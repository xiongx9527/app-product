#!/usr/bin/env bash
# 统一服务管理器：按需启动 / 停止 / 重启 / 查看本地 AI 相关服务。
#
# 服务：
#   ollama   Ollama 本地模型服务（默认 11434；LLM 以本机 Ollama 为上游时可选）
#   voice    本地 AI 服务（LLM + STT + TTS，默认 9529）
#            LLM 为纯 OpenAI 兼容转发代理，上游见 voice.conf 的 LLM_UPSTREAM_BASE_URL
#   gateway  Node 网关（默认 8787，热重载）
#   uniapp   uni-app 前端开发服务
#   backend  ollama + voice + gateway（不含前端）
#   all      ollama + voice + gateway + uniapp（默认）
#
# 用法:
#   ./scripts/services.sh start                 # 全部启动
#   ./scripts/services.sh start voice           # 只启动语音 / AI 服务
#   ./scripts/services.sh start ollama voice    # 启动多个指定服务
#   ./scripts/services.sh stop all              # 按相反顺序停止
#   ./scripts/services.sh restart voice         # 重启指定服务
#   ./scripts/services.sh status [服务...]      # 查看状态
#   ./scripts/services.sh log [服务...]         # 日志尾部（默认 80 行）
#   ./scripts/services.sh log voice -f          # 跟踪单个服务日志
#   ./scripts/services.sh log voice -n 200      # 查看最近 200 行
#   ./scripts/services.sh check [服务...]       # 只检查依赖，不启动
#
# 说明:
#   - voice 仍由 voice.sh 管理，gateway / uniapp 仍由
#     xiaoxiong-app/scripts/dev-server.mjs 管理；本脚本只做统一编排。
#   - 启动 / 重启前不会自动安装依赖；缺什么会提示对应的安装命令。
#   - Ollama 已经由 Ollama.app 等外部进程启动时，stop 不会结束它。
#
# 运行目录:
#   SERVICES_HOME/ollama.pid / ollama.log   Ollama 的 PID 与日志
#   VOICE_HOME/voice.pid / voice.log        语音 / AI 服务的 PID 与日志
#   xiaoxiong-app/logs/dev-*.log            网关 / 前端的日志
#
# 环境变量:
#   SERVICES_HOME  本脚本运行目录，默认 ~/.app-product/services
#   VOICE_HOME     语音 / AI 服务运行目录，默认 ~/.app-product/voice
#   OLLAMA_HOST    Ollama 地址；指向远端时本机不启动 Ollama
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICES_HOME="${SERVICES_HOME:-$HOME/.app-product/services}"
VOICE_HOME="${VOICE_HOME:-$HOME/.app-product/voice}"
export VOICE_HOME
export SERVICES_HOME

DEV_SERVER="$ROOT_DIR/xiaoxiong-app/scripts/dev-server.mjs"
LOGS_DIR="$ROOT_DIR/xiaoxiong-app/logs"
OLLAMA_PID_FILE="$SERVICES_HOME/ollama.pid"
OLLAMA_LOG_FILE="$SERVICES_HOME/ollama.log"
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

is_alive() {
  kill -0 "$1" 2>/dev/null
}

service_known() {
  case "$1" in
    ollama | voice | gateway | uniapp | backend | all) return 0 ;;
    *) return 1 ;;
  esac
}

# 把 all / backend 展开成具体服务，并保持用户输入顺序、去重。
# 结果写进全局 TARGET_LIST：用全局数组而不是 stdout + 进程替换，是为了让 die 能真正
# 终止主脚本（进程替换里的 exit 只结束子 shell，错误会被吞掉，之后又会误报「没有可操作的服务」）。
expand_targets() {
  local input=("$@") item
  [ "${#input[@]}" -gt 0 ] || input=(all)

  local expanded=()
  for item in "${input[@]}"; do
    case "$item" in
      all) expanded+=(ollama voice gateway uniapp) ;;
      backend) expanded+=(ollama voice gateway) ;;
      ollama | voice | gateway | uniapp) expanded+=("$item") ;;
      *) die "未知服务：${item}（可选 ollama / voice / gateway / uniapp / backend / all）" ;;
    esac
  done

  TARGET_LIST=()
  for item in "${expanded[@]}"; do
    case " ${TARGET_LIST[*]-} " in
      *" ${item} "*) ;;
      *) TARGET_LIST+=("$item") ;;
    esac
  done
}

