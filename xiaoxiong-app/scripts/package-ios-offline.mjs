#!/usr/bin/env node
/**
 * 把 `npm run build:app` 产出的本地打包资源（dist/build/app）接入 DCloud iOS 离线 SDK（自定义基座），
 * 并把内嵌网关（gateway.bundle.mjs + 提示音 + digidem 的 NodeMobile.xcframework）一并接入，生成离线打包所需的
 * 目录结构、配置与 Xcode 集成清单，省去手动拷贝出错。
 *
 * 用法：
 *   node scripts/package-ios-offline.mjs \
 *     --sdk /path/to/HBuilder-SDK \            # iOS 离线 SDK 工程根目录（含 .xcodeproj 与 Pandora/；内层工程为官方 HBuilder-Hello）
 *     --appid __UNI_XXXXXXXX \                  # DCloud 开发者中心的 appid（必须非空，且与 AppKey 对应）
 *     [--appkey xxxxxxxx]                       # 可选：AppKey 字符串，写入 Info.plist 的 dcloud_appkey
 *     [--plist /path/Info.plist]                # 可选：覆盖主目标 Info.plist 路径
 *     [--node-ios /path/to/digidem-ios]         # 可选：digidem ios 包解压目录（内含 NodeMobile.xcframework）
 *     [--gateway-bundle /path/bundle.mjs]       # 可选：覆盖默认 <gateway>/dist/gateway.bundle.mjs
 *     [--gateway-cues /path/cues]               # 可选：覆盖默认 <gateway>/static/cues
 *     [--no-gateway]                            # 可选：跳过内嵌网关资产接入
 *     [--app-name "小熊助手"]                    # 可选：应用显示名，改写 Info.plist 的 CFBundleDisplayName / CFBundleName
 *
 *     [--no-launch-storyboard]                  # 可选：本机 Xcode 缺 iOS 平台登记、ibtool 报 "Platform Not Installed" 时启用：
 *                                              #   启动图改用 iOS14+ 纯配置 UILaunchScreen，并把两个 LaunchScreen*.storyboard
 *                                              #   移出 Copy Bundle Resources（不再经 ibtool 编译），让完整工程能在这台机器上 BUILD SUCCEEDED。
 *                                              #   代价：启动屏变为系统默认纯色、不再有 DCloud 品牌启动图；平台装齐后可改回 storyboard。
 *
 * 脚本自动完成（文件/plist 级，无需 Xcode）：
 *   1. 资源 → Pandora/apps/<appid>/www（并修正 manifest.json 的 id 与 dcloud_control.xml）
 *   2. AppKey → 主目标 Info.plist 的 <key>dcloud_appkey</key>
 *   3. UIBackgroundModes: audio → Info.plist（网关常驻 + 退后台保活，必需）
 *   4. 网关资产 → <xcodeproj 所在工程根>/gateway/（gateway.bundle.mjs + static/cues，首启由 GatewayNode.swift 解包）。
 *      注意：DCloud 标准布局里 .xcodeproj 在工程根目录，而 Pandora/源码在子目录；pbxproj 里 gateway 用
 *      `../gateway` 指向工程根，故脚本把网关放到 .xcodeproj 的父目录（而非 --sdk 子目录），其余资源仍在 --sdk。
 *   5. NodeMobile.xcframework → <--sdk>/Frameworks/NodeMobile.xcframework（digidem iOS full 包）
 *   6. 网关 framework：构建 native/ios/app/XiaoxiongGateway.xcodeproj（内含 GatewayNode/GatewayLauncher），
 *      产物拷到 <--sdk>/Frameworks/XiaoxiongGateway.framework，并调 ios-integrate.rb（xcodeproj gem，幂等）
 *      自动接入壳工程：link + Embed(CodeSignOnCopy)、NodeMobile/gateway 资源兜底、
 *      清理旧式手动注入的 Swift 文件、patch AppDelegate.m 调 [GatewayLauncher startEmbeddedGateway]
 *   7. [--no-launch-storyboard] 启动图改 UILaunchScreen 纯配置 + storyboard 移出 Resources（见上方参数说明）
 *
 * 全程无手动 Xcode 步骤：壳工程可随时换新（放好官方 SDK 壳重跑本脚本即可恢复集成）。
 * 壳工程的真机构建与装机用 native/ios/reprovision.sh。
 *
 * 注意：Archive 出 IPA 不需要 appid/AppKey；只有装到设备上「能启动运行」才需要，且 appid、Bundle Identifier、
 * 证书三者必须与 DCloud 开发者中心申请 AppKey 时填的一致，否则启动报「未配置appkey或配置错误」。
 *
 * 已知待确认（拿到真实 iOS 基座后可能需微调）：
 *   - Pandora/ 相对 sdk 根的路径（有的在 <sdk>/Pandora，有的 <sdk>/HBuilder/Pandora）。
 *   - .xcodeproj / 主目标源目录 / 主目标 Info.plist 的具体路径（脚本用搜索兜底）。
 *   脚本已用常见默认值 + 搜索兜底，如不符请用 --plist / --proj 指定。
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

function parseArgs(argv) {
  const out = { gateway: true }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--sdk') out.sdk = argv[++i]
    else if (a === '--appid') out.appid = argv[++i]
    else if (a === '--appkey') out.appkey = argv[++i]
    else if (a === '--plist') out.plist = argv[++i]
    else if (a === '--proj') out.proj = argv[++i]
    else if (a === '--node-ios') out.nodeIos = argv[++i]
    else if (a === '--gateway-bundle') out.gatewayBundle = argv[++i]
    else if (a === '--gateway-cues') out.gatewayCues = argv[++i]
    else if (a === '--no-gateway') out.gateway = false
    else if (a === '--app-name') out.appName = argv[++i]
    else if (a === '--no-launch-storyboard') out.noLaunchStoryboard = true
  }
  return out
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dest, name)
    if (statSync(s).isDirectory()) {
      // 本机工具型目录不进包：如 static/audio/etts-venv（edge-tts 生成提示音的 Python venv，20MB）
      if (/[-_]venv$/.test(name) || name === '__pycache__' || name === '.venv') continue
      copyDir(s, d)
    } else copyFileSync(s, d)
  }
}

/** 安全 stat：悬空 symlink（Pods/旧 build 产物里常见）返回 null，不让遍历炸掉 */
function safeStat(p) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

