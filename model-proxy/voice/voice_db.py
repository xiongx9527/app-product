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

import hashlib
import ipaddress
import os
import json
import re
import sqlite3
import threading
import time
from typing import Any

import catalog  # 目录种子数据（seed/*.json）

# ── 连接与缓存（模块级单例）────────────────────────────────────────
_db_path: str | None = None
# 每线程一条连接：共享单连接被线程池并发 execute() 会触发 sqlite3.InterfaceError。
_conn_local = threading.local()
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
    """主文件在运行目录确定后调用，指定 voice.db 的位置。

    切换库路径时重置本线程连接与配置缓存，避免连到旧库 / 读到旧缓存（单实例启动
    只调一次不受影响；测试 / 多库切换场景必须重置）。
    """
    global _db_path
    new_path = os.path.abspath(os.path.expanduser(db_path))
    if new_path != _db_path:
        old = getattr(_conn_local, "c", None)
        if old is not None:
            try:
                old.close()
            finally:
                _conn_local.c = None
        _invalidate_cache()
    _db_path = new_path


def set_auto_seed(enabled: bool) -> None:
    """是否在建表 / 升级后自动播种目录。

    默认开启（服务启动即可用）；`init_catalog.py` 会关掉它，改由脚本自己灌库并
    如实报告「新增 / 更新」了多少条，避免出现「脚本没写、计数却是 0 新增」的假象。
    """
    global _auto_seed
    _auto_seed = bool(enabled)


def _conn_get() -> sqlite3.Connection:
    # 每个线程各持一条连接，避免单连接被 anyio 线程池并发 execute() 时触发
    # sqlite3.InterfaceError（bad parameter or other API misuse）——这是 admin
    # 请求偶发 500、保存偶发未落库的根因。写操作仍由 _lock 串行化，防止多
    # 条连接同时写造成 database is locked。
    c = getattr(_conn_local, "c", None)
    if c is None:
        c = sqlite3.connect(_db_path, check_same_thread=False, timeout=5.0)
        c.row_factory = sqlite3.Row
        _conn_local.c = c
    return c


# 管理员会话有效期（秒），与 admin_panel.SESSION_TTL 保持一致。
SESSION_TTL = 3600 * 8

