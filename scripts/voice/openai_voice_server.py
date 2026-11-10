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
        POST /voice/v1/audio/transcriptions multipart/form-data -> {"text": "..."}
        POST /voice/v1/audio/speech         application/json     -> WAV / MP3 / PCM
        GET  /voice/v1/models               语音后端模型列表
        GET  /voice/health                  仅语音的健康状态
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

上游概念只属于 LLM：
    STT / TTS 固定本地实现（SenseVoice / edge-tts），不支持上游代理。
    LLM：配置 LLM_UPSTREAM_POOL 即启用代理，请求按线协议翻译后转发；没有本地
    Ollama 后端，也不需要在本机安装 Ollama。
    仅 LLM 走 requirements-base.txt；STT / TTS 仍需各自的本地依赖与 ffmpeg。

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
        VOICE_API_KEY_AUTH  on / off；是否启用 API-Key 鉴权（作用于 /llm 与 /voice 数据接口）
        VOICE_IP_ALLOW     IP / CIDR 白名单（逗号或换行分隔）；非空时仅白名单内 IP 可访问
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
import ipaddress
import json
import os
import re
import secrets
import shutil
import subprocess
import urllib.parse
import urllib.request
import wave
import gzip
import zlib
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, AsyncIterator

import httpx
import uvicorn
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import llm_protocols  # LLM 上游多协议适配层
import admin_panel  # Web 管理面板（鉴权 + 配置编辑 + 启停 + 日志，挂在 9529 /admin）
import voice_db  # 本地管理数据库（SQLite）：配置的真相源 + 事件 / 审计
import voice_sync  # 远程数据库同步（Postgres）
import config_store  # 统一配置接口：本地缓存 + 本地库 + 远程库的门面
import upstream_pool  # 上游地址池：多地址 + 账号池，健康探测 + 轮询
import model_catalog  # 统一模型目录（LLM / TTS / STT 三端口，对齐 fw-plus-ai-native）
from fastapi import FastAPI, File, Form, Request, UploadFile
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
    "VOICE_API_KEY_AUTH": "off",
    "VOICE_IP_ALLOW": "",
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
    global _config_path, _file_config
    _config_path = os.path.abspath(os.path.expanduser(path))
    _file_config = None
    invalidate_api_keys()


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


# 对外提供的可用音色目录（edge-tts 风格），按语言分组并附说明。
# 管理面板与 /voice/v1/audio/voices 接口共用这一份，避免两端不一致。
VOICE_CATALOG = [
    {"id": "zh-CN-XiaoxiaoNeural", "lang": "中文", "desc": "女声·温柔自然（默认）"},
    {"id": "zh-CN-YunxiNeural", "lang": "中文", "desc": "男声·年轻活泼"},
    {"id": "zh-CN-YunyangNeural", "lang": "中文", "desc": "男声·专业新闻播报"},
    {"id": "zh-CN-XiaoyiNeural", "lang": "中文", "desc": "女声·活泼可爱"},
    {"id": "zh-CN-YunjianNeural", "lang": "中文", "desc": "男声·成熟稳重"},
    {"id": "zh-CN-YunxiaNeural", "lang": "中文", "desc": "女声·甜美"},
    {"id": "zh-CN-XiaoxuanNeural", "lang": "中文", "desc": "女声·清新"},
    {"id": "zh-TW-HsiaoChenNeural", "lang": "中文(台湾)", "desc": "女声·台湾腔"},
    {"id": "zh-TW-YunJheNeural", "lang": "中文(台湾)", "desc": "男声·台湾腔"},
    {"id": "zh-TW-HsiaoYuNeural", "lang": "中文(台湾)", "desc": "女声·台湾腔·温柔"},
    {"id": "zh-HK-HiuGaaiNeural", "lang": "粤语", "desc": "女声·粤语"},
    {"id": "zh-HK-WanLungNeural", "lang": "粤语", "desc": "男声·粤语"},
    {"id": "zh-HK-HiuMaanNeural", "lang": "粤语", "desc": "女声·粤语·活泼"},
    {"id": "en-US-AriaNeural", "lang": "英文", "desc": "女声·自然通用"},
    {"id": "en-US-GuyNeural", "lang": "英文", "desc": "男声·沉稳"},
    {"id": "en-US-JennyNeural", "lang": "英文", "desc": "女声·亲切"},
    {"id": "en-GB-SoniaNeural", "lang": "英文(英式)", "desc": "女声·优雅英音"},
    {"id": "en-GB-RyanNeural", "lang": "英文(英式)", "desc": "男声·英音"},
    {"id": "ja-JP-NanamiNeural", "lang": "日文", "desc": "女声·柔和"},
    {"id": "ja-JP-KeitaNeural", "lang": "日文", "desc": "男声·清晰"},
]


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


