"""MCP 工具参数说明优先级回归测试。

锁定三层优先级（防止面板编辑的兜底被覆盖）：
  1. 面板编辑的覆盖（config_kv.MCP_PARAM_DESC_OVERRIDE）最高
  2. 上游 inputSchema 的 description 次之
  3. 内置参数名字典兜底最低

同时验证覆盖可按「工具|参数」精确匹配，也支持按参数名全局匹配。

运行：
    cd model-proxy/voice
    ~/.app-product/voice/venv/bin/python tests/test_mcp_param_desc.py
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
    import config_store
    import voice_db
    import admin.routes_mcp as rm

    tmp = tempfile.mkdtemp(prefix="mcp_param_desc_")
    db = os.path.join(tmp, "voice.db")
    voice_db.configure(db)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()
    config_store.configure(db, None, None)

    # 1) 无覆盖：上游 description 优先于内置字典
    check("上游 description 优先",
          rm._param_desc("question", "上游说明", "chat_start", {}) == "上游说明")

    # 2) 无上游 description：用内置字典
    got = rm._param_desc("question", "", "chat_start", {})
    check("内置字典兜底", "自然语言" in got, got)

    # 3) 有覆盖：覆盖优先于上游 description
    ov = {"chat_start|question": "面板编辑的说明"}
    check("覆盖优先于上游",
          rm._param_desc("question", "上游说明", "chat_start", ov) == "面板编辑的说明")

    # 4) 覆盖优先于内置字典
    check("覆盖优先于内置字典",
          rm._param_desc("question", "", "chat_start", ov) == "面板编辑的说明")

    # 5) 精确工具名匹配：别的工具不受影响
    check("精确工具名隔离",
          rm._param_desc("question", "上游说明", "mcp_question", ov) == "上游说明")

    # 6) 按参数名全局覆盖（无工具前缀）
    ov2 = {"question": "全局说明"}
    check("参数名全局覆盖",
          rm._param_desc("question", "上游说明", "any_tool", ov2) == "全局说明")

    # 7) 持久化：写入 config_kv 后 _param_desc_overrides 能读到
    config_store.instance().bulk({
        "MCP_PARAM_DESC_OVERRIDE": json.dumps({"chat_start|question": "持久化说明"}, ensure_ascii=False)
    })
    check("配置持久化可读",
          rm._param_desc_overrides().get("chat_start|question") == "持久化说明")

    # 8) _build_params 应用覆盖
    schema = {"properties": {"question": {"type": "string"}}, "required": ["question"]}
    params = rm._build_params(schema, "generic", "chat_start")
    check("_build_params 应用覆盖",
          params[0]["description"] == "持久化说明", params[0]["description"])
    check("_build_params 必填标记", params[0]["required"] is True)
    check("_build_params 类型", params[0]["type"] == "string")

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
