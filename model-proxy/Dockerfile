# model-proxy 全量镜像：语音(ASR/TTS) + LLM/Embed/Rerank 代理 + MCP 网关。
# 基于 Python 3.12：3.14 装不上 sherpa-onnx / numpy1.26（无 wheel），见 AGENTS.md。
# 模型权重不进镜像，运行时从宿主挂载到 $VOICE_HOME/models（见 docker-compose.yml）。
FROM python:3.12-slim

# ffmpeg：本地 edge-tts 把 MP3 转 WAV 需要；curl/ca-certificates 用于运行时如需下载。
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖分开 COPY 以利用层缓存；用官方源（默认源缺 uvicorn/numpy 等，见 AGENTS.md）。
ENV PIP_INDEX_URL=https://pypi.org/simple \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1
COPY voice/requirements-base.txt \
     voice/requirements-stt.txt \
     voice/requirements-tts-docker.txt \
     voice/requirements-mcp.txt \
     voice/requirements-rerank.txt \
     ./voice/
# 一次性解析全部依赖，避免多次安装互相覆盖版本：
# - stt/tts 各 -r requirements-base.txt
# - tts 用 Docker 专用版（去掉 kokoro-onnx：它要求 numpy>=2.0.2，与 rerank 的
#   torch2.2.2+numpy1.26.4 硬冲突）；容器内 TTS 走在线 edge-tts。
# - rerank 锁 torch==2.2.2 + transformers==4.40 + numpy==1.26.4（兼容组合）
# - mcp 为 langchain[mcp]（含 fastmcp + mcp SDK）
RUN python -m pip install --upgrade pip \
    && python -m pip install \
        -r voice/requirements-base.txt \
        -r voice/requirements-stt.txt \
        -r voice/requirements-tts-docker.txt \
        -r voice/requirements-mcp.txt \
        -r voice/requirements-rerank.txt \
        pymysql \
        "psycopg[binary]" \
    && python -m pip install "numpy==1.26.4" paddlepaddle==3.0.0 \
        -i https://www.paddlepaddle.org.cn/packages/stable/cpu/ \
    && python -m pip install "numpy==1.26.4" paddleocr==3.7.0 \
        -i https://pypi.tuna.tsinghua.edu.cn/simple
# OCR 依赖：paddlepaddle 内核（百度源，Linux cp312 wheel）+ paddleocr 封装（清华源）。
# 钉住 numpy1.26 保护 torch2.2 内置重排；OCR 用独立子进程跑（voice/ocr_worker.py），
# 不与主进程 torch 冲突，无需额外端口。

# 源码（preflight.py / admin_panel.py / openai_voice_server.py 等），不含模型/venv/数据。
COPY voice/ ./voice/

# 运行目录：配置、数据库、模型、日志都在这里，通过 volume 挂到宿主持久化。
ENV VOICE_HOME=/data \
    VOICE_HOST=0.0.0.0 \
    VOICE_PORT=19529
RUN mkdir -p /data/models
VOLUME ["/data"]

EXPOSE 19529

# 直接跑服务（服务自带配置加载/建表/启动日志）；preflight 由 start-voice.sh 调用，
# 容器里用 python 直起即可，需要预检可手动 docker compose exec model-proxy python voice/preflight.py。
CMD ["python", "voice/openai_voice_server.py"]
