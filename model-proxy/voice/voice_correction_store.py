"""ASR 纠错词表的统一存储层：SQLite / MySQL / PostgreSQL 三库对等。

为什么单独抽这一层：
    asr_corrections 两表要在三种数据库上以同一套接口工作（建表/CRUD/分页/增量），
    调用方（9529 的 REST 接口、客户端同步、管理面板）只认 CorrectionStore，不关心
    底层是哪种库、占位符是 ? 还是 %s、UPSERT 怎么写、时间戳函数叫什么。

后端选择（按配置，优先级从高到低）：
    - VOICE_CORRECTION_DB: sqlite | mysql | postgresql（显式指定）
    - 若未指定，从 VOICE_REMOTE_DSN 的 scheme 推断（postgres:// / postgresql:// → postgresql，
      mysql:// → mysql）；都没有 → sqlite。
    - 连接参数：
        sqlite  : VOICE_DB_PATH（缺省沿用 voice_db 配置，或 ~/.app-product/voice/voice.db）
        mysql   : VOICE_MYSQL_DSN（mysql://user:pass@host:port/db）或分项 host/port/user/password/db
        postgres: VOICE_REMOTE_DSN 或 VOICE_PG_DSN（postgres://user:pass@host:port/db）

驱动（按需安装，懒加载，缺哪个不影响其它库）：
    sqlite: 标准库 sqlite3
    mysql : pip install pymysql
    pg    : pip install "psycopg[binary]"

表结构（两表，三库统一字段语义）：
    asr_corrections(correct 唯一, pinyin, note, device_id, source, source_id, created_at, updated_at)
    asr_correction_variants(correction_id→主表, wrong, pinyin, note, device_id, source,
                            source_correction_id, source_id, created_at, updated_at, UNIQUE(correction_id, wrong))
时间戳统一用「毫秒整数」：与网关增量同步水位口径一致。
"""

from __future__ import annotations

import os
import json
import os
import threading
import time
from typing import Any


def _now_ms() -> int:
    return int(time.time() * 1000)


# ── Redis 缓存（可选，懒加载 + 优雅降级）────────────────────────────
class _RedisCache:
    """纠错词表全量结果的 Redis 缓存。

    - REDIS_URL 没配 / redis 未装 / 连不上 → 全部透明降级（读写都不报错，只是不缓存）；
    - 连接失败后退避一段时间不再重试，避免每次请求都卡超时；
    - 只缓存「全量列表」(since=0 且无分页)，参数多变的增量/分页查询不缓存。
    """

    KEY = "asr:corrections:all"
    TTL = 30  # 秒；写操作会主动失效，TTL 只是兜底防脏读
    RETRY = 30  # 连接失败后多久再试

    def __init__(self, url: str | None):
        self.url = (url or os.environ.get("REDIS_URL") or "").strip()
        self._client = None
        self._bad_ts = 0.0
        self._lock = threading.Lock()

    def _get(self):
        if not self.url:
            return None
        if self._client is None and time.time() - self._bad_ts < self.RETRY:
            return None
        with self._lock:
            if self._client is None:
                if time.time() - self._bad_ts < self.RETRY:
                    return None
                try:
                    import redis  # type: ignore
                    self._client = redis.from_url(
                        self.url, socket_connect_timeout=1, socket_timeout=1,
                        decode_responses=True,
                    )
                    self._client.ping()
                except Exception:
                    self._client = None
                    self._bad_ts = time.time()
                    return None
        return self._client

    def get_all(self) -> list[dict[str, Any]] | None:
        c = self._get()
        if c is None:
            return None
        try:
            raw = c.get(self.KEY)
            return json.loads(raw) if raw else None
        except Exception:
            self._bad_ts = time.time()
            self._client = None
            return None

    def set_all(self, rows: list[dict[str, Any]]) -> None:
        c = self._get()
        if c is None:
            return
        try:
            c.setex(self.KEY, self.TTL, json.dumps(rows, ensure_ascii=False))
        except Exception:
            self._bad_ts = time.time()
            self._client = None

    def invalidate(self) -> None:
        c = self._get()
        if c is None:
            return
        try:
            c.delete(self.KEY)
        except Exception:
            self._bad_ts = time.time()
            self._client = None


