// iOS 网关原生启动：在 App 进程内的后台线程加载 digidem 的 NodeMobile.xcframework 并跑网关 bundle。
//
// 约束（对应 docs/mobile-embedded-gateway.md §12/#1、digidem EMBEDDING.md）：
//  - iOS 不允许 spawn 第二进程，Node 只能作为 App 进程内的后台线程运行（node_start 阻塞调用线程，
//    故必须 dispatch 到后台队列，绝不在主线程调）。
//  - 环境必须在 node_start 之前 setenv；full flavour 实为 --with-intl=small-icu（含 \p{} 与 Intl 所需表），
//    lite 无 Intl 会让网关正则崩溃 → 必须用 full 包。
//  - iOS 已设好 TMPDIR/HOME，无需像 Android 那样补；仅需设 GATEWAY_* 与 NODE_COMPILE_CACHE
//    （PORTABLE=1，避免容器路径 UUID 变化导致缓存失效）。
//  - 端口回传：bundle（src/embedded/entry.ts）把实际端口写进 GATEWAY_PORT_FILE，本类轮询后写出
//    ws URL 文件（Documents/gateway.url），客户端经 plus.io 读取并注入 WS 地址（回环，不暴露局域网）。
//
// 集成位置：DCloud iOS 离线工程（HBuilder-Hello）的 AppDelegate 启动后调用 GatewayNode.shared.start()，
// 并把 NodeMobile.xcframework 加入工程 Embedded Binaries。注意本机 Intel Mac 无 x86_64 模拟器切片，
// 必须在真机（arm64 iPad）或 Apple Silicon Mac 上联调。
//
// 资产布局（由 package-ios-offline.mjs 拷贝、并在 Xcode 里作为资源加入 target）：
//   工程目录/gateway/gateway.bundle.mjs
//   工程目录/gateway/static/cues/*.mp3
// 首启由本类从 App Bundle 拷到 GATEWAY_HOME（Library/Application Support/gateway）。

import Foundation

