"""llm_protocols 纯函数回归测试（无需起服务，直接 python tests/test_llm_protocols.py）。

锁住的关键点：线协议（URL 路径 + 流式翻译器）只由 protocol 决定，vendor 只是
管理面板的分组标签，不能把贴了 ollama 标签的 OpenAI 兼容端点（如 deepseek）
劫持到 ollama 原生 /api/chat。否则这类端点会 404。
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import llm_protocols as lp  # noqa: E402

_RESULTS: list[tuple[str, bool]] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    _RESULTS.append((name, cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")


def prep(protocol, base, vendor, model="m"):
    return lp.prepare(
        protocol, base, "sk-x", model, "",
        {"model": model, "messages": [{"role": "user", "content": "hi"}]},
        vendor,
    )


def main() -> int:
    # 1) uses_ollama_native：只认 protocol 显式为 ollama 旧别名
    check("uses_ollama_native(ollama)=True", lp.uses_ollama_native("ollama") is True)
    check("uses_ollama_native(openai_chat_completions)=False",
          lp.uses_ollama_native("openai_chat_completions") is False)
    check("uses_ollama_native(None)=False", lp.uses_ollama_native(None) is False)

    # 2) 贴 ollama 标签但走 OpenAI 兼容线协议：必须命 /v1/chat/completions
    #    OpenAI 兼容端点统一走 ThinkFilterStream（内容驱动剥离 <think>，无标签时透明透传）
    req, stream_cls, _ = prep("openai_chat_completions", "https://api.deepseek.com/v1", "ollama")
    check("vendor=ollama + openai 协议 -> /v1/chat/completions",
          req.url == "https://api.deepseek.com/v1/chat/completions", f"url={req.url}")
    check("vendor=ollama + openai 协议 -> ThinkFilterStream",
          stream_cls is lp.ThinkFilterStream, f"{stream_cls.__name__}")
    check("vendor=ollama + openai 协议 -> 不发 ollama 原生 think 字段",
          "think" not in req.payload, f"keys={list(req.payload)}")

    # 3) 显式 ollama 原生协议：仍走 /api/chat + OllamaStream（本地 ollama 不破坏）
    req2, stream_cls2, _ = prep("ollama", "http://127.0.0.1:11434", "ollama")
    check("protocol=ollama -> /api/chat",
          req2.url == "http://127.0.0.1:11434/api/chat", f"url={req2.url}")
    check("protocol=ollama -> OllamaStream",
          stream_cls2 is lp.OllamaStream, f"{stream_cls2.__name__}")

    # 4) prepare_models 同步：标签不劫持 /api/tags，原生协议才用
    url, _ = lp.prepare_models("openai_chat_completions", "https://api.deepseek.com/v1", "sk-x", "ollama")
    check("prepare_models 标签不劫持 -> /v1/models",
          url.endswith("/v1/models"), f"url={url}")
    url2, _ = lp.prepare_models("ollama", "http://127.0.0.1:11434", "sk-x", "ollama")
    check("prepare_models 原生 -> /api/tags",
          url2.endswith("/api/tags"), f"url={url2}")

    # 5) 其它线协议不受影响
    for proto, needle in [("anthropic_messages", "/v1/messages"),
                          ("openai_responses", "/v1/responses")]:
        r, _, _ = prep(proto, "https://x.example.com", "")
        check(f"{proto} 路径不受影响", needle in r.url, f"url={r.url}")

    # 6) usage 旁路解析（6 种协议）
    exp = {"prompt_tokens": 5, "completion_tokens": 21, "total_tokens": 26}
    t = lp.StreamTranslator("m")
    t.feed(b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
    t.feed(b'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":21,"total_tokens":26}}\n\n')
    check("usage: openai 透传尾帧", t.usage == exp, f"usage={t.usage}")

    o = lp.OllamaStream("m")
    o.feed(b'{"message":{"content":"hi"},"done":true,"prompt_eval_count":5,"eval_count":21}\n')
    check("usage: ollama done 行", o.usage == exp, f"usage={o.usage}")

    a = lp.AnthropicStream("m")
    a.feed(b'event: message_start\ndata: {"message":{"usage":{"input_tokens":5}}}\n\n')
    a.feed(b'event: message_delta\ndata: {"usage":{"output_tokens":21}}\n\n')
    check("usage: anthropic start+delta", a.usage == exp, f"usage={a.usage}")

    g = lp.GeminiStream("m")
    g.feed(b'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":21,"totalTokenCount":26}}\n\n')
    check("usage: gemini usageMetadata", g.usage == exp, f"usage={g.usage}")

    r = lp.OpenAiResponsesStream("m")
    r.feed(b'event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"output_tokens":21,"total_tokens":26}}}\n\n')
    check("usage: responses completed", r.usage == exp, f"usage={r.usage}")

    # 7) 非流式翻译保留 usage
    ou = lp.ollama_to_openai({"model": "m", "message": {"content": "hi"}, "prompt_eval_count": 5, "eval_count": 21})
    check("usage: ollama 非流式保留", ou.get("usage") == exp, f"usage={ou.get('usage')}")
    au = lp.anthropic_to_openai({"model": "m", "content": [], "usage": {"input_tokens": 5, "output_tokens": 21}})
    check("usage: anthropic 非流式保留", au.get("usage") == exp, f"usage={au.get('usage')}")
    gu = lp.gemini_to_openai({"model": "m", "candidates": [], "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 21}})
    check("usage: gemini 非流式保留", gu.get("usage") == exp, f"usage={gu.get('usage')}")
    ru = lp.openai_responses_to_openai({"model": "m", "output": [], "usage": {"input_tokens": 5, "output_tokens": 21}})
    check("usage: responses 非流式保留", ru.get("usage") == exp, f"usage={ru.get('usage')}")

    # 8) 上游无 usage 时归一化返回 None（调用方据此回退字符估算）
    check("usage: 全缺返回 None", lp._normalize_usage(None, None) is None, "")

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
