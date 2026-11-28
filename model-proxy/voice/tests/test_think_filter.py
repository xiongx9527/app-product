"""思考链 <think> 剥离回归测试（直接 python tests/test_think_filter.py）。

锁住 qwen3 等混合推理模型经 ollama OpenAI 兼容端点调用时，代理在响应侧
剥离 content 里的 <think>...</think>，避免思考链出现在回复里。
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


# 1) 非流式：剥离 <think> 段
obj = {"choices": [{"message": {"role": "assistant", "content": "<think>\n思考过程\n</think>\n最终答案"}}]}
out = lp.strip_think_response(json.loads(json.dumps(obj)))
check("非流式剥离思考段", out["choices"][0]["message"]["content"] == "\n最终答案",
      repr(out["choices"][0]["message"]["content"]))

# 2) 非流式：无 <think> 不动
obj2 = {"choices": [{"message": {"content": "普通回答"}}]}
out2 = lp.strip_think_response(json.loads(json.dumps(obj2)))
check("非流式无思考段不动", out2["choices"][0]["message"]["content"] == "普通回答")

# 3) 流式：单帧内完整 <think>
t = lp.ThinkFilterStream("qwen3:8b")
frame = 'data: ' + json.dumps({"choices": [{"delta": {"content": "<think>思考</think>答案"}}]}) + '\n'
res = t.feed(frame.encode())
parsed = json.loads(res.strip()[5:])
check("流式单帧剥离", parsed["choices"][0]["delta"]["content"] == "答案",
      repr(parsed["choices"][0]["delta"]["content"]))

# 4) 流式：<think> 跨多帧（标签被拆开）
t = lp.ThinkFilterStream("qwen3:8b")
parts = ["<thi", "nk>思考中", "</thi", "nk>答案"]
collected = []
for p in parts:
    frame = 'data: ' + json.dumps({"choices": [{"delta": {"content": p}}]}) + '\n'
    res = t.feed(frame.encode())
    if res.strip():
        for line in res.strip().split(b"\n"):
            if line.startswith(b"data:"):
                collected.append(json.loads(line[5:])["choices"][0]["delta"].get("content", ""))
joined = "".join(collected)
check("流式跨帧剥离", "思考中" not in joined and "答案" in joined,
      repr(joined))

# 5) 流式：正常文本不以 < 结尾时不受影响
t = lp.ThinkFilterStream("qwen3:8b")
frame = 'data: ' + json.dumps({"choices": [{"delta": {"content": "hello world"}}]}) + '\n'
res = t.feed(frame.encode())
parsed = json.loads(res.strip()[5:])
check("流式普通文本不动", parsed["choices"][0]["delta"]["content"] == "hello world",
      repr(parsed["choices"][0]["delta"]["content"]))

# 6) prepare：所有 OpenAI 兼容端点都启用（内容驱动，不按 vendor/端口/think 判断）
req, stream_cls, resp_transform = lp.prepare(
    "openai_chat_completions", "http://host.docker.internal:11434/v1", "", "qwen3:8b", "",
    {"messages": [{"role": "user", "content": "hi"}]}, vendor="ollama")
check("ollama 启用 ThinkFilter", stream_cls is lp.ThinkFilterStream,
      f"{stream_cls.__name__}")
# 非 ollama 端点同样启用（内容驱动，无 <think> 时透明）
req2, stream_cls2, _ = lp.prepare(
    "openai_chat_completions", "https://api.deepseek.com/v1", "", "deepseek", "",
    {"messages": [{"role": "user", "content": "hi"}]}, vendor="deepseek")
check("非 ollama 端点也启用（内容驱动）", stream_cls2 is lp.ThinkFilterStream,
      f"{stream_cls2.__name__}")
# think=true 也启用（标签不该进正文，思考走 reasoning_content）
req3, stream_cls3, _ = lp.prepare(
    "openai_chat_completions", "http://host.docker.internal:11434/v1", "", "qwen3:8b", "",
    {"messages": [{"role": "user", "content": "hi"}], "think": True}, vendor="ollama")
check("think=true 仍启用（思考走 reasoning_content）", stream_cls3 is lp.ThinkFilterStream,
      f"{stream_cls3.__name__}")

# 7) 思考内容进 reasoning_content（非流式 + 流式）
obj3 = {"choices": [{"message": {"content": "<think>推理</think>答案"}}]}
out3 = lp.strip_think_response(json.loads(json.dumps(obj3)))
m3 = out3["choices"][0]["message"]
check("非流式思考进 reasoning_content",
      m3["content"] == "答案" and m3.get("reasoning_content") == "推理",
      repr(m3))
t = lp.ThinkFilterStream("qwen3:8b")
frame = 'data: ' + json.dumps({"choices": [{"delta": {"content": "<think>推理</think>答案"}}]}) + '\n'
res = t.feed(frame.encode())
d3 = json.loads(res.strip()[5:])["choices"][0]["delta"]
check("流式思考进 reasoning_content",
      d3.get("content") == "答案" and d3.get("reasoning_content") == "推理",
      repr(d3))

# 8) 其他模型透传：无 <think> 的 SSE 流字节级原样（含 usage 尾帧、[DONE]、多帧拆分）
frames = [
    {"choices": [{"delta": {"content": ""}}]},
    {"choices": [{"delta": {"content": "你好"}}]},
    {"choices": [{"delta": {"content": "，世界"}}]},
    {"choices": [{"delta": {}, "finish_reason": "stop"}],
     "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}},
]
raw = b"".join(b"data: " + json.dumps(f, ensure_ascii=False).encode() + b"\n\n" for f in frames)
raw += b"data: [DONE]\n\n"
t2 = lp.ThinkFilterStream("deepseek-flash")
out2 = b""
for i in range(0, len(raw), 17):  # 模拟任意分块
    out2 += t2.feed(raw[i:i + 17])
out2 += t2.finish()
check("其他模型无think字节级透传", out2 == raw, f"in={len(raw)} out={len(out2)}")
check("其他模型usage不受影响", t2.usage == {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
      str(t2.usage))

# 9) 上游原生 reasoning_content（deepseek-reasoner 风格）不被改写
obj4 = {"choices": [{"delta": {"content": "2", "reasoning_content": "上游原生思考"}}]}
t3 = lp.ThinkFilterStream("deepseek-reasoner")
frame4 = 'data: ' + json.dumps(obj4, ensure_ascii=False) + '\n'
res4 = t3.feed(frame4.encode())
d4 = json.loads(res4.strip()[5:])["choices"][0]["delta"]
check("上游原生reasoning_content透传",
      d4.get("content") == "2" and d4.get("reasoning_content") == "上游原生思考",
      repr(d4))
# 非流式同样不改原生 reasoning_content
obj5 = {"choices": [{"message": {"content": "2", "reasoning_content": "原生"}}]}
out5 = lp.strip_think_response(json.loads(json.dumps(obj5)))
m5 = out5["choices"][0]["message"]
check("非流式不覆盖原生reasoning", m5.get("reasoning_content") == "原生", repr(m5))

print(f"\n== SUMMARY: {PASS}/{PASS + FAIL} passed ==")
sys.exit(0 if FAIL == 0 else 1)
