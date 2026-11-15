"""本地管理数据库（SQLite）：语音代理配置的「唯一真相源」+ 运行事件 / 审计日志。

为什么是 SQLite：
    用户要求本地用 SQLite 管理配置；把它作为配置的真相源，voice.conf 退化为
    首次初始化与兜底（DB 为空时从它播种）。所有读配置走内存缓存，避免每次请求
    都打 SQLite。

缓存（本地）：
    - config_kv 全量缓存在内存（_cache），TTL 5s 兜底防脏读；
    - 写操作走 write-through：落库同时更新缓存，读几乎零延迟；
    - 事件 / 审计只追加，不进热路径，无需缓存。

为什么不放 Node 网关：管理面板挂在 Python 代理同一进程（9529），DB 也由它独占
读写最自然；远程库（Postgres）只做同步镜像，见 voice_sync.py。
"""

from __future__ import annotations

import os
import json
import sqlite3
import threading
import time
from typing import Any

import catalog  # 目录种子数据（seed/*.json）

# ── 连接与缓存（模块级单例）────────────────────────────────────────
_db_path: str | None = None
_conn: sqlite3.Connection | None = None
_lock = threading.Lock()
_auto_seed = True

# 配置热缓存：全量 key->value；TTL 兜底，写时立即失效。
_cache: dict[str, str] = {}
_cache_ts = 0.0
_CACHE_TTL = 5.0

# 事件 / 审计保留上限，避免日志无限膨胀把磁盘吃满。
_MAX_EVENTS = 5000
_MAX_AUDIT = 5000


def configure(db_path: str) -> None:
    """主文件在运行目录确定后调用，指定 voice.db 的位置。"""
    global _db_path
    _db_path = os.path.abspath(os.path.expanduser(db_path))


def set_auto_seed(enabled: bool) -> None:
    """是否在建表 / 升级后自动播种目录。

    默认开启（服务启动即可用）；`init_catalog.py` 会关掉它，改由脚本自己灌库并
    如实报告「新增 / 更新」了多少条，避免出现「脚本没写、计数却是 0 新增」的假象。
    """
    global _auto_seed
    _auto_seed = bool(enabled)


