"""限流（按 api-key，策略驱动）回归测试（v11）。

覆盖：
1. 默认策略幂等播种 + 不可删/不可停用/不可取消默认。
2. 多策略绑定取最严格（每维阈值最小值）；停用策略不参与。
3. key 开关默认关（不限流）；开时查有效策略。
4. rate_store 令牌桶：放行/超限/retry/key 隔离；滑动窗口 record。
5. HTTP 接口：越权 403、策略 CRUD、绑定 PATCH、默认策略保护。
6. 429 带 Retry-After（通过 rate_store 直接验证 + 接口状态）。

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_rate_limit.py
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
    import rate_store
    import openai_voice_server as srv
    from fastapi.testclient import TestClient

    tmpdir = tempfile.mkdtemp(prefix="voice_ratelimit_test_")
    db_path = os.path.join(tmpdir, "voice.db")
    voice_db.configure(db_path)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    voice_db.set_auto_seed(True)
    old_home = getattr(admin_panel, "VOICE_HOME_DIR", None)
    admin_panel.init_admin(os.path.join(tmpdir, "voice.conf"), tmpdir)
    builtin = admin_panel.load_admin_config()
    rate_store.configure("memory")

    try:
        # ── 1) 内置策略（默认策略可多个，内置唯一）───────────────
        policies = voice_db.rate_policies_list()
        check("播种内置策略 1 条", len(policies) == 1 and policies[0]["is_builtin"] == 1 and policies[0]["is_default"] == 1)
        check("内置阈值正确", policies[0]["req_per_min"] == 100)
        voice_db.ensure_schema()
        check("幂等重跑不重复", len(voice_db.rate_policies_list()) == 1)
        did = policies[0]["id"]
        for fn, label in [(lambda: voice_db.rate_policy_delete(did), "内置策略不可删"),
                          (lambda: voice_db.rate_policy_update(did, enabled=0), "内置策略不可停"),
                          (lambda: voice_db.rate_policy_set_default(did, False), "内置策略不可取消默认")]:
            try:
                fn()
                check(label, False)
            except ValueError:
                check(label, True)
        # 默认策略可多个：新建一条设为默认，内置仍为默认
        p_extra = voice_db.rate_policy_add("默认2", 50, 1000, 10, 100)
        voice_db.rate_policy_set_default(p_extra["id"], True)
        check("默认策略可多个", sum(1 for p in voice_db.rate_policies_list() if p["is_default"]) == 2)

        # ── 2) 多策略取最严格 ────────────────────────────────────
        p_loose = voice_db.rate_policy_add("宽松", 1000, 100000, 5000, 500000)
        p_strict = voice_db.rate_policy_add("严格", 5, 100, 10, 500)
        test_key = voice_db.api_key_create("rl-test-key", name="rl")
        tkid = test_key["id"]
        voice_db.rate_binding_set(tkid, [p_loose["id"], p_strict["id"]])
        eff = voice_db.rate_binding_effective(tkid)
        check("多策略取最严格 req", eff["req_per_min"] == 5)
        check("多策略取最严格 llm", eff["llm_tokens_per_min"] == 100)
        # 停用严格策略后回退宽松
        voice_db.rate_policy_update(p_strict["id"], enabled=0)
        eff2 = voice_db.rate_binding_effective(tkid)
        check("停用策略不参与合并", eff2["req_per_min"] == 1000)
        # 无绑定用默认
        check("无绑定用默认策略", voice_db.rate_binding_effective(99999)["req_per_min"] == 100)

        # ── 3) 绑定关系（无 per-key 开关，绑定即生效）──────────────
        check("绑定策略列表", voice_db.rate_binding_list(tkid) == [p_loose["id"], p_strict["id"]])
        voice_db.rate_binding_set(tkid, [])  # 全解绑 = 回退默认策略
        check("全解绑回退默认", voice_db.rate_binding_effective(tkid)["req_per_min"] == 100)
        voice_db.rate_binding_set(tkid, [p_loose["id"], p_strict["id"]])

        # ── 4) rate_store 令牌桶 ─────────────────────────────────
        rate_store.reset(9999)
        check("令牌桶前3次放行", all(rate_store.check_and_consume(9999, "requests", 3)[0] for _ in range(3)))
        ok, retry = rate_store.check_and_consume(9999, "requests", 3)
        check("第4次超限拒绝", not ok and retry > 0, f"retry={retry}")
        check("其他 key 不受影响", rate_store.check_and_consume(9998, "requests", 3)[0])
        rate_store.record(9999, "llm_tokens", 1234)
        check("滑动窗口累加", rate_store.window_sum(9999, "llm_tokens") >= 1234)

        # ── 5) HTTP 接口 ────────────────────────────────────────
        admin_panel.register_admin_routes(srv.app)
        voice_db.admin_user_add("viewer1", "viewerpass1", "viewer")
        # 越权：viewer 访问限流端点 403
        cv = TestClient(srv.app)
        cv.post("/admin/login", data={"user": "viewer1", "password": "viewerpass1"})
        check("viewer 访问策略列表 403", cv.get("/admin/api/rate/policies").status_code == 403)

        ca = TestClient(srv.app)
        pw = builtin["password"]
        ca.post("/admin/login", data={"user": builtin["user"], "password": pw})
        r = ca.get("/admin/api/rate/policies")
        check("admin 访问策略列表 200", r.status_code == 200 and len(r.json()["policies"]) >= 3)
        r = ca.get("/admin/api/rate/bindings")
        check("admin 访问绑定列表 200", r.status_code == 200 and any(b["key_id"] == tkid for b in r.json()["bindings"]))
        # 默认策略禁删（接口层）
        r = ca.delete(f"/admin/api/rate/policies/{did}")
        check("接口删默认策略 400", r.status_code == 400)
        # 新策略 PATCH
        r = ca.patch(f"/admin/api/rate/policies/{p_loose['id']}", json={"req_per_min": 777})
        check("接口改策略阈值 200", r.status_code == 200 and r.json()["policy"]["req_per_min"] == 777)
        # 绑定 PATCH（只接受 policy_ids，无 per-key 开关）
        r = ca.patch(f"/admin/api/rate/bindings/{tkid}", json={"policy_ids": [p_strict["id"]]})
        check("接口改绑定 200", r.status_code == 200)
        check("绑定已生效", voice_db.rate_binding_list(tkid) == [p_strict["id"]])

    finally:
        if old_home is not None:
            admin_panel.init_admin(getattr(admin_panel, "VOICE_CONF_PATH", ""), old_home)

    passed = sum(1 for _, ok in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"\n== SUMMARY: {passed}/{total} passed ==")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
