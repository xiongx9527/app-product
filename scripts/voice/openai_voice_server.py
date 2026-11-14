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
    Voice（统一前缀，不按 ASR/TTS 分一级路径——与 DashScope 的形态一致）:
        POST /voice/v1/audio/transcriptions multipart/form-data -> {"text": "..."}
        POST /voice/v1/audio/translations   multipart/form-data -> {"text": "..."}（先 ASR 识别原文，再经 LLM 翻译成 target_lang，默认英语；无 LLM 上游返回 503）
        POST /voice/v1/audio/speech         application/json     -> WAV / MP3 / PCM
        GET  /voice/v1/audio/voices         可选音色目录
        GET  /voice/v1/models               语音后端模型列表（内置 + 已配置上游，动态）
        GET  /voice/v1/providers            语音提供商列表（STT / TTS 两个端口，含协议）
        GET  /voice/health                  仅语音的健康状态
    Voice WebSocket（/voice/ws 前缀，与 /voice/v1 平行，区分 WS 与 HTTP）:
        WS   /voice/ws/inference    实时 ASR / TTS 统一入口（run-task/finish-task + 二进制帧，task 区分）
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
import base64
import uuid
import websockets

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
import time
import urllib.parse
import urllib.request
from pathlib import Path
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
from fastapi import FastAPI, File, Form, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
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


