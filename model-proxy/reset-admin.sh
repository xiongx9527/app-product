#!/usr/bin/env bash
# 重置/修复内置管理员（直接改数据库，不经过运行中的服务）。
#
# 支持三种数据库，按配置连哪个就用哪个（与服务端 voice_correction_store / openai_voice_server 同源）：
#   VOICE_CORRECTION_DB / VOICE_ADMIN_DB = sqlite | mysql | postgresql   # 显式指定
#   未指定时按 DSN 推断：VOICE_REMOTE_DSN/VOICE_PG_DSN 是 postgres(ql):// → postgresql；
#                       VOICE_MYSQL_DSN 是 mysql:// → mysql；都没有 → sqlite
#   sqlite 路径：VOICE_DB_PATH > VOICE_DB_DIR/voice.db > $VOICE_HOME/voice.db
#   注：voice.conf 里的 DSN 不会注入 os.environ，服务端也只认环境变量，本脚本同样只认环境变量。
#
# 用法：
#   ./reset-admin.sh                 # 重置内置管理员密码（随机生成，打印一次）
#   ./reset-admin.sh --password XXX  # 指定新密码（至少 8 位）
#   ./reset-admin.sh --fix           # 修复内置管理员异常（缺失/重复/被禁用/角色被改）
#   ./reset-admin.sh --fix-roles     # 修复角色功能权限：清空自定义配置，恢复默认矩阵（兜底）
#   ./reset-admin.sh --list          # 列出所有账号及状态
#   可选显式覆盖（便于离线验证三库，优先于 env）：
#   --db-kind sqlite|mysql|postgresql --mysql-dsn DSN --pg-dsn DSN --sqlite-path PATH
#
# 可设 VOICE_HOME 指向运行目录（默认 ~/.app-product/voice）；用 venv python 跑（mysql/pg 驱动装这里），
# 无 venv 时回退 python3（仅 sqlite 可用，需标准库）。
set -euo pipefail

VOICE_HOME="${VOICE_HOME:-$HOME/.app-product/voice}"
VENV_PY="$VOICE_HOME/venv/bin/python"
PY="$VENV_PY"; [ -x "$PY" ] || PY=python3

exec "$PY" - "$VOICE_HOME" "$@" <<'PYEOF'
import os
import secrets
import sys
import time

home = sys.argv[1]
args = sys.argv[2:]

# ── 参数解析 ────────────────────────────────────────────────────────
action = "reset"
password = None
if "--list" in args:
    action = "list"
elif "--fix-roles" in args:
    action = "fix-roles"
elif "--fix" in args:
    action = "fix"
if "--password" in args:
    i = args.index("--password")
    if i + 1 >= len(args):
        sys.exit("--password 需要一个值")
    password = args[i + 1]
    if len(password) < 8:
        sys.exit("密码至少 8 位")

def opt(name, default=None):
    """取 --name VALUE 形式的可选覆盖参数。"""
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return default

# ── 配置来源：显式参数 > 环境变量；与服务端同源 ─────────────────────
kind_cfg = (opt("--db-kind") or os.environ.get("VOICE_CORRECTION_DB")
            or os.environ.get("VOICE_ADMIN_DB") or "").strip().lower()
mysql_dsn = (opt("--mysql-dsn") or os.environ.get("VOICE_MYSQL_DSN") or "").strip()
pg_dsn = (opt("--pg-dsn") or os.environ.get("VOICE_REMOTE_DSN")
          or os.environ.get("VOICE_PG_DSN") or "").strip()
sqlite_path = opt("--sqlite-path") or os.environ.get("VOICE_DB_PATH") or ""

# 未显式指定 kind 时，按 DSN scheme 推断，再缺省 sqlite（与 voice_correction_store.configure 一致）
kind = kind_cfg
if not kind:
    if pg_dsn.startswith(("postgres://", "postgresql://")):
        kind = "postgresql"
    elif mysql_dsn.startswith("mysql://"):
        kind = "mysql"
    else:
        kind = "sqlite"

