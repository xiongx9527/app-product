"""远程数据库同步（Postgres 为远端库 + Redis 为远端缓存）。

设计要点（对应「本地缓存 + 远程缓存、本地与远程同步；远程缓存必须用 Redis」）：
    - 远端库：Postgres（asyncpg，懒加载），存配置的权威副本；未配 VOICE_REMOTE_DSN
      或没装驱动时整段优雅降级为 no-op，不影响本地服务。
    - 远端缓存：Redis（cache-aside），绝不落数据库当缓存。读远端配置先查 Redis，
      命中即返回；未命中才查 Postgres 并回填 Redis。写（push）后写穿 Redis。
      Redis 未配 / 连不上时，缓存缺失直接回退查 Postgres（此时无缓存，不是「用库当缓存」）。
    - 调用方（config_store）只关心「最终两边一致」，不感知 Redis / Postgres 细节。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

_remote_dsn: str | None = None
_redis_url: str | None = None

_last: dict[str, Any] = {
    "configured": False,          # 远端 Postgres 是否配置
    "redis_configured": False,    # Redis 是否配置
    "redis_ok": None,             # 最近一次 Redis 连通性
    "redis_error": None,
    "last_ok": None,              # 最近一次同步（推/拉）是否成功
    "last_error": None,
    "last_sync": None,
    "driver": None,
}

# 远端缓存 key 与 TTL（秒）。Redis 不可用时此缓存整体失效，回退查 Postgres。
_REDIS_KEY = "voice:config_cache"
_REDIS_TTL = 60

# Redis 客户端与「最近不可用」记忆，避免 Redis 宕机时每次请求都卡 2s 连接超时。
_redis_client = None
_redis_bad_ts = 0.0
_REDIS_RETRY = 30.0


def configure(dsn: str | None = None, redis_url: str | None = None) -> None:
    """主文件启动时调用；DSN 走 VOICE_REMOTE_DSN，Redis 走 REDIS_URL。"""
    global _remote_dsn, _redis_url
    _remote_dsn = dsn or os.environ.get("VOICE_REMOTE_DSN") or None
    _redis_url = redis_url or os.environ.get("REDIS_URL") or None
    _last["configured"] = bool(_remote_dsn)
    _last["redis_configured"] = bool(_redis_url)


# ── Postgres（远端库）──────────────────────────────────────────────
def _pg_driver() -> str | None:
    try:
        import asyncpg  # noqa: F401

        return "asyncpg"
    except ImportError:
        return None


async def _pg_connect():
    import asyncpg

    return await asyncpg.connect(_remote_dsn)


async def _ensure_schema(conn) -> None:
    # 远端库与本地 SQLite 同构（config_kv 为同步主体；events / audit 为 centralized 日志预留）。
    await conn.execute(
        "CREATE TABLE IF NOT EXISTS config_kv ("
        "key TEXT PRIMARY KEY, value TEXT, updated_at BIGINT NOT NULL, updated_by TEXT)"
    )
    await conn.execute(
        "CREATE TABLE IF NOT EXISTS events ("
        "id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, level TEXT, source TEXT, "
        "message TEXT, meta TEXT)"
    )
    await conn.execute(
        "CREATE TABLE IF NOT EXISTS audit ("
        "id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, actor TEXT, action TEXT, detail TEXT)"
    )


# ── Redis（远端缓存）──────────────────────────────────────────────
async def _redis():
    """返回可用的 Redis 客户端；不可用（未配 / 未装 / 连不上）返回 None。"""
    global _redis_client, _redis_bad_ts
    if not _redis_url:
        return None
    now = time.time()
    # 近期连不上则直接放弃，避免反复连接超时拖慢请求。
    if _redis_client is None and now - _redis_bad_ts < _REDIS_RETRY:
        return None
    try:
        import redis.asyncio as aioredis

        if _redis_client is None:
            _redis_client = aioredis.from_url(
                _redis_url, socket_connect_timeout=2, socket_timeout=2
            )
        await _redis_client.ping()
        _last["redis_ok"] = True
        _last["redis_error"] = None
        return _redis_client
    except Exception as e:  # noqa: BLE001
        _redis_client = None
        _redis_bad_ts = time.time()
        _last["redis_ok"] = False
        _last["redis_error"] = str(e)
        return None


# ── 推送：本地 -> 远端库 + 写穿 Redis ─────────────────────────────
async def push_config(config: dict[str, str]) -> dict[str, Any]:
    """把本地全量配置 upsert 到 Postgres，并写穿 Redis 缓存。"""
    if not _remote_dsn:
        return _set(False, "未配置远程数据库（VOICE_REMOTE_DSN）")
    if not _pg_driver():
        return _set(False, "asyncpg 未安装（pip install asyncpg）")
    try:
        conn = await _pg_connect()
    except Exception as e:  # noqa: BLE001
        return _set(False, f"连接失败: {e}")
    try:
        await _ensure_schema(conn)
        now = int(time.time())
        for k, v in config.items():
            await conn.execute(
                "INSERT INTO config_kv(key, value, updated_at, updated_by) VALUES($1,$2,$3,$4) "
                "ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, "
                "updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by",
                k,
                v,
                now,
                "admin",
            )
        # 写穿：把刚推上去的配置写进 Redis，保证下次拉取走缓存。
        r = await _redis()
        if r is not None:
            try:
                await r.set(
                    _REDIS_KEY,
                    json.dumps({k: [v, now] for k, v in config.items()}),
                    ex=_REDIS_TTL,
                )
            except Exception:  # noqa: BLE001
                pass
        return _set(True, "")
    except Exception as e:  # noqa: BLE001
        return _set(False, str(e))
    finally:
        await conn.close()


# ── 拉取：先 Redis，未命中再 Postgres 并回填 ──────────────────────
async def pull_config() -> dict[str, tuple[str, int]]:
    """从远端缓存（Redis）读；未命中回源 Postgres 并回填 Redis。

    返回 {key: (value, updated_at)}。
    """
    # 1) 远端缓存：Redis
    r = await _redis()
    if r is not None:
        try:
            raw = await r.get(_REDIS_KEY)
            if raw:
                return {k: (v[0], v[1]) for k, v in json.loads(raw).items()}
        except Exception:  # noqa: BLE001
            pass
    # 2) 缓存未命中：回源 Postgres
    if not _remote_dsn or not _pg_driver():
        return {}
    try:
        conn = await _pg_connect()
    except Exception:  # noqa: BLE001
        return {}
    try:
        rows = await conn.fetch("SELECT key, value, updated_at FROM config_kv")
        out = {row["key"]: (row["value"], row["updated_at"]) for row in rows}
        # 3) 回填 Redis，避免下次再打 Postgres
        if r is not None:
            try:
                await r.set(_REDIS_KEY, json.dumps(out), ex=_REDIS_TTL)
            except Exception:  # noqa: BLE001
                pass
        return out
    except Exception:  # noqa: BLE001
        return {}
    finally:
        await conn.close()


def status() -> dict[str, Any]:
    return dict(_last)


def _set(ok: bool, err: str) -> dict[str, Any]:
    _last["last_ok"] = ok
    _last["last_error"] = err or None
    _last["last_sync"] = time.time()
    _last["driver"] = _pg_driver()
    return {"ok": ok, "error": err or None}