# 对外提供的可用音色目录（edge-tts 风格）。
# 每条只保留 id 与中/英两份描述（desc_zh / desc_en），不再带 lang——语言由 id 前缀体现，
# 调用方按需选中文或英文描述，避免接口里混入单语标签。
# 管理面板与 /voice/v1/audio/voices 接口共用这一份，避免两端不一致。
VOICE_CATALOG = [
    {"id": "zh-CN-XiaoxiaoNeural", "desc_zh": "女声·温柔自然（默认）", "desc_en": "Female · gentle and natural (default)"},
    {"id": "zh-CN-YunxiNeural", "desc_zh": "男声·年轻活泼", "desc_en": "Male · young and lively"},
    {"id": "zh-CN-YunyangNeural", "desc_zh": "男声·专业新闻播报", "desc_en": "Male · professional news broadcast"},
    {"id": "zh-CN-XiaoyiNeural", "desc_zh": "女声·活泼可爱", "desc_en": "Female · lively and cute"},
    {"id": "zh-CN-YunjianNeural", "desc_zh": "男声·成熟稳重", "desc_en": "Male · mature and steady"},
    {"id": "zh-CN-YunxiaNeural", "desc_zh": "女声·甜美", "desc_en": "Female · sweet"},
    {"id": "zh-CN-XiaoxuanNeural", "desc_zh": "女声·清新", "desc_en": "Female · fresh"},
    {"id": "zh-TW-HsiaoChenNeural", "desc_zh": "女声·台湾腔", "desc_en": "Female · Taiwanese accent"},
    {"id": "zh-TW-YunJheNeural", "desc_zh": "男声·台湾腔", "desc_en": "Male · Taiwanese accent"},
    {"id": "zh-TW-HsiaoYuNeural", "desc_zh": "女声·台湾腔·温柔", "desc_en": "Female · Taiwanese accent · gentle"},
    {"id": "zh-HK-HiuGaaiNeural", "desc_zh": "女声·粤语", "desc_en": "Female · Cantonese"},
    {"id": "zh-HK-WanLungNeural", "desc_zh": "男声·粤语", "desc_en": "Male · Cantonese"},
    {"id": "zh-HK-HiuMaanNeural", "desc_zh": "女声·粤语·活泼", "desc_en": "Female · Cantonese · lively"},
    {"id": "en-US-AriaNeural", "desc_zh": "女声·自然通用", "desc_en": "Female · natural and versatile"},
    {"id": "en-US-GuyNeural", "desc_zh": "男声·沉稳", "desc_en": "Male · calm"},
    {"id": "en-US-JennyNeural", "desc_zh": "女声·亲切", "desc_en": "Female · friendly"},
    {"id": "en-GB-SoniaNeural", "desc_zh": "女声·优雅英音", "desc_en": "Female · elegant British accent"},
    {"id": "en-GB-RyanNeural", "desc_zh": "男声·英音", "desc_en": "Male · British accent"},
    {"id": "ja-JP-NanamiNeural", "desc_zh": "女声·柔和", "desc_en": "Female · soft"},
    {"id": "ja-JP-KeitaNeural", "desc_zh": "男声·清晰", "desc_en": "Male · clear"},
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


def default_model_for_provider(cap: str, vendor: str) -> str:
    """取某提供商自己的默认模型（*_UPSTREAM_DEFAULT_MODELS 里的 vendor -> model）。

    默认模型按提供商维度存：每个提供商各有一个，没勾「默认提供商」也各自生效。
    找不到时回退到全局 *_UPSTREAM_MODEL（兼容旧配置 / 单地址写法）。
    """
    raw = (config_value(f"{cap}_UPSTREAM_DEFAULT_MODELS", "") or "").strip()
    if raw:
        try:
            mapping = json.loads(raw)
        except (ValueError, TypeError):
            mapping = None
        if isinstance(mapping, dict):
            v = (vendor or "").strip().lower()
            for key, val in mapping.items():
                if str(key).strip().lower() == v and isinstance(val, str) and val.strip():
                    return val.strip()
    return (config_value(f"{cap}_UPSTREAM_MODEL", "") or "").strip()


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


app = FastAPI(
    title="openai-voice-server",
    description=(
        "本地 AI 语音服务。HTTP 语音接口（/voice/v1/audio/transcriptions、/speech、/translations、"
        "/voices、/models、/providers）符合 OpenAI 音频 API 标准，可直接在下方调试；"
        "LLM 代理（/llm/v1/chat/completions、/embeddings、/models、/providers）同为 OpenAI 兼容层，"
        "网关换 base_url 即用。实时 WebSocket 接口 /voice/ws/inference 协议见 /docs/ws"
        "（OpenAPI 不描述 WebSocket，故独立文档页；也可在仓库 xiaoxiong-app/contracts/README.md 查看）。"
    ),
)

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


def _looks_like_mp3(data: bytes) -> bool:
    """粗略判断字节是否已是 MP3（ID3 标签头或 MPEG 音频帧同步字）。"""
    if data[:3] == b"ID3":
        return True
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return True
    return False


def transcode_mp3(mp3: bytes, fmt: str):
    """把上游音频字节（edge-tts / DashScope 的 MP3 或 WAV）转成网关需要的 WAV / 裸 PCM / MP3。

    强行指定 24kHz / 单声道 / 16bit，和网关 tts.start 声明的 pcm16@24000 对齐，
    网关拿到后不需要再重采样，直接按二进制帧下发。wav 输出带 RIFF 头，pcm 输出裸 s16le，
    mp3 用 libmp3lame 编码；若输入已是 MP3 则直接透传，省去重编码。
    """
    binary = ffmpeg_path()
    if not binary:
        raise RuntimeError(
            "未找到 ffmpeg，无法把音频转成目标格式；"
            "macOS 可执行 brew install ffmpeg，Windows 可执行 winget install Gyan.FFmpeg"
        )

    # 已是 MP3 则透传，避免把 MP3 又重新编码一遍（也兼容上游直接返回 MP3 的情况）。
    if fmt == "mp3" and _looks_like_mp3(mp3):
        return mp3, "audio/mpeg"

    if fmt == "wav":
        out_format, codec, media_type = "wav", "pcm_s16le", "audio/wav"
    elif fmt == "pcm":
        out_format, codec, media_type = "s16le", "pcm_s16le", "audio/pcm"
    elif fmt == "mp3":
        out_format, codec, media_type = "mp3", "libmp3lame", "audio/mpeg"
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
        codec,
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


# 内置语音引擎的有效模型白名单：与 /voice/v1/models 目录同源，防两处漂移。
# 请求里 model 为空/不传 = 用内置默认；传了必须是白名单里的值，传错直接 400（不静默忽略）。
BUILTIN_TTS_MODELS = {"edge-tts"}
BUILTIN_STT_MODELS = {"sensevoice-small"}

# STT / TTS 上游 provider 的默认上游地址（与转发分支里的兜底保持一致）。
_UPSTREAM_DEFAULT_BASE = "https://dashscope.aliyuncs.com"


def _host_of(base_url: str) -> str:
    """从上游 base_url 取出主机名（脱敏，不暴露路径 / 密钥）；解析失败原样返回。"""
    base = (base_url or "").strip()
    if not base:
        return ""
    try:
        from urllib.parse import urlparse

        return urlparse(base).netloc or base
    except Exception:  # noqa: BLE001
        return base


def _json_model_list(raw: str) -> list[str]:
    """DB 里 *_UPSTREAM_MODELS 可能是 JSON 数组字符串或空；安全解析成去空白模型名列表。"""
    raw = (raw or "").strip()
    if not raw:
        return []
    try:
        import json as _json

        val = _json.loads(raw)
        if isinstance(val, list):
            return [str(m).strip() for m in val if str(m).strip()]
    except Exception:  # noqa: BLE001
        pass
    return [m.strip() for m in raw.split(",") if m.strip()]


def _edge_tts_available() -> bool:
    """内置 TTS 是否可用：edge-tts 能 import 且 ffmpeg 在 PATH（或 FFMPEG_BIN 指向文件）。"""
    try:
        import edge_tts  # noqa: F401

        return ffmpeg_path() is not None
    except Exception:  # noqa: BLE001
        return False


def _voice_provider_entries() -> list[dict]:
    """枚举 STT / TTS 两个端口的可用提供商，供 /voice/v1/providers 与 /voice/v1/models 共用。

    每个端口始终含 builtin（本地引擎）；若 DB 配置了上游 provider（dashscope / deepseek /
    openai_audio），再追加一条上游条目，含 base_url 主机、默认模型、候选模型列表、协议。
    protocol 是调用形态（http / ws / http-async），优先取 DB 的 speech_models 表；任何密钥都不出现。
    """
    out: list[dict] = []

    def add(capability, vendor, model, host, ready, models, protocol):
        out.append(
            {
                "capability": capability,  # stt / tts
                "vendor": vendor,  # builtin / dashscope / openai_audio
                "protocol": protocol,  # http / ws / http-async（调用形态，不含厂商/部署位置）
                "model": model,  # 该 provider 当前默认模型
                "host": host,  # 上游主机（脱敏）
                "ready": ready,  # builtin 为布尔；上游为 None（需点测）
                "models": models,  # 候选模型列表（用于下拉）
            }
        )

    # ---- STT ----
    stt_provider = (config_value("STT_PROVIDER", "builtin") or "builtin").strip().lower()
    stt_base = (config_value("STT_UPSTREAM_BASE_URL") or "").strip() or _UPSTREAM_DEFAULT_BASE
    stt_model = (config_value("STT_UPSTREAM_MODEL") or "").strip()
    stt_models = _json_model_list(config_value("STT_UPSTREAM_MODELS")) or (
        [stt_model] if stt_model else []
    )
    add("stt", "builtin", "sensevoice-small", "", sensevoice_ready(),
        sorted(BUILTIN_STT_MODELS), "http")
    if stt_provider and stt_provider != "builtin":
        add("stt", stt_provider, stt_model, _host_of(stt_base), None,
            stt_models, voice_db.model_protocol("stt", stt_provider, stt_model)
            or ("ws" if _model_uses_ws(stt_model) else "http"))

    # ---- TTS ----
    tts_provider = (config_value("TTS_PROVIDER", "builtin") or "builtin").strip().lower()
    tts_base = (config_value("TTS_UPSTREAM_BASE_URL") or "").strip() or _UPSTREAM_DEFAULT_BASE
    tts_model = (config_value("TTS_UPSTREAM_MODEL") or "").strip()
    tts_models = _json_model_list(config_value("TTS_UPSTREAM_MODELS")) or (
        [tts_model] if tts_model else []
    )
    add("tts", "builtin", "edge-tts", "", _edge_tts_available(),
        sorted(BUILTIN_TTS_MODELS), "http")
    if tts_provider and tts_provider != "builtin":
        add("tts", tts_provider, tts_model, _host_of(tts_base), None,
            tts_models, voice_db.model_protocol("tts", tts_provider, tts_model)
            or ("ws" if _model_uses_ws(tts_model) else "http"))
    return out


@app.get("/voice/v1/providers")
def voice_providers():
    """对外公开：列出当前已配置的语音提供商（STT / TTS 两个端口）。

    形状对齐 /llm/v1/providers，但增加 capability / protocol / host / ready / models 等语音专属字段。
    每个端口恒含 builtin（本地引擎），若配置了上游 provider（dashscope / openai_audio）则追加其条目。
    仅含 vendor / protocol / host（脱敏）/ 模型，不含任何密钥。
    """
    return {"providers": _voice_provider_entries()}


@app.get("/voice/v1/models")
def voice_models():
    """语音模型目录：覆盖 STT 与 TTS 两个端口（对齐 fw-plus-ai-native 的三端口目录）。

    模型来自当前激活的提供商：builtin 固定（sensevoice-small / edge-tts），上游（dashscope /
    openai_audio）取 DB 配置的候选模型列表（*_UPSTREAM_MODELS），不再写死 2 个。
    统一用 model_catalog.ModelInfo，每条带 provider（厂商）与 protocol（调用形态
    http / ws / http-async），方便网关按 type / provider / protocol 归类与校验。
    """
    data = []
    for entry in _voice_provider_entries():
        mtype = (
            model_catalog.ModelType.STT
            if entry["capability"] == "stt"
            else model_catalog.ModelType.TTS
        )
        owned = "local" if entry["vendor"] == "builtin" else entry["vendor"]
        models = entry["models"] or ([entry["model"]] if entry["model"] else [])
        for mid in models:
            if not mid:
                continue
            # 协议是模型级字段，优先读 DB 的 speech_models 表（init_catalog.py 维护），
            # 读不到再按模型名推断。内置本地引擎走 /voice/v1 的 HTTP，协议是 http，
            # 不是 "local"（那是部署位置）；厂商单独放 provider 字段，不混进协议。
            protocol = voice_db.model_protocol(entry["capability"], entry["vendor"], mid) or (
                "http" if entry["vendor"] == "builtin"
                else ("ws" if _model_uses_ws(mid) else "http")
            )
            data.append(
                model_catalog.ModelInfo(
                    id=mid,
                    owned_by=owned,
                    type=mtype,
                    provider=entry["vendor"],
                    protocol=protocol,
                ).to_openai()
            )
    return {"object": "list", "data": data}


class SpeechBody(BaseModel):
    input: str
    model: str = ""  # 内置 edge-tts 忽略，兼容 OpenAI 字段
    # 留空表示使用配置里的默认音色；网关通常不传或传自定义音色。
    voice: str = ""
    response_format: str = "wav"
    speed: float = 1.0
    instructions: str = ""  # OpenAI 新 TTS 字段，内置模式忽略
    # 底部测试页可显式覆盖默认路由：留空=沿用 DB 配置，行为与不带这两个字段时完全一致。
    provider: str = ""  # builtin / dashscope / openai_audio
    protocol: str = ""  # 上游线协议：http / ws / http-async；留空按模型自动推断


def _openai_audio_url(base: str, path: str) -> str:
    """拼 OpenAI 兼容音频端点 URL：兼容用户填 / 不填 /v1（与 LLM 拼法同一风格）。"""
    url = base.rstrip("/")
    if not url.endswith("/v1"):
        url += "/v1"
    return url + path


async def forward_speech_openai(
    text: str, voice: str, speed: float, fmt: str, model: str
) -> bytes:
    """TTS_PROVIDER=openai_audio 时把合成请求转发到 OpenAI 兼容上游。

    返回上游音频原始字节（content-type 不保证 mp3；ffmpeg 转码按内容探测，不看扩展名）。
    失败抛 RuntimeError，由调用方转 502——已选上游就如实报错，不回落内置。
    """
    # 服务地址固定为 DashScope 官方入口（语音只能走云端，同 gateway 的约定）
    base = (config_value("TTS_UPSTREAM_BASE_URL") or "").strip() or "https://dashscope.aliyuncs.com"
    key = (config_value("TTS_UPSTREAM_API_KEY") or "").strip()
    url = _openai_audio_url(base, "/audio/speech")
    payload = {
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": fmt,
        "speed": speed,
    }
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(url, json=payload, headers=headers)
    if r.status_code >= 400:
        raise RuntimeError(f"上游 TTS 失败（{r.status_code}）: {r.text[:200]}")
    return r.content


async def _ws_asr_test(base: str, key: str, model: str, audio: bytes, fmt: str) -> str:
    """DashScope WS 实时识别测试：run-task → 发音频 → finish → 收识别文本。"""
    url = base.rstrip("/").replace("https://", "wss://").replace("http://", "ws://") + "/api-ws/v1/inference"
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    task_id = uuid.uuid4().hex
    text = ""
    async with websockets.connect(url, additional_headers=headers, close_timeout=5) as ws:
        await ws.send(json.dumps({
            "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
            "payload": {"task_group": "audio", "task": "asr", "function": "recognition",
                        "model": model, "input": {},
                        "parameters": {"format": fmt, "sample_rate": 16000}},
        }))
        started = False
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                continue
            ev = (json.loads(msg).get("header") or {})
            e = ev.get("event")
            if e == "task-started":
                started = True
                await ws.send(audio)
                await ws.send(json.dumps({
                    "header": {"action": "finish-task", "task_id": task_id, "streaming": "duplex"},
                    "payload": {"input": {}},
                }))
            elif e == "result-generated":
                payload = json.loads(msg).get("payload") or {}
                out = payload.get("output") or payload
                sentence = out.get("sentence") or {}
                if isinstance(sentence, dict) and sentence.get("text"):
                    text = sentence["text"].strip()
            elif e == "task-failed":
                raise RuntimeError(f"WS 任务失败: {ev.get('error_message') or ev.get('error_code')}")
            elif e == "task-finished":
                break
        if not started:
            raise RuntimeError("WS 连接未进入 task-started")
    return text


async def _ws_tts_test(base: str, key: str, model: str, text: str, voice: str) -> bytes:
    """DashScope WS 实时合成测试：run-task → 发文本 → 收二进制音频帧 → finished。"""
    url = base.rstrip("/").replace("https://", "wss://").replace("http://", "ws://") + "/api-ws/v1/inference"
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    task_id = uuid.uuid4().hex
    frames = bytearray()
    async with websockets.connect(url, additional_headers=headers, close_timeout=5) as ws:
        await ws.send(json.dumps({
            "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
            "payload": {"task_group": "audio", "task": "tts", "function": "SpeechSynthesizer",
                        "model": model, "input": {},
                        "parameters": {"text_type": "PlainText", "voice": voice}},
        }))
        started = False
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                frames.extend(msg)
                continue
            ev = (json.loads(msg).get("header") or {})
            e = ev.get("event")
            if e == "task-started" and not started:
                started = True
                await ws.send(json.dumps({
                    "header": {"action": "continue-task", "task_id": task_id, "streaming": "duplex"},
                    "payload": {"input": {"text": text}},
                }))
                await ws.send(json.dumps({
                    "header": {"action": "finish-task", "task_id": task_id, "streaming": "duplex"},
                    "payload": {"input": {}},
                }))
            elif e == "task-failed":
                raise RuntimeError(f"WS 任务失败: {ev.get('error_message') or ev.get('error_code')}")
            elif e == "task-finished":
                break
        if not started:
            raise RuntimeError("WS 连接未进入 task-started")
    if not frames:
        raise RuntimeError("WS 合成未收到音频帧")
    return bytes(frames)


def _model_uses_ws(model: str) -> bool:
    """模型是否只支持 WS（cosyvoice / realtime / streaming / gummy 系）——对齐面板协议标签。"""
    m = (model or "").lower()
    return bool(re.search(r"cosyvoice|realtime|streaming|gummy", m))


def resolve_voice_protocol(requested: str, model: str, provider: str) -> str:
    """把测试页的协议选择收敛成 http / ws / http-async；留空按模型自动推断。

    内置（本地 SenseVoice / edge-tts）只有 http；上游模型按 _model_uses_ws 推断。
    """
    p = (requested or "").strip().lower()
    if p:
        return p
    if provider == "builtin":
        return "http"
    return "ws" if _model_uses_ws(model) else "http"


# ── DeepSeek 语音（官方全家桶 API 的 ASR / TTS 独立接口）─────────────────
# 地址固定为官方入口（与 DashScope 一样「地址固定、只填 api-key」）。
# 调用协议是 http（整段上传 / 一次性返回），端点 POST /v1/tools/{asr,tts} 属于接口路径，
# 不是协议名——协议口径统一为 http / ws / http-async，不带厂商名。
DEEPSEEK_BASE = "https://api.deepseek.com"


def _deepseek_key(kind: str) -> str:
    """取 DeepSeek api-key：优先 STT_/TTS_ 各自的，其次共用的 DEEPSEEK_API_KEY。"""
    return (
        (config_value(f"{kind}_DEEPSEEK_API_KEY") or "").strip()
        or (config_value("DEEPSEEK_API_KEY") or "").strip()
    )


async def deepseek_tts_bytes(text: str, voice: str, key: str) -> bytes:
    """DeepSeek 官方 TTS：返回 24kHz / 16bit / 单声道 PCM，包成 WAV 交给上层。

    失败抛 RuntimeError，由调用方转 502——已选 DeepSeek 就如实报错，不回落内置。
    """
    if not key:
        raise RuntimeError("DeepSeek TTS 未配置 api-key（设置页填 TTS_DEEPSEEK_API_KEY）")
    payload: dict[str, Any] = {"text": text, "format": "pcm"}
    if voice:
        payload["voice_id"] = voice
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            DEEPSEEK_BASE + "/v1/tools/tts",
            json=payload,
            headers={"Authorization": f"Bearer {key}"},
        )
    if r.status_code >= 400:
        raise RuntimeError(f"DeepSeek TTS 失败（{r.status_code}）: {r.text[:200]}")
    if not r.content:
        raise RuntimeError("DeepSeek TTS 已响应但没有音频数据")
    return pcm16_to_wav(r.content, 24000)


