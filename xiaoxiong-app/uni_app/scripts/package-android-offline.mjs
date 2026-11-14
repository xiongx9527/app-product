#!/usr/bin/env node
/**
 * 把 `npm run build:app` 产出的本地打包资源（dist/build/app）接入 DCloud Android 离线 SDK 工程，
 * 并把内嵌网关（gateway.bundle.mjs + 提示音 + digidem libnode.so）一并接入，生成离线打包所需的
 * 目录结构与配置，省去手动拷贝出错。
 *
 * 用法：
 *   node scripts/package-android-offline.mjs \
 *     --sdk /path/to/HBuilder-Integrate-AS \   # 离线 SDK 里那个 Android Studio 工程根目录（含 simpleDemo/ 与 settings.gradle）
 *     --appid __UNI_XXXXXXXX \                  # DCloud 开发者中心的 appid（必须非空，且与 AppKey 对应）
 *     [--module simpleDemo]                     # 主模块名（5.34 SDK 默认是 simpleDemo，旧版可能是 app）
 *     [--appkey xxxxxxxx]                       # 可选：AppKey 字符串，写入 AndroidManifest 的 dcloud_appkey meta-data
 *     [--node-lib /path/to/digidem-android]     # 可选：digidem android 包解压目录（内含各 ABI 的 libnode.so）
 *     [--gateway-bundle /path/bundle.mjs]       # 可选：覆盖默认 <gateway>/dist/gateway.bundle.mjs
 *     [--gateway-cues /path/cues]               # 可选：覆盖默认 <gateway>/static/cues
 *     [--no-gateway]                            # 可选：跳过网关资产接入（退回纯 uni-app 资源接入）
 *
 * 该脚本只做「资源与运行库接入」，不负责：原生插件（app-product-wake）、JNI 桥编译、Java Service 落位、
 * AndroidManifest 的 :gateway Service 声明、build.gradle 的 CMake 接线、签名与包名（后两者在 build.gradle 里改）。
 * 这些后续步骤见 xiaoxiong-app/native/README.md 与 docs/mobile-embedded-gateway.md §15。
 *
 * 注意：编译出 APK 不需要 appid/AppKey；只有装到设备上「能启动运行」才需要，且 appid、包名、证书 SHA1 三者
 * 必须与 DCloud 开发者中心申请 AppKey 时填的一致，否则启动时报「未配置appkey或配置错误」。
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(__dirname, '..')
const gatewayRoot = resolve(root, '..', 'gateway') // xiaoxiong-app/gateway

const VALID_ABIS = new Set(['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'armeabi'])

function parseArgs(argv) {
  const out = { module: 'simpleDemo', gateway: true }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--sdk') out.sdk = argv[++i]
    else if (a === '--appid') out.appid = argv[++i]
    else if (a === '--module') out.module = argv[++i]
    else if (a === '--appkey') out.appkey = argv[++i]
    else if (a === '--node-lib') out.nodeLib = argv[++i]
    else if (a === '--gateway-bundle') out.gatewayBundle = argv[++i]
    else if (a === '--gateway-cues') out.gatewayCues = argv[++i]
    else if (a === '--no-gateway') out.gateway = false
  }
  return out
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dest, name)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

// 递归找出目录下所有同名文件（digidem 包的 libnode.so 分散在各 ABI 子目录）
function findFiles(dir, filename, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) findFiles(p, filename, acc)
    else if (name === filename) acc.push(p)
  }
  return acc
}

const args = parseArgs(process.argv.slice(2))
if (!args.sdk || !args.appid) {
  console.error('用法: node scripts/package-android-offline.mjs --sdk <HBuilder-Integrate-AS 路径> --appid <appid> [--module simpleDemo] [--appkey <AppKey字符串>] [--node-lib <digidem android 解压目录>] [--no-gateway]')
  process.exit(1)
}
if (!existsSync(args.sdk)) {
  console.error(`离线 SDK 工程不存在: ${args.sdk}`)
  process.exit(1)
}
const moduleDir = join(args.sdk, args.module)
if (!existsSync(moduleDir)) {
  console.error(`主模块不存在: ${moduleDir}（用 --module 指定，5.34 SDK 默认 simpleDemo）`)
  process.exit(1)
}

const bundle = join(root, 'dist', 'build', 'app')
if (!existsSync(bundle)) {
  console.error(`未找到构建产物 ${bundle}，请先运行 npm run build:app`)
  process.exit(1)
}

const appid = args.appid.trim()
const assetsDir = join(moduleDir, 'src', 'main', 'assets')
const appsDir = join(assetsDir, 'apps')
const dataDir = join(assetsDir, 'data')

// 0) 清掉 apps/ 下旧的 demo 应用目录，避免多个 app 并存让引擎读到错的那个
if (existsSync(appsDir)) {
  for (const name of readdirSync(appsDir)) rmSync(join(appsDir, name), { recursive: true, force: true })
}

// 1) 拷贝本地打包资源到 apps/<appid>/www
const wwwDir = join(appsDir, appid, 'www')
copyDir(bundle, wwwDir)
console.log(`[ok] 资源已接入: ${wwwDir}`)

// 2) manifest.json 的 id 必须与 appid 一致（官方文档要求 id / 文件夹名 / control.xml 三者一致），
//    CLI 项目导出时 id 为空，不补会运行时报 appid 不匹配。
const manifestPath = join(wwwDir, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.id = appid
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
console.log(`[ok] manifest.json id 已设为 ${appid}`)

// 3) 写入 dcloud_control.xml（离线引擎靠它定位 appid）
// 注意：必须在 assets/data/ 目录下（5.34 SDK demo 与官方文档都在 data/，写在 assets/ 根下引擎读不到）
mkdirSync(dataDir, { recursive: true })
const control = `<?xml version="1.0" encoding="utf-8"?>
<hbuilder>
  <apps>
    <app appid="${appid}" appver=""/>
  </apps>
</hbuilder>
`
writeFileSync(join(dataDir, 'dcloud_control.xml'), control)
console.log('[ok] 已写入 dcloud_control.xml -> assets/data/')

// 4) 可选：把 AppKey 写入 AndroidManifest 的 dcloud_appkey meta-data
//    Android 侧官方配置就是这个 meta-data 字符串（不是 assets/data/dcloud_key 文件，那是 iOS/旧版口径）。
const androidManifestPath = join(moduleDir, 'src', 'main', 'AndroidManifest.xml')
let xml = readFileSync(androidManifestPath, 'utf8')
if (args.appkey) {
  const appkey = args.appkey.trim()
  const hasMeta = /android:name="dcloud_appkey"/.test(xml)
  if (hasMeta) {
    xml = xml.replace(/(android:name="dcloud_appkey"[\s\S]*?android:value=")[^"]*(")/, `$1${appkey}$2`)
  } else {
    xml = xml.replace(/<\/application>/, `    <meta-data\n            android:name="dcloud_appkey"\n            android:value="${appkey}" />\n    </application>`)
  }
  writeFileSync(androidManifestPath, xml)
  console.log('[ok] AppKey 已写入 AndroidManifest.xml 的 dcloud_appkey')
} else {
  console.warn('[warn] 未提供 --appkey：APK 可编译，但装到设备上会因 AppKey 校验失败而无法启动')
}

// 5) 内嵌网关资产：gateway.bundle.mjs + static/cues/*.mp3 放进 assets/gateway/
//    运行时 GatewayNodeService 把 assets/gateway/ 整体拷到 no_backup（= GATEWAY_HOME）；
//    server.ts 的 CUE_DIR 依赖 <home>/static/cues/，故 cues 必须落在 static/cues 子目录。
if (args.gateway) {
  // 打包前自动重新构建网关 bundle，避免把过期的 dist/gateway.bundle.mjs 打进包里。
  // 仅当用户显式用 --gateway-bundle 指定外部 bundle 时才跳过自动构建。
  if (!args.gatewayBundle) {
    const buildScript = join(gatewayRoot, 'package.json')
    if (existsSync(buildScript)) {
      console.log('[step] 构建网关 bundle (npm run build:bundle) ...')
      const r = spawnSync('npm', ['run', 'build:bundle'], { cwd: gatewayRoot, stdio: 'inherit' })
      if (r.status !== 0) {
        console.error('[error] 网关 bundle 构建失败，请检查 gateway 目录')
        process.exit(1)
      }
      console.log('[ok] 网关 bundle 已重新构建')
    } else {
      console.warn(`[warn] 未找到 ${buildScript}，跳过自动构建，依赖现有 bundle`)
    }
  } else {
    console.log('[info] 使用 --gateway-bundle 指定的外部 bundle，跳过自动构建')
  }
  const bundleFile = args.gatewayBundle ? resolve(args.gatewayBundle) : join(gatewayRoot, 'dist', 'gateway.bundle.mjs')
  const cuesDir = args.gatewayCues ? resolve(args.gatewayCues) : join(gatewayRoot, 'static', 'cues')
  if (!existsSync(bundleFile)) {
    console.error(`[error] 未找到网关 bundle: ${bundleFile}\n       先在 gateway 目录跑 npm run build:bundle，或用 --no-gateway 跳过网关接入`)
    process.exit(1)
  }
  const gwAssets = join(assetsDir, 'gateway')
  rmSync(gwAssets, { recursive: true, force: true }) // 幂等：整个目录由本脚本管理，清掉旧版本避免残留
  mkdirSync(join(gwAssets, 'static'), { recursive: true })
  copyFileSync(bundleFile, join(gwAssets, 'gateway.bundle.mjs'))
  console.log('[ok] 网关 bundle -> assets/gateway/gateway.bundle.mjs')
  if (existsSync(cuesDir)) {
    copyDir(cuesDir, join(gwAssets, 'static', 'cues'))
    console.log(`[ok] 提示音 -> assets/gateway/static/cues/ (${readdirSync(join(gwAssets, 'static', 'cues')).length} 个)`)
  } else {
    console.warn(`[warn] 未找到提示音目录 ${cuesDir}：/static/cues/* 会 404（不影响网关启动）`)
  }
} else {
  rmSync(join(assetsDir, 'gateway'), { recursive: true, force: true })
  console.log('[info] --no-gateway：已跳过网关资产接入')
}

// 6) digidem libnode.so -> src/main/jniLibs/<abi>/libnode.so
//    digidem android 包（nodejs-mobile-android-24.20.0-0.zip）解压后各 ABI 子目录里有 libnode.so。
//    只覆盖 libnode.so，不删 jniLibs 里其它 native 库（工程可能已有别的 .so）。
if (args.nodeLib) {
  const nodeLibRoot = resolve(args.nodeLib)
  if (!existsSync(nodeLibRoot)) {
    console.error(`[error] --node-lib 目录不存在: ${nodeLibRoot}`)
    process.exit(1)
  }
  const libs = findFiles(nodeLibRoot, 'libnode.so')
  if (libs.length === 0) {
    console.error(`[error] 在 ${nodeLibRoot} 下未找到任何 libnode.so（应为 digidem android 包解压目录，含 arm64-v8a/ 等子目录）`)
    process.exit(1)
  }
  const jniDir = join(moduleDir, 'src', 'main', 'jniLibs')
  // 清掉上次接入的同名 libnode.so（逐 ABI），保留工程里其它 .so
  if (existsSync(jniDir)) {
    for (const abi of readdirSync(jniDir)) {
      const old = join(jniDir, abi, 'libnode.so')
      if (existsSync(old)) rmSync(old, { force: true })
    }
  }
  let copied = 0
  for (const lib of libs) {
    const abi = basename(dirname(lib))
    if (!VALID_ABIS.has(abi)) {
      console.warn(`[warn] 跳过非标准 ABI 目录 "${abi}": ${lib}`)
      continue
    }
    const dest = join(jniDir, abi, 'libnode.so')
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(lib, dest)
    console.log(`[ok] libnode.so -> jniLibs/${abi}/`)
    copied += 1
  }
  if (copied === 0) {
    console.error('[error] 没拷到任何标准 ABI 的 libnode.so（期望 arm64-v8a / armeabi-v7a / x86_64）')
    process.exit(1)
  }
} else {
  console.warn('[warn] 未提供 --node-lib：APK 不含 libnode.so，内嵌网关无法启动（下载 digidem android 包后用 --node-lib 指向其解压目录）')
}

console.log('\n下一步（网关同包，详见 xiaoxiong-app/native/README.md 与 docs §15）：')
console.log('  1. 把 native/android/GatewayNodeService.java 放到 src/main/java/com/xiaoxiong/assistant/gateway/')
console.log('  2. AndroidManifest.xml 声明 <service android:name="com.xiaoxiong.assistant.gateway.GatewayNodeService" android:process=":gateway" android:exported="false"/>')
console.log('  3. NDK 编 gateway_node_bridge.cpp（CMake 的 NODE_INCLUDE 指向 digidem 包 include/node，NODE_LIB 指向 jniLibs/<abi>/libnode.so）')
console.log('  4. 接入 app-product-wake 原生插件（否则唤醒与 PCM 采集不可用）')
console.log('  5. Android Studio 打开 HBuilder-Integrate-AS，Sync 后 Build APK（或 Run 到 Pixel5_API35 AVD）')
