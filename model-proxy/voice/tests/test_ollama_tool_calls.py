"""Ollama 原生路径工具调用转换回归测试（直接 python tests/test_ollama_tool_calls.py）。

锁住经代理调用 ollama 模型（qwen3:8b-think 等支持 tools 的模型）时：
- _build_ollama 透传 tools / tool_choice
- 非流式 ollama_to_openai 把 message.tool_calls 转成 OpenAI 格式
- 流式 OllamaStream 把 tool_calls 转成 delta.tool_calls（arguments 为 JSON 字符串）
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_protocols as lp

PASS = FAIL = 0


def check(name, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} {extra}")


TOOLS = [{"type": "function", "function": {
    "name": "get_weather", "description": "查天气",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
}}]

# 1) _build_ollama 透传 tools / tool_choice
req = lp._build_ollama("http://host.docker.internal:11434", "", "qwen3:8b-think",
                       {"model": "qwen3:8b-think", "messages": [], "tools": TOOLS,
                        "tool_choice": "required"})
check("tools 透传", req.payload.get("tools") == TOOLS, str(req.payload.get("tools")))
check("tool_choice 透传", req.payload.get("tool_choice") == "required")
check("URL 为原生 /api/chat", req.url.endswith("/api/chat"), req.url)

# 2) 非流式：ollama tool_calls -> OpenAI
raw = {"model": "qwen3:8b-think",
       "message": {"role": "assistant", "content": "",
                   "tool_calls": [{"function": {"name": "get_weather", "arguments": {"city": "北京"}}}]},
       "prompt_eval_count": 10, "eval_count": 5}
out = lp.ollama_to_openai(json.loads(json.dumps(raw)))
msg = out["choices"][0]["message"]
tc = (msg.get("tool_calls") or [{}])[0]
check("非流式 tool_calls 存在", bool(msg.get("tool_calls")))
check("非流式 name", tc.get("function", {}).get("name") == "get_weather", str(tc))
check("非流式 arguments 为 JSON 字符串",
      json.loads(tc["function"]["arguments"]) == {"city": "北京"}, str(tc))
check("非流式 finish_reason=tool_calls", out["choices"][0]["finish_reason"] == "tool_calls")

# 3) 流式：OllamaStream 把 tool_calls 转成 delta.tool_calls
t = lp.OllamaStream("qwen3:8b-think")
line1 = json.dumps({"model": "qwen3:8b-think", "done": False,
                    "message": {"role": "assistant", "content": "",
                                "tool_calls": [{"function": {"name": "get_weather", "arguments": {"city": "北京"}}}]}})
line2 = json.dumps({"model": "qwen3:8b-think", "done": True,
                    "prompt_eval_count": 10, "eval_count": 5,
                    "message": {"role": "assistant", "content": ""}})
out_bytes = t.feed((line1 + "\n" + line2 + "\n").encode())
out_bytes += t.finish()
frames = []
for line in out_bytes.decode().split("\n"):
    line = line.strip()
    if line.startswith("data:") and line[5:].strip() != "[DONE]":
        frames.append(json.loads(line[5:].strip()))
tc_frames = [f for f in frames if (f.get("choices") or [{}])[0].get("delta", {}).get("tool_calls")]
check("流式有 tool_calls 帧", bool(tc_frames), str(frames))
if tc_frames:
    dtc = tc_frames[0]["choices"][0]["delta"]["tool_calls"][0]
    check("流式 name", dtc.get("function", {}).get("name") == "get_weather", str(dtc))
    check("流式 arguments 为 JSON 字符串",
          json.loads(dtc["function"]["arguments"]) == {"city": "北京"}, str(dtc))
    check("流式 finish_reason=tool_calls",
          tc_frames[0]["choices"][0].get("finish_reason") == "tool_calls",
          str(tc_frames[0]["choices"][0]))
check("流式有 [DONE]", b"[DONE]" in out_bytes)

# 4) 无 tool_calls 时行为不变（普通回答）
plain = lp.ollama_to_openai({"model": "m", "message": {"content": "你好"}})
check("普通回答无 tool_calls", "tool_calls" not in plain["choices"][0]["message"])
check("普通回答 finish_reason=stop", plain["choices"][0]["finish_reason"] == "stop")

print(f"\n== SUMMARY: {PASS}/{PASS + FAIL} passed ==")
sys.exit(0 if FAIL == 0 else 1)
