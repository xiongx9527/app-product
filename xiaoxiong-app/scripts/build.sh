#!/usr/bin/env bash
#
# 离线包一键构建（按「环境」+「平台」出包）：
#   uni-app 前端资源构建 → 接入 DCloud SDK + 内嵌网关 → 编译出 APK / 准备 iOS 工程。
#
# 用法：
#   scripts/build.sh <env> <platform>
#     env      = dev | test | pro   （对应 scripts/.build_env.<env> 配置）
#     platform = android | ios
#
# 示例：
#   scripts/build.sh dev android
#   scripts/build.sh pro ios
#   APPID=__UNI_XXXX scripts/build.sh test android   # 单变量也可环境变量覆盖
#
# 说明：
#   - 构建配置按环境拆分：scripts/.build_env.dev / .test / .pro（不入库，从 .build_env.example 复制填值）。
#   - app 工厂（native/android/app）已含 Java 源码、CMake、AndroidManifest、dcloud_properties，
#     本脚本不触碰这些「源」，只跑生成物接入与编译。
#   - Android：引擎 aar 由 app/build.gradle 从 ../sdk/libs 引用；SDK 壳（native/android/sdk）不入库；
#     接完资源后 gradlew :app:assembleDebug 出 APK。
#   - iOS：只做资源接入（package-ios-offline.mjs），Xcode 手动步骤见生成的 GATEWAY_INTEGRATION.md。

set -e -o pipefail

# —— 路径（相对本脚本所在目录解析，与调用位置无关）——
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"            # xiaoxiong-app
UNI_APP="$ROOT/uni_app"
APP_MODULE="$ROOT/native/android/app"
ANDROID_SDK_DEFAULT="$ROOT/native/android/sdk/HBuilder-SDK"

# —— 参数：环境 + 平台 ——
ENV="${1:-}"
PLATFORM="${2:-}"
if [ -z "$ENV" ] || [ -z "$PLATFORM" ]; then
  echo "用法: scripts/build.sh <env> <platform>   env=dev|test|pro  platform=android|ios" >&2
  exit 1
fi
case "$ENV" in
  dev|test|pro) ;;
  *) echo "未知环境: $ENV（应为 dev|test|pro）" >&2; exit 1 ;;
esac
case "$PLATFORM" in
  android|ios) ;;
  *) echo "未知平台: $PLATFORM（应为 android|ios）" >&2; exit 1 ;;
esac

# —— 读取本机构建环境（scripts/.build_env.<env> 优先；可选公共回退 scripts/.build_env 若存在）——
if [ -f "$SCRIPT_DIR/.build_env.$ENV" ]; then
  # shellcheck disable=SC1090
  . "$SCRIPT_DIR/.build_env.$ENV"
elif [ -f "$SCRIPT_DIR/.build_env" ]; then
  # shellcheck disable=SC1090
  . "$SCRIPT_DIR/.build_env"
fi

# —— 可覆盖的参数（优先级：环境变量 > .build_env.<env> > 内置默认）——
# DCloud 的 appid / appkey 按平台各一个（Android / iOS 是独立 app），按 platform 取值；
# 仍可用 APPID / APPKEY 环境变量整体覆盖（跨平台强制同一个）。
if [ "$PLATFORM" = "android" ]; then
  APPID="${APPID:-${ANDROID_APPID:-__UNI__145C29C}}"
  APPKEY="${APPKEY:-${ANDROID_APPKEY:-}}"
else
  APPID="${APPID:-${IOS_APPID:-__UNI__145C29C}}"
  APPKEY="${APPKEY:-${IOS_APPKEY:-}}"
fi
NODE_LIB="${NODE_LIB:-}"
ANDROID_SDK_DIR="${ANDROID_SDK_DIR:-$ANDROID_SDK_DEFAULT}"
IOS_SDK_DIR="${IOS_SDK_DIR:-$ROOT/native/ios/sdk/HBuilder-SDK}"
NODE_IOS="${NODE_IOS:-}"

