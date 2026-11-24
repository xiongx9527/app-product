"""请求详情日志：请求头 / query / body 打印，带脱敏 + 截断 + 限额。

设计目标：排障时能看清一次请求带了什么，又不能让日志被大体积 body 撑爆。
- query / headers：解析成结构化字段，敏感键打码，整体限长；
- body：仅当 Content-Length 小于阈值时才读，且只记录文本类（JSON / form / 文本），
  二进制（音频 / 图片 / PCM）只记类型 + 字节数；敏感键递归打码；超长截断。
- 总开关 LOG_REQUEST_DETAIL（默认 on），可在管理面板安全设置里关。
"""
from __future__ import annotations

import json
import os
import re

import config_store

# 超过该字节数不读 body（避免把音频/图片整块加载进内存，也避免日志爆炸）
BODY_READ_MAX = 64 * 1024
# body 详情最多保留的字符数
BODY_LOG_MAX = 2048
# query / headers 各自最多保留的字符数
QUERY_LOG_MAX = 1024
HEADER_LOG_MAX = 1024

_SENSITIVE_KEY = re.compile(
    r"(pass|passwd|pwd|secret|token|api[_-]?key|authoriz|auth|cookie|credential|private[_-]?key)",
    re.I,
)
_MASK = "***"
# 有价值的请求头（其余的不记，减少噪声与泄露面）
_HEADER_KEEP = {
    "content-type", "content-length", "accept", "user-agent", "authorization",
    "api-key", "x-api-key", "x-requested-with", "referer", "origin", "host",
}


def enabled() -> bool:
    """默认开启；显式 off 时关闭。读取异常按开启处理，避免配置抖动导致静默丢日志。"""
    try:
        v = config_store.instance().all().get("LOG_REQUEST_DETAIL")
    except Exception:
        v = None
    return str("on" if v is None else v).strip().lower() != "off"


def _mask_value(key: str, value):
    if _SENSITIVE_KEY.search(str(key)):
        return _MASK
    return value


def _mask_obj(obj, depth: int = 0):
    """递归给 dict 里的敏感键打码；限制深度，避免深层嵌套拖慢。"""
    if depth > 6:
        return "..."
    if isinstance(obj, dict):
        return {k: _mask_value(k, _mask_obj(v, depth + 1)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_mask_obj(x, depth + 1) for x in obj[:50]]
    return obj


def _clip(s: str, limit: int) -> str:
    return s if len(s) <= limit else s[:limit] + f"...(truncated,{len(s)}chars)"


def _format_headers(headers) -> str:
    from urllib.parse import unquote
    out = {}
    size = 0
    for key, value in headers.items():
        k = key.lower()
        if not k.startswith("x-") and k not in _HEADER_KEEP:
            continue
        v = _mask_value(k, unquote(value))
        out[key] = v
        size += len(key) + len(str(v))
        if size > HEADER_LOG_MAX:
            out["_truncated"] = True
            break
    return json.dumps(out, ensure_ascii=False)


def _format_query(raw_query: str) -> str:
    from urllib.parse import parse_qsl
    if isinstance(raw_query, bytes):
        raw_query = raw_query.decode("utf-8", "replace")
    if not raw_query:
        return "{}"
    pairs = [(k, _mask_value(k, v)) for k, v in parse_qsl(raw_query, keep_blank_values=True)]
    s = json.dumps(dict(pairs), ensure_ascii=False)
    return _clip(s, QUERY_LOG_MAX)


def _format_body(body: bytes, content_type: str) -> str:
    if not body:
        return "{}"
    ct = (content_type or "").lower()
    if "json" in ct:
        try:
            obj = json.loads(body)
            return _clip(json.dumps(_mask_obj(obj), ensure_ascii=False), BODY_LOG_MAX)
        except Exception:
            pass
    if "form-urlencoded" in ct:
        from urllib.parse import parse_qsl
        try:
            pairs = parse_qsl(body.decode("utf-8", "replace"), keep_blank_values=True)
            return _clip(json.dumps(dict((k, _mask_value(k, v)) for k, v in pairs), ensure_ascii=False), BODY_LOG_MAX)
        except Exception:
            pass
    if "text/" in ct or "xml" in ct:
        return _clip(body.decode("utf-8", "replace"), BODY_LOG_MAX)
    # 二进制 / 未知：只记类型与大小，绝不打印内容
    return json.dumps({"binary": True, "content_type": ct or "unknown", "bytes": len(body)}, ensure_ascii=False)


def format_detail(method: str, path: str, raw_query: str, headers, body: bytes, content_type: str) -> str:
    """生成单行详情日志，便于 grep / 日志面板按行读取。"""
    return (
        f'[REQ_DETAIL] {method} {path} '
        f'query={_format_query(raw_query)} '
        f'headers={_format_headers(headers)} '
        f'body={_format_body(body, content_type)}'
    )
