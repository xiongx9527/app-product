#!/usr/bin/env node
/**
 * 把 `npm run build:app` 产出的本地打包资源（dist/build/app）接入 DCloud Android 离线 SDK 工程，
 * 生成离线打包所需的目录结构与配置，省去手动拷贝出错。
 *
 * 用法：
 *   node scripts/package-android-offline.mjs \
 *     --sdk /path/to/HBuilder-Integrate-AS \   # 离线 SDK 里那个 Android Studio 工程根目录（含 simpleDemo/ 与 settings.gradle）
 *     --appid __UNI_XXXXXXXX \                  # DCloud 开发者中心的 appid（必须非空，且与 AppKey 对应）
 *     [--module simpleDemo]                     # 主模块名（5.34 SDK 默认是 simpleDemo，旧版可能是 app）
 *     [--appkey xxxxxxxx]                       # 可选：AppKey 字符串，写入 AndroidManifest 的 dcloud_appkey meta-data
 *
 * 该脚本只做「资源接入」，不负责原生插件（app-product-wake）、签名与包名——后两者在 simpleDemo/build.gradle 里改。
 * 注意：编译出 APK 不需要 appid/AppKey；只有装到设备上「能启动运行」才需要，且 appid、包名、证书 SHA1 三者
 * 必须与 DCloud 开发者中心申请 AppKey 时填的一致，否则启动时报「未配置appkey或配置错误」。
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(__dirname, '..')

function parseArgs(argv) {
  const out = { module: 'simpleDemo' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--sdk') out.sdk = argv[++i]
    else if (a === '--appid') out.appid = argv[++i]
    else if (a === '--module') out.module = argv[++i]
    else if (a === '--appkey') out.appkey = argv[++i]
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

const args = parseArgs(process.argv.slice(2))
if (!args.sdk || !args.appid) {
  console.error('用法: node scripts/package-android-offline.mjs --sdk <HBuilder-Integrate-AS 路径> --appid <appid> [--module simpleDemo] [--appkey <AppKey字符串>]')
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

console.log('\n下一步：')
console.log('  1. 将 app-product-wake 原生插件接入该工程的 nativeplugins / 模块（否则唤醒与 PCM 采集不可用）')
console.log('  2. Android Studio 打开 HBuilder-Integrate-AS，Sync 后 Build APK（或 Run 到 Pixel5_API35 AVD）')
