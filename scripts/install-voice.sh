#!/usr/bin/env bash
# 安装本地语音服务：STT（SenseVoice）+ TTS（edge-tts），macOS / Linux 原生运行，不使用 Docker。
#
# 安装内容：
#   1. 在 VOICE_HOME 下创建独立 Python 虚拟环境，避免污染系统 Python；
#   2. STT：sherpa-onnx + SenseVoice-small 模型（约 240MB，下载后离线可用）；
#   3. TTS：edge-tts + ffmpeg（edge-tts 只输出 MP3，网关要求 WAV，需要 ffmpeg 转码）；
#   4. 首次安装时把 voice.conf.example 复制成 $VOICE_HOME/voice.conf。
#
# 用法:
#   ./scripts/install-voice.sh                 # 同时安装 STT + TTS，并下载 SenseVoice 模型
#   ./scripts/install-voice.sh --tts-only      # 只安装 TTS，不下载模型
#   ./scripts/install-voice.sh --stt-only      # 只安装 STT，不装 edge-tts / ffmpeg
#   ./scripts/install-voice.sh --proxy-only    # 只装基础依赖，代理远程 OpenAI 兼容服务
#   ./scripts/install-voice.sh --skip-model    # 安装 STT 依赖但不下载模型
#   ./scripts/install-voice.sh --dry-run       # 只打印步骤，不实际安装/下载
#
# 环境变量:
#   VOICE_HOME  运行目录，默认 ~/.app-product/voice
#   PYTHON      Python 可执行文件，默认 python3
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 运行目录放在用户目录而不是仓库里：模型约 240MB，既避免污染 git 状态，
# 也让同一个仓库的多个工作副本可以复用同一份虚拟环境和模型。
VOICE_HOME="${VOICE_HOME:-$HOME/.app-product/voice}"
VENV_DIR="$VOICE_HOME/venv"
MODEL_DIR="$VOICE_HOME/models/sensevoice"
CONFIG_FILE="$VOICE_HOME/voice.conf"
MODE_FILE="$VOICE_HOME/install-mode"
REQ_DIR="$SCRIPT_DIR/voice"
CONFIG_TEMPLATE="$REQ_DIR/voice.conf.example"
PYTHON_BIN="${PYTHON:-python3}"

# 国内优先走 hf-mirror，失败再回退 huggingface.co；两边是同一份模型。
MODEL_MIRROR="https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"
MODEL_FALLBACK="https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"

DO_STT=1
DO_TTS=1
DOWNLOAD_MODEL=1
PROXY_ONLY=0
DRY_RUN=0

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