async def deepseek_asr_text(audio: bytes, key: str) -> str:
    """DeepSeek 官方 ASR：multipart 上传整段音频，返回识别文本（不支持流式）。"""
    if not key:
        raise RuntimeError("DeepSeek ASR 未配置 api-key（设置页填 STT_DEEPSEEK_API_KEY）")
    if audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        raise ValueError("DeepSeek ASR 只接受 16 位 PCM WAV（网关上行会补 WAV 头）")
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(
            DEEPSEEK_BASE + "/v1/tools/asr",
            headers={"Authorization": f"Bearer {key}"},
            files={"file": ("audio.wav", audio, "audio/wav")},
        )
    if r.status_code >= 400:
        raise RuntimeError(f"DeepSeek ASR 失败（{r.status_code}）: {r.text[:200]}")
    try:
        return (r.json().get("text") or "").strip()
    except ValueError as exc:
        raise RuntimeError(f"DeepSeek ASR 返回无法解析: {r.text[:150]}") from exc


def _deepseek_default_model(kind: str) -> str:
    """DeepSeek 官方 ASR/TTS 没有模型参数，这里给目录里的模型名做占位。"""
    return voice_db.default_speech_model(kind, "deepseek") or (
        "deepseek-asr" if kind == "stt" else "deepseek-tts"
    )


def _deepseek_voice(voice: str, model: str) -> str:
    """音色必须属于 DeepSeek 目录（stella / tide），否则回退该模型的默认音色。"""
    v = (voice or "").strip()
    known = {x["id"] for x in voice_db.list_voices("deepseek")}
    if v and (not known or v in known):
        return v
    return voice_db.default_voice("deepseek", model or "deepseek-tts") or "stella"


def pcm16_to_wav(pcm: bytes, sample_rate: int = TTS_SAMPLE_RATE) -> bytes:
    """WS 实时合成返回裸 s16le PCM 帧，包成 WAV 供播放器与后续转码使用。"""
    if pcm[:4] == b"RIFF" and pcm[8:12] == b"WAVE":
        return pcm
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def is_edge_voice(voice: str) -> bool:
    """音色是否属于内置 edge-tts 目录（与 DashScope 音色体系不通用）。"""
    return any(v.get("id") == voice for v in VOICE_CATALOG)


async def stt_upstream_test(model_override: str | None = None, provider: str = "") -> dict:
    """管理面板 ASR 行点「测试可用」：真识别一次样例语音（与正式转发同源）。

    provider 为空时按 DashScope 行测（历史行为）；传 deepseek 则测 DeepSeek 官方 ASR。
    """
    b64_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "asr_sample.b64")
    audio = base64.b64decode(open(b64_path, encoding="utf-8").read().strip())
    if (provider or "").strip().lower() == "deepseek":
        try:
            text = await deepseek_asr_text(audio, _deepseek_key("STT"))
            return ({"ok": True, "message": f"识别成功：{text[:60]}"} if text
                    else {"ok": True, "message": "DeepSeek 已响应（空文本）"})
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": str(exc)[:200]}
    base = (config_value("STT_UPSTREAM_BASE_URL") or "").strip() or "https://dashscope.aliyuncs.com"
    model = (model_override or "").strip() or (config_value("STT_UPSTREAM_MODEL") or "").strip()
    if not model:
        return {"ok": False, "message": "请先在 DashScope 行刷新模型并勾选（STT_UPSTREAM_MODEL）"}
    key = (config_value("STT_UPSTREAM_API_KEY") or "").strip() or (
        config_value("TTS_UPSTREAM_API_KEY") or ""
    ).strip()
    is_dashscope = "dashscope.aliyuncs.com" in base
    try:
        if is_dashscope and _model_uses_ws(model):
            text = await _ws_asr_test(base, key, model, audio, audio_fmt(audio))
        elif is_dashscope:
            text = await dashscope_asr_text(base, key, model, audio, audio_fmt(audio))
        else:
            text = await forward_transcriptions_openai(audio, "a.mp3", "audio/mpeg", model)
        return ({"ok": True, "message": f"识别成功：{text[:60]}"} if text
                else {"ok": True, "message": "上游已响应（空文本）"})
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": str(exc)[:200]}


