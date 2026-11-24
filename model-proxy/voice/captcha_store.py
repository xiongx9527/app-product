"""管理面板登录验证码：存储 + 图片生成。

多实例一致性：配了 REDIS_URL 且连得上时，答案存 Redis，任意实例生成 / 校验都能对上；
Redis 没配 / 未装依赖 / 连不上时透明降级到进程内存（单实例仍可用），不阻塞登录。
答案一次性消费（校验后立即删除），TTL 兜底过期，防重放。
"""
from __future__ import annotations

import os
import secrets
import threading
import time

import config_store

_PREFIX = "admin:captcha:"
_TTL = 300       # 秒；验证码有效期
_RETRY = 30      # Redis 连接失败后多久再试
# 去掉易混淆字符：I / O / 0 / 1
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_answer() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(4))


def render_svg(answer: str) -> str:
    """纯标准库生成验证码 SVG（无第三方依赖），字符轻微扭曲 + 干扰线。"""
    import random

    w, h = 124, 42
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
        '<rect width="100%" height="100%" fill="#eef2f7"/>',
    ]
    for i, ch in enumerate(answer):
        x = 14 + i * 27
        y = 29 + random.randint(-4, 4)
        rot = random.randint(-24, 24)
        color = random.choice(["#24304a", "#1f6feb", "#8b3fb0", "#b3541e"])
        size = random.randint(21, 27)
        parts.append(
            f'<text x="{x}" y="{y}" font-size="{size}" font-family="monospace" '
            f'font-weight="bold" fill="{color}" transform="rotate({rot} {x} {y})">{ch}</text>'
        )
    for _ in range(4):
        x1, y1 = random.randint(0, w), random.randint(0, h)
        x2, y2 = random.randint(0, w), random.randint(0, h)
        color = random.choice(["#c9d4e3", "#9db3cc"])
        parts.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="1"/>')
    parts.append("</svg>")
    return "".join(parts)


class _CaptchaStore:
    def __init__(self):
        self._client = None
        self._bad_ts = 0.0
        self._lock = threading.Lock()
        self._mem: dict[str, tuple[str, float]] = {}

    def _redis_url(self) -> str:
        try:
            v = config_store.instance().all().get("REDIS_URL")
        except Exception:
            v = None
        return str(v or os.environ.get("REDIS_URL") or "").strip()

    def _get(self):
        url = self._redis_url()
        if not url:
            return None
        if self._client is not None:
            return self._client
        if time.time() - self._bad_ts < _RETRY:
            return None
        with self._lock:
            if self._client is None and time.time() - self._bad_ts >= _RETRY:
                try:
                    import redis  # type: ignore
                    self._client = redis.from_url(
                        url, socket_connect_timeout=1, socket_timeout=1,
                        decode_responses=True,
                    )
                    self._client.ping()
                except Exception:
                    self._client = None
                    self._bad_ts = time.time()
        return self._client

    def _gc(self) -> None:
        now = time.time()
        for k in [k for k, (_, exp) in self._mem.items() if exp <= now]:
            self._mem.pop(k, None)

    def issue(self, answer: str) -> str:
        cid = secrets.token_urlsafe(12)
        c = self._get()
        if c is not None:
            try:
                c.setex(_PREFIX + cid, _TTL, answer)
                return cid
            except Exception:
                self._client = None
                self._bad_ts = time.time()
        with self._lock:
            self._mem[cid] = (answer, time.time() + _TTL)
            self._gc()
        return cid

    def verify(self, cid: str, supplied: str) -> bool:
        if not cid or not supplied:
            return False
        c = self._get()
        if c is not None:
            expected = None
            try:
                expected = c.getdel(_PREFIX + cid)  # Redis >= 6.2 原子取删
            except Exception:
                try:
                    expected = c.get(_PREFIX + cid)  # 老版本退化为 GET + DEL
                    c.delete(_PREFIX + cid)
                except Exception:
                    self._client = None
                    self._bad_ts = time.time()
                    expected = None
            if expected is None:
                return False
            return str(expected).lower() == supplied.strip().lower()
        with self._lock:
            item = self._mem.pop(cid, None)
            if not item:
                return False
            answer, exp = item
            if exp <= time.time():
                return False
            return answer.lower() == supplied.strip().lower()

    def backend(self) -> str:
        return "redis" if self._get() is not None else "memory"


_store = _CaptchaStore()


def issue(answer: str) -> str:
    return _store.issue(answer)


def verify(cid: str, supplied: str) -> bool:
    return _store.verify(cid, supplied)


def backend() -> str:
    return _store.backend()


def enabled() -> bool:
    """登录验证码开关：默认开（键缺失或异常都按开处理）。"""
    try:
        v = config_store.instance().all().get("ADMIN_CAPTCHA")
    except Exception:
        v = None
    return str("on" if v is None else v).strip().lower() != "off"
