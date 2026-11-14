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

# 当前 schema 版本；新增表 / 列时 +1，并在 _migrate() 里补 DDL。
SCHEMA_VERSION = 5


def ensure_schema() -> None:
    """建表（幂等）+ 版本管理。首次运行、或升级新增表 / 列时都安全。"""
    c = _conn_get()
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS schema_version (
            version   INTEGER PRIMARY KEY,
            applied_at INTEGER
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
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
        CREATE INDEX IF NOT EXISTS idx_health_ts ON health_snapshots(ts);
        CREATE INDEX IF NOT EXISTS idx_sessions_exp ON admin_sessions(expires_at);
        """
    )
    c.commit()
    _migrate()


def _has_column(table: str, col: str) -> bool:
    rows = _conn_get().execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == col for r in rows)


def _migrate() -> None:
    """按版本补增量 DDL；旧库缺列时用 ALTER TABLE 补齐（新列都可空，安全）。"""
    c = _conn_get()
    row = c.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").fetchone()
    current = row["version"] if row else 0
    if current >= SCHEMA_VERSION:
        return
    # 给已存在的旧表补列：SQLite 仅支持 ADD COLUMN，且新增列均可为空。
    if not _has_column("config_kv", "updated_by"):
        c.execute("ALTER TABLE config_kv ADD COLUMN updated_by TEXT")
    if not _has_column("events", "meta"):
        c.execute("ALTER TABLE events ADD COLUMN meta TEXT")
    if not _has_column("speech_models", "protocol"):
        c.execute("ALTER TABLE speech_models ADD COLUMN protocol TEXT NOT NULL DEFAULT ''")
    # 未来升级在此追加 ALTER / CREATE。
    c.execute(
        "INSERT INTO schema_version(version, applied_at) VALUES(?,?)",
        (SCHEMA_VERSION, int(time.time())),
    )
    c.commit()
    # 音色 / 模型表首次建好后播种（内置 + dashscope + deepseek；表已有数据则跳过）。
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
        return {"config": 0, "events": 0, "audit": 0, "health": 0, "sessions": 0, "voices": 0}
    cur = _conn_get()
    return {
        "config": cur.execute("SELECT COUNT(*) FROM config_kv").fetchone()[0],
        "events": cur.execute("SELECT COUNT(*) FROM events").fetchone()[0],
        "audit": cur.execute("SELECT COUNT(*) FROM audit").fetchone()[0],
        "health": cur.execute("SELECT COUNT(*) FROM health_snapshots").fetchone()[0],
        "sessions": cur.execute("SELECT COUNT(*) FROM admin_sessions").fetchone()[0],
        "voices": cur.execute("SELECT COUNT(*) FROM voices").fetchone()[0],
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
