#!/usr/bin/env bash
#
# USB 真机安装脚本（Android / iOS）。
#
# 分工：build.sh 负责「前端构建 + 网关 bundle 一起打 + 资源接入 + 编译产物」；
#       本脚本在其产物上执行「USB 真机安装」这一层，不重复构建逻辑。
#   - Android：build.sh 出 APK 后，用 adb -d 装到当前 USB 在线真机。
#   - iOS：build.sh 完成资源接入后，复用 native/ios/reprovision.sh
#          （xcodebuild + ios-deploy）装到 USB 在线真机。reprovision.sh 已对齐
#          「只处理 ios-deploy -c 列出的在线设备、设备侧状态（离线/待信任/待开开发者模式）
#          不计为错误」的约定，本脚本直接委派。
#
# 网关同包约定：build.sh 已含 npm run build:bundle，本脚本沿用，不再单独处理网关。
#
# 用法：
#   scripts/install.sh <platform> [--env dev] [--no-build]
#     platform   = android | ios | all
#     --env      = dev | test | pro（默认 dev；与 build.sh 同套 .build_env.<env>）
#     --no-build：跳过 build.sh 的「构建/资源整合」步骤，直接安装已有产物。
#                 （android 复用已有 APK；ios 复用已接入资源的 SDK，仍由 reprovision 编译装机）
#
# 前置：
#   - 设备用 USB 连接并授权（Android 开 USB 调试；iOS 信任本机 + 开开发者模式）。
#   - Android：adb 在 PATH（本机 /Users/xiongxiao/Library/Android/sdk/platform-tools）。
#   - iOS：Xcode 命令行工具 + brew ios-deploy；native/ios/build.local 已配 IOS_SDK 等。
#
# 退出码：任一平台安装失败（Android 真失败 / iOS 编译失败）返回 1；
#        iOS 仅设备侧状态（离线/待信任等）不算失败，沿用 reprovision.sh 的 exit 0。

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"            # xiaoxiong-app

# —— 参数解析 ——
PLATFORM=""
ENV="dev"
NO_BUILD=0

usage() {
  cat <<'EOF'
用法: scripts/install.sh <platform> [--env dev] [--no-build]
  platform   android | ios | all
  --env      dev | test | pro  （默认 dev）
  --no-build 跳过 build.sh 的构建/资源整合，直接装已有产物
  -h|--help  显示本帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    android|ios|all) PLATFORM="$1" ;;
    --no-build) NO_BUILD=1 ;;
    --env) ENV="${2:-dev}"; shift ;;
    --env=*) ENV="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

if [ -z "$PLATFORM" ]; then
  echo "请指定平台: android | ios | all" >&2
  usage >&2
  exit 1
fi
case "$ENV" in
  dev|test|pro) ;;
  *) echo "未知环境: ${ENV}（应为 dev|test|pro）" >&2; exit 1 ;;
esac

# —— Android：构建（可选）+ adb 装到 USB 单设备 ——
install_android() {
  if [ "$NO_BUILD" -eq 0 ]; then
    echo "==> [Android] 构建并接入资源 (build.sh $ENV android)"
    if ! bash "$SCRIPT_DIR/build.sh" "$ENV" android; then
      echo "Android 构建失败，中止安装" >&2
      return 1
    fi
  fi

  local APK_DIR="$ROOT/native/android/app/build/outputs/apk/debug"
  if [ ! -d "$APK_DIR" ]; then
    echo "找不到 APK 目录: ${APK_DIR}（先不带 --no-build 构建一次）" >&2
    return 1
  fi
  local APK
  # 取最新修改的 APK（-t 按 mtime 倒序），适配 build.sh 输出的时间戳文件名
  APK="$(ls -1t "$APK_DIR"/*.apk 2>/dev/null | head -1)"
  if [ -z "$APK" ]; then
    echo "该目录无 APK: $APK_DIR" >&2
    return 1
  fi
  echo "==> [Android] APK: $APK"

  if ! command -v adb >/dev/null 2>&1; then
    echo "找不到 adb，请确认 Android SDK platform-tools 在 PATH" >&2
    return 1
  fi

  # 只认 USB 在线设备（adb -d 指向单台 USB 设备，规避模拟器与多设备误装）
  local DEVICES
  DEVICES="$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device"{print $1}')"
  if [ -z "$DEVICES" ]; then
    echo "当前没有 USB 在线的 Android 设备（adb devices 为空）。请连接并授权 USB 调试。" >&2
    return 1
  fi
  local COUNT
  COUNT="$(printf '%s\n' "$DEVICES" | grep -c .)"
  if [ "$COUNT" -gt 1 ]; then
    echo "检测到多台 USB 设备，adb -d 只能指定单台。请保留一台，或手动:" >&2
    echo "  adb -s <serial> install -r -t $APK" >&2
    printf '%s\n' "$DEVICES" >&2
    return 1
  fi

  echo "==> [Android] 安装到 USB 设备"
  # -g 安装时自动授予声明的权限（RECORD_AUDIO 等），避免设备端弹框被拒导致
  # INSTALL_FAILED_ABORTED: User rejected permissions（多见于自动化装机/无头环境）。
  # 已装包先卸载再全新安装：Android 15 / 部分机型对 adb install -r 重装（尤其应用正在运行、
  # 或「通过 USB 安装」开发者开关未开）会直接 INSTALL_FAILED_ABORTED，全新安装路径更稳。
  PKG="com.xiaoxiong.assistant"
  if adb -d shell pm list packages "$PKG" 2>/dev/null | grep -q "$PKG"; then
    echo "==> [Android] 检测到已安装 $PKG，先卸载再全新安装（规避重装被拒）"
    adb -d uninstall "$PKG" || echo "（卸载失败，继续尝试安装）"
  fi
  if ! adb -d install -t -g "$APK"; then
    echo "==> [Android] 安装失败。若仍报 INSTALL_FAILED_ABORTED: User rejected permissions，" >&2
    echo "    请在该 Honor 设备的「开发者选项」中打开「通过 USB 安装」（部分机型为「USB 安装」），" >&2
    echo "    并确保在弹出的安装确认框中点「安装」；若应用在前台运行请先退回桌面。" >&2
    return 1
  fi
}

# —— iOS：资源接入（可选）+ 委派 reprovision.sh 编译装机 ——
install_ios() {
  if [ "$NO_BUILD" -eq 0 ]; then
    echo "==> [iOS] 资源接入 (build.sh $ENV ios)"
    if ! bash "$SCRIPT_DIR/build.sh" "$ENV" ios; then
      echo "iOS 资源接入失败，中止安装" >&2
      return 1
    fi
  fi

  local REPRO="$ROOT/native/ios/reprovision.sh"
  if [ ! -x "$REPRO" ]; then
    echo "找不到 iOS 装机脚本: $REPRO" >&2
    return 1
  fi
  echo "==> [iOS] 编译并装到 USB 真机 (reprovision.sh)"
  # reprovision.sh 自带 USB 设备发现、设备侧状态不报错、exit 0，直接委派
  bash "$REPRO"
  # reprovision 始终 exit 0（设备侧状态不计失败），这里不据其退出码判定
}

# —— 主流程 ——
RC=0
case "$PLATFORM" in
  android)
    install_android || RC=1
    ;;
  ios)
    install_ios || RC=1
    ;;
  all)
    install_android || RC=1
    install_ios || RC=1
    ;;
esac

if [ "$RC" -eq 0 ]; then
  echo "==> 安装完成"
else
  echo "==> 安装存在失败（详见上方输出）" >&2
fi
exit "$RC"