def api_key_auth_enabled() -> bool:
    """是否启用 API-Key 鉴权（作用于 /llm 与 /voice 数据接口）。默认不开启。

    显式 VOICE_API_KEY_AUTH=on -> 开启；显式 off/none/... -> 关闭。
    未设置（空）时向后兼容：沿用旧语义——VOICE_API_KEY 为非 off 值即开启
    （让旧的 VOICE_API_KEY=auto / --api-key 配置不因新增开关而失效）。
    全新安装两者皆空 -> VOICE_API_KEY 默认 off -> 关闭，满足「默认不开启」。
    """
    auth = config_value("VOICE_API_KEY_AUTH", "").strip().lower()
    if auth in ENABLED_VALUES:
        return True
    # 注意："" 也在 API_KEY_OFF_VALUES 里，必须排除空串，否则「未设置」会被当成
    # 「显式关闭」，直接短路掉下面这条向后兼容分支。
    if auth and auth in API_KEY_OFF_VALUES:
        return False
    return config_value("VOICE_API_KEY", "off").strip().lower() not in API_KEY_OFF_VALUES


_auto_api_key: str | None = None


def _auto_generated_key() -> str:
    """auto 模式下「一个」随机 Key，只生成一次并写入文件（一次性副作用，需记忆化）。"""
    global _auto_api_key
    if _auto_api_key:
        return _auto_api_key
    path = api_key_file()
    existing = _read_api_key(path)
    if existing:
        _auto_api_key = existing
        return existing
    generated = secrets.token_urlsafe(32)
    _write_api_key(path, generated)
    print(f"[local-ai] 已生成 API Key：{path}", flush=True)
    _auto_api_key = generated
    return generated


def resolve_api_keys() -> set[str]:
    """按「当前」配置解析允许的一组 Key；空集合 = 不校验。

    每次请求都重新读配置（config_value 走内存缓存，开销可忽略），因此开关 / 多 Key
    改动即时生效，不存在 TTL 缓存造成的鉴权空窗。只有 auto 生成的随机 Key 需要记忆化。
    """
    if not api_key_auth_enabled():
        return set()
    raw = config_value("VOICE_API_KEY", "off").strip()
    lowered = raw.lower()
    if lowered in API_KEY_AUTO_VALUES or lowered in API_KEY_OFF_VALUES or not raw:
        return {_auto_generated_key()}
    # 显式多 Key：逗号 / 换行 / 空格分隔，去空项（多个 Key 任一命中即通过）。
    return {k.strip() for k in re.split(r"[\s,]+", raw) if k.strip()}


def invalidate_api_keys() -> None:
    """切换配置文件后清掉 auto Key 记忆，避免沿用另一个 HOME 的旧 Key。"""
    global _auto_api_key
    _auto_api_key = None


def auth_enabled() -> bool:
    """仅供 /health 无副作用地报告状态。"""
    return api_key_auth_enabled()


# ── IP 白名单：覆盖所有对外接口（含 /admin），未命中直接 403 ──
def _parse_ip_allow() -> list:
    """把 VOICE_IP_ALLOW 解析成 ip_network 列表（单 IP 自动变 /32 或 /128）；空返回 []。

    逗号 / 换行 / 空格分隔，支持多个 IP 与 CIDR；非法条目静默忽略，避免一条错配置
    让整个服务起不来。
    """
    raw = config_value("VOICE_IP_ALLOW", "").strip()
    if not raw:
        return []
    out: list = []
    for part in re.split(r"[\s,]+", raw):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            continue
    return out


def client_ip(request: Request) -> str:
    """取直连对端 IP。

    刻意不信任 X-Forwarded-For / X-Real-IP：这些头可由客户端伪造，作为白名单依据
    等于给远程伪造「127.0.0.1」开后门。本服务由 Node 网关直连、不挂反向代理，
    对端 IP 即真实来源。若将来确实经可信代理接入，再按可信代理列表显式放通。
    """
    return request.client.host if request.client else ""


def ip_allowed(ip: str, allow: list) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in allow)