# 统一的“执行或只打印”入口：--dry-run 时所有安装/下载动作都只输出不执行。
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --stt-only)
      # 只跑离线转写：不装 edge-tts，也不需要 ffmpeg。
      DO_TTS=0
      ;;
    --tts-only)
      # 只跑在线合成：跳过 240MB 模型，适合先验证网关的 TTS 链路。
      DO_STT=0
      DOWNLOAD_MODEL=0
      ;;
    --proxy-only)
      # 不装本地推理依赖、不下载模型：STT / TTS 都转发到远程 OpenAI 兼容服务。
      DO_STT=0
      DO_TTS=0
      DOWNLOAD_MODEL=0
      PROXY_ONLY=1
      ;;
    --skip-model)
      # 依赖先装好，模型稍后手动补；适合网络受限或想复用已有模型文件的场景。
      DOWNLOAD_MODEL=0
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --python)
      shift
      [ $# -gt 0 ] || die "--python 需要一个参数"
      PYTHON_BIN="$1"
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

if [ "$PROXY_ONLY" -eq 0 ] && [ "$DO_STT" -eq 0 ] && [ "$DO_TTS" -eq 0 ]; then
  die "不能同时指定 --stt-only 和 --tts-only"
fi

# 记录安装模式，供启动前的 preflight 判断哪些本地依赖是“预期缺失”。
# 例如 --tts-only 没装 SenseVoice，启动检查不应因此拒绝启动。
if [ "$PROXY_ONLY" -eq 1 ]; then
  INSTALL_MODE="proxy-only"
elif [ "$DO_STT" -eq 0 ]; then
  INSTALL_MODE="tts-only"
elif [ "$DO_TTS" -eq 0 ]; then
  INSTALL_MODE="stt-only"
else
  INSTALL_MODE="full"
fi

# sherpa-onnx / FastAPI 的较新 wheel 都要求 Python 3.10+；旧版本会在导入时直接报错。
command -v "$PYTHON_BIN" >/dev/null 2>&1 \
  || die "找不到 ${PYTHON_BIN}，请先安装 Python 3.10+，或用 PYTHON=/path/to/python3 指定"
"$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
  || die "需要 Python 3.10+（当前 $("${PYTHON_BIN}" --version 2>&1)）"

log "[1/4] 准备运行目录：${VOICE_HOME}"
run mkdir -p "$VOICE_HOME" "$MODEL_DIR"
log "  安装模式：${INSTALL_MODE}"
if [ "$DRY_RUN" -eq 1 ]; then
  log "  [dry-run] 写入 ${MODE_FILE}"
else
  printf '%s\n' "$INSTALL_MODE" >"$MODE_FILE"
fi

# 只复制模板，不覆盖已有配置：用户改过的端口 / IP / API Key 必须保留。
if [ -f "$CONFIG_FILE" ]; then
  log "  保留已有配置：${CONFIG_FILE}"
elif [ -f "$CONFIG_TEMPLATE" ]; then
  log "  生成配置文件：${CONFIG_FILE}"
  run cp "$CONFIG_TEMPLATE" "$CONFIG_FILE"
else
  log "  警告: 未找到配置模板 ${CONFIG_TEMPLATE}，启动时将使用内置默认值。"
fi

log "[2/4] 准备 Python 虚拟环境"
# 使用 venv 而不是直接 pip install：macOS 的 Homebrew Python 受 PEP 668 保护，
# 系统 Python 也不适合装 200MB 级的推理依赖。
VENV_PY="$VENV_DIR/bin/python"
if [ -x "$VENV_PY" ]; then
  log "  复用已有虚拟环境：${VENV_DIR}"
else
  log "  创建虚拟环境：${VENV_DIR}"
  run "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
run "$VENV_PY" -m pip install --upgrade pip

# STT 和 TTS 的依赖拆成两个文件：--stt-only / --tts-only 时只装需要的那一半。
# --proxy-only 两个都不装，只保留基础依赖（FastAPI / uvicorn / httpx）。
REQS=()
if [ "$DO_STT" -eq 1 ]; then
  REQS+=("-r" "$REQ_DIR/requirements-stt.txt")
fi
if [ "$DO_TTS" -eq 1 ]; then
  REQS+=("-r" "$REQ_DIR/requirements-tts.txt")
fi
if [ "${#REQS[@]}" -eq 0 ]; then
  REQS=("-r" "$REQ_DIR/requirements-base.txt")
fi
log "  安装依赖：$(printf '%s ' "${REQS[@]}")"
run "$VENV_PY" -m pip install "${REQS[@]}"

log "[3/4] 检查 ffmpeg（本地 TTS 把 edge-tts 的 MP3 转成 WAV 需要它）"
if [ "$PROXY_ONLY" -eq 1 ]; then
  log "  跳过：代理模式不需要 ffmpeg"
elif [ "$DO_TTS" -eq 0 ]; then
  log "  跳过：只安装 STT"
elif command -v ffmpeg >/dev/null 2>&1; then
  log "  已安装：$(command -v ffmpeg)"
elif [ "$DRY_RUN" -eq 1 ]; then
  log "  [dry-run] 将尝试用 Homebrew 安装 ffmpeg"
elif command -v brew >/dev/null 2>&1; then
  # macOS 上优先复用 Homebrew；ffmpeg 依赖较多，安装时间可能比 pip 还长。
  log "  安装 ffmpeg..."
  if ! brew install ffmpeg; then
    log "  警告: ffmpeg 安装失败；TTS 的 wav 输出将不可用，可稍后手动安装。"
  fi
else
  log "  警告: 未找到 ffmpeg，TTS 的 wav 输出将不可用。"
  log "        macOS 可先安装 Homebrew 再执行 brew install ffmpeg；"
  log "        Linux 用系统包管理器安装 ffmpeg。"
fi

if [ "$PROXY_ONLY" -eq 1 ]; then
  log "[4/4] 跳过 SenseVoice 模型下载（--proxy-only）"
elif [ "$DO_STT" -eq 0 ]; then
  log "[4/4] 跳过 SenseVoice 模型下载（--tts-only）"
elif [ "$DOWNLOAD_MODEL" -eq 0 ]; then
  log "[4/4] 跳过 SenseVoice 模型下载（--skip-model）"
else
  log "[4/4] 下载 SenseVoice 模型（约 240MB）到 ${MODEL_DIR}"

  # 下载到 .part 再改名：中断后下次可以续传，也不会让服务误把半个文件当模型。
  download_file() {
    local url="$1"
    local dest="$2"
    local min_bytes="$3"
    local size

    if [ -s "$dest" ]; then
      size=$(wc -c <"$dest" | tr -d ' ')
      if [ "$size" -ge "$min_bytes" ]; then
        log "  已存在：$(basename "$dest")（$size 字节），跳过"
        return 0
      fi
      log "  文件不完整，重新下载：$(basename "$dest")"
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [dry-run] 下载 ${url}"
      log "            -> ${dest}"
      return 0
    fi

    local tmp="$dest.part"
    # 上次下载其实已经完成、只差 mv 的情况：直接收尾，避免 curl 续传返回 416。
    if [ -s "$tmp" ]; then
      local part_size
      part_size=$(wc -c <"$tmp" | tr -d ' ')
      if [ "$part_size" -ge "$min_bytes" ]; then
        mv "$tmp" "$dest"
        return 0
      fi
    fi

    if command -v curl >/dev/null 2>&1; then
      curl -fL --retry 3 --retry-delay 2 -C - -o "$tmp" "$url" || return 1
    elif command -v wget >/dev/null 2>&1; then
      wget -c -O "$tmp" "$url" || return 1
    else
      die "需要 curl 或 wget 才能下载模型"
    fi
    mv "$tmp" "$dest"
  }

  # 镜像失败时回退官方源；两边的文件名和内容一致，.part 可以继续复用。
  download_model_file() {
    local name="$1"
    local min_bytes="$2"

    if download_file "$MODEL_MIRROR/$name" "$MODEL_DIR/$name" "$min_bytes"; then
      return 0
    fi

    log "  镜像下载失败，改用 huggingface.co 重试..."
    download_file "$MODEL_FALLBACK/$name" "$MODEL_DIR/$name" "$min_bytes"
  }

  # 最小字节数用来识别“下载到一半”或代理返回的 HTML 错误页，不是精确校验。
  download_model_file "model.int8.onnx" 100000000
  download_model_file "tokens.txt" 100000

  if [ "$DRY_RUN" -eq 0 ]; then
    model_size=$(wc -c <"$MODEL_DIR/model.int8.onnx" | tr -d ' ')
    token_size=$(wc -c <"$MODEL_DIR/tokens.txt" | tr -d ' ')
    [ "$model_size" -ge 100000000 ] || die "model.int8.onnx 不完整（${model_size} 字节）"
    [ "$token_size" -ge 100000 ] || die "tokens.txt 不完整（${token_size} 字节）"
    log "  模型就绪：model.int8.onnx（${model_size} 字节），tokens.txt（${token_size} 字节）"
  fi
fi

log ""
log "完成。配置文件：${CONFIG_FILE}"
log "安装模式：${INSTALL_MODE}（启动检查会据此跳过未安装的能力）"
log ""
log "启动服务（后台管理，推荐）："
log "  ./scripts/voice.sh start"
log "  ./scripts/voice.sh status"
log "  ./scripts/voice.sh log"
log "  ./scripts/voice.sh stop"
log ""
log "前台运行：./scripts/start-voice.sh"
log "启动前会检查依赖；缺失时终端和日志会打印安装命令，不会自动安装。"
if [ "$PROXY_ONLY" -eq 1 ]; then
  log ""
  log "代理模式：启动前必须在上面的配置文件中填写 VOICE_UPSTREAM_BASE_URL 和"
  log "VOICE_UPSTREAM_API_KEY（或 STT_/TTS_ 专属上游配置），否则依赖检查会失败。"
fi
log ""
log "网关（xiaoxiong-app/gateway/.env）对应配置："
log "  ASR_PROVIDER=whisper"
log "  ASR_BASE_URL=http://127.0.0.1:9529"
log "  TTS_PROVIDER=edge"
log "  TTS_BASE_URL=http://127.0.0.1:9529"
log "  TTS_PARAMS={\"voice\":\"zh-CN-XiaoxiaoNeural\"}"
log "如果开启了 API Key，再补上 ASR_API_KEY / TTS_API_KEY（与配置文件一致）。"
