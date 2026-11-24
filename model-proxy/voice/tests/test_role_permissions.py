"""角色权限矩阵回归测试。

覆盖三角色（viewer / operator / admin）对所有关键 /admin/api/* 端点的访问权限，
验证「后端强制分级」——绕过前端直接调接口也按角色 401/403 拦截。

角色层级：viewer(0) < operator(1) < admin(2)，高角色自动拥有低角色权限。
权限来源：admin_panel.py 的 ROLE_ORDER / require_role 与各路由的 Depends。

矩阵（期望状态码）：
- viewer：只读端点 200；operator/admin 端点 403
- operator：只读 + 测试端点 200；admin 管理端点 403
- admin：全部 200
- 公开端点（captcha / me / 登录页）：未登录也可访问

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_role_permissions.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

_VOICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_VOICE_DIR))

_RESULTS: list[tuple[str, bool]] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    _RESULTS.append((name, bool(cond)))
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")


# 端点矩阵：(方法, 路径, 最小角色)
# 最小角色：viewer=0 / operator=1 / admin=2
ENDPOINTS: list[tuple[str, str, str]] = [
    # ── viewer 及以上（只读）──
    ("GET",  "/admin/api/status",              "viewer"),
    ("GET",  "/admin/api/overview",            "viewer"),
    ("GET",  "/admin/api/overview-cache-stats","viewer"),
    ("GET",  "/admin/api/log-files",           "viewer"),
    ("GET",  "/admin/api/logs",                "viewer"),
    ("GET",  "/admin/api/schema-history",      "viewer"),
    ("GET",  "/admin/api/speech-models",       "viewer"),
    ("GET",  "/admin/api/enabled-models",      "viewer"),
    # ── operator 及以上（测试类）──
    ("POST", "/admin/api/probe",               "operator"),
    ("POST", "/admin/api/stt-builtin-test",    "operator"),
    ("POST", "/admin/api/tts-builtin-test",    "operator"),
    ("POST", "/admin/api/stt-upstream-test",   "operator"),
    ("POST", "/admin/api/tts-upstream-test",   "operator"),
    ("POST", "/admin/api/dashscope-models",    "operator"),
    # ── admin only（管理类）──
    ("GET",  "/admin/api/config",              "admin"),
    ("GET",  "/admin/api/corrections",         "admin"),
    ("GET",  "/admin/api/llm-pool",            "admin"),
    ("GET",  "/admin/api/embed-pool",          "admin"),
    ("GET",  "/admin/api/rerank-pool",         "admin"),
    ("GET",  "/admin/api/speech-secrets",      "admin"),
    ("GET",  "/admin/api/users",               "admin"),
    ("GET",  "/admin/api/api-keys",            "admin"),
    ("GET",  "/admin/api/rate/policies",       "admin"),
    ("GET",  "/admin/api/rate/bindings",       "admin"),
    ("GET",  "/admin/api/mcp/servers",         "admin"),
    ("GET",  "/admin/api/mcp/tools",           "admin"),
    ("GET",  "/admin/api/mcp/acl",             "admin"),
]
ROLE_LEVEL = {"viewer": 0, "operator": 1, "admin": 2}


def req(client, method: str, path: str):
    if method == "GET":
        return client.get(path)
    return client.post(path, json={})


def main() -> int:
    import admin_panel
    import voice_db
    import config_store
    import openai_voice_server as srv
    from fastapi.testclient import TestClient

    tmpdir = tempfile.mkdtemp(prefix="voice_perm_test_")
    db_path = os.path.join(tmpdir, "voice.db")
    voice_db.configure(db_path)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    voice_db.set_auto_seed(True)
    config_store.configure(db_path, None, None)
    # 关闭验证码：本测试用账号密码直接登录，避免 400 干扰角色断言
    config_store.instance().bulk({"ADMIN_CAPTCHA": "off"})
    admin_panel.init_admin(os.path.join(tmpdir, "voice.conf"), tmpdir)
    builtin = admin_panel.load_admin_config()

    try:
        # 建三个账号（admin 用内置，再补 viewer/operator）
        voice_db.admin_user_add("perm_viewer", "viewpass123", "viewer")
        voice_db.admin_user_add("perm_op", "oppass12345", "operator")
        admin_user = builtin["user"]
        admin_pw = builtin["password"]
        # 内置密码可能是随机播种值，用 init 返回的；若为空则从 load 取
        if not admin_pw:
            admin_pw = admin_panel.load_admin_config()["password"]

        admin_panel.register_admin_routes(srv.app)

        def login_client(user: str, pw: str):
            c = TestClient(srv.app)
            r = c.post("/admin/login", data={"user": user, "password": pw})
            return c, r

        clients: dict[str, TestClient] = {}
        for role, (u, p) in {
            "viewer": ("perm_viewer", "viewpass123"),
            "operator": ("perm_op", "oppass12345"),
            "admin": (admin_user, admin_pw),
        }.items():
            c, r = login_client(u, p)
            check(f"{role} 登录成功", r.status_code == 200,
                  f"(HTTP {r.status_code})")
            clients[role] = c

        # ── 权限矩阵 ──
        for method, path, min_role in ENDPOINTS:
            need = ROLE_LEVEL[min_role]
            for role, lvl in ROLE_LEVEL.items():
                resp = req(clients[role], method, path)
                expected = 200 if lvl >= need else 403
                check(f"{role:8s} {method:5s} {path} -> {expected}",
                      resp.status_code == expected,
                      f"(实际 {resp.status_code})")

        # ── 未登录访问受保护端点应 401 ──
        anon = TestClient(srv.app)
        for method, path, _ in ENDPOINTS[:3]:  # 抽 3 个代表性端点
            resp = req(anon, method, path)
            check(f"未登录 {method} {path} -> 401", resp.status_code == 401,
                  f"(实际 {resp.status_code})")

        # ── 公开端点：未登录可访问 ──
        check("未登录访问 /admin/ -> 200", anon.get("/admin/").status_code == 200)
        check("未登录访问 /admin/api/captcha -> 200",
              anon.get("/admin/api/captcha").status_code == 200)
        me = anon.get("/admin/api/me").json()
        check("未登录 /admin/api/me -> authenticated:false",
              me.get("authenticated") is False)
        check("未登录访问 /admin/login -> 405(GET 不允许)",
              anon.get("/admin/login").status_code == 405)

    finally:
        pass

    passed = sum(1 for _, ok in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"\n== SUMMARY: {passed}/{total} passed ==")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
