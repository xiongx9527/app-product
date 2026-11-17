#!/usr/bin/env node
/**
 * 安装离线 Android 包到已连接设备，并自动完成「让内嵌网关可靠启动」所需的设备侧授权。
 *
 * 为什么需要本脚本（而不是裸 adb install）：
 *   - 内嵌网关是独立 :gateway 进程里的 Node 服务（监听 127.0.0.1:8787）。
 *   - 荣耀 / 华为的 iaware / trustsbase 会静默拦掉普通后台 Service 的启动；
 *     而 `adb install -r` 重装会清空系统为该应用保存的 Doze/启动白名单，
 *     于是重装后网关服务起不来 → 表现就是「网关连不上 / 设置页下拉无数据」，反复复发。
 *   - 设备侧豁免（dumpsys deviceidle whitelist）是让 :gateway 在荣耀固件上稳定启动的开关，
 *     本脚本在每次安装后重新应用它，使重装不再复发。
 *
 * 用法：
 *   node scripts/install-android-offline.mjs [--apk <apk 路径>] [--pkg <包名>] [--no-launch]
 *
 *   --apk   缺省自动定位 native/android/app/build/outputs/apk/debug/app-debug.apk
 *   --pkg   缺省 com.xiaoxiong.assistant
 *   --no-launch  仅安装+授权，不自动冷启动（默认安装后冷启动并等待 8787 就绪）
 *
 * 依赖：本地 adb 在 PATH 中，且恰好一台设备通过 USB 连接（adb devices 仅一条 device）。
 */
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolve(__dirname, '..') // xiaoxiong-app

function parseArgs(argv) {
  const out = {
    apk: resolve(projectRoot, 'native/android/app/build/outputs/apk/debug/app-debug.apk'),
    pkg: 'com.xiaoxiong.assistant',
    launch: true,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apk') out.apk = resolve(argv[++i])
    else if (a === '--pkg') out.pkg = argv[++i]
    else if (a === '--no-launch') out.launch = false
  }
  return out
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) throw r.error
  return r
}

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return (r.stdout ?? '') + (r.stderr ?? '')
}

const args = parseArgs(process.argv.slice(2))

// 0) adb 可用性 + 设备唯一性
const devices = runCapture('adb', ['devices']).split('\n').filter((l) => /\bdevice\b/.test(l) && !l.startsWith('List'))
if (devices.length === 0) {
  console.error('[error] 未发现已连接的 Android 设备（adb devices 为空）。请用 USB 连接设备并开启调试。')
  process.exit(1)
}
if (devices.length > 1) {
  console.error('[error] 发现多台设备，脚本仅支持单设备。请断开多余设备或用 ANDROID_SERIAL 指定。')
  process.exit(1)
}
console.log(`[ok] 设备已连接: ${devices[0].trim()}`)

// 1) APK 存在性
if (!existsSync(args.apk)) {
  console.error(`[error] 未找到 APK: ${args.apk}\n       请先构建：cd xiaoxiong-app/native/android/sdk/HBuilder-SDK && ./gradlew :app:assembleDebug`)
  process.exit(1)
}

// 2) 干净安装：先 uninstall 再 install（不带 -r）。
//    关键：DCloud 离线包把 www 解压缓存到 data/data/<pkg>/files/apps/<appid>/www，
//    `adb install -r`（替换安装）会保留 data 目录，导致旧 www 不会被新 APK 重新解压——
//    这就是「设备永远跑旧前端 / 下拉空」反复复发的根因。干净安装强制从新 APK 重新解压 www，
//    每次打包都拿到最新前端与网关 bundle，无需手动清数据。代价：应用内已保存的配置（网关 SQLite）
//    会被清空，但设置页的模型目录来自网关实时目录，不受影响，重装后照常填充。
console.log(`[step] 干净安装 APK（先卸载再装，强制刷新 www）: ${args.apk}`)
const uninstall = spawnSync('adb', ['uninstall', args.pkg])
if (uninstall.status === 0) console.log('[ok] 已卸载旧包')
else console.log('[info] 旧包未安装或卸载跳过')
const install = run('adb', ['install', args.apk])
if (install.status !== 0) {
  console.error('[error] 安装失败')
  process.exit(1)
}
console.log('[ok] 安装完成（www 已从新 APK 重新解压）')

