"""管理面板路由 · Skill 管理域：提示词知识型技能的增删改查 / 启停。

由 admin_panel.register_admin_routes 在运行时加载。
Skill 全部落库（voice.db 的 skills 表），重启即可用；对外通过
GET /skills 清单 + GET /skills/{name} 正文渐进披露，所有 API Key 共享。
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

import admin_panel as ap
import voice_db

# name 作为对外路径段，限制为小写字母/数字开头，后可跟小写字母、数字、短横线、下划线。
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-_]*$")


def _audit(action: str, detail: str) -> None:
    try:
        voice_db.append_audit("admin", action, detail)
    except Exception:
        pass


def _validate_name(name: str) -> str:
    n = (name or "").strip()
    if not n or not _NAME_RE.match(n):
        raise HTTPException(400, "name 只能包含小写字母、数字、短横线、下划线，且以字母或数字开头")
    return n


def build_router() -> APIRouter:
    router = APIRouter()
    require_admin = ap.require_admin

    @router.get("/admin/api/skills", dependencies=[Depends(require_admin)])
    def skills_list():
        return {"skills": voice_db.skills_list()}

    @router.post("/admin/api/skills", dependencies=[Depends(require_admin)])
    def skill_add(body: dict[str, Any]):
        name = _validate_name(str(body.get("name") or ""))
        if voice_db.skill_get_by_name(name):
            raise HTTPException(400, f"Skill 名称 {name} 已存在")
        content = str(body.get("content") or "")
        description = str(body.get("description") or "").strip()
        row = voice_db.skill_add(name, description, content, int(body.get("enabled", 1)))
        _audit("skill_add", f"name={name}")
        return {"ok": True, "skill": row}

    @router.patch("/admin/api/skills/{sid}", dependencies=[Depends(require_admin)])
    def skill_update(sid: int, body: dict[str, Any]):
        old = voice_db.skill_get(sid)
        if not old:
            raise HTTPException(404, "Skill 不存在")
        fields: dict[str, Any] = {}
        if "name" in body:
            fields["name"] = _validate_name(str(body.get("name") or ""))
            dup = voice_db.skill_get_by_name(fields["name"])
            if dup and dup["id"] != sid:
                raise HTTPException(400, f"Skill 名称 {fields['name']} 已存在")
        for key in ("description", "content"):
            if key in body:
                fields[key] = str(body[key] or "")
        if "enabled" in body:
            fields["enabled"] = int(bool(body["enabled"]))
        row = voice_db.skill_update(sid, fields)
        _audit("skill_update", f"id={sid} name={row.get('name') if row else old.get('name')}")
        return {"ok": True, "skill": row}

    @router.delete("/admin/api/skills/{sid}", dependencies=[Depends(require_admin)])
    def skill_delete(sid: int):
        old = voice_db.skill_get(sid)
        if not old:
            raise HTTPException(404, "Skill 不存在")
        voice_db.skill_delete(sid)
        _audit("skill_delete", f"id={sid} name={old.get('name')}")
        return {"ok": True}

    @router.post("/admin/api/skills/{sid}/enable", dependencies=[Depends(require_admin)])
    def skill_enable(sid: int, body: dict[str, Any] | None = None):
        if not voice_db.skill_get(sid):
            raise HTTPException(404, "Skill 不存在")
        enabled = int(bool((body or {}).get("enabled", True)))
        voice_db.skill_update(sid, {"enabled": enabled})
        _audit("skill_enable", f"id={sid} enabled={enabled}")
        return {"ok": True, "enabled": enabled}

    @router.get("/admin/api/skills/{sid}/preview", dependencies=[Depends(require_admin)])
    def skill_preview(sid: int):
        """返回正文原文，供面板预览（不渲染 markdown，由前端处理）。"""
        row = voice_db.skill_get(sid)
        if not row:
            raise HTTPException(404, "Skill 不存在")
        return {"name": row["name"], "description": row["description"] or "",
                "content": row["content"] or ""}

    return router
