#!/usr/bin/env bash
# 下载 KWS（端侧关键词唤醒）依赖：sherpa-onnx 原生 SDK + 中文 KWS 模型。
# 幂等：已下载且非空则跳过。产物放 native/kws/vendor/。
#
# 加速源（实测 2026-11-20）：
#   - GitHub 产物走 gh-proxy.com（直连仅 ~30KB/s，镜像 ~190KB/s）
#   - 模型走 ModelScope（3MB/s+），用 int8 量化版（~5MB，随包不占体积）
#
# 用法：
#   ./scripts/download-kws-deps.sh            # 全部
#   ./scripts/download-kws-deps.sh android    # 只下 Android AAR
#   ./scripts/download-kws-deps.sh ios        # 只下 iOS xcframework
#   ./scripts/download-kws-deps.sh model      # 只下模型
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/native/kws/vendor"
MODEL_DIR="$OUT/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
mkdir -p "$OUT" "$MODEL_DIR"

SHERPA_VER="2.0.2"
GH_PROXY="https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download"
MS="https://www.modelscope.cn/api/v1/models/pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/repo"

# GitHub 产物：优先 gh-proxy，失败再直连
fetch_gh() {
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then echo "  已存在，跳过: $(basename "$dest")"; return 0; fi
  local proxy="$GH_PROXY/$url"
  echo "  下载(镜像): $proxy"
  if ! curl -fL --retry 2 --connect-timeout 15 -o "$dest" "$proxy"; then
    echo "  镜像失败，尝试直连: $url"
    rm -f "$dest"
    curl -fL --retry 2 --connect-timeout 15 -o "$dest" "$url"
  fi
}

# ModelScope 单文件
fetch_ms() {
  local file="$1" dest="$2"
  if [ -s "$dest" ]; then return 0; fi
  echo "  下载模型文件: $file"
  curl -fL --retry 3 --connect-timeout 15 -o "$dest" "$MS?Revision=master&FilePath=$file"
}

dl_android() {
  echo "[Android] sherpa-onnx AAR"
  fetch_gh "v$SHERPA_VER/sherpa-onnx-$SHERPA_VER.aar" "$OUT/sherpa-onnx-$SHERPA_VER.aar"
}

dl_ios() {
  echo "[iOS] sherpa-onnx static xcframework"
  fetch_gh "xcframework/sherpa-onnx-v$SHERPA_VER-ios-static.xcframework.zip" \
        "$OUT/sherpa-onnx-v$SHERPA_VER-ios-static.xcframework.zip"
}

dl_model() {
  echo "[Model] 中文 KWS 模型（int8）"
  # int8 三件套 + tokens（keywords.txt 由 prepare 脚本用项目入库的唤醒词表覆盖，不下载官方表）
  fetch_ms "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$MODEL_DIR/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
  fetch_ms "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$MODEL_DIR/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
  fetch_ms "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$MODEL_DIR/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
  fetch_ms "tokens.txt" "$MODEL_DIR/tokens.txt"
  cp -f "$ROOT/native/kws/keywords.txt" "$MODEL_DIR/keywords.txt"
  echo "  模型文件:"
  ls -lh "$MODEL_DIR"
}

case "${1:-all}" in
  android) dl_android ;;
  ios) dl_ios ;;
  model) dl_model ;;
  all) dl_android; dl_ios; dl_model ;;
  *) echo "用法: $0 [all|android|ios|model]"; exit 1 ;;
esac

echo "完成，产物在: $OUT"
