"""管理面板鉴权加固回归测试（v9，v10 后聚焦会话/审计/Cookie/白名单/安全头）。

播种/迁移/内置管理员相关断言已迁到 test_user_management.py。

覆盖：
1. 初始随机密码写入 admin_users 表，二次调用一致。
2. 登录失败写 audit、不锁定；audit 不含密码原文。
3. Cookie 属性：HTTP 无 Secure、HTTPS 有 Secure；httponly/samesite/path。
4. /admin 受 IP 白名单约束（环回放行、非白名单 403）。
5. /admin 响应带安全头。

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_admin_hardening.py
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


def main() -> int:
    import admin_panel
    import voice_db
    import openai_voice_server as srv
    from fastapi.testclient import TestClient

    tmpdir = tempfile.mkdtemp(prefix="voice_admin_hardening_")
    db_path = os.path.join(tmpdir, "voice.db")
    voice_db.configure(db_path)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    voice_db.set_auto_seed(True)

    old_home = getattr(admin_panel, "VOICE_HOME_DIR", None)
    admin_panel.init_admin(os.path.join(tmpdir, "voice.conf"), tmpdir)

    try:
        # ── 1) 首次随机密码写入 admin_users ───────────────────────
        cfg = admin_panel.load_admin_config()
        check("首次生成非空密码", bool(cfg["password"]))
        check("首次密码不是 admin", cfg["password"] != "admin")
        stored = voice_db.admin_user_get(cfg["user"])
        check("密码写入 admin_users 表", stored is not None)
        check("内置管理员标记", bool(stored and stored["is_builtin"]))
        check("二次调用密码不变", admin_panel.load_admin_config()["password"] == cfg["password"])

        # 用 srv.app（已挂 security_middleware / client_ip_audit_middleware）测端到端
        admin_panel.register_admin_routes(srv.app)
        client = TestClient(srv.app)

        # ── 2) 失败审计、不锁定 ────────────────────────────────────
        first_fail = client.post("/admin/login", data={"user": cfg["user"], "password": "wrong-pass"})
        check("错误密码返回 401", first_fail.status_code == 401)
        for _ in range(4):
            client.post("/admin/login", data={"user": cfg["user"], "password": "wrong-pass"})
        r_ok = client.post("/admin/login", data={"user": cfg["user"], "password": cfg["password"]})
        check("连续失败后正确密码仍可登录（不锁定）", r_ok.status_code == 200)

        audits = voice_db.recent_audit(200)
        fails = [a for a in audits if a["action"] == "admin_login_failed"]
        check("失败写 audit（>=5 条）", len(fails) >= 5)
        check("audit 不含密码原文", all("wrong-pass" not in (a["detail"] or "") for a in fails))

        # ── 3) Cookie 属性 ─────────────────────────────────────────
        set_cookie = r_ok.headers.get("set-cookie", "").lower()
        check("HTTP 登录 Cookie 无 Secure", "secure" not in set_cookie)
        check("Cookie HttpOnly", "httponly" in set_cookie)
        check("Cookie SameSite=Lax", "samesite=lax" in set_cookie)
        check("Cookie path=/admin", "path=/admin" in set_cookie)
        client_https = TestClient(srv.app, base_url="https://testserver")
        r_https = client_https.post("/admin/login", data={"user": cfg["user"], "password": cfg["password"]})
        check("HTTPS 登录 Cookie 带 Secure", "secure" in r_https.headers.get("set-cookie", "").lower())

        # ── 5) 安全响应头 ──────────────────────────────────────────
        r_page = client.get("/admin")
        check("/admin 带 X-Content-Type-Options", r_page.headers.get("x-content-type-options") == "nosniff")
        check("/admin 带 X-Frame-Options", r_page.headers.get("x-frame-options") == "DENY")
        check("/admin 带 Referrer-Policy", r_page.headers.get("referrer-policy") == "no-referrer")

        # ── 4) /admin 白名单（环回放行、非白名单 403）───────────────
        original_config_value = srv.config_value
        original_client_ip = srv.client_ip
        try:
            srv.config_value = lambda key, default=None: (
                "203.0.113.0/24" if key == "VOICE_IP_ALLOW" else original_config_value(key, default)
            )
            srv.client_ip = lambda request: "127.0.0.1"
            check("环回访问 /admin 放行", client.get("/admin").status_code == 200)
            srv.client_ip = lambda request: "198.51.100.9"
            check("非白名单 IP 访问 /admin 返回 403", client.get("/admin").status_code == 403)
        finally:
            srv.config_value = original_config_value
            srv.client_ip = original_client_ip

    finally:
        if old_home is not None:
            admin_panel.init_admin(getattr(admin_panel, "VOICE_CONF_PATH", ""), old_home)

    passed = sum(1 for _, ok in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"\n== SUMMARY: {passed}/{total} passed ==")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
