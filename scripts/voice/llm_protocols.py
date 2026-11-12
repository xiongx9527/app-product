"""LLM 上游协议适配层。

入站契约固定为 OpenAI 兼容（`/llm/v1/chat/completions` + SSE 流式），本模块只做
出站翻译：把客户端送来的 OpenAI 格式请求，转换成各厂商上游要求的协议，并把上游
的流式 / 非流式响应翻译回 OpenAI SSE / JSON，供网关（只认 OpenAI 格式）消费。

这样新增厂商不会动到网关与接口契约；代理侧只需声明 protocol（线协议）+ vendor（厂商）。

协议口径对齐 fw-plus-ai-native 的 LlmProtocol：**协议是「线协议」，与厂商严格分开**。
我们支持 5 个线协议（与 Java 一致）：
    openai_chat_completions         OpenAI Chat Completions 线协议；deepseek / dashscope /
                                    ollama 都走它（仅 baseUrl 路径 / 厂商私有字段不同，
                                    由 vendor 区分），这是和 Java 解析规则一致的地方：
                                    protocol 优先，vendor 只决定路径变体。
    azure_openai_chat_completions   Azure OpenAI（/openai/deployments/{model}/chat/completions?api-version=）
    openai_responses                OpenAI Responses API（/v1/responses）
    anthropic_messages              Anthropic /v1/messages（请求 / 流式响应双向翻译）
    gemini                          Gemini generateContent / streamGenerateContent?alt=sse

向后兼容：旧配置里写的 openai / deepseek / dashscope / ollama / azure / anthropic
仍可作为 protocol 值，normalize_protocol() 会把它们收敛到上面的线协议，并由
protocol_vendor() 推断出对应 vendor（dashscope / ollama / deepseek），用于路径变体。

所有翻译都是无状态字节处理；异常由调用方（chat_completions）统一兜底。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


OPENAI_SSE_DONE = "data: [DONE]\n\n"

# ── 线协议定义（对齐 fw-plus-ai-native 的 LlmProtocol）─────────────────
# 5 个线协议；旧配置里用的厂商式名字都收敛到这里（与 Java 解析规则一致：
# protocol 取线协议，vendor 只决定路径变体）。
WIRE_PROTOCOLS = {
    "openai_chat_completions",
    "azure_openai_chat_completions",
    "openai_responses",
    "anthropic_messages",
    "gemini",
}

# 旧协议名 / 线协议名 -> 线协议。未知协议回退到 openai_chat_completions（保证不崩）。
PROTOCOL_ALIASES = {
    "openai": "openai_chat_completions",
    "deepseek": "openai_chat_completions",
    "dashscope": "openai_chat_completions",
    "ollama": "openai_chat_completions",
    "azure": "azure_openai_chat_completions",
    "anthropic": "anthropic_messages",
    "gemini": "gemini",
    "openai_chat_completions": "openai_chat_completions",
    "azure_openai_chat_completions": "azure_openai_chat_completions",
    "openai_responses": "openai_responses",
    "anthropic_messages": "anthropic_messages",
}

# 由（旧）协议名推断厂商：只有这几个需要走不同的 baseUrl 路径变体。
# azure / gemini 等路径差异由线协议本身决定，不需要 vendor。
PROTOCOL_VENDOR = {
    "dashscope": "dashscope",
    "ollama": "ollama",
    "deepseek": "deepseek",
}


def normalize_protocol(protocol: str | None) -> str:
    """把任意协议名收敛到 5 个线协议之一；空 / 未知回退到 openai_chat_completions。"""
    key = (protocol or "openai").strip().lower()
    return PROTOCOL_ALIASES.get(key, "openai_chat_completions")


def protocol_vendor(protocol: str | None) -> str:
    """由协议名推断厂商（用于路径变体）；无则空串。"""
    key = (protocol or "").strip().lower()
    return PROTOCOL_VENDOR.get(key, "")


def resolve_vendor(protocol: str | None, vendor: str | None) -> str:
    """确定最终 vendor：显式 vendor 优先；否则由协议名推断。"""
    v = (vendor or "").strip().lower()
    if v:
        return v
    return protocol_vendor(protocol)


def uses_ollama_native(protocol: str | None) -> bool:
    """是否走 Ollama 原生 /api/chat（NDJSON）线协议。

    线协议只由 protocol 决定：仅当显式写 `ollama` 才启用原生端点。vendor 是
    厂商方言标签（管理面板把某行命名为 ollama 只是分组），不能切换线协议——
    否则把 deepseek 等 OpenAI 兼容端点归到 ollama 行时会被发到 /api/chat 而 404。
    """
    return (protocol or "").strip().lower() == "ollama"


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


def _openai_chat_path(base: str) -> str:
    """OpenAI Chat Completions 路径后缀；兼容 base 已带 / 或未带 /v1。

    与 _build_openai 配合：它把该后缀拼到 base 后面，所以这里只返回路径段。
    """
    base = base.rstrip("/")
    if base.endswith("/v1"):
        return "/chat/completions"
    return "/v1/chat/completions"


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


class GeminiStream(StreamTranslator):
    """Gemini streamGenerateContent?alt=sse 的 SSE（每行 data:{...}）-> OpenAI SSE。

    每个事件是一个 GenerateContentResponse JSON，取其 candidates[0].content.parts
    里的文本拼成 OpenAI delta。Gemini 命名与 OpenAI 不同（user/model、parts、text），
    故需要独立翻译器。
    """

    def __init__(self, model: str) -> None:
        super().__init__(model)
        self.buf = b""

    def _parse(self, buf: bytes) -> tuple[bytes, bytes]:
        out = b""
        while b"\n\n" in buf:
            event, buf = buf.split(b"\n\n", 1)
            data = None
            for line in event.split(b"\n"):
                if line.startswith(b"data:"):
                    data = line[5:].strip()
            if not data:
                continue
            try:
                obj = json.loads(data)
            except ValueError:
                continue
            cands = obj.get("candidates") or []
            if not cands:
                continue
            parts = (cands[0].get("content") or {}).get("parts") or []
            text = "".join(p.get("text", "") for p in parts)
            if text:
                out += _openai_chunk(self.model, {"content": text})
        return out, buf

    def feed(self, chunk: bytes) -> bytes:
        out, self.buf = self._parse(self.buf + chunk)
        return out

    def finish(self) -> bytes:
        out, _ = self._parse(self.buf)
        return out + OPENAI_SSE_DONE.encode()


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


def gemini_to_openai(obj: dict) -> dict:
    """Gemini generateContent 的 JSON -> OpenAI chat.completion JSON。

    取 candidates[0].content.parts[].text 拼成助手消息；finish_reason 固定 stop。
    """
    cands = obj.get("candidates") or []
    text = ""
    if cands:
        parts = (cands[0].get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts)
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
    base = base.rstrip("/")
    # 兼容 base 已带 /v1（如用户填 https://api.anthropic.com/v1）或未带两种情况。
    url = base + "/messages" if base.endswith("/v1") else base + "/v1/messages"
    headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01", **_bearer(api_key)}
    return UpstreamRequest(url, headers, payload)


def _build_ollama(base: str, api_key: str, model_override: str, body: dict) -> UpstreamRequest:
    payload: dict[str, Any] = {
        "model": model_override or body.get("model"),
        "messages": body.get("messages", []),
        "stream": bool(body.get("stream", False)),
        "options": {k: body[k] for k in ("temperature", "top_p", "seed") if k in body},
    }
    # 思考开关由 prepare 末尾的 apply_think() 统一翻译，这里不再重复处理。
    url = base.rstrip("/") + "/api/chat"
    headers = {"Content-Type": "application/json", **_bearer(api_key)}
    return UpstreamRequest(url, headers, payload)


def _build_gemini(base: str, api_key: str, model_override: str, body: dict) -> UpstreamRequest:
    """OpenAI 格式 -> Gemini 原生 generateContent。

    Gemini 用自己的 contents / parts / systemInstruction 结构，模型名写在 URL 路径里
    （/models/{model}:generateContent），鉴权用 x-goog-api-key 头。流式走
    streamGenerateContent?alt=sse。
    """
    messages = body.get("messages", [])
    sys_parts = [m.get("content", "") for m in messages if m.get("role") == "system"]
    conv = [m for m in messages if m.get("role") != "system"]
    contents = []
    for m in conv:
        role = "model" if m.get("role") == "assistant" else "user"
        text = m.get("content", "")
        if isinstance(text, list):  # 多模态兜底：只取文本段
            text = "".join(
                p.get("text", "") for p in text if isinstance(p, dict) and p.get("type") == "text"
            )
        contents.append({"role": role, "parts": [{"text": text}]})
    gencfg: dict[str, Any] = {}
    if "temperature" in body:
        gencfg["temperature"] = body["temperature"]
    if "top_p" in body:
        gencfg["top_p"] = body["top_p"]
    if "max_tokens" in body:
        gencfg["maxOutputTokens"] = int(body["max_tokens"])
    payload: dict[str, Any] = {"contents": contents}
    if sys_parts:
        payload["systemInstruction"] = {
            "parts": [{"text": "\n".join(p for p in sys_parts if p)}]
        }
    if gencfg:
        payload["generationConfig"] = gencfg

    model = model_override or body.get("model") or "gemini-1.5-pro"
    stream = bool(body.get("stream", False))
    if stream:
        url = base.rstrip("/") + f"/models/{model}:streamGenerateContent?alt=sse"
    else:
        url = base.rstrip("/") + f"/models/{model}:generateContent"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["x-goog-api-key"] = api_key
    return UpstreamRequest(url, headers, payload)


def _build_openai_responses(base: str, api_key: str, model_override: str, body: dict) -> UpstreamRequest:
    """OpenAI 兼容 Chat Completions -> OpenAI Responses API（/v1/responses）。

    Responses API 用 input 数组 + instructions 承载系统提示；流式事件与 Chat
    Completions 的 SSE 不同，需要独立的翻译器（OpenAiResponsesStream）。
    """
    messages = body.get("messages", [])
    sys_parts = [m.get("content", "") for m in messages if m.get("role") == "system"]
    conv = [m for m in messages if m.get("role") != "system"]
    payload: dict[str, Any] = {
        "model": model_override or body.get("model") or "",
        "input": [
            {"role": m.get("role", "user"), "content": m.get("content", "")}
            for m in conv
        ],
        "stream": bool(body.get("stream", False)),
    }
    if sys_parts:
        payload["instructions"] = "\n".join(p for p in sys_parts if p)
    if "temperature" in body:
        payload["temperature"] = body["temperature"]
    if "top_p" in body:
        payload["top_p"] = body["top_p"]
    url = base.rstrip("/") + "/v1/responses"
    headers = {"Content-Type": "application/json", **_bearer(api_key)}
    return UpstreamRequest(url, headers, payload)


class OpenAiResponsesStream(StreamTranslator):
    """OpenAI Responses API 的 SSE -> OpenAI Chat Completions SSE。

    关注两类事件：
        response.output_text.delta        data: {"delta": "..."}
        response.completed               结束，补 [DONE]
    其余事件（created / in_progress / output_item.added 等）忽略。
    """

    def __init__(self, model: str) -> None:
        super().__init__(model)
        self.buf = b""

    def _parse(self, buf: bytes) -> tuple[bytes, bytes]:
        out = b""
        while b"\n\n" in buf:
            event, buf = buf.split(b"\n\n", 1)
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
            if ev_type == "response.output_text.delta":
                delta = obj.get("delta") or ""
                if delta:
                    out += _openai_chunk(self.model, {"content": delta})
            elif ev_type == "response.completed":
                # 结束信号交给 finish() 统一补 [DONE]，避免重复。
                pass
        return out, buf

    def feed(self, chunk: bytes) -> bytes:
        out, self.buf = self._parse(self.buf + chunk)
        return out

    def finish(self) -> bytes:
        out, _ = self._parse(self.buf)
        return out + OPENAI_SSE_DONE.encode()


def openai_responses_to_openai(obj: dict) -> dict:
    """OpenAI Responses API 的非流式响应 -> OpenAI chat.completion JSON。

    Responses 的文本内容在 output[].content[].text（type=output_text）。
    """
    text = ""
    for item in obj.get("output", []) or []:
        for c in item.get("content", []) or []:
            if isinstance(c, dict) and c.get("type") == "output_text":
                text += c.get("text", "")
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


# ── 思考开关：统一契约 -> 各厂商原生参数 ─────────────────────────────────
# 代理对外的统一契约是布尔 think（true=要推理链 / false=不要）。各家原生参数
# 名字、结构完全不同，必须在这里翻译，不能把 think 原样丢给上游（多数厂商不认，
# 还可能当成非法参数报错）。同时把代理内部字段从最终 payload 里剔除，避免
# _build_openai 的 dict(body) 把 base_url / api_key / vendor 等一起透传上去。
_INTERNAL_KEYS = {"base_url", "api_key", "vendor", "protocol", "bypass_catalog", "think", "extra_body", "direct_upstream"}


def apply_think(payload: dict, body: dict, wire: str, vendor: str) -> dict:
    """把统一 think 契约翻译成目标厂商的『是否思考』参数（就地改 payload）。

    未带 think 时不干预上游默认行为。通用 OpenAI 兼容端点没有统一标准，保守
    不下发任何思考参数（宁可沿用上游默认，也不发对方不认的字段）。
    """
    for k in _INTERNAL_KEYS:
        payload.pop(k, None)
    think = body.get("think")
    if think is None:
        return payload
    enable = bool(think)
    if vendor == "ollama":
        # ollama 原生 /api/chat：think=true/false（0.40.x+ 支持）
        payload["think"] = enable
    elif wire == "anthropic_messages":
        # Claude：不带 thinking 字段即不思考；要思考才带 type+budget
        if enable:
            payload["thinking"] = {"type": "enabled", "budget_tokens": 4096}
        else:
            payload.pop("thinking", None)
    elif wire == "gemini":
        # Gemini：thinkingBudget 0=关闭，-1=动态（自动）
        cfg = payload.setdefault("generationConfig", {})
        cfg.setdefault("thinkingConfig", {})["thinkingBudget"] = -1 if enable else 0
    elif wire == "openai_responses":
        # OpenAI o-series 没有『关闭推理』语义，只能不带 reasoning 用默认
        if enable:
            payload["reasoning"] = {"effort": "medium"}
        else:
            payload.pop("reasoning", None)
    elif vendor == "dashscope":
        # 通义千问（OpenAI 兼容模式）
        payload["enable_thinking"] = enable
    elif vendor == "deepseek":
        # DeepSeek V3.1+ 混合思考
        payload["thinking"] = {"type": "enabled" if enable else "disabled"}
    # 其余 openai_chat_completions / azure：无统一标准，保持不下发
    return payload


# ── 统一入口 ────────────────────────────────────────────────────────────
def prepare(
    protocol: str,
    base: str,
    api_key: str,
    model_override: str,
    api_version: str,
    body: dict,
    vendor: str | None = None,
) -> tuple[UpstreamRequest, type[StreamTranslator], callable]:
    """返回（上游请求, 流式翻译器类, 非流式响应翻译函数）。

    线协议（URL 路径 + 流式翻译器）只由 protocol 决定；vendor 只管厂商方言参数
    （think 开关命名、dashscope 的 /compatible-mode/v1 路径变体），不再切换线协议。
    Ollama 原生 /api/chat 仅当 protocol 显式为旧别名 ollama 时启用——vendor=ollama
    只是管理面板的分组标签，不能把贴了该标签的 OpenAI 兼容端点劫持到 /api/chat。
    协议名大小写不敏感；未知协议回退到 openai_chat_completions，保证不崩。
    """
    wire = normalize_protocol(protocol)
    vendor = resolve_vendor(protocol, vendor)

    if wire == "azure_openai_chat_completions":
        model = model_override or body.get("model") or ""
        req = _build_openai(
            base, api_key, model_override, body,
            f"/openai/deployments/{model}/chat/completions",
        )
        if api_version:
            req.url += f"?api-version={api_version}"
        stream_cls, resp_transform = StreamTranslator, _identity
    elif wire == "anthropic_messages":
        req = _build_anthropic(base, api_key, model_override, body)
        stream_cls, resp_transform = AnthropicStream, anthropic_to_openai
    elif wire == "gemini":
        req = _build_gemini(base, api_key, model_override, body)
        stream_cls, resp_transform = GeminiStream, gemini_to_openai
    elif wire == "openai_responses":
        req = _build_openai_responses(base, api_key, model_override, body)
        stream_cls, resp_transform = OpenAiResponsesStream, openai_responses_to_openai
    elif uses_ollama_native(protocol):
        # 仅 protocol 显式为 ollama 旧别名才走原生 /api/chat（NDJSON）。
        # vendor=ollama 只是面板分组标签，不能把 OpenAI 兼容端点劫持到 /api/chat。
        req = _build_ollama(base, api_key, model_override, body)
        stream_cls, resp_transform = OllamaStream, ollama_to_openai
    else:
        path = "/compatible-mode/v1/chat/completions" if vendor == "dashscope" else _openai_chat_path(base)
        req = _build_openai(base, api_key, model_override, body, path)
        stream_cls, resp_transform = StreamTranslator, _identity

    # 统一收口：思考开关按厂商翻译 + 剔除代理内部字段（_build_openai 用了 dict(body)）
    apply_think(req.payload, body, wire, vendor)
    # 自定义 body 参数：合并到上游 payload（各线协议结构不同，这里统一补齐，
    # setdefault 保证不覆盖协议自身已翻译好的字段）。
    extra_body = body.get("extra_body")
    if isinstance(extra_body, dict):
        for k, v in extra_body.items():
            if isinstance(k, str) and k.strip():
                req.payload.setdefault(k.strip(), v)
    return req, stream_cls, resp_transform


def prepare_models(
    protocol: str, base: str, api_key: str, vendor: str | None = None
) -> tuple[str, dict[str, str]]:
    """模型列表接口：Ollama 走 /api/tags，Gemini 走 /models，其余 OpenAI 兼容走 /v1/models。"""
    wire = normalize_protocol(protocol)
    headers = {"Content-Type": "application/json", **_bearer(api_key)}
    if uses_ollama_native(protocol):
        return base.rstrip("/") + "/api/tags", headers
    if wire == "gemini":
        return base.rstrip("/") + "/models", headers
    return _openai_completions_url(base).replace("/chat/completions", "/models"), headers


def ollama_tags_to_openai(obj: dict) -> dict:
    """Ollama /api/tags -> OpenAI /v1/models 形状。"""
    models = [
        {"id": m.get("name", ""), "object": "model", "owned_by": "ollama"}
        for m in obj.get("models", [])
    ]
    return {"object": "list", "data": models}
