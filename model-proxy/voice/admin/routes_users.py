"""管理面板路由 · 用户 / API Key / 限流策略域。

由 admin_panel.register_admin_routes 在运行时加载，共享鉴权与状态从主模块按需取，
避免顶层循环 import（主模块只在 register 函数内部 import 本模块）。
"""
from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

import rate_store
import voice_db
import admin_panel as ap  # 共享辅助/鉴权依赖；调用时根模块已完全加载


def build_router() -> APIRouter:
    """创建「用户管理」域的 router。"""
    router = APIRouter()
    require_admin = ap.require_admin

    # ── 用户管理（仅 admin）────────────────────────────────────────
    @router.get("/admin/api/users", dependencies=[Depends(require_admin)])
    def admin_users_list():
        return {"users": voice_db.admin_users_list()}

    @router.post("/admin/api/users", dependencies=[Depends(require_admin)])
    def admin_users_add(request: Request, body: dict[str, Any]):
        username = (body or {}).get("username") or ""
        password = (body or {}).get("password") or ""
        role = (body or {}).get("role") or "viewer"
        if len(password) < 8:
            raise HTTPException(status_code=400, detail="密码至少 8 位")
        try:
            acct = voice_db.admin_user_add(username, password, role)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        client = request.client.host if request.client else "unknown"
        voice_db.append_audit(client, "admin_user_add", f"user={username},role={role}")
        return {"ok": True, "user": acct}

    @router.patch("/admin/api/users/{username}", dependencies=[Depends(require_admin)])
    def admin_users_patch(request: Request, username: str, body: dict[str, Any]):
        client = request.client.host if request.client else "unknown"
        body = body or {}
        if "role" in body:
            try:
                voice_db.admin_user_set_role(username, body["role"])
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            voice_db.append_audit(client, "admin_user_role", f"user={username},role={body['role']}")
        if "enabled" in body:
            try:
                voice_db.admin_user_set_enabled(username, bool(body["enabled"]))
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            voice_db.append_audit(client, "admin_user_enabled",
                                  f"user={username},enabled={bool(body['enabled'])}")
        if "password" in body:
            pw = body["password"] or ""
            if len(pw) < 8:
                raise HTTPException(status_code=400, detail="密码至少 8 位")
            try:
                voice_db.admin_user_reset_password(username, pw)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            voice_db.append_audit(client, "admin_user_reset_password", f"user={username}")
        return {"ok": True, "user": voice_db.admin_user_get(username)}

    @router.delete("/admin/api/users/{username}", dependencies=[Depends(require_admin)])
    def admin_users_delete(request: Request, username: str):
        try:
            voice_db.admin_user_delete(username)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        client = request.client.host if request.client else "unknown"
        voice_db.append_audit(client, "admin_user_delete", f"user={username}")
        return {"ok": True}

    # ── API Key 管理（仅 admin）─────────────────────────────────────
    @router.get("/admin/api/api-keys", dependencies=[Depends(require_admin)])
    def admin_api_keys_list():
        return {"keys": voice_db.api_keys_list()}

    @router.post("/admin/api/api-keys", dependencies=[Depends(require_admin)])
    def admin_api_keys_create(request: Request, body: dict[str, Any]):
        body = body or {}
        token = secrets.token_urlsafe(32)
        try:
            row = voice_db.api_key_create(
                token,
                name=(body.get("name") or "").strip(),
                not_before=body.get("not_before"),
                expires_at=body.get("expires_at"),
                allowed_ips=body.get("allowed_ips") or [],
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        client = request.client.host if request.client else "unknown"
        voice_db.append_audit(client, "api_key_create",
                              f"id={row['id']},prefix={row['key_prefix']}")
        # 明文只此一次返回，供复制；之后面板只显示前缀。
        return {"ok": True, "key": token, "row": row}

    @router.patch("/admin/api/api-keys/{key_id}", dependencies=[Depends(require_admin)])
    def admin_api_keys_patch(request: Request, key_id: int, body: dict[str, Any]):
        body = body or {}
        # 启停走专门的函数（api_key_update 的白名单不含 enabled，之前会被静默忽略）
        if "enabled" in body:
            voice_db.api_key_set_enabled(key_id, bool(body["enabled"]))
        fields = {k: v for k, v in body.items() if k != "enabled"}
        if fields:
            voice_db.api_key_update(key_id, **fields)
        client = request.client.host if request.client else "unknown"
        voice_db.append_audit(client, "api_key_update", f"id={key_id}")
        return {"ok": True}

    @router.delete("/admin/api/api-keys/{key_id}", dependencies=[Depends(require_admin)])
    def admin_api_keys_delete(request: Request, key_id: int):
        voice_db.api_key_delete(key_id)
        rate_store.reset(key_id)  # 删 key 时清限流计数，避免 id 复用残留
        client = request.client.host if request.client else "unknown"
        voice_db.append_audit(client, "api_key_delete", f"id={key_id}")
        return {"ok": True}

    # ── 限流策略管理（仅 admin）────────────────────────────────────
    @router.get("/admin/api/rate/policies", dependencies=[Depends(require_admin)])
    def rate_policies_list():
        return {"policies": voice_db.rate_policies_list()}

    @router.post("/admin/api/rate/policies", dependencies=[Depends(require_admin)])
    def rate_policy_add(request: Request, body: dict[str, Any]):
        b = body or {}
        try:
            row = voice_db.rate_policy_add(
                b.get("name") or "", int(b.get("req_per_min") or 0),
                int(b.get("llm_tokens_per_min") or 0), int(b.get("asr_seconds_per_min") or 0),
                int(b.get("tts_chars_per_min") or 0), (b.get("description") or "").strip(),
                period=(b.get("period") or "minute"),
                embed=int(b.get("embed_tokens_per_min") or 0),
                rerank=int(b.get("rerank_tokens_per_min") or 0),
            )
        except (ValueError, TypeError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        voice_db.append_audit(request.client.host if request.client else "unknown",
                              "rate_policy_add", f"id={row['id']},name={row['name']}")
        return {"ok": True, "policy": row}

    @router.patch("/admin/api/rate/policies/{policy_id}", dependencies=[Depends(require_admin)])
    def rate_policy_patch(request: Request, policy_id: int, body: dict[str, Any]):
        b = body or {}
        fields = {k: b[k] for k in ("name", "description", "enabled", "req_per_min",
                  "llm_tokens_per_min", "asr_seconds_per_min", "tts_chars_per_min",
                  "embed_tokens_per_min", "rerank_tokens_per_min", "period") if k in b}
        for k in ("req_per_min", "llm_tokens_per_min", "asr_seconds_per_min",
                  "tts_chars_per_min", "embed_tokens_per_min", "rerank_tokens_per_min", "enabled"):
            if k in fields:
                try:
                    fields[k] = int(fields[k])
                except (ValueError, TypeError):
                    raise HTTPException(status_code=400, detail=f"{k} 必须是数字")
        try:
            if "is_default" in b:
                voice_db.rate_policy_set_default(policy_id, bool(b["is_default"]))
            row = voice_db.rate_policy_update(policy_id, **fields) if fields else voice_db.rate_policy_get(policy_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        voice_db.append_audit(request.client.host if request.client else "unknown",
                              "rate_policy_update", f"id={policy_id}")
        return {"ok": True, "policy": row}

    @router.delete("/admin/api/rate/policies/{policy_id}", dependencies=[Depends(require_admin)])
    def rate_policy_delete(request: Request, policy_id: int):
        try:
            voice_db.rate_policy_delete(policy_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        voice_db.append_audit(request.client.host if request.client else "unknown",
                              "rate_policy_delete", f"id={policy_id}")
        return {"ok": True}

    @router.get("/admin/api/rate/bindings", dependencies=[Depends(require_admin)])
    def rate_bindings_list():
        rows = voice_db._conn_get().execute(
            "SELECT id AS key_id, key_prefix, name FROM admin_api_keys ORDER BY id"
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["name"] = d["name"] or d["key_prefix"]
            d["policy_ids"] = voice_db.rate_binding_list(d["key_id"])
            out.append(d)
        return {"bindings": out}

    @router.patch("/admin/api/rate/bindings/{key_id}", dependencies=[Depends(require_admin)])
    def rate_bindings_patch(request: Request, key_id: int, body: dict[str, Any]):
        b = body or {}
        try:
            # 只接受 policy_ids：绑定即启用，全解绑即用默认；没有 per-key 开关。
            if "policy_ids" in b:
                voice_db.rate_binding_set(key_id, [int(x) for x in (b["policy_ids"] or [])])
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        voice_db.append_audit(request.client.host if request.client else "unknown",
                              "rate_binding_update", f"key_id={key_id}")
        return {"ok": True}

    # ── 单账号单独授权（v20）：仅内置管理员可管理 ──────────────────
    def _require_builtin(request: Request) -> str:
        tok = request.cookies.get(ap.SESSION_COOKIE)
        user = voice_db.session_username(tok) if tok else None
        acct = voice_db.admin_user_get(user) if user else None
        if not acct or not acct.get("is_builtin") or not acct.get("enabled"):
            raise HTTPException(status_code=403, detail="仅内置管理员可管理角色权限")
        return user

    @router.get("/admin/api/grants", dependencies=[Depends(require_admin)])
    def grants_list():
        return {"grants": voice_db.grants_list(), "features": list(voice_db.VALID_GRANT_FEATURES)}

    @router.put("/admin/api/grants/{username}/{feature}", dependencies=[Depends(require_admin)])
    def grants_set(request: Request, username: str, feature: str, body: dict[str, Any]):
        actor = _require_builtin(request)
        role = (body or {}).get("role") or None  # null/空 = 撤销
        if role == "":
            role = None
        try:
            voice_db.grant_set(username, feature, role)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        action = "grant_revoke" if role is None else "grant_set"
        voice_db.append_audit(
            request.client.host if request.client else "unknown", action,
            f"actor={actor} user={username} feature={feature} role={role or '-'}",
        )
        return {"ok": True}

    # ── 角色功能矩阵（v21）：仅内置管理员可管理 ────────────────────
    @router.get("/admin/api/role-features", dependencies=[Depends(require_admin)])
    def role_features_get():
        custom = {r["role"] + "/" + r["feature"]: bool(r["enabled"])
                  for r in voice_db.role_features_list()}
        roles = ("viewer", "operator", "admin")
        data = {}
        for role in roles:
            data[role] = {
                f: custom.get(role + "/" + f, voice_db.DEFAULT_ROLE_FEATURES[role][f])
                for f in voice_db.VALID_GRANT_FEATURES
            }
        return {"roles": roles, "features": list(voice_db.VALID_GRANT_FEATURES),
                "matrix": data, "defaults": voice_db.DEFAULT_ROLE_FEATURES}

    @router.put("/admin/api/role-features/{role}/{feature}", dependencies=[Depends(require_admin)])
    def role_features_set(request: Request, role: str, feature: str, body: dict[str, Any]):
        actor = _require_builtin(request)
        enabled = bool((body or {}).get("enabled"))
        try:
            voice_db.role_feature_set(role, feature, enabled)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        voice_db.append_audit(
            request.client.host if request.client else "unknown", "role_feature_set",
            f"actor={actor} role={role} feature={feature} enabled={enabled}",
        )
        return {"ok": True}

    @router.post("/admin/api/role-features/{role}/reset", dependencies=[Depends(require_admin)])
    def role_features_reset(request: Request, role: str):
        actor = _require_builtin(request)
        try:
            voice_db.role_features_reset(role)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        voice_db.append_audit(
            request.client.host if request.client else "unknown", "role_feature_reset",
            f"actor={actor} role={role}",
        )
        return {"ok": True}

    return router
