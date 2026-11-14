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
ANDROID_SDK_DEFAULT="$ROOT/native/android/sdk/HBuilder-Integrate-AS"

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
IOS_SDK_DIR="${IOS_SDK_DIR:-}"
NODE_IOS="${NODE_IOS:-}"

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
  if [ -z "$IOS_SDK_DIR" ]; then echo "iOS 构建需在 .build_env.$ENV 设置 IOS_SDK_DIR（iOS 离线 SDK 工程根）" >&2; exit 1; fi
  if [ ! -d "$IOS_SDK_DIR" ]; then echo "找不到 iOS 离线 SDK 工程: $IOS_SDK_DIR" >&2; exit 1; fi
fi

# —— 1. 构建 uni-app 前端资源（H5 / APP 共用）——
echo "==> [1/3] 前端资源 (npm run build:app)  [env=$ENV platform=$PLATFORM]"
cd "$UNI_APP"
npm run build:app

# —— 2. 构建内嵌网关 bundle（与前端、原生一起出包）——
echo "==> [2/3] 网关 bundle (npm run build:bundle)"
cd "$ROOT/gateway"
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

if [ "$PLATFORM" = "android" ]; then
  echo "==> [3/3] 接入 Android 离线资源 + 原生编译 (gradle :app:assembleDebug)"
  cd "$ROOT"
  node "$SCRIPT_DIR/package-android-offline.mjs" \
    --sdk "$ANDROID_SDK_DIR" \
    --appid "$APPID" \
    --gateway-bundle "$GATEWAY_BUNDLE" \
    "${APPKEY_ARG[@]}" "${NODE_ARG[@]}"

  cd "$ANDROID_SDK_DIR"
  ./gradlew :app:clean :app:assembleDebug
  echo "==> 完成：APK 位于 $APP_MODULE/build/outputs/apk/debug/"
else
  echo "==> [3/3] 接入 iOS 离线资源（Xcode 手动步骤见 $IOS_SDK_DIR/GATEWAY_INTEGRATION.md）"
  cd "$ROOT"
  node "$SCRIPT_DIR/package-ios-offline.mjs" \
    --sdk "$IOS_SDK_DIR" \
    --appid "$APPID" \
    --gateway-bundle "$GATEWAY_BUNDLE" \
    "${APPKEY_ARG[@]}" "${NODE_ARG[@]}"

  echo "    在 Xcode 打开 $IOS_SDK_DIR 完成 A~D 手动步骤后 Archive 出 IPA。"
fi