def _conn_get() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        # check_same_thread=False：FastAPI 异步 handler 可能在不同线程回调。
        _conn = sqlite3.connect(_db_path, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
    return _conn


# 管理员会话有效期（秒），与 admin_panel.SESSION_TTL 保持一致。
SESSION_TTL = 3600 * 8

# 当前 schema 版本；新增表 / 列时 +1，并在 SCHEMA_CHANGES 里登记这次变更。
SCHEMA_VERSION = 7

# 每次表结构变更的留痕：version -> (变更说明, DDL 指令列表)。
# 指令 "col:表:列:类型" 表示 ALTER TABLE ADD COLUMN（先判断是否已存在，幂等）；
# 建表统一由 ensure_schema() 的 CREATE TABLE IF NOT EXISTS 负责，这里只记说明。
# 历史 v1~v6 按当前结构补录；从 v7 起每次结构变化都必须在此登记 + 版本号 +1。
SCHEMA_CHANGES: dict[int, tuple[str, list[str]]] = {
    1: ("初始结构：config_kv / events / audit / health_snapshots / admin_sessions", []),
    2: ("config_kv 增加 updated_by；events 增加 meta",
        ["col:config_kv:updated_by:TEXT", "col:events:meta:TEXT"]),
    3: ("新增 voices 表：音色目录（内置 edge-tts + 全部 dashscope 音色），含 provider/model/中英描述/默认标记", []),
    4: ("新增 speech_models 表：ASR/TTS 模型目录，按 kind + provider 维护，每 provider 一个默认模型", []),
    5: ("speech_models 增加 protocol 列：调用形态 http / ws / http-async（不含厂商名）",
        ["col:speech_models:protocol:TEXT NOT NULL DEFAULT ''"]),
    6: ("新增 enabled_speech_models 表：实际启用（用户勾选）的模型，与基础库 speech_models 严格分离；"
        "基础库只由 seed/init_catalog.py 维护，保存动作按 (kind, provider) 整体替换启用表", []),
    7: ("schema_version 增加 description 列，按版本逐级记录表结构变更；补齐 v1~v6 历史说明",
        ["col:schema_version:description:TEXT"]),
}


def ensure_schema() -> None:
    """建表（幂等）+ 版本管理。首次运行、或升级新增表 / 列时都安全。"""
    c = _conn_get()
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS schema_version (
            version     INTEGER PRIMARY KEY,
            applied_at  INTEGER,
            description TEXT          -- 该版本做了什么表结构变更（见 SCHEMA_CHANGES）
        );
        -- 配置键值表：配置的真相源。updated_by 记录最近修改者（审计用）。
        CREATE TABLE IF NOT EXISTS config_kv (
            key        TEXT PRIMARY KEY,
            value      TEXT,
            updated_at INTEGER NOT NULL,
            updated_by TEXT
        );
        -- 运行事件流（启动 / 健康 / 错误），meta 存 JSON 附加信息。
        CREATE TABLE IF NOT EXISTS events (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      INTEGER NOT NULL,
            level   TEXT NOT NULL DEFAULT 'info',
            source  TEXT,
            message TEXT NOT NULL,
            meta    TEXT
        );
        -- 配置变更审计（谁、什么时候、改了什么）。
        CREATE TABLE IF NOT EXISTS audit (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      INTEGER NOT NULL,
            actor   TEXT,
            action  TEXT NOT NULL,
            detail  TEXT
        );
        -- 健康快照历史（周期写入 /health，便于排查）。
        CREATE TABLE IF NOT EXISTS health_snapshots (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      INTEGER NOT NULL,
            payload TEXT
        );
        -- 管理员登录会话：落库后可跨重启 / 多实例保持一致（不再因重启掉登录）。
        CREATE TABLE IF NOT EXISTS admin_sessions (
            token      TEXT PRIMARY KEY,
            username   TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        -- 音色目录：每条带 provider / model 与中英描述，供 /voice/v1/audio/voices 查询。
        -- 用表维护（不再硬编码），首次初始化时播种内置(edge-tts) + 全部 dashscope 音色。
        CREATE TABLE IF NOT EXISTS voices (
            id         TEXT PRIMARY KEY,
            provider   TEXT NOT NULL DEFAULT 'builtin',
            model      TEXT NOT NULL DEFAULT '',
            desc_zh    TEXT,
            desc_en    TEXT,
            sort       INTEGER NOT NULL DEFAULT 0,
            is_default INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_voices_pm ON voices(provider, model);
        -- ASR / TTS 模型目录：按 kind('stt'/'tts') + provider 维护，每 provider 一个默认模型。
        -- protocol 是「调用形态」线协议（http / ws / http-async），与 LLM 侧「协议 ≠ 厂商」
        -- 口径一致：不带厂商名/引擎名，厂商由 provider 列单独表达；同一 provider 下可有多种形态。
        -- 与 voices 表配合：voices 的 (provider, model) 指向这里的模型；用表维护不再硬编码。
        CREATE TABLE IF NOT EXISTS speech_models (
            kind       TEXT NOT NULL,
            provider   TEXT NOT NULL,
            protocol   TEXT NOT NULL DEFAULT '',
            model      TEXT NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0,
            sort       INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(kind, provider, model)
        );
        CREATE INDEX IF NOT EXISTS idx_speech_models_kp ON speech_models(kind, provider);
        -- 实际启用的模型（用户在配置页勾选的）：与「基础模型库」speech_models 严格分开。
        -- speech_models 只由 seed / init_catalog.py 维护，是全量官方目录，保存动作绝不写它；
        -- 这张表只存「当前真正要用上的」模型，按 (kind, provider) 整体替换，取消勾选即删除。
        CREATE TABLE IF NOT EXISTS enabled_speech_models (
            kind       TEXT NOT NULL,
            provider   TEXT NOT NULL,
            model      TEXT NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0,
            sort       INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(kind, provider, model)
        );
        CREATE INDEX IF NOT EXISTS idx_enabled_models_kp ON enabled_speech_models(kind, provider);
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
        CREATE INDEX IF NOT EXISTS idx_health_ts ON health_snapshots(ts);
        CREATE INDEX IF NOT EXISTS idx_sessions_exp ON admin_sessions(expires_at);
        """
    )
    c.commit()
    _migrate()
    # 启用表迁移与 schema 版本无关：老库已是最新版但启用表为空时（例如升级后
    # 第一次启动、或表被清空）也要能从旧 config_kv 勾选清单补回来。
    if _auto_seed:
        _seed_enabled_from_config()


def _has_column(table: str, col: str) -> bool:
    rows = _conn_get().execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == col for r in rows)


def _apply_change_ddl(c: sqlite3.Connection, instruction: str) -> None:
    """执行一条幂等的迁移指令；目前只支持给已有表补列。"""
    parts = instruction.split(":")
    if len(parts) != 4 or parts[0] != "col":
        return
    _, table, column, decl = parts
    if not _has_column(table, column):
        c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def schema_history() -> list[dict[str, Any]]:
    """按版本返回表结构变更记录（含说明与应用时间），供管理面板 / 运维查看。"""
    if _db_path is None:
        return []
    rows = _conn_get().execute(
        "SELECT version, applied_at, description FROM schema_version ORDER BY version"
    ).fetchall()
    return [dict(r) for r in rows]


def _migrate() -> None:
    """按版本逐级应用表结构变更，每个版本在 schema_version 里留一条带说明的记录。

    与旧实现的区别：不再「一次性把版本号刷到最新」，而是 current+1 .. SCHEMA_VERSION
    逐级执行各自的 DDL 并登记说明；老库里已存在的版本行会补上历史说明（v1~v6 补录）。
    所有建表 / 补列都是幂等的，跨版本升级、重复启动都安全。
    """
    c = _conn_get()
    # 所有补列 DDL 无条件幂等执行一遍（用 _has_column 判断），与版本号无关：
    # 老库可能版本行已存在但列缺失（升级中断 / 手工改过），这样也能自愈。
    # 版本记录只负责「留痕」，不负责决定要不要执行 DDL。
    if not _has_column("schema_version", "description"):
        c.execute("ALTER TABLE schema_version ADD COLUMN description TEXT")
    for _desc, ddl in SCHEMA_CHANGES.values():
        for instruction in ddl:
            _apply_change_ddl(c, instruction)
    c.commit()

    row = c.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
    current = int(row["v"] or 0)

    # 历史行补录说明（老库升级时这些行已存在但没有 description）
    for version, (desc, _ddl) in SCHEMA_CHANGES.items():
        if version <= current:
            c.execute(
                "UPDATE schema_version SET description=COALESCE(description, ?) "
                "WHERE version=? AND (description IS NULL OR description='')",
                (desc, version),
            )

    # 逐级应用缺失的版本
    for version in range(current + 1, SCHEMA_VERSION + 1):
        desc, _ddl = SCHEMA_CHANGES.get(version, ("", []))
        c.execute(
            "INSERT OR REPLACE INTO schema_version(version, applied_at, description) "
            "VALUES(?,?,?)",
            (version, int(time.time()), desc),
        )

    c.commit()
    # 音色 / 模型基础库首次建好后播种（内置 + dashscope + deepseek；表已有数据则跳过）。
    if _auto_seed:
        _seed_voices()
        _seed_speech_models()


# ── 管理员会话（落库）──────────────────────────────────────────────
def session_create(token: str, username: str, ttl: int = SESSION_TTL) -> None:
    now = int(time.time())
    with _lock:
        cur = _conn_get()
        # 顺手清掉过期会话，避免表无限增长。
        cur.execute("DELETE FROM admin_sessions WHERE expires_at < ?", (now,))
        cur.execute(
            "INSERT INTO admin_sessions(token, username, created_at, expires_at) "
            "VALUES(?,?,?,?)",
            (token, username, now, now + ttl),
        )
        cur.commit()


def session_valid(token: str | None) -> bool:
    if not token:
        return False
    now = int(time.time())
    row = _conn_get().execute(
        "SELECT expires_at FROM admin_sessions WHERE token=?", (token,)
    ).fetchone()
    if not row:
        return False
    if row["expires_at"] < now:
        with _lock:
            _conn_get().execute("DELETE FROM admin_sessions WHERE token=?", (token,))
            _conn_get().commit()
        return False
    return True


def session_destroy(token: str | None) -> None:
    if not token:
        return
    with _lock:
        _conn_get().execute("DELETE FROM admin_sessions WHERE token=?", (token,))
        _conn_get().commit()


def seed_from_conf(conf: dict[str, str]) -> int:
    """DB 为空时从 voice.conf 播种；返回新增的键数。

    已有时绝不回写，保证「DB 是真相源」——之后手改 voice.conf 不会覆盖 DB。
    """
    with _lock:
        cur = _conn_get()
        existing = {
            r["key"] for r in cur.execute("SELECT key FROM config_kv").fetchall()
        }
        now = int(time.time())
        added = 0
        for k, v in conf.items():
            if k in existing:
                continue
            cur.execute(
                "INSERT INTO config_kv(key, value, updated_at) VALUES(?,?,?)",
                (k, v, now),
            )
            added += 1
        if added:
            cur.commit()
            _invalidate_cache()
    return added


# ── 配置缓存 ───────────────────────────────────────────────────────
def _load_cache(force: bool = False) -> None:
    global _cache, _cache_ts
    now = time.time()
    if not force and _cache and now - _cache_ts < _CACHE_TTL:
        return
    with _lock:
        if _cache and not force and now - _cache_ts < _CACHE_TTL:
            return
        rows = _conn_get().execute("SELECT key, value FROM config_kv").fetchall()
        _cache = {r["key"]: r["value"] for r in rows}
        _cache_ts = time.time()


def _invalidate_cache() -> None:
    global _cache_ts
    _cache_ts = 0.0


def get_config(key: str, default: str | None = None) -> str | None:
    """带缓存读取单键；DB 未配置或键不存在返回 default。"""
    if _db_path is None:
        return default
    _load_cache()
    v = _cache.get(key)
    return v if v is not None else default


def load_config() -> dict[str, str]:
    """全量配置（缓存）。"""
    if _db_path is None:
        return {}
    _load_cache()
    return dict(_cache)


def set_config(key: str, value: str) -> None:
    """单键写入：落库 + write-through 缓存。"""
    _set_config_raw(key, value, int(time.time()))


def _set_config_raw(key: str, value: str, updated_at: int) -> None:
    """底层写入（允许指定 updated_at，供远程同步回写本地时保留远端时间戳）。"""
    with _lock:
        _conn_get().execute(
            "INSERT INTO config_kv(key, value, updated_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, updated_at),
        )
        _conn_get().commit()
    _cache[key] = value
    _cache_ts = time.time()


def dump_config_ts() -> dict[str, tuple[str, int]]:
    """全量配置 + 时间戳，供远程同步做按时间合并。"""
    if _db_path is None:
        return {}
    _load_cache()
    rows = _conn_get().execute(
        "SELECT key, value, updated_at FROM config_kv"
    ).fetchall()
    return {r["key"]: (r["value"], r["updated_at"]) for r in rows}


def apply_remote(patch: dict[str, tuple[str, int]]) -> int:
    """把远端拉来的 (value, updated_at) 写回本地；返回更新的键数。"""
    updated = 0
    with _lock:
        now = int(time.time())
        cur = _conn_get()
        for k, (v, ts) in patch.items():
            cur.execute(
                "INSERT INTO config_kv(key, value, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at "
                "WHERE excluded.updated_at > config_kv.updated_at",
                (k, v, ts),
            )
            _cache[k] = v
            updated += 1
        cur.commit()
    _cache_ts = time.time()
    return updated


def set_config_bulk(patch: dict[str, str], actor: str = "admin") -> None:
    """批量写入（管理面板保存）。空值=清空该键；调用方自行处理 HIDDEN 哨兵。"""
    with _lock:
        now = int(time.time())
        cur = _conn_get()
        for k, v in patch.items():
            cur.execute(
                "INSERT INTO config_kv(key, value, updated_at, updated_by) VALUES(?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                (k, v, now, actor),
            )
            _cache[k] = v
        cur.commit()
    _cache_ts = time.time()
    append_audit(actor, "config.save", f"keys={','.join(patch.keys())}")


# ── 运行事件 ───────────────────────────────────────────────────────
def append_event(level: str, source: str, message: str, meta: Any = None) -> None:
    meta_json = json.dumps(meta, ensure_ascii=False) if meta is not None else None
    with _lock:
        cur = _conn_get()
        cur.execute(
            "INSERT INTO events(ts, level, source, message, meta) VALUES(?,?,?,?,?)",
            (int(time.time()), level, source, message, meta_json),
        )
        # 超量则删最旧的；用子查询避免一次性拉全表。
        cur.execute(
            "DELETE FROM events WHERE id <= (SELECT MAX(id) - ? FROM events)",
            (_MAX_EVENTS,),
        )
        cur.commit()


def append_health(payload: Any) -> None:
    """周期写入 /health 快照，便于事后排查配置 / 能力变化。"""
    with _lock:
        cur = _conn_get()
        cur.execute(
            "INSERT INTO health_snapshots(ts, payload) VALUES(?,?)",
            (int(time.time()), json.dumps(payload, ensure_ascii=False)),
        )
        cur.execute(
            "DELETE FROM health_snapshots WHERE id <= "
            "(SELECT MAX(id) - ? FROM health_snapshots)",
            (_MAX_EVENTS,),
        )
        cur.commit()


def recent_events(limit: int = 200) -> list[dict[str, Any]]:
    if _db_path is None:
        return []
    rows = (
        _conn_get()
        .execute(
            "SELECT id, ts, level, source, message FROM events "
            "ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        .fetchall()
    )
    return [dict(r) for r in reversed(rows)]


# ── 审计 ───────────────────────────────────────────────────────────
def append_audit(actor: str, action: str, detail: str) -> None:
    with _lock:
        cur = _conn_get()
        cur.execute(
            "INSERT INTO audit(ts, actor, action, detail) VALUES(?,?,?,?)",
            (int(time.time()), actor, action, detail),
        )
        cur.execute(
            "DELETE FROM audit WHERE id <= (SELECT MAX(id) - ? FROM audit)",
            (_MAX_AUDIT,),
        )
        cur.commit()


def recent_audit(limit: int = 50) -> list[dict[str, Any]]:
    if _db_path is None:
        return []
    rows = (
        _conn_get()
        .execute(
            "SELECT id, ts, actor, action, detail FROM audit "
            "ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        .fetchall()
    )
    return [dict(r) for r in reversed(rows)]


def stats() -> dict[str, int]:
    if _db_path is None:
        return {"config": 0, "events": 0, "audit": 0, "health": 0, "sessions": 0,
                "voices": 0, "speech_models": 0, "enabled_models": 0}
    cur = _conn_get()
    return {
        "config": cur.execute("SELECT COUNT(*) FROM config_kv").fetchone()[0],
        "events": cur.execute("SELECT COUNT(*) FROM events").fetchone()[0],
        "audit": cur.execute("SELECT COUNT(*) FROM audit").fetchone()[0],
        "health": cur.execute("SELECT COUNT(*) FROM health_snapshots").fetchone()[0],
        "sessions": cur.execute("SELECT COUNT(*) FROM admin_sessions").fetchone()[0],
        "voices": cur.execute("SELECT COUNT(*) FROM voices").fetchone()[0],
        "speech_models": cur.execute("SELECT COUNT(*) FROM speech_models").fetchone()[0],
        "enabled_models": cur.execute("SELECT COUNT(*) FROM enabled_speech_models").fetchone()[0],
    }


# ── 音色目录（数据库表维护）──────────────────────────────────────────
# 目录数据本体在 `seed/*.json`（见 catalog.py），这里只负责首次建库时灌进去。
# 之所以不写死在代码里：音色 / 模型 / 协议会随上游变化，数据要和代码解耦，
# 换机或升级时用 `init_catalog.py` 重新同步即可。


def _seed_voices() -> None:
    """音色表为空时按 seed 播种（内置 + dashscope + deepseek，每个模型各一个默认音色）。"""
    c = _conn_get()
    if c.execute("SELECT COUNT(*) FROM voices").fetchone()[0]:
        return
    rows = [
        (r["id"], r["provider"], r["model"], r["desc_zh"], r["desc_en"],
         r["sort"], 1 if r["is_default"] else 0)
        for r in catalog.load_voices()
    ]
    if not rows:
        return
    with _lock:
        c.executemany(
            "INSERT OR IGNORE INTO voices(id, provider, model, desc_zh, desc_en, sort, is_default) "
            "VALUES(?,?,?,?,?,?,?)",
            rows,
        )
        c.commit()


def list_voices(provider: str | None = None, model: str | None = None) -> list[dict[str, Any]]:
    """按 provider / model 过滤（均可空）返回音色目录，含 is_default 标记。"""
    if _db_path is None:
        return []
    sql = "SELECT id, provider, model, desc_zh, desc_en, is_default FROM voices"
    clauses: list[str] = []
    args: list[Any] = []
    if provider:
        clauses.append("provider=?")
        args.append(provider)
    if model:
        clauses.append("model=?")
        args.append(model)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY sort, id"
    rows = _conn_get().execute(sql, args).fetchall()
    return [dict(r) for r in rows]


def default_voice(provider: str, model: str) -> str | None:
    """取某 provider+model 的默认音色 id；没有则 None。"""
    if _db_path is None:
        return None
    row = _conn_get().execute(
        "SELECT id FROM voices WHERE provider=? AND model=? AND is_default=1 LIMIT 1",
        (provider, model),
    ).fetchone()
    return row["id"] if row else None


def set_default_voice(provider: str, model: str, voice_id: str) -> bool:
    """把某 provider+model 下的某个音色设为默认（同模型其余取消默认）。"""
    if _db_path is None:
        return False
    with _lock:
        c = _conn_get()
        exists = c.execute("SELECT 1 FROM voices WHERE id=?", (voice_id,)).fetchone()
        if not exists:
            return False
        c.execute("UPDATE voices SET is_default=0 WHERE provider=? AND model=?", (provider, model))
        c.execute("UPDATE voices SET is_default=1 WHERE id=?", (voice_id,))
        c.commit()
    return True


def upsert_voice(
    voice_id: str,
    provider: str,
    model: str,
    desc_zh: str = "",
    desc_en: str = "",
    sort: int = 0,
    is_default: bool = False,
) -> None:
    """新增 / 更新一个音色；is_default=True 时会清掉同 provider+model 的其它默认。"""
    if _db_path is None:
        return
    with _lock:
        c = _conn_get()
        if is_default:
            c.execute("UPDATE voices SET is_default=0 WHERE provider=? AND model=?", (provider, model))
        c.execute(
            "INSERT INTO voices(id, provider, model, desc_zh, desc_en, sort, is_default) "
            "VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, model=excluded.model, "
            "desc_zh=excluded.desc_zh, desc_en=excluded.desc_en, sort=excluded.sort, "
            "is_default=excluded.is_default",
            (voice_id, provider, model, desc_zh, desc_en, sort, 1 if is_default else 0),
        )
        c.commit()


def delete_voice(voice_id: str) -> None:
    if _db_path is None:
        return
    with _lock:
        _conn_get().execute("DELETE FROM voices WHERE id=?", (voice_id,))
        _conn_get().commit()


# ── ASR / TTS 模型目录（数据库表维护）────────────────────────────────
# 数据同样在 seed/speech_models.json，字段：kind / provider / protocol / model / 默认 / 排序。


def _seed_speech_models() -> None:
    """模型表为空时按 seed 播种（含 provider + protocol，每个 provider 一个默认模型）。"""
    c = _conn_get()
    if c.execute("SELECT COUNT(*) FROM speech_models").fetchone()[0]:
        return
    rows = [
        (r["kind"], r["provider"], r["protocol"], r["model"],
         1 if r["is_default"] else 0, r["sort"])
        for r in catalog.load_speech_models()
    ]
    if not rows:
        return
    with _lock:
        c.executemany(
            "INSERT OR IGNORE INTO speech_models(kind, provider, protocol, model, is_default, sort) "
            "VALUES(?,?,?,?,?,?)",
            rows,
        )
        c.commit()


def list_speech_models(kind: str | None = None, provider: str | None = None) -> list[dict[str, Any]]:
    """按 kind('stt'/'tts') / provider 过滤（均可空）返回模型目录，含 is_default。"""
    if _db_path is None:
        return []
    sql = "SELECT kind, provider, protocol, model, is_default, sort FROM speech_models"
    clauses: list[str] = []
    args: list[Any] = []
    if kind:
        clauses.append("kind=?")
        args.append(kind)
    if provider:
        clauses.append("provider=?")
        args.append(provider)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY kind, sort, model"
    rows = _conn_get().execute(sql, args).fetchall()
    return [dict(r) for r in rows]


def default_speech_model(kind: str, provider: str) -> str | None:
    """取某 kind+provider 的默认模型；没有则 None。"""
    if _db_path is None:
        return None
    row = _conn_get().execute(
        "SELECT model FROM speech_models WHERE kind=? AND provider=? AND is_default=1 LIMIT 1",
        (kind, provider),
    ).fetchone()
    return row["model"] if row else None


def set_default_speech_model(kind: str, provider: str, model: str) -> bool:
    if _db_path is None:
        return False
    with _lock:
        c = _conn_get()
        exists = c.execute(
            "SELECT 1 FROM speech_models WHERE kind=? AND provider=? AND model=?",
            (kind, provider, model),
        ).fetchone()
        if not exists:
            return False
        c.execute("UPDATE speech_models SET is_default=0 WHERE kind=? AND provider=?", (kind, provider))
        c.execute(
            "UPDATE speech_models SET is_default=1 WHERE kind=? AND provider=? AND model=?",
            (kind, provider, model),
        )
        c.commit()
    return True


def upsert_speech_model(
    kind: str,
    provider: str,
    model: str,
    *,
    protocol: str = "",
    is_default: bool = False,
    sort: int = 0,
) -> None:
    """新增 / 更新一个 ASR-TTS 模型；protocol 留空表示不覆盖已有协议。"""
    if _db_path is None:
        return
    with _lock:
        c = _conn_get()
        if is_default:
            c.execute("UPDATE speech_models SET is_default=0 WHERE kind=? AND provider=?", (kind, provider))
        c.execute(
            "INSERT INTO speech_models(kind, provider, protocol, model, is_default, sort) "
            "VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(kind, provider, model) DO UPDATE SET "
            "protocol=COALESCE(NULLIF(excluded.protocol,''), speech_models.protocol), "
            "is_default=excluded.is_default, sort=excluded.sort",
            (kind, provider, (protocol or "").strip(), model, 1 if is_default else 0, sort),
        )
        c.commit()


def model_protocol(kind: str, provider: str, model: str) -> str:
    """取某模型的调用协议（http / ws / http-async）；查不到返回空串。"""
    if _db_path is None:
        return ""
    row = _conn_get().execute(
        "SELECT protocol FROM speech_models WHERE kind=? AND provider=? AND model=?",
        (kind, provider, model),
    ).fetchone()
    return (row["protocol"] or "") if row else ""


def set_speech_model_protocol(kind: str, provider: str, model: str, protocol: str) -> None:
    """只补协议，不动默认 / 排序（老库升级补字段时用，避免覆盖用户的选择）。"""
    if _db_path is None:
        return
    with _lock:
        c = _conn_get()
        c.execute(
            "UPDATE speech_models SET protocol=? WHERE kind=? AND provider=? AND model=?",
            ((protocol or "").strip(), kind, provider, model),
        )
        c.commit()



def delete_voices_by_provider(provider: str) -> int:
    """删除某提供商的全部音色（初始化脚本 --reset 用）。返回删除行数。"""
    if _db_path is None:
        return 0
    with _lock:
        c = _conn_get()
        n = c.execute("DELETE FROM voices WHERE provider=?", (provider,)).rowcount
        c.commit()
    return int(n or 0)


def delete_speech_models_by_provider(provider: str) -> int:
    """删除某提供商的全部 ASR/TTS 模型（初始化脚本 --reset 用）。返回删除行数。"""
    if _db_path is None:
        return 0
    with _lock:
        c = _conn_get()
        n = c.execute("DELETE FROM speech_models WHERE provider=?", (provider,)).rowcount
        c.commit()
    return int(n or 0)



def delete_speech_model(kind: str, provider: str, model: str) -> None:
    if _db_path is None:
        return
    with _lock:
        _conn_get().execute(
            "DELETE FROM speech_models WHERE kind=? AND provider=? AND model=?",
            (kind, provider, model),
        )
        _conn_get().commit()


# ── 实际启用的模型（勾选数据）──────────────────────────────────────
# 与基础库 speech_models 严格分离：这里是「当前真正要用上的」模型，由配置页保存时
# 按 (kind, provider) 整体替换；基础库只由 seed / init_catalog.py 维护，保存动作不碰。


def list_enabled_models(
    kind: str | None = None, provider: str | None = None
) -> list[dict[str, Any]]:
    """列出实际启用的模型；按 kind / provider 过滤（均可空）。"""
    if _db_path is None:
        return []
    sql = "SELECT kind, provider, model, is_default, sort FROM enabled_speech_models"
    clauses: list[str] = []
    args: list[Any] = []
    if kind:
        clauses.append("kind=?")
        args.append(kind)
    if provider:
        clauses.append("provider=?")
        args.append(provider)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY kind, sort, model"
    return [dict(r) for r in _conn_get().execute(sql, args).fetchall()]


def enabled_models(kind: str, provider: str) -> list[str]:
    """某 kind+provider 下实际启用的模型名（按 sort 顺序）。"""
    return [r["model"] for r in list_enabled_models(kind, provider)]


def enabled_default_model(kind: str, provider: str) -> str | None:
    """某 kind+provider 下实际启用的默认模型；没有则取第一个启用模型。"""
    rows = list_enabled_models(kind, provider)
    for r in rows:
        if r["is_default"]:
            return r["model"]
    return rows[0]["model"] if rows else None


def replace_enabled_models(
    kind: str, provider: str, models: list[str], default_model: str = ""
) -> None:
    """整体替换某 kind+provider 的启用清单：取消勾选的模型会被真正删除。

    models 为空表示全部取消。默认模型必须在清单内，否则不标默认（由调用方回退）。
    """
    if _db_path is None:
        return
    seen: set[str] = set()
    clean: list[str] = []
    for m in models:
        m = (m or "").strip()
        if m and m not in seen:
            seen.add(m)
            clean.append(m)
    default_model = (default_model or "").strip()
    if default_model not in clean:
        default_model = clean[0] if clean else ""
    with _lock:
        c = _conn_get()
        c.execute(
            "DELETE FROM enabled_speech_models WHERE kind=? AND provider=?",
            (kind, provider),
        )
        c.executemany(
            "INSERT INTO enabled_speech_models(kind, provider, model, is_default, sort) "
            "VALUES(?,?,?,?,?)",
            [
                (kind, provider, m, 1 if m == default_model else 0, i)
                for i, m in enumerate(clean)
            ],
        )
        c.commit()


# 旧配置里勾选清单存在 config_kv；升级到「两张表」时迁移进启用表，避免升级后页面全不勾。
_CONFIG_TO_ENABLED = (
    ("stt", "dashscope", "STT_UPSTREAM_MODELS", "STT_UPSTREAM_MODEL"),
    ("tts", "dashscope", "TTS_UPSTREAM_MODELS", "TTS_UPSTREAM_MODEL"),
    ("stt", "deepseek", "STT_DEEPSEEK_MODELS", "STT_DEEPSEEK_MODEL"),
    ("tts", "deepseek", "TTS_DEEPSEEK_MODELS", "TTS_DEEPSEEK_MODEL"),
)


def _seed_enabled_from_config() -> None:
    """启用表为空时，从旧 config_kv 勾选清单迁移一次（幂等）。"""
    c = _conn_get()
    if c.execute("SELECT COUNT(*) FROM enabled_speech_models").fetchone()[0]:
        return
    rows = 0
    for kind, provider, models_key, def_key in _CONFIG_TO_ENABLED:
        raw = c.execute("SELECT value FROM config_kv WHERE key=?", (models_key,)).fetchone()
        default = c.execute("SELECT value FROM config_kv WHERE key=?", (def_key,)).fetchone()
        try:
            models = json.loads(raw["value"]) if raw and raw["value"] else []
        except (ValueError, TypeError):
            models = []
        if not isinstance(models, list):
            models = []
        clean = [m.strip() for m in models if isinstance(m, str) and m.strip()]
        dm = (default["value"] or "").strip() if default else ""
        # 旧配置可能默认模型为空 / 指向已不在清单里的模型：标清单第一个，
        # 保证每个有勾选的 (kind, provider) 都有一个默认模型。
        if dm not in clean:
            dm = clean[0] if clean else ""
        with _lock:
            c.execute(
                "DELETE FROM enabled_speech_models WHERE kind=? AND provider=?",
                (kind, provider),
            )
            c.executemany(
                "INSERT INTO enabled_speech_models(kind, provider, model, is_default, sort) "
                "VALUES(?,?,?,?,?)",
                [
                    (kind, provider, m, 1 if m == dm else 0, i)
                    for i, m in enumerate(clean)
                ],
            )
        rows += len(clean)
    # 内置是固定白名单，也登记为启用，保证「实际要用上的」清单完整
    with _lock:
        c.execute(
            "INSERT OR IGNORE INTO enabled_speech_models(kind, provider, model, is_default, sort) "
            "VALUES(?,?,?,?,?)", ("stt", "builtin", "sensevoice-small", 1, 0)
        )
        c.execute(
            "INSERT OR IGNORE INTO enabled_speech_models(kind, provider, model, is_default, sort) "
            "VALUES(?,?,?,?,?)", ("tts", "builtin", "edge-tts", 1, 0)
        )
        c.commit()
