// iOS 网关原生启动：在 App 进程内的后台线程加载 digidem 的 NodeMobile.xcframework 并跑网关 bundle。
//
// 约束（对应 docs/mobile-embedded-gateway.md §12/#1、digidem EMBEDDING.md）：
//  - iOS 不允许 spawn 第二进程，Node 只能作为 App 进程内的后台线程运行（node_start 阻塞调用线程，
//    故必须 dispatch 到后台队列，绝不在主线程调）。
//  - 环境必须在 node_start 之前 setenv；full flavour 实为 --with-intl=small-icu（含 \p{} 与 Intl 所需表），
//    lite 无 Intl 会让网关正则崩溃 → 必须用 full 包。
//  - iOS 已设好 TMPDIR/HOME，无需像 Android 那样补；仅需设 GATEWAY_* 与 NODE_COMPILE_CACHE
//    （PORTABLE=1，避免容器路径 UUID 变化导致缓存失效）。
//  - 端口回传：bundle（src/embedded/entry.ts）把实际端口写进 GATEWAY_PORT_FILE，本类轮询后通知 App。
//
// 集成位置：DCloud iOS 离线工程（HBuilder-Hello）的 AppDelegate 启动后调用 GatewayNode.shared.start()，
// 并把 NodeMobile.xcframework 加入工程 Embedded Binaries。注意本机 Intel Mac 无 x86_64 模拟器切片，
// 必须在真机（arm64 iPad）或 Apple Silicon Mac 上联调。

import Foundation

// NodeMobile.framework 暴露的 C 入口（见其 Headers/NodeMobile.h）
@_silgen_name("node_start")
func node_start(_ argc: Int32, _ argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32

final class GatewayNode {
    static let shared = GatewayNode()
    private let queue = DispatchQueue(label: "com.xiaoxiong.gateway.node")
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        queue.async { [weak self] in
            self?.runNode()
        }
    }

    private func runNode() {
        let fm = FileManager.default
        // 解包目录：首启由原生层把 gateway.bundle.mjs + cues 从 Assets 拷到此处
        let home = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("gateway", isDirectory: true)
        try? fm.createDirectory(at: home, withIntermediateDirectories: true)
        let bundlePath = home.appendingPathComponent("gateway.bundle.mjs").path

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
        try? fm.createDirectory(at: cache, withIntermediateDirectories: true)
        setenv("NODE_COMPILE_CACHE", cache.path, 1)
        setenv("NODE_COMPILE_CACHE_PORTABLE", "1", 1)
        setenv("NODE_OPTIONS", "--max-old-space-size-percentage=50 --enable-source-maps", 1)

        // 3) 切工作目录（相对路径基准）
        chdir(home.path)

        // 4) 构造 argv：argv[0] 占位，argv[1] 为要执行的脚本
        let args = ["node", bundlePath]
        var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
        defer { cargs.forEach { free($0) } }

        // node_start 阻塞运行在本次后台线程，直到网关退出
        _ = node_start(Int32(cargs.count), &cargs)
    }

    // 轮询端口文件并通知 App（UI 据此拼 ws://127.0.0.1:<port>）
    func awaitPort(timeoutMs: Int = 60_000, onReady: @escaping (String) -> Void) {
        let home = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("gateway/.gateway_port")
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        DispatchQueue.global().async {
            while Date() < deadline {
                if let p = try? String(contentsOf: home, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines'),
                   !p.isEmpty {
                    onReady(p)
                    return
                }
                Thread.sleep(forTimeInterval: 0.2)
            }
        }
    }
}
