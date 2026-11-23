#!/usr/bin/env bash
# 安装内置 OCR（PaddleOCR / PP-OCRv5）到语音服务的 venv（单进程内嵌，不加端口）。
#
# 关键点（实测踩坑，务必按此顺序）：
#   1) paddlepaddle 用百度官方源（PyPI 无 cp312 macOS wheel 或极慢）；paddleocr/paddlex 用清华源；
#   2) 必须钉住 numpy==1.26.4，否则 pip 会升到 numpy2.x 顶掉 torch2.2 → 内置重排崩；
#   3) pypdfium2 编译时从 GitHub 下 pdfium 二进制，国内断连——脚本用 gh-proxy 预下 + 本地缓存绕过。
#
# 用法：
#   ./model-proxy/install-ocr.sh            # 安装
#   ./model-proxy/install-ocr.sh --verify   # 只验证（不安装）
set -euo pipefail

VOICE_HOME="${VOICE_HOME:-$HOME/.app-product/voice}"
VENV_PY="$VOICE_HOME/venv/bin/python"
VENV_PIP="$VOICE_HOME/venv/bin/pip"
BAIDU_SRC="https://www.paddlepaddle.org.cn/packages/stable/cpu/"
TUNA_SRC="https://pypi.tuna.tsinghua.edu.cn/simple"
PP_VERSION="3.0.0"
PPOCR_VERSION="3.7.0"
PADDLEX_VERSION="3.7.2"
PDFIUM_VER="8138"
PROXY="https://gh-proxy.com/github.com"

if [ ! -x "$VENV_PY" ]; then
  echo "找不到语音服务 venv：$VENV_PY（先跑 install-voice.sh）" >&2
  exit 1
fi

log() { echo "[install-ocr] $*"; }

if [ "${1:-}" = "--verify" ]; then
  "$VENV_PY" - <<'PY'
import numpy, torch
import paddle, paddleocr
from paddleocr import PaddleOCR
print(f"numpy {numpy.__version__} | torch {torch.__version__} | "
      f"paddle {paddle.__version__} | paddleocr {paddleocr.__version__} | OK")
PY
  exit 0
fi

log "1/5 装 paddlepaddle==$PP_VERSION（--no-deps，百度源）"
"$VENV_PIP" install --no-deps "paddlepaddle==$PP_VERSION" -i "$BAIDU_SRC"

log "2/5 装 paddleocr==$PPOCR_VERSION / paddlex==$PADDLEX_VERSION（--no-deps，清华源）"
"$VENV_PIP" install --no-deps "paddleocr==$PPOCR_VERSION" "paddlex==$PADDLEX_VERSION" -i "$TUNA_SRC"

log "3/5 预置 pypdfium2 的 pdfium 二进制缓存（绕过 GitHub 直连失败）"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
URL="$PROXY/bblanchon/pdfium-binaries/releases/download/chromium%2F$PDFIUM_VER"
curl -fsSL --retry 3 --max-time 180 -o "$TMP/pdfium.tgz" "$URL/pdfium-mac-x64.tgz" || {
  echo "pdfium 二进制下载失败，pypdfium2 安装可能卡在 GitHub；可手动下载后重试" >&2
}
# pypdfium2 会自动下载二进制；这里先替它下载到 pip 缓存，后续 pip install 会优先用缓存。
if [ -s "$TMP/pdfium.tgz" ]; then
  SRC=$(find ~/Library/Caches/pip -type d -name "pypdfium2-*" 2>/dev/null | head -1 || true)
  if [ -n "$SRC" ]; then
    mkdir -p "$SRC/data/darwin_x64"
    cp "$TMP/pdfium.tgz" "$SRC/data/darwin_x64/pdfium-mac-x64.tgz" || true
  fi
fi

log "4/5 补依赖（钉住 numpy==1.26.4，保护 torch2.2 重排）"
"$VENV_PIP" install "numpy==1.26.4" "paddleocr==$PPOCR_VERSION" -i "$TUNA_SRC"

log "5/5 验证"
"$VENV_PY" - <<'PY'
import numpy, torch, paddle, paddleocr
from paddleocr import PaddleOCR
print(f"numpy {numpy.__version__} | torch {torch.__version__} | "
      f"paddle {paddle.__version__} | paddleocr {paddleocr.__version__} | OK")
PY
log "完成。模型在首次识别时自动下载到 ~/.paddlex/official_models/"