if kind in ("pg", "postgres", "postgresql"):
    if not pg_dsn:
        sys.exit("PostgreSQL 后端需要 VOICE_REMOTE_DSN / VOICE_PG_DSN（或 --pg-dsn）")
elif kind == "mysql":
    if not mysql_dsn:
        sys.exit("MySQL 后端需要 VOICE_MYSQL_DSN（或 --mysql-dsn）")
elif kind not in ("sqlite", "sqlite3"):
    sys.exit(f"未知数据库类型: {kind}（可用 sqlite / mysql / postgresql）")

# ── 连接封装：向上层提供统一的 execute/fetch，屏蔽三库方言差异 ──────
class _Cur:
    """极简游标：只暴露 fetchone / fetchall，行统一为 dict。"""
    def __init__(self, rows):
        self._rows = rows
    def fetchone(self):
        return self._rows[0] if self._rows else None
    def fetchall(self):
        return list(self._rows)

class Db:
    def __init__(self, kind, sqlite_path, mysql_dsn, pg_dsn):
        self.kind = kind
        self.autocommit = kind != "sqlite"
        self.sqlite_path = sqlite_path
        self.mysql_dsn = mysql_dsn
        self.pg_dsn = pg_dsn
        self.conn = self._connect()

    def _connect(self):
        if self.kind in ("sqlite", "sqlite3"):
            import sqlite3
            if not self.sqlite_path:
                db_dir = os.environ.get("VOICE_DB_DIR") or ""
                self.sqlite_path = os.path.join(
                    os.path.expanduser(db_dir) if db_dir else home, "voice.db")
            self.sqlite_path = os.path.abspath(os.path.expanduser(self.sqlite_path))
            if not os.path.isfile(self.sqlite_path):
                sys.exit(f"找不到数据库：{self.sqlite_path}（设 VOICE_HOME / VOICE_DB_PATH 指向正确目录）")
            c = sqlite3.connect(self.sqlite_path, timeout=10)
            c.row_factory = sqlite3.Row
            return c
        if self.kind == "mysql":
            try:
                import pymysql
                from urllib.parse import unquote, urlparse
            except ImportError:
                sys.exit("缺少 MySQL 驱动，请：pip install pymysql（建议装到 voice/venv）")
            u = urlparse(self.mysql_dsn)
            return pymysql.connect(
                host=u.hostname, port=u.port or 3306,
                user=unquote(u.username or ""), password=unquote(u.password or ""),
                database=(u.path or "").lstrip("/"), charset="utf8mb4",
                autocommit=True, cursorclass=pymysql.cursors.DictCursor,
            )
        # postgresql
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError:
            sys.exit('缺少 PostgreSQL 驱动，请：pip install "psycopg[binary]"（建议装到 voice/venv）')
        return psycopg.connect(self.pg_dsn, autocommit=True, row_factory=dict_row)

    def _sql(self, sql):
        # 内部统一写 %s；sqlite 驱动需要 ?
        return sql.replace("%s", "?") if self.kind in ("sqlite", "sqlite3") else sql

    def execute(self, sql, params=()):
        cur = self.conn.cursor()
        cur.execute(self._sql(sql), params)
        rows = [dict(r) for r in cur.fetchall()] if cur.description else []
        return _Cur(rows)

    def begin(self):
        # sqlite 用 BEGIN IMMEDIATE 抢写锁；mysql/pg 走 autocommit，无需显式事务
        if self.kind in ("sqlite", "sqlite3"):
            self.conn.execute("BEGIN IMMEDIATE")

    def commit(self):
        if not self.autocommit:
            self.conn.commit()

    def ensure_tables(self):
        """幂等建表：三库 DDL 对齐（建表由服务端/schema 也做，这里保证独立可用）。"""
        if self.kind in ("sqlite", "sqlite3"):
            self.conn.executescript("""
                CREATE TABLE IF NOT EXISTS admin_users (
                    username TEXT PRIMARY KEY, password TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'viewer', enabled INTEGER NOT NULL DEFAULT 1,
                    is_builtin INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_builtin
                    ON admin_users(is_builtin) WHERE is_builtin=1;
                CREATE TABLE IF NOT EXISTS admin_sessions (
                    token TEXT PRIMARY KEY, username TEXT NOT NULL,
                    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
            """)
        elif self.kind == "mysql":
            self.execute("""CREATE TABLE IF NOT EXISTS admin_users (
                username VARCHAR(255) PRIMARY KEY, password VARCHAR(512) NOT NULL,
                role VARCHAR(32) NOT NULL DEFAULT 'viewer', enabled TINYINT NOT NULL DEFAULT 1,
                is_builtin TINYINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")
            self.execute("""CREATE TABLE IF NOT EXISTS admin_sessions (
                token VARCHAR(255) PRIMARY KEY, username VARCHAR(255) NOT NULL,
                created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")
        else:  # postgresql
            self.execute("""CREATE TABLE IF NOT EXISTS admin_users (
                username TEXT PRIMARY KEY, password TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'viewer', enabled INTEGER NOT NULL DEFAULT 1,
                is_builtin INTEGER NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL
            )""")
            self.execute("""CREATE TABLE IF NOT EXISTS admin_sessions (
                token TEXT PRIMARY KEY, username TEXT NOT NULL,
                created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
            )""")
            try:
                self.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_builtin "
                             "ON admin_users(is_builtin) WHERE is_builtin=1")
            except Exception:
                pass  # 部分唯一索引在部分托管 PG 上不可建，忽略

    def upsert_builtin(self, username, pw):
        """新建内置管理员（原 INSERT OR REPLACE 的三库方言版）。"""
        ts = int(time.time())
        if self.kind in ("sqlite", "sqlite3"):
            self.execute("INSERT OR REPLACE INTO admin_users"
                         "(username,password,role,enabled,is_builtin,updated_at) "
                         "VALUES(%s,%s,'admin',1,1,%s)", (username, pw, ts))
        elif self.kind == "mysql":
            self.execute("""INSERT INTO admin_users"
                         "(username,password,role,enabled,is_builtin,updated_at) "
                         "VALUES(%s,%s,'admin',1,1,%s) ON DUPLICATE KEY UPDATE "
                         "password=VALUES(password),role=VALUES(role),enabled=VALUES(enabled),"
                         "is_builtin=VALUES(is_builtin),updated_at=VALUES(updated_at)""",
                         (username, pw, ts))
        else:
            self.execute("""INSERT INTO admin_users"
                         "(username,password,role,enabled,is_builtin,updated_at) "
                         "VALUES(%s,%s,'admin',1,1,%s) ON CONFLICT(username) DO UPDATE SET "
                         "password=EXCLUDED.password,role=EXCLUDED.role,enabled=EXCLUDED.enabled,"
                         "is_builtin=EXCLUDED.is_builtin,updated_at=EXCLUDED.updated_at""",
                         (username, pw, ts))

db = Db(kind, sqlite_path, mysql_dsn, pg_dsn)
db.ensure_tables()

def rows(sql, params=()):
    return db.execute(sql, params).fetchall()

def show():
    rs = rows("SELECT username, role, enabled, is_builtin FROM admin_users "
              "ORDER BY is_builtin DESC, username")
    if not rs:
        print("（无账号）")
        return
    for r in rs:
        print(f"  {r['username']:<20} role={r['role']:<10} "
              f"enabled={r['enabled']} builtin={r['is_builtin']}")

print(f"数据库: {kind}" + (f" ({db.sqlite_path})" if kind in ("sqlite", "sqlite3") else ""))
if action == "list":
    print("当前账号：")
    show()
    sys.exit(0)

db.begin()

# --fix-roles：修复角色功能权限（兜底）。清空自定义配置，回到默认矩阵；
# 内置管理员恒为全功能，不受此表影响。不重置密码、不动账号。
if action == "fix-roles":
    try:
        db.execute("DELETE FROM role_features")
        db.commit()
        print("修复：角色功能权限自定义配置已清空，恢复默认矩阵")
        print("  viewer = 概览/日志；operator = 概览/日志/连通测试；admin = 全部")
    except Exception as e:
        print(f"修复角色功能权限失败（表可能尚未创建）：{e}")
    sys.exit(0)

builtins = rows("SELECT username, role, enabled FROM admin_users WHERE is_builtin=1")

# --fix：修复异常
if action == "fix":
    if len(builtins) > 1:
        keep = builtins[0]["username"]
        # 部分唯一索引只允许一个 builtin=1：先全清，再设回要保留的那个
        db.execute("UPDATE admin_users SET is_builtin=0 WHERE is_builtin=1")
        db.execute("UPDATE admin_users SET is_builtin=1 WHERE username=%s", (keep,))
        builtins = [r for r in builtins if r["username"] == keep]
        print(f"修复：多个内置管理员，保留 {keep}")
    if not builtins:
        # 尝试从 admin_credentials / admin.conf 恢复
        try:
            src = rows("SELECT username, password FROM admin_credentials WHERE id=1")
        except Exception:
            src = []
        user, pw = None, None
        if src and src[0]["password"]:
            user, pw = src[0]["username"], src[0]["password"]
        else:
            # 与原脚本一致：恢复源是 voice.conf（兼容旧 admin.conf 命名）
            conf = os.path.join(home, "voice.conf")
            if not os.path.isfile(conf):
                alt = os.path.join(home, "admin.conf")
                if os.path.isfile(alt):
                    conf = alt
            if os.path.isfile(conf):
                cfg = {}
                for line in open(conf, encoding="utf-8"):
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    cfg[k.strip()] = v.strip().strip("'\"")
                user, pw = cfg.get("ADMIN_USER", "admin"), cfg.get("ADMIN_PASSWORD")
        if not pw:
            pw = secrets.token_urlsafe(18)
            print("修复：无内置管理员，已新建并生成随机密码（见下方）")
        user = user or "admin"
        db.upsert_builtin(user, pw)
        builtins = rows("SELECT username, role, enabled FROM admin_users WHERE is_builtin=1")
    else:
        b = builtins[0]
        # 角色被改 / 被禁用：重置回来
        if b["role"] != "admin" or not b["enabled"]:
            db.execute("UPDATE admin_users SET role='admin', enabled=1, updated_at=%s "
                       "WHERE username=%s", (int(time.time()), b["username"]))
            print(f"修复：内置管理员 {b['username']} 角色/禁用状态已重置")
        builtins = rows("SELECT username, role, enabled FROM admin_users WHERE is_builtin=1")

# reset / fix 都重置密码（fix 仅在新建时已设密码，这里 --password 时也覆盖）
if not builtins:
    sys.exit("没有内置管理员且无法恢复，请用 --fix")
bu = builtins[0]["username"]
if password is None:
    password = secrets.token_urlsafe(18)
    generated = True
else:
    generated = False
db.execute("UPDATE admin_users SET password=%s, updated_at=%s WHERE username=%s",
           (password, int(time.time()), bu))
# 清掉该账号所有会话，旧 token 立即失效
db.execute("DELETE FROM admin_sessions WHERE username=%s", (bu,))
db.commit()

print(f"内置管理员：{bu}")
if generated:
    print(f"新密码（仅显示一次，请立即保存）：{password}")
else:
    print("密码已按 --password 更新")
print("已清除该账号的所有登录会话，需重新登录。")
print("当前账号：")
show()
PYEOF
