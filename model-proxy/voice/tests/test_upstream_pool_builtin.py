"""上游池 builtin 本地引擎入口回归测试（直接 python tests/test_upstream_pool_builtin.py）。

锁住：
- protocol/vendor=builtin 的本地引擎条目 base_url 为空也要进池（否则问数调
  /rerank/v1/rerank 不带 base_url 时落不到本地 CrossEncoder，误选无效上游）。
- builtin 标识不能被 normalize_protocol 收敛成 openai_chat_completions。
- 非 builtin 的空 base_url 条目仍被过滤，避免放宽过度。
- 分组写法（{"builtin": {...}}）里的 builtin 同样进池。
"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config_store
import upstream_pool as up

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
config_store.configure(os.path.join(tmpdir, "v.db"), None, None)
up.invalidate()

# 1) builtin 识别
check("builtin protocol 识别", up._is_builtin_entry({"protocol": "builtin"}))
check("builtin vendor 识别", up._is_builtin_entry({"vendor": "builtin"}))
check("分组键 builtin 识别", up._is_builtin_entry({}, "builtin"))
check("普通条目不误判", not up._is_builtin_entry({"protocol": "openai", "vendor": "dashscope"}))

# 2) _normalize_entry 保留 builtin 标识
e = up._normalize_entry({"vendor": "builtin", "protocol": "builtin", "model": "bge-reranker", "base_url": ""})
check("builtin protocol 保留", e["protocol"] == "builtin", str(e))
check("builtin vendor 保留", e["vendor"] == "builtin", str(e))
check("本地引擎 base_url 仍为空", e["base_url"] == "", str(e))
e2 = up._normalize_entry({"base_url": "", "api_key": ""}, group_protocol="builtin", group_model="bge")
check("分组 builtin vendor 补全", e2["vendor"] == "builtin" and e2["protocol"] == "builtin", str(e2))

# 3) 扁平数组：builtin 进池、非 builtin 空 base_url 被过滤
config_store.instance().bulk({
    "RERANK_UPSTREAM_POOL": json.dumps([
        {"vendor": "builtin", "protocol": "builtin", "model": "bge-reranker-v2-m3", "base_url": "", "api_key": ""},
        {"vendor": "empty", "protocol": "openai", "model": "should-drop", "base_url": "", "api_key": ""},
        {"vendor": "dashscope", "protocol": "dashscope", "model": "", "base_url": "https://x.example/v1/reranks", "api_key": "k"},
    ], ensure_ascii=False)
})
up.invalidate()
pool = up.load_pool("RERANK")
check("builtin 空 base_url 进池", any(x.get("vendor") == "builtin" for x in pool), str(pool))
check("路由 builtin 检测命中", any(
    (x.get("protocol") or "").lower() == "builtin" or (x.get("vendor") or "").lower() == "builtin"
    for x in pool), str(pool))
check("非 builtin 空 base_url 被过滤", not any(x.get("vendor") == "empty" for x in pool), str(pool))
check("非空 base_url 条目正常进池", any(x.get("vendor") == "dashscope" for x in pool), str(pool))

# 4) 分组写法：builtin 作为分组键
config_store.instance().bulk({
    "RERANK_UPSTREAM_POOL": json.dumps({
        "builtin": {"model": "bge-reranker", "accounts": [{"base_url": "", "api_key": ""}]},
    }, ensure_ascii=False)
})
up.invalidate()
pool2 = up.load_pool("RERANK")
check("分组写法 builtin 进池", any(
    (x.get("vendor") or "").lower() == "builtin" and (x.get("protocol") or "").lower() == "builtin"
    for x in pool2), str(pool2))

# 5) 健康探测：本地引擎恒可用
# 后台探测线程对池里每个入口做网络探测；builtin 的 base_url 为空，若照网络探测
# 必抛 UnsupportedProtocol → 被误标不健康并进冷却，管理面板会显示该能力不可用，
# 而实际调用是好的。这里锁住 builtin 不参与网络探测、非 builtin 仍正常探测。
builtin_entry = up._normalize_entry(
    {"vendor": "builtin", "protocol": "builtin", "model": "bge-reranker", "base_url": ""}
)
ok, err = asyncio.run(up._probe_reach(builtin_entry))
check("builtin 存活探测恒可用", ok is True and err is None, f"{ok} {err}")
ok, err = asyncio.run(up._probe_useful(builtin_entry))
check("builtin 可用性探测恒可用", ok is True and err is None, f"{ok} {err}")

http_entry = up._normalize_entry(
    {"vendor": "dashscope", "protocol": "dashscope", "base_url": "http://127.0.0.1:9/v1", "api_key": ""}
)
ok, err = asyncio.run(up._probe_reach(http_entry))
check("非 builtin 仍走网络探测", ok is False, f"{ok} {err}")

print(f"\n== SUMMARY: {PASS}/{PASS + FAIL} passed ==")
sys.exit(0 if FAIL == 0 else 1)
