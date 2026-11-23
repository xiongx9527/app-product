#!/usr/bin/env bash
# 安装内置重排（rerank）能力：sentence-transformers + 本地 CrossEncoder 模型，非 Docker、原生运行。
#
# 安装内容：
#   1. 复用/创建 voice 的 Python venv（与语音服务共用 ~/.app-product/voice/venv）；
#   2. 安装 sentence-transformers（含 torch，约 2G+ 依赖）；
#   3. 检查本地 bge-reranker 模型目录（默认用已有模型，未找到则提示下载命令，不自动下载大模型）。
#
# 用法：
#   ./model-proxy/install-rerank.sh                 # 安装依赖 + 检查模型
#   ./model-proxy/install-rerank.sh --check         # 只检查环境（依赖/模型），不安装
#   ./model-proxy/install-rerank.sh --dry-run       # 只打印步骤
#
# 环境变量：
#   VOICE_HOME    运行目录，默认 ~/.app-product/voice（venv 在这里）
#   RERANK_MODEL  本地重排模型目录；默认自动探测常见路径（见下方 MODEL_CANDIDATES）
#   PIP_INDEX     pip 源，默认 https://mirrors.aliyun.com/pypi/simple（官方源下 torch 常断连）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VOICE_HOME="${VOICE_HOME:-$HOME/.app-product/voice}"
VENV_DIR="$VOICE_HOME/venv"
VENV_PY="$VENV_DIR/bin/python"
REQ_FILE="$SCRIPT_DIR/voice/requirements-rerank.txt"
PIP_INDEX="${PIP_INDEX:-https://mirrors.aliyun.com/pypi/simple}"
PYTHON_BIN="${PYTHON:-python3}"

DO_CHECK=0
DRY_RUN=0
case "${1:-}" in
  --check) DO_CHECK=1 ;;
  --dry-run) DRY_RUN=1 ;;
  "" ) ;;
  *) echo "未知参数: $1（支持 --check / --dry-run / 无参数安装）" >&2; exit 1 ;;
esac

log() { printf '[install-rerank] %s\n' "$*"; }
run() { if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] $*"; else "$@"; fi; }

# 模型候选路径：优先环境变量，其次常见位置（用户已有模型 / 项目 venv 内）
MODEL_CANDIDATES=(
  "${RERANK_MODEL:-}"
  "$HOME/Workspace/Soft/models/bge-reranker-v2-m3"
  "$HOME/Workspace/Idea/codes/app-product/model-proxy/models/bge-reranker-v2-m3"
  "$VOICE_HOME/models/bge-reranker-v2-m3"
)
find_model() {
  for m in "${MODEL_CANDIDATES[@]}"; do
    [ -n "$m" ] && [ -f "$m/config.json" ] && { echo "$m"; return 0; }
  done
  return 1
}

log "运行目录: $VOICE_HOME"
log "虚拟环境: $VENV_DIR"

if [ "$DO_CHECK" -eq 1 ]; then
  if [ -x "$VENV_PY" ] && "$VENV_PY" -c "import sentence_transformers" 2>/dev/null; then
    log "依赖: OK（sentence-transformers 已装）"
  else
    log "依赖: 缺失（请运行 install-rerank.sh 安装）"
  fi
  if MODEL_PATH="$(find_model)"; then
    log "模型: OK（${MODEL_PATH}）"
  else
    log "模型: 未找到（设 RERANK_MODEL 指向 bge-reranker 目录，或下载 BAAI/bge-reranker-v2-m3）"
  fi
  exit 0
fi

# 1) 准备 venv（复用语音服务的 venv）
if [ -x "$VENV_PY" ]; then
  log "复用已有虚拟环境: $VENV_DIR"
else
  log "创建虚拟环境: $VENV_DIR"
  run "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
run "$VENV_PY" -m pip install --upgrade pip -i "$PIP_INDEX"

# 2) 安装内置重排依赖
log "安装依赖: sentence-transformers（含 torch，较大）"
run "$VENV_PY" -m pip install -i "$PIP_INDEX" -r "$REQ_FILE"

# 3) 检查模型
if MODEL_PATH="$(find_model)"; then
  log "模型就绪: $MODEL_PATH"
  log "配置：面板 Rerank tab 选 builtin，或设 RERANK_UPSTREAM_POOL 的 base_url=$MODEL_PATH / protocol=builtin"
else
  log "警告: 未找到本地重排模型。"
  log "  下载: huggingface-cli download BAAI/bge-reranker-v2-m3 --local-dir ~/.app-product/voice/models/bge-reranker-v2-m3"
  log "  或设 RERANK_MODEL 指向已有模型目录后重跑 --check。"
fi
log "完成。"
