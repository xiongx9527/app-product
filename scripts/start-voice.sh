#!/usr/bin/env bash
# 启动本地语音服务（STT: SenseVoice / TTS: edge-tts），默认监听 0.0.0.0:9529。
#
# 默认监听 0.0.0.0 而不是 127.0.0.1：网关通常在本机，但手机 / 另一台机器调试时
# 需要直接访问。默认不启用 API Key，需要时用 --require-api-key 或配置文件开启。
#
# 启动前会调用 voice/preflight.py 检查依赖环境（本地模式检查模型 / ffmpeg，
# 代理模式检查基础包和上游地址）。检查失败时只打印安装方法，不会自动安装。
#
# 用法:
#   ./scripts/start-voice.sh
#   ./scripts/start-voice.sh --port 9531
#   ./scripts/start-voice.sh --ip 127.0.0.1
#   ./scripts/start-voice.sh --config /path/to/voice.conf
#   ./scripts/start-voice.sh --require-api-key
#   ./scripts/start-voice.sh --api-key-file /path/to/api-key
#   ./scripts/start-voice.sh --api-key off
#
# 环境变量:
#   VOICE_HOME         运行目录，默认 ~/.app-product/voice
#   VOICE_CONFIG       配置文件，默认 $VOICE_HOME/voice.conf
#   VOICE_PORT         监听端口，默认 9529（也可用 --port）
#   VOICE_HOST         监听地址，默认 0.0.0.0（也可用 --host / --ip）
#   VOICE_API_KEY      off / auto / 显式 Key（也可用 --api-key 等参数）
#   VOICE_API_KEY_FILE API Key 文件，默认 $VOICE_HOME/api-key
#   TTS_VOICE          默认音色，默认 zh-CN-XiaoxiaoNeural
#   FFMPEG_BIN         ffmpeg 路径；默认从 PATH 查找
set -euo pipefail

# 启动日志里有中文（模型状态、安装提示）；固定 UTF-8，避免 C/POSIX locale 下编码失败。
export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 与 install-voice.sh 使用同一套目录约定；只启动不安装，缺依赖时服务会明确报错。
VOICE_HOME="${VOICE_HOME:-$HOME/.app-product/voice}"
VENV_PY="$VOICE_HOME/venv/bin/python"
SERVER="$SCRIPT_DIR/voice/openai_voice_server.py"
CHECKER="$SCRIPT_DIR/voice/preflight.py"

CONFIG_FILE="${VOICE_CONFIG:-$VOICE_HOME/voice.conf}"
PORT="${VOICE_PORT:-}"
BIND_HOST="${VOICE_HOST:-}"
API_KEY="${VOICE_API_KEY:-}"
API_KEY_FILE="${VOICE_API_KEY_FILE:-}"
CHECK_ONLY=0

usage() {
  # 打印文件头注释（从第 2 行到 set -euo pipefail 之前），改注释不用同步改行号。
  sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

die() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      shift
      [ $# -gt 0 ] || die "--config 需要一个参数"
      CONFIG_FILE="$1"
      ;;
    --port | -p)
      shift
      [ $# -gt 0 ] || die "--port 需要一个参数"
      PORT="$1"
      ;;
    --host | --ip | -H)
      shift
      [ $# -gt 0 ] || die "--host / --ip 需要一个参数"
      BIND_HOST="$1"
      ;;
    --api-key)
      shift
      [ $# -gt 0 ] || die "--api-key 需要一个参数"
      API_KEY="$1"
      ;;
    --api-key-file)
      shift
      [ $# -gt 0 ] || die "--api-key-file 需要一个参数"
      API_KEY_FILE="$1"
      ;;
    --require-api-key)
      # 等价于 auto：读取 Key 文件，不存在时随机生成并写入。
      API_KEY="auto"
      ;;
    --no-api-key)
      API_KEY="off"
      ;;
    --check-only)
      # 供 voice.sh 在后台启动前同步预检；对用户无副作用。
      CHECK_ONLY=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "未知参数: ${1}（--help 查看用法）"
      ;;
  esac
  shift
done

# 端口只在显式提供时校验；否则由配置文件 / 服务内置默认值决定。
if [ -n "$PORT" ]; then
  case "$PORT" in
    '' | *[!0-9]*) die "端口必须是数字：${PORT}" ;;
  esac
fi

# 只做检查，不在这里自动安装，避免启动脚本偷偷改环境。
# 依赖缺失时由 preflight.py 打印具体的安装命令，用户手动执行安装脚本即可。
[ -x "$VENV_PY" ] || die "未找到虚拟环境：${VENV_PY}
手动安装（启动脚本不会自动安装）：
  ./scripts/install-voice.sh
如果依赖装在别处，请设置 VOICE_HOME 指向包含 venv 的目录。"
[ -f "$SERVER" ] || die "未找到服务脚本：${SERVER}"
[ -f "$CHECKER" ] || die "未找到依赖检查脚本：${CHECKER}"

# 只导出显式设置的值，让配置文件里的其它项继续生效。
export VOICE_CONFIG="$CONFIG_FILE"
export VOICE_HOME
if [ -n "$BIND_HOST" ]; then
  export VOICE_HOST="$BIND_HOST"
fi
if [ -n "$PORT" ]; then
  export VOICE_PORT="$PORT"
fi
if [ -n "$API_KEY" ]; then
  export VOICE_API_KEY="$API_KEY"
fi
if [ -n "$API_KEY_FILE" ]; then
  export VOICE_API_KEY_FILE="$API_KEY_FILE"
fi
if [ -n "${TTS_VOICE:-}" ]; then
  export TTS_VOICE
fi
if [ -n "${FFMPEG_BIN:-}" ]; then
  export FFMPEG_BIN
fi

if [ ! -f "$CONFIG_FILE" ]; then
  log "提示: 配置文件不存在，使用内置默认值；可运行 ./scripts/install-voice.sh 生成模板。"
fi
log "启动前检查依赖环境（只检查，不自动安装）..."
if [ "$CHECK_ONLY" -eq 1 ]; then
  exec "$VENV_PY" "$CHECKER"
fi
"$VENV_PY" "$CHECKER" || exit $?
log ""
log "启动后以服务打印的监听地址、模型状态和鉴权状态为准。"
log "按 Ctrl+C 停止。"
log ""

# exec 让 Python 直接接管当前进程：Ctrl+C、退出码和信号都按预期传递，不会多一层 shell。
exec "$VENV_PY" "$SERVER"
