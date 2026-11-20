#!/usr/bin/env bash
# 准备 KWS 随包资源：确保依赖已下载，并把 AAR/模型放到原生工程引用位。
# 由 build.sh 在原生编译前调用；也可单独运行。幂等。
#
#   Android: vendor/sherpa-onnx-*.aar      -> native/android/sdk/libs/
#            vendor/<kws-model>/*          -> native/android/app/src/main/assets/kws/<kws-model>/
#   iOS:     vendor/<kws-model>/*          -> native/ios/app/KwsResources/<kws-model>/（供 Xcode 拷入 bundle）
#            vendor/sherpa-onnx-*-ios-static.xcframework.zip -> native/ios/app/Frameworks/sherpa-onnx.xcframework（static 库，只 link 不 Embed）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/native/kws/vendor"
MODEL="sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
AAR="sherpa-onnx-2.0.2.aar"

# 1) 缺依赖则下载（AAR + 模型）
echo "==> [KWS] 确保依赖已下载"
if [ ! -s "$VENDOR/$AAR" ]; then
  "$ROOT/scripts/download-kws-deps.sh" android
fi
if [ ! -s "$VENDOR/$MODEL/tokens.txt" ]; then
  "$ROOT/scripts/download-kws-deps.sh" model
fi

# 1b) iOS sherpa-onnx static xcframework：从 vendor zip 幂等解压（SPM 并未配置，必须手动解压）
IOS_FW_ZIP="$(find "$VENDOR" -maxdepth 1 -name 'sherpa-onnx-*-ios-static.xcframework.zip' 2>/dev/null | head -1)"
IOS_FW_DIR="$ROOT/native/ios/app/Frameworks/sherpa-onnx.xcframework"
if [ -n "$IOS_FW_ZIP" ] && [ ! -d "$IOS_FW_DIR" ]; then
  echo "==> [KWS] 解压 iOS sherpa-onnx xcframework"
  mkdir -p "$(dirname "$IOS_FW_DIR")"
  unzip -oq "$IOS_FW_ZIP" -d "$(dirname "$IOS_FW_DIR")"
fi

# 2) 用项目入库的关键词表覆盖下载的官方表（官方是「小爱同学」等，不是我们的唤醒词；
#    且 vendor 不入库，必须靠这里覆盖才能保证任意环境 clone 后 KWS 都能正确唤醒）。
echo "==> [KWS] 覆盖唤醒词表"
cp -f "$ROOT/native/kws/keywords.txt" "$VENDOR/$MODEL/keywords.txt"

# 3) Android：AAR + 模型
echo "==> [KWS] 放置 Android AAR / 模型"
mkdir -p "$ROOT/native/android/sdk/libs"
cp -f "$VENDOR/$AAR" "$ROOT/native/android/sdk/libs/$AAR"
mkdir -p "$ROOT/native/android/app/src/main/assets/kws/$MODEL"
cp -f "$VENDOR/$MODEL"/* "$ROOT/native/android/app/src/main/assets/kws/$MODEL/"

# 4) iOS：模型（xcframework 见 1b，由 ios-integrate.rb 拷进壳工程 link）
mkdir -p "$ROOT/native/ios/app/KwsResources/$MODEL"
cp -f "$VENDOR/$MODEL"/* "$ROOT/native/ios/app/KwsResources/$MODEL/"

echo "==> [KWS] 就绪（AAR + 模型 + 唤醒词表 + iOS xcframework 已放置，随包编译）"
