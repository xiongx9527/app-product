#!/usr/bin/env bash
# 重新生成 App 的本地提示音 mp3。
# 文案 → mp3 统一走 9529 的 OpenAI 兼容 TTS 接口（/voice/v1/audio/speech）。
# 提供商 / base_url / api_key / 模型 / 音色 这 5 个参数从同目录的 .env 读取。
#
# 用法（任意目录均可）：
#   audio-tool/generate-cues.sh             # 生成全部
#   audio-tool/generate-cues.sh greeting    # 只生成指定提示音（可多个）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 读取 .env（5 个参数）──────────────────────────────────────────────
if [ ! -f "${SCRIPT_DIR}/.env" ]; then
  echo "错误：缺少 ${SCRIPT_DIR}/.env，请从 .env.example 复制一份。" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/.env"
set +a

# 必填校验
: "${TTS_PROVIDER:?请在 .env 设置 TTS_PROVIDER}"
: "${VOICE_BASE_URL:?请在 .env 设置 VOICE_BASE_URL}"
: "${TTS_MODEL:?请在 .env 设置 TTS_MODEL}"
: "${TTS_VOICE:?请在 .env 设置 TTS_VOICE}"
# TTS_API_KEY 可为空（本机 9529 默认未开鉴权）

SPEECH_URL="${VOICE_BASE_URL%/}/v1/audio/speech"
OUT_DIR="${SCRIPT_DIR}/../uni_app/src/static/audio"

# api_key 非空时用 Bearer 传给 9529（其鉴权中间件读 Authorization header）
AUTH_ARGS=()
if [ -n "${TTS_API_KEY:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${TTS_API_KEY}")
fi

# 文案清单：文件名|文案。与 uni_app/src/static/audio/README.md 保持一致。
CUES=(
  "greeting|我在"
  "still-there|还在吗？"
  "farewell|那我先退下了，需要时再叫我。"
  "network-down|无法连上网络，请检查网络后重试"
  "gateway-down|无法连上网关，请检查网关后重试"
  "asr-down|语音识别没连好，我暂时听不见你说话"
  "tts-down|语音播报没接好，我没法念出来"
  "llm-down|大模型没接好，我暂时没法回答"
  "mic-denied|麦克风没授权，语音唤醒和对话都用不了，请到设置里开启"
  "asr-error|不好意思，我没听清，你再说一遍好吗"
  "thinking|稍等一下，我还在想哈"
  "queue-full|你说的太多了，我记不住"
  "gateway-preparing|网关启动中，请稍等一下。"
  "gateway-ready|网关已就绪。"
  "llm-error|回答出了问题，请稍后再问我一次。"
  "tts-error|播报出了问题，这一段没能念出来。"
)

# 连通性检查：9529 的 health 在根路径或 /voice 下均可
if ! curl -fsS -m 5 "${VOICE_BASE_URL%/voice}/health" >/dev/null 2>&1 \
   && ! curl -fsS -m 5 "${VOICE_BASE_URL%/}/health" >/dev/null 2>&1; then
  echo "错误：连不上 9529（${VOICE_BASE_URL}），请先启动语音服务（voice.sh start voice）。" >&2
  exit 1
fi

generate_one() {
  local name="$1" text="$2" out="${OUT_DIR}/$1.mp3" tmp="${OUT_DIR}/.$1.mp3.tmp"
  # 文案与音色均为固定中文字符串，无双引号/反斜杠，直接拼 JSON 即可。
  local payload
  payload=$(printf '{"input":"%s","provider":"%s","model":"%s","voice":"%s","response_format":"mp3"}' \
    "$text" "$TTS_PROVIDER" "$TTS_MODEL" "$TTS_VOICE")
  if ! curl -fsS -m 60 -X POST "$SPEECH_URL" \
      -H 'Content-Type: application/json' ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
      -d "$payload" -o "$tmp"; then
    echo "失败：$name（9529 合成出错）" >&2
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$out"
  echo "生成 $(basename "$out")：$text"
}

if [ "$#" -gt 0 ]; then
  for want in "$@"; do
    found=0
    for cue in "${CUES[@]}"; do
      name="${cue%%|*}"; text="${cue#*|}"
      if [ "$name" = "$want" ]; then generate_one "$name" "$text"; found=1; break; fi
    done
    [ "$found" -eq 1 ] || { echo "未知的提示音：$want" >&2; exit 1; }
  done
else
  for cue in "${CUES[@]}"; do
    name="${cue%%|*}"; text="${cue#*|}"
    generate_one "$name" "$text"
  done
fi

echo "完成。输出目录：${OUT_DIR}"