# 应用品牌（打包的应用名称 / logo）：
#   - APP_DISPLAY_NAME：应用显示名（文字），改写各平台原生显示名；缺省「小熊助手」。
#   - APP_ICON_DIR：品牌资源目录，含 icon.png / splash.png / push.png（二进制，无法纯 env 配置）。
#     留空时按环境回退到 native/branding/<env>/（若存在）；都不存在则沿用各平台默认图标。
APP_DISPLAY_NAME="${APP_DISPLAY_NAME:-小熊助手}"
APP_ICON_DIR="${APP_ICON_DIR:-}"
if [ -z "$APP_ICON_DIR" ] && [ -d "$ROOT/native/branding/$ENV" ]; then
  APP_ICON_DIR="$ROOT/native/branding/$ENV"
fi

# —— 0. 前置检查 ——
if [ ! -d "$UNI_APP" ]; then echo "找不到 uni_app: $UNI_APP" >&2; exit 1; fi
if [ ! -d "$APP_MODULE" ]; then echo "找不到原生工厂模块: $APP_MODULE" >&2; exit 1; fi
if [ -n "$NODE_LIB" ] && [ ! -d "$NODE_LIB" ]; then echo "NODE_LIB 目录不存在: $NODE_LIB" >&2; exit 1; fi
if [ "$PLATFORM" = "android" ]; then
  if [ ! -d "$ANDROID_SDK_DIR" ]; then
    echo "找不到 DCloud 离线 SDK 壳: $ANDROID_SDK_DIR（下载离线 SDK 解压到 native/android/sdk/，或在 .build_env.$ENV 设 ANDROID_SDK_DIR）" >&2
    exit 1
  fi
elif [ "$PLATFORM" = "ios" ]; then
  if [ ! -d "$IOS_SDK_DIR" ]; then echo "找不到 iOS 离线 SDK 工程: $IOS_SDK_DIR（默认指向 native/ios/sdk/HBuilder-SDK；请把官方下载的 iOS 离线 SDK 解压、外层目录改名为 HBuilder-SDK 放到此处，或在 .build_env.$ENV 设 IOS_SDK_DIR）" >&2; exit 1; fi
fi

# —— 1. 构建 uni-app 前端资源（H5 / APP 共用）——
# 原则：每次出包必须全量重编译——uni/vite 有缓存，曾产出「时间戳新、内容旧」的产物
# 导致设备上跑旧代码（2026-11-16 实锤）。构建前必须清产物目录与缓存，禁止增量。
echo "==> [1/3] 前端资源 (清理 + npm run build:app)  [env=$ENV platform=$PLATFORM]"
cd "$UNI_APP"
rm -rf dist/build/app
rm -rf node_modules/.vite
npm run build:app
# static/ 会被整目录拷进产物：剔除本机工具目录（规则与 package-*-offline.mjs 的 copyDir 一致：
# [-_]venv$ 对应 -name "*-venv" 与 "*_venv"，另有 .venv 与 __pycache__）
find dist/build/app -type d \( -name "*-venv" -o -name "*_venv" -o -name ".venv" -o -name "__pycache__" \) -prune -exec rm -rf {} +

# —— 2. 构建内嵌网关 bundle（与前端、原生一起出包）——
echo "==> [2/3] 网关 bundle (清理 + npm run build:bundle)"
cd "$ROOT/gateway"
rm -rf dist
npm run build:bundle
GATEWAY_BUNDLE="$ROOT/gateway/dist/gateway.bundle.mjs"
if [ ! -f "$GATEWAY_BUNDLE" ]; then echo "网关 bundle 未生成: $GATEWAY_BUNDLE" >&2; exit 1; fi

# —— 3. 接入离线资源 + 编译原生（Android gradle / iOS 资源）——
APPKEY_ARG=()
[ -n "$APPKEY" ] && APPKEY_ARG=(--appkey "$APPKEY")
NODE_ARG=()
if [ "$PLATFORM" = "android" ]; then
  [ -n "$NODE_LIB" ] && NODE_ARG=(--node-lib "$NODE_LIB")
