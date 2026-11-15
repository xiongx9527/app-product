"""向量维度参数（dimensions）翻译回归测试（无需起服务，直接 python tests/test_embeddings_dimensions.py）。

锁住的关键点：/llm/v1/embeddings 对外接受 OpenAI 兼容的 dimensions 字段，并按线协议
翻译成各家原生字段——否则填了维度却没生效（或发给不支持的字段名）会让模型忽略 /
报错，管理面板「请求维度」输入框就成了摆设：

- OpenAI 兼容（含 dashscope / deepseek / azure）：直接透传 dimensions（OpenAI 原生字段）。
- Ollama 原生：dimensions -> options.embedding_length（int）。
- Gemini：dimensions -> generationConfig.outputDimensionality（int）。
- 不传 dimensions 时，不应凭空注入上述字段。
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


def embed(protocol: str, model: str, body: dict) -> object:
    req, _ = lp.prepare_embeddings(protocol, "https://x.example.com", "sk-x", model, "", body)
    return req


def main() -> int:
    # 1) OpenAI 兼容（deepseek / openai 等）：dimensions 原样透传
    body = {"input": "你好", "model": "text-embedding-3-small", "dimensions": 768}
    req = embed("openai_chat_completions", "text-embedding-3-small", body)
    check("OpenAI 兼容: dimensions 透传",
          req.payload.get("dimensions") == 768, f"payload={req.payload}")
    check("OpenAI 兼容: 命中 /v1/embeddings",
          req.url.endswith("/v1/embeddings"), f"url={req.url}")

    # 2) DashScope 兼容模式：同样透传 dimensions，路径变体 /compatible-mode/v1/embeddings
    req = embed("dashscope", "text-embedding-v2", body)
    check("DashScope: dimensions 透传",
          req.payload.get("dimensions") == 768, f"payload={req.payload}")
    check("DashScope: 命中 /compatible-mode/v1/embeddings",
          req.url.endswith("/compatible-mode/v1/embeddings"), f"url={req.url}")

    # 3) Azure OpenAI：dimensions 透传 + 路径含 deployments/{model}/embeddings
    az_body = {"input": "你好", "dimensions": 1024}
    req = embed("azure_openai_chat_completions", "my-embed-deploy", az_body)
    check("Azure: dimensions 透传",
          req.payload.get("dimensions") == 1024, f"payload={req.payload}")
    check("Azure: 命中 deployments 路径",
          "/openai/deployments/my-embed-deploy/embeddings" in req.url, f"url={req.url}")

    # 4) Ollama 原生：dimensions -> options.embedding_length（int）
    ol_body = {"input": "你好", "model": "nomic-embed-text", "dimensions": 512}
    req = embed("ollama", "nomic-embed-text", ol_body)
    check("Ollama: dimensions -> options.embedding_length",
          req.payload.get("options", {}).get("embedding_length") == 512, f"payload={req.payload}")
    check("Ollama: embedding_length 为 int",
          isinstance(req.payload.get("options", {}).get("embedding_length"), int))
    check("Ollama: 命中 /api/embed",
          req.url.endswith("/api/embed"), f"url={req.url}")

    # 5) Gemini：dimensions -> generationConfig.outputDimensionality（int）
    ge_body = {"input": "你好", "model": "text-embedding-004", "dimensions": 256}
    req = embed("gemini", "text-embedding-004", ge_body)
    gencfg = req.payload.get("generationConfig", {})
    check("Gemini: dimensions -> generationConfig.outputDimensionality",
          gencfg.get("outputDimensionality") == 256, f"payload={req.payload}")
    check("Gemini: outputDimensionality 为 int",
          isinstance(gencfg.get("outputDimensionality"), int))
    check("Gemini: 命中 embedContent 路径",
          req.url.endswith("/models/text-embedding-004:embedContent"), f"url={req.url}")

    # 6) 不传 dimensions 时，不应凭空注入维度字段
    no_dim = {"input": "你好", "model": "m"}
    req = embed("openai_chat_completions", "m", no_dim)
    check("OpenAI 兼容(无维度): payload 不含 dimensions",
          "dimensions" not in req.payload, f"payload={req.payload}")
    req = embed("ollama", "nomic-embed-text", no_dim)
    check("Ollama(无维度): payload 不含 options",
          "options" not in req.payload, f"payload={req.payload}")
    req = embed("gemini", "text-embedding-004", no_dim)
    check("Gemini(无维度): payload 不含 generationConfig",
          "generationConfig" not in req.payload, f"payload={req.payload}")

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
