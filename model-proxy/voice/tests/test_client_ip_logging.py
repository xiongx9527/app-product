"""客户端 IP 日志 / 审计回归测试。

背景：
    voice.log 的 access 日志原先是 `127.0.0.1:端口`（带端口、无时间）；经反向代理
    / adb reverse 时 uvicorn 只看到 127.0.0.1，看不到真实来源。现要求：
    access 日志去端口、支持 X-Forwarded-For；审计表只记录 /admin/*** 接口
    （操作日志只保留管理面数据），voice 请求不写审计表。

锁住的关键点：
1. _strip_port：IPv4 / IPv6 / 无端口都正确。
2. client_ip_for_log：XFF 首项 → X-Real-IP → 直连对端；非法 / 超长值丢弃。
3. 安全边界：client_ip()（白名单 / 鉴权用）绝不受伪造 XFF 影响。
4. _IpOnlyAccessFormatter：输出纯 IP + 时间戳，不含端口。
5. client_ip_audit_middleware：voice 请求不写 audit 表，/admin/*** 请求写 audit 表。

运行：
    cd model-proxy/voice
    /Users/xiongxiao/.app-product/voice/venv/bin/python tests/test_client_ip_logging.py
"""
from __future__ import annotations

import contextlib
import copy
import io
import logging
import logging.config
import os
import re
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

_VOICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_VOICE_DIR))

_RESULTS: list[tuple[str, bool]] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    _RESULTS.append((name, bool(cond)))
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")


def fake_conn(headers: dict, host: str):
    """同时具备 .headers / .client 的假连接，Request 与 WebSocket 通用。"""
    return SimpleNamespace(
        headers=headers,
        client=SimpleNamespace(host=host) if host else None,
    )


def main() -> int:
    from fastapi.testclient import TestClient
    from uvicorn.config import LOGGING_CONFIG
    import openai_voice_server as srv
    import voice_db

    # 1) 去端口
    check("_strip_port: IPv4 去端口",
          srv._strip_port("127.0.0.1:50070") == "127.0.0.1")
    check("_strip_port: IPv6 去端口",
          srv._strip_port("[::1]:50070") == "[::1]")
    check("_strip_port: 无端口则原样",
          srv._strip_port("192.168.1.2") == "192.168.1.2")

    # 2) 日志用客户端 IP 解析
    check("client_ip_for_log: XFF 首项优先",
          srv.client_ip_for_log(fake_conn(
              {"x-forwarded-for": "203.0.113.9, 10.0.0.1"}, "127.0.0.1")) == "203.0.113.9")
    check("client_ip_for_log: X-Real-IP 兜底",
          srv.client_ip_for_log(fake_conn(
              {"x-real-ip": "198.51.100.7"}, "127.0.0.1")) == "198.51.100.7")
    check("client_ip_for_log: 非法 XFF 回退直连对端",
          srv.client_ip_for_log(fake_conn(
              {"x-forwarded-for": "not-an-ip"}, "10.0.0.5")) == "10.0.0.5")
    check("client_ip_for_log: 超长 XFF 丢弃",
          srv.client_ip_for_log(fake_conn(
              {"x-forwarded-for": "1.2.3.4" * 20}, "10.0.0.5")) == "10.0.0.5")
    check("client_ip_for_log: 无头时直连对端",
          srv.client_ip_for_log(fake_conn({}, "10.0.0.5")) == "10.0.0.5")

    # 3) 安全边界：鉴权用的 client_ip 不读 XFF
    check("安全边界: client_ip 不受伪造 XFF 影响",
          srv.client_ip(fake_conn(
              {"x-forwarded-for": "1.2.3.4"}, "10.0.0.1")) == "10.0.0.1")
    # uvicorn 默认只信任来自环回的 X-Forwarded-For；非本机来源的伪造头不会
    # 改写 request.client，也就进不了白名单 / 鉴权。
    from uvicorn.config import Config
    _cfg = Config(app=None)
    trusted = {x.strip() for x in _cfg.forwarded_allow_ips.split(",")}
    check("安全边界: uvicorn 只信任环回来源的 XFF",
          _cfg.proxy_headers is True and trusted == {"127.0.0.1", "::1"},
          f"allow={_cfg.forwarded_allow_ips}")

    # 4) access formatter：纯 IP + 时间戳（用真实 dictConfig 走一遍，与线上配置一致）
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        cfg = copy.deepcopy(LOGGING_CONFIG)
        cfg["formatters"]["default"]["fmt"] = "%(asctime)s %(levelprefix)s %(message)s"
        cfg["formatters"]["default"]["datefmt"] = "%Y-%m-%d %H:%M:%S"
        cfg["formatters"]["access"]["fmt"] = (
            '%(asctime)s %(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s'
        )
        cfg["formatters"]["access"]["datefmt"] = "%Y-%m-%d %H:%M:%S"
        cfg["formatters"]["access"]["()"] = srv._IpOnlyAccessFormatter
        logging.config.dictConfig(cfg)
        logging.getLogger("uvicorn.access").info(
            '%s - "%s %s HTTP/%s" %d', "127.0.0.1:50070", "GET", "/health", "1.1", 200
        )
    out = buf.getvalue().strip()
    check("access 日志去端口",
          '127.0.0.1 - "GET /health HTTP/1.1" 200 OK' in out and "50070" not in out,
          out)
    check("access 日志带时间戳",
          bool(re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ", out)), out)

    # 5) 审计 middleware：操作日志只记录 /admin/***，voice 请求不再写 audit 表
    # 换临时库前清掉主线程 thread-local 连接，避免指向上一个库。
    if hasattr(voice_db._conn_local, "c"):
        try:
            voice_db._conn_local.c.close()
        except Exception:
            pass
        delattr(voice_db._conn_local, "c")
    voice_db._cache.clear()
    voice_db._cache_ts = 0.0
    db = os.path.join(tempfile.mkdtemp(prefix="client_ip_test_"), "voice.db")
    voice_db.configure(db)
    voice_db.set_auto_seed(False)
    voice_db.ensure_schema()

    client = TestClient(srv.app)
    r = client.get("/voice/__audit_probe__",
                   headers={"x-forwarded-for": "203.0.113.9"})
    check("探针请求可达（404 仍返回）", r.status_code == 404,
          f"status={r.status_code}")
    audits = voice_db.recent_audit(limit=50)
    hit = [a for a in audits if a["action"] == "http.request"]
    check("voice 请求不写审计表（操作日志只要 /admin/***）", len(hit) == 0,
          f"rows={len(hit)}")

    client.get("/voice/__audit_probe2__")  # 不带 XFF
    audits2 = voice_db.recent_audit(limit=50)
    check("多个 voice 请求后审计表仍为空",
          not any(a["action"] == "http.request" for a in audits2))

    # /admin/*** 请求仍正常写审计（action=admin.api）
    r3 = client.get("/admin/api/__audit_probe__")
    audits3 = voice_db.recent_audit(limit=50)
    hit3 = [a for a in audits3 if a["action"] == "admin.api"]
    check("/admin/*** 请求仍写审计表", len(hit3) >= 1, f"rows={len(hit3)}")

    failed = [n for n, ok in _RESULTS if not ok]
    print("\n== SUMMARY:", "ALL PASS" if not failed
          else f"{len(failed)} FAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
