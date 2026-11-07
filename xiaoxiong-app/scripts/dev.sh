#!/usr/bin/env bash
# 跨平台开发服务器管理（macOS / Linux 包装）。
# 真实逻辑在 dev-server.mjs（Node 实现，三平台通用）；本脚本只负责切到脚本目录并转发参数。
#
# 用法：
#   ./dev.sh                 # 启动全部（热重载）
#   ./dev.sh start           # 启动全部
#   ./dev.sh stop            # 停止全部
#   ./dev.sh restart         # 重启全部
#   ./dev.sh status          # 查看状态
#   ./dev.sh log             # 看日志尾部
#   ./dev.sh start uniapp    # 只启动某个服务（gateway / uniapp）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
exec node dev-server.mjs "$@"