reverse_list() {
  local list=("$@") i
  for ((i = ${#list[@]} - 1; i >= 0; i--)); do
    printf '%s\n' "${list[$i]}"
  done
}

# ── Ollama ───────────────────────────────────────────────────────
ollama_url() {
  local host="${OLLAMA_HOST:-http://127.0.0.1:11434}"
  case "$host" in
    http://* | https://*) printf '%s\n' "${host%/}" ;;
    *) printf 'http://%s\n' "${host%/}" ;;
  esac
}

ollama_is_local() {
  local host="${OLLAMA_HOST:-127.0.0.1:11434}"
  host="${host#http://}"
  host="${host#https://}"
  host="${host%%/*}"
  case "$host" in
    127.0.0.1* | localhost* | 0.0.0.0* | \[::1\]*) return 0 ;;
    *) return 1 ;;
  esac
}

ollama_ready() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "$(ollama_url)/api/tags" >/dev/null 2>&1
  else
    OLLAMA_HOST="$(ollama_url)" ollama list >/dev/null 2>&1
  fi
}

read_ollama_pid() {
  local pid
  pid=$(head -n 1 "$OLLAMA_PID_FILE" 2>/dev/null || true)
  pid="${pid//[!0-9]/}"
  [ -n "$pid" ] && printf '%s\n' "$pid"
}

# PID 可能被系统回收；只有命令行里仍是 ollama serve 时才归本脚本管。
is_ollama_pid() {
  local pid="$1" command_line
  command_line=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command_line" in
    *"ollama serve"*) return 0 ;;
    *) return 1 ;;
  esac
}

managed_ollama_pid() {
  local pid
  pid=$(read_ollama_pid || true)
  if [ -n "$pid" ] && is_alive "$pid" && is_ollama_pid "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi
  return 1
}

start_ollama() {
  local pid i
  if ollama_ready; then
    log "Ollama：已在运行（$(ollama_url)），无需重复启动。"
    return 0
  fi
  rm -f "$OLLAMA_PID_FILE"

  if ! ollama_is_local; then
    log "Ollama：OLLAMA_HOST 指向远端 $(ollama_url)，本机不启动。"
    log "        请先确认远端 Ollama 已启动。"
    return 1
  fi
  if ! command -v ollama >/dev/null 2>&1; then
    log "Ollama：未安装。先运行 ./scripts/install-ollama.sh"
    return 1
  fi

  mkdir -p "$SERVICES_HOME"
  printf '\n=== start @ %s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$OLLAMA_LOG_FILE"
  nohup ollama serve >>"$OLLAMA_LOG_FILE" 2>&1 </dev/null &
  pid=$!
  printf '%s\n' "$pid" >"$OLLAMA_PID_FILE"

  # 首次加载模型可能稍慢；最多等 15 秒，仍然失败才报错。
  i=0
  while [ "$i" -lt 30 ]; do
    if ollama_ready; then
      log "Ollama：已启动（pid=${pid}，$(ollama_url)）。"
      log "  日志：${OLLAMA_LOG_FILE}"
      return 0
    fi
    if ! is_alive "$pid"; then
      break
    fi
    sleep 0.5
    i=$((i + 1))
  done

  rm -f "$OLLAMA_PID_FILE"
  log "Ollama：启动失败。最近日志："
  tail -n 20 "$OLLAMA_LOG_FILE" 2>/dev/null || true
  return 1
}

stop_ollama() {
  local pid i
  if pid=$(managed_ollama_pid); then
    log "Ollama：正在停止（pid=${pid}）..."
    kill "$pid" 2>/dev/null || true
    i=0
    while [ "$i" -lt 50 ] && is_alive "$pid"; do
      sleep 0.1
      i=$((i + 1))
    done
    if is_alive "$pid"; then
      log "Ollama：进程未在 5 秒内退出，强制结束。"
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$OLLAMA_PID_FILE"
    log "Ollama：已停止。"
    return 0
  fi

  rm -f "$OLLAMA_PID_FILE"
  if ollama_ready; then
    log "Ollama：服务由外部进程（如 Ollama.app）运行，本脚本不会结束它。"
    log "        如需停止，请从菜单栏退出 Ollama。"
    return 0
  fi
  log "Ollama：未在运行。"
  return 0
}

