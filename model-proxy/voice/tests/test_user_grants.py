"""单账号单独授权（v20）回归测试。

覆盖：
1. 授权提升功能域权限：viewer 在 config 域授 admin 后 _effective_role=admin，其它域仍 viewer
2. 撤销授权后回到角色默认
3. 仅内置管理员可管理授权（普通 admin / 普通用户 403）
4. 授权变更写入审计日志
5. 删除账号时清理其授权

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_user_grants.py
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

    tmpdir = tempfile.mkdtemp(prefix="voice_grants_test_")
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
        # 三个账号：viewer、普通 admin、内置 admin
        voice_db.admin_user_add("g_viewer", "gviewerpass", "viewer")
        voice_db.admin_user_add("g_admin", "gadminpass1", "admin")
        admin_panel.register_admin_routes(srv.app)

        # 0) 授权前：viewer 访问 config 应 403
        cv = TestClient(srv.app)
        cv.post("/admin/login", data={"user": "g_viewer", "password": "gviewerpass"})
        check("授权前 viewer 访问 config(应403)", cv.get("/admin/api/config").status_code == 403)

        # 1) 授权提升：viewer 在 config 域授 admin
        voice_db.grant_set("g_viewer", "config", "admin")
        check("授权后 config 域 effective=admin",
              admin_panel._effective_role("g_viewer", "/admin/api/config") == "admin")
        check("未授权 mcp 域仍 viewer",
              admin_panel._effective_role("g_viewer", "/admin/api/mcp/servers") == "viewer")
        check("授权列表含该条",
              any(g["username"] == "g_viewer" and g["feature"] == "config"
                  for g in voice_db.grants_list()))

        # 2) HTTP 层：授权后 viewer 能访问 config（原本 403）
        # 用内置管理员通过接口授权
        cb = TestClient(srv.app)
        cb.post("/admin/login", data={"user": builtin["user"], "password": builtin["password"]})
        r = cb.put("/admin/api/grants/g_viewer/config", json={"role": "admin"})
        check("内置管理员授权接口 200", r.status_code == 200)
        check("授权后 viewer 访问 config(应200)", cv.get("/admin/api/config").status_code == 200)
        check("未授权 mcp 仍 403", cv.get("/admin/api/mcp/servers").status_code == 403)

        # 3) 仅内置管理员可管理：普通 admin 调接口 403
        ca = TestClient(srv.app)
        ca.post("/admin/login", data={"user": "g_admin", "password": "gadminpass1"})
        r = ca.put("/admin/api/grants/g_viewer/test", json={"role": "operator"})
        check("普通 admin 改授权(应403)", r.status_code == 403)

        # 4) 审计日志：授权操作留痕
        rows = voice_db._conn_get().execute(
            "SELECT action, detail FROM audit WHERE action IN ('grant_set','grant_revoke') ORDER BY id DESC LIMIT 3"
        ).fetchall()
        check("授权操作记入审计", any("g_viewer" in (r["detail"] or "") for r in rows))

        # 5) 撤销授权后回到 viewer
        cb.put("/admin/api/grants/g_viewer/config", json={"role": None})
        check("撤销后 config 恢复 403", cv.get("/admin/api/config").status_code == 403)

        # 6) 删除账号清理授权
        voice_db.grant_set("g_viewer", "test", "operator")
        check("删除前有授权", len(voice_db.grants_list("g_viewer")) > 0)
        voice_db.admin_user_delete("g_viewer")
        check("删除账号后授权清空", len(voice_db.grants_list("g_viewer")) == 0)

    finally:
        pass

    passed = sum(1 for _, ok in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"\n== SUMMARY: {passed}/{total} passed ==")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
