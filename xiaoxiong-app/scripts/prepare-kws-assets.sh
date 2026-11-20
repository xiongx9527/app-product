#!/usr/bin/env bash
# 准备 KWS 随包资源：确保依赖已下载，并把 AAR/模型放到原生工程引用位。
# 由 build.sh 在原生编译前调用；也可单独运行。幂等。
#
#   Android: vendor/sherpa-onnx-*.aar      -> native/android/sdk/libs/
#            vendor/<kws-model>/*          -> native/android/app/src/main/assets/kws/<kws-model>/
#   iOS:     vendor/<kws-model>/*          -> native/ios/app/KwsResources/<kws-model>/（供 Xcode 拷入 bundle）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/native/kws/vendor"
MODEL="sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
AAR="sherpa-onnx-2.0.2.aar"

# 1) 缺依赖则下载（AAR + 模型；iOS xcframework 由 SPM 自动拉取，无需手动）
echo "==> [KWS] 确保依赖已下载"
if [ ! -s "$VENDOR/$AAR" ]; then
  "$ROOT/scripts/download-kws-deps.sh" android
fi
if [ ! -s "$VENDOR/$MODEL/tokens.txt" ]; then
  "$ROOT/scripts/download-kws-deps.sh" model
fi

# 2) Android：AAR
echo "==> [KWS] 放置 Android AAR / 模型"
mkdir -p "$ROOT/native/android/sdk/libs"
cp -f "$VENDOR/$AAR" "$ROOT/native/android/sdk/libs/$AAR"
mkdir -p "$ROOT/native/android/app/src/main/assets/kws/$MODEL"
cp -f "$VENDOR/$MODEL"/* "$ROOT/native/android/app/src/main/assets/kws/$MODEL/"

# 3) iOS：模型（xcframework 由 SPM 依赖，不在这里拷）
mkdir -p "$ROOT/native/ios/app/KwsResources/$MODEL"
cp -f "$VENDOR/$MODEL"/* "$ROOT/native/ios/app/KwsResources/$MODEL/"

echo "==> [KWS] 就绪（AAR + 模型已放置，随包编译）"
