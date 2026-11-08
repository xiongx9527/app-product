#!/usr/bin/env bash
# 下载 Ollama 模型（macOS / Linux）。
#
# 用法：
#   ./scripts/pull-ollama-models.sh                     # 按 scripts/ollama-models.txt 下载
#   ./scripts/pull-ollama-models.sh gpt-oss:20b qwen3:8b  # 只下载指定模型
#   ./scripts/pull-ollama-models.sh --dry-run           # 只打印要下载的模型，不联网
#
# 服务未启动时会尝试后台拉起 ollama serve，日志在系统临时目录。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_FILE="${MODELS_FILE:-$SCRIPT_DIR/ollama-models.txt}"
DRY_RUN=false
MODELS=()

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    -h|--help)
      cat <<'EOF'
下载 Ollama 模型（macOS / Linux）。

用法：
  ./scripts/pull-ollama-models.sh                       按 scripts/ollama-models.txt 下载
  ./scripts/pull-ollama-models.sh gpt-oss:20b qwen3:8b  只下载指定模型
  ./scripts/pull-ollama-models.sh --dry-run             只打印要下载的模型，不联网
EOF
      exit 0
      ;;
    -*)
      echo "未知参数：$arg（支持 --dry-run / --help）" >&2
      exit 1
      ;;
    *)
      MODELS+=("$arg")
      ;;
  esac
done

# 没有显式指定模型时，读 ollama-models.txt；空行和 # 注释跳过。
if [ "${#MODELS[@]}" -eq 0 ]; then
  if [ ! -f "$MODELS_FILE" ]; then
    echo "找不到模型清单：$MODELS_FILE" >&2
    exit 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "$line" ] && MODELS+=("$line")
  done < "$MODELS_FILE"
fi

if [ "${#MODELS[@]}" -eq 0 ]; then
  echo "模型清单为空：$MODELS_FILE" >&2
  exit 1
fi

if [ "$DRY_RUN" = true ]; then
  echo "将下载以下模型（dry-run，未执行）："
  printf '  - %s\n' "${MODELS[@]}"
  exit 0
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "未找到 ollama。请先运行 ./scripts/install-ollama.sh。" >&2
  exit 1
fi

# OLLAMA_HOST 指向远端时不本地拉起服务，避免拉错实例。
host="${OLLAMA_HOST:-}"
is_local_host=true
case "$host" in
  ""|127.0.0.1*|localhost*|0.0.0.0*) is_local_host=true ;;
  *) is_local_host=false ;;
esac

server_ready() {
  ollama list >/dev/null 2>&1
}

if ! server_ready; then
  if [ "$is_local_host" = false ]; then
    echo "Ollama 服务不可用（OLLAMA_HOST=$host），请先确认远端服务已启动。" >&2
    exit 1
  fi
  log_file="${TMPDIR:-/tmp}/ollama-serve.log"
  echo "Ollama 服务未启动，后台拉起：ollama serve（日志：$log_file）"
  nohup ollama serve >"$log_file" 2>&1 &
  for _ in $(seq 1 40); do
    server_ready && break
    sleep 0.5
  done
  if ! server_ready; then
    echo "Ollama 启动失败，最近日志：" >&2
    tail -n 20 "$log_file" >&2 || true
    exit 1
  fi
fi

failed=()
for model in "${MODELS[@]}"; do
  echo
  echo "==> 下载 $model"
  if ! ollama pull "$model"; then
    failed+=("$model")
  fi
done

echo
if [ "${#failed[@]}" -gt 0 ]; then
  echo "以下模型下载失败：${failed[*]}" >&2
  echo "完整列表：ollama list" >&2
  exit 1
fi

echo "全部完成。已安装模型："
ollama list
