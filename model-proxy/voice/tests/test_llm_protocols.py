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

    # 2) 贴 ollama 标签但走 OpenAI 兼容线协议：必须命 /v1/chat/completions + StreamTranslator
    req, stream_cls, _ = prep("openai_chat_completions", "https://api.deepseek.com/v1", "ollama")
    check("vendor=ollama + openai 协议 -> /v1/chat/completions",
          req.url == "https://api.deepseek.com/v1/chat/completions", f"url={req.url}")
    check("vendor=ollama + openai 协议 -> StreamTranslator",
          stream_cls is lp.StreamTranslator, f"{stream_cls.__name__}")
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

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