status_ollama() {
  local pid
  if pid=$(managed_ollama_pid); then
    if ollama_ready; then
      log "Ollama：运行中（pid=${pid}，$(ollama_url)）"
      return 0
    fi
    log "Ollama：进程存在但服务未就绪（pid=${pid}）"
    return 1
  fi
  if ollama_ready; then
    log "Ollama：运行中（外部进程，$(ollama_url)）"
    return 0
  fi
  log "Ollama：未运行"
  return 3
}

check_ollama() {
  if ! command -v ollama >/dev/null 2>&1; then
    log "Ollama：未安装。运行 ./scripts/install-ollama.sh 后重试。"
    return 1
  fi
  if ! ollama_is_local; then
    log "Ollama：使用远端 $(ollama_url)（本机不检查进程）。"
  elif ollama_ready; then
    log "Ollama：可用（$(ollama_url)）"
  else
    log "Ollama：已安装但未运行；start 时会自动拉起。"
  fi
  return 0
}

# ── voice / gateway / uniapp ─────────────────────────────────────
run_voice() {
  local command="$1"
  [ -x "$SCRIPT_DIR/voice.sh" ] || {
    log "voice：未找到可执行脚本 ${SCRIPT_DIR}/voice.sh"
    return 1
  }
  "$SCRIPT_DIR/voice.sh" "$command"
}

run_dev_server() {
  local command="$1" service="$2"
  if ! command -v node >/dev/null 2>&1; then
    log "${service}：未找到 node。请先安装 Node.js 18+。"
    return 1
  fi
  [ -f "$DEV_SERVER" ] || {
    log "${service}：未找到 ${DEV_SERVER}"
    return 1
  }
  node "$DEV_SERVER" "$command" "$service"
}

check_dev_service() {
  local service="$1" dir
  if ! command -v node >/dev/null 2>&1; then
    log "${service}：未找到 node。请先安装 Node.js 18+。"
    return 1
  fi
  if [ "$service" = "gateway" ]; then
    dir="$ROOT_DIR/xiaoxiong-app/gateway"
  else
    dir="$ROOT_DIR/xiaoxiong-app/uni_app"
  fi
  [ -d "$dir" ] || {
    log "${service}：未找到目录 ${dir}"
    return 1
  }
  if [ -d "$dir/node_modules" ]; then
    log "${service}：可用（${dir}）"
  else
    log "${service}：未安装依赖。先运行：cd ${dir} && npm install"
    return 1
  fi
  return 0
}

# ── 统一命令 ─────────────────────────────────────────────────────
start_service() {
  case "$1" in
    ollama) start_ollama ;;
    voice) run_voice start ;;
    gateway) run_dev_server start gateway ;;
    uniapp) run_dev_server start uniapp ;;
  esac
}

stop_service() {
  case "$1" in
    ollama) stop_ollama ;;
    voice) run_voice stop ;;
    gateway) run_dev_server stop gateway ;;
    uniapp) run_dev_server stop uniapp ;;
  esac
}

status_service() {
  case "$1" in
    ollama) status_ollama ;;
    voice) run_voice status ;;
    gateway) run_dev_server status gateway ;;
    uniapp) run_dev_server status uniapp ;;
  esac
}

check_service() {
  case "$1" in
    ollama) check_ollama ;;
    voice) run_voice check ;;
    gateway | uniapp) check_dev_service "$1" ;;
  esac
}

service_log_file() {
  case "$1" in
    ollama) printf '%s\n' "$OLLAMA_LOG_FILE" ;;
    voice) printf '%s\n' "$VOICE_HOME/voice.log" ;;
    gateway) printf '%s\n' "$LOGS_DIR/dev-gateway.log" ;;
    uniapp) printf '%s\n' "$LOGS_DIR/dev-uniapp.log" ;;
  esac
}

show_log() {
  local services=("$@") follow="$FOLLOW" lines="$LOG_LINES" service file
  if [ "$follow" -eq 1 ] && [ "${#services[@]}" -ne 1 ]; then
    die "-f / --follow 只能配合单个服务使用"
  fi
  for service in "${services[@]}"; do
    file=$(service_log_file "$service")
    log ""
    log "========== ${service} 日志（${file}）=========="
    if [ ! -f "$file" ]; then
      log "（暂无日志）"
      continue
    fi
    if [ "$follow" -eq 1 ]; then
      tail -n "$lines" -f "$file"
    else
      tail -n "$lines" "$file"
    fi
  done
  return 0
}

