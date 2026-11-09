#!/usr/bin/env bash
# 本地语音服务管理：后台启动、停止、重启、查看状态和日志。
#
# 真正的启动参数解析在 start-voice.sh；本脚本负责后台常驻和进程管理。
# 服务配置仍来自 $VOICE_HOME/voice.conf（可用 VOICE_CONFIG 或 start 的参数覆盖）。
#
# 用法:
#   ./scripts/voice.sh start                 # 后台启动（默认命令）
#   ./scripts/voice.sh start --port 9531     # 附加参数会传给 start-voice.sh
#   ./scripts/voice.sh stop                  # 停止
#   ./scripts/voice.sh restart               # 重启（重新读取配置文件）
#   ./scripts/voice.sh status                # 查看是否在运行
#   ./scripts/voice.sh check                 # 只做启动前依赖检查
#   ./scripts/voice.sh log                   # 查看日志尾部（默认 80 行）
#   ./scripts/voice.sh log -f                # 持续跟踪日志
#   ./scripts/voice.sh log -n 200            # 查看最近 200 行
#   ./scripts/voice.sh run                   # 前台运行，Ctrl+C 停止
#
# 启动前检查依赖环境；缺失时只把安装方法写进日志 / 终端，不会自动安装。
#
# 运行目录:
#   $VOICE_HOME/voice.pid  进程号
#   $VOICE_HOME/voice.log  服务日志
#
# 环境变量:
#   VOICE_HOME  运行目录，默认 ~/.app-product/voice
#   VOICE_CONFIG 配置文件，默认 $VOICE_HOME/voice.conf
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VOICE_HOME="${VOICE_HOME:-$HOME/.app-product/voice}"
# 调用方可能只把它当普通 shell 变量；导出后 start-voice.sh 和 preflight 才能看到同一个目录。
export VOICE_HOME
if [ -n "${VOICE_CONFIG:-}" ]; then
  export VOICE_CONFIG
fi
START_SCRIPT="$SCRIPT_DIR/start-voice.sh"
VENV_PY="$VOICE_HOME/venv/bin/python"
CHECKER="$SCRIPT_DIR/voice/preflight.py"
PID_FILE="$VOICE_HOME/voice.pid"
# 日志路径默认 $VOICE_HOME/voice.log；voice.conf 写 VOICE_LOG_FILE 可改（支持 ~ 与 $VOICE_HOME）。
LOG_FILE="$VOICE_HOME/voice.log"
if [ -n "${VOICE_CONFIG:-}" ] && [ -f "$VOICE_CONFIG" ]; then
  _conf_line=$(grep -m1 '^[[:space:]]*VOICE_LOG_FILE[[:space:]]*=' "$VOICE_CONFIG" 2>/dev/null || true)
elif [ -f "$VOICE_HOME/voice.conf" ]; then
  _conf_line=$(grep -m1 '^[[:space:]]*VOICE_LOG_FILE[[:space:]]*=' "$VOICE_HOME/voice.conf" 2>/dev/null || true)
else
  _conf_line=""
fi
if [ -n "$_conf_line" ]; then
  _lf=$(printf '%s' "$_conf_line" | cut -d= -f2- | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^["'"'"']//; s/["'"'"']$//' | sed "s|\$VOICE_HOME|$VOICE_HOME|g; s|~|$HOME|g")
  [ -n "$_lf" ] && LOG_FILE="$_lf"
fi
unset _conf_line _lf
DEFAULT_TAIL=80

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

# signal 0 只探测进程是否存在，不发送真实信号。
is_alive() {
  kill -0 "$1" 2>/dev/null
}

# PID 可能被系统回收；只有命令行里仍是语音服务时才认为它归本脚本管。
is_voice_process() {
  local pid="$1" command
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command" in
    *openai_voice_server.py*) return 0 ;;
    *) return 1 ;;
  esac
}

read_pid() {
  local pid
  # 只取第一行：Windows 版 PID 文件还会记录进程启动时间，不能被拼进 PID。
  pid=$(head -n 1 "$PID_FILE" 2>/dev/null || true)
  pid="${pid//[!0-9]/}"
  [ -n "$pid" ] && printf '%s\n' "$pid"
}

running_pid() {
  local pid
  pid=$(read_pid || true)
  if [ -n "$pid" ] && is_alive "$pid" && is_voice_process "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi
  return 1
}

log_tail() {
  if [ -f "$LOG_FILE" ]; then
    log ""
    log "最近日志（${LOG_FILE}）："
    tail -n 40 "$LOG_FILE"
  fi
}

