"""限流存储门面：按 api-key 计数，后端由配置决定（内存 / Redis），调用方无感。

沿用项目 config_store.py 的门面原则：调用方只调 check_and_consume/record/reset/stats，
不感知后端是内存还是 Redis。配了 Redis 但连不上时透明降级到内存（与 voice_sync 一致）。

阶段 1 只用 requests 次数桶；三类计量（llm_tokens/asr_seconds/tts_chars）的 record
接口已就绪，埋点在阶段 2 接入。
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

# 4 个独立维度（每个 key 各自计数）
KINDS = ("requests", "llm_tokens", "asr_seconds", "tts_chars")

_backend: "_BaseBackend | None" = None
_backend_name = "memory"
_lock = threading.Lock()


class _BaseBackend:
    def check_and_consume(self, key_id: int, kind: str, limit: int, cost: int = 1,
                          period_seconds: int = 60) -> tuple[bool, int]:
        raise NotImplementedError

    def record(self, key_id: int, kind: str, amount: float, period_seconds: int = 60) -> None:
        raise NotImplementedError

    def reset(self, key_id: int) -> None:
        raise NotImplementedError

    def stats(self) -> dict[str, Any]:
        raise NotImplementedError


class _MemoryBackend(_BaseBackend):
    """令牌桶（每秒补充 limit/60）+ 滑动窗口（60s）。纯进程内存，重启清零。"""

    def __init__(self) -> None:
        self._buckets: dict[tuple[int, str], tuple[float, float, int]] = {}  # (tokens, last_refill, period_sec)
        self._windows: dict[tuple[int, str], list[tuple[float, float]]] = {}
        self._lock = threading.Lock()

    def _refill(self, key: tuple[int, str], limit: int, now: float, period_sec: int) -> float:
        tokens, last, _old_period = self._buckets.get(key, (float(limit), now, period_sec))
        # 周期变了（策略改单位）→ 桶重置为满
        if _old_period != period_sec:
            tokens, last = float(limit), now
        rate = max(limit, 1) / max(period_sec, 1)
        tokens = min(float(limit), tokens + (now - last) * rate)
        self._buckets[key] = (tokens, now, period_sec)
        return tokens

    def check_and_consume(self, key_id: int, kind: str, limit: int, cost: int = 1,
                          period_seconds: int = 60) -> tuple[bool, int]:
        limit = max(int(limit), 1)
        period_sec = max(int(period_seconds), 1)
        with self._lock:
            now = time.time()
            key = (key_id, kind)
            tokens = self._refill(key, limit, now, period_sec)
            if tokens >= cost:
                self._buckets[key] = (tokens - cost, now, period_sec)
                return True, 0
            rate = max(limit, 1) / period_sec
            retry = max(1, int((cost - tokens) / rate) + 1)
            return False, retry

    def record(self, key_id: int, kind: str, amount: float, period_seconds: int = 60) -> None:
        now = time.time()
        key = (key_id, kind)
        with self._lock:
            win = self._windows.setdefault(key, [])
            win.append((now, float(amount)))
            cutoff = now - max(period_seconds, 1)
            while win and win[0][0] < cutoff:
                win.pop(0)

    def window_sum(self, key_id: int, kind: str, period_seconds: int = 60) -> float:
        now = time.time()
        cutoff = now - max(period_seconds, 1)
        with self._lock:
            win = self._windows.get((key_id, kind), [])
            return sum(a for ts, a in win if ts >= cutoff)

    def reset(self, key_id: int) -> None:
        with self._lock:
            for k in list(self._buckets):
                if k[0] == key_id:
                    del self._buckets[k]
            for k in list(self._windows):
                if k[0] == key_id:
                    del self._windows[k]

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {"backend": "memory", "buckets": len(self._buckets), "windows": len(self._windows)}


class _RedisBackend(_BaseBackend):
    """Redis 后端（阶段 2 增强，多实例共享计数）。

    Lua 脚本原子令牌桶 + ZSET 滑动窗口。未装 redis 或连不上时由 configure 降级到内存。
    """

    def __init__(self, url: str) -> None:
        import redis  # type: ignore
        self._client = redis.from_url(url, decode_responses=True)
        self._client.ping()

    def check_and_consume(self, key_id: int, kind: str, limit: int, cost: int = 1) -> tuple[bool, int]:
        # 占位：阶段 2 实现 Lua 令牌桶。当前抛错由 configure 降级到内存。
        raise NotImplementedError("Redis 限流后端待阶段 2 实现")

    def record(self, key_id: int, kind: str, amount: float) -> None:
        raise NotImplementedError("Redis 限流后端待阶段 2 实现")

    def reset(self, key_id: int) -> None:
        raise NotImplementedError("Redis 限流后端待阶段 2 实现")

    def stats(self) -> dict[str, Any]:
        return {"backend": "redis"}


def configure(backend: str | None = None, redis_url: str | None = None) -> str:
    """按配置选后端；返回实际后端名（memory / redis）。

    backend: auto（默认，配了 REDIS_URL 用 Redis）| memory | redis。
    Redis 连不上 / 未装依赖 → 降级内存并打警告，业务不中断。
    """
    global _backend, _backend_name
    choice = (backend or "auto").strip().lower()
    with _lock:
        if choice == "redis" or (choice == "auto" and redis_url):
            try:
                _backend = _RedisBackend(redis_url or "")
                _backend_name = "redis"
                return _backend_name
            except Exception as exc:  # noqa: BLE001
                logging.getLogger("uvicorn.error").warning(
                    "[local-ai] Redis 限流后端不可用，降级内存：%s", exc
                )
        _backend = _MemoryBackend()
        _backend_name = "memory"
        return _backend_name


def _ensure() -> _BaseBackend:
    global _backend
    if _backend is None:
        _backend = _MemoryBackend()
    return _backend


def check_and_consume(key_id: int, kind: str, limit: int, cost: int = 1,
                      period_seconds: int = 60) -> tuple[bool, int]:
    """判断是否放行。返回 (是否放行, retry_after秒)。同步、微秒级。"""
    return _ensure().check_and_consume(key_id, kind, limit, cost, period_seconds)


def record(key_id: int, kind: str, amount: float, period_seconds: int = 60) -> None:
    """滑动窗口累加（计量用，阶段 2 埋点调）。"""
    _ensure().record(key_id, kind, amount, period_seconds)


def window_sum(key_id: int, kind: str, period_seconds: int = 60) -> float:
    """查窗口累计量（仅内存后端，阶段 2 用）。"""
    b = _ensure()
    return b.window_sum(key_id, kind, period_seconds) if isinstance(b, _MemoryBackend) else 0.0


def reset(key_id: int) -> None:
    _ensure().reset(key_id)


def stats() -> dict[str, Any]:
    return _ensure().stats()


def backend_name() -> str:
    return _backend_name
