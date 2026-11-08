"""LLM 上游协议适配层。

入站契约固定为 OpenAI 兼容（`/llm/v1/chat/completions` + SSE 流式），本模块只做
出站翻译：把客户端送来的 OpenAI 格式请求，转换成各厂商上游要求的协议，并把上游
的流式 / 非流式响应翻译回 OpenAI SSE / JSON，供网关（只认 OpenAI 格式）消费。

这样新增厂商不会动到网关与接口契约；代理侧只需声明 LLM_UPSTREAM_PROTOCOL。

支持协议：
    openai / deepseek    OpenAI 兼容，原样转发（仅拼 /v1/chat/completions）
    dashscope            阿里云 DashScope OpenAI 兼容（路径 /compatible-mode/v1）
    azure                Azure OpenAI（/openai/deployments/{model}/chat/completions?api-version=）
    ollama               Ollama 原生 /api/chat（NDJSON 流式 -> OpenAI SSE，保留 thinking）
    anthropic            Anthropic /v1/messages（请求 / 流式响应双向翻译）

所有翻译都是无状态字节处理；异常由调用方（chat_completions）统一兜底。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


OPENAI_SSE_DONE = "data: [DONE]\n\n"


@dataclass
class UpstreamRequest:
    """翻译后的上游请求：URL、请求头、JSON 体。"""

    url: str
    headers: dict[str, str]
    payload: dict[str, Any]


# ── 工具函数 ────────────────────────────────────────────────────────────
def _apply_model_override(body: dict, override: str) -> None:
    if override:
        body["model"] = override


def _bearer(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


def _openai_completions_url(base: str) -> str:
    """拼 OpenAI 风格 chat/completions：兼容用户填 / 不填 /v1。"""
    base = base.rstrip("/")
    if base.endswith("/v1"):
        return base + "/chat/completions"
    return base + "/v1/chat/completions"


def _openai_chunk(model: str, delta: dict, finish: str | None = None) -> bytes:
    choice: dict[str, Any] = {"index": 0, "delta": delta}
    if finish is not None:
        choice["finish_reason"] = finish
    return (
        "data: "
        + json.dumps(
            {
                "id": "chatcmpl-proxy",
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [choice],
            }
        )
        + "\n\n"
    ).encode()


# ── 流式翻译器：把上游字节流翻译为 OpenAI SSE 字节 ──────────────────────
class StreamTranslator:
    """默认实现：原样透传（上游已是 OpenAI SSE）。"""

    def __init__(self, model: str) -> None:
        self.model = model

    def feed(self, chunk: bytes) -> bytes:
        return chunk

    def finish(self) -> bytes:
        return b""


class OllamaStream(StreamTranslator):
    """Ollama 原生 /api/chat 的 NDJSON 流式 -> OpenAI SSE。

    每行一个 JSON：{"message":{"role","content","thinking?"},"done":bool}。
    thinking 字段（推理模型）映射到 OpenAI 扩展字段 reasoning_content。
    """

    def __init__(self, model: str) -> None:
        super().__init__(model)
        self.buf = b""

    def feed(self, chunk: bytes) -> bytes:
        self.buf += chunk
        *lines, self.buf = self.buf.split(b"\n")
        out = b""
        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            msg = obj.get("message") or {}
            content = msg.get("content") or ""
            thinking = msg.get("thinking") or ""
            delta: dict[str, Any] = {}
            if content:
                delta["content"] = content
            if thinking:
                delta["reasoning_content"] = thinking
            if delta:
                out += _openai_chunk(self.model, delta)
            if obj.get("done"):
                out += OPENAI_SSE_DONE.encode()
        return out

    def finish(self) -> bytes:
        out = b""
        tail = self.buf.strip()
        if tail:
            try:
                obj = json.loads(tail)
            except ValueError:
                obj = None
            if obj:
                msg = obj.get("message") or {}
                content = msg.get("content") or ""
                thinking = msg.get("thinking") or ""
                delta = {}
                if content:
                    delta["content"] = content
                if thinking:
                    delta["reasoning_content"] = thinking
                if delta:
                    out += _openai_chunk(self.model, delta)
        out += OPENAI_SSE_DONE.encode()
        return out


class AnthropicStream(StreamTranslator):
    """Anthropic /v1/messages 的 SSE 事件 -> OpenAI SSE。

    事件格式：
        event: message_start
        event: content_block_delta  data: {"delta":{"type":"text_delta","text":"..."}}
        event: message_stop
    """

    def __init__(self, model: str) -> None:
        super().__init__(model)
        self.buf = b""

    def feed(self, chunk: bytes) -> bytes:
        self.buf += chunk
        out = b""
        while b"\n\n" in self.buf:
            event, self.buf = self.buf.split(b"\n\n", 1)
            ev_type = None
            data = None
            for line in event.split(b"\n"):
                if line.startswith(b"event:"):
                    ev_type = line[6:].strip().decode("utf-8", "replace")
                elif line.startswith(b"data:"):
                    data = line[5:].strip()
            if not data:
                continue
            try:
                obj = json.loads(data)
            except ValueError:
                continue
            out += self._handle(ev_type, obj)
        return out

    def _handle(self, ev_type: str | None, obj: dict) -> bytes:
        if ev_type == "message_start":
            return _openai_chunk(self.model, {"role": "assistant"})
        if ev_type == "content_block_delta":
            delta = obj.get("delta", {})
            dtype = delta.get("type")
            if dtype == "text_delta":
                text = delta.get("text", "")
                if text:
                    return _openai_chunk(self.model, {"content": text})
            elif dtype == "thinking_delta":
                thinking = delta.get("thinking", "")
                if thinking:
                    return _openai_chunk(self.model, {"reasoning_content": thinking})
            return b""
        if ev_type == "message_stop":
            return OPENAI_SSE_DONE.encode()
        return b""

    def finish(self) -> bytes:
        return OPENAI_SSE_DONE.encode()


# ── 非流式响应翻译：上游 JSON -> OpenAI 兼容 JSON ────────────────────────
def _identity(obj: dict) -> dict:
    return obj


def ollama_to_openai(obj: dict) -> dict:
    msg = obj.get("message", {}) or {}
    content = msg.get("content", "")
    reasoning = msg.get("thinking", "")
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if reasoning:
        message["reasoning_content"] = reasoning
    return {
        "id": "chatcmpl-proxy",
        "object": "chat.completion",
        "model": obj.get("model", ""),
        "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
    }


def anthropic_to_openai(obj: dict) -> dict:
    text = "".join(
        c.get("text", "")
        for c in obj.get("content", [])
        if isinstance(c, dict) and c.get("type") == "text"
    )
    return {
        "id": "chatcmpl-proxy",
        "object": "chat.completion",
        "model": obj.get("model", ""),
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
    }


# ── 请求构建（出站翻译）─────────────────────────────────────────────────
def _build_openai(base: str, api_key: str, model_override: str, body: dict, path: str) -> UpstreamRequest:
    payload = dict(body)
    _apply_model_override(payload, model_override)
    url = base.rstrip("/") + path
    headers = {"Content-Type": "application/json", **_bearer(api_key)}
    return UpstreamRequest(url, headers, payload)


def _build_anthropic(base: str, api_key: str, model_override: str, body: dict) -> UpstreamRequest:
    messages = body.get("messages", [])
    sys_parts = [m.get("content", "") for m in messages if m.get("role") == "system"]
    conv = [m for m in messages if m.get("role") != "system"]
    payload: dict[str, Any] = {
        "model": model_override or body.get("model") or "deepseek-flash",
        "messages": conv,
        "stream": bool(body.get("stream", False)),
        "max_tokens": int(body.get("max_tokens", 1024)),
    }
    if sys_parts:
        payload["system"] = "\n".join(p for p in sys_parts if p)
    if "temperature" in body:
        payload["temperature"] = body["temperature"]
    if "top_p" in body:
        payload["top_p"] = body["top_p"]
    url = base.rstrip("/") + "/v1/messages"
    headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01", **_bearer(api_key)}
    return UpstreamRequest(url, headers, payload)


def _build_ollama(base: str, api_key: str, model_override: str, body: dict) -> UpstreamRequest:
    payload: dict[str, Any] = {
        "model": model_override or body.get("model"),
        "messages": body.get("messages", []),
        "stream": bool(body.get("stream", False)),
        "options": {k: body[k] for k in ("temperature", "top_p", "seed") if k in body},
    }
    url = base.rstrip("/") + "/api/chat"
    headers = {"Content-Type": "application/json", **_bearer(api_key)}
    return UpstreamRequest(url, headers, payload)


# ── 统一入口 ────────────────────────────────────────────────────────────
def prepare(
    protocol: str,
    base: str,
    api_key: str,
    model_override: str,
    api_version: str,
    body: dict,
) -> tuple[UpstreamRequest, type[StreamTranslator], callable]:
    """返回（上游请求, 流式翻译器类, 非流式响应翻译函数）。

    协议名大小写不敏感；未知协议回退到 openai。
    """
    protocol = (protocol or "openai").strip().lower()

    if protocol in ("openai", "deepseek"):
        req = _build_openai(base, api_key, model_override, body, "/v1/chat/completions")
        return req, StreamTranslator, _identity
    if protocol == "dashscope":
        req = _build_openai(base, api_key, model_override, body, "/compatible-mode/v1/chat/completions")
        return req, StreamTranslator, _identity
    if protocol == "azure":
        model = model_override or body.get("model") or ""
        req = _build_openai(base, api_key, model_override, body, f"/openai/deployments/{model}/chat/completions")
        if api_version:
            req.url += f"?api-version={api_version}"
        return req, StreamTranslator, _identity
    if protocol == "ollama":
        req = _build_ollama(base, api_key, model_override, body)
        return req, OllamaStream, ollama_to_openai
    if protocol == "anthropic":
        req = _build_anthropic(base, api_key, model_override, body)
        return req, AnthropicStream, anthropic_to_openai
    # 未知协议：回退到 OpenAI 透传，保证不崩。
    req = _build_openai(base, api_key, model_override, body, "/v1/chat/completions")
    return req, StreamTranslator, _identity


def prepare_models(protocol: str, base: str, api_key: str) -> tuple[str, dict[str, str]]:
    """模型列表接口：OpenAI 兼容走 /v1/models，Ollama 走 /api/tags。"""
    protocol = (protocol or "openai").strip().lower()
    headers = {"Content-Type": "application/json", **_bearer(api_key)}
    if protocol == "ollama":
        return base.rstrip("/") + "/api/tags", headers
    return _openai_completions_url(base).replace("/chat/completions", "/models"), headers


def ollama_tags_to_openai(obj: dict) -> dict:
    """Ollama /api/tags -> OpenAI /v1/models 形状。"""
    models = [
        {"id": m.get("name", ""), "object": "model", "owned_by": "ollama"}
        for m in obj.get("models", [])
    ]
    return {"object": "list", "data": models}