// 3) 设备侧豁免：重装会清空白名单，必须重新加回，否则荣耀/华为 iaware 会拦掉 :gateway 启动。
console.log('[step] 重新应用 Doze/启动白名单（绕过 iaware 对后台 Service 的静默拦截）...')
const wl = runCapture('adb', ['shell', `dumpsys deviceidle whitelist +${args.pkg}`])
console.log(`[ok] whitelist: ${wl.trim().split('\n').pop() ?? '(applied)'}`)

// 3b) 麦克风权限：uninstall 重装会清掉所有运行时权限，而 adb 静默安装不会弹授权框。
//     唤醒（网关 ASR）与对话采集都靠原生 AudioRecord 拿麦克风，权限缺失就「喊小熊小熊没反应」。
//     这里用 pm grant 直接授予危险权限，等价于用户在系统设置里点「允许」，免去每次重装后手动授权。
console.log('[step] 授予麦克风权限（RECORD_AUDIO，重装后被清空）...')
const mic = spawnSync('adb', ['shell', 'pm', 'grant', args.pkg, 'android.permission.RECORD_AUDIO'])
if (mic.status === 0) console.log('[ok] RECORD_AUDIO 已授予')
else console.warn(`[warn] RECORD_AUDIO 授予失败（${(mic.stderr ?? '').toString().trim()}），请在系统设置里手动允许麦克风`)

// 3c) 定位权限：天气/位置类工具走懒加载定位（uni.getLocation），重装后被清空且 adb 安装不弹授权框。
//     APK 原生 manifest 已声明 FINE/COARSE 两级定位权限，这里用 pm grant 预授权，
//     免得首次问天气时还要手动去系统设置里允许（尤其荣耀机型静默拒绝）。
for (const perm of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']) {
  const full = `android.permission.${perm}`
  const r = spawnSync('adb', ['shell', 'pm', 'grant', args.pkg, full])
  if (r.status === 0) console.log(`[ok] ${perm} 已授予`)
  else console.warn(`[warn] ${perm} 授予失败（${(r.stderr ?? '').toString().trim()}），首次问天气可能需要手动允许定位`)
}

// 4) 冷启动（确保 :gateway 进程重新拉起，而非沿用旧进程）
if (args.launch) {
  console.log('[step] 强制停止并冷启动 App...')
  run('adb', ['shell', `am force-stop ${args.pkg}`])
  // 稍等进程退出，避免 force-stop 与 start 竞争
  const wait = spawnSync('sleep', ['2'])
  run('adb', ['shell', `am start -n ${args.pkg}/io.dcloud.PandoraEntry`])
  console.log('[ok] 已发起冷启动')

  // 5) 轮询 8787 是否 LISTEN（网关就绪判据）
  let ready = false
  for (let i = 1; i <= 30; i += 1) {
    const out = runCapture('adb', ['shell', 'netstat -tln 2>/dev/null | grep "127.0.0.1:8787.*LISTEN"'])
    if (out.trim()) {
      console.log(`[ok] 网关 8787 已就绪（${i}s），:gateway 进程启动成功`)
      ready = true
      break
    }
    const w = spawnSync('sleep', ['1'])
  }
  if (!ready) {
    console.warn('[warn] 30s 内未检测到 8787 LISTEN。可能设备 iaware 仍拦截，请确认：')
    console.warn('       - 设备「设置 → 应用 → 小熊助手 → 启动管理」改为「手动管理」并允许自启动/后台活动')
    console.warn('       - 或设备已重启导致白名单失效，本脚本重跑一次即可')
    process.exit(2)
  }
  console.log('\n可直接在真机打开「设置」页验证 LLM / 语音模型 / 音色下拉是否填充。')
}