/** 递归找出目录下所有同名文件 */
function findFiles(dir, filename, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = safeStat(p)
    if (st?.isDirectory()) findFiles(p, filename, acc)
    else if (name === filename) acc.push(p)
  }
  return acc
}

/** 递归找出目录下所有匹配子目录名（如 .xcodeproj / NodeMobile.xcframework） */
function findDirs(dir, dirnameMatch, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = safeStat(p)
    if (!st?.isDirectory()) continue
    if (name === dirnameMatch) acc.push(p)
    else findDirs(p, dirnameMatch, acc)
  }
  return acc
}

/** 递归找出目录下所有以 suffix 结尾的子目录（如工程目录的 *.xcodeproj） */
function findDirsEndsWith(dir, suffix, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = safeStat(p)
    if (!st?.isDirectory()) continue
    if (name.endsWith(suffix)) acc.push(p)
    else findDirsEndsWith(p, suffix, acc)
  }
  return acc
}

/** 在工程目录树里找 .xcodeproj（真实目录名形如 HBuilder-Hello.xcodeproj，不能当字面量匹配） */
function findXcodeproj(from) {
  const hits = [...findDirsEndsWith(from, '.xcodeproj'), ...findDirsEndsWith(dirname(from), '.xcodeproj')]
  return hits
}

const args = parseArgs(process.argv.slice(2))
if (!args.sdk || !args.appid) {
  console.error('用法: node scripts/package-ios-offline.mjs --sdk <iOS SDK 工程路径> --appid <appid> [--appkey <AppKey>] [--node-ios <digidem ios 包>] [--no-gateway]')
  process.exit(1)
}
if (!existsSync(args.sdk)) {
  console.error(`iOS SDK 工程不存在: ${args.sdk}`)
  process.exit(1)
}
const bundle = join(uniAppRoot, 'dist', 'build', 'app')
if (!existsSync(bundle)) {
  console.error(`未找到构建产物 ${bundle}，请先运行 npm run build:app`)
  process.exit(1)
}
const appid = args.appid.trim()

