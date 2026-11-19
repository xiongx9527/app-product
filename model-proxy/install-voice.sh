#!/usr/bin/env bash
# 安装本地语音服务：STT（SenseVoice）+ TTS（edge-tts + kokoro），macOS / Linux 原生运行，不使用 Docker。
#
# 安装内容：
#   1. 在 VOICE_HOME 下创建独立 Python 虚拟环境，避免污染系统 Python；
#   2. STT：sherpa-onnx + SenseVoice-small 模型（约 240MB，下载后离线可用）；
#   3. TTS：edge-tts + ffmpeg（在线，edge-tts 只输出 MP3，网关要求 WAV，需要 ffmpeg 转码）；
#   4. TTS 内置 kokoro：kokoro-onnx + 本地 ONNX 模型（约 142MB），纯本地、离线可用，强制安装；
#   5. 首次安装时把 voice.conf.example 复制成 $VOICE_HOME/voice.conf。
#
# 用法:
#   ./model-proxy/install-voice.sh                 # 同时安装 STT + TTS（含 kokoro），并下载全部模型
#   ./model-proxy/install-voice.sh --tts-only      # 只安装 TTS（edge-tts + kokoro），不下载 SenseVoice
#   ./model-proxy/install-voice.sh --stt-only      # 只安装 STT，不装 edge-tts / kokoro / ffmpeg
#   ./model-proxy/install-voice.sh --proxy-only    # 只装基础依赖，代理远程 OpenAI 兼容服务
#   ./model-proxy/install-voice.sh --skip-model    # 安装 STT 依赖但不下载 SenseVoice 模型
#   ./model-proxy/install-voice.sh --skip-kokoro   # 网络受限时跳过 kokoro 模型（不推荐；内置 kokoro 将不可用）
#   ./model-proxy/install-voice.sh --dry-run       # 只打印步骤，不实际安装/下载
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
KOKORO_MODEL_DIR="$VOICE_HOME/models/kokoro"
CONFIG_FILE="$VOICE_HOME/voice.conf"
MODE_FILE="$VOICE_HOME/install-mode"
REQ_DIR="$SCRIPT_DIR/voice"
CONFIG_TEMPLATE="$REQ_DIR/voice.conf.example"
PYTHON_BIN="${PYTHON:-python3}"

# 国内优先走 hf-mirror，失败再回退 huggingface.co；两边是同一份模型。
MODEL_MIRROR="https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"
MODEL_FALLBACK="https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"
# Silero VAD：幻觉二级判断用（打嗝/吸鼻子/回声脑补的单字）。独立仓库，下载到同一个 sensevoice 目录。
VAD_MIRROR="https://hf-mirror.com/onnx-community/silero-vad/resolve/main/onnx"
VAD_FALLBACK="https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx"
# 内置 kokoro 本地 TTS：kokoro-onnx 官方 model-files-v1.1 发布（int8 模型 + 中文音色库）。
# 国内 GitHub 直连常只有几十 KB/s，默认优先走 ghfast.top 镜像（同一 release，非改写包），
# 失败回退官方；可用 KOKORO_MIRROR 环境变量覆盖（设成官方地址即只用官方源）。
KOKORO_RELEASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1"
KOKORO_MIRROR="${KOKORO_MIRROR:-https://ghfast.top/${KOKORO_RELEASE}}"

DO_STT=1
DO_TTS=1
DOWNLOAD_MODEL=1
DOWNLOAD_VAD=1  # Silero VAD 是幻觉二级判断的默认必需依赖；--skip-vad 可跳过
DOWNLOAD_KOKORO=1  # kokoro 是内置强制必装项；仅网络受限时可用 --skip-kokoro 跳过
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
    --skip-vad)
      # 跳过 Silero VAD（幻觉二级判断会降级为文本层）。默认要下载，仅在明确不需要时用。
      DOWNLOAD_VAD=0
      ;;
    --skip-kokoro)
      # 网络受限时的应急开关：跳过 kokoro 模型下载（内置 kokoro 将不可用，不推荐）。
      DOWNLOAD_KOKORO=0
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

log "[1/5] 准备运行目录：${VOICE_HOME}"
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

log "[2/5] 准备 Python 虚拟环境"
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

log "[3/5] 检查 ffmpeg（本地 TTS 把 edge-tts 的 MP3 转成 WAV 需要它）"
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

# 下载到 .part 再改名：中断后下次可以续传，也不会让服务误把半个文件当模型。
# STT / kokoro 模型下载共用；文件够大就跳过，幂等可重复运行。
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

if [ "$PROXY_ONLY" -eq 1 ]; then
  log "[4/5] 跳过 SenseVoice 模型下载（--proxy-only）"
elif [ "$DO_STT" -eq 0 ]; then
  log "[4/5] 跳过 SenseVoice 模型下载（--tts-only）"
elif [ "$DOWNLOAD_MODEL" -eq 0 ]; then
  log "[4/5] 跳过 SenseVoice 模型下载（--skip-model）"
