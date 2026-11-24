"""迁移脚本 013 / 014 回归测试（手工补迁移路径）。

背景：19529 的 schema 迁移由 voice_db.ensure_schema() 自动执行；但 migrations/*.sql
也支持手工 `sqlite3 db < script.sql` 补迁移。本测试验证这两个脚本在 v12 老库上
能正确迁移、且重复执行幂等（数据不乱）。

覆盖：
1. 构造 v12 老库（rate_policies 无 is_builtin/period 列、is_default 唯一索引在、版本到 12）。
2. 执行 013 → is_builtin 列、旧默认唯一索引删除、内置唯一索引建好、默认策略标内置、版本 13。
3. 执行 014 → period 列、存量 period=minute、版本 14。
4. 重复执行 013/014 → duplicate column 报错可忽略，但数据不丢失、版本留痕不重复。

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_migration_scripts.py
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

_VOICE_DIR = Path(__file__).resolve().parent.parent
_PROJECT = _VOICE_DIR.parent
sys.path.insert(0, str(_VOICE_DIR))

MIGRATIONS = _PROJECT / "migrations"
_RESULTS: list[tuple[str, bool]] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    _RESULTS.append((name, bool(cond)))
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")


def run_sql_script(db: str, script: Path) -> tuple[int, str]:
    """用 sqlite3 命令行执行 .sql 脚本（模拟手工补迁移）。"""
    sql = script.read_text(encoding="utf-8")
    r = subprocess.run(["sqlite3", db], input=sql, text=True, capture_output=True)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def cols(db: str, table: str) -> set[str]:
    conn = sqlite3.connect(db)
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    finally:
        conn.close()


def indexes(db: str, table: str) -> set[str]:
    conn = sqlite3.connect(db)
    try:
        return {r[1] for r in conn.execute(f"PRAGMA index_list({table})")}
    finally:
        conn.close()


def query(db: str, sql: str):
    conn = sqlite3.connect(db)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def main() -> int:
    import voice_db

    if shutil.which("sqlite3") is None:
        check("sqlite3 命令行可用", False, "系统未安装 sqlite3，跳过脚本测试")
        print(f"\n== SUMMARY: {sum(1 for _,ok in _RESULTS if ok)}/{len(_RESULTS)} passed ==")
        return 1

    s13 = MIGRATIONS / "013_builtin_rate_policy.sql"
    s14 = MIGRATIONS / "014_rate_limit_period.sql"
    check("013/014 脚本存在", s13.exists() and s14.exists())

    tmpdir = tempfile.mkdtemp(prefix="voice_mig_scripts_test_")
    db = os.path.join(tmpdir, "v.db")

    # 1) 建全新库（到 v14），再降级到 v12 模拟老库
    voice_db.configure(db)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    voice_db.set_auto_seed(True)
    conn = sqlite3.connect(db)
    try:
        conn.execute("DROP INDEX IF EXISTS idx_rate_policies_builtin")
        conn.execute("ALTER TABLE rate_policies DROP COLUMN is_builtin")
        conn.execute("ALTER TABLE rate_policies DROP COLUMN period")
        # v12 时 is_default 唯一索引还在（v13 才删），重建它
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_policies_default "
                     "ON rate_policies(is_default) WHERE is_default=1")
        # 删掉所有高于 12 的版本留痕（当前 SCHEMA_VERSION 已到 19，不能只删 13/14）
        conn.execute("DELETE FROM schema_version WHERE version > 12")
        conn.commit()
    finally:
        conn.close()

    check("构造 v12 老库成功", query(db, "SELECT MAX(version) FROM schema_version")[0][0] == 12)
    check("v12 无 is_builtin 列", "is_builtin" not in cols(db, "rate_policies"))
    check("v12 无 period 列", "period" not in cols(db, "rate_policies"))
    check("v12 有 is_default 唯一索引", "idx_rate_policies_default" in indexes(db, "rate_policies"))
    check("v12 有默认策略", query(db, "SELECT COUNT(*) FROM rate_policies WHERE is_default=1")[0][0] >= 1)

    # 2) 执行 013
    rc13, out13 = run_sql_script(db, s13)
    check("013 执行后 is_builtin 列存在", "is_builtin" in cols(db, "rate_policies"), out13.strip()[:80])
    check("013 删除 is_default 唯一索引", "idx_rate_policies_default" not in indexes(db, "rate_policies"))
    check("013 建 is_builtin 唯一索引", "idx_rate_policies_builtin" in indexes(db, "rate_policies"))
    builtin = query(db, "SELECT name FROM rate_policies WHERE is_builtin=1")
    check("013 默认策略标记为内置", len(builtin) == 1, str(builtin))
    check("013 版本留痕 v13", query(db, "SELECT COUNT(*) FROM schema_version WHERE version=13")[0][0] == 1)

    # 3) 执行 014
    rc14, out14 = run_sql_script(db, s14)
    check("014 执行后 period 列存在", "period" in cols(db, "rate_policies"), out14.strip()[:80])
    periods = query(db, "SELECT DISTINCT period FROM rate_policies")
    check("014 存量 period=minute", periods and all(p[0] == "minute" for p in periods), str(periods))
    check("014 版本留痕 v14", query(db, "SELECT COUNT(*) FROM schema_version WHERE version=14")[0][0] == 1)

    # 4) 幂等性：重复执行（duplicate column 报错可忽略，数据不乱）
    r13, _ = run_sql_script(db, s13)
    r14, _ = run_sql_script(db, s14)
    check("重复执行后内置策略仍唯一",
          query(db, "SELECT COUNT(*) FROM rate_policies WHERE is_builtin=1")[0][0] == 1)
    check("重复执行后 v13 留痕不重复",
          query(db, "SELECT COUNT(*) FROM schema_version WHERE version=13")[0][0] == 1)
    check("重复执行后 v14 留痕不重复",
          query(db, "SELECT COUNT(*) FROM schema_version WHERE version=14")[0][0] == 1)
    check("重复执行后数据不丢",
          query(db, "SELECT COUNT(*) FROM rate_policies")[0][0] >= 1)

    shutil.rmtree(tmpdir, ignore_errors=True)

    passed = sum(1 for _, ok in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"\n== SUMMARY: {passed}/{total} passed ==")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
