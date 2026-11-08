#!/usr/bin/env bash
# 安装 Ollama（macOS / Linux）。
#
# 用法：
#   ./scripts/install-ollama.sh
#
# 说明：
#   - macOS 优先用 Homebrew；没有 Homebrew 时给出官方安装包地址，不擅自改动系统。
#   - Linux 走 Ollama 官方 install.sh（默认装到 /usr/local）。
#   - Windows 请用同目录的 install-ollama.ps1。
set -euo pipefail

if command -v ollama >/dev/null 2>&1; then
  echo "Ollama 已安装：$(ollama --version 2>/dev/null || echo '版本未知')"
  echo "启动服务：ollama serve（macOS Homebrew 安装可用 brew services start ollama）"
  exit 0
fi

os="$(uname -s)"
case "$os" in
  Darwin)
    if command -v brew >/dev/null 2>&1; then
      echo "==> 使用 Homebrew 安装 Ollama"
      brew install ollama
    elif command -v curl >/dev/null 2>&1; then
      # 没有 Homebrew 时走官方脚本；官方同时支持 macOS 与 Linux。
      echo "==> 使用 Ollama 官方脚本安装"
      curl -fsSL https://ollama.com/install.sh | sh
    else
      cat >&2 <<'EOF'
缺少 curl，无法自动安装 Ollama。

任选一种方式：
  1. 安装 curl / Homebrew 后重跑本脚本：https://brew.sh
  2. 直接下载 macOS 安装包：https://ollama.com/download/Ollama.dmg

安装完成后打开 Ollama.app，再运行 ./scripts/pull-ollama-models.sh。
EOF
      exit 1
    fi
    echo
    echo "安装完成。启动服务："
    echo "  open -a Ollama              # 打开桌面应用（推荐）"
    echo "  ollama serve                # 或仅当前终端启动"
    echo "  brew services start ollama  # Homebrew 安装时可开机自启"
    ;;
  Linux)
    if ! command -v curl >/dev/null 2>&1; then
      echo "缺少 curl，请先安装 curl 再重跑本脚本。" >&2
      exit 1
    fi
    echo "==> 使用官方脚本安装 Ollama"
    curl -fsSL https://ollama.com/install.sh | sh
    echo
    echo "安装完成。启动服务："
    echo "  ollama serve"
    ;;
  *)
    echo "不支持的系统：$os。Windows 请运行 install-ollama.ps1。" >&2
    exit 1
    ;;
esac

echo
echo "验证：ollama --version && ollama list"
echo "下载模型：./scripts/pull-ollama-models.sh"