def is_loopback(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


# 网关健康探测 / 接口文档：不参与 API-Key 校验。/admin 由 _is_admin_path() 统一豁免。
_API_KEY_OPEN_PATHS = {
    "/", "/health",
    "/voice", "/voice/health",
    "/llm", "/llm/health",
    "/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect",
    "/favicon.ico",
}


def _is_admin_path(path: str) -> bool:
    """管理面板及其所有 API：走独立会话鉴权，两个过滤都不作用于它。"""
    return path == "/admin" or path.startswith("/admin/")


def _path_needs_api_key(path: str) -> bool:
    if _is_admin_path(path) or path.startswith("/static/"):
        return False
    return path not in _API_KEY_OPEN_PATHS


def _bearer_token(header: str | None) -> str:
    scheme, _, token = (header or "").partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


def upstream_timeout() -> float:
    try:
        return max(5.0, float(config_value("UPSTREAM_TIMEOUT", "120")))
    except ValueError:
        return 120.0


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
# /llm 是纯 OpenAI 兼容反向代理：把请求原样转发到上游地址池（LLM_UPSTREAM_POOL，
# 或向后兼容的单个 LLM_UPSTREAM_BASE_URL）。不加载本地模型、不做 Ollama 风格接口
# 翻译、不做非流式兜底；线协议（openai_chat_completions / azure_openai_chat_completions /
# openai_responses / anthropic_messages / gemini）按池里每个入口的 protocol 字段决定，
# 不再有全局单一协议；vendor（deepseek / dashscope / ollama 等）只决定路径变体。
def llm_enabled() -> bool:
    """auto 模式下配了上游池就启用；显式 on / off 始终优先。

    这里只判断、不轮询：has_upstream 不会推进轮询下标、也不会写入健康状态。
    """
    raw = config_value("LLM_ENABLED", "auto").strip().lower()
    if raw in API_KEY_OFF_VALUES:
        return False
    if raw in ENABLED_VALUES:
        return True
    return upstream_pool.has_upstream("LLM")


def llm_base_url() -> str | None:
    """当前选中的上游地址（供 /health 与启动日志展示）。

    展示用，优先取池里第一个入口，避免调用 pick() 推进轮询或误建健康条目。
    """
    entries = upstream_pool.load_pool("LLM")
    return entries[0]["base_url"] if entries else None


def llm_model_override() -> str:
    """配置后覆盖客户端传来的模型名；留空则完全沿用请求。"""
    return config_value("LLM_UPSTREAM_MODEL", "").strip()


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


app = FastAPI(title="openai-voice-server")

# 管理面板「测其它实例」是浏览器直连对方代理，对方必须允许跨域，否则 ASR/TTS
# 会在浏览器侧被 CORS 拦掉（表现为 Failed to fetch）。
# 只放行本机与内网来源：面板本身就跑在本机，跨实例测试的 Origin 也只可能是这些；
# 公网任意页面（如 https://evil.com）不在白名单内，避免被驱动本地代理烧配额。
_PRIVATE_ORIGIN_RE = (
    r"^https?://(?:localhost|127\.0\.0\.1|\[::1\]"
    r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?$"
)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=_PRIVATE_ORIGIN_RE,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
    max_age=600,
)


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    """对外数据接口统一过滤：IP 白名单 + API-Key 鉴权。

    /admin 管理面板走独立会话鉴权，两个过滤都不作用于它（「不包含 /admin」、
    「admin 也不需要 api-key」），也避免白名单配错把自己锁在面板外面。

    - IP 白名单（VOICE_IP_ALLOW 非空时）：作用于除 /admin 外的所有对外接口。
      本机环回地址恒放行——网关 / 面板都在本机，环回不算「对外」来源。
    - API-Key 鉴权（VOICE_API_KEY_AUTH=on 时）：作用于 /llm、/voice 数据接口。
      健康探测 / 文档 / OPTIONS 预检豁免；已登录管理面板的会话请求直接放行
      （面板自带会话鉴权，且它拉取模型目录不带 Bearer）。

    两个过滤都是「默认关闭」，未配置时整层零开销直接 call_next。
    """
    path = request.url.path

    # 管理面板：完全豁免两个过滤（IP 白名单与 API-Key 都不作用于 /admin）
    if _is_admin_path(path):
        return await call_next(request)

    # 1) IP 白名单（除 /admin 外的所有对外路径）
    allow = _parse_ip_allow()
    if allow:
        ip = client_ip(request)
        if not is_loopback(ip) and not ip_allowed(ip, allow):
            return JSONResponse(status_code=403, content={"detail": "IP 不在白名单"})

    # 2) API-Key 鉴权（全部 /llm、/voice 数据接口）
    if (
        request.method != "OPTIONS"
        and api_key_auth_enabled()
        and _path_needs_api_key(path)
        and not admin_panel.valid_session(request.cookies.get(admin_panel.SESSION_COOKIE))
    ):
        keys = resolve_api_keys()
        if keys:
            token = _bearer_token(request.headers.get("authorization"))
            if not (token and any(
                hmac.compare_digest(token.encode("utf-8"), k.encode("utf-8")) for k in keys
            )):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "缺少或错误的 API Key"},
                    headers={"WWW-Authenticate": "Bearer"},
                )
    return await call_next(request)


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


