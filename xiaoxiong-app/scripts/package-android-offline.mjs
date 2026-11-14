#!/usr/bin/env node
/**
 * 把 `npm run build:app` 产出的本地打包资源（dist/build/app）接入 Android 离线打包工程，
 * 并把内嵌网关（gateway.bundle.mjs + 提示音 + digidem libnode.so）一并接入，生成离线打包所需的
 * 目录结构与配置，省去手动拷贝出错。
 *
 * 工程二分（见 xiaoxiong-app/native/android/）：
 *   - sdk/  = DCloud 离线打包工程壳（HBuilder-Integrate-AS，仅含 gradlew/settings.gradle/引擎 aar），
 *            体积大、不入库（.gitignore 已忽略 xiaoxiong-app/native/android/sdk/）。
 *   - app/  = 我们的「原生工厂」（native/android/app），含全部 Java 源码、JNI 桥、AndroidManifest、
 *            dcloud_properties 与已预置的网关 Service/Application 声明；这是可直接打开构建的 Android 模块，入库。
 *   二者由 SDK 壳的 settings.gradle 用 `include ':app'` + `project(':app').projectDir = file('../app')` 关联。
 *
 * 用法：
 *   node scripts/package-android-offline.mjs \
 *     --sdk <HBuilder-Integrate-AS 路径> \     # DCloud 离线 SDK 壳根；缺省默认 xiaoxiong-app/native/android/sdk/HBuilder-Integrate-AS
 *     --appid __UNI_XXXXXXXX \                  # DCloud 开发者中心的 appid（必须非空，且与 AppKey 对应）
 *     [--appkey xxxxxxxx]                       # 可选：AppKey 字符串，写入 app 模块 AndroidManifest 的 dcloud_appkey meta-data（已预置，可覆盖）
 *     [--node-lib /path/to/digidem-android]     # 可选：digidem android 包解压目录（内含各 ABI 的 libnode.so）；app 模块已内置，可用它刷新
 *     [--gateway-bundle /path/bundle.mjs]       # 可选：覆盖默认 <gateway>/dist/gateway.bundle.mjs
 *     [--gateway-cues /path/cues]               # 可选：覆盖默认 <gateway>/static/cues
 *     [--no-gateway]                            # 可选：跳过网关资产接入（退回纯 uni-app 资源接入）
 *
 * 脚本只做「生成物接入」（前端 www、网关 bundle、libnode.so 与可选 AppKey）；Java/CMake/Manifest/
 * dcloud_properties 这些「源」都已在 app/ 模块里就位，脚本仅做幂等兜底，不新增源文件。
 * 构建与签名见 app/build.gradle（引擎 aar 从 ../sdk/libs 引用，keystore 从 ../sdk/HBuilder-Integrate-AS 引用）。
 *
 * 注意：编译出 APK 不需要 appid/AppKey；只有装到设备上「能启动运行」才需要，且 appid、包名、证书 SHA1 三者
 * 必须与 DCloud 开发者中心申请 AppKey 时填的一致，否则启动时报「未配置appkey或配置错误」。
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
// 脚本集中在 xiaoxiong-app/scripts；以下路径均相对 xiaoxiong-app 根解析，与脚本所在目录无关。
const projectRoot = resolve(__dirname, '..') // xiaoxiong-app
const uniAppRoot = resolve(projectRoot, 'uni_app')
const gatewayRoot = resolve(projectRoot, 'gateway') // xiaoxiong-app/gateway
const nativeAndroid = resolve(projectRoot, 'native', 'android', 'app') // 我们的原生工厂模块（单一真相源）

const VALID_ABIS = new Set(['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'armeabi'])

function parseArgs(argv) {
  const out = { gateway: true, sdk: resolve(projectRoot, 'native', 'android', 'sdk', 'HBuilder-Integrate-AS') }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--sdk') out.sdk = argv[++i]
    else if (a === '--appid') out.appid = argv[++i]
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
if (!args.appid) {
  console.error('用法: node scripts/package-android-offline.mjs --appid <appid> [--sdk <HBuilder-Integrate-AS 路径>] [--appkey <AppKey字符串>] [--node-lib <digidem android 解压目录>] [--no-gateway>]')
  console.error('  --sdk 缺省默认 xiaoxiong-app/native/android/sdk/HBuilder-Integrate-AS（DCloud 离线 SDK 壳，已随工程放置）；用其它 SDK 时再用 --sdk 覆盖')
  process.exit(1)
}
if (!existsSync(args.sdk)) {
  console.error(`离线 SDK 工程不存在: ${args.sdk}（可把 DCloud 离线 SDK 解压到 xiaoxiong-app/native/android/sdk/HBuilder-Integrate-AS，或用 --sdk 指定）`)
  process.exit(1)
}
// app 模块是固定的原生工厂（native/android/app）；SDK 壳通过 settings.gradle 的 include ':app' 关联它。
const moduleDir = nativeAndroid
if (!existsSync(moduleDir)) {
  console.error(`原生工厂模块不存在: ${moduleDir}（确认 xiaoxiong-app/native/android/app 已就位）`)
  process.exit(1)
}

const bundle = join(uniAppRoot, 'dist', 'build', 'app')
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

// 7) 原生源码（App.java / GatewayNodeService.java / WakeModule.java）已作为「源」常驻在
//    native/android/app/src/main/java/com/xiaoxiong/assistant/，是可直接打开构建的 Android 模块，
//    无需脚本再拷入。脚本只负责下方 7a/7b/7c 的幂等兜底（dcloud_properties / 权限 / Manifest 声明），
//    正常情况下这些已预置在 app 模块，脚本直接跳过。


// 7a) dcloud_properties.xml 注册 feature（离线 SDK 原生插件靠它在 requireNativePlugin 时定位类）
{
  const propPath = join(moduleDir, 'src', 'main', 'assets', 'data', 'dcloud_properties.xml')
  if (existsSync(propPath)) {
    let prop = readFileSync(propPath, 'utf8')
    if (!/app-product-wake/.test(prop)) {
      prop = prop.replace(
        /(\s*)<\/features>/,
        `$1\t<feature name="app-product-wake" value="com.xiaoxiong.assistant.wake.WakeModule"/>\n$1</features>`,
      )
      writeFileSync(propPath, prop)
      console.log('[ok] dcloud_properties.xml 已注册 app-product-wake')
    } else {
      console.log('[info] dcloud_properties.xml 已含 app-product-wake，跳过注册')
    }
  } else {
    console.warn(`[warn] 未找到 ${propPath}，无法注册 app-product-wake（请手动加 feature）`)
  }
}

// 7b) AndroidManifest 声明麦克风权限（AudioRecord 必需，uni-app 框架不会为原生 AudioRecord 请求）
if (existsSync(androidManifestPath)) {
  let mf = readFileSync(androidManifestPath, 'utf8')
  if (!/RECORD_AUDIO/.test(mf)) {
    mf = mf.replace(
      /(\s*)<application/,
      `$1<uses-permission android:name="android.permission.RECORD_AUDIO" />\n$1<application`,
    )
    writeFileSync(androidManifestPath, mf)
    console.log('[ok] AndroidManifest 已声明 RECORD_AUDIO 权限')
  } else {
    console.log('[info] AndroidManifest 已含 RECORD_AUDIO，跳过')
  }

  // 7c) 注入自定义 Application 类（主进程拉起网关）与 :gateway 独立进程 Service。
  //     让 SDK 的 AndroidManifest 完全由本脚本从仓库装配，不再手工编辑（对应「包括 sdk」的要求）。
  if (!/android:name="com\.xiaoxiong\.assistant\.App"/.test(mf)) {
    if (/<application\b[^>]*\bandroid:name="/.test(mf)) {
      mf = mf.replace(/(<application\b[^>]*\b)android:name="[^"]*"/,
        '$1android:name="com.xiaoxiong.assistant.App" tools:replace="android:name"')
    } else {
      mf = mf.replace(/(<application\b)/,
        '$1 android:name="com.xiaoxiong.assistant.App" tools:replace="android:name"')
    }
    if (!/xmlns:tools=/.test(mf)) {
      mf = mf.replace(/(<manifest\b[^>]*?)(\s*>)/,
        '$1 xmlns:tools="http://schemas.android.com/apk/res/android"$2')
    }
    writeFileSync(androidManifestPath, mf)
    console.log('[ok] AndroidManifest 注入 Application=com.xiaoxiong.assistant.App')
  } else {
    console.log('[info] AndroidManifest 已声明 App 类，跳过')
  }
  if (!/GatewayNodeService/.test(mf)) {
    mf = readFileSync(androidManifestPath, 'utf8')
    mf = mf.replace(
      /(\s*)<\/application>/,
      `$1\t<service\n\t\tandroid:name="com.xiaoxiong.assistant.gateway.GatewayNodeService"\n\t\tandroid:process=":gateway"\n\t\tandroid:exported="false" />\n$1</application>`,
    )
    writeFileSync(androidManifestPath, mf)
    console.log('[ok] AndroidManifest 注入 :gateway Service')
  } else {
    console.log('[info] AndroidManifest 已含 :gateway Service，跳过')
  }
}

console.log('\n下一步（网关同包，详见 xiaoxiong-app/native/android/）：')
console.log('  1. 原生源码/Manifest/CMake 已就位在 native/android/app/，本脚本只注入了前端 www、网关 bundle 与 libnode.so。')
console.log('  2. 进 SDK 壳目录构建（app 模块由 settings.gradle 的 include \':app\' 关联）：')
console.log('       cd xiaoxiong-app/native/android/sdk/HBuilder-Integrate-AS && ./gradlew :app:clean :app:assembleDebug')
console.log('  3. 装到设备：adb install -r app/build/outputs/apk/debug/app-debug.apk')
console.log('  4. 真机验证「一键检测」：网关应正常（地址可达即「已接入」，内置源永不报「未选择模型」）。')
