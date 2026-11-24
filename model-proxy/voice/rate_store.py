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

# 6 个独立维度（每个 key 各自计数）
KINDS = ("requests", "llm_tokens", "asr_seconds", "tts_chars", "embed_tokens", "rerank_tokens")

_backend: "_BaseBackend | None" = None
_backend_name = "memory"
_lock = threading.Lock()
# Redis 运行时故障的降级后端（不与主后端共享状态，仅在异常时顶上，避免业务 500）
_fallback_memory: "_MemoryBackend | None" = None
_fallback_lock = threading.Lock()


def _fallback() -> "_MemoryBackend":
    global _fallback_memory
    with _fallback_lock:
        if _fallback_memory is None:
            _fallback_memory = _MemoryBackend()
        return _fallback_memory


class _BaseBackend:
    def check_and_consume(self, key_id: int, kind: str, limit: int, cost: int = 1,
                          period_seconds: int = 60) -> tuple[bool, int]:
        raise NotImplementedError

    def record(self, key_id: int, kind: str, amount: float, period_seconds: int = 60) -> None:
        raise NotImplementedError

    def reset(self, key_id: int) -> None:
        raise NotImplementedError

    def window_sum(self, key_id: int, kind: str, period_seconds: int = 60) -> float:
        return 0.0

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
    """Redis 后端：多实例共享计数，Lua 脚本原子令牌桶 + ZSET 滑动窗口。

    与内存后端同语义：令牌桶每秒补 limit/period，ZSET 记 60s 滑动窗口累计量。
    用 Redis 服务端 TIME 取时间，避免多实例时钟漂移。连接/脚本异常时由门面降级到内存。
    """

    _PREFIX = "rl:"
    # 原子令牌桶：KEYS[1]=桶hash ARGV=limit period cost 秒 微秒
    # 返回 {放行1/0, retry秒}；桶不存在按满桶初始化。
    _TOKEN_LUA = """
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local period = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4]) + tonumber(ARGV[5]) / 1000000
local t = redis.call('HMGET', key, 'tokens', 'last', 'period')
local tokens = tonumber(t[1])
local last = tonumber(t[2])
local oldp = tonumber(t[3])
if tokens == nil or last == nil or oldp ~= period then
  tokens = limit
  last = now
end
local rate = limit / period
tokens = math.min(limit, tokens + (now - last) * rate)
if tokens >= cost then
  redis.call('HMSET', key, 'tokens', tokens - cost, 'last', now, 'period', period)
  redis.call('PEXPIRE', key, period * 2000)
  return {1, 0}
end
local retry = math.ceil((cost - tokens) / rate)
return {0, math.max(1, retry)}
"""

    def __init__(self, url: str) -> None:
        import redis  # type: ignore
        self._client = redis.from_url(url, decode_responses=True)
        self._client.ping()
        self._token_sha = self._client.script_load(self._TOKEN_LUA)

    def _bucket_key(self, key_id: int, kind: str) -> str:
        return f"{self._PREFIX}b:{key_id}:{kind}"

    def _window_key(self, key_id: int, kind: str) -> str:
        return f"{self._PREFIX}w:{key_id}:{kind}"

    def check_and_consume(self, key_id: int, kind: str, limit: int, cost: int = 1,
                          period_seconds: int = 60) -> tuple[bool, int]:
        limit = max(int(limit), 1)
        period_sec = max(int(period_seconds), 1)
        sec, usec = self._client.time()
        res = self._client.evalsha(
            self._token_sha, 1, self._bucket_key(key_id, kind),
            limit, period_sec, cost, sec, usec,
        )
        return (int(res[0]) == 1, int(res[1]))

    def record(self, key_id: int, kind: str, amount: float, period_seconds: int = 60) -> None:
        # score=时间戳（按时间范围清理/查询），member 内编码 amount（取 ':' 前段求和）。
        # member 加随机后缀避免同一时刻同 amount 的条目互相覆盖。
        import secrets
        key = self._window_key(key_id, kind)
        now = time.time()
        member = f"{float(amount)}:{secrets.token_hex(4)}"
        self._client.zadd(key, {member: now})
        # 清理窗口外数据 + 设过期（period 的 2 倍）
        self._client.zremrangebyscore(key, 0, now - max(period_seconds, 1))
        self._client.expire(key, max(period_seconds, 1) * 2)

    def window_sum(self, key_id: int, kind: str, period_seconds: int = 60) -> float:
        key = self._window_key(key_id, kind)
        now = time.time()
        members = self._client.zrangebyscore(key, now - max(period_seconds, 1), now)
        total = 0.0
        for m in members:
            try:
                total += float(str(m).split(":", 1)[0])
            except (ValueError, TypeError):
                pass
        return total

    def reset(self, key_id: int) -> None:
        pat_b = f"{self._PREFIX}b:{key_id}:*"
        pat_w = f"{self._PREFIX}w:{key_id}:*"
        for pat in (pat_b, pat_w):
            keys = self._client.keys(pat)
            if keys:
                self._client.delete(*keys)

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
    """判断是否放行。返回 (是否放行, retry_after秒)。同步、微秒级。

    Redis 后端运行时故障（断连/脚本丢失）时透明降级到进程内存，绝不因限流故障
    让业务请求 500。降级期间多实例计数不再共享，属可接受的性能退化。
    """
    try:
        return _ensure().check_and_consume(key_id, kind, limit, cost, period_seconds)
    except Exception as exc:  # noqa: BLE001
        logging.getLogger("uvicorn.error").warning(
            "[local-ai] 限流后端故障，降级内存：%s", exc
        )
        return _fallback().check_and_consume(key_id, kind, limit, cost, period_seconds)


def record(key_id: int, kind: str, amount: float, period_seconds: int = 60) -> None:
    """滑动窗口累加（计量用，阶段 2 埋点调）。"""
    try:
        _ensure().record(key_id, kind, amount, period_seconds)
    except Exception:  # noqa: BLE001
        _fallback().record(key_id, kind, amount, period_seconds)


def window_sum(key_id: int, kind: str, period_seconds: int = 60) -> float:
    """查窗口累计量（内存 / Redis 后端都支持）。"""
    try:
        return _ensure().window_sum(key_id, kind, period_seconds)
    except Exception:  # noqa: BLE001
        return _fallback().window_sum(key_id, kind, period_seconds)


def reset(key_id: int) -> None:
    _ensure().reset(key_id)


def stats() -> dict[str, Any]:
    return _ensure().stats()


def backend_name() -> str:
    return _backend_name