async def tts_upstream_test(model_override: str | None = None, provider: str = "") -> dict:
    """管理面板 TTS 行点「测试可用」：真合成一句验证上游 TTS（与正式转发同源）。

    provider 为空时按 DashScope 行测（历史行为）；传 deepseek 则测 DeepSeek 官方 TTS。
    """
    if (provider or "").strip().lower() == "deepseek":
        try:
            m = (model_override or "").strip() or _deepseek_default_model("tts")
            voice = _deepseek_voice("", m)
            raw = await deepseek_tts_bytes("你好，语音合成测试。", voice, _deepseek_key("TTS"))
            return {"ok": True, "message": f"合成成功（{m} / {voice}，{len(raw)} 字节音频）"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": str(exc)[:200]}
    base = (config_value("TTS_UPSTREAM_BASE_URL") or "").strip() or "https://dashscope.aliyuncs.com"
    model = (model_override or "").strip() or (config_value("TTS_UPSTREAM_MODEL") or "").strip()
    if not model:
        return {"ok": False, "message": "请先在 DashScope 行刷新模型并勾选（TTS_UPSTREAM_MODEL）"}
    key = (config_value("TTS_UPSTREAM_API_KEY") or "").strip()
    is_dashscope = "dashscope.aliyuncs.com" in base
    try:
        if is_dashscope and _model_uses_ws(model):
            raw = await _ws_tts_test(base, key, model, "你好，语音合成测试。", _dashscope_default_voice(model))
        elif is_dashscope:
            raw = await dashscope_tts_bytes(base, key, model, "你好，语音合成测试。", _dashscope_default_voice(model))
        else:
            voice = (config_value("TTS_VOICE") or "").strip() or resolve_voice("")
            raw = await forward_speech_openai("你好，语音合成测试。", voice, 1.0, "wav", model)
        return {"ok": True, "message": f"合成成功（{model}，{len(raw)} 字节音频）"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": str(exc)[:200]}


def _dashscope_default_voice(model: str) -> str:
    """按模型族给一个官方默认音色（音色必须属于所选模型，否则云端 418）。

    音色与模型绑定（官方音色列表 model-studio/cosyvoice-voice-list）：
    cosyvoice-v3 系用 *_v3/longanyang 等 v3 音色；v2 用 *_v2；v1 用无后缀。
    """
    m = (model or "").lower()
    if m.startswith("cosyvoice-v3"):
        return "longanyang"          # v3 标杆音色（龙安洋，v3 系通用）
    if m.startswith("cosyvoice-v2"):
        return "longxiaochun_v2"
    if m.startswith("cosyvoice"):
        return "longxiaochun"
    return "Cherry"


async def dashscope_tts_bytes(base: str, key: str, model: str, text: str, voice: str) -> bytes:
    """DashScope 官方 HTTP 合成：multimodal-generation → 响应带 OSS 音频 URL → 下载。

    返回音频原始字节（wav）。失败抛 RuntimeError，由调用方转 502。
    """
    url = base.rstrip("/") + "/api/v1/services/aigc/multimodal-generation/generation"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(url, headers=headers, json={
            "model": model, "input": {"text": text, "voice": voice},
        })
        if r.status_code >= 400:
            raise RuntimeError(f"DashScope TTS 失败（{r.status_code}）: {r.text[:200]}")
        audio_url = ((r.json().get("output") or {}).get("audio") or {}).get("url") or ""
        if not audio_url:
            raise RuntimeError(f"DashScope TTS 已响应但没有音频 URL: {r.text[:150]}")
        dl = await client.get(audio_url, timeout=30)
        if dl.status_code >= 400 or not dl.content:
            raise RuntimeError(f"DashScope 音频下载失败（{dl.status_code}）")
        return dl.content


async def dashscope_asr_text(base: str, key: str, model: str, audio: bytes, fmt: str) -> str:
    """DashScope 识别：OpenAI 兼容 chat + input_audio（base64 data URL 直传，免上传）。

    返回识别文本。失败抛 RuntimeError，由调用方转 502。
    """
    url = base.rstrip("/") + "/compatible-mode/v1/chat/completions"
    audio_b64 = base64.b64encode(audio).decode()
    # qwen3-asr 系吃 data URL；qwen-audio 系要 data/format 分开的 base64
    if model.lower().startswith("qwen-audio"):
        audio_part = {"type": "input_audio", "input_audio": {"data": audio_b64, "format": fmt}}
    else:
        audio_part = {"type": "input_audio", "input_audio": {"data": f"data:audio/{fmt};base64,{audio_b64}"}}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(url, headers=headers, json={
            "model": model, "messages": [{"role": "user", "content": [audio_part]}],
        })
        if r.status_code >= 400:
            raise RuntimeError(f"DashScope ASR 失败（{r.status_code}）: {r.text[:200]}")
        return ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""


def audio_fmt(payload: bytes) -> str:
    """按魔数探测音频格式（dashscope input_audio 的 format 字段用）。"""
    if payload[:4] == b"RIFF" and payload[8:12] == b"WAVE":
        return "wav"
    if payload[:3] == b"ID3":
        return "mp3"
    return "wav"


async def _tts_synthesize(
    text: str, voice: str, rate: str, fmt: str,
    tts_provider: str, protocol: str, upstream_model: str, speed: float = 1.0,
) -> tuple[bytes, str]:
    """合成核心：根据 provider / protocol / model 调对应引擎，返回 (音频字节, media_type)。

    抽出自 /voice/v1/audio/speech 路由（OpenAI 形状）与 WS /voice/ws/inference 共用，
    避免两套重复逻辑。
    """
    if tts_provider == "deepseek":
        # DeepSeek 只有 stella / tide 两个音色，且没有语速参数（speed 忽略）
        raw = await deepseek_tts_bytes(
            text, _deepseek_voice(voice, upstream_model), _deepseek_key("TTS")
        )
        if fmt == "wav":
            return raw, "audio/wav"
        return transcode_mp3(raw, fmt)
    if tts_provider == "dashscope":
        # DashScope 音色体系与 edge-tts 不通用：传来的 edge 目录音色视为「未指定」，
        # 按模型族回退官方默认音色（否则云端 418 Invalid voice）。
        ds_voice = (voice or "").strip()
        if not ds_voice or is_edge_voice(ds_voice):
            ds_voice = _dashscope_default_voice(upstream_model)
        key = (config_value("TTS_UPSTREAM_API_KEY") or "").strip()
        base = (config_value("TTS_UPSTREAM_BASE_URL") or "").strip() or "https://dashscope.aliyuncs.com"
        if protocol == "ws":
            raw = pcm16_to_wav(await _ws_tts_test(base, key, upstream_model, text, ds_voice))
        else:
            raw = await dashscope_tts_bytes(base, key, upstream_model, text, ds_voice)
        if fmt == "wav":
            return raw, "audio/wav"
        return transcode_mp3(raw, fmt)
    if tts_provider == "openai_audio":
        raw = await forward_speech_openai(text, voice, speed, fmt, upstream_model)
        if fmt == "mp3":
            return raw, "audio/mpeg"
        return transcode_mp3(raw, fmt)
    # 内置：本地 edge-tts
    mp3 = await synthesize_edge_mp3(text, voice, rate)
    if fmt == "mp3":
        return mp3, "audio/mpeg"
    return transcode_mp3(mp3, fmt)


async def _asr_recognize(
    payload: bytes, filename: str, content_type: str,
    stt_provider: str, protocol: str, model: str, language: str = "",
) -> tuple[str, float, str]:
    """识别核心：返回 (文本, 时长秒, 语种)。失败抛异常，由调用方决定 4xx / 5xx。

    - 客户端错误（不支持的格式 / 协议）抛 ValueError → 调用方转 400；
    - 引擎 / 上游失败抛 RuntimeError → 调用方转 502（内置未就绪转 503）。
    抽出自 transcriptions() 路由（OpenAI 形状）与 WS /voice/ws/inference 共用。
    注意：当前 ASR 引擎（SenseVoice / Paraformer）只做识别不清翻译，translations 也走这里，
    返回的是识别原文而非英文翻译（详见 translations 路由说明）。
    """
    if stt_provider == "builtin":
        # 本地 SenseVoice 只认 WAV：直接交给它只会得到空文本，先挡掉非 WAV。
        if payload[:4] != b"RIFF" or payload[8:12] != b"WAVE":
            raise ValueError("只支持 WAV 音频（网关上行会补 WAV 头）")
        text, duration, lang = await asyncio.to_thread(transcribe_sensevoice, payload, language)
        return text, duration, lang
    if stt_provider == "deepseek":
        # 官方 ASR 是整段上传（≤120s），没有 model / 语种参数，语种自动识别
        text = await deepseek_asr_text(payload, _deepseek_key("STT"))
        return text, 0.0, ""
    upstream_model = (model or "").strip()
    if not upstream_model:
        raise RuntimeError("已选择上游 ASR，请在请求里带 model 或配置 STT_UPSTREAM_MODEL")
    if protocol not in ("http", "ws", "http-async"):
        raise ValueError(f"不支持的协议 {protocol!r}（可用 http / ws / http-async）")
    if protocol == "http-async":
        raise ValueError("http-async 是录音文件异步转写协议，实时识别接口不支持（需公网 URL 提交+轮询）")
    key = (config_value("STT_UPSTREAM_API_KEY") or "").strip() or (
        config_value("TTS_UPSTREAM_API_KEY") or ""
    ).strip()
    base = (config_value("STT_UPSTREAM_BASE_URL") or "").strip() or "https://dashscope.aliyuncs.com"
    if stt_provider == "dashscope":
        if protocol == "ws":
            text = await _ws_asr_test(base, key, upstream_model, payload, audio_fmt(payload))
        else:
            text = await dashscope_asr_text(base, key, upstream_model, payload, audio_fmt(payload))
    else:
        text = await forward_transcriptions_openai(payload, filename, content_type, upstream_model)
    return text, 0.0, ""


def _asr_response(text: str, response_format: str, duration: float = 0.0, language: str = "") -> Any:
    """把识别文本按 OpenAI 形状格式化（transcriptions / translations 共用）。"""
    if response_format == "text":
        return Response(content=text, media_type="text/plain; charset=utf-8")
    if response_format == "verbose_json":
        return {
            "task": "transcribe",
            "language": language,
            "duration": duration,
            "text": text,
            "segments": (
                [{"id": 0, "start": 0.0, "end": duration, "text": text}]
                if text
                else []
            ),
        }
    return {"text": text}


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
    # 底部测试页可显式覆盖默认提供商/协议；不传则完全沿用 DB 配置，行为不变。
    tts_provider = (body.provider or "").strip().lower() or (
        config_value("TTS_PROVIDER", "builtin") or "builtin"
    ).strip().lower()
    upstream_model = ""
    if tts_provider == "builtin":
        # 内置模式：model 可为空，但传了必须是有效模型——传错直接拒绝，不静默吞掉。
        requested = (body.model or "").strip()
        if requested and requested not in BUILTIN_TTS_MODELS:
            return error_response(
                400,
                f"内置 TTS 模型只有 {'/'.join(sorted(BUILTIN_TTS_MODELS))}，收到 {requested!r}；"
                "如需其它模型请配置上游（TTS_PROVIDER）",
            )
    else:
        # 上游模式：model 优先取请求参数，缺省回退 TTS_UPSTREAM_MODEL 配置
        upstream_model = (body.model or "").strip() or (
            config_value("TTS_UPSTREAM_MODEL") or ""
        ).strip()
        if not upstream_model:
            return error_response(
                400,
                "已选择上游 TTS（dashscope），请在请求里带 model 或配置 TTS_UPSTREAM_MODEL",
            )
    protocol = resolve_voice_protocol(body.protocol, upstream_model, tts_provider)
    if protocol not in ("http", "ws", "http-async"):
        return error_response(400, f"不支持的协议 {protocol!r}（可用 http / ws / http-async）")
    if protocol == "http-async":
        return error_response(400, "http-async 是录音文件异步转写协议，实时合成接口不支持")
    if tts_provider == "builtin" and protocol != "http":
        return error_response(400, "内置 TTS 为本地合成，只支持 http 协议")
    cache_key = (tts_provider, protocol, upstream_model, text, voice, rate, fmt)
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
        audio, media_type = await _tts_synthesize(
            text, voice, rate, fmt, tts_provider, protocol, upstream_model, body.speed
        )
    except Exception as exc:  # noqa: BLE001
        # 这里不抛 500：网关遇到 4xx/5xx 会自己回退静音，会话不中断。
        return error_response(502, str(exc))

    tts_cache.put(cache_key, audio)
    return Response(
        content=audio, media_type=media_type, headers={"X-TTS-Cache": "miss"}
    )


@app.get("/voice/v1/audio/voices")
async def list_voices(provider: str = "", model: str = ""):
    """对外公开的可选音色目录（无需鉴权），供客户端下拉框与第三方调用方拉取。

    可选查询参数：
    - provider：TTS 提供商（builtin / openai_audio，openai_audio 归为 dashscope）；不传用配置默认。
    - model：TTS 模型；不传用该 provider 的默认模型。
    两者都不传时即「默认提供商 + 默认模型」。音色目录来自本地 SQLite 的 voices 表（表维护）。

    返回 {default, provider, model, voices:[{id, provider, model, desc_zh, desc_en, is_default}]}，
    与 /voice/v1/audio/speech 的 voice 字段对齐；default 为该 provider+model 的默认音色。
    """
    prov = (provider or "").strip().lower() or (
        config_value("TTS_PROVIDER", "builtin") or "builtin"
    ).strip().lower()
    if prov in ("openai_audio", "dashscope"):
        prov_key = "dashscope"
    elif prov == "deepseek":
        prov_key = "deepseek"
    else:
        prov_key = "builtin"
    mdl = (model or "").strip()
    voices = voice_db.list_voices(prov_key, mdl or None)
    if not voices:  # 模型名不匹配 / 未传 → 退回该 provider 全部音色
        voices = voice_db.list_voices(prov_key, None)
    # 回显的 model 与真实返回的音色对齐（请求的模型若不在目录里，用目录里的模型）
    if voices and (not mdl or not any(v["model"] == mdl for v in voices)):
        mdl = voices[0]["model"]
    if not voices:  # DB 尚未播种等极端情况：退回内置硬编码目录
        voices = [
            {"id": v["id"], "provider": "builtin", "model": "edge-tts",
             "desc_zh": v.get("desc_zh", ""), "desc_en": v.get("desc_en", ""),
             "is_default": v["id"] == tts_voice()}
            for v in VOICE_CATALOG
        ]
        mdl = mdl or "edge-tts"
    default_id = next((v["id"] for v in voices if v.get("is_default")), None)
    if not default_id and prov_key == "builtin":
        default_id = tts_voice()
    if not default_id and voices:
        default_id = voices[0]["id"]
    return {
        "default": default_id or tts_voice(),
        "provider": prov_key,
        "model": mdl,
        "protocol": voice_db.model_protocol("tts", prov_key, mdl),
        "voices": [
            {
                "id": v["id"],
                "provider": v["provider"],
                "model": v["model"],
                "desc_zh": v.get("desc_zh") or "",
                "desc_en": v.get("desc_en") or "",
                "is_default": bool(v.get("is_default")),
            }
            for v in voices
        ],
    }


async def forward_transcriptions_openai(
    payload: bytes, filename: str, content_type: str, model: str
) -> str:
    """STT_PROVIDER=openai_audio 时把转写请求转发到 OpenAI 兼容上游。

    返回识别文本（取响应 JSON 的 text 字段）。失败抛 RuntimeError，由调用方转 502
    ——已选上游就如实报错，不回落内置。
    """
    base = (config_value("STT_UPSTREAM_BASE_URL") or "").strip() or "https://dashscope.aliyuncs.com"
    key = (config_value("STT_UPSTREAM_API_KEY") or "").strip()
    url = _openai_audio_url(base, "/audio/transcriptions")
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    files = {"file": (filename, payload, content_type or "audio/wav")}
    data = {"model": model}
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(url, files=files, data=data, headers=headers)
    if r.status_code >= 400:
        raise RuntimeError(f"上游 ASR 失败（{r.status_code}）: {r.text[:200]}")
    try:
        return (r.json().get("text") or "").strip()
    except ValueError:
        raise RuntimeError(f"上游 ASR 响应不是 JSON: {r.text[:200]}")


@app.post("/voice/v1/audio/transcriptions")
async def transcriptions(
    request: Request,
    file: UploadFile = File(...),
    model: str = Form("sensevoice-small"),
    language: str = Form(""),
    response_format: str = Form("json"),
    temperature: float = Form(0.0),
    provider: str = Form(""),
    protocol: str = Form(""),
):
    """OpenAI 兼容的语音转写；网关只会提交 16k / 16bit / 单声道 WAV。

    provider / protocol 只用于底部测试页显式覆盖默认路由；不传则沿用 DB 配置。
    """
    payload = await file.read()
    if not payload:
        return error_response(400, "上传的音频为空")

    stt_provider = (provider or "").strip().lower() or (
        config_value("STT_PROVIDER", "builtin") or "builtin"
    ).strip().lower()
    upstream_model = ""
    proto = (protocol or "").strip().lower()
    if stt_provider == "deepseek":
        # DeepSeek 官方 ASR 是整段上传，没有模型 / 协议可选
        upstream_model = (model or "").strip() or _deepseek_default_model("stt")
        proto = proto or "http"
    elif stt_provider == "builtin":
        # 内置模式：model 可为空/默认值，但传了别的（如上游模型名）直接拒绝——不静默吞掉。
        requested = (model or "").strip()
        if requested and requested not in BUILTIN_STT_MODELS:
            return error_response(
                400,
                f"内置 ASR 模型只有 {'/'.join(sorted(BUILTIN_STT_MODELS))}，收到 {requested!r}；"
                "如需其它模型请配置上游（STT_PROVIDER）",
            )
        if proto in ("ws", "http-async"):
            return error_response(400, f"内置 ASR 为本地推理，只支持 http 协议（收到 {proto}）")
        if not proto:
            proto = "http"
    else:
        # 上游模式：model 优先取请求参数，缺省回退 STT_UPSTREAM_MODEL 配置；
        # 不做 WAV 前置校验（上游接受 mp3/wav 等，网关上行仍是 16k WAV）。
        upstream_model = (model or "").strip()
        if upstream_model in ("", "sensevoice-small"):
            upstream_model = (config_value("STT_UPSTREAM_MODEL") or "").strip()
        if not proto:
            proto = resolve_voice_protocol(protocol, upstream_model, stt_provider)

    try:
        text, duration, lang = await _asr_recognize(
            payload,
            file.filename or "audio.wav",
            file.content_type or "audio/wav",
            stt_provider,
            proto,
            upstream_model,
            language,
        )
    except ValueError as exc:  # 客户端错误（格式 / 协议）→ 400
        return error_response(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        # 模型没下载 → 503（重试安装有意义）；模型在但推理失败 / 上游失败 → 502。
        status = 503 if (stt_provider == "builtin" and not sensevoice_ready()) else 502
        return error_response(status, f"转写失败: {exc}")

    return _asr_response(text, response_format, duration, lang)


def _lang_matches(lang: str, target_lang: str) -> bool:
    """粗略判断识别语种是否与目标语种一致，一致则无需翻译（避免无意义翻译）。

    只做保守判定：目标为英语且识别语种也像英语时才算一致；其余一律认为不一致、
    需要翻译，宁可多翻译一次也不漏翻。
    """
    target_is_en = ("en" in (target_lang or "").lower()) or ("英" in (target_lang or ""))
    lang_l = (lang or "").lower()
    if target_is_en and (lang_l.startswith("en") or lang in ("英语", "english")):
        return True
    return False


async def _translate_text(text: str, target_lang: str) -> tuple[str | None, str | None]:
    """把文本翻译成目标语言；返回 (译文, 错误信息)。无 LLM 上游或上游失败返回 (None, 错误)。

    走本地 LLM 代理的选路（upstream_pool.pick + llm_protocols.prepare），复用对话路由的
    协议翻译，不重复实现；不需要知道服务自身的 host/port。
    """
    if not llm_enabled():
        return None, "翻译需要 LLM 上游，当前未启用（请在 voice.conf 配置 LLM_UPSTREAM_BASE_URL）"
    entry = upstream_pool.pick("LLM")
    if entry is None:
        return None, "翻译需要 LLM 上游，当前未配置可用提供商"
    protocol = entry["protocol"] or "openai_chat_completions"
    api_version = llm_api_version()
    model = entry.get("model") or llm_model_override() or ""
    body = {
        "messages": [
            {
                "role": "system",
                "content": (
                    f"你是一个翻译助手。请把用户发来的文本翻译成{target_lang}，"
                    "只输出译文本身，不要任何解释、引号或多余文字。"
                ),
            },
            {"role": "user", "content": text},
        ],
        "stream": False,
    }
    req, _, transform = llm_protocols.prepare(
        protocol, entry["base_url"], entry["api_key"], model, api_version, body, entry.get("vendor")
    )
    try:
        async with httpx.AsyncClient(timeout=upstream_timeout()) as client:
            r = await client.post(req.url, headers=req.headers, json=req.payload)
    except httpx.HTTPError as exc:
        return None, f"翻译上游请求失败: {exc}"
    if r.status_code >= 400:
        return None, f"翻译上游失败（{r.status_code}）: {upstream_error(r)}"
    try:
        data = r.json()
    except ValueError:
        return None, "翻译上游返回的不是 JSON"
    data = transform(data)
    content = (data.get("choices", [{}])[0].get("message", {}).get("content", "") or "").strip()
    return content, None


@app.post("/voice/v1/audio/translations")
async def translations(
    request: Request,
    file: UploadFile = File(...),
    model: str = Form("sensevoice-small"),
    response_format: str = Form("json"),
    temperature: float = Form(0.0),
    provider: str = Form(""),
    protocol: str = Form(""),
    target_lang: str = Form("英语"),
):
    """OpenAI 兼容的语音翻译：任意语言音频 → 目标语言文本（默认英语）。

    实现：先 ASR 识别原文，再把原文交给 LLM 代理翻译成目标语言（复用 /llm/v1/chat/completions
    的路由与协议翻译，不重复实现）。没有 LLM 上游时，如实返回 503，不把识别原文冒充翻译。
    """
    payload = await file.read()
    if not payload:
        return error_response(400, "上传的音频为空")

    stt_provider = (provider or "").strip().lower() or (
        config_value("STT_PROVIDER", "builtin") or "builtin"
    ).strip().lower()
    upstream_model = ""
    proto = (protocol or "").strip().lower()
    if stt_provider == "deepseek":
        upstream_model = (model or "").strip() or _deepseek_default_model("stt")
        proto = proto or "http"
    elif stt_provider == "builtin":
        if proto in ("ws", "http-async"):
            return error_response(400, f"内置 ASR 为本地推理，只支持 http 协议（收到 {proto}）")
        if not proto:
            proto = "http"
    else:
        upstream_model = (model or "").strip()
        if upstream_model in ("", "sensevoice-small"):
            upstream_model = (config_value("STT_UPSTREAM_MODEL") or "").strip()
        if not proto:
            proto = resolve_voice_protocol(protocol, upstream_model, stt_provider)
    try:
        text, duration, lang = await _asr_recognize(
            payload,
            file.filename or "audio.wav",
            file.content_type or "audio/wav",
            stt_provider,
            proto,
            upstream_model,
            "",
        )
    except ValueError as exc:
        return error_response(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        status = 503 if (stt_provider == "builtin" and not sensevoice_ready()) else 502
        return error_response(status, f"识别失败: {exc}")

    # 翻译：交给 LLM 上游。识别原文即目标语言时不调用，直接透传（避免无意义翻译）。
    if text and not _lang_matches(lang, target_lang):
        translated, err = await _translate_text(text, target_lang)
        if err:
            # 诚实：翻译不可用就如实说，绝把识别原文冒充翻译。
            return error_response(503, err)
        text = translated or text

    if response_format == "text":
        return Response(content=text, media_type="text/plain; charset=utf-8")
    if response_format == "verbose_json":
        return _asr_response(text, "verbose_json", duration, lang)
    return {"text": text}


# ── WebSocket 实时接口（/voice/ws，与 /voice/v1 平行，区分 WS 与 HTTP） ──
# 一个入口靠 payload.task 区分 asr / tts，协议复用 DashScope 的
# run-task / continue-task / finish-task + 二进制帧；上游为 dashscope 时由
# _asr_recognize / _tts_synthesize 内部转发到 DashScope WS（真流式），
# 内置（SenseVoice / edge-tts）为本地批处理，按同一协议形状回一个结果块。


def _ws_client_ip(websocket: WebSocket) -> str:
    return websocket.client.host if websocket.client else ""


def _ws_auth_ok(websocket: WebSocket, path: str) -> bool:
    """WS 握手阶段鉴权：与 HTTP 安全中间件同逻辑（IP 白名单 + API-Key），默认都关闭。"""
    allow = _parse_ip_allow()
    if allow:
        ip = _ws_client_ip(websocket)
        if not is_loopback(ip) and not ip_allowed(ip, allow):
            return False
    if (
        api_key_auth_enabled()
        and _path_needs_api_key(path)
        and not admin_panel.valid_session(websocket.cookies.get(admin_panel.SESSION_COOKIE))
    ):
        keys = resolve_api_keys()
        if keys:
            token = _bearer_token(websocket.headers.get("authorization")) or (
                websocket.query_params.get("api_key") or ""
            )
            if not (
                token
                and any(
                    hmac.compare_digest(token.encode("utf-8"), k.encode("utf-8")) for k in keys
                )
            ):
                return False
    return True


async def _ws_send_fail(websocket: WebSocket, task_id: str | None, message: str) -> None:
    try:
        await websocket.send_text(json.dumps({
            "header": {
                "action": "task-failed",
                "task_id": task_id,
                "error_code": "INVALID_REQUEST",
                "error_message": message,
            },
            "payload": {},
        }))
    except Exception:  # noqa: BLE001
        pass


def _ws_safe_json(text: str | None) -> dict | None:
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


async def _ws_handle_asr(websocket: WebSocket, task_id: str, model: str, payload: dict) -> bool:
    """ASR 子流程：收二进制音频 + finish-task，识别后回 result-generated + task-finished。"""
    stt_provider = (config_value("STT_PROVIDER", "builtin") or "builtin").strip().lower()
    upstream_model = ""
    proto = "http"
    if stt_provider == "deepseek":
        # DeepSeek ASR 没有模型参数，用目录里的模型名占位即可
        upstream_model = (model or "").strip() or _deepseek_default_model("stt")
    elif stt_provider != "builtin":
        upstream_model = (model or "").strip() or (config_value("STT_UPSTREAM_MODEL") or "").strip()
        if not upstream_model:
            await _ws_send_fail(websocket, task_id, "dashscope ASR 需要 model 或配置 STT_UPSTREAM_MODEL")
            return False
        proto = "ws" if _model_uses_ws(upstream_model) else "http"
    else:
        # 内置模式只认内置模型；传了上游（尤其 ws）模型属于「模型与提供商对不上」，直接报错，
        # 不让它静默落到 SenseVoice（识别不出还误导用户以为测的是上游模型）。
        if (model or "").strip() and (model or "").strip() not in BUILTIN_STT_MODELS:
            await _ws_send_fail(
                websocket, task_id,
                f"模型 {model} 是上游模型，但当前 STT_PROVIDER=builtin（内置模式）；"
                f"请在测试页选择内置模型，或先配置上游提供商再测 ws。",
            )
            return False
    fmt = ((payload.get("parameters") or {}).get("format") or "wav").strip().lower()

    audio = bytearray()
    while True:
        msg = await websocket.receive()
        if msg["type"] == "websocket.disconnect":
            return False
        if msg.get("bytes") is not None:
            audio.extend(msg["bytes"])
        else:
            d = _ws_safe_json(msg.get("text"))
            if d is None:
                continue
            act = ((d.get("header") or {}).get("action") or "").lower()
            if act == "finish-task":
                break
            # 其它控制消息（如 ping）忽略
    # 内置 SenseVoice 只认 WAV（与 HTTP 内置接口一致）；非 WAV 直接拒，不把垃圾喂给识别引擎。
    audio_bytes = bytes(audio)
    if stt_provider == "builtin" and not (
        audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE"
    ):
        await _ws_send_fail(websocket, task_id, "内置 ASR 只支持 WAV 音频（网关上行会补 WAV 头）")
        return False

    try:
        text, _duration, _lang = await _asr_recognize(
            audio_bytes, "audio.wav", f"audio/{fmt}", stt_provider, proto, upstream_model, ""
        )
    except ValueError as exc:
        await _ws_send_fail(websocket, task_id, str(exc))
        return False
    except Exception as exc:  # noqa: BLE001
        status = 503 if (stt_provider == "builtin" and not sensevoice_ready()) else 502
        await _ws_send_fail(websocket, task_id, f"ASR 失败: {exc}" if status != 503 else "SenseVoice 模型未就绪")
        return False
    await websocket.send_text(json.dumps({
        "header": {"action": "result-generated", "task_id": task_id},
        "payload": {"output": {"sentence": {"text": text}, "task_id": task_id}},
    }))
    await websocket.send_text(json.dumps({
        "header": {"action": "task-finished", "task_id": task_id},
        "payload": {"output": {}},
    }))
    return True


async def _ws_handle_tts(websocket: WebSocket, task_id: str, model: str, payload: dict) -> bool:
    """TTS 子流程：收 continue-task(文本) + finish-task，合成后回二进制音频 + task-finished。"""
    tts_provider = (config_value("TTS_PROVIDER", "builtin") or "builtin").strip().lower()
    upstream_model = ""
    if tts_provider == "deepseek":
        upstream_model = (model or "").strip() or _deepseek_default_model("tts")
    elif tts_provider != "builtin":
        upstream_model = (model or "").strip() or (config_value("TTS_UPSTREAM_MODEL") or "").strip()
        if not upstream_model:
            await _ws_send_fail(websocket, task_id, "dashscope TTS 需要 model 或配置 TTS_UPSTREAM_MODEL")
            return False
    else:
        # 内置模式只认内置模型；传了上游（尤其 ws）模型属于「模型与提供商对不上」，直接报错。
        if (model or "").strip() and (model or "").strip() not in BUILTIN_TTS_MODELS:
            await _ws_send_fail(
                websocket, task_id,
                f"模型 {model} 是上游模型，但当前 TTS_PROVIDER=builtin（内置模式）；"
                f"请在测试页选择内置模型，或先配置上游提供商再测 ws。",
            )
            return False
    proto = "ws" if _model_uses_ws(upstream_model) else "http"

    text = ""
    finished = False
    while True:
        msg = await websocket.receive()
        if msg["type"] == "websocket.disconnect":
            return False
        if msg.get("bytes") is not None:
            continue
        d = _ws_safe_json(msg.get("text"))
        if d is None:
            continue
        h = d.get("header") or {}
        act = (h.get("action") or "").lower()
        if act == "continue-task":
            text = (((d.get("payload") or {}).get("input") or {}).get("text") or "").strip()
        elif act == "finish-task":
            finished = True
            break
    if not text:
        await _ws_send_fail(websocket, task_id, "TTS 未收到文本")
        return False
    ds_voice = ((payload.get("parameters") or {}).get("voice") or "").strip()
    try:
        audio, _mt = await _tts_synthesize(
            text, resolve_voice(ds_voice), tts_rate(1.0), "wav", tts_provider, proto, upstream_model
        )
    except Exception as exc:  # noqa: BLE001
        await _ws_send_fail(websocket, task_id, f"TTS 失败: {exc}")
        return False
    await websocket.send_bytes(audio)
    await websocket.send_text(json.dumps({
        "header": {"action": "task-finished", "task_id": task_id},
        "payload": {"output": {}},
    }))
    return True


@app.websocket("/voice/ws/inference")
async def ws_inference(websocket: WebSocket):
    """WebSocket 实时 ASR / TTS 统一入口（对外，DashScope 协议形状）。

    连接后客户端发 run-task（payload.task=asr|tts，model 仅上游模式生效）：
    - ASR：客户端随后发二进制音频帧、再发 finish-task；服务端回 result-generated + task-finished。
    - TTS：客户端随后发 continue-task（input.text）+ finish-task；服务端回二进制音频 + task-finished。
    协议/事件形状对齐 DashScope /api-ws/v1/inference，第三方换 base_url 即用；网关也走这里。
    """
    path = websocket.url.path
    if not _ws_auth_ok(websocket, path):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    task_id: str | None = None
    try:
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                break
            data = _ws_safe_json(msg.get("text"))
            if data is None:
                # 协议要求控制消息走 JSON；裸二进制只在子流程循环里处理
                continue
            header = data.get("header") or {}
            action = (header.get("action") or "").lower()
            if action == "run-task":
                task_id = header.get("task_id") or uuid.uuid4().hex
                pl = data.get("payload") or {}
                task = (pl.get("task") or "").lower()
                model = (pl.get("model") or "").strip()
                # 先校验 task 合法再回 task-started；非法直接 task-failed，不断连。
                if task not in ("asr", "tts"):
                    await _ws_send_fail(websocket, task_id, f"未知的 task: {task}（仅支持 asr / tts）")
                    continue
                await websocket.send_text(json.dumps({
                    "header": {
                        "action": "task-started",
                        "task_id": task_id,
                        "streaming": "duplex",
                    },
                    "payload": {"task": task, "function": pl.get("function", "")},
                }))
                # 子流程出错时已发过 task-failed；保持连接继续等下一个 run-task。
                if task == "tts":
                    await _ws_handle_tts(websocket, task_id, model, pl)
                else:
                    await _ws_handle_asr(websocket, task_id, model, pl)
            elif action in ("ping", "heartbeat"):
                await websocket.send_text(json.dumps({"header": {"action": "pong", "task_id": task_id}}))
            else:
                await _ws_send_fail(websocket, task_id, f"非预期的 action: {action}")
                continue
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        await _ws_send_fail(websocket, task_id, str(exc))


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
                    provider=e.get("vendor") or "",
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
    if llm_protocols.uses_ollama_native(protocol):
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
    # 管理面板「测试当前账号地址」：显式标志表示 base_url 是真实上游地址（可能尚未
    # 保存进配置池），原样直连、不做下面那步 /llm 补全——那是「按 URL 测代理实例」
    # 专用的，外部上游（如 https://api.deepseek.com）被补成 .../llm/v1/... 会 404。
    # 自身代理剥离仍保留，避免用户误把本代理地址填进账号地址时造成自转发递归。
    direct_upstream = body.get("direct_upstream") is True and bool(req_base_url)
    # 测试界面「按 URL 测试本代理（或其它实例）」：base_url 只填代理地址即可，
    # 自动补 /llm 前缀命中本代理的 OpenAI 兼容端点 /llm/v1/chat/completions；
    # 已带 /llm（如用户手填完整路径）则不重复追加。
    if req_base_url and not direct_upstream and "/llm" not in req_base_url:
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
    #
    # 例外：客户端/网关带了目录里没有的模型（例如网关占位默认 gpt-oss:120b-cloud），
    # 但配置了全局默认模型（LLM_UPSTREAM_MODEL）且该模型真实存在时，回落到默认模型，
    # 让本地代理用真实可用的模型接管，而不是一刀切 400 拒绝。这样网关不必硬编码
    # 业务侧的具体模型名，内置服务侧一处配好默认即可。
    if req_model and not body.get("bypass_catalog") and not req_base_url:
        catalog = llm_catalog()
        if catalog:
            v = model_catalog.validate(model_catalog.ModelType.LLM, catalog, req_model)
            if not v.valid:
                override_model = llm_model_override()
                if override_model and any(
                    e.get("model") == override_model
                    for e in upstream_pool.load_pool("LLM")
                ):
                    req_model = override_model
                else:
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
    # - 没带模型（只传提供商 / 都没传）：取「该提供商自己的默认模型」——默认模型
    #   是按提供商维度存的，每个提供商各有一个，不串到别的提供商；该提供商没设
    #   默认则退回其入口模型。
    override_model = llm_model_override()
    if req_model:
        effective_model = req_model
    else:
        vendor_models = [
            e.get("model") for e in upstream_pool.load_pool("LLM")
            if e.get("vendor") == entry.get("vendor") and e.get("model")
        ]
        provider_default = default_model_for_provider("LLM", entry.get("vendor") or "")
        effective_model = (
            provider_default if (provider_default in vendor_models) else
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


def _embed_cap() -> str:
    """嵌入优先用独立的 EMBED 上游池（与 LLM 数据独立、结构一致）；未配置则退回 LLM 池。

    这样嵌入和对话各自存各自的地址池，互不影响（改一个不会同步/覆盖另一个）。
    """
    try:
        if upstream_pool.load_pool("EMBED"):
            return "EMBED"
    except Exception:
        pass
    return "LLM"


@app.post("/llm/v1/embeddings")
async def embeddings(request: Request):
    """OpenAI 兼容嵌入（向量）接口：入站固定 OpenAI /v1/embeddings 格式，出站按上游
    线协议翻译。Embeddings 只支持非流式；Anthropic / OpenAI Responses 线协议没有向量
    接口，直接返回 501。

    路由、模型校验、多账号轮询逻辑与 /llm/v1/chat/completions 共用同一套入口选择。
    """
    if not llm_enabled():
        return llm_disabled_response()
    try:
        body = await request.json()
    except ValueError:
        return error_response(400, "请求体不是合法 JSON")
    if not isinstance(body, dict):
        return error_response(400, "请求体必须是 JSON 对象")

    req_model = body.get("model") if isinstance(body.get("model"), str) else None
    req_vendor = body.get("vendor") if isinstance(body.get("vendor"), str) else None
    req_protocol = body.get("protocol") if isinstance(body.get("protocol"), str) else None
    req_base_url = body.get("base_url") if isinstance(body.get("base_url"), str) else None
    direct_upstream = body.get("direct_upstream") is True and bool(req_base_url)
    if req_base_url and not direct_upstream and "/llm" not in req_base_url:
        req_base_url = req_base_url.rstrip("/") + "/llm"
    if req_base_url and _is_self_proxy_base(req_base_url):
        req_base_url = None
        body.pop("base_url", None)
        body.pop("api_key", None)

    # 不支持嵌入的线协议（Anthropic / OpenAI Responses）：它们没有向量接口。
    eff_wire = llm_protocols.normalize_protocol(req_protocol or "")
    if eff_wire in ("anthropic_messages", "openai_responses"):
        return error_response(501, f"所选线协议 {eff_wire} 不提供 embeddings 向量接口")

    # 嵌入模型（如 nomic-embed-text）通常不在对话模型目录里，目录校验会误杀；
    # 这里不按目录回退到默认对话模型（那会让 ollama 用 chat 模型去 embed 而 501），
    # 而是交给下方「上游模型存在性校验（404）」这一权威关卡——真实存在的模型放行，
    # 不存在的由上游报错或这里 404 拦截。bypass_catalog 仍生效（跳过下方存在性校验）。
    cap = _embed_cap()
    if req_base_url:
        entry = {
            "base_url": req_base_url,
            "api_key": (body.get("api_key") or "") if isinstance(body.get("api_key"), str) else "",
            "protocol": req_protocol or "openai_chat_completions",
            "model": req_model or "",
            "vendor": "",
        }
    else:
        if req_vendor:
            entry = upstream_pool.pick_by_vendor(cap, req_vendor)
        elif req_model:
            matched = [e for e in upstream_pool.load_pool(cap) if e.get("model") == req_model]
            if not matched:
                return error_response(
                    400,
                    f"模型 {req_model} 未在已配置的提供商中找到（请检查模型名或刷新模型列表）",
                )
            vendors = sorted({e.get("vendor") for e in matched})
            if len(vendors) > 1:
                default_vendor = (config_value(f"{cap}_UPSTREAM_VENDOR", "") or "").strip().lower()
                if not default_vendor or default_vendor not in vendors:
                    return error_response(
                        400,
                        f"模型 {req_model} 命中多个提供商 {vendors}，"
                        f"但未配置默认提供商或默认提供商不含该模型（{cap}_UPSTREAM_VENDOR）",
                    )
                target_vendor = default_vendor
            else:
                target_vendor = vendors[0]
            entry = upstream_pool.pick_by_vendor(cap, target_vendor)
        else:
            default_vendor = (config_value(f"{cap}_UPSTREAM_VENDOR", "") or "").strip().lower()
            entry = (upstream_pool.pick_by_vendor(cap, default_vendor)
                     if default_vendor else upstream_pool.pick_by_model(cap, None))
    if entry is None:
        return llm_disabled_response()

    # 计算生效模型：显式指定优先；否则取「该提供商自己的默认模型」（按提供商维度）。
    # 没配 → 如实报错（没有向量模型就不该静默成功）。
    if req_model:
        effective_model = req_model
    else:
        embed_model = default_model_for_provider(cap, entry.get("vendor") or "")
        if not embed_model:
            return error_response(
                400,
                f"未配置向量模型：请先在配置页为该提供商指定默认模型，"
                f"或在请求中显式传入 model 字段。",
            )
        effective_model = embed_model

    # 上游模型存在性校验（同 chat 路由）：生效模型必须确实在提供商目录里。
    # 模型一定要在提供商里面——既不校验本地聊天模型目录，也不默认放行；目录探不到（None）时才跳过，避免误杀。
    # bypass_catalog 可跳过；直连上游（direct_upstream）不涉及本地池，也不校验。
    if not body.get("bypass_catalog") and not req_base_url:
        try:
            upstream_models = await upstream_pool.list_provider_models(
                entry["base_url"], entry["api_key"],
                req_protocol or entry["protocol"] or "openai_chat_completions",
                entry.get("vendor"),
            )
        except Exception:
            upstream_models = None
        if upstream_models is not None and not any(
            m.lower() == effective_model.lower() for m in upstream_models
        ):
            return error_response(
                404,
                f"模型不存在：{effective_model}（该提供商未提供此模型，请检查名称或刷新模型列表）",
            )

    wire = llm_protocols.normalize_protocol(req_protocol or entry["protocol"] or "openai_chat_completions")
    if wire in ("anthropic_messages", "openai_responses"):
        return error_response(501, f"所选线协议 {wire} 不提供 embeddings 向量接口")

    req, resp_transform = llm_protocols.prepare_embeddings(
        req_protocol or entry["protocol"] or "openai_chat_completions",
        entry["base_url"], entry["api_key"], effective_model, llm_api_version(), body,
    )
    req.headers.update(extra_upstream_headers(request))
    req.headers["Accept-Encoding"] = "identity"

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
        return error_response(502, f"上游 LLM 失败（{response.status_code}）: {upstream_error(response)}")
    upstream_pool.mark_success("LLM", entry)
    try:
        data = response.json()
    except ValueError:
        return Response(content=response.content, status_code=response.status_code,
                        media_type=response.headers.get("content-type"))
    data = resp_transform(data)
    return Response(
        content=json.dumps(data, ensure_ascii=False).encode("utf-8"),
        status_code=200, media_type="application/json",
    )


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


def _ws_doc_markdown() -> str:
    """从 contracts/README.md 抽取 WS 章节原文，避免与契约文档漂移。"""
    readme = Path(__file__).resolve().parents[2] / "xiaoxiong-app" / "contracts" / "README.md"
    if not readme.exists():
        return "# WS 实时接口文档\n\n未找到 contracts/README.md（应为本仓库 xiaoxiong-app/contracts/README.md）。"
    text = readme.read_text(encoding="utf-8")
    lines = text.split("\n")
    start = next((i for i, ln in enumerate(lines) if ln.startswith("### 对外 WS 实时接口")), None)
    if start is None:
        return "# WS 实时接口文档\n\n未找到 WS 章节。"
    end = len(lines)
    for j in range(start + 1, len(lines)):
        # 遇到下一个任意级别的标题即结束：WS 章节内部的同级/下级标题不会误并入。
        if lines[j].startswith("#"):
            end = j
            break
    return "\n".join(lines[start:end])


def _md_esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _md_inline(s: str) -> str:
    s = _md_esc(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    return s


def _md_to_html(md: str) -> str:
    """极简 markdown→HTML，覆盖 WS 章节用到的子集：标题 / 表格 / 引用 / 列表 / 代码块 / 段落。"""
    lines = md.split("\n")
    out: list[str] = []
    i = 0
    in_list = False

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("```"):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            out.append("<pre><code>" + _md_esc("\n".join(buf)) + "</code></pre>")
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            close_list()
            lv = len(m.group(1))
            out.append(f"<h{lv}>{_md_inline(m.group(2))}</h{lv}>")
            i += 1
            continue
        if line.startswith(">"):
            close_list()
            buf = []
            while i < len(lines) and lines[i].startswith(">"):
                buf.append(lines[i].lstrip(">").strip())
                i += 1
            out.append("<blockquote>" + _md_inline(" ".join(buf)) + "</blockquote>")
            continue
        if "|" in line and i + 1 < len(lines) and re.match(r"^\s*\|?[\s:|-]+\|?\s*$", lines[i + 1]):
            close_list()
            header = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip() and "|" in lines[i]:
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            th = "".join(f"<th>{_md_inline(h)}</th>" for h in header)
            trs = "".join(
                "<tr>" + "".join(f"<td>{_md_inline(c)}</td>" for c in r) + "</tr>" for r in rows
            )
            out.append(f"<table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>")
            continue
        if re.match(r"^\s*-\s+", line):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append("<li>" + _md_inline(line.strip()[2:].strip()) + "</li>")
            i += 1
            continue
        if not line.strip():
            close_list()
            i += 1
            continue
        close_list()
        out.append("<p>" + _md_inline(line) + "</p>")
        i += 1
    close_list()
    return "\n".join(out)


@app.get("/docs/ws", include_in_schema=False)
async def ws_doc():
    """WS 实时接口文档页：从 contracts/README.md 的 WS 章节渲染（OpenAPI 不描述 WS，故独立页面）。"""
    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WS 实时接口文档 · 本地语音代理</title>
<style>
  body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;max-width:880px;margin:32px auto;padding:0 16px;color:#1f2329;line-height:1.7;background:#fff}}
  h2{{border-bottom:1px solid #eaecef;padding-bottom:.3em;margin-top:1.6em}}
  h3{{margin-top:1.4em;color:#2c3e50}}
  code{{background:#f3f4f6;padding:.15em .4em;border-radius:4px;font-size:.9em}}
  pre{{background:#0f172a;color:#e2e8f0;padding:14px 16px;border-radius:8px;overflow:auto}}
  pre code{{background:none;color:inherit;padding:0}}
  blockquote{{border-left:4px solid #d0d7de;margin:1em 0;padding:.2em 1em;color:#57606a;background:#f6f8fa}}
  table{{border-collapse:collapse;width:100%;margin:1em 0;font-size:.92em}}
  th,td{{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}}
  th{{background:#f6f8fa}}
  a{{color:#2563eb}}
  .back{{margin-bottom:18px;display:inline-block}}
</style></head><body>
<a class="back" href="/docs">← 返回 Swagger 文档</a>
{_md_to_html(_ws_doc_markdown())}
</body></html>"""
    return HTMLResponse(content=page)


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
        app,
        stt_builtin_check=sensevoice_check,
        tts_builtin_check=tts_builtin_check,
        stt_upstream_test=stt_upstream_test,
        tts_upstream_test=tts_upstream_test,
    )

    # 非对外 API 的内部/运维端点从 Swagger/OpenAPI 文档隐藏，只保留真正的语音/LLM 接口：
    # /admin/* 是管理面板页面与配置接口，/ 是根信息页，/health 是健康检查；隐藏只影响文档展示，
    # 不影响实际路由可用性。WS 接口（/voice/ws/inference）OpenAPI 本就不描述，无需处理。
    _HIDE_PATH_EXACT = {"/", "/health"}
    for _r in app.routes:
        _p = getattr(_r, "path", "")
        if _p.startswith("/admin") or _p in _HIDE_PATH_EXACT:
            _r.include_in_schema = False

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