// ── 工程主目录（放 Frameworks/、control.xml 等资源的位置，默认取 --sdk 本身，即源码/Pandora 所在子目录）──
function resolveProjectDir() {
  if (args.proj) return args.proj
  // 注意：不要按字面量 '.xcodeproj' 匹配（真实目录名是 HBuilder-Hello.xcodeproj），否则会找不到而误用父目录。
  // 这里资源（Frameworks/NodeMobile、control.xml、Pandora）都相对 --sdk，故默认回退到 --sdk。
  return args.sdk
}
const projDir = resolveProjectDir()
console.log(`[info] 工程主目录: ${projDir}`)

// ── 网关资产目标目录：放 .xcodeproj 所在的工程根（DCloud 标准布局里 .xcodeproj 在根目录、
//    Pandora/control.xml/源码在子目录，而 pbxproj 里 gateway 用 ../gateway 指向工程根）。
//    仅当 --sdk 指向子目录时，需要向上找一层 .xcodeproj，否则会写错位置导致进不了包。──
function resolveGatewayDestDir() {
  if (args.gatewayBundle) return projDir // 外部 bundle 时信任 projDir
  const xcodeprojs = findXcodeproj(args.sdk)
  if (xcodeprojs.length) return dirname(xcodeprojs[0])
  return projDir
}

// ── 1) 资源 → Pandora/apps/<appid>/www ──
function resolvePandora() {
  const candidates = [join(args.sdk, 'Pandora'), join(args.sdk, 'HBuilder', 'Pandora')]
  for (const c of candidates) if (existsSync(c)) return c
  const found = findDirs(args.sdk, 'Pandora')
  if (found.length) return found[0]
  console.error(`未在 ${args.sdk} 下找到 Pandora 目录（期望 <sdk>/Pandora 或 <sdk>/HBuilder/Pandora）`)
  process.exit(1)
}
const pandora = resolvePandora()
const appsDir = join(pandora, 'apps')
const dataDir = join(pandora, 'data')

// 清掉 apps/ 下旧的 demo 应用目录，避免多个 app 并存让引擎读到错的那个
if (existsSync(appsDir)) {
  for (const name of readdirSync(appsDir)) rmSync(join(appsDir, name), { recursive: true, force: true })
}
const wwwDir = join(appsDir, appid, 'www')
copyDir(bundle, wwwDir)
console.log(`[ok] 资源已接入: ${wwwDir}`)

