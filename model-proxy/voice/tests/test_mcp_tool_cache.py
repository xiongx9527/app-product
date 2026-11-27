"""MCP 工具发现缓存（v26）回归测试。

覆盖：
1. schema v26 + mcp_discovered_tools 表
2. 缓存 CRUD：按 server 替换 / 列表 / 按 server 取 / 名字集 / 清空
3. refresh 成功后落库；refresh 失败时保留旧缓存（工具仍在对外清单）
4. ACL prune 使用缓存工具名，上游临时挂掉不误清授权
5. 已删除/禁用 server 的缓存被清理

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_mcp_tool_cache.py
"""
from __future__ import annotations

import json
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
    import mcp_gateway as g

    tmpdir = tempfile.mkdtemp(prefix="mcp_tool_cache_")
    db = os.path.join(tmpdir, "voice.db")
    voice_db.configure(db)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()

    # 1) schema
    check("schema>=26", voice_db.SCHEMA_VERSION >= 26, str(voice_db.SCHEMA_VERSION))
    check("v26 已登记", 26 in voice_db.SCHEMA_CHANGES)
    tables = {r["name"] for r in voice_db._conn_get().execute(
        "select name from sqlite_master where type='table'").fetchall()}
    check("缓存表存在", "mcp_discovered_tools" in tables)

    # 2) CRUD
    voice_db.mcp_discovered_replace_server(1, [
        {"qualified_name": "a__t1", "orig_name": "t1", "description": "工具1",
         "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}}},
        {"qualified_name": "a__t2", "orig_name": "t2", "description": "工具2",
         "input_schema": {}},
    ])
    check("按 server 取", len(voice_db.mcp_discovered_by_server(1)) == 2)
    check("schema 是 dict", isinstance(voice_db.mcp_discovered_by_server(1)[0]["input_schema"], dict))
    check("名字集", voice_db.mcp_discovered_names() == {"a__t1", "a__t2"})
    # 替换：t2 消失，t3 出现
    voice_db.mcp_discovered_replace_server(1, [
        {"qualified_name": "a__t3", "orig_name": "t3", "description": "工具3", "input_schema": {}},
    ])
    names = voice_db.mcp_discovered_names()
    check("替换生效", names == {"a__t3"}, str(names))
    voice_db.mcp_discovered_replace_server(2, [
        {"qualified_name": "b__t1", "orig_name": "t1", "description": "b工具", "input_schema": {}},
    ])
    check("多 server", len(voice_db.mcp_discovered_names()) == 2)

    # 3) ACL prune 用缓存工具名（上游挂了也不误清）
    voice_db.mcp_acl_set(0, ["a__t3", "b__t1", "stale__tool"])
    voice_db.mcp_acl_prune(voice_db.mcp_discovered_names())
    acl = {r["qualified_name"] for r in voice_db.mcp_acl_list()}
    check("ACL 保留缓存工具", "a__t3" in acl and "b__t1" in acl, str(acl))
    check("ACL 清掉真失效", "stale__tool" not in acl, str(acl))

    # 4) refresh 用 mock 模拟：先插入一个 server，第一次成功发现落库，第二次失败保留缓存
    srv = voice_db.mcp_server_add("mock", "http://127.0.0.1:9/mcp", enabled=1)
    voice_db.mcp_discovered_replace_server(srv["id"], [
        {"qualified_name": "mock__echo", "orig_name": "echo", "description": "缓存工具",
         "input_schema": {"type": "object"}},
    ])

    class FakeTool:
        def __init__(self, name):
            self.name = name
            self.input_schema = {"type": "object", "properties": {"q": {"type": "string"}}}
            self.description = "真实工具"

    class FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def list_tools(self): return [FakeTool("ping")]

    import asyncio
    orig_make = g._make_client

    async def ok_client(server, for_discovery=False):
        return FakeClient()

    async def bad_client(server, for_discovery=False):
        raise RuntimeError("upstream down")

    try:
        g._make_client = ok_client
        r1 = asyncio.run(g.refresh())
        check("refresh 成功落库", "mock__ping" in voice_db.mcp_discovered_names(),
              str(voice_db.mcp_discovered_names()))

        g._make_client = bad_client
        r2 = asyncio.run(g.refresh())
        check("失败时 server 被记 failed", srv["id"] in r2.get("failed_servers", []), str(r2))
        check("失败时缓存保留", "mock__ping" in voice_db.mcp_discovered_names(),
              str(voice_db.mcp_discovered_names()))
        check("失败时工具仍在内存清单", "mock__ping" in g._upstream_tools,
              str(list(g._upstream_tools.keys())))
    finally:
        g._make_client = orig_make

    # 5) 删除 server 后缓存被清
    voice_db.mcp_server_delete(srv["id"])
    import asyncio
    asyncio.run(g.refresh())
    check("删除 server 缓存被清", "mock__ping" not in voice_db.mcp_discovered_names(),
          str(voice_db.mcp_discovered_names()))

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
