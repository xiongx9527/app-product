#!/usr/bin/env bash
# 跨平台开发服务器管理（macOS / Linux 包装）。
# 真实逻辑在 dev-server.mjs（Node 实现，三平台通用）；本脚本负责 source 本地 .dev_env、导出环境、切目录并转发参数。
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

# 读取本机开发环境（scripts/.dev_env 不入库；不存在则跳过）
if [ -f "$SCRIPT_DIR/.dev_env" ]; then
  # shellcheck disable=SC1090
  . "$SCRIPT_DIR/.dev_env"
fi
# 导出给 dev-server.mjs（其读取 process.env.PORT 等）
export PORT="${PORT:-8787}"
export UNI_APP_DEV_PORT="${UNI_APP_DEV_PORT:-5173}"
export DEV_HOST="${DEV_HOST:-127.0.0.1}"

cd "$SCRIPT_DIR"
exec node dev-server.mjs "$@"
