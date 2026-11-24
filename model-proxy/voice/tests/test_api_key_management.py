"""API Key 表管理回归测试（v10）。

覆盖：
1. 存哈希不存明文：库里读不到明文；create 返回明文一次。
2. 校验：哈希命中 + enabled + 时间窗口（not_before/expires_at）+ key 级绑定 IP（单 IP/CIDR）。
3. 存量 VOICE_API_KEY 迁移幂等（api_keys_migrate_legacy）。
4. 三态鉴权开关：显式 on/off、未设置时表内有 enabled key 即开启。
5. 管理端点越权（viewer 403、admin 200）。
6. 改表即时生效（verify 每次直查）。

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_api_key_management.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
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

    tmpdir = tempfile.mkdtemp(prefix="voice_apikey_test_")
    db_path = os.path.join(tmpdir, "voice.db")
    voice_db.configure(db_path)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    voice_db.set_auto_seed(True)
    # 测试用账号密码登录，关闭默认开启的登录验证码以免 400
    config_store.configure(db_path, None, None)
    config_store.instance().bulk({"ADMIN_CAPTCHA": "off"})
    old_home = getattr(admin_panel, "VOICE_HOME_DIR", None)
    admin_panel.init_admin(os.path.join(tmpdir, "voice.conf"), tmpdir)
    builtin = admin_panel.load_admin_config()

    try:
        # ── 1) 哈希存储 + 明文一次 ────────────────────────────────
        row = voice_db.api_key_create("my-secret-key-123", name="test")
        check("create 返回前缀", row["key_prefix"] == "my-secre")
        check("create 不返回哈希原文", "key_hash" not in row)
        raw = open(db_path, "rb").read().decode("latin1")
        check("库里无明文 key", "my-secret-key-123" not in raw)

        # ── 2) 校验 ──────────────────────────────────────────────
        check("正确 key 校验通过", voice_db.api_keys_verify("my-secret-key-123", "1.2.3.4") is not None)
        check("错误 key 拒绝", voice_db.api_keys_verify("wrong", "1.2.3.4") is None)

        now = int(time.time())
        voice_db.api_key_create("future-key", not_before=now + 3600)
        voice_db.api_key_create("expired-key", expires_at=now - 3600)
        check("未生效拒绝", voice_db.api_keys_verify("future-key", "1.2.3.4") is None)
        check("已过期拒绝", voice_db.api_keys_verify("expired-key", "1.2.3.4") is None)

        voice_db.api_key_create("ip-key", allowed_ips=["192.168.1.0/24"])
        check("IP 匹配放行", voice_db.api_keys_verify("ip-key", "192.168.1.10") is not None)
        check("IP 不匹配拒绝", voice_db.api_keys_verify("ip-key", "10.0.0.1") is None)
        check("非法 IP 拒绝", voice_db.api_keys_verify("ip-key", "not-an-ip") is None)

        # 启停
        kid = voice_db.api_key_create("toggle-key")["id"]
        check("启用态校验通过", voice_db.api_keys_verify("toggle-key", "1.2.3.4") is not None)
        voice_db.api_key_set_enabled(kid, False)
        check("禁用后校验拒绝", voice_db.api_keys_verify("toggle-key", "1.2.3.4") is None)

        # ── 3) 存量迁移幂等 ──────────────────────────────────────
        tmp2 = tempfile.mkdtemp(prefix="voice_apikey_migrate_")
        voice_db.configure(os.path.join(tmp2, "voice.db"))
        voice_db.ensure_schema()
        n1 = voice_db.api_keys_migrate_legacy(["legacy-key-a", "legacy-key-b"])
        n2 = voice_db.api_keys_migrate_legacy(["legacy-key-a"])
        check("存量迁移导入 2 把", n1 == 2)
        check("迁移幂等（第二次 0）", n2 == 0)
        check("迁移后可校验", voice_db.api_keys_verify("legacy-key-a", "1.2.3.4") is not None)
        voice_db.configure(db_path)
        voice_db.ensure_schema()

        # ── 4) 三态开关 ──────────────────────────────────────────
        original_config = srv.config_value
        try:
            srv.config_value = lambda k, d=None: ("on" if k == "VOICE_API_KEY_AUTH" else original_config(k, d))
            check("显式 on 开启", srv.api_key_auth_enabled())
            srv.config_value = lambda k, d=None: ("off" if k == "VOICE_API_KEY_AUTH" else original_config(k, d))
            check("显式 off 关闭", not srv.api_key_auth_enabled())
            srv.config_value = lambda k, d=None: ("" if k == "VOICE_API_KEY_AUTH" else original_config(k, d))
            # 新语义：建了 Key 不自动开启鉴权，必须显式 on（避免建测试 Key 就锁死所有接口）
            check("未设置+表有 key 仍视为关闭", not srv.api_key_auth_enabled())
        finally:
            srv.config_value = original_config

        # ── 5) 端点越权 ──────────────────────────────────────────
        admin_panel.register_admin_routes(srv.app)
        voice_db.admin_user_add("viewer1", "viewerpass1", "viewer")
        cv = TestClient(srv.app); cv.post("/admin/login", data={"user": "viewer1", "password": "viewerpass1"})
        check("viewer 访问 api-keys(应403)", cv.get("/admin/api/api-keys").status_code == 403)
        ca = TestClient(srv.app); ca.post("/admin/login", data={"user": builtin["user"], "password": builtin["password"]})
        check("admin 访问 api-keys(应200)", ca.get("/admin/api/api-keys").status_code == 200)
        r = ca.post("/admin/api/api-keys", json={"name": "via-api", "allowed_ips": ["10.0.0.0/8"]})
        check("admin 创建 key 返回明文", r.status_code == 200 and bool(r.json().get("key")))
        check("创建的 key 可校验", voice_db.api_keys_verify(r.json()["key"], "10.1.2.3") is not None)

    finally:
        if old_home is not None:
            admin_panel.init_admin(getattr(admin_panel, "VOICE_CONF_PATH", ""), old_home)

    passed = sum(1 for _, ok in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"\n== SUMMARY: {passed}/{total} passed ==")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