do_start() {
  local pid
  if pid=$(running_pid); then
    log "语音服务已在运行（pid=${pid}），无需重复启动。"
    log "  日志：${LOG_FILE}"
    return 0
  fi
  rm -f "$PID_FILE"

  [ -x "$START_SCRIPT" ] || die "未找到可执行脚本：${START_SCRIPT}"
  mkdir -p "$VOICE_HOME"
  printf '\n=== start @ %s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$LOG_FILE"

  # 先同步预检，失败时直接返回非零并展示原因；不要先报“已启动”再让服务悄悄退出。
  # start-voice.sh 启动时还会再检查一次，这里是为了让后台管理命令本身给出确定的失败结果。
  local check_output
  if ! check_output=$("$START_SCRIPT" --check-only "$@" 2>&1); then
    if [ -n "$check_output" ]; then
      printf '%s\n' "$check_output" >>"$LOG_FILE"
    fi
    {
      printf '启动失败：依赖检查未通过时，请按上方 [check] 提示手动安装。\n'
      printf '启动脚本不会自动安装依赖；完整日志用 ./scripts/voice.sh log 查看。\n'
    } >>"$LOG_FILE"
    log "语音服务启动失败：依赖检查未通过。"
    log_tail
    log ""
    log "完整日志：./scripts/voice.sh log"
    log "安装依赖后重试；启动脚本不会自动安装。"
    return 1
  fi

  # nohup + 后台运行：关闭终端后服务继续存活；start-voice.sh 会 exec Python，
  # 所以 $! 最终就是 Python 服务的进程号。
  nohup "$START_SCRIPT" "$@" >>"$LOG_FILE" 2>&1 </dev/null &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"

  # 给依赖检查留出时间（要导入 fastapi / uvicorn）；入口脚本失败时能及时发现。
  sleep 3
  if is_alive "$pid"; then
    log "语音服务已后台启动（pid=${pid}）。"
    log "  配置文件：${VOICE_CONFIG:-$VOICE_HOME/voice.conf}"
    if [ $# -gt 0 ]; then
      log "  附加参数：$*"
    fi
    log "  日志：${LOG_FILE}"
    log "  状态：./scripts/voice.sh status"
    log "  停止：./scripts/voice.sh stop"
    return 0
  fi

  rm -f "$PID_FILE"
  {
    printf '启动失败：请查看上方日志里的错误信息。\n'
    printf '若是依赖问题，按 [check] 提示手动安装；启动脚本不会自动安装。\n'
  } >>"$LOG_FILE"
  log "语音服务启动失败。"
  log_tail
  log ""
  log "完整日志：./scripts/voice.sh log"
  log "安装依赖后重试；启动脚本不会自动安装。"
  return 1
}

do_stop() {
  local pid i
  if ! pid=$(running_pid); then
    rm -f "$PID_FILE"
    log "语音服务未在运行。"
    return 0
  fi

  log "正在停止语音服务（pid=${pid}）..."
  kill "$pid" 2>/dev/null || true

  # 先等 uvicorn 优雅退出；5 秒还没退出再强制结束。
  i=0
  while [ "$i" -lt 50 ] && is_alive "$pid"; do
    sleep 0.1
    i=$((i + 1))
  done
  if is_alive "$pid"; then
    log "进程未在 5 秒内退出，强制结束。"
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.2
  fi

  rm -f "$PID_FILE"
  log "语音服务已停止。"
}

do_restart() {
  do_stop
  sleep 0.5
  # 临时命令行参数不落盘；重启以配置文件为准。需要临时覆盖时用 start 的参数。
  do_start "$@"
}

do_status() {
  local pid listening
  if ! pid=$(running_pid); then
    log "语音服务：未运行"
    log "  配置文件：${VOICE_CONFIG:-$VOICE_HOME/voice.conf}"
    log "  日志：${LOG_FILE}"
    return 3
  fi

  log "语音服务：运行中（pid=${pid}）"
  log "  配置文件：${VOICE_CONFIG:-$VOICE_HOME/voice.conf}"
  log "  日志：${LOG_FILE}"
  if command -v lsof >/dev/null 2>&1; then
    # 没有监听端口时 lsof 会返回 1；不能让它把 status 的退出码带成失败。
    listening=$(lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null \
      | awk 'NR > 1 { print $9 }' | sort -u | tr '\n' ' ' || true)
    if [ -n "$listening" ]; then
      log "  监听：${listening}"
    fi
  fi
  if [ -s "$LOG_FILE" ]; then
    # 跳过空行，避免日志最后一行恰好是分隔空行时 status 显示为空。
    last=$(tail -n 20 "$LOG_FILE" | awk 'NF { line=$0 } END { print line }')
    if [ -n "$last" ]; then
      log "  最近一行：${last}"
    fi
  fi
  return 0
}

do_log() {
  local lines="$DEFAULT_TAIL" follow=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -f | --follow)
        follow=1
        ;;
      -n | --lines)
        shift
        [ $# -gt 0 ] || die "-n / --lines 需要一个数字"
        lines="$1"
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        die "未知参数: ${1}（用法：log [-f] [-n 行数]）"
        ;;
    esac
    shift
  done
  case "$lines" in
    '' | *[!0-9]*) die "行数必须是数字：${lines}" ;;
  esac
  [ "$lines" -gt 0 ] || die "行数必须是正整数：${lines}"

  [ -f "$LOG_FILE" ] || {
    log "暂无日志：${LOG_FILE}"
    return 0
  }
  log "日志：${LOG_FILE}"
  if [ "$follow" -eq 1 ]; then
    tail -n "$lines" -f "$LOG_FILE"
  else
    tail -n "$lines" "$LOG_FILE"
  fi
}

COMMAND="${1:-start}"
if [ $# -gt 0 ]; then
  shift
fi

case "$COMMAND" in
  start)
    do_start "$@"
    ;;
  stop)
    do_stop
    ;;
  restart)
    do_restart "$@"
    ;;
  status)
    do_status
    ;;
  check | doctor)
    [ -x "$VENV_PY" ] || die "未找到虚拟环境：${VENV_PY}
手动安装（启动脚本不会自动安装）：
  ./scripts/install-voice.sh"
    [ -f "$CHECKER" ] || die "未找到依赖检查脚本：${CHECKER}"
    "$VENV_PY" "$CHECKER"
    ;;
  log | logs)
    do_log "$@"
    ;;
  run | foreground)
    [ -x "$START_SCRIPT" ] || die "未找到可执行脚本：${START_SCRIPT}"
    exec "$START_SCRIPT" "$@"
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    die "未知命令：${COMMAND}（支持 start / stop / restart / status / check / log / run）"
    ;;
esac
