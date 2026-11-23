#!/usr/bin/env bash
# 语音代理内网穿透（Cloudflare Tunnel quick tunnel，无需账号、免费）
#
# 用途：把本地/局域网语音代理（默认 http://192.168.1.100:19529）暴露成公网 https 域名，
#       供 iOS/Android 真机访问。解决"设备与代理隔 WiFi AP 隔离、局域网 IP 直连不通"的问题。
#
# 为什么用 cloudflared：本机已装（brew），quick tunnel 一条命令拿 trycloudflare.com 域名，
#   无需 Cloudflare 账号/域名配置。用 --protocol http2（QUIC 在国内网络会周期性断连：
#   "timeout: no recent network activity"；http2 稳定得多，但仍会偶发重连，cloudflared 会自动重连）。
#
# 用法：
#   ./scripts/voice-tunnel.sh start [本地代理地址]   # 启动隧道，输出域名
#   ./scripts/voice-tunnel.sh status                  # 查看隧道状态与当前域名
#   ./scripts/voice-tunnel.sh url                     # 只输出域名（供脚本调用）
#   ./scripts/voice-tunnel.sh apply [域名]            # 把域名写进三处默认地址配置（需重新打包）
#   ./scripts/voice-tunnel.sh stop                    # 停止隧道
#
# 注意：
#   - quick tunnel 域名每次启动都会变（随机 xxx.trycloudflare.com）。换域名后要：
#       1) ./scripts/voice-tunnel.sh apply <新域名>   写回配置
#       2) 重新 build.sh 出包（iOS/Android 网关 bundle + 前端）
#     若不想每次换域名，需改用 Cloudflare 账号的具名隧道（固定域名），本脚本不含。
#   - 本地代理默认 192.168.1.100:19529（语音代理 app-product-local-ai）；
#     若代理跑在别处，start 时传入地址覆盖。

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJ_ROOT="$(cd "$ROOT/.." && pwd)"
CF_BIN="${CF_BIN:-cloudflared}"
LOCAL_URL="${1:-http://192.168.1.100:19529}"
LOG="/tmp/voice-tunnel.log"
PIDFILE="/tmp/voice-tunnel.pid"
DOMAIN_FILE="/tmp/voice-tunnel.domain"

# 三处默认地址配置（apply 用）
declare -a CONFIG_FILES=(
  "$ROOT/uni_app/src/core/config/storage.ts"
  "$ROOT/gateway/src/config.ts"
  "$ROOT/gateway/src/service/ttsVoices.ts"
  "$ROOT/gateway/.env"
)

get_domain() {
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1
}

case "${1:-status}" in
  start)
    LOCAL_URL="${2:-http://192.168.1.100:19529}"
    if ! command -v "$CF_BIN" >/dev/null 2>&1; then
      echo "错误: 找不到 $CF_BIN（brew install cloudflared）"; exit 1
    fi
    # 先停旧的
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      kill "$(cat "$PIDFILE")" 2>/dev/null
    fi
    : > "$LOG"
    echo "启动 cloudflared 隧道 → $LOCAL_URL"
    nohup "$CF_BIN" tunnel --no-autoupdate --protocol http2 --url "$LOCAL_URL" > "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    # 等域名出现（最多 30s）
    for i in $(seq 1 30); do
      d=$(get_domain)
      if [ -n "$d" ]; then
        echo "$d" > "$DOMAIN_FILE"
        echo "域名: $d"
        echo "PID: $(cat "$PIDFILE")"
        echo "日志: $LOG"
        echo ""
        echo "验证: curl -s -m 15 $d/   （返回 {\"service\":\"app-product-local-ai\",...} 即通）"
        echo "写回配置: $0 apply $d   然后重新 build.sh 出包"
        exit 0
      fi
      sleep 1
    done
    echo "错误: 30s 内未拿到域名，查看 $LOG"; exit 1
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null && echo "隧道已停止 (PID $(cat "$PIDFILE"))"
      rm -f "$PIDFILE" "$DOMAIN_FILE"
    else
      echo "无运行中的隧道"
    fi
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "隧道运行中 (PID $(cat "$PIDFILE"))"
      echo "域名: $(get_domain)"
      echo "错误数: $(grep -c 'ERR' "$LOG" 2>/dev/null || echo 0)"
    else
      echo "隧道未运行"
    fi
    ;;
  url)
    get_domain
    ;;
  apply)
    NEW_URL="${2:-$(get_domain)}"
    if [ -z "$NEW_URL" ]; then echo "错误: 无域名，先 start 或传入域名"; exit 1; fi
    echo "把默认地址写为: $NEW_URL"
    for f in "${CONFIG_FILES[@]}"; do
      if [ -f "$f" ]; then
        # 替换 gohho.co / trycloudflare.com / 192.168.1.100:19529 三种旧值
        sed -i.bak -E "s#https://[a-z0-9-]+\.trycloudflare\.com#${NEW_URL}#g; s#https://25946kt718\.goho\.co#${NEW_URL}#g; s#http://192\.168\.1\.100:19529#${NEW_URL}#g" "$f"
        rm -f "$f.bak"
        echo "  更新: $f"
      fi
    done
    echo "完成。重新打包: bash scripts/build.sh dev ios  (或 android)"
    ;;
  *)
    echo "用法: $0 {start [代理地址]|stop|status|url|apply [域名]}"
    exit 1
    ;;
esac
