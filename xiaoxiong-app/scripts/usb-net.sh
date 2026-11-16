#!/usr/bin/env bash
# USB 联网（Android 真机借用电脑网络）的 macOS / Linux 包装。
# 真实逻辑在 usb-net.mjs（Node 实现，三平台通用）；本脚本只切到脚本目录并转发参数。
#
# 用法：
#   ./usb-net.sh                 # 等同 up（默认对所有 USB 在线的 Android 设备生效）
#   ./usb-net.sh up              # 起代理 + 逐台 adb reverse + 写设备全局代理（幂等）
#   ./usb-net.sh down            # 逐台清设备代理 + 删 adb reverse + 停本机代理
#   ./usb-net.sh status          # 查看每台 USB 设备的代理 / 反代 / 本机代理状态
#   ./usb-net.sh up --port 8901  # 换代理端口（默认 8899）
#   ./usb-net.sh up --serial A,B # 只处理指定设备（逗号分隔多台）
#
# 前置：adb 在 PATH；设备用 USB 连接并授权 USB 调试；Node 已在 PATH。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
exec node usb-net.mjs "$@"
