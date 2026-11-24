"""角色功能矩阵（v21）回归测试。

覆盖：
1. 默认矩阵：viewer=概览/日志；operator=+测试；admin=全功能
2. 内置管理员改角色功能后即时生效（鉴权按矩阵）
3. admin 恒全功能且不可被修改（后端拒绝）
4. 仅内置管理员可管理（普通 admin 403）
5. 操作记入审计
6. 重置恢复默认

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_role_features.py
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

    tmpdir = tempfile.mkdtemp(prefix="voice_rolefeat_test_")
    db_path = os.path.join(tmpdir, "voice.db")
    voice_db.configure(db_path)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    voice_db.set_auto_seed(True)
    config_store.configure(db_path, None, None)
    config_store.instance().bulk({"ADMIN_CAPTCHA": "off"})
    admin_panel.init_admin(os.path.join(tmpdir, "voice.conf"), tmpdir)
    builtin = admin_panel.load_admin_config()

    try:
        # 1) 默认矩阵
        check("viewer 默认可读日志", voice_db.role_feature_allowed("viewer", "logs") is True)
        check("viewer 默认不可改配置", voice_db.role_feature_allowed("viewer", "config") is False)
        check("operator 默认可测试", voice_db.role_feature_allowed("operator", "test") is True)
        check("operator 默认不可 MCP", voice_db.role_feature_allowed("operator", "mcp") is False)
        check("admin 恒全功能", all(voice_db.role_feature_allowed("admin", f)
                                   for f in voice_db.VALID_GRANT_FEATURES))

        voice_db.admin_user_add("rf_op", "rfoppass12", "operator")
        admin_panel.register_admin_routes(srv.app)

        # 2) 默认鉴权：operator 测 model config 403
        co = TestClient(srv.app)
        co.post("/admin/login", data={"user": "rf_op", "password": "rfoppass12"})
        check("默认 operator 改配置(应403)", co.get("/admin/api/config").status_code == 403)
        check("默认 operator 测试(应放行)", co.post("/admin/api/probe", json={}).status_code != 403)

        # 3) 内置管理员给 operator 开 config
        cb = TestClient(srv.app)
        cb.post("/admin/login", data={"user": builtin["user"], "password": builtin["password"]})
        r = cb.put("/admin/api/role-features/operator/config", json={"enabled": True})
        check("内置管理员改角色功能 200", r.status_code == 200)
        check("改后 operator 改配置(应200)", co.get("/admin/api/config").status_code == 200)

        # 4) admin 不可被修改
        r = cb.put("/admin/api/role-features/admin/config", json={"enabled": False})
        check("admin 功能不可改(应400)", r.status_code == 400)
        check("admin 仍全功能", all(voice_db.role_feature_allowed("admin", f)
                                   for f in voice_db.VALID_GRANT_FEATURES))

        # 5) 普通 admin 不能改角色功能
        voice_db.admin_user_add("rf_admin", "rfadmin123", "admin")
        ca = TestClient(srv.app)
        ca.post("/admin/login", data={"user": "rf_admin", "password": "rfadmin123"})
        r = ca.put("/admin/api/role-features/viewer/mcp", json={"enabled": True})
        check("普通 admin 改角色功能(应403)", r.status_code == 403)

        # 6) 审计
        rows = voice_db._conn_get().execute(
            "SELECT detail FROM audit WHERE action='role_feature_set' ORDER BY id DESC LIMIT 3"
        ).fetchall()
        check("角色功能变更记审计", any("operator" in (r["detail"] or "") for r in rows))

        # 7) 重置恢复默认
        cb.post("/admin/api/role-features/operator/reset")
        check("重置后 operator config 恢复默认(应403)", co.get("/admin/api/config").status_code == 403)

        # 8) 矩阵接口返回完整
        r = cb.get("/admin/api/role-features")
        data = r.json() if r.status_code == 200 else {}
        check("矩阵接口含三角色", set(data.get("roles", [])) == {"viewer", "operator", "admin"})
        check("矩阵接口含全部功能", set(data.get("features", [])) == set(voice_db.VALID_GRANT_FEATURES))

    finally:
        pass

    passed = sum(1 for _, ok in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"\n== SUMMARY: {passed}/{total} passed ==")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