else
  log "[4/5] 下载 SenseVoice 模型（约 240MB）到 ${MODEL_DIR}"

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

  # Silero VAD（幻觉二级判断）：默认必需依赖，镜像失败回退官方源；两个源都失败才 die。
  # 仅在明确 --skip-vad 时跳过（此时幻觉拦截降级为文本层）。
  if [ "$DOWNLOAD_VAD" -eq 1 ]; then
    log "  下载 Silero VAD（幻觉二级判断依赖）..."
    if ! download_file "$VAD_MIRROR/model.onnx" "$MODEL_DIR/silero_vad.onnx" 1000000; then
      log "  镜像下载失败，改用 huggingface.co 重试..."
      download_file "$VAD_FALLBACK/model.onnx" "$MODEL_DIR/silero_vad.onnx" 1000000 \
        || die "VAD 模型下载失败（幻觉二级判断依赖）；网络受限可加 --skip-vad 跳过"
    fi
  else
    log "  已跳过 Silero VAD（--skip-vad）：幻觉拦截降级为文本层"
  fi

  if [ "$DRY_RUN" -eq 0 ]; then
    model_size=$(wc -c <"$MODEL_DIR/model.int8.onnx" | tr -d ' ')
    token_size=$(wc -c <"$MODEL_DIR/tokens.txt" | tr -d ' ')
    [ "$model_size" -ge 100000000 ] || die "model.int8.onnx 不完整（${model_size} 字节）"
    [ "$token_size" -ge 100000 ] || die "tokens.txt 不完整（${token_size} 字节）"
    log "  模型就绪：model.int8.onnx（${model_size} 字节），tokens.txt（${token_size} 字节）"
    if [ -s "$MODEL_DIR/silero_vad.onnx" ]; then
      log "  Silero VAD 就绪（幻觉二级判断可用）"
    elif [ "$DOWNLOAD_VAD" -eq 0 ]; then
      log "  Silero VAD 已按 --skip-vad 跳过（幻觉拦截降级为文本层）"
    else
      die "Silero VAD 模型不完整；检查下载或加 --skip-vad 跳过"
    fi
  fi
fi

# [5/5] 内置 kokoro（纯本地 TTS）模型：kokoro-onnx 依赖在 requirements-tts.txt 强制安装，
# 这里强制下载全精度 ONNX 模型 + 中文音色库到 $VOICE_HOME/models/kokoro（约 353MB，离线可用）。
# 不用 int8 量化版：它含 ConvInteger 算子，onnxruntime CPU 版不支持，加载会直接失败。
if [ "$PROXY_ONLY" -eq 1 ]; then
  log "[5/5] 跳过 kokoro 模型下载（--proxy-only）"
elif [ "$DO_TTS" -eq 0 ]; then
  log "[5/5] 跳过 kokoro 模型下载（--stt-only）"
elif [ "$DOWNLOAD_KOKORO" -eq 0 ]; then
  log "[5/5] 已跳过 kokoro 模型（--skip-kokoro）：内置 kokoro 将不可用"
else
  log "[5/5] 下载内置 kokoro 模型（约 353MB）到 ${KOKORO_MODEL_DIR}"
  run mkdir -p "$KOKORO_MODEL_DIR"
  # 最小字节数识别半截文件 / HTML 错误页（官方 release: onnx≈325MB，bin≈28MB）。
  # 镜像失败回退官方；文件已完整时 download_file 直接跳过，幂等。
  download_kokoro_file() {
    local name="$1" dest="$2" min="$3"
    if download_file "$KOKORO_MIRROR/$name" "$dest" "$min"; then
      return 0
    fi
    log "  镜像下载失败，改用 GitHub 官方源重试..."
    download_file "$KOKORO_RELEASE/$name" "$dest" "$min"
  }
  download_kokoro_file "kokoro-v1.0.onnx" \
    "$KOKORO_MODEL_DIR/kokoro-v1.0.onnx" 320000000 \
    || die "kokoro 模型下载失败；网络受限可加 --skip-kokoro 跳过"
  download_kokoro_file "voices-v1.0.bin" \
    "$KOKORO_MODEL_DIR/voices-v1.0.bin" 26000000 \
    || die "kokoro 音色库下载失败；网络受限可加 --skip-kokoro 跳过"
  if [ "$DRY_RUN" -eq 0 ]; then
    kokoro_model_size=$(wc -c <"$KOKORO_MODEL_DIR/kokoro-v1.0.onnx" | tr -d ' ')
    kokoro_voice_size=$(wc -c <"$KOKORO_MODEL_DIR/voices-v1.0.bin" | tr -d ' ')
    [ "$kokoro_model_size" -ge 320000000 ] || die "kokoro-v1.0.onnx 不完整（${kokoro_model_size} 字节）"
    [ "$kokoro_voice_size" -ge 26000000 ] || die "voices-v1.0.bin 不完整（${kokoro_voice_size} 字节）"
    log "  kokoro 就绪：kokoro-v1.0.onnx（${kokoro_model_size} 字节），voices-v1.0.bin（${kokoro_voice_size} 字节）"
  fi
fi

log ""
log "完成。配置文件：${CONFIG_FILE}"
log "安装模式：${INSTALL_MODE}（启动检查会据此跳过未安装的能力）"
log ""
log "启动服务（后台管理，推荐）："
log "  ./model-proxy/voice.sh start"
log "  ./model-proxy/voice.sh status"
log "  ./model-proxy/voice.sh log"
log "  ./model-proxy/voice.sh stop"
log ""
log "前台运行：./model-proxy/start-voice.sh"
log "启动前会检查依赖；缺失时终端和日志会打印安装命令，不会自动安装。"
if [ "$PROXY_ONLY" -eq 1 ]; then
  log ""
  log "仅基础依赖模式：STT / TTS 固定本地实现，仍需各自依赖与模型 / ffmpeg；"
  log "本模式适合只用 LLM 上游代理的场景，启动前无需填写任何语音上游地址。"
fi
log ""
log "网关（xiaoxiong-app/gateway/.env）对应配置："
log "  ASR_PROVIDER=whisper"
log "  ASR_BASE_URL=http://127.0.0.1:9529"
log "  TTS_PROVIDER=edge"
log "  TTS_BASE_URL=http://127.0.0.1:9529"
log "  TTS_PARAMS={\"voice\":\"zh-CN-XiaoxiaoNeural\"}"
log "如果开启了 API Key，再补上 ASR_API_KEY / TTS_API_KEY（与配置文件一致）。"