class CorrectionStore:
    """统一接口：调用方只依赖本类，不感知具体数据库与缓存。"""
    def __init__(self, backend: "_BaseBackend", redis_url: str | None = None):
        self._b = backend
        self._cache = _RedisCache(redis_url)

    @property
    def backend_name(self) -> str:
        return self._b.name

    @property
    def cache_enabled(self) -> bool:
        return bool(self._cache.url)

    def ensure_schema(self) -> None:
        self._b.ensure_schema()

    def list(self, since: int = 0, limit: int | None = None,
             offset: int = 0, enabled_only: bool = False) -> list[dict[str, Any]]:
        """错词→正确词 flat 列表。since>0 只取 updated_at>since；limit/offset 分页。
        enabled_only=True 时只返回已启用的（客户端同步用）；管理面板查看传 False 返回全部。
        全量查询（since=0 且无分页且不过滤）走 Redis 缓存，写操作后主动失效。"""
        full = (since == 0 and limit is None and not enabled_only)
        if full:
            cached = self._cache.get_all()
            if cached is not None:
                return cached
        rows = self._b.list(since, limit, offset)
        if enabled_only:
            # 客户端同步口径：子表 enabled=1 才下发；且客户端上传词必须审核通过
            rows = [r for r in rows if r.get("enabled", 1)
                    and not (r.get("source") == "uploaded" and not r.get("reviewed"))]
        if full:
            self._cache.set_all(rows)
        return rows

    def find_exact(self, correct: str, wrong: str) -> dict[str, Any] | None:
        """按文字精确查一条错词（correct+wrong 完全一致），与来源无关。
        用于添加前查重：无论已存在的是本地手动还是客户端上传，命中即视为重复。"""
        for r in self.list():
            if r.get("correct") == correct and r.get("wrong") == wrong:
                return r
        return None

    def find_main(self, correct: str) -> dict[str, Any] | None:
        """按正确词文字精确查主表，与来源无关。"""
        for m in self._b.list_mains(1, 100000).get("items", []):
            if m.get("correct") == correct:
                return m
        return None

    def list_review(self, page: int = 1, page_size: int = 10, q: str = "") -> dict[str, Any]:
        """审核 tab：按子表维度分页，只列 source=uploaded 的上传词（含已审核）。
        本地手动添加的词不进此 tab（它们在"热词" tab 管理）。q 为错词/正确词/拼音搜索。"""
        flat = self.list()  # 全量（走缓存）
        rows = [r for r in flat if r.get("source") == "uploaded"]
        if q:
            ql = q.lower()
            rows = [r for r in rows if ql in (r.get("wrong", "") or "").lower()
                    or ql in (r.get("correct", "") or "").lower()
                    or ql in (r.get("pinyin", "") or "").lower()]
        rows.sort(key=lambda r: (r.get("reviewed", 0), -(r.get("updated_at", 0))))  # 未审核在前
        total = len(rows)
        page = max(1, page)
        page_size = min(200, max(1, page_size))
        start = (page - 1) * page_size
        return {
            "items": rows[start:start + page_size],
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": (total + page_size - 1) // page_size,
            "pending": sum(1 for r in rows if r.get("reviewed", 0) == 0),
        }

    def count(self, since: int = 0) -> int:
        return self._b.count(since)

    def max_updated_at(self) -> int:
        return self._b.max_updated_at()

    def upsert(self, correct: str, correct_pinyin: str, wrong: str, wrong_pinyin: str,
               source: str = "local", source_id: int | None = None,
               source_correction_id: int | None = None, note: str = "", device_id: str = "") -> dict[str, Any]:
        """写入一条错词→正确词（主表 upsert + 变体 upsert），返回 id 与是否新增。"""
        result = self._b.upsert(correct, correct_pinyin, wrong, wrong_pinyin,
                                source, source_id, source_correction_id, note, device_id)
        self._cache.invalidate()
        return result

    def delete(self, wrong: str, correct: str) -> bool:
        """删除一条错词映射（按 correct+wrong）。返回是否删到。"""
        ok = self._b.delete(wrong, correct)
        if ok:
            self._cache.invalidate()
        return ok

    def delete_variant(self, variant_id: int) -> bool:
        """删除子表一条错词（按 variant_id）。"""
        ok = self._b.delete_variant(variant_id)
        if ok:
            self._cache.invalidate()
        return ok

    def delete_main(self, main_id: int) -> bool:
        """删除主表词条（级联删其下所有错词）。"""
        ok = self._b.delete_main(main_id)
        if ok:
            self._cache.invalidate()
        return ok


    def set_enabled(self, variant_id: int, value: bool) -> bool:
        """启用/禁用一条热词（管理操作）。每次变更都前移 updated_at。"""
        ok = self._b.set_flag(variant_id, "enabled", 1 if value else 0)
        if ok:
            self._cache.invalidate()
        return ok

    def set_reviewed(self, variant_id: int, value: bool) -> bool:
        """标记审核状态（只是标记，不拦同步）。每次变更都前移 updated_at。"""
        ok = self._b.set_flag(variant_id, "reviewed", 1 if value else 0)
        if ok:
            self._cache.invalidate()
        return ok

    def set_main_enabled(self, main_id: int, value: bool) -> bool:
        """主表级启用/禁用（管理端按正确词整组操作）。主表 enabled 控制该词所有错词是否同步。"""
        ok = self._b.set_main_flag(main_id, "enabled", 1 if value else 0)
        if ok:
            self._cache.invalidate()
        return ok

    def set_main_reviewed(self, main_id: int, value: bool) -> bool:
        ok = self._b.set_main_flag(main_id, "reviewed", 1 if value else 0)
        if ok:
            self._cache.invalidate()
        return ok

    def upsert_main_only(self, correct: str, correct_pinyin: str,
                         source: str = "local", note: str = "") -> dict[str, Any]:
        """只建主表（管理端添加正确词+来源，错词留空由学习补）。"""
        result = self._b.upsert_main_only(correct, correct_pinyin, source, note)
        self._cache.invalidate()
        return result

    def list_grouped(self, page: int = 1, page_size: int = 20, q: str = "") -> dict[str, Any]:
        """管理端主表-明细视图：主表分页，每条带其下错词明细。
        客户端上传且未审核的错词不在热词 tab 显示（由"热词审核" tab 管理）。
        q 搜索：主表 correct 或子表 wrong/pinyin 命中即保留（子表只留命中的明细）。"""
        all_data = self._b.list_mains(1, 100000)  # 拿全量再内存过滤分页（热词量小）
        ql = q.lower().strip()
        items = []
        for m in all_data.get("items", []):
            raw_variants = m.get("variants", [])
            # 热词 tab 不显示客户端上传且未审核的错词（它们在"热词审核" tab 管理）
            visible = [v for v in raw_variants
                       if not (v.get("source") == "uploaded" and v.get("reviewed") != 1)]
            # 主表原有错词但过滤后全部不可见、且主表自身也是客户端上传 → 整条主表不显示
            if raw_variants and not visible and m.get("source") == "uploaded":
                continue
            # 搜索过滤：主表名命中 → 保留全部明细；否则只留命中子词，子词也不命中则丢弃该主表
            if ql:
                main_hit = ql in (m.get("correct", "") or "").lower()
                if not main_hit:
                    visible = [v for v in visible if ql in (v.get("wrong", "") or "").lower()
                               or ql in (v.get("pinyin", "") or "").lower()]
                    if not visible:
                        continue
            item = dict(m)
            item["variants"] = visible
            items.append(item)
        total = len(items)
        page = max(1, page)
        page_size = min(200, max(1, page_size))
        start = (page - 1) * page_size
        return {
            "items": items[start:start + page_size],
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": (total + page_size - 1) // page_size,
        }

    def approve_variant(self, variant_id: int) -> bool:
        """审核通过子表错词：置 reviewed=1 + enabled=1，并自动启用其主表。"""
        mid = self._b.variant_main_id(variant_id)
        if not mid:
            return False
        self._b.set_flag(variant_id, "reviewed", 1)
        self._b.set_flag(variant_id, "enabled", 1)
        self._b.set_main_flag(mid, "enabled", 1)
        self._cache.invalidate()
        return True


