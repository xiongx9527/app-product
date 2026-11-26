"""Skill 管理后端回归测试（v25）。

覆盖：
1. schema 建表 skills + 版本升到 25
2. CRUD：增/查/改/删 + 按 name 查 + 重名唯一约束
3. 渐进披露对外接口：清单只回 name/description，正文回 content；仅 enabled 可见
4. 对外接口鉴权：VOICE_API_KEY_AUTH=on 时 /skills 需 Bearer Key（白名单外）
5. 角色功能矩阵：新增 skill 功能域，admin 恒可用、viewer/operator 默认不可用
6. 管理接口：内置管理员可增删改查；skill 路径归属 skill 功能域
7. 写操作记入审计

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_skills.py
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
    import voice_db
    import config_store
    import admin_panel
    from fastapi.testclient import TestClient

    tmpdir = tempfile.mkdtemp(prefix="voice_skills_test_")
    db_path = os.path.join(tmpdir, "voice.db")
    voice_db.configure(db_path)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    voice_db.set_auto_seed(True)
    config_store.configure(db_path, None, None)
    config_store.instance().bulk({"ADMIN_CAPTCHA": "off"})
    admin_panel.init_admin(os.path.join(tmpdir, "voice.conf"), tmpdir)
    builtin = admin_panel.load_admin_config()

    # 1) schema 版本 + 建表
    check("schema 版本>=25", voice_db.SCHEMA_VERSION >= 25, str(voice_db.SCHEMA_VERSION))
    check("v25 变更已登记", 25 in voice_db.SCHEMA_CHANGES)

    # 2) CRUD
    s = voice_db.skill_add("pdf-processing", "处理 PDF 的指引", "# PDF\n用 pdftotext。", 1)
    check("新增返回行", bool(s) and s["name"] == "pdf-processing", str(s))
    check("按 id 查", voice_db.skill_get(s["id"])["content"].startswith("# PDF"))
    check("按 name 查", voice_db.skill_get_by_name("pdf-processing")["id"] == s["id"])
    dupe = False
    try:
        voice_db.skill_add("pdf-processing", "重复", "x", 1)
    except Exception:
        dupe = True
    check("重名被唯一约束拒绝", dupe)
    voice_db.skill_update(s["id"], {"description": "改过的摘要", "content": "# 新正文", "enabled": 0})
    updated = voice_db.skill_get(s["id"])
    check("改描述", updated["description"] == "改过的摘要")
    check("改正文", updated["content"] == "# 新正文")
    check("改启停", updated["enabled"] == 0)

    # 3) 渐进披露对外接口
    voice_db.skill_add("meeting-notes", "会议纪要模板", "# 纪要\n请按模板写。", 1)   # enabled
    voice_db.skill_add("disabled-skill", "已停用", "hidden", 0)                     # disabled
    pub = voice_db.skill_public_list()
    names = {x["name"] for x in pub}
    check("清单含启用的", "meeting-notes" in names, str(names))
    check("清单排除停用的", "disabled-skill" not in names, str(names))
    check("清单不含正文字段", all("content" not in x for x in pub), str(pub))
    detail = voice_db.skill_public_get("meeting-notes")
    check("正文接口回 content", detail and detail["content"].startswith("# 纪要"))
    check("停用技能正文不可见", voice_db.skill_public_get("disabled-skill") is None)

    # 4) 角色功能矩阵新增 skill 域
    check("skill 在功能域列表", "skill" in voice_db.VALID_GRANT_FEATURES)
    check("admin 恒可用 skill", voice_db.role_feature_allowed("admin", "skill") is True)
    check("viewer 默认不可用 skill", voice_db.role_feature_allowed("viewer", "skill") is False)
    check("operator 默认不可用 skill", voice_db.role_feature_allowed("operator", "skill") is False)
    check("skill 路径归属 skill 域", admin_panel._feature_for_path("/admin/api/skills") == "skill")

    # 5) 管理接口（TestClient）
    try:
        import openai_voice_server as srv
        # register_admin_routes 现在也会挂载 routes_skill（无需手动 include）
        admin_panel.register_admin_routes(srv.app)
        with TestClient(srv.app) as client:
            # 未登录 401
            r = client.get("/admin/api/skills")
            check("管理接口未登录 401", r.status_code == 401, str(r.status_code))
            # 登录（表单提交，验证码已通过 ADMIN_CAPTCHA=off 关闭）
            lr = client.post("/admin/login", data={
                "user": builtin["user"], "password": builtin["password"]})
            check("内置管理员登录", lr.status_code == 200, lr.text[:200])
            r = client.get("/admin/api/skills")
            check("登录后列技能", r.status_code == 200 and len(r.json()["skills"]) >= 2,
                  r.text[:200])
            # 新增（合法 name）
            r = client.post("/admin/api/skills", json={
                "name": "api-test-skill", "description": "d", "content": "# c", "enabled": 1})
            check("管理接口新增", r.status_code == 200 and r.json().get("ok"), r.text[:200])
            # 非法 name 400
            r = client.post("/admin/api/skills", json={
                "name": "Bad Name!", "description": "d", "content": "c"})
            check("非法 name 400", r.status_code == 400, str(r.status_code))
            # 重名 400
            r = client.post("/admin/api/skills", json={
                "name": "api-test-skill", "description": "d", "content": "c"})
            check("管理接口重名 400", r.status_code == 400, str(r.status_code))
            # 对外清单（开放接口，无鉴权）
            r = client.get("/skills")
            check("对外清单 200", r.status_code == 200, str(r.status_code))
            names2 = {x["name"] for x in r.json()["skills"]}
            check("对外清单不含停用", "disabled-skill" not in names2, str(names2))
            r = client.get("/skills/meeting-notes")
            check("对外正文 200", r.status_code == 200 and "content" in r.json(), r.text[:200])
            r = client.get("/skills/no-such-skill")
            check("不存在技能 404", r.status_code == 404, str(r.status_code))
    except Exception as exc:
        check("TestClient 接口测试", False, repr(exc))

    # 6) 审计
    rows = voice_db._conn_get().execute(
        "SELECT action, detail FROM audit WHERE action IN "
        "('skill_add','skill_update','skill_delete','skill_enable')"
    ).fetchall()
    check("新增记审计", any(r["action"] == "skill_add" for r in rows),
          str([r["action"] for r in rows]))

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
