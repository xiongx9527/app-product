"""本地 AI 服务（LLM + STT + TTS），macOS / Windows 原生运行，不依赖 Docker。

为什么需要它：
    客户端只和 Node 网关通信；网关的 ASR / TTS / LLM 再按各自的协议调用本服务。
    开发机上没有现成的 9529 服务时，这个脚本用 Python 直接提供同样的能力，
    避免为了跑通一条语音 / 对话链路去装 Docker。

接口前缀（按能力分开）：
    LLM（纯 OpenAI 兼容反向代理）:
        POST /llm/v1/chat/completions       原样转发到上游（流式 SSE 字节透传）
        GET  /llm/v1/models                 原样转发上游模型列表
        GET  /llm/health                    仅 LLM 的健康状态
    Voice:
        POST /voide/v1/audio/transcriptions multipart/form-data -> {"text": "..."}
        POST /voide/v1/audio/speech         application/json     -> WAV / MP3 / PCM
        GET  /voide/v1/models               语音后端模型列表
        GET  /voide/health                  仅语音的健康状态
    全局:
        GET  /                              服务与后端概览
        GET  /health                        全部能力状态

后端：
    STT  sherpa-onnx + SenseVoice-small，模型加载后完全离线。
         网关上行是 16kHz / 16bit / 单声道 PCM，提交前会补 44 字节 WAV 头，
         所以本地模式只接受 WAV；非 WAV 直接返回 400，避免误报“识别为空”。
    TTS  edge-tts（微软在线神经音色）。网关要求 24kHz / 16bit / 单声道 WAV，
         edge-tts 只输出 MP3，因此用 ffmpeg 转码；没有 ffmpeg 时 TTS 返回 502，
         STT 不受影响。
    LLM  纯 OpenAI 兼容反向代理：/llm/v1/chat/completions 与 /llm/v1/models
         原样转发到 LLM_UPSTREAM_BASE_URL 指向的上游。不加载本地模型、
         不提供 Ollama 风格接口、不做接口翻译，也不做「上游忽略 stream
         时把完整响应聚合成流」的兜底。上游可以是任意 OpenAI 兼容服务
         （云端 API 或本机 Ollama 的 /v1 均可）。

代理模式（不想在本机装模型 / ffmpeg 时使用）：
    STT / TTS：配置 VOICE_UPSTREAM_BASE_URL 后两类都转发到该 OpenAI
    兼容服务；也可以用 STT_UPSTREAM_BASE_URL / TTS_UPSTREAM_BASE_URL
    分别指定，或只给其中一类配置（另一类继续走本地）。
    LLM：配置 LLM_UPSTREAM_BASE_URL 即启用代理，请求原样转发；没有本地
    Ollama 后端，也不需要在本机安装 Ollama。
    代理模式只需要 requirements-base.txt，不下载 SenseVoice、不需要 ffmpeg。
    也不需要在本机安装 Ollama。

配置：
    所有运行参数都可以写在配置文件里（默认 $VOICE_HOME/voice.conf）：
        VOICE_HOST         监听地址，默认 0.0.0.0
        VOICE_PORT         监听端口，默认 9529
        SENSEVOICE_DIR     SenseVoice 模型目录，默认 $VOICE_HOME/models/sensevoice
        TTS_VOICE          默认音色，默认 zh-CN-XiaoxiaoNeural
        TTS_TIMEOUT        edge-tts 单个音频块的超时秒数，默认 20
        FFMPEG_BIN         ffmpeg 可执行文件路径，默认 PATH 中的 ffmpeg
        VOICE_API_KEY      off / auto / 显式 Key；默认 off（不鉴权）
        VOICE_API_KEY_FILE Key 文件；auto 模式读取，缺失时随机生成并写入
        VOICE_UPSTREAM_BASE_URL  通用上游地址，设置后 STT / TTS 都走代理
        VOICE_UPSTREAM_API_KEY   通用上游 API Key
        STT_UPSTREAM_BASE_URL    STT 专属上游地址，覆盖通用地址
        STT_UPSTREAM_API_KEY     STT 专属上游 Key
        STT_UPSTREAM_MODEL       转发给上游的 STT 模型名
        TTS_UPSTREAM_BASE_URL    TTS 专属上游地址，覆盖通用地址
        TTS_UPSTREAM_API_KEY     TTS 专属上游 Key
        TTS_UPSTREAM_MODEL       转发给上游的 TTS 模型名
        TTS_UPSTREAM_VOICE       转发给上游的 TTS 音色（覆盖客户端传来的音色）
        LLM_ENABLED              auto / on / off，默认 auto（auto=配了上游即启用）
        LLM_UPSTREAM_BASE_URL    OpenAI 兼容上游；设置后启用 LLM 代理（必填）
        LLM_UPSTREAM_API_KEY     上游 API Key，留空表示上游不需要鉴权
        LLM_UPSTREAM_MODEL       覆盖客户端传来的模型名，默认沿用请求
        UPSTREAM_TIMEOUT         上游请求超时秒数，默认 120
    优先级：命令行参数 > 环境变量 > 配置文件 > 内置默认值。
    配置文件路径可用环境变量 VOICE_CONFIG 或命令行参数 --config 指定。

命令行：
    python openai_voice_server.py --config ~/.app-product/voice/voice.conf
    python openai_voice_server.py --host 127.0.0.1 --port 9531
    python openai_voice_server.py --require-api-key     # 等价于 --api-key auto
    python openai_voice_server.py --no-api-key          # 默认行为
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import io
import json
import os
import secrets
import shutil
import subprocess
import urllib.request
import wave
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, AsyncIterator

import httpx
import uvicorn
import llm_protocols  # LLM 上游多协议适配层
import admin_panel  # Web 管理面板（鉴权 + 配置编辑 + 启停 + 日志，挂在 9529 /admin）
import voice_db  # 本地管理数据库（SQLite）：配置的真相源 + 事件 / 审计
import voice_sync  # 远程数据库同步（Postgres）
import config_store  # 统一配置接口：本地缓存 + 本地库 + 远程库的门面
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

# 与网关契约保持一致：上行 16k，下行 24k；两边都是 16bit 单声道。
SAMPLE_RATE = 16000
TTS_SAMPLE_RATE = 24000

# 配置优先级从高到低：命令行覆盖 > 环境变量 > 配置文件 > 这里的默认值。
DEFAULTS = {
    "VOICE_HOST": "0.0.0.0",
    "VOICE_PORT": "9529",
    "TTS_VOICE": "zh-CN-XiaoxiaoNeural",
    "TTS_TIMEOUT": "20",
    "UPSTREAM_TIMEOUT": "120",
    "FFMPEG_BIN": "ffmpeg",
    "VOICE_API_KEY": "off",
    "LLM_ENABLED": "auto",
}

# 兼容常见的“关闭 / 开启”写法；LLM_ENABLED 和 VOICE_API_KEY 共用同一套判断。
API_KEY_OFF_VALUES = {"", "off", "none", "false", "0", "no", "disabled"}
API_KEY_AUTO_VALUES = {"auto", "generate", "random"}
ENABLED_VALUES = {"on", "true", "1", "yes", "enabled"}


def _default_voice_home() -> str:
    """与安装脚本保持一致的默认目录，避免直接运行服务时找不到模型。"""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Local"
        )
        return os.path.join(base, "app-product", "voice")
    return os.path.join(os.path.expanduser("~"), ".app-product", "voice")


VOICE_HOME = os.environ.get("VOICE_HOME") or _default_voice_home()
_config_path = os.environ.get("VOICE_CONFIG") or os.path.join(
    VOICE_HOME, "voice.conf"
)
_file_config: dict[str, str] | None = None
_cli_overrides: dict[str, str] = {}
_api_key: str | None = None
_api_key_resolved = False


def _parse_config_file(path: str) -> dict[str, str]:
    """解析 KEY=VALUE 配置。

    规则故意保持简单，方便用户直接手改，也方便 shell 脚本生成：
        - 空行和 # 开头的行忽略；
        - 兼容 `export KEY=VALUE`；
        - 值两端的成对单/双引号会被去掉；
        - 未加引号时，` #` 之后视为行尾注释；
        - 不展开变量，路径留给 _expand_path() 统一处理。
    """
    values: dict[str, str] = {}
    if not path or not os.path.isfile(path):
        return values
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :].lstrip()
            key, separator, value = line.partition("=")
            if not separator:
                continue
            key = key.strip()
            if not key:
                continue
            value = value.strip()
            if (
                len(value) >= 2
                and value[0] == value[-1]
                and value[0] in ("'", '"')
            ):
                value = value[1:-1]
            elif " #" in value:
                value = value.split(" #", 1)[0].rstrip()
            values[key] = value
    return values


def _file_values() -> dict[str, str]:
    """配置文件只读一次；运行期间修改需重启服务。"""
    global _file_config
    if _file_config is None:
        _file_config = _parse_config_file(_config_path)
    return _file_config


def set_config_path(path: str) -> None:
    """切换配置文件后清掉缓存，避免 --config 已经生效却仍读旧文件。"""
    global _config_path, _file_config, _api_key, _api_key_resolved
    _config_path = os.path.abspath(os.path.expanduser(path))
    _file_config = None
    _api_key = None
    _api_key_resolved = False


def config_value(name: str, default: str | None = None) -> str:
    """按命令行 > 环境变量 > 本地数据库(真相源) > voice.conf(兜底) > 内置默认值取配置。"""
    if name in _cli_overrides:
        return _cli_overrides[name]
    env_value = os.environ.get(name)
    if env_value not in (None, ""):
        return env_value
    # 本地 SQLite 是配置真相源，读取走内存缓存，几乎零延迟。
    db_value = voice_db.get_config(name)
    if db_value not in (None, ""):
        return db_value
    file_value = _file_values().get(name)
    if file_value not in (None, ""):
        return file_value
    if default is not None:
        return default
    return DEFAULTS.get(name, "")


def _expand_path(value: str) -> str:
    """配置文件里允许写 ~ 和 $VOICE_HOME，服务启动前统一展开。"""
    value = value.replace("${VOICE_HOME}", VOICE_HOME).replace("$VOICE_HOME", VOICE_HOME)
    return os.path.expandvars(os.path.expanduser(value))


def sensevoice_dir() -> str:
    default = os.path.join(VOICE_HOME, "models", "sensevoice")
    return _expand_path(config_value("SENSEVOICE_DIR", default))


def tts_voice() -> str:
    value = config_value("TTS_VOICE", "zh-CN-XiaoxiaoNeural").strip()
    return value or "zh-CN-XiaoxiaoNeural"


def tts_timeout() -> float:
    """配置写错时退回 20 秒，不让一个笔误把服务启动拖死。"""
    try:
        return max(1.0, float(config_value("TTS_TIMEOUT", "20")))
    except ValueError:
        return 20.0


def api_key_file() -> str:
    default = os.path.join(VOICE_HOME, "api-key")
    return _expand_path(config_value("VOICE_API_KEY_FILE", default))


def _read_api_key(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as handle:
            value = handle.read().strip()
    except OSError:
        return None
    return value or None


def _write_api_key(path: str, value: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(value + "\n")
    try:
        # 仅当前用户可读；Windows 对 chmod 支持有限，失败也不影响服务启动。
        os.chmod(path, 0o600)
    except OSError:
        pass


def resolve_api_key() -> str | None:
    """把 VOICE_API_KEY 解析成实际 Key；None 表示不校验。

    off / none / false  不鉴权（默认）
    auto                读 VOICE_API_KEY_FILE；文件不存在或为空时随机生成并写入
    其它任意值          直接使用该值作为 Key
    """
    global _api_key, _api_key_resolved
    if _api_key_resolved:
        return _api_key
    _api_key_resolved = True

    raw = config_value("VOICE_API_KEY", "off").strip()
    lowered = raw.lower()
    if lowered in API_KEY_OFF_VALUES:
        _api_key = None
        return None
    if lowered in API_KEY_AUTO_VALUES:
        path = api_key_file()
        existing = _read_api_key(path)
        if existing:
            _api_key = existing
            return existing
        generated = secrets.token_urlsafe(32)
        _write_api_key(path, generated)
        print(f"[local-ai] 已生成 API Key：{path}", flush=True)
        _api_key = generated
        return generated
    _api_key = raw
    return raw


def auth_enabled() -> bool:
    """只看配置意图，不触发 auto 生成；供 /health 无副作用地报告状态。"""
    value = config_value("VOICE_API_KEY", "off").strip().lower()
    return value not in API_KEY_OFF_VALUES


def require_api_key(authorization: str | None = Header(default=None)) -> None:
    """校验 Authorization: Bearer <key>。

    保护会消耗资源的推理接口：/voide/v1/audio/* 和 /llm 下的 chat / completions。
    根路径、/health、模型列表保持开放，网关健康探测不会因为开启鉴权而被误判为
    “服务不可达”。
    """
    expected = resolve_api_key()
    if expected is None:
        return
    scheme, _, token = (authorization or "").partition(" ")
    valid = scheme.lower() == "bearer" and hmac.compare_digest(
        token.strip().encode("utf-8"), expected.encode("utf-8")
    )
    if not valid:
        raise HTTPException(
            status_code=401,
            detail="缺少或错误的 API Key",
            headers={"WWW-Authenticate": "Bearer"},
        )


def upstream_base(capability: str) -> str:
    """返回某类能力的上游地址；空字符串表示使用本地后端。

    先看能力专属的 STT_/TTS_UPSTREAM_BASE_URL，再回退通用
    VOICE_UPSTREAM_BASE_URL。这样只填一个通用的地址就能把 STT 和 TTS
    一起代理到远程 OpenAI 兼容服务，也允许两类能力分别指向不同服务。
    """
    specific = config_value(f"{capability}_UPSTREAM_BASE_URL", "").strip()
    return specific or config_value("VOICE_UPSTREAM_BASE_URL", "").strip()


def upstream_key(capability: str) -> str:
    specific = config_value(f"{capability}_UPSTREAM_API_KEY", "").strip()
    return specific or config_value("VOICE_UPSTREAM_API_KEY", "").strip()


def upstream_headers(capability: str) -> dict[str, str]:
    key = upstream_key(capability)
    return {"Authorization": f"Bearer {key}"} if key else {}


def upstream_timeout() -> float:
    try:
        return max(5.0, float(config_value("UPSTREAM_TIMEOUT", "120")))
    except ValueError:
        return 120.0


def upstream_url(capability: str, endpoint: str) -> str:
    """拼出上游完整地址，同时兼容用户填 /v1 或不填 /v1。"""
    base = upstream_base(capability).rstrip("/")
    if base.endswith("/v1"):
        return base + endpoint
    return base + "/v1" + endpoint


def upstream_error(response: httpx.Response) -> str:
    """尽量从 OpenAI 风格错误体里取 message，取不到就截断原始文本。"""
    try:
        data = response.json()
    except ValueError:
        data = None
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        if isinstance(data.get("message"), str):
            return data["message"]
    text = response.text.strip()
    return text[:500] if text else "上游没有返回错误详情"


# ── LLM 代理配置 ─────────────────────────────────────────────────
# /llm 是纯 OpenAI 兼容反向代理：把请求原样转发到 LLM_UPSTREAM_BASE_URL
# 指向的上游。不加载本地模型、不做 Ollama 风格接口翻译、不做非流式兜底。
def llm_upstream_base() -> str:
    return config_value("LLM_UPSTREAM_BASE_URL", "").strip()


def llm_upstream_key() -> str:
    return config_value("LLM_UPSTREAM_API_KEY", "").strip()


def llm_headers() -> dict[str, str]:
    key = llm_upstream_key()
    return {"Authorization": f"Bearer {key}"} if key else {}


def llm_enabled() -> bool:
    """auto 模式下配了上游就启用；显式 on / off 始终优先。"""
    raw = config_value("LLM_ENABLED", "auto").strip().lower()
    if raw in API_KEY_OFF_VALUES:
        return False
    if raw in ENABLED_VALUES:
        return True
    return bool(llm_upstream_base())


def llm_base_url() -> str:
    return llm_upstream_base()


def llm_model_override() -> str:
    """配置后覆盖客户端传来的模型名；留空则完全沿用请求。"""
    return config_value("LLM_UPSTREAM_MODEL", "").strip()


def llm_protocol() -> str:
    """LLM 上游协议；默认 openai（OpenAI 兼容透传）。详见 llm_protocols。"""
    return config_value("LLM_UPSTREAM_PROTOCOL", "openai").strip().lower() or "openai"


def llm_api_version() -> str:
    """Azure OpenAI 需要的 api-version；其它协议忽略。"""
    return config_value("LLM_UPSTREAM_API_VERSION", "").strip()


async def fetch_json(url: str, headers: dict[str, str] | None = None):
    """GET 上游 JSON；失败时返回统一错误响应而不是抛 500。"""
    try:
        async with httpx.AsyncClient(timeout=upstream_timeout()) as client:
            response = await client.get(url, headers=headers or {})
    except httpx.HTTPError as exc:
        return error_response(502, f"上游 LLM 请求失败: {exc}")
    if response.status_code >= 400:
        return error_response(
            502, f"上游 LLM 失败（{response.status_code}）: {upstream_error(response)}"
        )
    try:
        return response.json()
    except ValueError:
        return error_response(502, "上游 LLM 返回的不是 JSON")


async def proxy_transcription(
    file: UploadFile,
    payload: bytes,
    model: str,
    language: str,
    response_format: str,
    temperature: float,
):
    """把转写请求原样转给远程 OpenAI 兼容服务，省掉本地模型和依赖。"""
    url = upstream_url("STT", "/audio/transcriptions")
    data = {
        "model": config_value("STT_UPSTREAM_MODEL", model),
        "response_format": response_format,
        "temperature": str(temperature),
    }
    if language:
        data["language"] = language

    try:
        async with httpx.AsyncClient(timeout=upstream_timeout()) as client:
            response = await client.post(
                url,
                headers=upstream_headers("STT"),
                data=data,
                files={
                    "file": (
                        file.filename or "audio.wav",
                        payload,
                        file.content_type or "audio/wav",
                    )
                },
            )
    except httpx.HTTPError as exc:
        return error_response(502, f"上游转写请求失败: {exc}")

    if response.status_code >= 400:
        return error_response(
            502, f"上游转写失败（{response.status_code}）: {upstream_error(response)}"
        )
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type"),
    )


app = FastAPI(title="openai-voice-server")

# OpenAI 风格音色名 -> edge-tts 中文神经音色，方便直接填 openai/alloy 之类的值。
VOICE_ALIASES = {
    "alloy": "zh-CN-XiaoxiaoNeural",
    "echo": "zh-CN-XiaoxiaoNeural",
    "fable": "zh-CN-YunxiNeural",
    "onyx": "zh-CN-YunyangNeural",
    "nova": "zh-CN-XiaobeiNeural",
    "shimmer": "zh-CN-XiaoniNeural",
    "ash": "zh-CN-YunjianNeural",
    "coral": "zh-CN-XiaoyiNeural",
    "sage": "zh-CN-YunxiaNeural",
    "ballad": "zh-CN-YunzeNeural",
}

_recognizer = None


class TTSCache:
    """按 (文本, 音色, 语速, 格式) 缓存合成结果，避免重复请求云端。"""

    def __init__(self, max_entries: int = 256, max_bytes: int = 64 * 1024 * 1024):
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self._data: OrderedDict[tuple, bytes] = OrderedDict()
        self._size = 0
        self.hits = 0
        self.misses = 0

    def get(self, key: tuple) -> bytes | None:
        item = self._data.get(key)
        if item is None:
            self.misses += 1
            return None
        self._data.move_to_end(key)
        self.hits += 1
        return item

    def put(self, key: tuple, value: bytes) -> None:
        if not value or len(value) > self.max_bytes:
            return
        old = self._data.pop(key, None)
        if old is not None:
            self._size -= len(old)
        self._data[key] = value
        self._size += len(value)
        while self._data and (
            len(self._data) > self.max_entries or self._size > self.max_bytes
        ):
            _, evicted = self._data.popitem(last=False)
            self._size -= len(evicted)

    def stats(self) -> dict:
        return {
            "entries": len(self._data),
            "bytes": self._size,
            "hits": self.hits,
            "misses": self.misses,
        }


tts_cache = TTSCache()


def error_response(status_code: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"message": message}})


def sensevoice_ready() -> bool:
    """每次请求都看文件是否存在，安装脚本补完模型后无需重启服务。"""
    model_dir = sensevoice_dir()
    model = os.path.join(model_dir, "model.int8.onnx")
    tokens = os.path.join(model_dir, "tokens.txt")
    return (
        os.path.isfile(model)
        and os.path.getsize(model) > 0
        and os.path.isfile(tokens)
        and os.path.getsize(tokens) > 0
    )


def get_sensevoice():
    """懒加载 SenseVoice，第一次转写时才占内存。"""
    global _recognizer
    if _recognizer is None:
        if not sensevoice_ready():
            raise RuntimeError(
                f"未找到 SenseVoice 模型：{sensevoice_dir()}，请先运行 install-voice 脚本"
            )
        import sherpa_onnx

        _recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=os.path.join(sensevoice_dir(), "model.int8.onnx"),
            tokens=os.path.join(sensevoice_dir(), "tokens.txt"),
            num_threads=max(2, min(8, os.cpu_count() or 4)),
            use_itn=True,
            debug=False,
        )
    return _recognizer


def decode_wav(payload: bytes):
    """把 WAV 解码成 16kHz 单声道 float32（-1..1）。

    网关自己拼 WAV 头，采样率/声道数不保证和 SenseVoice 的输入一致；
    这里统一做位深转换、混单声道和线性重采样，后面就不用再关心格式。
    """
    import numpy as np

    with wave.open(io.BytesIO(payload), "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())

    if width == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v).astype(np.float32)
        x = v / 8388608.0
    elif width == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width: {width}")

    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE and x.size:
        n = int(round(x.size * SAMPLE_RATE / rate))
        x = np.interp(
            np.linspace(0.0, x.size - 1.0, n, dtype=np.float64),
            np.arange(x.size, dtype=np.float64),
            x,
        ).astype(np.float32)
    return x


def transcribe_sensevoice(payload: bytes, language: str):
    """同步转写；调用方用 asyncio.to_thread 包一层，避免模型加载时阻塞事件循环。"""
    x = decode_wav(payload)
    if x.size == 0:
        return "", 0.0, language or "zh"
    rec = get_sensevoice()
    stream = rec.create_stream()
    stream.accept_waveform(SAMPLE_RATE, x)
    rec.decode_stream(stream)
    text = (stream.result.text or "").strip()
    lang = getattr(stream.result, "lang", "") or language or "zh"
    return text, x.size / SAMPLE_RATE, lang


def tts_rate(speed: float) -> str:
    """edge-tts 的语速是 +10% / -10% 这种字符串，不是倍率。"""
    if speed > 1:
        return f"+{round((speed - 1.0) * 100)}%"
    if speed < 1:
        return f"-{round((1.0 - speed) * 100)}%"
    return "+0%"


def resolve_voice(name: str) -> str:
    """兼容 OpenAI 音色名；已经是 zh-CN-xxx 这种 edge 音色时原样返回。"""
    cleaned = (name or "").strip()
    if not cleaned:
        return tts_voice()
    return VOICE_ALIASES.get(cleaned.lower(), cleaned)


def ffmpeg_path() -> str | None:
    """FFMPEG_BIN 可能是 winget 装出来的绝对路径，也可能只是 PATH 里的命令名。"""
    candidate = _expand_path(config_value("FFMPEG_BIN", "ffmpeg")).strip()
    if candidate and os.path.isfile(candidate):
        return candidate
    return shutil.which(candidate) if candidate else None


async def synthesize_edge_mp3(text: str, voice: str, rate: str) -> bytes:
    """调 edge-tts 拿完整 MP3。

    - 重试 3 次：edge-tts 走微软匿名 WebSocket，偶发断连很常见。
    - 按“单个音频块”超时而不是给整个文本设总超时：长文本总时长可能超过 20s，
      但只要还在持续出块就不算卡死。
    - 必须收完整 MP3 才能交给 ffmpeg 转 WAV；网关当前也是一次性读取响应。
    """
    try:
        import edge_tts
    except ImportError as exc:
        raise RuntimeError(
            "edge-tts 未安装，请运行 install-voice 脚本安装 TTS 依赖"
        ) from exc

    last_error: Exception | None = None
    timeout = tts_timeout()
    for attempt in range(3):
        try:
            communicate = edge_tts.Communicate(text, voice, rate=rate)
            buf = bytearray()
            iterator = communicate.stream().__aiter__()
            while True:
                try:
                    chunk = await asyncio.wait_for(
                        iterator.__anext__(), timeout=timeout
                    )
                except StopAsyncIteration:
                    break
                if chunk.get("type") == "audio" and chunk.get("data"):
                    buf.extend(chunk["data"])
            if buf:
                return bytes(buf)
            last_error = RuntimeError("edge-tts 没有返回音频")
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        if attempt < 2:
            await asyncio.sleep(0.2 * (attempt + 1))
    raise RuntimeError(f"edge-tts 合成失败: {last_error}")


def transcode_mp3(mp3: bytes, fmt: str):
    """把 edge-tts 的 MP3 转成网关需要的 WAV / 裸 PCM。

    这里强行指定 24kHz / 单声道 / 16bit，和网关 tts.start 声明的
    pcm16@24000 对齐，网关拿到后不需要再重采样，直接按二进制帧下发。
    wav 输出带 RIFF 头，pcm 输出裸 s16le。
    """
    binary = ffmpeg_path()
    if not binary:
        raise RuntimeError(
            "未找到 ffmpeg，无法把 edge-tts 的 MP3 转成 WAV；"
            "macOS 可执行 brew install ffmpeg，Windows 可执行 winget install Gyan.FFmpeg"
        )

    if fmt == "wav":
        out_format, media_type = "wav", "audio/wav"
    elif fmt == "pcm":
        out_format, media_type = "s16le", "audio/pcm"
    else:
        raise ValueError(f"unsupported response_format: {fmt}")

    cmd = [
        binary,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        out_format,
        "-acodec",
        "pcm_s16le",
        "-ar",
        str(TTS_SAMPLE_RATE),
        "-ac",
        "1",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, input=mp3, capture_output=True)
    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode("utf-8", "replace").strip() or "unknown error"
        raise RuntimeError(f"ffmpeg 转码失败: {detail.splitlines()[-1]}")
    return proc.stdout, media_type


def voice_health() -> dict:
    # 不主动加载模型：健康检查应该秒回，第一次真正转写时再加载 SenseVoice。
    stt_upstream = upstream_base("STT")
    tts_upstream = upstream_base("TTS")
    tts_voice_name = (
        (config_value("TTS_UPSTREAM_VOICE", "").strip() or tts_voice())
        if tts_upstream
        else tts_voice()
    )
    return {
        "status": "ok",
        "auth_enabled": auth_enabled(),
        "stt_backend": "upstream" if stt_upstream else "sensevoice",
        "stt_ready": bool(stt_upstream) or sensevoice_ready(),
        "stt_upstream": stt_upstream or None,
        "tts_backend": "upstream" if tts_upstream else "edge",
        "tts_voice": tts_voice_name,
        "tts_upstream": tts_upstream or None,
        # 代理 TTS 时 ffmpeg 不参与，返回 null 避免误判成“缺依赖”。
        "ffmpeg": None if tts_upstream else bool(ffmpeg_path()),
        "model_dir": None if stt_upstream else sensevoice_dir(),
        "tts_cache": tts_cache.stats(),
    }


def llm_health() -> dict:
    enabled = llm_enabled()
    return {
        "status": "ok",
        "enabled": enabled,
        "backend": "proxy" if enabled else "off",
        "base_url": llm_base_url() if enabled else None,
        "model": llm_model_override() or None,
        "auth_enabled": auth_enabled(),
    }


@app.get("/")
def root():
    # 网关健康检查先打根路径，这里直接给 200，省掉一次模型列表回退探测。
    return {
        "service": "app-product-local-ai",
        "llm": "proxy" if llm_enabled() else "off",
        "stt": "upstream" if upstream_base("STT") else "sensevoice",
        "tts": "upstream" if upstream_base("TTS") else "edge",
    }


@app.get("/health")
def health():
    report = voice_health()
    report["llm"] = llm_health()
    return report


@app.get("/voide")
def voice_root():
    return {
        "service": "app-product-voice",
        "stt": "upstream" if upstream_base("STT") else "sensevoice",
        "tts": "upstream" if upstream_base("TTS") else "edge",
    }


@app.get("/voide/health")
def voice_health_route():
    return voice_health()


@app.get("/voide/v1/models")
def voice_models():
    # 只列出实际可用的后端；网关和设置页的“测试连接”都可以拿它做探测。
    items = [
        {"id": "edge-tts", "object": "model", "owned_by": "local"},
        {"id": "sensevoice-small", "object": "model", "owned_by": "local"},
    ]
    return {"object": "list", "data": items}


class SpeechBody(BaseModel):
    input: str
    # 本地模式忽略 model；代理模式优先用 TTS_UPSTREAM_MODEL，留空则用客户端传的值。
    model: str = ""
    # 留空表示使用配置里的默认音色；网关通常不传或传自定义音色。
    voice: str = ""
    response_format: str = "wav"
    speed: float = 1.0
    instructions: str = ""  # OpenAI 新 TTS 字段，本地模式忽略


async def proxy_speech(body: SpeechBody):
    """把合成请求转给远程 OpenAI 兼容服务，返回上游音频原样透传。"""
    url = upstream_url("TTS", "/audio/speech")
    # 只转发上游认识的字段，避免把本地兼容字段（如空 model）带过去。
    payload = {
        "input": body.input,
        "response_format": body.response_format,
        "speed": body.speed,
    }
    model = config_value("TTS_UPSTREAM_MODEL", "").strip() or body.model.strip()
    if model:
        payload["model"] = model
    # 网关默认传 zh-CN-XiaoxiaoNeural，OpenAI 官方服务不认识；
    # 配置 TTS_UPSTREAM_VOICE=alloy 即可覆盖，未配置时也给一个通用默认值。
    payload["voice"] = (
        config_value("TTS_UPSTREAM_VOICE", "").strip()
        or body.voice.strip()
        or "alloy"
    )
    if body.instructions.strip():
        payload["instructions"] = body.instructions.strip()

    try:
        async with httpx.AsyncClient(timeout=upstream_timeout()) as client:
            response = await client.post(
                url,
                headers=upstream_headers("TTS"),
                json=payload,
            )
    except httpx.HTTPError as exc:
        return error_response(502, f"上游合成请求失败: {exc}")

    if response.status_code >= 400:
        return error_response(
            502, f"上游合成失败（{response.status_code}）: {upstream_error(response)}"
        )
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type"),
    )


@app.post("/voide/v1/audio/speech", dependencies=[Depends(require_api_key)])
async def speech(body: SpeechBody):
    """OpenAI 兼容的语音合成；网关固定请求 wav，按 24k PCM 下发。"""
    text = (body.input or "").strip()
    if not text:
        return error_response(400, "input 不能为空")

    fmt = (body.response_format or "wav").strip().lower()
    if fmt not in ("wav", "mp3", "pcm"):
        return error_response(400, f"不支持的 response_format: {fmt}")

    # 配了上游就完全不碰本地模型和 ffmpeg，代理模式只需要基础 Python 依赖。
    if upstream_base("TTS"):
        return await proxy_speech(body)

    voice = resolve_voice(body.voice)
    rate = tts_rate(body.speed)
    # 助手常重复“我在 / 还在吗”这类短句，缓存能省掉一次云端合成和 ffmpeg 转码。
    cache_key = (text, voice, rate, fmt)
    cached = tts_cache.get(cache_key)
    if cached is not None:
        media_type = {
            "wav": "audio/wav",
            "mp3": "audio/mpeg",
            "pcm": "audio/pcm",
        }[fmt]
        return Response(
            content=cached, media_type=media_type, headers={"X-TTS-Cache": "hit"}
        )

    try:
        mp3 = await synthesize_edge_mp3(text, voice, rate)
        if fmt == "mp3":
            audio, media_type = mp3, "audio/mpeg"
        else:
            audio, media_type = transcode_mp3(mp3, fmt)
    except Exception as exc:  # noqa: BLE001
        # 这里不抛 500：网关遇到 4xx/5xx 会自己回退静音，会话不中断。
        return error_response(502, str(exc))

    tts_cache.put(cache_key, audio)
    return Response(
        content=audio, media_type=media_type, headers={"X-TTS-Cache": "miss"}
    )


@app.post(
    "/voide/v1/audio/transcriptions", dependencies=[Depends(require_api_key)]
)
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form("sensevoice-small"),
    language: str = Form(""),
    response_format: str = Form("json"),
    temperature: float = Form(0.0),
):
    """OpenAI 兼容的语音转写；网关只会提交 16k / 16bit / 单声道 WAV。"""
    payload = await file.read()
    if not payload:
        return error_response(400, "上传的音频为空")

    # 代理模式允许上游接受 WAV 以外的格式，所以先转发，再做本地 WAV 校验。
    if upstream_base("STT"):
        return await proxy_transcription(
            file, payload, model, language, response_format, temperature
        )

    # 先挡掉非 WAV：SenseVoice 的接入口只认 RIFF/WAVE，直接交给它只会得到空文本。
    if payload[:4] != b"RIFF" or payload[8:12] != b"WAVE":
        return error_response(400, "只支持 WAV 音频（网关上行会补 WAV 头）")

    try:
        # 模型加载和推理都是 CPU 阻塞操作，放到线程里避免卡住其他请求。
        text, duration, lang = await asyncio.to_thread(
            transcribe_sensevoice, payload, language
        )
    except Exception as exc:  # noqa: BLE001
        # 模型没下载 → 503（重试安装有意义）；模型在但推理失败 → 502。
        status = 503 if not sensevoice_ready() else 502
        return error_response(status, f"转写失败: {exc}")

    # 网关默认只要 json；保留 text / verbose_json 是为了兼容 OpenAI 客户端调试。
    if response_format == "text":
        return Response(content=text, media_type="text/plain; charset=utf-8")
    if response_format == "verbose_json":
        return {
            "task": "transcribe",
            "language": lang,
            "duration": duration,
            "text": text,
            "segments": (
                [{"id": 0, "start": 0.0, "end": duration, "text": text}]
                if text
                else []
            ),
        }
    return {"text": text}


# ── LLM 路由 ─────────────────────────────────────────────────────
def llm_disabled_response() -> JSONResponse:
    return error_response(
        503,
        "LLM 未启用：在 voice.conf 配置 LLM_UPSTREAM_BASE_URL 指向 "
        "OpenAI 兼容上游即可启用纯转发代理",
    )


@app.get("/llm")
def llm_root():
    # 网关健康探测会先打 baseUrl 本身，这里直接给 200。
    return llm_health()


@app.get("/llm/health")
def llm_health_route():
    return llm_health()


@app.get("/llm/v1/models")
async def llm_models():
    """模型列表：按上游协议取对应接口，Ollama 翻译回 OpenAI 形状。"""
    if not llm_enabled():
        return llm_disabled_response()
    url, headers = llm_protocols.prepare_models(llm_protocol(), llm_upstream_base(), llm_upstream_key())
    data = await fetch_json(url, headers)
    if isinstance(data, Response):
        return data
    if llm_protocol() == "ollama":
        data = llm_protocols.ollama_tags_to_openai(data)
    return data


@app.post(
    "/llm/v1/chat/completions", dependencies=[Depends(require_api_key)]
)
async def chat_completions(request: Request):
    """OpenAI 兼容对话：入站固定 OpenAI 格式，出站按 LLM_UPSTREAM_PROTOCOL 翻译到上游。

    流式走 SSE 字节透传 + 协议翻译器；非流式走 JSON 翻译。具体协议映射见
    llm_protocols.prepare。
    """
    if not llm_enabled():
        return llm_disabled_response()
    try:
        body = await request.json()
    except ValueError:
        return error_response(400, "请求体不是合法 JSON")
    if not isinstance(body, dict):
        return error_response(400, "请求体必须是 JSON 对象")

    req, stream_cls, resp_transform = llm_protocols.prepare(
        llm_protocol(), llm_upstream_base(), llm_upstream_key(),
        llm_model_override(), llm_api_version(), body,
    )

    if not body.get("stream"):
        try:
            async with httpx.AsyncClient(timeout=upstream_timeout()) as client:
                response = await client.post(req.url, headers=req.headers, json=req.payload)
        except httpx.HTTPError as exc:
            return error_response(502, f"上游 LLM 请求失败: {exc}")
        if response.status_code >= 400:
            return error_response(
                502, f"上游 LLM 失败（{response.status_code}）: {upstream_error(response)}"
            )
        try:
            data = response.json()
        except ValueError:
            return Response(
                content=response.content, status_code=response.status_code,
                media_type=response.headers.get("content-type"),
            )
        data = resp_transform(data)
        return Response(
            content=json.dumps(data, ensure_ascii=False).encode("utf-8"),
            status_code=200, media_type="application/json",
        )

    client = httpx.AsyncClient(timeout=httpx.Timeout(upstream_timeout(), connect=10.0))
    upstream_req = client.build_request("POST", req.url, headers=req.headers, json=req.payload)
    try:
        response = await client.send(upstream_req, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        return error_response(502, f"上游 LLM 请求失败: {exc}")
    if response.status_code >= 400:
        content = await response.aread()
        await client.aclose()
        return error_response(
            502,
            f"上游 LLM 失败（{response.status_code}）: {content.decode(errors='replace')[:500]}",
        )

    model = llm_model_override() or body.get("model", "")
    translator = stream_cls(model)

    async def body_gen():
        try:
            async for chunk in response.aiter_raw():
                out = translator.feed(chunk)
                if out:
                    yield out
        finally:
            tail = translator.finish()
            if tail:
                yield tail
            await response.aclose()
            await client.aclose()

    return StreamingResponse(body_gen(), media_type="text/event-stream")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="本地 AI 服务（LLM 纯转发代理 + STT / TTS），"
        "也可以代理远程 OpenAI 兼容服务。"
    )
    parser.add_argument(
        "--config",
        help="配置文件路径，默认 $VOICE_HOME/voice.conf",
    )
    parser.add_argument(
        "--host",
        "--ip",
        dest="host",
        help="监听地址，默认 0.0.0.0",
    )
    parser.add_argument("--port", type=int, help="监听端口，默认 9529")
    parser.add_argument(
        "--api-key",
        dest="api_key",
        help="API Key；填 auto 表示读取或随机生成 Key 文件",
    )
    parser.add_argument(
        "--api-key-file",
        dest="api_key_file",
        help="API Key 文件路径，默认 $VOICE_HOME/api-key",
    )
    key_group = parser.add_mutually_exclusive_group()
    key_group.add_argument(
        "--require-api-key",
        action="store_true",
        help="启用 API Key 校验（等价于 --api-key auto）",
    )
    key_group.add_argument(
        "--no-api-key",
        action="store_true",
        help="关闭 API Key 校验（默认）",
    )
    return parser.parse_args(argv)


def main(argv=None) -> None:
    args = parse_args(argv)
    if args.config:
        set_config_path(args.config)
    if args.host:
        _cli_overrides["VOICE_HOST"] = args.host
    if args.port is not None:
        _cli_overrides["VOICE_PORT"] = str(args.port)
    if args.api_key_file:
        _cli_overrides["VOICE_API_KEY_FILE"] = args.api_key_file
    if args.api_key is not None:
        _cli_overrides["VOICE_API_KEY"] = args.api_key
    if args.require_api_key:
        _cli_overrides["VOICE_API_KEY"] = "auto"
    if args.no_api_key:
        _cli_overrides["VOICE_API_KEY"] = "off"

    # 配置真相源 = 本地 SQLite，并通过 config_store 统一接口收口缓存与远程同步。
    # voice.conf 仅在 DB 为空时用于播种（首次初始化 / 兜底），之后不再是权威。
    db_path = os.path.join(VOICE_HOME, "voice.db")
    remote_dsn = os.environ.get("VOICE_REMOTE_DSN") or None
    redis_url = os.environ.get("REDIS_URL") or None
    store = config_store.configure(db_path, remote_dsn, redis_url)
    seeded = store.seed_from_conf(_file_values())
    if seeded:
        print(
            f"[local-ai] 数据库: 首次初始化，已从 voice.conf 播种 {seeded} 项到 {db_path}",
            flush=True,
        )
    else:
        print(f"[local-ai] 数据库: {db_path}（配置以数据库为准）", flush=True)
    if remote_dsn:
        print("[local-ai] 远程库: 已配置，保存 / 启动时会与本地同步", flush=True)
    if redis_url:
        print("[local-ai] 远程缓存: Redis（REDIS_URL 已配置，缓存走 Redis 不落库）", flush=True)
        # 启动时先把远端配置合并到本地，保证「本地与远程一致」。
        if remote_dsn:
            try:
                import asyncio

                asyncio.run(store.sync_pull())
                print("[local-ai] 远程库: 已拉取远端配置合并到本地", flush=True)
            except Exception as e:  # noqa: BLE001
                print(
                    f"[local-ai] 远程库: 启动时拉取失败（忽略，继续用本地）: {e}",
                    flush=True,
                )
    voice_db.append_event("info", "startup", f"service starting, db={db_path}")

    # 默认监听 0.0.0.0：网关可能和手机在同一局域网，换机器部署时不用改代码。
    host = config_value("VOICE_HOST", "0.0.0.0").strip() or "0.0.0.0"
    port_text = config_value("VOICE_PORT", "9529").strip()
    try:
        port = int(port_text)
    except ValueError as exc:
        raise SystemExit(f"VOICE_PORT 不是数字：{port_text}") from exc
    if not 1 <= port <= 65535:
        raise SystemExit(f"VOICE_PORT 超出范围：{port}")

    # 启动时把关键状态打出来，避免“服务起来了但模型没下/ffmpeg 没装”这种静默失败。
    config_exists = os.path.isfile(_config_path)
    print(
        f"[local-ai] 配置 : {_config_path}"
        f"{'' if config_exists else '（不存在，使用默认值）'}",
        flush=True,
    )
    print("[local-ai] 接口 : LLM /llm，Voice /voide", flush=True)

    if llm_enabled():
        print(
            f"[local-ai] LLM  : 代理 {llm_upstream_base()}"
            f"{'（模型 ' + llm_model_override() + '）' if llm_model_override() else ''}",
            flush=True,
        )
    else:
        print(
            "[local-ai] LLM  : 未启用（在 voice.conf 配置 LLM_UPSTREAM_BASE_URL 即可启用）",
            flush=True,
        )

    stt_upstream = upstream_base("STT")
    if stt_upstream:
        print(f"[local-ai] STT  : 代理 {stt_upstream}", flush=True)
    else:
        print(
            f"[local-ai] STT  : SenseVoice-small (sherpa-onnx) @ {sensevoice_dir()}",
            flush=True,
        )
        print(
            f"[local-ai] 模型 : {'已就绪' if sensevoice_ready() else '未下载（STT 不可用）'}",
            flush=True,
        )

    tts_upstream = upstream_base("TTS")
    if tts_upstream:
        upstream_voice = config_value("TTS_UPSTREAM_VOICE", "").strip()
        print(
            f"[local-ai] TTS  : 代理 {tts_upstream}"
            f"{'（音色 ' + upstream_voice + '）' if upstream_voice else ''}",
            flush=True,
        )
    else:
        print(f"[local-ai] TTS  : edge-tts（音色 {tts_voice()}）", flush=True)
        print(
            f"[local-ai] ffmpeg: {'已找到' if ffmpeg_path() else '未找到（TTS 的 wav 输出不可用）'}",
            flush=True,
        )

    key = resolve_api_key()
    if key is None:
        print("[local-ai] 鉴权 : 关闭", flush=True)
    elif config_value("VOICE_API_KEY", "").strip().lower() in API_KEY_AUTO_VALUES:
        print(f"[local-ai] 鉴权 : 开启（Key 文件 {api_key_file()}）", flush=True)
    else:
        print("[local-ai] 鉴权 : 开启（Key 来自配置 / 环境变量 / 命令行）", flush=True)

    # 管理面板：把 Web 控制台挂到同一个 9529 端口，用 admin.conf 的独立账号密码保护。
    # 与语音 / LLM 接口同进程，但走 /admin 前缀且单独鉴权，不干扰推理接口。
    admin_panel.init_admin(_config_path, VOICE_HOME)
    admin_panel.register_admin_routes(app)
    print(
        f"[local-ai] 管理 : http://{host}:{port}/admin "
        f"（账号密码见 {os.path.join(VOICE_HOME, 'admin.conf')}）",
        flush=True,
    )

    print(f"[local-ai] 监听 : http://{host}:{port}", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