def sensevoice_check() -> dict:
    """按需真实检测内置（本地 SenseVoice）是否可用：模型文件 → 依赖 → 加载 → 跑一次推理。

    只在管理面板 ASR「内置」行点「测试可用」时调用（见 register_admin_routes 注入），
    启动阶段不执行：冷加载 240MB 模型会拖慢启动，且用户可能改用外部 ASR 提供商。
    同步函数，调用方用 asyncio.to_thread 包一层，避免阻塞事件循环。
    """
    model_dir = sensevoice_dir()
    if not sensevoice_ready():
        return {
            "ok": False,
            "reason": "model_missing",
            "model_dir": model_dir,
            "detail": "缺少 model.int8.onnx / tokens.txt，请运行 install-voice 下载内置模型",
        }
    try:
        import numpy  # noqa: F401  # decode_wav / 推理都要用
        import sherpa_onnx  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "dep_missing", "model_dir": model_dir, "detail": str(exc)}
    # 走与真实转写完全相同的 decode_wav + 推理路径，光看文件存在不算「可用」。
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(b"\x00\x00" * int(SAMPLE_RATE * 0.3))
    try:
        transcribe_sensevoice(buf.getvalue(), "zh")
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "infer_failed", "model_dir": model_dir, "detail": str(exc)}
    return {"ok": True, "reason": "ok", "model_dir": model_dir, "detail": ""}


async def tts_builtin_check() -> dict:
    """真实合成一句，验证内置 TTS（edge-tts + ffmpeg）是否可用。

    和线上 /voice/v1/audio/speech 走同一条本地分支；不拼地址、不自请求。
    用 wav 对齐网关实际请求格式（覆盖 ffmpeg 转码这一环）。
    只在管理面板 TTS「测试可用」时调用，启动阶段不执行。
    """
    text, fmt = "测试", "wav"
    try:
        mp3 = await synthesize_edge_mp3(text, resolve_voice(tts_voice()), tts_rate(1.0))
        audio, _ = await asyncio.to_thread(transcode_mp3, mp3, fmt)
        ok = bool(audio)
        detail = "" if ok else "合成结果为空"
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "infer_failed", "detail": str(exc)}
    return {"ok": ok, "reason": "ok" if ok else "infer_failed", "detail": detail}


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
    # ASR 固定本地 SenseVoice、TTS 固定内置 edge-tts，二者都没有上游。
    return {
        "status": "ok",
        "auth_enabled": auth_enabled(),
        "stt_backend": "sensevoice",
        "stt_ready": sensevoice_ready(),
        "stt_upstream": None,
        "tts_backend": "edge",
        "tts_voice": tts_voice(),
        "tts_upstream": None,
        "ffmpeg": bool(ffmpeg_path()),
        "model_dir": sensevoice_dir(),
        "tts_cache": tts_cache.stats(),
        "upstreams": {
            "LLM": upstream_pool.health_snapshot("LLM"),
        },
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
        "upstreams": upstream_pool.health_snapshot("LLM") if enabled else [],
    }


@app.get("/")
def root():
    # 网关健康检查先打根路径，这里直接给 200，省掉一次模型列表回退探测。
    return {
        "service": "app-product-local-ai",
        "llm": "proxy" if llm_enabled() else "off",
        "stt": "sensevoice",
        "tts": "edge",
    }


@app.get("/health")
def health():
    report = voice_health()
    report["llm"] = llm_health()
    return report


@app.get("/voice")
def voice_root():
    return {
        "service": "app-product-voice",
        "stt": "sensevoice",
        "tts": "edge",
    }


@app.get("/voice/health")
def voice_health_route():
    return voice_health()


@app.get("/voice/v1/models")
def voice_models():
    """语音模型目录：覆盖 TTS 与 STT 两个端口（对齐 fw-plus-ai-native 的三端口目录）。

    TTS / STT 固定本地后端（edge-tts / sensevoice-small），没有上游。
    统一用 model_catalog.ModelInfo，方便网关按 type 归类与校验。
    """
    data = [
        model_catalog.ModelInfo(
            id="edge-tts", owned_by="local", type=model_catalog.ModelType.TTS
        ).to_openai(),
        model_catalog.ModelInfo(
            id="sensevoice-small", owned_by="local", type=model_catalog.ModelType.STT
        ).to_openai(),
    ]
    return {"object": "list", "data": data}


class SpeechBody(BaseModel):
    input: str
    model: str = ""  # 内置 edge-tts 忽略，兼容 OpenAI 字段
    # 留空表示使用配置里的默认音色；网关通常不传或传自定义音色。
    voice: str = ""
    response_format: str = "wav"
    speed: float = 1.0
    instructions: str = ""  # OpenAI 新 TTS 字段，内置模式忽略


@app.post("/voice/v1/audio/speech")
async def speech(body: SpeechBody):
    """OpenAI 兼容的语音合成；网关固定请求 wav，按 24k PCM 下发。"""
    text = (body.input or "").strip()
    if not text:
        return error_response(400, "input 不能为空")

    fmt = (body.response_format or "wav").strip().lower()
    if fmt not in ("wav", "mp3", "pcm"):
        return error_response(400, f"不支持的 response_format: {fmt}")

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


@app.get("/voice/v1/audio/voices")
async def list_voices():
    """对外公开的可选音色目录（无需鉴权），供客户端下拉框与第三方调用方拉取。

    返回 {default, voices:[{id,lang,desc}]}，与 /voice/v1/audio/speech 的 voice 字段对齐。
    """
    return {"default": tts_voice(), "voices": VOICE_CATALOG}


