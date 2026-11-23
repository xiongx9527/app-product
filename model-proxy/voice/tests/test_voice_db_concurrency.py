"""voice.db（语音数据库文件）并发访问回归测试。

背景（真实缺陷）：
    voice_db._conn_get() 原先返回模块级**单个** sqlite3.Connection（
    check_same_thread=False）。写方法都在 `with _lock:` 里，但大量读方法
    （session_valid / get_config / load_config / list_speech_models / stats ...）
    没加锁。19529 的 admin 请求由 anyio 线程池并发回调 require_admin →
    valid_session → session_valid，多个线程同时对同一 Connection 调用
    .execute() 会把 sqlite 内部状态搞乱：
      - 抛 sqlite3.InterfaceError: bad parameter or other API misuse → 500；
      - 读到错乱结果、把有效 session 误判失效 → 401；
      - 保存偶发没落库（用户可见「保存了但没生效」）。
    修复：改为**每线程一条独立连接**（threading.local()），写仍由 _lock 串行化，
    跨连接靠 sqlite 文件锁 + commit 保证可见性。

运行（无需起 19529 服务，每个用例用独立临时 SQLite）：
    cd model-proxy/voice
    /Users/xiongxiao/.app-product/voice/venv/bin/python tests/test_voice_db_concurrency.py
    （只用标准库 + 本地 catalog.py，系统 python3 亦可）

锁住的关键点：
1. _conn_get() 同线程复用、不同线程返回不同连接——这是修复本身，改回
   全局单连接会立刻 FAIL（确定性，不靠时序碰运气）。
2. 读（无锁）+ 写（有锁）混合并发，不出现任何 sqlite 异常。
3. 并发写全部落盘、无丢失（用全新连接直接读 db 文件，绕过缓存）。
4. 并发 session_valid 不把有效会话误判失效（旧代码偶发 401 的直接回归）。
5. 线程 A 的写入对线程 B 的独立连接可见（commit 生效）。
6. enabled 表并发「整体替换」不会读到半截状态。
7. 并发后 db 文件 integrity_check 仍为 ok。
8. 单线程基本功能（配置 / 会话 / 启用模型 / seed 目录）不因并发修复退化。
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

_VOICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_VOICE_DIR))

import voice_db  # noqa: E402  需在 sys.path 就绪后导入

_RESULTS: list[tuple[str, bool]] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    _RESULTS.append((name, bool(cond)))
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")


def fresh_db() -> str:
    """新建独立临时 voice.db；重置模块级状态，避免用例间串扰。

    换库时必须丢弃主线程 thread-local 里残留的连接（它指向上一个临时库），
    否则后续读写仍落在旧文件上。
    """
    db_path = os.path.join(tempfile.mkdtemp(prefix="voice_db_concurrency_"), "voice.db")
    if hasattr(voice_db._conn_local, "c"):
        try:
            voice_db._conn_local.c.close()
        except Exception:
            pass
        delattr(voice_db._conn_local, "c")
    voice_db._cache.clear()
    voice_db._cache_ts = 0.0
    voice_db.configure(db_path)
    voice_db.set_auto_seed(True)   # 灌入音色 / 模型目录，贴近真实库
    voice_db.ensure_schema()
    return db_path


def read_file(db_path: str, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    """用全新连接直接读 db 文件，绕过 voice_db 的缓存与连接，验证真实落盘。"""
    c = sqlite3.connect(db_path)
    try:
        c.row_factory = sqlite3.Row
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def run_threads(fn, count: int, workers: int | None = None) -> None:
    with ThreadPoolExecutor(max_workers=workers or count) as ex:
        futs = [ex.submit(fn, i) for i in range(count)]
        for f in futs:
            f.result()


# ── 1) 修复点本身：每线程独立连接 ───────────────────────────────────
def test_conn_per_thread(db_path: str) -> None:
    # 同线程内多次调用必须复用同一连接
    a, b = voice_db._conn_get(), voice_db._conn_get()
    check("同线程复用同一连接", a is b)

    # Barrier 强制 4 个线程同时首次取连接：修复后应各拿到自己的连接
    barrier = threading.Barrier(4)
    ids: list[int] = []
    guard = threading.Lock()

    def worker() -> None:
        barrier.wait()
        c = voice_db._conn_get()
        with guard:
            ids.append(id(c))

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check("不同线程返回不同连接（改回全局单连接即 FAIL）",
          len(ids) == 4 and len(set(ids)) == 4, f"unique={len(set(ids))}")

    # 源码级防回退：不再声明模块级单连接 / 不再 global _conn
    src = (_VOICE_DIR / "voice_db.py").read_text(encoding="utf-8")
    start = src.index("def _conn_get")
    end = src.find("\ndef ", start + 1)
    body = src[start:end if end != -1 else start + 800]
    check("_conn_get 使用 threading.local 且无 global _conn",
          "_conn_local = threading.local()" in src and "global _conn" not in body)


# ── 2) 读（无锁）+ 写（有锁）混合并发不抛异常 ───────────────────────
def test_concurrent_mixed(db_path: str) -> None:
    errors: list[str] = []
    guard = threading.Lock()

    def record(e: Exception) -> None:
        with guard:
            errors.append(repr(e))

    def reader(i: int) -> None:
        try:
            for _ in range(20):
                voice_db.session_valid("sess")
                voice_db.get_config("X", "d")
                voice_db.load_config()
                voice_db.dump_config_ts()
                voice_db.list_speech_models()
                voice_db.list_voices()
                voice_db.list_enabled_models()
                voice_db.stats()
                voice_db.recent_events()
        except Exception as e:
            record(e)

    def writer(i: int) -> None:
        try:
            for j in range(20):
                voice_db.set_config(f"mix_{i}_{j}", f"v{i}-{j}")
                voice_db.append_event("info", "conc", f"e{i}-{j}")
                voice_db.append_audit("admin", "conc", f"a{i}-{j}")
                voice_db.replace_enabled_models("tts", f"prov{i}", [f"m{i}-{j}"], f"m{i}-{j}")
                voice_db.session_create(f"s{i}-{j}", "admin", ttl=3600)
        except Exception as e:
            record(e)

    voice_db.session_create("sess", "admin", ttl=3600)
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(reader if i % 2 == 0 else writer, i) for i in range(16)]
        for f in futs:
            f.result()
    check("并发混合读写无 sqlite 异常", not errors,
          f"count={len(errors)} first={errors[:2]}")


# ── 3) 并发写全部落盘、无丢失（回归「保存偶发没生效」）────────────────
def test_no_lost_writes(db_path: str) -> None:
    n, per = 6, 40

    def writer(i: int) -> None:
        for j in range(per):
            voice_db.set_config_bulk({f"bulk_{i}_{j}": f"v{i}-{j}"})

    run_threads(writer, n)
    rows = read_file(db_path, "SELECT key, value FROM config_kv WHERE key LIKE 'bulk_%'")
    got = {r["key"]: r["value"] for r in rows}
    expected = {f"bulk_{i}_{j}": f"v{i}-{j}" for i in range(n) for j in range(per)}
    check("并发写全部落盘、无丢失", got == expected,
          f"got={len(got)} expected={len(expected)}")


# ── 4) session_valid 并发不误判（旧代码偶发 401 的直接回归）────────────
def test_session_valid_stable(db_path: str) -> None:
    voice_db.session_create("stable", "admin", ttl=3600)
    bad: list[int] = []
    guard = threading.Lock()

    def worker(_: int) -> None:
        for _ in range(60):
            if not voice_db.session_valid("stable"):
                with guard:
                    bad.append(1)

    run_threads(worker, 8)
    check("并发 session_valid 不误判有效会话失效", not bad, f"bad={len(bad)}")


# ── 5) 跨线程写入对另一条连接可见 ────────────────────────────────────
def test_cross_thread_visibility(db_path: str) -> None:
    def w() -> None:
        voice_db.set_config("visible_key", "visible_value")

    t = threading.Thread(target=w)
    t.start()
    t.join()
    rows = read_file(db_path, "SELECT value FROM config_kv WHERE key='visible_key'")
    check("线程A写入对独立连接可见(commit 生效)",
          bool(rows) and rows[0]["value"] == "visible_value")


# ── 6) enabled 表并发整体替换读不到半截 ──────────────────────────────
def test_enabled_models_atomic(db_path: str) -> None:
    errors: list[str] = []
    anomalies: list[list[str]] = []
    guard = threading.Lock()

    def writer(i: int) -> None:
        try:
            for j in range(25):
                voice_db.replace_enabled_models("stt", "dashscope",
                                                [f"m{i}-{j}", "base"], "base")
        except Exception as e:
            with guard:
                errors.append(repr(e))

    def reader(_: int) -> None:
        try:
            for _ in range(30):
                models = [r["model"] for r in
                          voice_db.list_enabled_models("stt", "dashscope")]
                # 替换是单事务：要么看到空、要么看到完整的两条（含 base），
                # 绝不能看到 DELETE 后、INSERT 前的半截状态。
                if models and (len(models) != 2 or "base" not in models):
                    with guard:
                        anomalies.append(models)
        except Exception as e:
            with guard:
                errors.append(repr(e))

    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(writer if i % 2 == 0 else reader, i) for i in range(8)]
        for f in futs:
            f.result()
    check("enabled 表并发替换/读取无异常", not errors, f"errors={errors[:2]}")
    check("并发读不出现半截状态", not anomalies, f"anomalies={anomalies[:2]}")
    final = voice_db.enabled_models("stt", "dashscope")
    check("并发结束后启用表状态完整", len(final) == 2 and "base" in final,
          f"final={final}")


# ── 7) 并发后 db 文件完整性 ──────────────────────────────────────────
def test_integrity(db_path: str) -> None:
    # 先制造一轮并发写，再检查文件完整性，否则测的只是刚建库的空表
    def writer(i: int) -> None:
        for j in range(20):
            voice_db.set_config(f"integ_{i}_{j}", "x" * 64)
            voice_db.append_event("info", "integ", "y" * 64)

    run_threads(writer, 8)
    c = sqlite3.connect(db_path)
    try:
        result = c.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        c.close()
    check("并发后 voice.db 文件完整(integrity_check=ok)", result == "ok",
          f"got={result}")


# ── 8) 单线程基本功能回归（并发修复未破坏常规链路）────────────────────
def test_basic_regression(db_path: str) -> None:
    voice_db.set_config("A", "1")
    check("set/get 配置", voice_db.get_config("A") == "1")
    voice_db.set_config_bulk({"A": "2", "B": "3"})
    check("批量写入", voice_db.get_config("A") == "2" and voice_db.get_config("B") == "3")

    voice_db.session_create("t1", "admin", ttl=3600)
    check("会话有效", voice_db.session_valid("t1") is True)
    voice_db.session_destroy("t1")
    check("会话销毁后失效", voice_db.session_valid("t1") is False)

    voice_db.replace_enabled_models("tts", "builtin", ["edge-tts"], "edge-tts")
    check("启用模型写入与默认模型",
          voice_db.enabled_models("tts", "builtin") == ["edge-tts"]
          and voice_db.enabled_default_model("tts", "builtin") == "edge-tts")
    check("seed 模型目录已灌入", len(voice_db.list_speech_models()) > 0,
          f"count={len(voice_db.list_speech_models())}")
    check("schema 版本可读", voice_db.SCHEMA_VERSION >= 7)


def main() -> int:
    cases = [
        test_conn_per_thread,
        test_concurrent_mixed,
        test_no_lost_writes,
        test_session_valid_stable,
        test_cross_thread_visibility,
        test_enabled_models_atomic,
        test_integrity,
        test_basic_regression,
    ]
    for case in cases:
        # 每个用例独立 db 文件，避免 thread-local 连接 / 缓存跨用例串扰
        case(fresh_db())

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed
          else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
