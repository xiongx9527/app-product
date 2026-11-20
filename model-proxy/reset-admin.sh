#!/usr/bin/env bash
# 重置/修复内置管理员（直接改本地 SQLite voice.db，不经过运行中的服务）。
#
# 用法：
#   ./reset-admin.sh                 # 重置内置管理员密码（随机生成，打印一次）
#   ./reset-admin.sh --password XXX  # 指定新密码（至少 8 位）
#   ./reset-admin.sh --fix           # 修复内置管理员异常（缺失/重复/被禁用/角色被改）
#   ./reset-admin.sh --list          # 列出所有账号及状态
#
# 可设 VOICE_HOME 指向运行目录（默认 ~/.app-product/voice）。
# 服务运行时也可执行：SQLite 用 BEGIN IMMEDIATE 事务，安全并发。
set -euo pipefail

VOICE_HOME="${VOICE_HOME:-$HOME/.app-product/voice}"
DB="$VOICE_HOME/voice.db"
CONF="$VOICE_HOME/voice.conf"
VENV_PY="$VOICE_HOME/venv/bin/python"

[ -f "$DB" ] || { echo "找不到数据库：$DB（设 VOICE_HOME 指向正确目录）" >&2; exit 1; }
# 直接用系统 python3 跑内联脚本（不依赖 venv，只用标准库 sqlite3/secrets/os）。
PY="${VENV_PY:-python3}"; [ -x "$PY" ] || PY=python3

exec "$PY" - "$DB" "$CONF" "$@" <<'PYEOF'
import sys, os, sqlite3, secrets, time

db, conf = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
action = "reset"
password = None
if "--list" in args:
    action = "list"
elif "--fix" in args:
    action = "fix"
if "--password" in args:
    i = args.index("--password")
    if i + 1 >= len(args):
        print("--password 需要一个值", file=sys.stderr); sys.exit(1)
    password = args[i + 1]
    if len(password) < 8:
        print("密码至少 8 位", file=sys.stderr); sys.exit(1)

conn = sqlite3.connect(db, timeout=10)
conn.row_factory = sqlite3.Row
# 兼容尚未升级到 v10 的库：确保目标表存在（幂等）
conn.executescript("""
CREATE TABLE IF NOT EXISTS admin_users (
    username TEXT PRIMARY KEY, password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer', enabled INTEGER NOT NULL DEFAULT 1,
    is_builtin INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_builtin ON admin_users(is_builtin) WHERE is_builtin=1;
CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
""")
def rows(sql, params=()):
    return conn.execute(sql, params).fetchall()

def show():
    rs = rows("SELECT username, role, enabled, is_builtin FROM admin_users ORDER BY is_builtin DESC, username")
    if not rs:
        print("（无账号）")
        return
    for r in rs:
        print(f"  {r['username']:<20} role={r['role']:<10} enabled={r['enabled']} builtin={r['is_builtin']}")

if action == "list":
    print("当前账号："); show(); sys.exit(0)

with conn:  # BEGIN IMMEDIATE 由 sqlite3 的 DML 隐式获取写锁
    conn.execute("BEGIN IMMEDIATE")
    builtins = rows("SELECT username, role, enabled FROM admin_users WHERE is_builtin=1")

    # --fix：修复异常
    if action == "fix":
        if len(builtins) > 1:
            keep = builtins[0]["username"]
            # 部分唯一索引只允许一个 builtin=1：先全清，再设回要保留的那个
            conn.execute("UPDATE admin_users SET is_builtin=0 WHERE is_builtin=1")
            conn.execute("UPDATE admin_users SET is_builtin=1 WHERE username=?", (keep,))
            builtins = [r for r in builtins if r["username"] == keep]
            print(f"修复：多个内置管理员，保留 {keep}")
        if not builtins:
            # 尝试从 admin_credentials / admin.conf 恢复
            src = rows("SELECT username, password FROM admin_credentials WHERE id=1")
            user, pw = None, None
            if src and src[0]["password"]:
                user, pw = src[0]["username"], src[0]["password"]
            elif os.path.isfile(conf):
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
            conn.execute(
                "INSERT OR REPLACE INTO admin_users(username,password,role,enabled,is_builtin,updated_at) "
                "VALUES(?,?, 'admin',1,1,?)", (user, pw, int(time.time())))
            builtins = [conn.execute("SELECT username, role, enabled FROM admin_users WHERE is_builtin=1").fetchone()]
        else:
            b = builtins[0]
            # 角色被改 / 被禁用：重置回来
            if b["role"] != "admin" or not b["enabled"]:
                conn.execute("UPDATE admin_users SET role='admin', enabled=1, updated_at=? WHERE username=?",
                             (int(time.time()), b["username"]))
                print(f"修复：内置管理员 {b['username']} 角色/禁用状态已重置")
            builtins = [conn.execute("SELECT username, role, enabled FROM admin_users WHERE is_builtin=1").fetchone()]

    # reset / fix 都重置密码（fix 仅在新建时已设密码，这里 --password 时也覆盖）
    if not builtins:
        print("没有内置管理员且无法恢复，请用 --fix", file=sys.stderr); sys.exit(1)
    bu = builtins[0]["username"]
    if password is None:
        password = secrets.token_urlsafe(18)
        generated = True
    else:
        generated = False
    conn.execute("UPDATE admin_users SET password=?, updated_at=? WHERE username=?",
                 (password, int(time.time()), bu))
    # 清掉该账号所有会话，旧 token 立即失效
    conn.execute("DELETE FROM admin_sessions WHERE username=?", (bu,))

print(f"内置管理员：{bu}")
if generated:
    print(f"新密码（仅显示一次，请立即保存）：{password}")
else:
    print("密码已按 --password 更新")
print("已清除该账号的所有登录会话，需重新登录。")
print("当前账号："); show()
PYEOF