@app.post("/voice/v1/audio/transcriptions")
async def transcriptions(
    request: Request,
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

    # ASR 固定走本地 SenseVoice（无上游概念），先挡掉非 WAV：
    # SenseVoice 的接入口只认 RIFF/WAVE，直接交给它只会得到空文本。
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


def llm_catalog() -> list[model_catalog.ModelInfo]:
    """合成 LLM 模型目录：所有分组的模型并集（去重）。

    优先用配置里的模型名（入口 model > 分组 model > 全局 LLM_UPSTREAM_MODEL），
    owned_by 记厂商 / 线协议便于排查。供 /llm/v1/models 与 chat 请求校验共用。
    """
    models: dict[str, model_catalog.ModelInfo] = {}
    override = llm_model_override()
    if override:
        models[override] = model_catalog.ModelInfo(
            id=override, owned_by="config", type=model_catalog.ModelType.LLM
        )
    for e in upstream_pool.load_pool("LLM"):
        m = e.get("model")
        if m:
            models.setdefault(
                m,
                model_catalog.ModelInfo(
                    id=m,
                    owned_by=(e.get("vendor") or e.get("protocol") or "openai"),
                    type=model_catalog.ModelType.LLM,
                ),
            )
    return list(models.values())


@app.get("/llm/v1/models")
async def llm_models():
    """模型列表：返回「所有分组的模型之和」，而不是只代理某一个上游。

    每个分组（按提供商）有自己固定的模型类型，把它们的模型并集返回给网关 / 用户，
    这样客户端能在多个提供商之间看到全部可用模型。优先用配置里的模型名（入口 model
    > 分组 model > 全局 LLM_UPSTREAM_MODEL）合成；如果都没配，则退回真实代理一个
    上游的 /models（保留 Ollama 翻译），避免空列表。
    """
    if not llm_enabled():
        return llm_disabled_response()
    entries = upstream_pool.load_pool("LLM")
    if not entries:
        return llm_disabled_response()

    models = llm_catalog()
    if models:
        return {
            "object": "list",
            "data": [mi.to_openai() for mi in models],
        }

    # 没有任何配置模型时，退回真实代理一个上游的模型列表。
    entry = upstream_pool.pick("LLM")
    if entry is None:
        return llm_disabled_response()
    protocol = entry["protocol"] or "openai_chat_completions"
    url, headers = llm_protocols.prepare_models(
        protocol, entry["base_url"], entry["api_key"], entry.get("vendor")
    )
    data = await fetch_json(url, headers)
    if isinstance(data, Response):
        return data
    if entry.get("vendor") == "ollama":
        data = llm_protocols.ollama_tags_to_openai(data)
    upstream_pool.mark_success("LLM", entry)
    return data


def _is_self_proxy_base(url: str) -> bool:
    """base_url 是否指向本代理自身。测试界面默认填本机地址时，若原样转发会
    把请求（连同 body 里的 base_url）不断发给自己造成递归、前端一直「请求中」。
    这类地址等价于「测本代理内部链路」，应剥掉 base_url 走配置池而非 HTTP 自转发。
    其它实例（不同 host 或不同端口）不受影响，仍按 URL 真转发。
    """
    try:
        p = urllib.parse.urlparse(url if "://" in url else "http://" + url)
    except ValueError:
        return False
    host = (p.hostname or "").lower()
    if host not in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
        return False
    try:
        own_port = int(config_value("VOICE_PORT", "9529").strip())
    except (ValueError, TypeError):
        own_port = 9529
    return (p.port or 80) == own_port


# 客户端自带的自定义请求头原样透传给上游（不落存储，每次请求各带各的）。
# 不做打包/编码：客户端填什么头，入站请求里就是什么头。只排除会破坏上游请求的
# 逐跳/浏览器保留头、代理鉴权头，以及代理自用的控制头 X-Proxy-Think
# （它由代理消费后翻译成上游厂商的 body 参数，不能当普通头透传）。
_PASSTHROUGH_EXCLUDE = {
    "host", "content-length", "content-type", "connection", "accept-encoding",
    "transfer-encoding", "cookie", "origin", "referer", "user-agent", "accept",
    "accept-language", "authorization", "x-proxy-think",
}


def extra_upstream_headers(request: Request) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in request.headers.items():
        lk = k.lower()
        if lk in _PASSTHROUGH_EXCLUDE or lk.startswith("sec-"):
            continue
        out[k] = v
    return out


@app.post("/llm/v1/chat/completions")
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

    # 是否思考：对外固定用请求头 X-Proxy-Think（不落存储、客户端每次自带），
    # 代理读入后转成内部统一字段，再由 apply_think 翻译成上游厂商原生的 body 参数。
    # 这是「代理自用的控制头」，不会原样透传给上游（上游的 think 在 body 里）。
    think_hdr = request.headers.get("x-proxy-think")
    if think_hdr is not None:
        body["think"] = think_hdr.strip().lower() in ("1", "true", "yes", "on")

    # 接口通过模型名路由到对应分组（提供商），再在组内多账号间轮询「内部消化」。
    # 命中分组时用该分组的模型（与请求模型一致，幂等）；未命中任何分组时退回
    # 全局健康优先 + 轮询，且不再用入口 model 覆盖，避免把请求模型偷偷改掉。
    # 测试界面可显式带 vendor / protocol 覆盖路由与线协议（不影响上游配置）。
    req_model = body.get("model") if isinstance(body.get("model"), str) else None
    req_vendor = body.get("vendor") if isinstance(body.get("vendor"), str) else None
    req_protocol = body.get("protocol") if isinstance(body.get("protocol"), str) else None
    req_base_url = body.get("base_url") if isinstance(body.get("base_url"), str) else None
    # 测试界面「按 URL 测试本代理（或其它实例）」：base_url 只填代理地址即可，
    # 自动补 /llm 前缀命中本代理的 OpenAI 兼容端点 /llm/v1/chat/completions；
    # 已带 /llm（如用户手填完整路径）则不重复追加。
    if req_base_url and "/llm" not in req_base_url:
        req_base_url = req_base_url.rstrip("/") + "/llm"
    # base_url 指向本代理自身时等价于「测本代理内部链路」：剥掉它走配置池路由，
    # 不再 HTTP 自转发（否则请求体带着 base_url 无限递归，前端一直「请求中」）。
    if req_base_url and _is_self_proxy_base(req_base_url):
        req_base_url = None
        body.pop("base_url", None)
        body.pop("api_key", None)

    # 模型目录校验：目录非空（即已配置模型）且客户端显式带了模型时，若不在目录内
    # 直接拒绝，避免把请求发到一个根本不存在的模型上、再由上游返回一堆乱码错误。
    # 客户端没带模型、或目录为空（没法判定）时放行，由上游决定。
    # 显式带 base_url 的「按 URL 测试」场景跳过此门禁（不受配置池目录约束）。
    if req_model and not body.get("bypass_catalog") and not req_base_url:
        catalog = llm_catalog()
        if catalog:
            v = model_catalog.validate(model_catalog.ModelType.LLM, catalog, req_model)
            if not v.valid:
                return error_response(400, f"模型校验失败：{v.reason}（请求模型 {req_model!r}）")

    # 测试界面可显式带 base_url，直接打到该上游地址（绕过池内路由），用于验证任意
    # OpenAI 兼容端点；此时厂商/模型路由不再生效，完全按客户端给的 URL + 协议转发。
    if req_base_url:
        entry = {
            "base_url": req_base_url,
            "api_key": (body.get("api_key") or "") if isinstance(body.get("api_key"), str) else "",
            "protocol": req_protocol or "openai_chat_completions",
            "model": req_model or "",
            "vendor": "",
        }
    else:
        # 池内路由（未显式带 base_url）。四种情况：
        # 1) 提供商+模型都传：按提供商路由，模型原样下发；
        # 2) 只传模型：按模型定位提供商，命中多个提供商时取默认提供商，未配置默认或
        #    默认不含该模型则报错；
        # 3) 只传提供商：在该提供商的模型池内取默认模型；
        # 4) 都没传：优先默认提供商，在其模型池内取默认模型，没配默认提供商则退回全局轮询。
        if req_vendor:
            entry = upstream_pool.pick_by_vendor("LLM", req_vendor)
        elif req_model:
            matched = [e for e in upstream_pool.load_pool("LLM") if e.get("model") == req_model]
            if not matched:
                return error_response(
                    400,
                    f"模型 {req_model} 未在已配置的提供商中找到（请检查模型名或刷新模型列表）",
                )
            vendors = sorted({e.get("vendor") for e in matched})
            if len(vendors) > 1:
                default_vendor = (config_value("LLM_UPSTREAM_VENDOR", "") or "").strip().lower()
                if not default_vendor or default_vendor not in vendors:
                    return error_response(
                        400,
                        f"模型 {req_model} 命中多个提供商 {vendors}，"
                        f"但未配置默认提供商或默认提供商不含该模型（LLM_UPSTREAM_VENDOR）",
                    )
                target_vendor = default_vendor
            else:
                target_vendor = vendors[0]
            entry = upstream_pool.pick_by_vendor("LLM", target_vendor)
        else:
            default_vendor = (config_value("LLM_UPSTREAM_VENDOR", "") or "").strip().lower()
            entry = (upstream_pool.pick_by_vendor("LLM", default_vendor)
                     if default_vendor else upstream_pool.pick_by_model("LLM", None))
    if entry is None:
        return llm_disabled_response()
    # 模型存在性校验（对外接口侧，基于上游模型列表缓存，非每次实时探测）：
    # 仅当上游能枚举模型且请求模型不在其中时才报「模型不存在」，避免把请求发给根本不存在的模型；
    # 枚举失败 / 不支持枚举时放行，不误杀正常流量。
    if req_model:
        try:
            upstream_models = await upstream_pool.list_provider_models(
                entry["base_url"], entry["api_key"],
                req_protocol or entry["protocol"] or "openai_chat_completions",
                entry.get("vendor"),
            )
        except Exception:
            upstream_models = None
        if upstream_models is not None and not any(
            m.lower() == req_model.lower() for m in upstream_models
        ):
            return error_response(
                404,
                f"模型不存在：{req_model}（该提供商未提供此模型，请检查名称或刷新模型列表）",
            )
    # 模型名确定（对外统一规则）：
    # - 显式带了模型就原样下发（用户/测试指定了要跑哪个模型，绝不偷偷替换）；
    # - 没带模型（只传提供商 / 都没传）：在所选提供商的模型池内取默认模型——
    #   优先全局默认模型（LLM_UPSTREAM_MODEL），若它属于该提供商；否则退回该提供商
    #   的入口模型，保证模型在该提供商模型池里消化，不串到别的提供商。
    override_model = llm_model_override()
    if req_model:
        effective_model = req_model
    else:
        vendor_models = [
            e.get("model") for e in upstream_pool.load_pool("LLM")
            if e.get("vendor") == entry.get("vendor") and e.get("model")
        ]
        effective_model = (
            override_model if (override_model and override_model in vendor_models) else
            (entry.get("model") or next(iter(vendor_models), "") or override_model)
        )
    req, stream_cls, resp_transform = llm_protocols.prepare(
        req_protocol or entry["protocol"] or "openai_chat_completions", entry["base_url"], entry["api_key"],
        effective_model, llm_api_version(), body, entry.get("vendor"),
    )
    # 客户端自带的自定义请求头透传到上游（不落存储，每次请求各带各的）
    req.headers.update(extra_upstream_headers(request))
    # 强制上游返回明文（不压缩）：流式响应 httpx 不会自动解压，若上游 gzip
    # 压缩后原样透传给浏览器，浏览器又收不到 Content-Encoding 头，会把压缩字节
    # 当 UTF-8 解码 → SSE 解析不出任何 data 行，前端测试/对话一片空白。
    req.headers["Accept-Encoding"] = "identity"

    if not body.get("stream"):
        try:
            async with httpx.AsyncClient(timeout=upstream_timeout()) as client:
                response = await client.post(req.url, headers=req.headers, json=req.payload)
        except httpx.HTTPError as exc:
            upstream_pool.mark_failure("LLM", entry)
            if req_base_url:
                return error_response(502, f"无法连接 base_url 指定的上游（{entry['base_url']}）：{exc}；请检查地址是否正确、该代理/服务是否已启动。")
            return error_response(502, f"上游 LLM 请求失败: {exc}")
        if response.status_code >= 400:
            upstream_pool.mark_failure("LLM", entry, response.status_code)
            return error_response(
                502, f"上游 LLM 失败（{response.status_code}）: {upstream_error(response)}"
            )
        upstream_pool.mark_success("LLM", entry)
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
        if req_base_url:
            return error_response(502, f"无法连接 base_url 指定的上游（{entry['base_url']}）：{exc}；请检查地址是否正确、该代理/服务是否已启动。")
        return error_response(502, f"上游 LLM 请求失败: {exc}")
    if response.status_code >= 400:
        content = await response.aread()
        await client.aclose()
        return error_response(
            502,
            f"上游 LLM 失败（{response.status_code}）: {content.decode(errors='replace')[:500]}",
        )

    model = effective_model or body.get("model", "")
    translator = stream_cls(model)

    # 兜底：即便上游忽略了 Accept-Encoding: identity 仍返回压缩流，这里按
    # Content-Encoding 解压后再喂给翻译器，保证下发给浏览器的是明文 SSE。
    upstream_encoding = (response.headers.get("content-encoding") or "").lower()
    _decomp = None
    if upstream_encoding == "gzip":
        _decomp = gzip.decompress
    elif upstream_encoding in ("deflate", "zlib"):
        _decomp = zlib.decompress
    elif upstream_encoding == "br":
        try:
            import brotli
            _decomp = brotli.decompress
        except Exception:
            _decomp = None  # 无 brotli 依赖时不强制，交给浏览器（极少数上游）

    def _decode(raw: bytes) -> bytes:
        if _decomp is not None:
            try:
                return _decomp(raw)
            except Exception:
                return raw
        return raw

    async def body_gen():
        try:
            async for chunk in response.aiter_raw():
                out = translator.feed(_decode(chunk))
                if out:
                    yield out
        finally:
            tail = translator.finish()
            if tail:
                yield tail
            await response.aclose()
            await client.aclose()

    return StreamingResponse(body_gen(), media_type="text/event-stream")


@app.get("/llm/v1/providers")
async def list_llm_providers():
    """对外公开：列出当前已配置的 LLM 提供商（vendor），供测试界面下拉框与第三方拉取。

    每个条目含 vendor / protocol / model / host（脱敏后的上游主机），不含任何密钥。
    """
    entries = upstream_pool.load_pool("LLM")
    out = []
    seen = set()
    for e in entries:
        vendor = (e.get("vendor") or "").strip().lower()
        protocol = e.get("protocol") or "openai_chat_completions"
        model = e.get("model") or ""
        base = (e.get("base_url") or "").strip()
        host = ""
        if base:
            try:
                from urllib.parse import urlparse
                host = urlparse(base).netloc or base
            except Exception:
                host = base
        key = (vendor, protocol, model, host)
        if key in seen:
            continue
        seen.add(key)
        out.append({"vendor": vendor or "(未指定)", "protocol": protocol, "model": model, "host": host})
    return {"providers": out}


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
        _cli_overrides["VOICE_API_KEY_AUTH"] = "on"
        if "VOICE_API_KEY" not in _cli_overrides:
            _cli_overrides["VOICE_API_KEY"] = "auto"
    if args.no_api_key:
        _cli_overrides["VOICE_API_KEY_AUTH"] = "off"

    # 配置真相源 = 本地 SQLite，并通过 config_store 统一接口收口缓存与远程同步。
    # voice.conf 只在 DB 为空时用于播种（首次初始化 / 兜底），之后不再是权威。
    # 本地数据库目录本身属于基础设施，必须在 store 配置前确定，故直接读环境变量 / voice.conf。
    db_dir = (
        os.environ.get("VOICE_DB_DIR")
        or _file_values().get("VOICE_DB_DIR")
        or VOICE_HOME
    )
    db_dir = os.path.expanduser(_expand_path(db_dir))
    os.makedirs(db_dir, exist_ok=True)
    db_path = os.path.join(db_dir, "voice.db")
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
    print("[local-ai] 接口 : LLM /llm，Voice /voice", flush=True)

    if llm_enabled():
        print(
            f"[local-ai] LLM  : 代理 {llm_base_url()}"
            f"（地址池共 {len(upstream_pool.load_pool('LLM'))} 个）"
            f"{'（模型 ' + llm_model_override() + '）' if llm_model_override() else ''}",
            flush=True,
        )
    else:
        print(
            "[local-ai] LLM  : 未启用（在 voice.conf 配置 LLM_UPSTREAM_POOL 或 "
            "LLM_UPSTREAM_BASE_URL 即可启用）",
            flush=True,
        )

    # STT 固定走本地 SenseVoice，不接上游；可用性由管理面板 ASR「内置」行按需检测。
    print(
        f"[local-ai] STT  : 内置 SenseVoice-small @ {sensevoice_dir()}；"
        "可用性在管理面板 ASR「内置」行点「测试可用」按需检测",
        flush=True,
    )

    print(f"[local-ai] TTS  : 内置 edge-tts（音色 {tts_voice()}）", flush=True)
    print(
        f"[local-ai] ffmpeg: {'已找到' if ffmpeg_path() else '未找到（TTS 的 wav 输出不可用）'}",
        flush=True,
    )

    if api_key_auth_enabled():
        ks = resolve_api_keys()
        print(f"[local-ai] 鉴权 : 开启（{len(ks)} 个 Key）", flush=True)
    else:
        print("[local-ai] 鉴权 : 关闭", flush=True)
    allow = _parse_ip_allow()
    if allow:
        print(f"[local-ai] IP白名单: 启用（{len(allow)} 条）", flush=True)
    else:
        print("[local-ai] IP白名单: 关闭（不限制来源）", flush=True)

    # 管理面板：把 Web 控制台挂到同一个 9529 端口，用 admin.conf 的独立账号密码保护。
    # 与语音 / LLM 接口同进程，但走 /admin 前缀且单独鉴权，不干扰推理接口。
    admin_panel.init_admin(_config_path, VOICE_HOME)
    admin_panel.register_admin_routes(
        app, stt_builtin_check=sensevoice_check, tts_builtin_check=tts_builtin_check
    )
    print(
        f"[local-ai] 管理 : http://{host}:{port}/admin "
        f"（账号密码见 {os.path.join(VOICE_HOME, 'admin.conf')}）",
        flush=True,
    )

    # 上游地址池健康探测：后台线程定期探活，配合运行期失败累计，自动把挂掉的
    # 上游从轮询里摘掉、冷却恢复后再放回。与 uvicorn 主事件循环解耦。
    upstream_pool.start_health_probing()
    print("[local-ai] 上游 : 地址池健康探测已启动（多地址 + 账号池，健康优先 + 轮询）", flush=True)

    print(f"[local-ai] 监听 : http://{host}:{port}", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
