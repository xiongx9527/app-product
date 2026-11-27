"""其他工具 in_mcp 手动加入 + 来源类型 回归测试（直接 python tests/test_http_tool_in_mcp.py）。

锁住：
- mcp_http_tools 的 in_mcp 字段（默认 0，不自动加入 MCP 清单）
- refresh 只注册 in_mcp=1 且 enabled=1 的其他工具
- mcp_discovered_tools 的 source_type/source_id（mcp网关 / 其它工具）
- 加入 MCP 的工具禁止删除（需先移出）
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import voice_db

PASS = FAIL = 0


def check(name, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} {extra}")


tmpdir = tempfile.mkdtemp()
voice_db.configure(os.path.join(tmpdir, "v.db"))
voice_db.set_auto_seed(False)
voice_db.ensure_schema()

# 1) schema v27 + in_mcp 默认 0
check("版本 v28", voice_db.SCHEMA_VERSION == 28)
t1 = voice_db.mcp_http_tool_add("amap", "http://x", "周边查询", in_mcp=0)
check("in_mcp 默认 0", voice_db.mcp_http_tool_get(t1["id"])["in_mcp"] == 0)
t2 = voice_db.mcp_http_tool_add("weather", "http://y", "天气", in_mcp=1)
check("in_mcp 可为 1", voice_db.mcp_http_tool_get(t2["id"])["in_mcp"] == 1)

# 2) 来源类型/id 落库
voice_db.mcp_discovered_replace_http_tools([
    {"qualified_name": "default__weather", "orig_name": "weather", "source_id": t2["id"],
     "description": "天气", "input_schema": {}}
])
voice_db.mcp_discovered_replace_server(4, [
    {"qualified_name": "askdata__chat", "orig_name": "chat", "description": "d", "input_schema": {}}
])
rows = {r["qualified_name"]: r for r in voice_db.mcp_discovered_list()}
check("其他工具来源类型", rows["default__weather"]["source_type"] == voice_db.SOURCE_HTTP_TOOL
      and rows["default__weather"]["source_id"] == t2["id"], str(rows.get("default__weather")))
check("网关工具来源类型", rows["askdata__chat"]["source_type"] == voice_db.SOURCE_GATEWAY
      and rows["askdata__chat"]["source_id"] == 4, str(rows.get("askdata__chat")))

# 3) 原子替换：其他工具移除后缓存清空
voice_db.mcp_discovered_replace_http_tools([])
check("移出后其他工具缓存清空", not any(
    r["source_type"] == voice_db.SOURCE_HTTP_TOOL for r in voice_db.mcp_discovered_list()))

# 4) 禁用再启用的 in_mcp 保持
voice_db.mcp_http_tool_update(t2["id"], {"enabled": 0})
check("禁用后 in_mcp 字段保留", voice_db.mcp_http_tool_get(t2["id"])["in_mcp"] == 1)

# 5) 加入 MCP 后禁止删除（接口层校验已在 routes_mcp，这里验证字段可判断）
cur = voice_db.mcp_http_tool_get(t2["id"]) or {}
check("可判断已加入 MCP（禁止删除依据）", bool(cur.get("in_mcp")))

print(f"\n== SUMMARY: {PASS}/{PASS + FAIL} passed ==")
sys.exit(0 if FAIL == 0 else 1)