// ── 2) manifest.json 的 id 必须与 appid 一致 ──
const manifestPath = join(wwwDir, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.id = appid
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
console.log(`[ok] manifest.json id 已设为 ${appid}`)

// ── 3) dcloud_control.xml → Pandora/data/ ──
mkdirSync(dataDir, { recursive: true })
writeFileSync(join(dataDir, 'dcloud_control.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<hbuilder>
  <apps>
    <app appid="${appid}" appver=""/>
  </apps>
</hbuilder>
`)
console.log('[ok] 已写入 dcloud_control.xml -> Pandora/data/')

// ── 3.5) 根目录 control.xml 的 appid 必须同步 ──
// iOS 引擎启动读的是 app bundle 根目录的 control.xml（随 Copy Bundle Resources 打进包），
// 不是 Pandora/data/dcloud_control.xml（那份是 Android/运行时用的）。SDK 示例默认 __UNI__2302A5F，
// 不改就会去 Pandora/apps/<旧 appid>/www 找资源，导致装到真机后白屏。
const ctrlCandidates = [join(projDir, 'control.xml'), ...findFiles(args.sdk, 'control.xml')]
  .filter((p, i, a) => a.indexOf(p) === i && existsSync(p) && !p.includes('/build/'))
for (const ctrl of ctrlCandidates) {
  const s = readFileSync(ctrl, 'utf8')
  const re = /(<app\s+appid=")[^"]*("[^>]*\/>)/g
  if (re.test(s)) {
    writeFileSync(ctrl, s.replace(re, `$1${appid}$2`))
    console.log(`[ok] control.xml appid 已设为 ${appid}: ${ctrl}`)
  }
}

// ── 4) AppKey + UIBackgroundModes:audio → 主目标 Info.plist ──
/** 递归收集所有以 nameEndsWith 结尾的文件 */
function findFilesEndsWith(dir, nameEndsWith, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = safeStat(p)
    if (st?.isDirectory()) {
      findFilesEndsWith(p, nameEndsWith, acc)
    } else {
      if (name.endsWith(nameEndsWith)) acc.push(p)
    }
  }
  return acc
}
function findInfoPlist() {
  if (args.plist) return args.plist
  // 主 target plist 可能叫 Info.plist 或 <Target>-Info.plist；优先匹配含 dcloud_appkey 的那个
  const candidates = [
    ...findFiles(args.sdk, 'Info.plist'),
    ...findFilesEndsWith(args.sdk, 'Info.plist'),
  ].filter((p, i, a) => a.indexOf(p) === i) // 去重
  const withAppKey = candidates.find((p) => /dcloud_appkey/.test(readFileSync(p, 'utf8')))
  if (withAppKey) return withAppKey
  const withBundleId = candidates.find((p) => /CFBundleIdentifier/.test(readFileSync(p, 'utf8')))
  return withBundleId || candidates[0] || null
}
const plistPath = findInfoPlist()
if (!plistPath) {
  console.error('[error] 未找到主目标 Info.plist，请用 --plist 指定')
  process.exit(1)
}
console.log(`[info] 主目标 Info.plist: ${plistPath}`)
let plist = readFileSync(plistPath, 'utf8')

// 应用显示名（Android 侧由 strings.xml app_name 承载；iOS 侧由 Info.plist 的
// CFBundleDisplayName / CFBundleName 承载）。图标因 iOS 用 AppIcon.appiconset 多尺寸合集，
// 纯文本 env 不便配置，仍走 Xcode Assets.xcassets 手动替换（见 GATEWAY_INTEGRATION.md）。
if (args.appName) {
  const name = args.appName.trim()
  for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
    const re = new RegExp(`(<key>${key}</key>\\s*)<string>[^<]*</string>`)
    if (re.test(plist)) {
      plist = plist.replace(re, `$1<string>${name}</string>`)
    } else {
      plist = plist.replace(/<\/dict>\s*<\/plist>/,
        `\t<key>${key}</key>\n\t<string>${name}</string>\n</dict>\n</plist>`)
    }
  }
  console.log(`[ok] 应用显示名 -> ${name} (Info.plist CFBundleDisplayName/CFBundleName)`)
} else {
  console.log('[info] 未提供 --app-name：沿用 Info.plist 现有显示名')
}

if (args.appkey) {
  const appkey = args.appkey.trim()
  const keyRe = /<key>dcloud_appkey<\/key>\s*<string>[^<]*<\/string>/
  if (keyRe.test(plist)) {
    plist = plist.replace(keyRe, `<key>dcloud_appkey</key>\n\t<string>${appkey}</string>`)
  } else {
    plist = plist.replace(/<\/dict>\s*<\/plist>/,
      `\t<key>dcloud_appkey</key>\n\t<string>${appkey}</string>\n</dict>\n</plist>`)
  }
  console.log(`[ok] AppKey 已写入 Info.plist 的 dcloud_appkey: ${plistPath}`)
} else {
  console.warn('[warn] 未提供 --appkey：IPA 可 Archive，但装到设备会因 AppKey 校验失败无法启动')
}

// UIBackgroundModes: audio（网关常驻 + 退后台保活，必需）
if (/<key>UIBackgroundModes<\/key>/.test(plist)) {
  if (!/UIBackgroundModes<\/key>\s*<array>[\s\S]*<string>audio<\/string>/.test(plist)) {
    plist = plist.replace(/(<key>UIBackgroundModes<\/key>\s*<array>)/,
      `$1\n\t\t<string>audio</string>`)
    console.log('[ok] Info.plist UIBackgroundModes 已追加 audio')
  } else {
    console.log('[info] Info.plist 已有 UIBackgroundModes:audio，跳过')
  }
} else {
  plist = plist.replace(/<\/dict>\s*<\/plist>/,
    `\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>audio</string>\n\t</array>\n</dict>\n</plist>`)
  console.log('[ok] Info.plist 已新增 UIBackgroundModes:audio')
}
// 可选：本机 Xcode 缺配套 iOS 平台登记、ibtool 编 storyboard 报 "iOS x.x Platform Not Installed" 时启用。
// 启动图改用 iOS14+ 纯配置 UILaunchScreen（不再引用 storyboard），让完整工程无需装平台即可 BUILD SUCCEEDED。
if (args.noLaunchStoryboard) {
  const sbKeyRe = /<key>UILaunchStoryboardName<\/key>\s*<string>[^<]*<\/string>/
  if (sbKeyRe.test(plist)) {
    plist = plist.replace(sbKeyRe, '<key>UILaunchScreen</key>\n\t<dict/>')
  } else if (!/<key>UILaunchScreen<\/key>/.test(plist)) {
    plist = plist.replace(/<\/dict>\s*<\/plist>/,
      '\t<key>UILaunchScreen</key>\n\t<dict/>\n</dict>\n</plist>')
  }
  console.log('[ok] 启动图: Info.plist 已改用 UILaunchScreen 纯配置')
}
writeFileSync(plistPath, plist)

// 同步把两个 LaunchScreen*.storyboard 移出 Copy Bundle Resources：只要它们还留在 Resources phase，
// Xcode 就会调 ibtool 编译 storyboard，从而触发 "Platform Not Installed"。PBXFileReference 与 group 引用
// 都保留（文件在 Xcode 里仍可见），平台装齐后把 Resources 两行加回即可恢复 DCloud 品牌启动图。
if (args.noLaunchStoryboard) {
  for (const pbx of findFiles(args.sdk, 'project.pbxproj')) {
    let s = readFileSync(pbx, 'utf8')
    const before = s
    s = s.replace(/^[ \t]*[0-9A-Fa-f]{24} \/\* LaunchScreen(?:AD)?\.storyboard in Resources \*\/ = \{[^\n]*\};\n/gm, '')
    s = s.replace(/^[ \t]*[0-9A-Fa-f]{24} \/\* LaunchScreen(?:AD)?\.storyboard in Resources \*\/,\n/gm, '')
    if (s !== before) {
      writeFileSync(pbx, s)
      console.log(`[ok] 启动图: 已把 storyboard 移出 Copy Bundle Resources: ${pbx}`)
    }
  }
}

// ── 5) 内嵌网关资产 → <projDir>/gateway/ ──
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
    console.error(`[error] 未找到网关 bundle: ${bundleFile}\n       先在 gateway 目录跑 npm run build:bundle，或用 --no-gateway 跳过`)
    process.exit(1)
  }
  const gwDir = join(resolveGatewayDestDir(), 'gateway')
  rmSync(gwDir, { recursive: true, force: true })
  mkdirSync(gwDir, { recursive: true })
  copyFileSync(bundleFile, join(gwDir, 'gateway.bundle.mjs'))
  console.log(`[ok] 网关 bundle -> ${gwDir}/gateway.bundle.mjs`)
  if (existsSync(cuesDir)) {
    copyDir(cuesDir, join(gwDir, 'static', 'cues'))
    console.log(`[ok] 提示音 -> ${gwDir}/static/cues/ (${readdirSync(join(gwDir, 'static', 'cues')).length} 个)`)
  } else {
    console.warn(`[warn] 未找到提示音目录 ${cuesDir}：/static/cues/* 会 404（不影响网关启动）`)
  }
} else {
  console.log('[info] --no-gateway：已跳过网关资产接入')
}

// ── 6) NodeMobile.xcframework → <projDir>/Frameworks/ ──
if (args.nodeIos) {
  const nodeIosRoot = resolve(args.nodeIos)
  if (!existsSync(nodeIosRoot)) {
    console.error(`[error] --node-ios 目录不存在: ${nodeIosRoot}`)
    process.exit(1)
  }
  const xcf = findDirs(nodeIosRoot, 'NodeMobile.xcframework')
  if (xcf.length === 0) {
    console.error(`[error] 在 ${nodeIosRoot} 下未找到 NodeMobile.xcframework（应为 digidem ios 包解压目录）`)
    process.exit(1)
  }
  // 注意：pbxproj 里 Frameworks 组没有 path，按 <group> 继承到工程根（.xcodeproj 所在 OUTER 目录），
  // 所以 NodeMobile.xcframework 必须落在 OUTER/Frameworks，而非 --sdk 子目录。用 resolveGatewayDestDir()
  // （返回 .xcodeproj 父目录）作为 Frameworks 基址。
  const fwDir = join(resolveGatewayDestDir(), 'Frameworks')
  mkdirSync(fwDir, { recursive: true })
  const dest = join(fwDir, 'NodeMobile.xcframework')
  rmSync(dest, { recursive: true, force: true })
  copyDir(xcf[0], dest)
  console.log(`[ok] NodeMobile.xcframework -> ${dest}`)
} else {
  console.warn('[warn] 未提供 --node-ios：IPA 不含 Node 运行时，内嵌网关无法启动（下载 digidem ios 包后用 --node-ios 指向其解压目录）')
}

// ── 7) 网关 framework：构建 XiaoxiongGateway 并自动接入壳工程（替代旧手动清单）──
const factoryDir = join(projectRoot, 'native', 'ios', 'app')
const factoryProj = join(factoryDir, 'XiaoxiongGateway.xcodeproj')
if (!existsSync(factoryProj)) {
  console.error(`[error] 未找到工厂工程 ${factoryProj}（见 native/ios/app/README.md）`)
  process.exit(1)
}

// 7a) 构建产物落工厂自己的 .build（gitignore），避免污染全局 DerivedData 难以定位。
// 全量重编译原则：先清 .build 再编——xcodebuild 增量可能产出「时间戳新、内容旧」的 framework。
const fwDerivedData = join(factoryDir, '.build')
rmSync(fwDerivedData, { recursive: true, force: true })
console.log('[step] 构建网关 framework (XiaoxiongGateway) ...')
const fwBuild = spawnSync('xcodebuild', [
  '-project', factoryProj, '-scheme', 'XiaoxiongGateway',
  '-configuration', 'Release', '-destination', 'generic/platform=iOS',
  'CODE_SIGNING_ALLOWED=NO', '-derivedDataPath', fwDerivedData, 'build',
], { stdio: 'inherit' })
if (fwBuild.status !== 0) {
  console.error('[error] XiaoxiongGateway framework 构建失败')
  process.exit(1)
}
const fwProduct = join(fwDerivedData, 'Build', 'Products', 'Release-iphoneos', 'XiaoxiongGateway.framework')
if (!existsSync(fwProduct)) {
  console.error(`[error] 未找到 framework 产物: ${fwProduct}`)
  process.exit(1)
}

// 7b) 产物拷到壳工程 Frameworks/（Embed & Sign 由壳工程构建时完成）
const fwDest = join(resolveGatewayDestDir(), 'Frameworks', 'XiaoxiongGateway.framework')
rmSync(fwDest, { recursive: true, force: true })
copyDir(fwProduct, fwDest)
console.log(`[ok] XiaoxiongGateway.framework -> ${fwDest}`)

// 7c) ios-integrate.rb（xcodeproj gem，幂等）：link + Embed、NodeMobile/gateway 兜底、
//     清理旧式手动注入的 Swift 文件、patch AppDelegate.m
const shellXcodeproj = findXcodeproj(args.sdk)[0]
if (!shellXcodeproj) {
  console.error('[error] 在 --sdk 下找不到壳工程 .xcodeproj')
  process.exit(1)
}
const integrateRb = join(__dirname, 'ios-integrate.rb')
console.log('[step] 自动集成壳工程 (ios-integrate.rb) ...')
const integ = spawnSync('ruby', [integrateRb, '--project', shellXcodeproj, '--framework', 'XiaoxiongGateway'], { stdio: 'inherit' })
if (integ.status !== 0) {
  console.error('[error] 壳工程集成失败')
  process.exit(1)
}

// 旧手动清单已作废（集成已自动化），清掉历史遗留文件
rmSync(join(args.sdk, 'GATEWAY_INTEGRATION.md'), { force: true })

console.log('\n下一步：')
console.log('  1. 壳工程真机构建与装机：native/ios/reprovision.sh（设备离线/待信任不报错）')
console.log('  2. 设备联调：App 启动后网关就绪写 _documents/gateway.url，前端连 ws://127.0.0.1:8787/ws')