else
  [ -n "$NODE_IOS" ] && NODE_ARG=(--node-ios "$NODE_IOS")
fi

# 应用品牌：显示名（--app-name）必传；logo 目录（--icon-dir）仅当存在时传。
BRAND_ARG=(--app-name "$APP_DISPLAY_NAME")
ICON_ARG=()
[ -n "$APP_ICON_DIR" ] && ICON_ARG=(--icon-dir "$APP_ICON_DIR")

if [ "$PLATFORM" = "android" ]; then
  echo "==> [3/3] 接入 Android 离线资源 + 原生编译 (gradle :app:assembleDebug)"
  cd "$ROOT"
  node "$SCRIPT_DIR/package-android-offline.mjs" \
    --sdk "$ANDROID_SDK_DIR" \
    --appid "$APPID" \
    --gateway-bundle "$GATEWAY_BUNDLE" \
    "${BRAND_ARG[@]}" "${ICON_ARG[@]}" "${APPKEY_ARG[@]}" "${NODE_ARG[@]}"

  cd "$ANDROID_SDK_DIR"
  ./gradlew :app:clean :app:assembleDebug

  # 重命名 APK：加「环境 + 时间戳」，便于区分每次出包（:app:clean 已清空旧产物，目录下仅此一个）
  APK_DIR="$APP_MODULE/build/outputs/apk/debug"
  SRC_APK="$(ls -1 "$APK_DIR"/app-debug.apk 2>/dev/null | head -1)"
  if [ -z "$SRC_APK" ]; then
    SRC_APK="$(ls -1 "$APK_DIR"/*.apk 2>/dev/null | head -1)"
  fi
  if [ -n "$SRC_APK" ] && [ -f "$SRC_APK" ]; then
    TS="$(date +%Y%m%d-%H%M%S)"
    DST_APK="$APK_DIR/app-debug-${ENV}-${TS}.apk"
    mv "$SRC_APK" "$DST_APK"
    echo "==> 完成：APK 位于 $DST_APK"
  else
    echo "==> 完成：APK 目录 $APK_DIR 下未找到 app-debug.apk（请检查 gradle 产物名）"
  fi
else
  echo "==> [3/3] 接入 iOS 离线资源（壳工程集成由 ios-integrate.rb 全自动）"
  cd "$ROOT"
  node "$SCRIPT_DIR/package-ios-offline.mjs" \
    --sdk "$IOS_SDK_DIR" \
    --appid "$APPID" \
    --gateway-bundle "$GATEWAY_BUNDLE" \
    "${BRAND_ARG[@]}" "${APPKEY_ARG[@]}" "${NODE_ARG[@]}"

  # 全量重编译原则（iOS 原生侧）：清壳工程旧构建产物与 Xcode 缓存，避免下次 xcodebuild
  # 拿增量产物（时间戳新、内容旧）。注意「文件夹引用」（Pandora/）的增量拷贝不会从产物里
  # 删除已移除的文件——只 clean 不够，必须连 DerivedData 一起删（曾致 .app 残留 72 个 venv 文件）。
  # profile/签名由 reprovision.sh 以设备为 destination 处理。
  echo "==> [3/3+] 清理 iOS 壳工程旧构建产物"
  rm -rf "$IOS_SDK_DIR/build"
  rm -rf "$HOME/Library/Developer/Xcode/DerivedData/HBuilder-Hello-"*
  xcodebuild -workspace "$IOS_SDK_DIR/HBuilder-Hello.xcworkspace" -scheme HBuilder \
    -configuration Debug clean >/dev/null 2>&1 || true

  echo "    真机构建与装机：native/ios/reprovision.sh（或 Xcode 打开 $IOS_SDK_DIR Archive 出 IPA）。"
fi
