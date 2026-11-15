"""配置存储统一接口（facade）：调用方无感地读写「本地缓存 + 本地 SQLite + 远程 Postgres」。

为什么要有这一层：
    用户要求缓存、本地库、远程库三者同步，且「调用方无感」。把这套逻辑收口成一个
    接口后，openai_voice_server 的 config_value、管理面板的读写、启动播种、远程
    同步都只跟本模块打交道，不用关心：读命中内存缓存还是 SQLite、写入要不要推远程、
    远程没配时怎么降级。

职责划分：
    - 本地读 / 写 / 缓存：voice_db（SQLite + write-through 内存缓存）
    - 远程同步：voice_sync（Postgres，懒加载、带远程缓存、优雅降级）
    - 本模块负责把两者编排成「本地与远程最终一致」。
"""

from __future__ import annotations

import voice_db
import voice_sync
from typing import Any


class ConfigStore:
    def __init__(self, db_path: str, remote_dsn: str | None = None, redis_url: str | None = None):
        self.db_path = db_path
        self.remote_dsn = remote_dsn
        self.redis_url = redis_url
        voice_db.configure(db_path)
        voice_db.ensure_schema()
        voice_sync.configure(remote_dsn, redis_url)

    # ── 首次初始化：从 voice.conf 播种（仅 DB 为空时）─────────────
    def seed_from_conf(self, conf: dict[str, str]) -> int:
        return voice_db.seed_from_conf(conf)

    # ── 本地读（调用方无感：内部走内存缓存，未命中回 SQLite）──────
    def get(self, key: str, default: str | None = None) -> str | None:
        return voice_db.get_config(key, default)

    def all(self) -> dict[str, str]:
        return voice_db.load_config()

    # ── 本地写（write-through 缓存 + 落库）───────────────────────
    def set(self, key: str, value: str) -> None:
        voice_db.set_config(key, value)

    def bulk(self, patch: dict[str, str], actor: str = "admin") -> None:
        voice_db.set_config_bulk(patch, actor)

    # ── 远程同步（异步，由 async handler / 启动钩子调用）──────────
    async def sync_push(self) -> dict[str, Any]:
        """本地 -> 远端。"""
        return await voice_sync.push_config(voice_db.load_config())

    async def sync_pull(self) -> dict[str, Any]:
        """远端 -> 本地（按 updated_at 合并，避免把旧值覆盖新值）。"""
        pulled = await voice_sync.pull_config()
        if pulled:
            voice_db.apply_remote(pulled)
        return pulled

    async def sync_full(self) -> dict[str, Any]:
        """双向合并：先拉远端到本地，再把本地推到远端，最终两边收敛。"""
        await self.sync_pull()
        return await self.sync_push()

    # ── 状态（管理面板展示）──────────────────────────────────────
    def status(self) -> dict[str, Any]:
        return {
            "db_path": self.db_path,
            "stats": voice_db.stats(),
            "remote": voice_sync.status(),
        }


_store: ConfigStore | None = None


def configure(db_path: str, remote_dsn: str | None = None, redis_url: str | None = None) -> ConfigStore:
    """主文件启动时调用，建立全局唯一存储实例。"""
    global _store
    _store = ConfigStore(db_path, remote_dsn, redis_url)
    return _store


def instance() -> ConfigStore:
    if _store is None:
        raise RuntimeError("config_store 尚未 configure()")
    return _store