// NodeMobile.framework 暴露的 C 入口（见其 Headers/NodeMobile.h）
@_silgen_name("node_start")
func node_start(_ argc: Int32, _ argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32

enum GatewayNodeError: Error {
    case bundleNotFound
}

final class GatewayNode {
    static let shared = GatewayNode()
    /// 端口就绪后写出的 WS URL 文件名（落 Documents 目录，客户端 plus.io 可读为 `_documents/gateway.url`）。
    private static let URL_FILE = "gateway.url"
    private let queue = DispatchQueue(label: "com.xiaoxiong.gateway.node")
    private var started = false

    /// 在 App 进程后台线程启动网关。幂等：重复调用只生效一次。
    func start() {
        guard !started else { return }
        started = true
        queue.async { [weak self] in
            self?.runNode()
        }
    }

    private func runNode() {
        let fm = FileManager.default
        // 解包目录：首启把 gateway.bundle.mjs + cues 从 App Bundle 拷到此处
        let home = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("gateway", isDirectory: true)
        do {
            try fm.createDirectory(at: home, withIntermediateDirectories: true)
        } catch {
            NSLog("[gateway] 创建 GATEWAY_HOME 失败: \(error)")
            return
        }

        // 0) 首启从 App Bundle 解包网关资产（Xcode 里已把 gateway/ 作为资源加入 target）
        do {
            try extractAssetsIfNeeded(from: Bundle.main, to: home)
        } catch {
            NSLog("[gateway] 解包网关资产失败: \(error)")
            return
        }

        let bundlePath = home.appendingPathComponent("gateway.bundle.mjs").path
        guard fm.fileExists(atPath: bundlePath) else {
            NSLog("[gateway] 未找到 gateway.bundle.mjs: \(bundlePath)")
            return
        }

        // 1) 启动前设环境（node_start 读取一次）
        setenv("GATEWAY_HOME", home.path, 1)
        setenv("GATEWAY_MODE", "embedded", 1)
        setenv("DOCS_ENABLED", "false", 1)
        setenv("GATEWAY_PORT", "0", 1)
        setenv("GATEWAY_PORT_FILE", home.appendingPathComponent(".gateway_port").path, 1)
        setenv("HOME", home.path, 1)

        // 2) V8 代码缓存放 Caches，PORTABLE=1 适配容器路径 UUID 变化
        let cache = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("gateway-node-cache", isDirectory: true)
        do { try fm.createDirectory(at: cache, withIntermediateDirectories: true) } catch {}
        setenv("NODE_COMPILE_CACHE", cache.path, 1)
        setenv("NODE_COMPILE_CACHE_PORTABLE", "1", 1)
        setenv("NODE_OPTIONS", "--max-old-space-size-percentage=50 --enable-source-maps", 1)

        // 3) 切工作目录（相对路径基准）
        chdir(home.path)

        // 4) 构造 argv：argv[0] 占位，argv[1] 为要执行的脚本
        let args = ["node", bundlePath]
        var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
        defer { cargs.forEach { free($0) } }

        // node_start 阻塞运行在本次后台线程，直到网关退出（进程内常驻，不主动退出）
        _ = node_start(Int32(cargs.count), &cargs)
    }

    /// 把 App Bundle 里的 gateway/ 资源首启拷贝到 home（幂等：已存在则跳过）。
    private func extractAssetsIfNeeded(from bundle: Bundle, to home: URL) throws {
        // 资源可能以「文件夹引用 gateway/」加入（subdirectory: "gateway"），也可能平铺；依次尝试。
        let candidates: [URL?] = [
            bundle.url(forResource: "gateway.bundle.mjs", withExtension: nil, subdirectory: "gateway"),
            bundle.url(forResource: "gateway.bundle.mjs", withExtension: nil),
        ]
        guard let srcBundle = candidates.compactMap({ $0 }).first else {
            // 可能已解包过（home 里已有），不视为错误
            if FileManager.default.fileExists(atPath: home.appendingPathComponent("gateway.bundle.mjs").path) { return }
            throw GatewayNodeError.bundleNotFound
        }
        let srcDir = srcBundle.deletingLastPathComponent()
        try copyDir(srcDir, to: home)
        NSLog("[gateway] 网关资产已解包到 \(home.path)")
    }

    private func copyDir(_ src: URL, to dst: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dst, withIntermediateDirectories: true)
        let items = try fm.contentsOfDirectory(at: src, includingPropertiesForKeys: nil)
        for item in items {
            let dest = dst.appendingPathComponent(item.lastPathComponent)
            if (try item.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true {
                try copyDir(item, to: dest)
            } else {
                try? fm.removeItem(at: dest)
                try fm.copyItem(at: item, to: dest)
            }
        }
    }

    /// 轮询端口文件，读到后写出 ws URL 到 Documents/gateway.url 并回调。
    /// 客户端（uni-app）经 plus.io 读取 `_documents/gateway.url` 拿到 `ws://127.0.0.1:<port>/ws`。
    func awaitPort(timeoutMs: Int = 60_000, onReady: ((String) -> Void)? = nil) {
        let portFile = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("gateway/.gateway_port")
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        DispatchQueue.global().async {
            while Date() < deadline {
                if let raw = try? String(contentsOf: portFile, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   let port = Int(raw), port > 0 {
                    let url = "ws://127.0.0.1:\(port)/ws"
                    self.writeUrlFile(url)
                    onReady?(url)
                    return
                }
                Thread.sleep(forTimeInterval: 0.2)
            }
            NSLog("[gateway] 端口轮询超时（\(timeoutMs)ms 内未读到 .gateway_port）")
        }
    }

    private func writeUrlFile(_ url: String) {
        guard let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let file = docs.appendingPathComponent(GatewayNode.URL_FILE)
        try? url.write(to: file, atomically: true, encoding: .utf8)
        NSLog("[gateway] ws URL 已写出: \(file.path) -> \(url)")
    }
}
