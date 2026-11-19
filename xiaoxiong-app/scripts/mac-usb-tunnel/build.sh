#!/usr/bin/env bash
# 编译 mac-usb-tunnel（PeerTalk usbmux USB 端口转发 helper）。
# 依赖：Xcode 命令行工具（clang + Foundation），无需 CocoaPods / IOKit。
# 产物：bin/mac-usb-tunnel（已 gitignore）。
set -e -o pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
mkdir -p bin

FLAGS=(
  -fobjc-arc
  -O2
  -I .
  -framework Foundation
  -lpthread
  Peertalk/PTUSBHub.m
  Peertalk/PTChannel.m
  Peertalk/PTProtocol.m
  main.m
  -o bin/mac-usb-tunnel
)
echo "==> clang ${FLAGS[*]}"
clang "${FLAGS[@]}"
echo "==> 产物: $DIR/bin/mac-usb-tunnel"
