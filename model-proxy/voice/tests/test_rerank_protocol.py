"""重排（rerank）线协议回归测试（无需起服务，直接 python tests/test_rerank_protocol.py）。

锁住：
- prepare_rerank 路径拼接：base 带 /v1 时不重复。
- 响应归一化：Cohere / TEI / DashScope 形状 -> 统一 Cohere 风格，按分数降序。
"""
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

body = {"model": "bge-reranker", "query": "q", "documents": ["a", "b"], "top_n": 1}

# 1) 路径拼接
req, transform = lp.prepare_rerank("rerank", "http://127.0.0.1:11434/v1", "k", "m", body)
check("base 带 /v1 -> /v1/rerank", req.url == "http://127.0.0.1:11434/v1/rerank", f"url={req.url}")
req2, _ = lp.prepare_rerank("rerank", "http://127.0.0.1:9000", "k", "m", body)
check("base 不带 /v1 -> /v1/rerank", req2.url == "http://127.0.0.1:9000/v1/rerank", f"url={req2.url}")
check("请求体保留 Cohere 字段", req.payload.get("query") == "q" and req.payload.get("documents") == ["a", "b"])
check("请求体剥离控制字段", "vendor" not in req.payload and "base_url" not in req.payload)

# 2) Cohere 响应
cohere = {"results": [{"index": 0, "relevance_score": 0.2}, {"index": 1, "relevance_score": 0.9}], "model": "m"}
out = lp.rerank_to_cohere(cohere)
check("Cohere 归一化 + 降序", [r["index"] for r in out["results"]] == [1, 0], f"{out['results']}")

# 3) TEI 响应 [{index,score}]
tei = [{"index": 0, "score": 0.1}, {"index": 1, "score": 0.8}]
out2 = lp.rerank_to_cohere(tei)
check("TEI score -> relevance_score", out2["results"][0]["relevance_score"] == 0.8, f"{out2['results']}")

# 4) DashScope 嵌套 {output:{results}}
ds = {"output": {"results": [{"index": 0, "relevance_score": 0.3}, {"index": 1, "relevance_score": 0.7}]}}
out3 = lp.rerank_to_cohere(ds)
check("DashScope output.results 归一化", [r["index"] for r in out3["results"]] == [1, 0], f"{out3['results']}")

# 5) document 拍平（DashScope {text:...}）
ds_doc = {"results": [{"index": 0, "relevance_score": 0.9, "document": {"text": "hi"}}]}
out4 = lp.rerank_to_cohere(ds_doc)
check("document {text} 拍平成字符串", out4["results"][0].get("document") == "hi")

# 6) 不支持的线协议
try:
    lp.prepare_rerank("anthropic_messages", "http://x", "k", "m", body)
    check("不支持协议抛错", False)
except ValueError:
    check("不支持协议抛错", True)

print(f"\n== SUMMARY: {PASS}/{PASS+FAIL} passed ==")
sys.exit(0 if FAIL == 0 else 1)