# 启动 / 停止时逐个执行，某个服务失败不影响其它服务；最后统一汇总。
run_each() {
  local action="$1"
  shift
  local services=("$@") service failed=()
  for service in "${services[@]}"; do
    log ""
    log "── ${action} ${service} ─────────────────────────────"
    case "$action" in
      start) start_service "$service" || failed+=("$service") ;;
      stop) stop_service "$service" || failed+=("$service") ;;
      # status 是查询：voice.sh / status_ollama 对「未运行」返回 3，那是正常状态而非失败，
      # 吞掉非零即可，否则会被汇总成「status失败」并让整个命令退出 1。
      status) status_service "$service" || true ;;
      check) check_service "$service" || failed+=("$service") ;;
      *) die "内部错误：未知动作 ${action}" ;;
    esac
  done

  if [ "${#failed[@]}" -gt 0 ]; then
    log ""
    log "以下服务${action}失败：${failed[*]}"
    return 1
  fi
  return 0
}

# ── 参数解析 ─────────────────────────────────────────────────────
COMMAND="${1:-start}"
if [ $# -gt 0 ]; then
  shift
fi

TARGETS=()
FOLLOW=0
LOG_LINES="$DEFAULT_TAIL"

case "$COMMAND" in
  start | stop | restart | status | check)
    while [ $# -gt 0 ]; do
      case "$1" in
        -h | --help)
          usage
          exit 0
          ;;
        -*)
          die "未知参数：${1}（服务名写在命令后，例如 start voice）"
          ;;
        *)
          TARGETS+=("$1")
          ;;
      esac
      shift
    done
    ;;
  log | logs)
    while [ $# -gt 0 ]; do
      case "$1" in
        -f | --follow)
          FOLLOW=1
          ;;
        -n | --lines)
          shift
          [ $# -gt 0 ] || die "-n / --lines 需要一个数字"
          LOG_LINES="$1"
          ;;
        -h | --help)
          usage
          exit 0
          ;;
        -*)
          die "未知参数：${1}（用法：log [服务...] [-f] [-n 行数]）"
          ;;
        *)
          TARGETS+=("$1")
          ;;
      esac
      shift
    done
    case "$LOG_LINES" in
      '' | *[!0-9]*) die "行数必须是数字：${LOG_LINES}" ;;
    esac
    [ "$LOG_LINES" -gt 0 ] || die "行数必须是正整数：${LOG_LINES}"
    ;;
  -h | --help | help)
    usage
    exit 0
    ;;
  *)
    die "未知命令：${COMMAND}（支持 start / stop / restart / status / log / check）"
    ;;
esac

# 未指定服务时 expand_targets 会默认按 all 展开；${TARGETS[@]+...} 让 Bash 3.2
# 在 set -u 下安全展开空数组（直接写 "${TARGETS[@]}" 会报 unbound variable）。
expand_targets ${TARGETS[@]+"${TARGETS[@]}"}
if [ "${#TARGET_LIST[@]}" -eq 0 ]; then
  die "没有可操作的服务"
fi

case "$COMMAND" in
  start)
    run_each start "${TARGET_LIST[@]}"
    ;;
  stop)
    REVERSED=()
    while IFS= read -r item; do
      [ -n "$item" ] && REVERSED+=("$item")
    done < <(reverse_list "${TARGET_LIST[@]}")
    run_each stop "${REVERSED[@]}"
    ;;
  restart)
    REVERSED=()
    while IFS= read -r item; do
      [ -n "$item" ] && REVERSED+=("$item")
    done < <(reverse_list "${TARGET_LIST[@]}")
    log "先停止：${REVERSED[*]}"
    run_each stop "${REVERSED[@]}" || true
    sleep 0.5
    log ""
    log "再启动：${TARGET_LIST[*]}"
    run_each start "${TARGET_LIST[@]}"
    ;;
  status)
    run_each status "${TARGET_LIST[@]}"
    ;;
  check)
    run_each check "${TARGET_LIST[@]}"
    ;;
  log)
    show_log "${TARGET_LIST[@]}"
    ;;
esac