# 当前 schema 版本；新增表 / 列时 +1，并在 SCHEMA_CHANGES 里登记这次变更。
SCHEMA_VERSION = 14

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
    8: ("新增 asr_corrections + asr_correction_variants 两表：ASR 同音错词→正确词（与主表一对多），"
        "作为所有客户端共享的纠错词表权威源（learn_correction 工具写入，网关静默同步）", []),
    9: ("新增 admin_credentials 表：管理面板账号密码（独立表，不写 config_kv，避免被 voice_sync "
        "推到远端 Postgres/Redis）；SCHEMA_VERSION 常量与 SCHEMA_CHANGES 版本对齐（原常量滞后到 v7）", []),
    10: ("新增 admin_users（多账号 + 角色 viewer/operator/admin、内置管理员标记、禁用）与 "
        "admin_api_keys（API Key 哈希管理 + 启停 + 生效/失效时间 + 绑定 IP + owner 预留）两表；"
        "存量 admin_credentials 迁为内置管理员、存量 VOICE_API_KEY/auto key 哈希入库", []),
    11: ("新增 rate_policies（限流策略：4 维阈值 + 默认标记）与 rate_policy_bindings（key↔策略多对多）两表；"
        "admin_api_keys 曾加 rate_limit_enabled 列（v12 已废弃删除，改由全局 RATE_LIMIT_ENABLED 统一控制）", []),
    12: ("删除 admin_api_keys.rate_limit_enabled 列（per-key 限流开关废弃；限流只由全局开关 + 策略绑定控制）", []),
    13: ("rate_policies 加 is_builtin 列（内置策略，不可删/禁，作没绑策略时的唯一兜底）；"
        "is_default 允许多个（去掉其唯一索引），改给 is_builtin 加唯一索引",
        ["col:rate_policies:is_builtin:INTEGER NOT NULL DEFAULT 0"]),
    14: ("rate_policies 加 period 列（限流时间单位 minute/hour/day/week/month，默认 minute）",
        ["col:rate_policies:period:TEXT NOT NULL DEFAULT 'minute'"]),
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
        -- 管理面板账号密码：独立表，不写 config_kv（config_kv 会被 voice_sync 全量
        -- 推到远端 Postgres + Redis 缓存，密码进去等于明文同步到远端）。单行表，id 固定 1。
        CREATE TABLE IF NOT EXISTS admin_credentials (
            id         INTEGER PRIMARY KEY CHECK(id = 1),
            username   TEXT NOT NULL,
            password   TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        -- 管理面板多账号（v10）：username 唯一；role=viewer/operator/admin；is_builtin 为
        -- 内置管理员（不可删/改角色/禁用/被重置密码，只能自己改）。同样不进 config_kv。
        CREATE TABLE IF NOT EXISTS admin_users (
            username   TEXT PRIMARY KEY,
            password   TEXT NOT NULL,
            role       TEXT NOT NULL DEFAULT 'viewer',
            enabled    INTEGER NOT NULL DEFAULT 1,
            is_builtin INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_builtin
            ON admin_users(is_builtin) WHERE is_builtin = 1;
        -- API Key（v10）：只存哈希，不存明文。not_before/expires_at 为秒级 epoch（NULL=不限）；
        -- allowed_ips 为 JSON 数组（空=不额外限制）；owner_* 为将来外部用户预留，本期不用。
        CREATE TABLE IF NOT EXISTS admin_api_keys (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            key_hash    TEXT NOT NULL UNIQUE,
            key_prefix  TEXT NOT NULL,
            name        TEXT NOT NULL DEFAULT '',
            enabled     INTEGER NOT NULL DEFAULT 1,
            not_before  INTEGER,
            expires_at  INTEGER,
            allowed_ips TEXT NOT NULL DEFAULT '[]',
            owner_type  TEXT NOT NULL DEFAULT '',
            owner_id    TEXT NOT NULL DEFAULT '',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON admin_api_keys(key_hash);
        -- 限流策略（v13）：阈值模板，多个 key 可复用；is_builtin 为内置兜底策略（唯一、不可删/禁）。
        -- is_default 仅作标记，允许多个。
        CREATE TABLE IF NOT EXISTS rate_policies (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            name                TEXT NOT NULL UNIQUE,
            description         TEXT,
            req_per_min         INTEGER NOT NULL,
            llm_tokens_per_min  INTEGER NOT NULL,
            asr_seconds_per_min INTEGER NOT NULL,
            tts_chars_per_min   INTEGER NOT NULL,
            enabled             INTEGER NOT NULL DEFAULT 1,
            is_default          INTEGER NOT NULL DEFAULT 0,
            is_builtin          INTEGER NOT NULL DEFAULT 0,
            period              TEXT NOT NULL DEFAULT 'minute',  -- 限流单位 minute/hour/day/week/month
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL
        );
        -- is_builtin 唯一索引在 _migrate() 补列后创建（老库补列前建索引会报 no such column）。
        -- 限流策略绑定（v11）：key ↔ 策略多对多；取所有启用策略的阈值最小值。
        CREATE TABLE IF NOT EXISTS rate_policy_bindings (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            key_id    INTEGER NOT NULL REFERENCES admin_api_keys(id) ON DELETE CASCADE,
            policy_id INTEGER NOT NULL REFERENCES rate_policies(id) ON DELETE CASCADE,
            UNIQUE(key_id, policy_id)
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
        -- ASR 纠错词表（权威源，供所有客户端同步）：主表 correct（正确词，唯一）+ 变体表 wrong（错词）。
        -- 与网关侧 asr_corrections / asr_correction_variants 两表结构一致，同步时联表成 flat {wrong,pinyin,correct}。
        -- learn_correction 工具写入：先 upsert 主表拿 id，再 upsert 变体。
        CREATE TABLE IF NOT EXISTS asr_corrections (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            correct    TEXT NOT NULL UNIQUE,   -- 正确词
            pinyin     TEXT NOT NULL DEFAULT '', -- 正确词拼音
            note       TEXT,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asr_correction_variants (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            correction_id INTEGER NOT NULL,    -- 主表 id
            wrong         TEXT NOT NULL,       -- 错词（识别错的文本）
            pinyin        TEXT NOT NULL DEFAULT '', -- 错词拼音，匹配用它
            note          TEXT,
            updated_at    INTEGER NOT NULL,
            UNIQUE(correction_id, wrong),
            FOREIGN KEY(correction_id) REFERENCES asr_corrections(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_asr_variants_cid ON asr_correction_variants(correction_id);
        CREATE INDEX IF NOT EXISTS idx_asr_variants_pinyin ON asr_correction_variants(pinyin);
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
    # v10 账号迁移：存量 admin_credentials（单行）→ admin_users 的内置管理员，幂等。
    # 纯 DB 内部操作，不读任何外部配置/文件（api-key 迁移由 server 启动时调函数传入）。
    _migrate_admin_users()
    # v11：播种默认限流策略（幂等，库里没有 is_default=1 的策略时建一条）。
    _seed_default_rate_policy()
    # v12：删除废弃的 admin_api_keys.rate_limit_enabled 列（SQLite 3.35+ DROP COLUMN）。
    # 不支持时忽略——该列留着物理存在但代码不再读写，无害。
    try:
        if _has_column("admin_api_keys", "rate_limit_enabled"):
            c.execute("ALTER TABLE admin_api_keys DROP COLUMN rate_limit_enabled")
            c.commit()
    except Exception:  # noqa: BLE001  老 SQLite 不支持 DROP COLUMN 时跳过
        pass
    # v13：限流策略支持多个默认 + 内置标识。
    # 1) 删旧的 is_default 唯一索引（允许多个默认）；2) 把现有 is_default=1 那条标为内置；
    # 3) 建 is_builtin 唯一索引（最多一个内置）。
    if _has_column("rate_policies", "is_builtin"):
        try:
            c.execute("DROP INDEX IF EXISTS idx_rate_policies_default")
        except Exception:  # noqa: BLE001
            pass
        try:
            # 现有默认策略（v11 播种的那条）升级为内置；若没有则不动（新种植入由 seed 负责）
            row = c.execute("SELECT id FROM rate_policies WHERE is_default=1 ORDER BY id LIMIT 1").fetchone()
            if row and not c.execute("SELECT 1 FROM rate_policies WHERE is_builtin=1").fetchone():
                c.execute("UPDATE rate_policies SET is_builtin=1, is_default=1 WHERE id=?", (row["id"],))
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_policies_builtin "
                      "ON rate_policies(is_builtin) WHERE is_builtin = 1")
            c.commit()
        except Exception:  # noqa: BLE001
            pass
    # 音色 / 模型基础库首次建好后播种（内置 + dashscope + deepseek；表已有数据则跳过）。
    if _auto_seed:
        _seed_voices()
        _seed_speech_models()


def _seed_default_rate_policy() -> None:
    """幂等播种一条默认限流策略（没绑策略的 key 用它）。

    阈值取 config_kv 的 RATE_LIMIT_DEFAULT_*（手工配置可读），读不到用内置默认。
    用 is_default 的部分唯一索引 + INSERT OR IGNORE 保证重复启动不重复。
    """
    def _int_cfg(key: str, default: int) -> int:
        try:
            return int(get_config(key, "") or default)
        except (ValueError, TypeError):
            return default

    # 配置读取必须在拿 _lock 之前完成：get_config → _load_cache 也会拿 _lock（不可重入）。
    req = _int_cfg("RATE_LIMIT_DEFAULT_REQ", 100)
    llm = _int_cfg("RATE_LIMIT_DEFAULT_LLM_TOKENS", 20000)
    asr = _int_cfg("RATE_LIMIT_DEFAULT_ASR_SECONDS", 300)
    tts = _int_cfg("RATE_LIMIT_DEFAULT_TTS_CHARS", 50000)
    now = int(time.time())
    with _lock:
        c = _conn_get()
        # 有多条默认策略，但内置兜底只能有一条：按 is_builtin 判断
        if c.execute("SELECT 1 FROM rate_policies WHERE is_builtin=1").fetchone():
            return
        c.execute(
            "INSERT OR IGNORE INTO rate_policies"
            "(name, description, req_per_min, llm_tokens_per_min, asr_seconds_per_min, "
            "tts_chars_per_min, enabled, is_default, is_builtin, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,1,1,1,?,?)",
            ("默认策略", "系统内置，不可删除或停用", req, llm, asr, tts, now, now),
        )
        c.commit()


def _migrate_admin_users() -> None:
    """把存量 admin_credentials 的单账号迁为内置管理员（幂等，只迁一次）。

    触发条件：admin_users 还没有任何 is_builtin=1 的行，且 admin_credentials 有密码。
    迁完不清旧表（保留只读兼容）；密码原样搬过去，不重置。
    """
    with _lock:
        c = _conn_get()
        builtin = c.execute(
            "SELECT COUNT(*) AS n FROM admin_users WHERE is_builtin=1"
        ).fetchone()["n"]
        if builtin:
            return
        row = c.execute(
            "SELECT username, password FROM admin_credentials WHERE id=1"
        ).fetchone()
        if not row or not row["password"]:
            return
        c.execute(
            "INSERT OR IGNORE INTO admin_users(username, password, role, enabled, is_builtin, updated_at) "
            "VALUES(?,?, 'admin', 1, 1, ?)",
            (row["username"], row["password"], int(time.time())),
        )
        c.commit()


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


# ── 管理面板凭据（独立表，不进 config_kv / 远程同步）─────────────────
def admin_credentials_get() -> dict[str, str] | None:
    """读取单行凭据；未初始化返回 None。"""
    if _db_path is None:
        return None
    row = _conn_get().execute(
        "SELECT username, password FROM admin_credentials WHERE id=1"
    ).fetchone()
    return {"username": row["username"], "password": row["password"]} if row else None


def admin_credentials_set(username: str, password: str) -> None:
    """写入/覆盖单行凭据（先删后插，保证 CHECK(id=1) 约束下只有一行）。"""
    now = int(time.time() * 1000)  # 毫秒，与其他表的时间列口径一致
    with _lock:
        cur = _conn_get()
        cur.execute("DELETE FROM admin_credentials WHERE id=1")
        cur.execute(
            "INSERT INTO admin_credentials(id, username, password, updated_at) "
            "VALUES(1, ?, ?, ?)",
            (username, password, now),
        )
        cur.commit()


# ── 管理账号（多账号 + 角色，v10）───────────────────────────────────
ROLES = ("viewer", "operator", "admin")
_ROLE_RANK = {r: i for i, r in enumerate(ROLES)}


def session_username(token: str | None) -> str | None:
    """取会话对应的 username（鉴权用；调用方再校验账号 enabled/角色）。"""
    if not token:
        return None
    row = _conn_get().execute(
        "SELECT username FROM admin_sessions WHERE token=?", (token,)
    ).fetchone()
    return row["username"] if row else None


def admin_user_get(username: str) -> dict[str, Any] | None:
    row = _conn_get().execute(
        "SELECT username, role, enabled, is_builtin, updated_at "
        "FROM admin_users WHERE username=?", (username,)
    ).fetchone()
    return dict(row) if row else None


def admin_users_list() -> list[dict[str, Any]]:
    """列出账号（不含密码）。"""
    rows = _conn_get().execute(
        "SELECT username, role, enabled, is_builtin, updated_at "
        "FROM admin_users ORDER BY is_builtin DESC, username"
    ).fetchall()
    return [dict(r) for r in rows]


def admin_user_auth(username: str, password: str) -> bool:
    """校验账号密码（hmac 由调用方做）；禁用账号一律拒绝。"""
    import hmac
    row = _conn_get().execute(
        "SELECT password, enabled FROM admin_users WHERE username=?", (username,)
    ).fetchone()
    if not row or not row["enabled"]:
        return False
    return hmac.compare_digest(password, row["password"])


def admin_user_add(username: str, password: str, role: str) -> dict[str, Any]:
    """新增账号；用户名重复或角色非法抛 ValueError。"""
    if role not in ROLES:
        raise ValueError(f"非法角色: {role}")
    username = (username or "").strip()
    if not username:
        raise ValueError("用户名不能为空")
    now = int(time.time())
    with _lock:
        c = _conn_get()
        if c.execute("SELECT 1 FROM admin_users WHERE username=?", (username,)).fetchone():
            raise ValueError("用户名已存在")
        c.execute(
            "INSERT INTO admin_users(username, password, role, enabled, is_builtin, updated_at) "
            "VALUES(?,?,?,1,0,?)",
            (username, password, role, now),
        )
        c.commit()
    return admin_user_get(username)


def admin_user_delete(username: str) -> None:
    """删除账号；内置管理员、或最后一个启用的 admin 不可删。"""
    with _lock:
        c = _conn_get()
        row = c.execute(
            "SELECT is_builtin, role, enabled FROM admin_users WHERE username=?", (username,)
        ).fetchone()
        if not row:
            return
        if row["is_builtin"]:
            raise ValueError("内置管理员不可删除")
        if row["role"] == "admin" and row["enabled"]:
            n = c.execute(
                "SELECT COUNT(*) AS n FROM admin_users WHERE role='admin' AND enabled=1"
            ).fetchone()["n"]
            if n <= 1:
                raise ValueError("不能删除最后一个启用的管理员")
        c.execute("DELETE FROM admin_users WHERE username=?", (username,))
        c.execute("DELETE FROM admin_sessions WHERE username=?", (username,))
        c.commit()


def admin_user_set_role(username: str, role: str) -> None:
    """改角色；内置管理员不可改，最后一个 admin 不可降级。"""
    if role not in ROLES:
        raise ValueError(f"非法角色: {role}")
    with _lock:
        c = _conn_get()
        row = c.execute(
            "SELECT is_builtin, role, enabled FROM admin_users WHERE username=?", (username,)
        ).fetchone()
        if not row:
            raise ValueError("账号不存在")
        if row["is_builtin"]:
            raise ValueError("内置管理员角色不可修改")
        if row["role"] == "admin" and role != "admin" and row["enabled"]:
            n = c.execute(
                "SELECT COUNT(*) AS n FROM admin_users WHERE role='admin' AND enabled=1"
            ).fetchone()["n"]
            if n <= 1:
                raise ValueError("不能降级最后一个启用的管理员")
        c.execute(
            "UPDATE admin_users SET role=?, updated_at=? WHERE username=?",
            (role, int(time.time()), username),
        )
        c.commit()


def admin_user_set_enabled(username: str, enabled: bool) -> None:
    """禁用/启用账号；内置管理员不可禁用，最后一个 admin 不可禁用。"""
    with _lock:
        c = _conn_get()
        row = c.execute(
            "SELECT is_builtin, role FROM admin_users WHERE username=?", (username,)
        ).fetchone()
        if not row:
            raise ValueError("账号不存在")
        if row["is_builtin"]:
            raise ValueError("内置管理员不可禁用")
        if row["role"] == "admin" and not enabled:
            n = c.execute(
                "SELECT COUNT(*) AS n FROM admin_users WHERE role='admin' AND enabled=1"
            ).fetchone()["n"]
            if n <= 1:
                raise ValueError("不能禁用最后一个启用的管理员")
        c.execute(
            "UPDATE admin_users SET enabled=?, updated_at=? WHERE username=?",
            (1 if enabled else 0, int(time.time()), username),
        )
        c.commit()
        if not enabled:
            # 禁用即失效：清掉该账号所有会话，避免旧 token 继续访问数据接口。
            c.execute("DELETE FROM admin_sessions WHERE username=?", (username,))
            c.commit()


def admin_user_reset_password(username: str, new_password: str) -> None:
    """admin 重置他人密码；内置管理员不可被重置（只能自己改）。"""
    with _lock:
        c = _conn_get()
        row = c.execute(
            "SELECT is_builtin FROM admin_users WHERE username=?", (username,)
        ).fetchone()
        if not row:
            raise ValueError("账号不存在")
        if row["is_builtin"]:
            raise ValueError("内置管理员密码不可由他人重置")
        c.execute(
            "UPDATE admin_users SET password=?, updated_at=? WHERE username=?",
            (new_password, int(time.time()), username),
        )
        c.commit()
        c.execute("DELETE FROM admin_sessions WHERE username=?", (username,))
        c.commit()


def admin_user_change_password(username: str, old_password: str, new_password: str) -> bool:
    """本人改自己密码（含内置管理员）；校验旧密码，成功后清掉本人其它会话。"""
    import hmac
    with _lock:
        c = _conn_get()
        row = c.execute(
            "SELECT password FROM admin_users WHERE username=?", (username,)
        ).fetchone()
        if not row or not hmac.compare_digest(old_password, row["password"]):
            return False
        c.execute(
            "UPDATE admin_users SET password=?, updated_at=? WHERE username=?",
            (new_password, int(time.time()), username),
        )
        c.commit()
        c.execute("DELETE FROM admin_sessions WHERE username=?", (username,))
        c.commit()
        return True


# ── API Key（哈希管理，v10）─────────────────────────────────────────
def _api_key_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


def api_keys_list() -> list[dict[str, Any]]:
    """列出 key（不含哈希原文/明文，只回前缀展示）。"""
    rows = _conn_get().execute(
        "SELECT id, key_prefix, name, enabled, not_before, expires_at, allowed_ips, "
        "owner_type, owner_id, created_at, updated_at FROM admin_api_keys ORDER BY id"
    ).fetchall()
    return [dict(r) for r in rows]


def api_keys_migrated() -> bool:
    """存量 VOICE_API_KEY 是否已迁移过（防重复）。"""
    v = get_config("api_keys_migrated", "")
    return str(v) == "1"


def api_keys_migrate_legacy(tokens: list[str]) -> int:
    """把启动方传入的明文 key 哈希入库（幂等）；调用方负责从配置/文件读明文。

    用「迁移标记」保证只做一次：标记已置位时直接返回 0，避免用户后来在表里删光
    key 后重启又被旧配置灌回来。
    """
    if api_keys_migrated():
        return 0
    now = int(time.time())
    added = 0
    with _lock:
        c = _conn_get()
        for token in tokens:
            token = (token or "").strip()
            if not token:
                continue
            kh = _api_key_hash(token)
            if c.execute("SELECT 1 FROM admin_api_keys WHERE key_hash=?", (kh,)).fetchone():
                continue
            c.execute(
                "INSERT INTO admin_api_keys(key_hash, key_prefix, name, enabled, "
                "not_before, expires_at, allowed_ips, owner_type, owner_id, created_at, updated_at) "
                "VALUES(?,?,?,1,NULL,NULL,'[]','','',?,?)",
                (kh, token[:8], "migrated", now, now),
            )
            added += 1
        c.commit()
    # set_config 内部也拿 _lock，必须在释放后调用（threading.Lock 不可重入）。
    set_config("api_keys_migrated", "1")
    return added


def api_key_create(token: str, name: str = "", not_before: int | None = None,
                   expires_at: int | None = None, allowed_ips: list[str] | None = None,
                   owner_type: str = "", owner_id: str = "") -> dict[str, Any]:
    """新增 key；返回行（含 id 与前缀，不含哈希/明文）。明文只由调用方返回一次。"""
    token = (token or "").strip()
    if not token:
        raise ValueError("key 不能为空")
    kh = _api_key_hash(token)
    now = int(time.time())
    with _lock:
        c = _conn_get()
        if c.execute("SELECT 1 FROM admin_api_keys WHERE key_hash=?", (kh,)).fetchone():
            raise ValueError("该 key 已存在")
        c.execute(
            "INSERT INTO admin_api_keys(key_hash, key_prefix, name, enabled, "
            "not_before, expires_at, allowed_ips, owner_type, owner_id, created_at, updated_at) "
            "VALUES(?,?,?,1,?,?,?,?,?,?,?)",
            (kh, token[:8], (name or "").strip(), not_before, expires_at,
             json.dumps(allowed_ips or [], ensure_ascii=False), owner_type, owner_id, now, now),
        )
        c.commit()
        row = c.execute(
            "SELECT id, key_prefix, name, enabled, not_before, expires_at, allowed_ips, "
            "owner_type, owner_id, created_at, updated_at FROM admin_api_keys WHERE key_hash=?",
            (kh,),
        ).fetchone()
    return dict(row)


def api_key_delete(key_id: int) -> bool:
    with _lock:
        c = _conn_get()
        cur = c.execute("DELETE FROM admin_api_keys WHERE id=?", (key_id,))
        c.commit()
        return cur.rowcount > 0


def api_key_set_enabled(key_id: int, enabled: bool) -> bool:
    with _lock:
        c = _conn_get()
        cur = c.execute(
            "UPDATE admin_api_keys SET enabled=?, updated_at=? WHERE id=?",
            (1 if enabled else 0, int(time.time()), key_id),
        )
        c.commit()
        return cur.rowcount > 0


def api_key_update(key_id: int, **fields) -> bool:
    """更新白名单字段：name/not_before/expires_at/allowed_ips/owner_type/owner_id。"""
    allowed = {"name", "not_before", "expires_at", "allowed_ips", "owner_type", "owner_id"}
    patch = {k: v for k, v in fields.items() if k in allowed}
    if not patch:
        return False
    if "allowed_ips" in patch and isinstance(patch["allowed_ips"], list):
        patch["allowed_ips"] = json.dumps(patch["allowed_ips"], ensure_ascii=False)
    patch["updated_at"] = int(time.time())
    with _lock:
        c = _conn_get()
        sets = ", ".join(f"{k}=?" for k in patch)
        cur = c.execute(
            f"UPDATE admin_api_keys SET {sets} WHERE id=?",
            (*patch.values(), key_id),
        )
        c.commit()
        return cur.rowcount > 0


def api_keys_verify(token: str, client_ip: str) -> dict[str, Any] | None:
    """校验 key：哈希命中 + enabled + 时间窗口 + key 级 IP（空=不限制）。

    返回匹配行的安全字段（不含哈希/明文）或 None。每次直查 SQLite，即时生效。
    """
    token = (token or "").strip()
    if not token:
        return None
    kh = _api_key_hash(token)
    row = _conn_get().execute(
        "SELECT id, key_prefix, name, enabled, not_before, expires_at, allowed_ips "
        "FROM admin_api_keys WHERE key_hash=?", (kh,)
    ).fetchone()
    if not row or not row["enabled"]:
        return None
    now = int(time.time())
    nb, exp = row["not_before"], row["expires_at"]
    if nb is not None and now < nb:
        return None
    if exp is not None and now > exp:
        return None
    ips = json.loads(row["allowed_ips"] or "[]")
    if ips:
        try:
            addr = ipaddress.ip_address(client_ip)
            if not any(addr in ipaddress.ip_network(cidr, strict=False) for cidr in ips):
                return None
        except ValueError:
            return None
    return dict(row)


def api_keys_has_enabled() -> bool:
    """是否存在启用的 key（三态鉴权开关用）。"""
    row = _conn_get().execute(
        "SELECT 1 FROM admin_api_keys WHERE enabled=1 LIMIT 1"
    ).fetchone()
    return row is not None


# ── 限流策略（v14，仅按 key，周期可配）──────────────────────────────
_RATE_POLICY_FIELDS = ("name", "description", "req_per_min", "llm_tokens_per_min",
                       "asr_seconds_per_min", "tts_chars_per_min", "enabled", "is_default", "period")
# 时间单位 → 秒数（固定秒数近似，月=30天）
RATE_PERIODS: dict[str, int] = {
    "minute": 60, "hour": 3600, "day": 86400, "week": 604800, "month": 2592000,
}


def rate_period_seconds(period: str | None) -> int:
    return RATE_PERIODS.get((period or "minute").strip().lower(), 60)


def rate_policy_get(policy_id: int) -> dict[str, Any] | None:
    row = _conn_get().execute(
        "SELECT * FROM rate_policies WHERE id=?", (policy_id,)
    ).fetchone()
    return dict(row) if row else None


def rate_policies_list() -> list[dict[str, Any]]:
    rows = _conn_get().execute(
        "SELECT * FROM rate_policies ORDER BY is_builtin DESC, is_default DESC, id"
    ).fetchall()
    return [dict(r) for r in rows]


def rate_policy_add(name: str, req: int, llm: int, asr: int, tts: int,
                    description: str = "", period: str = "minute") -> dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("策略名不能为空")
    period = (period or "minute").strip().lower()
    if period not in RATE_PERIODS:
        raise ValueError(f"非法时间单位: {period}")
    now = int(time.time())
    with _lock:
        c = _conn_get()
        if c.execute("SELECT 1 FROM rate_policies WHERE name=?", (name,)).fetchone():
            raise ValueError("策略名已存在")
        cur = c.execute(
            "INSERT INTO rate_policies(name, description, req_per_min, llm_tokens_per_min, "
            "asr_seconds_per_min, tts_chars_per_min, enabled, is_default, period, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,1,0,?,?,?)",
            (name, description, req, llm, asr, tts, period, now, now),
        )
        c.commit()
        return rate_policy_get(cur.lastrowid)


def rate_policy_update(policy_id: int, **fields) -> dict[str, Any]:
    """改阈值/备注/启用；内置策略不可停用。"""
    old = rate_policy_get(policy_id)
    if not old:
        raise ValueError("策略不存在")
    if old["is_builtin"] and fields.get("enabled") == 0:
        raise ValueError("内置策略不可停用")
    patch = {k: v for k, v in fields.items() if k in ("name", "description", "req_per_min",
             "llm_tokens_per_min", "asr_seconds_per_min", "tts_chars_per_min", "enabled", "period")}
    if "period" in patch:
        p = (patch["period"] or "minute").strip().lower()
        if p not in RATE_PERIODS:
            raise ValueError(f"非法时间单位: {p}")
        patch["period"] = p
    if "name" in patch:
        patch["name"] = (patch["name"] or "").strip()
        if not patch["name"]:
            raise ValueError("策略名不能为空")
    if not patch:
        return old
    patch["updated_at"] = int(time.time())
    with _lock:
        c = _conn_get()
        sets = ", ".join(f"{k}=?" for k in patch)
        c.execute(f"UPDATE rate_policies SET {sets} WHERE id=?", (*patch.values(), policy_id))
        c.commit()
    return rate_policy_get(policy_id)


def rate_policy_delete(policy_id: int) -> None:
    """内置策略不可删；删其它策略时级联清绑定（外键 ON DELETE CASCADE）。"""
    old = rate_policy_get(policy_id)
    if not old:
        return
    if old["is_builtin"]:
        raise ValueError("内置策略不可删除")
    with _lock:
        c = _conn_get()
        c.execute("DELETE FROM rate_policies WHERE id=?", (policy_id,))
        c.commit()


def rate_policy_set_default(policy_id: int, value: bool = True) -> None:
    """设/取消默认标记；默认策略允许多个，互不影响。目标必须启用（取消时不限）。"""
    target = rate_policy_get(policy_id)
    if not target:
        raise ValueError("策略不存在")
    if value and not target["enabled"]:
        raise ValueError("停用的策略不能设为默认")
    if target["is_builtin"] and not value:
        raise ValueError("内置策略不能取消默认")
    with _lock:
        c = _conn_get()
        c.execute("UPDATE rate_policies SET is_default=?, updated_at=? WHERE id=?",
                  (1 if value else 0, int(time.time()), policy_id))
        c.commit()


def rate_binding_list(key_id: int) -> list[int]:
    rows = _conn_get().execute(
        "SELECT policy_id FROM rate_policy_bindings WHERE key_id=? ORDER BY policy_id",
        (key_id,)
    ).fetchall()
    return [r["policy_id"] for r in rows]


def rate_binding_set(key_id: int, policy_ids: list[int]) -> None:
    """整体替换某 key 的绑定策略列表（先删后插）。"""
    with _lock:
        c = _conn_get()
        c.execute("DELETE FROM rate_policy_bindings WHERE key_id=?", (key_id,))
        for pid in set(policy_ids or []):
            if c.execute("SELECT 1 FROM rate_policies WHERE id=?", (pid,)).fetchone():
                c.execute(
                    "INSERT OR IGNORE INTO rate_policy_bindings(key_id, policy_id) VALUES(?,?)",
                    (key_id, pid),
                )
        c.commit()


def rate_binding_effective(key_id: int) -> dict[str, Any] | None:
    """取该 key 绑定策略的最严格有效阈值；无绑定/全停用则用内置策略。

    多策略 period 可能不同：按「每秒速率」归一化后取最小速率，再换算到所选 period
    （取各策略中最短的 period，即最频繁检查的周期）对应的阈值。
    返回 {req_per_min, llm_tokens_per_min, asr_seconds_per_min, tts_chars_per_min,
          period, period_seconds, policy_name}。
    """
    FIELDS = ("req_per_min", "llm_tokens_per_min", "asr_seconds_per_min", "tts_chars_per_min")
    rows = _conn_get().execute(
        "SELECT p.req_per_min, p.llm_tokens_per_min, p.asr_seconds_per_min, "
        "p.tts_chars_per_min, p.name, p.period "
        "FROM rate_policy_bindings b JOIN rate_policies p ON p.id=b.policy_id "
        "WHERE b.key_id=? AND p.enabled=1", (key_id,)
    ).fetchall()
    if not rows:
        # 没绑策略 → 用内置的兜底策略（唯一、不可删禁）
        row = _conn_get().execute(
            "SELECT req_per_min, llm_tokens_per_min, asr_seconds_per_min, "
            "tts_chars_per_min, name, period FROM rate_policies "
            "WHERE is_builtin=1 AND enabled=1 LIMIT 1"
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["period"] = d.get("period") or "minute"
        d["period_seconds"] = rate_period_seconds(d["period"])
        return d
    # 选最短 period（秒数最小）作为输出周期
    shortest = min(rows, key=lambda r: rate_period_seconds(r["period"]))
    period = shortest["period"] or "minute"
    period_sec = rate_period_seconds(period)
    out: dict[str, Any] = {"period": period, "period_seconds": period_sec,
                           "policy_name": "+".join(r["name"] for r in rows)}
    # 每维：取最小每秒速率，再换算成该 period 的阈值
    for f in FIELDS:
        min_rate = min(r[f] / rate_period_seconds(r["period"]) for r in rows)
        out[f] = max(1, round(min_rate * period_sec))
    return out


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


# ── ASR 纠错词表（权威源，供客户端增量同步） ──────────────────────────
def list_asr_corrections(since: int = 0) -> list[dict[str, Any]]:
    """返回错词→正确词的 flat 列表（联表），since>0 时只返回 updated_at>since 的变更记录。

    结构与网关侧 listFlat 一致：{wrong, pinyin, correct, updated_at}，网关拿到可直接
    load 进 asrCorrector。按 updated_at 增量同步——新增或修正映射都会前移 updated_at，
    客户端记录水位即可只拉变更，避免每次全量。
    """
    if _db_path is None:
        return []
    sql = """
        SELECT v.id AS variant_id, m.id AS main_id,
               v.wrong, v.pinyin, m.correct, v.updated_at
        FROM asr_correction_variants v
        JOIN asr_corrections m ON m.id = v.correction_id
    """
    args: list[Any] = []
    if since > 0:
        sql += " WHERE v.updated_at > ?"
        args.append(since)
    sql += " ORDER BY v.updated_at, v.id"
    rows = _conn_get().execute(sql, args).fetchall()
    return [dict(r) for r in rows]


def max_asr_correction_ts() -> int:
    """当前词表最大 updated_at（毫秒时间戳），供客户端记录同步水位。"""
    if _db_path is None:
        return 0
    row = _conn_get().execute(
        "SELECT MAX(updated_at) AS ts FROM asr_correction_variants"
    ).fetchone()
    return int(row["ts"] or 0) if row else 0


def upsert_asr_correction(correct: str, correct_pinyin: str, wrong: str, wrong_pinyin: str,
                          note: str = "") -> dict[str, Any]:
    """写入一条错词→正确词（learn_correction 用）。主表按 correct 去重，变体按 (correction_id, wrong) 去重。
    返回 {correct, wrong, updated_at, is_new}。updated_at 用毫秒时间戳，保证增量同步水位精确。"""
    if _db_path is None:
        return {}
    c = _conn_get()
    now_ms = int(time.time() * 1000)
    c.execute(
        "INSERT INTO asr_corrections(correct, pinyin, note, updated_at) VALUES(?,?,?,?) "
        "ON CONFLICT(correct) DO UPDATE SET pinyin=excluded.pinyin, note=excluded.note, updated_at=excluded.updated_at",
        (correct, correct_pinyin, note or None, now_ms),
    )
    row = c.execute("SELECT id FROM asr_corrections WHERE correct=?", (correct,)).fetchone()
    if not row:
        return {}
    cid = int(row["id"])
    existed = c.execute(
        "SELECT id FROM asr_correction_variants WHERE correction_id=? AND wrong=?", (cid, wrong)
    ).fetchone()
    is_new = existed is None
    variant_id = int(existed["id"]) if existed else 0
    if is_new:
        cur = c.execute(
            "INSERT INTO asr_correction_variants(correction_id, wrong, pinyin, note, updated_at) "
            "VALUES(?,?,?,?,?)",
            (cid, wrong, wrong_pinyin, note or None, now_ms),
        )
        variant_id = int(cur.lastrowid or 0)
    else:
        # 已存在也前移 updated_at（修正映射场景，让增量同步能带上）
        c.execute(
            "UPDATE asr_correction_variants SET pinyin=?, note=?, updated_at=? "
            "WHERE correction_id=? AND wrong=?",
            (wrong_pinyin, note or None, now_ms, cid, wrong),
        )
    c.commit()
    return {"main_id": cid, "variant_id": variant_id, "correct": correct, "wrong": wrong,
            "updated_at": now_ms, "is_new": is_new}


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
    # 注意：是否已迁移的判断必须在补内置项「之前」读取。否则全新库补完 kokoro
    # 后会被误判为已迁移，导致下面 dashscope / deepseek 的 config_kv 勾选清单不再迁移。
    already_seeded = bool(
        c.execute("SELECT COUNT(*) FROM enabled_speech_models").fetchone()[0]
    )
    # kokoro 是后上线的内置本地 TTS：存量库在它上线前已非空，不会走下面的 config_kv
    # 迁移，必须无条件补一次，否则管理页内置 TTS 模型列表永远缺 kokoro。
    # PRIMARY KEY(kind,provider,model) + INSERT OR IGNORE 保证重复启动不会插出重复行。
    with _lock:
        c.execute(
            "INSERT OR IGNORE INTO enabled_speech_models(kind, provider, model, is_default, sort) "
            "VALUES(?,?,?,?,?)", ("tts", "builtin", "kokoro", 0, 1)
        )
        c.commit()
    if already_seeded:
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
