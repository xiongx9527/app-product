// 网关启动入口：供壳工程（HBuilder-Hello）的 AppDelegate.m / SceneDelegate.m 经 ObjC 调用。
//
// 为什么要这个类：原实现是 `extension AppDelegate`（AppDelegate+Gateway.swift），
// 但 Swift extension 编译期必须看到宿主类，无法进独立 framework；壳工程的 AppDelegate
// 是 ObjC（AppDelegate.m），因此改由本类暴露 @objc 静态方法，AppDelegate.m 直接
// `[GatewayLauncher startEmbeddedGateway]` 调用（见 XiaoxiongGateway-Swift.h 自动生成声明）。
//
// 集成由 package-ios-offline.mjs 自动完成（embed framework + patch AppDelegate.m），
// 不再需要手动拖文件。
//
// 退后台保活（beginGatewayKeepAlive / endGatewayKeepAlive）：
// 本 App 声明了 UIBackgroundModes=audio，但仅声明不够，必须真在播音频系统才允许后台持续运行。
// 退后台时播一段循环静音 + 申请 beginBackgroundTask，让内嵌网关的 Node 线程（8787）不被冻结。
// 注意：本 App 走 SceneDelegate，前后台回调在 SceneDelegate.m 而非 AppDelegate.m，
// 由 ios-integrate.rb 注入调用（见该脚本的 xiaoxiong-gw-keepalive 段）。

import Foundation
import AVFoundation
import UIKit

@objc
public final class GatewayLauncher: NSObject {
    /// 在应用启动早期调用：后台线程拉起 Node 网关，并异步等端口就绪后写出 ws URL。
    /// 幂等（GatewayNode.start 内部保证），重复调用无害。
    @objc
    public static func startEmbeddedGateway() {
        GatewayNode.shared.start()
        GatewayNode.shared.awaitPort { url in
            NSLog("[gateway] 内嵌网关就绪，客户端可连接: \(url)")
        }
    }

    /// 退后台时调用：播循环静音 + 申请后台任务，保住网关 8787。
    @objc
    public static func beginGatewayKeepAlive() {
        SilentKeepAlive.shared.begin()
    }

    /// 回前台时调用：停静音、关音频会话、结束后台任务。
    @objc
    public static func endGatewayKeepAlive() {
        SilentKeepAlive.shared.end()
    }
}

// MARK: - 退后台静音保活
/// 用 AVAudioSession(.playback, .mixWithOthers) + 循环静音 WAV，让系统认为 App 在后台放音频，
/// 从而不冻结内嵌网关线程。音量走真实静音采样（非 volume=0），避免系统因"无声"判定无效。
private final class SilentKeepAlive {
    static let shared = SilentKeepAlive()

    private let lock = NSLock()
    private var bgId: UIBackgroundTaskIdentifier = .invalid
    private var player: AVAudioPlayer?
    private var isKeepingAlive = false

    private init() {}

    func begin() {
        lock.lock()
        defer { lock.unlock() }
        // 幂等：已在保活则不重复申请/播放，避免叠加后台任务与音频会话。
        guard bgId == .invalid, !isKeepingAlive else {
            NSLog("[gateway-keepalive] begin 忽略：已在保活中")
            return
        }

        bgId = UIApplication.shared.beginBackgroundTask(withName: "GatewayKeepAlive") { [weak self] in
            // 后台任务即将被系统回收时的兜底收敛。
            self?.endInternal()
        }
        isKeepingAlive = true
        NSLog("[gateway-keepalive] begin: bgId=\(bgId.rawValue)")

        // 延迟短暂时间再激活音频会话，避开退后台瞬间 WakeModule 录音会话切换的竞争。
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.activateAudioSession()
        }

        // 监听音频中断（来电/其它 App 抢占），结束后重播。
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
    }

    func end() {
        lock.lock()
        defer { lock.unlock() }
        endInternal()
    }

    /// 必须在 lock 已持有或由过期回调单线程调用；完成所有收敛与复位。
    private func endInternal() {
        guard isKeepingAlive || bgId != .invalid || player != nil else { return }

        player?.stop()
        player = nil

        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)

        if bgId != .invalid {
            UIApplication.shared.endBackgroundTask(bgId)
            bgId = .invalid
        }
        isKeepingAlive = false
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
        NSLog("[gateway-keepalive] end: 已停止静音保活")
    }

    private func activateAudioSession() {
        lock.lock()
        defer { lock.unlock() }
        guard isKeepingAlive else { return } // end 已先行，避免竞态重新激活

        let session = AVAudioSession.sharedInstance()
        do {
            // .playback + .mixWithOthers：不打断前台 TTS/录音，也不被其 duck。
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)

            let wavURL = try ensureSilentWav()
            let p = try AVAudioPlayer(contentsOf: wavURL)
            p.numberOfLoops = -1
            p.volume = 1.0
            p.prepareToPlay()
            guard p.play() else {
                NSLog("[gateway-keepalive] 静音播放 play() 返回 false")
                return
            }
            player = p
            NSLog("[gateway-keepalive] 静音循环播放已启动: \(wavURL.path)")
        } catch {
            NSLog("[gateway-keepalive] 激活音频会话失败: \(error)")
        }
    }

    @objc private func handleInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            NSLog("[gateway-keepalive] 音频中断开始")
        case .ended:
            // 中断结束后若仍在保活态，尝试重播。
            guard isKeepingAlive else { return }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.3) { [weak self] in
                self?.activateAudioSession()
            }
        @unknown default:
            break
        }
    }

    /// 生成 1 秒 16k/16bit/mono 静音 WAV 到 Caches（照 health.ts tinySilentWav 的 WAV 头）。
    private func ensureSilentWav() throws -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let url = caches.appendingPathComponent("gateway-keepalive-silence.wav")
        if FileManager.default.fileExists(atPath: url.path) { return url }

        let sampleRate: UInt32 = 16000
        let sampleCount = 16000 // 1 秒静音
        let pcmByteCount = sampleCount * 2 // 16bit
        var data = Data()
        data.append(contentsOf: Array("RIFF".utf8))
        data.append(le32(UInt32(36 + pcmByteCount)))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        data.append(le32(16))          // fmt chunk size
        data.append(le16(1))           // PCM
        data.append(le16(1))           // mono
        data.append(le32(sampleRate))
        data.append(le32(sampleRate * 2)) // byte rate
        data.append(le16(2))           // block align
        data.append(le16(16))          // bits per sample
        data.append(contentsOf: Array("data".utf8))
        data.append(le32(UInt32(pcmByteCount)))
        data.append(Data(repeating: 0, count: pcmByteCount)) // 全 0 = 静音
        try data.write(to: url)
        return url
    }

    private func le16(_ v: UInt16) -> Data {
        var x = v; return Data(bytes: &x, count: 2)
    }
    private func le32(_ v: UInt32) -> Data {
        var x = v; return Data(bytes: &x, count: 4)
    }
}
