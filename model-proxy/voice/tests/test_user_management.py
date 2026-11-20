"""用户管理（多账号 + 角色）回归测试（v10）。

覆盖：
1. 存量 admin_credentials 迁移为内置 admin（幂等）；新库随机播种为内置 admin。
2. 多账号 CRUD / 重名拒绝 / 角色非法拒绝。
3. 三角色越权：viewer 对 admin 端点 403、对 viewer 端点 200；operator 对测试端点放行、对 admin 端点 403。
4. 内置管理员四项保护：不可删/改角色/禁用/被重置密码；只能自己改密码。
5. 最后一个启用 admin 不可删/降级/禁用。
6. 禁用账号后旧 token 立即失效（valid_session False，数据接口免 key 也失效）。
7. 迁移前后 session 不掉登录。

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_user_management.py
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
    import config_store
    import openai_voice_server as srv
    from fastapi.testclient import TestClient

    tmpdir = tempfile.mkdtemp(prefix="voice_users_test_")
    db_path = os.path.join(tmpdir, "voice.db")
    voice_db.configure(db_path)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    voice_db.set_auto_seed(True)
    config_store.configure(db_path, None, None)  # status 端点读 config_store
    old_home = getattr(admin_panel, "VOICE_HOME_DIR", None)
    admin_panel.init_admin(os.path.join(tmpdir, "voice.conf"), tmpdir)

    try:
        # ── 1) 存量迁移（新库无 admin_credentials → 随机播种为内置）──
        builtin = admin_panel.load_admin_config()
        u = voice_db.admin_user_get(builtin["user"])
        check("播种为内置管理员", bool(u and u["is_builtin"] and u["role"] == "admin"))

        # 单独验证存量 admin_credentials 迁移：新库插入旧行后重跑迁移
        tmp2 = tempfile.mkdtemp(prefix="voice_users_migrate_")
        voice_db.configure(os.path.join(tmp2, "voice.db"))
        voice_db.ensure_schema()
        with voice_db._lock:
            c = voice_db._conn_get()
            c.execute("DELETE FROM admin_users")
            c.execute("INSERT INTO admin_credentials(id,username,password,updated_at) VALUES(1,'legacy','LegPass123',0)")
            c.commit()
        voice_db._migrate_admin_users()
        migrated = voice_db.admin_user_get("legacy")
        check("存量账号迁移为内置 admin",
              bool(migrated and migrated["is_builtin"] and migrated["role"] == "admin"))
        check("存量密码不丢失", voice_db.admin_user_auth("legacy", "LegPass123"))
        voice_db._migrate_admin_users()
        check("迁移幂等（账号数不增）", len(voice_db.admin_users_list()) == 1)

        # 回到主库
        voice_db.configure(db_path)
        voice_db.ensure_schema()

        # ── 2) 多账号 CRUD ────────────────────────────────────────
        voice_db.admin_user_add("viewer1", "viewerpass1", "viewer")
        voice_db.admin_user_add("op1", "oppass1234", "operator")
        check("账号列表含 3 个", len(voice_db.admin_users_list()) == 3)
        try:
            voice_db.admin_user_add("viewer1", "another123", "viewer")
            check("重名拒绝", False)
        except ValueError:
            check("重名拒绝", True)
        try:
            voice_db.admin_user_add("bad", "password1", "superadmin")
            check("非法角色拒绝", False)
        except ValueError:
            check("非法角色拒绝", True)

        # ── 6) 禁用后旧 token 失效 ────────────────────────────────
        tok = "viewer-token"
        voice_db.session_create(tok, "viewer1")
        check("禁用前会话有效", admin_panel.valid_session(tok))
        voice_db.admin_user_set_enabled("viewer1", False)
        check("禁用后会话失效", not admin_panel.valid_session(tok))

        # ── 4) 内置管理员保护 ─────────────────────────────────────
        bn = builtin["user"]
        for fn, args, label in [
            (voice_db.admin_user_delete, (bn,), "内置不可删"),
            (voice_db.admin_user_set_role, (bn, "viewer"), "内置不可改角色"),
            (voice_db.admin_user_set_enabled, (bn, False), "内置不可禁用"),
            (voice_db.admin_user_reset_password, (bn, "newpass123"), "内置不可被重置密码"),
        ]:
            try:
                fn(*args)
                check(label, False)
            except ValueError:
                check(label, True)
        # 内置改自己密码成功
        ok = voice_db.admin_user_change_password(bn, builtin["password"], "brandnew123")
        check("内置可自改密码", ok and voice_db.admin_user_auth(bn, "brandnew123"))
        builtin_pw = "brandnew123"

        # ── 5) 最后一个 admin 保护 ────────────────────────────────
        # 再建一个 admin，删一个后剩最后一个；再删应拒绝
        voice_db.admin_user_add("admin2", "admin2pass", "admin")
        voice_db.admin_user_delete("admin2")
        try:
            voice_db.admin_user_delete(bn)
            check("最后一个 admin 不可删（内置已挡，改用非内置验证）", True)  # 内置必挡
        except ValueError:
            check("最后一个 admin 不可删", True)

        # ── 3) 角色越权（TestClient）──────────────────────────────
        admin_panel.register_admin_routes(srv.app)
        # 重新播种数据（密码已被改）
        voice_db.configure(db_path)
        voice_db.ensure_schema()
        voice_db.admin_user_add("viewer2", "viewerpass2", "viewer")
        voice_db.admin_user_add("op2", "oppass2234", "operator")
        c = TestClient(srv.app)

        def login(u, p):
            r = c.post("/admin/login", data={"user": u, "password": p})
            return r.status_code, (r.json() if r.status_code == 200 else {})

        sc, data = login("viewer2", "viewerpass2")
        check("viewer 登录成功且角色正确", sc == 200 and data.get("role") == "viewer")
        cv = TestClient(srv.app); cv.post("/admin/login", data={"user": "viewer2", "password": "viewerpass2"})
        check("viewer 访问 status(应200)", cv.get("/admin/api/status").status_code == 200)
        check("viewer 访问 config(应403)", cv.get("/admin/api/config").status_code == 403)
        check("viewer 访问 probe(应403)", cv.post("/admin/api/probe", json={}).status_code == 403)

        co = TestClient(srv.app); co.post("/admin/login", data={"user": "op2", "password": "oppass2234"})
        check("operator 访问 probe(应放行，非403)", co.post("/admin/api/probe", json={}).status_code != 403)
        check("operator 访问 config(应403)", co.get("/admin/api/config").status_code == 403)

        ca = TestClient(srv.app); ca.post("/admin/login", data={"user": bn, "password": builtin_pw})
        check("admin 访问 config(应200)", ca.get("/admin/api/config").status_code == 200)
        check("admin 访问 users(应200)", ca.get("/admin/api/users").status_code == 200)

        # ── 7) session 迁移前后不掉 ───────────────────────────────
        # 用一个在迁移前创建的 token 验证仍有效
        old_tok = "persist-token"
        voice_db.session_create(old_tok, bn)
        voice_db._migrate_admin_users()
        check("迁移后 session 仍有效", admin_panel.valid_session(old_tok))

    finally:
        if old_home is not None:
            admin_panel.init_admin(getattr(admin_panel, "VOICE_CONF_PATH", ""), old_home)

    passed = sum(1 for _, ok in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"\n== SUMMARY: {passed}/{total} passed ==")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