# ── 后端基类 ──────────────────────────────────────────────────────
class _BaseBackend:
    name = "base"

    def ensure_schema(self) -> None: raise NotImplementedError
    def list(self, since: int, limit: int | None, offset: int) -> list[dict[str, Any]]: raise NotImplementedError
    def count(self, since: int) -> int: raise NotImplementedError
    def max_updated_at(self) -> int: raise NotImplementedError
    def upsert(self, correct, correct_pinyin, wrong, wrong_pinyin, source,
               source_id, source_correction_id, note, device_id="") -> dict[str, Any]: raise NotImplementedError
    def upsert_main_only(self, correct, correct_pinyin, source, note) -> dict[str, Any]: raise NotImplementedError
    def list_mains(self, page: int, page_size: int) -> dict[str, Any]: raise NotImplementedError
    def delete(self, wrong: str, correct: str) -> bool: raise NotImplementedError
    def delete_variant(self, variant_id: int) -> bool: raise NotImplementedError
    def delete_main(self, main_id: int) -> bool: raise NotImplementedError
    def set_flag(self, variant_id: int, field: str, value: int) -> bool: raise NotImplementedError
    def set_main_flag(self, main_id: int, field: str, value: int) -> bool: raise NotImplementedError
    def variant_main_id(self, variant_id: int) -> int: raise NotImplementedError

    @staticmethod
    def _normalize(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """统一返回字段名：main_id/variant_id/wrong/pinyin/correct/source/updated_at。"""
        out = []
        for r in rows:
            d = dict(r)
            out.append({
                "main_id": d.get("main_id"),
                "variant_id": d.get("variant_id"),
                "wrong": d.get("wrong", ""),
                "pinyin": d.get("pinyin", ""),  # 错词拼音
                "correct_pinyin": d.get("correct_pinyin", ""),  # 正确词拼音
                "correct": d.get("correct", ""),
                "source": d.get("source", "local"),
                "reviewed": d.get("reviewed", 0),
                "enabled": d.get("enabled", 1),
                "note": d.get("note", ""),
                "device_id": d.get("device_id", ""),
                "created_at": d.get("created_at", 0),
                "updated_at": d.get("updated_at", 0),
                "main_updated_at": d.get("main_updated_at", 0),
            })
        return out


# ── SQLite 后端（标准库，零依赖，复用 voice.db 文件） ────────────────
class _SqliteBackend(_BaseBackend):
    name = "sqlite"

    def __init__(self, db_path: str):
        self.db_path = os.path.abspath(os.path.expanduser(db_path))
        self._local = threading.local()
        self._lock = threading.Lock()

    def _conn(self):
        c = getattr(self._local, "c", None)
        if c is None:
            import sqlite3
            c = sqlite3.connect(self.db_path, timeout=5.0)
            c.row_factory = sqlite3.Row
            self._local.c = c
        return c

    def ensure_schema(self) -> None:
        c = self._conn()
        c.executescript("""
            CREATE TABLE IF NOT EXISTS asr_corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                correct TEXT NOT NULL UNIQUE,
                pinyin TEXT NOT NULL DEFAULT '',
                note TEXT,
                device_id TEXT,
                source TEXT NOT NULL DEFAULT 'local',
                reviewed INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                source_id INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS asr_correction_variants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                correction_id INTEGER NOT NULL REFERENCES asr_corrections(id) ON DELETE CASCADE,
                wrong TEXT NOT NULL,
                pinyin TEXT NOT NULL DEFAULT '',
                note TEXT,
                device_id TEXT,
                source TEXT NOT NULL DEFAULT 'local',
                reviewed INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                source_correction_id INTEGER,
                source_id INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(correction_id, wrong)
            );
            CREATE INDEX IF NOT EXISTS idx_acv_pinyin ON asr_correction_variants(pinyin);
            CREATE INDEX IF NOT EXISTS idx_acv_updated ON asr_correction_variants(updated_at);
        """)
        # 旧库补列（CREATE TABLE IF NOT EXISTS 不会给已有表加列）——早期 voice.db 的纠错表字段很少。
        for stmt in [
            "ALTER TABLE asr_corrections ADD COLUMN created_at INTEGER",
            "ALTER TABLE asr_corrections ADD COLUMN device_id TEXT",
            "ALTER TABLE asr_corrections ADD COLUMN source TEXT NOT NULL DEFAULT 'local'",
            "ALTER TABLE asr_corrections ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE asr_corrections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE asr_corrections ADD COLUMN source_id INTEGER",
            "ALTER TABLE asr_corrections ADD COLUMN updated_at INTEGER",
            "ALTER TABLE asr_correction_variants ADD COLUMN created_at INTEGER",
            "ALTER TABLE asr_correction_variants ADD COLUMN device_id TEXT",
            "ALTER TABLE asr_correction_variants ADD COLUMN source TEXT NOT NULL DEFAULT 'local'",
            "ALTER TABLE asr_correction_variants ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE asr_correction_variants ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE asr_correction_variants ADD COLUMN source_correction_id INTEGER",
            "ALTER TABLE asr_correction_variants ADD COLUMN source_id INTEGER",
            "ALTER TABLE asr_correction_variants ADD COLUMN updated_at INTEGER",
        ]:
            try:
                c.execute(stmt)
            except Exception:
                pass  # 列已存在
        c.execute("UPDATE asr_corrections SET updated_at=0 WHERE updated_at IS NULL")
        c.execute("UPDATE asr_corrections SET created_at=updated_at WHERE created_at IS NULL")
        c.execute("UPDATE asr_correction_variants SET updated_at=0 WHERE updated_at IS NULL")
        c.execute("UPDATE asr_correction_variants SET created_at=updated_at WHERE created_at IS NULL")
        c.commit()

    def list(self, since, limit, offset):
        sql = """SELECT v.id AS variant_id, m.id AS main_id, v.wrong, v.pinyin, m.pinyin AS correct_pinyin, m.correct,
                        v.source, v.reviewed, v.device_id, v.enabled AS enabled, m.enabled AS main_enabled, v.created_at, v.updated_at, m.updated_at AS main_updated_at, m.note
                 FROM asr_correction_variants v JOIN asr_corrections m ON m.id=v.correction_id"""
        args: list[Any] = []
        if since > 0:
            sql += " WHERE v.updated_at > ?"
            args.append(since)
        sql += " ORDER BY v.updated_at DESC, v.id DESC"
        if limit is not None:
            sql += " LIMIT ? OFFSET ?"
            args.extend([limit, offset])
        rows = self._conn().execute(sql, args).fetchall()
        return self._normalize([dict(r) for r in rows])

    def count(self, since):
        sql = "SELECT COUNT(*) AS n FROM asr_correction_variants"
        args: list[Any] = []
        if since > 0:
            sql += " WHERE updated_at > ?"
            args.append(since)
        return int(self._conn().execute(sql, args).fetchone()["n"])

    def max_updated_at(self):
        row = self._conn().execute("SELECT MAX(updated_at) AS ts FROM asr_correction_variants").fetchone()
        return int(row["ts"] or 0)

    def upsert(self, correct, correct_pinyin, wrong, wrong_pinyin, source,
               source_id, source_correction_id, note, device_id=""):
        c = self._conn()
        now = _now_ms()
        with self._lock:
            c.execute("""INSERT INTO asr_corrections(correct,pinyin,note,source,source_id,created_at,updated_at)
                         VALUES(?,?,?,?,?,?,?)
                         ON CONFLICT(correct) DO UPDATE SET
                           pinyin=CASE WHEN excluded.pinyin='' THEN asr_corrections.pinyin ELSE excluded.pinyin END,
                           note=excluded.note, source=excluded.source,
                           source_id=COALESCE(excluded.source_id, asr_corrections.source_id),
                           updated_at=excluded.updated_at""",
                      (correct, correct_pinyin, note or None, source, source_id, now, now))
            main_id = int(c.execute("SELECT id FROM asr_corrections WHERE correct=?", (correct,)).fetchone()["id"])
            existed = c.execute("SELECT id FROM asr_correction_variants WHERE correction_id=? AND wrong=?",
                                (main_id, wrong)).fetchone()
            is_new = existed is None
            if is_new:
                cur = c.execute("""INSERT INTO asr_correction_variants
                    (correction_id,wrong,pinyin,note,source,device_id,source_correction_id,source_id,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (main_id, wrong, wrong_pinyin, note or None, source, device_id or None,
                     source_correction_id, source_id, now, now))
                variant_id = int(cur.lastrowid or 0)
            else:
                variant_id = int(existed["id"])
                c.execute("""UPDATE asr_correction_variants SET pinyin=?, note=?, source=?,
                    device_id=COALESCE(?, device_id),
                    source_correction_id=COALESCE(?, source_correction_id),
                    source_id=COALESCE(?, source_id), updated_at=? WHERE id=?""",
                    (wrong_pinyin, note or None, source, device_id or None, source_correction_id, source_id, now, variant_id))
            c.commit()
        return {"main_id": main_id, "variant_id": variant_id, "is_new": is_new, "updated_at": now}

    def upsert_main_only(self, correct, correct_pinyin, source, note):
        """只建主表（管理端添加正确词+来源，错词留空由学习补）。"""
        c = self._conn()
        now = _now_ms()
        with self._lock:
            c.execute("""INSERT INTO asr_corrections(correct,pinyin,note,source,created_at,updated_at)
                         VALUES(?,?,?,?,?,?)
                         ON CONFLICT(correct) DO UPDATE SET
                           pinyin=CASE WHEN excluded.pinyin='' THEN asr_corrections.pinyin ELSE excluded.pinyin END,
                           note=excluded.note, source=excluded.source, updated_at=excluded.updated_at""",
                      (correct, correct_pinyin, note or None, source, now, now))
            mid = int(c.execute("SELECT id FROM asr_corrections WHERE correct=?", (correct,)).fetchone()["id"])
            c.commit()
        return {"main_id": mid, "updated_at": now}

    def list_mains(self, page, page_size):
        """主表分页（含无错词的词条），每条带其变体明细。"""
        c = self._conn()
        mains = c.execute("SELECT id,correct,pinyin,note,device_id,source,enabled,reviewed,created_at,updated_at "
                          "FROM asr_corrections ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
                          (page_size, (page-1)*page_size)).fetchall()
        total = int(c.execute("SELECT COUNT(*) AS n FROM asr_corrections").fetchone()["n"])
        items = []
        for m in mains:
            vs = c.execute("SELECT id,wrong,pinyin,enabled,source,reviewed,created_at,device_id,updated_at "
                           "FROM asr_correction_variants WHERE correction_id=? ORDER BY updated_at DESC",
                           (m["id"],)).fetchall()
            items.append({"main_id": m["id"], "correct": m["correct"], "correct_pinyin": m["pinyin"] or "",
                          "note": m["note"] or "", "device_id": m["device_id"] or "", "created_at": m["created_at"] or 0,
                          "source": m["source"], "enabled": m["enabled"],
                          "reviewed": m["reviewed"], "updated_at": m["updated_at"],
                          "variants": [{"variant_id": v["id"], "wrong": v["wrong"], "pinyin": v["pinyin"],
                                        "enabled": v["enabled"], "source": v["source"], "reviewed": v["reviewed"],
                                        "device_id": v["device_id"] or "", "created_at": v["created_at"] or 0, "updated_at": v["updated_at"]}
                                       for v in vs]})
        return {"items": items, "total": total, "page": page, "page_size": page_size,
                "pages": (total + page_size - 1)//page_size}


    def set_flag(self, variant_id: int, field: str, value: int) -> bool:
        if field not in ("reviewed", "enabled"):
            return False
        c = self._conn()
        with self._lock:
            cur = c.execute(f"UPDATE asr_correction_variants SET {field}=?, updated_at=? WHERE id=?",
                            (value, _now_ms(), variant_id))
            c.commit()
            return cur.rowcount > 0

    def set_main_flag(self, main_id: int, field: str, value: int) -> bool:
        if field not in ("reviewed", "enabled"):
            return False
        c = self._conn()
        with self._lock:
            cur = c.execute(f"UPDATE asr_corrections SET {field}=?, updated_at=? WHERE id=?",
                            (value, _now_ms(), main_id))
            c.commit()
            return cur.rowcount > 0

    def variant_main_id(self, variant_id: int) -> int:
        c = self._conn()
        row = c.execute("SELECT correction_id FROM asr_correction_variants WHERE id=?", (variant_id,)).fetchone()
        return int(row["correction_id"]) if row else 0

    def delete(self, wrong, correct):
        c = self._conn()
        with self._lock:
            main = c.execute("SELECT id FROM asr_corrections WHERE correct=?", (correct,)).fetchone()
            if not main:
                return False
            cur = c.execute("DELETE FROM asr_correction_variants WHERE correction_id=? AND wrong=?",
                            (main["id"], wrong))
            c.commit()
            return cur.rowcount > 0

    def delete_variant(self, variant_id):
        c = self._conn()
        with self._lock:
            cur = c.execute("DELETE FROM asr_correction_variants WHERE id=? AND enabled=0", (variant_id,))
            c.commit()
            return cur.rowcount > 0

    def delete_main(self, main_id):
        c = self._conn()
        with self._lock:
            # 只有未启用的主表才能删；且下面有子表（错词）时禁止删除，避免连带丢数据
            row = c.execute("SELECT enabled FROM asr_corrections WHERE id=?", (main_id,)).fetchone()
            if not row or row["enabled"] != 0:
                return False
            child = c.execute("SELECT 1 FROM asr_correction_variants WHERE correction_id=? LIMIT 1", (main_id,)).fetchone()
            if child:
                return False
            c.execute("DELETE FROM asr_corrections WHERE id=?", (main_id,))
            c.commit()
            return True



# ── MySQL 后端（pymysql，占位符 %s，UPSERT 用 ON DUPLICATE KEY UPDATE） ──
class _MysqlBackend(_BaseBackend):
    name = "mysql"

    def __init__(self, dsn: str):
        self.dsn = dsn
        self._conn = None

    def _get_conn(self):
        if self._conn is None:
            import pymysql
            from urllib.parse import urlparse, unquote
            u = urlparse(self.dsn)
            self._conn = pymysql.connect(
                host=u.hostname, port=u.port or 3306,
                user=unquote(u.username or ""), password=unquote(u.password or ""),
                database=(u.path or "").lstrip("/"), charset="utf8mb4", autocommit=True,
            )
        return self._conn

    def ensure_schema(self):
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("""CREATE TABLE IF NOT EXISTS asr_corrections (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                correct VARCHAR(255) NOT NULL UNIQUE,
                pinyin VARCHAR(512) NOT NULL DEFAULT '',
                note VARCHAR(512),
                source VARCHAR(16) NOT NULL DEFAULT 'local',
                reviewed TINYINT NOT NULL DEFAULT 0,
                enabled TINYINT NOT NULL DEFAULT 1,
                source_id BIGINT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")
            cur.execute("""CREATE TABLE IF NOT EXISTS asr_correction_variants (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                correction_id BIGINT NOT NULL,
                wrong VARCHAR(255) NOT NULL,
                pinyin VARCHAR(512) NOT NULL DEFAULT '',
                note VARCHAR(512),
                source VARCHAR(16) NOT NULL DEFAULT 'local',
                reviewed TINYINT NOT NULL DEFAULT 0,
                enabled TINYINT NOT NULL DEFAULT 1,
                source_correction_id BIGINT,
                source_id BIGINT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE KEY uq_acv (correction_id, wrong),
                KEY idx_acv_pinyin (pinyin),
                KEY idx_acv_updated (updated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

    def list(self, since, limit, offset):
        c = self._get_conn()
        sql = """SELECT v.id AS variant_id, m.id AS main_id, v.wrong, v.pinyin, m.pinyin AS correct_pinyin, m.correct,
                        v.source, v.reviewed, v.device_id, v.enabled AS enabled, m.enabled AS main_enabled, v.created_at, v.updated_at, m.updated_at AS main_updated_at, m.note
                 FROM asr_correction_variants v JOIN asr_corrections m ON m.id=v.correction_id"""
        args: list[Any] = []
        if since > 0:
            sql += " WHERE v.updated_at > %s"
            args.append(since)
        sql += " ORDER BY v.updated_at DESC, v.id DESC"
        if limit is not None:
            sql += " LIMIT %s OFFSET %s"
            args.extend([limit, offset])
        with c.cursor() as cur:
            cur.execute(sql, args)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        return self._normalize(rows)

    def count(self, since):
        c = self._get_conn()
        sql = "SELECT COUNT(*) AS n FROM asr_correction_variants"
        args: list[Any] = []
        if since > 0:
            sql += " WHERE updated_at > %s"
            args.append(since)
        with c.cursor() as cur:
            cur.execute(sql, args)
            return int(cur.fetchone()[0])

    def max_updated_at(self):
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("SELECT MAX(updated_at) FROM asr_correction_variants")
            return int(cur.fetchone()[0] or 0)

    def upsert(self, correct, correct_pinyin, wrong, wrong_pinyin, source,
               source_id, source_correction_id, note, device_id=""):
        c = self._get_conn()
        now = _now_ms()
        with c.cursor() as cur:
            cur.execute("""INSERT INTO asr_corrections(correct,pinyin,note,source,source_id,created_at,updated_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s)
                ON DUPLICATE KEY UPDATE
                  pinyin=IF(VALUES(pinyin)='',pinyin,VALUES(pinyin)), note=VALUES(note),
                  source=VALUES(source),
                  source_id=COALESCE(VALUES(source_id),source_id), updated_at=VALUES(updated_at)""",
                (correct, correct_pinyin, note or None, source, source_id, now, now))
            cur.execute("SELECT id FROM asr_corrections WHERE correct=%s", (correct,))
            main_id = int(cur.fetchone()[0])
            cur.execute("SELECT id FROM asr_correction_variants WHERE correction_id=%s AND wrong=%s",
                        (main_id, wrong))
            row = cur.fetchone()
            is_new = row is None
            if is_new:
                cur.execute("""INSERT INTO asr_correction_variants
                    (correction_id,wrong,pinyin,note,source,device_id,source_correction_id,source_id,created_at,updated_at)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (main_id, wrong, wrong_pinyin, note or None, source, device_id or None,
                     source_correction_id, source_id, now, now))
                variant_id = int(cur.lastrowid)
            else:
                variant_id = int(row[0])
                cur.execute("""UPDATE asr_correction_variants SET pinyin=%s,note=%s,source=%s,device_id=COALESCE(%s,device_id),
                    source_correction_id=COALESCE(%s,source_correction_id), source_id=COALESCE(%s,source_id),
                    updated_at=%s WHERE id=%s""",
                    (wrong_pinyin, note or None, source, device_id or None, source_correction_id, source_id, now, variant_id))
        return {"main_id": main_id, "variant_id": variant_id, "is_new": is_new, "updated_at": now}

    def upsert_main_only(self, correct, correct_pinyin, source, note):
        c = self._get_conn()
        now = _now_ms()
        with c.cursor() as cur:
            cur.execute("""INSERT INTO asr_corrections(correct,pinyin,note,source,created_at,updated_at)
                VALUES(%s,%s,%s,%s,%s,%s)
                ON DUPLICATE KEY UPDATE
                  pinyin=IF(VALUES(pinyin)='',pinyin,VALUES(pinyin)), note=VALUES(note),
                  source=VALUES(source), updated_at=VALUES(updated_at)""",
                (correct, correct_pinyin, note or None, source, now, now))
            cur.execute("SELECT id FROM asr_corrections WHERE correct=%s", (correct,))
            mid = int(cur.fetchone()[0])
        return {"main_id": mid, "updated_at": now}

    def list_mains(self, page, page_size):
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("SELECT id,correct,pinyin,note,device_id,source,enabled,reviewed,created_at,updated_at "
                        "FROM asr_corrections ORDER BY updated_at DESC, id DESC LIMIT %s OFFSET %s",
                        (page_size, (page-1)*page_size))
            cols=[d[0] for d in cur.description]; mains=[dict(zip(cols,r)) for r in cur.fetchall()]
            cur.execute("SELECT COUNT(*) FROM asr_corrections"); total=int(cur.fetchone()[0])
            items=[]
            for m in mains:
                cur.execute("SELECT id,wrong,pinyin,enabled,source,reviewed,created_at,device_id,updated_at FROM asr_correction_variants "
                            "WHERE correction_id=%s ORDER BY updated_at DESC", (m["id"],))
                vc=[d[0] for d in cur.description]; vs=[dict(zip(vc,r)) for r in cur.fetchall()]
                items.append({"main_id":m["id"],"correct":m["correct"],"correct_pinyin":m["pinyin"] or "",
                    "note":m["note"] or "","device_id":m.get("device_id") or "","created_at":m.get("created_at",0),
                    "source":m["source"],"enabled":m["enabled"],"reviewed":m["reviewed"],
                    "updated_at":m["updated_at"],
                    "variants":[{"variant_id":v["id"],"wrong":v["wrong"],"pinyin":v["pinyin"],
                        "enabled":v["enabled"],"source":v["source"],"reviewed":v["reviewed"],
                        "device_id":v.get("device_id") or "","created_at":v.get("created_at",0),"updated_at":v["updated_at"]} for v in vs]})
        return {"items":items,"total":total,"page":page,"page_size":page_size,"pages":(total+page_size-1)//page_size}


    def set_flag(self, variant_id: int, field: str, value: int) -> bool:
        if field not in ("reviewed", "enabled"):
            return False
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute(f"UPDATE asr_correction_variants SET {field}=%s, updated_at=%s WHERE id=%s",
                        (value, _now_ms(), variant_id))
            return cur.rowcount > 0

    def set_main_flag(self, main_id: int, field: str, value: int) -> bool:
        if field not in ("reviewed", "enabled"):
            return False
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute(f"UPDATE asr_corrections SET {field}=%s, updated_at=%s WHERE id=%s",
                        (value, _now_ms(), main_id))
            return cur.rowcount > 0

    def set_flag(self, variant_id: int, field: str, value: int) -> bool:
        if field not in ("reviewed", "enabled"):
            return False
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute(f"UPDATE asr_correction_variants SET {field}=%s, updated_at=%s WHERE id=%s",
                        (value, _now_ms(), variant_id))
            return cur.rowcount > 0

    def set_main_flag(self, main_id: int, field: str, value: int) -> bool:
        if field not in ("reviewed", "enabled"):
            return False
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute(f"UPDATE asr_corrections SET {field}=%s, updated_at=%s WHERE id=%s",
                        (value, _now_ms(), main_id))
            return cur.rowcount > 0

    def variant_main_id(self, variant_id: int) -> int:
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("SELECT correction_id FROM asr_correction_variants WHERE id=%s", (variant_id,))
            row = cur.fetchone()
            return int(row[0]) if row else 0

    def delete_variant(self, variant_id):
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("DELETE FROM asr_correction_variants WHERE id=%s AND enabled=0", (variant_id,))
            return cur.rowcount > 0

    def delete_main(self, main_id):
        c = self._get_conn()
        with c.cursor() as cur:
            # 只有未启用的主表才能删；且下面有子表时禁止删除
            cur.execute("SELECT enabled FROM asr_corrections WHERE id=%s", (main_id,))
            row = cur.fetchone()
            if not row or row[0] != 0:
                return False
            cur.execute("SELECT 1 FROM asr_correction_variants WHERE correction_id=%s LIMIT 1", (main_id,))
            if cur.fetchone():
                return False
            cur.execute("DELETE FROM asr_corrections WHERE id=%s", (main_id,))
            return True

    def delete(self, wrong, correct):
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("SELECT id FROM asr_corrections WHERE correct=%s", (correct,))
            main = cur.fetchone()
            if not main:
                return False
            cur.execute("DELETE FROM asr_correction_variants WHERE correction_id=%s AND wrong=%s",
                        (main[0], wrong))
            return cur.rowcount > 0



# ── PostgreSQL 后端（psycopg，占位符 %s，UPSERT 用 ON CONFLICT） ──
class _PgBackend(_BaseBackend):
    name = "postgresql"

    def __init__(self, dsn: str):
        self.dsn = dsn
        self._conn = None

    def _get_conn(self):
        if self._conn is None:
            import psycopg
            self._conn = psycopg.connect(self.dsn, autocommit=True)
        return self._conn

    def ensure_schema(self):
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("""CREATE TABLE IF NOT EXISTS asr_corrections (
                id BIGSERIAL PRIMARY KEY,
                correct TEXT NOT NULL UNIQUE,
                pinyin TEXT NOT NULL DEFAULT '',
                note TEXT,
                device_id TEXT,
                source TEXT NOT NULL DEFAULT 'local',
                reviewed INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                source_id BIGINT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            )""")
            cur.execute("""CREATE TABLE IF NOT EXISTS asr_correction_variants (
                id BIGSERIAL PRIMARY KEY,
                correction_id BIGINT NOT NULL REFERENCES asr_corrections(id) ON DELETE CASCADE,
                wrong TEXT NOT NULL,
                pinyin TEXT NOT NULL DEFAULT '',
                note TEXT,
                device_id TEXT,
                source TEXT NOT NULL DEFAULT 'local',
                reviewed INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                source_correction_id BIGINT,
                source_id BIGINT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE(correction_id, wrong)
            )""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_acv_pinyin ON asr_correction_variants(pinyin)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_acv_updated ON asr_correction_variants(updated_at)")

    def list(self, since, limit, offset):
        c = self._get_conn()
        sql = """SELECT v.id AS variant_id, m.id AS main_id, v.wrong, v.pinyin, m.pinyin AS correct_pinyin, m.correct,
                        v.source, v.reviewed, v.device_id, v.enabled AS enabled, m.enabled AS main_enabled, v.created_at, v.updated_at, m.updated_at AS main_updated_at, m.note
                 FROM asr_correction_variants v JOIN asr_corrections m ON m.id=v.correction_id"""
        args: list[Any] = []
        if since > 0:
            sql += " WHERE v.updated_at > %s"
            args.append(since)
        sql += " ORDER BY v.updated_at DESC, v.id DESC"
        if limit is not None:
            sql += " LIMIT %s OFFSET %s"
            args.extend([limit, offset])
        with c.cursor() as cur:
            cur.execute(sql, args)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        return self._normalize(rows)

    def count(self, since):
        c = self._get_conn()
        sql = "SELECT COUNT(*) AS n FROM asr_correction_variants"
        args: list[Any] = []
        if since > 0:
            sql += " WHERE updated_at > %s"
            args.append(since)
        with c.cursor() as cur:
            cur.execute(sql, args)
            return int(cur.fetchone()[0])

    def max_updated_at(self):
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("SELECT MAX(updated_at) FROM asr_correction_variants")
            return int(cur.fetchone()[0] or 0)

    def upsert(self, correct, correct_pinyin, wrong, wrong_pinyin, source,
               source_id, source_correction_id, note, device_id=""):
        c = self._get_conn()
        now = _now_ms()
        with c.cursor() as cur:
            cur.execute("""INSERT INTO asr_corrections(correct,pinyin,note,source,source_id,created_at,updated_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT(correct) DO UPDATE SET
                  pinyin=CASE WHEN EXCLUDED.pinyin='' THEN asr_corrections.pinyin ELSE EXCLUDED.pinyin END,
                  note=EXCLUDED.note, source=EXCLUDED.source,
                  source_id=COALESCE(EXCLUDED.source_id, asr_corrections.source_id),
                  updated_at=EXCLUDED.updated_at""",
                (correct, correct_pinyin, note or None, source, source_id, now, now))
            cur.execute("SELECT id FROM asr_corrections WHERE correct=%s", (correct,))
            main_id = int(cur.fetchone()[0])
            cur.execute("SELECT id FROM asr_correction_variants WHERE correction_id=%s AND wrong=%s",
                        (main_id, wrong))
            row = cur.fetchone()
            is_new = row is None
            if is_new:
                cur.execute("""INSERT INTO asr_correction_variants
                    (correction_id,wrong,pinyin,note,source,device_id,source_correction_id,source_id,created_at,updated_at)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (main_id, wrong, wrong_pinyin, note or None, source, device_id or None,
                     source_correction_id, source_id, now, now))
                variant_id = int(cur.fetchone()[0])
            else:
                variant_id = int(row[0])
                cur.execute("""UPDATE asr_correction_variants SET pinyin=%s,note=%s,source=%s,device_id=COALESCE(%s,device_id),
                    source_correction_id=COALESCE(%s,source_correction_id), source_id=COALESCE(%s,source_id),
                    updated_at=%s WHERE id=%s""",
                    (wrong_pinyin, note or None, source, device_id or None, source_correction_id, source_id, now, variant_id))
        return {"main_id": main_id, "variant_id": variant_id, "is_new": is_new, "updated_at": now}

    def upsert_main_only(self, correct, correct_pinyin, source, note):
        c = self._get_conn()
        now = _now_ms()
        with c.cursor() as cur:
            cur.execute("""INSERT INTO asr_corrections(correct,pinyin,note,source,created_at,updated_at)
                VALUES(%s,%s,%s,%s,%s,%s)
                ON DUPLICATE KEY UPDATE
                  pinyin=IF(VALUES(pinyin)='',pinyin,VALUES(pinyin)), note=VALUES(note),
                  source=VALUES(source), updated_at=VALUES(updated_at)""",
                (correct, correct_pinyin, note or None, source, now, now))
            cur.execute("SELECT id FROM asr_corrections WHERE correct=%s", (correct,))
            mid = int(cur.fetchone()[0])
        return {"main_id": mid, "updated_at": now}

    def list_mains(self, page, page_size):
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("SELECT id,correct,pinyin,note,device_id,source,enabled,reviewed,created_at,updated_at "
                        "FROM asr_corrections ORDER BY updated_at DESC, id DESC LIMIT %s OFFSET %s",
                        (page_size, (page-1)*page_size))
            cols=[d[0] for d in cur.description]; mains=[dict(zip(cols,r)) for r in cur.fetchall()]
            cur.execute("SELECT COUNT(*) FROM asr_corrections"); total=int(cur.fetchone()[0])
            items=[]
            for m in mains:
                cur.execute("SELECT id,wrong,pinyin,enabled,source,reviewed,created_at,device_id,updated_at FROM asr_correction_variants "
                            "WHERE correction_id=%s ORDER BY updated_at DESC", (m["id"],))
                vc=[d[0] for d in cur.description]; vs=[dict(zip(vc,r)) for r in cur.fetchall()]
                items.append({"main_id":m["id"],"correct":m["correct"],"correct_pinyin":m["pinyin"] or "",
                    "note":m["note"] or "","device_id":m.get("device_id") or "","created_at":m.get("created_at",0),
                    "source":m["source"],"enabled":m["enabled"],"reviewed":m["reviewed"],
                    "updated_at":m["updated_at"],
                    "variants":[{"variant_id":v["id"],"wrong":v["wrong"],"pinyin":v["pinyin"],
                        "enabled":v["enabled"],"source":v["source"],"reviewed":v["reviewed"],
                        "device_id":v.get("device_id") or "","created_at":v.get("created_at",0),"updated_at":v["updated_at"]} for v in vs]})
        return {"items":items,"total":total,"page":page,"page_size":page_size,"pages":(total+page_size-1)//page_size}


    def variant_main_id(self, variant_id: int) -> int:
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("SELECT correction_id FROM asr_correction_variants WHERE id=%s", (variant_id,))
            row = cur.fetchone()
            return int(row[0]) if row else 0

    def delete_variant(self, variant_id):
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("DELETE FROM asr_correction_variants WHERE id=%s AND enabled=0", (variant_id,))
            return cur.rowcount > 0

    def delete_main(self, main_id):
        c = self._get_conn()
        with c.cursor() as cur:
            # 只有未启用的主表才能删；且下面有子表时禁止删除
            cur.execute("SELECT enabled FROM asr_corrections WHERE id=%s", (main_id,))
            row = cur.fetchone()
            if not row or row[0] != 0:
                return False
            cur.execute("SELECT 1 FROM asr_correction_variants WHERE correction_id=%s LIMIT 1", (main_id,))
            if cur.fetchone():
                return False
            cur.execute("DELETE FROM asr_corrections WHERE id=%s", (main_id,))
            return True

    def delete(self, wrong, correct):
        c = self._get_conn()
        with c.cursor() as cur:
            cur.execute("SELECT id FROM asr_corrections WHERE correct=%s", (correct,))
            main = cur.fetchone()
            if not main:
                return False
            cur.execute("DELETE FROM asr_correction_variants WHERE correction_id=%s AND wrong=%s",
                        (main[0], wrong))
            return cur.rowcount > 0



# ── 工厂 ──────────────────────────────────────────────────────────
_store: CorrectionStore | None = None


def configure(
    db_kind: str | None = None,
    sqlite_path: str | None = None,
    mysql_dsn: str | None = None,
    pg_dsn: str | None = None,
    redis_url: str | None = None,
) -> CorrectionStore:
    """建立全局唯一纠错存储实例。db_kind 缺省时按 DSN scheme 推断，再缺省 sqlite。
    redis_url 不传时从 REDIS_URL 环境变量读（见 _RedisCache）。"""
    global _store
    kind = (db_kind or os.environ.get("VOICE_CORRECTION_DB") or "").strip().lower()
    remote = (pg_dsn or os.environ.get("VOICE_REMOTE_DSN") or os.environ.get("VOICE_PG_DSN") or "").strip()
    mysql = (mysql_dsn or os.environ.get("VOICE_MYSQL_DSN") or "").strip()
    if not kind:
        if remote.startswith(("postgres://", "postgresql://")):
            kind = "postgresql"
        elif mysql.startswith("mysql://"):
            kind = "mysql"
        else:
            kind = "sqlite"
    if kind in ("pg", "postgres", "postgresql"):
        if not remote:
            raise RuntimeError("PostgreSQL 后端需要 VOICE_REMOTE_DSN / VOICE_PG_DSN")
        backend: _BaseBackend = _PgBackend(remote)
    elif kind == "mysql":
        if not mysql:
            raise RuntimeError("MySQL 后端需要 VOICE_MYSQL_DSN")
        backend = _MysqlBackend(mysql)
    elif kind in ("sqlite", "sqlite3"):
        path = sqlite_path or os.environ.get("VOICE_DB_PATH") or os.path.expanduser("~/.app-product/voice/voice.db")
        backend = _SqliteBackend(path)
    else:
        raise RuntimeError(f"未知纠错库类型: {kind}（可用 sqlite/mysql/postgresql）")
    _store = CorrectionStore(backend, redis_url=redis_url)
    return _store


def get_store() -> CorrectionStore:
    if _store is None:
        return configure()
    return _store
