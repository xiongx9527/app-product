"""语音代理的 Web 管理面板（鉴权 + 配置编辑 + 启停 + 日志）。

为什么单独成模块：管理面板要读写 voice.conf、调 voice.sh、读日志，逻辑足够多，
塞进 openai_voice_server.py 会让主文件更难读；独立出来后由主文件调用
init_admin() + register_admin_routes(app) 挂到同一个 FastAPI app 上，端口还是 19529。

鉴权：账号密码存本地 SQLite 的 admin_credentials 表（真相源），不再写 admin.conf。
首次启动若表为空，会把存量 admin.conf 迁移进库；若连 admin.conf 都没有，则生成一把
随机密码入库并在启动日志打印一次（只显示一次，之后从库里读）。登录成功后发一个
httpOnly 的会话 Cookie，后续 /admin/api/* 都校验它；Cookie 不暴露给 JS，降低 XSS
盗用风险。会话同样落库（voice_db.admin_sessions），跨重启 / 多实例一致，不引第三方依赖。

为什么不直接复用网关那套 RSA 参数加密：管理面板和代理同进程同端口，没必要把
浏览器到本机的链路再套一层非对称加密；httpOnly Cookie + 本地访问即可。
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import platform
import re
import resource
import secrets
import socket
import sqlite3
import subprocess
import threading
import time
from typing import Any

import config_store  # 统一配置接口：本地缓存 + 本地库 + 远程库，调用方无感
import upstream_pool  # 上游地址池：配置变更后需要清掉池缓存（见 admin_config_save）
import voice_db  # 本地库：配置真相源 + 事件 / 审计 + 会话（落库，跨重启一致）
import rate_store  # 限流门面：删 key 时清计数
import captcha_store  # 登录验证码：Redis 优先 + 内存降级，多实例可共享
import voice_correction_store  # ASR 纠错词表（管理端维护；对外同步接口在 openai_voice_server）
import httpx  # 探测上游连通性（/admin/api/probe）
import llm_protocols  # 由协议名推导模型列表接口地址（prepare_models）

from fastapi import Cookie, Depends, Form, HTTPException, Request

_START_TS = time.time()  # 面板模块加载时间，供概览页算 uptime

# 热词词性校验：jieba 懒加载（首次调用才载入词典，避免拖慢服务启动）。
# 返回 [(词, 词性标记)]；依赖缺失返回 None，调用方据此降级为只做字数校验。
_PSEG = None
_PSEG_TRIED = False


def _pseg_cut(text: str):
    global _PSEG, _PSEG_TRIED
    if not _PSEG_TRIED:
        _PSEG_TRIED = True
        try:
            import jieba.posseg as _p
            _PSEG = _p
        except Exception:
            _PSEG = None
    if _PSEG is None:
        return None
    try:
        return [(t.word, t.flag) for t in _PSEG.cut(text)]
    except Exception:
        return None


def _validate_hotword(correct: str, wrong: str) -> None:
    """热词字数/词性校验，不通过直接抛 400。添加与审核通过两处共用。

    - 正确词、错词都须 2-6 个纯汉字；两者字数相等。
    - 正确词须为名词性词语（含 n* token、无代词/虚词/形容词）；jieba 把
      「太阳花→太阳(ns)+花(v)」这类专有词单字误标为 v，故动词 token 不一律拒。
    - 错词不得含动词(v*)/形容词(a*)/区别词(b)。
    - jieba 不可用时降级为只做字数/形态校验，不阻断。
    """
    han = re.compile(r"^[\u3400-\u9fff]+$")
    if not (2 <= len(correct) <= 6) or not han.match(correct):
        raise HTTPException(status_code=400, detail="config.hotwordBadLen")
    if wrong:
        if not (2 <= len(wrong) <= 6) or not han.match(wrong):
            raise HTTPException(status_code=400, detail="config.hotwordBadLen")
        if len(correct) != len(wrong):
            raise HTTPException(status_code=400, detail="config.hotwordLenMismatch")
    tags_c = _pseg_cut(correct)
    if tags_c is not None:
        bad = {"a", "b", "r", "d", "c", "l", "m", "q", "p", "u", "zg"}
        if (not any(f.startswith("n") for _, f in tags_c)
                or any(f in bad or f.startswith("a") for _, f in tags_c)):
            raise HTTPException(status_code=400, detail="config.hotwordMustBeName")
    if wrong:
        tags_w = _pseg_cut(wrong)
        if tags_w is not None and any(
            f.startswith("v") or f.startswith("a") or f == "b" for _, f in tags_w
        ):
            raise HTTPException(status_code=400, detail="config.hotwordWrongPos")
from fastapi.responses import HTMLResponse, JSONResponse, Response

# ── 路径与配置（由主文件 init_admin 注入）────────────────────────────
VOICE_CONF_PATH = ""
VOICE_HOME_DIR = ""
VOICE_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "voice.sh"
)

# 由主文件注入：按需真实检测内置能力是否可用。启动阶段不调用，只在管理面板
# ASR / TTS「内置」行点「测试可用」时经 /admin/api/*-builtin-test 触发。
_STT_BUILTIN_CHECK = None
_TTS_BUILTIN_CHECK = None

# 密钥类配置项：读取时打码，避免明文出现在页面 / 接口里。
# LLM_UPSTREAM_POOL 是含 api_key 的 JSON，整串打码；STT/TTS 固定本地，无上游密钥/池。
MASKED_KEYS = {
    "LLM_UPSTREAM_API_KEY",
    "VOICE_API_KEY",  # 鉴权开启后这里存的是多个真实 Key，绝不回传明文
    "VOICE_API_KEY_FILE",
    "LLM_UPSTREAM_POOL",
    "EMBED_UPSTREAM_POOL",  # 向量上游池（含 api_key 的 JSON，整串打码），与 LLM 池数据独立
    # ASR / TTS 的上游与 DeepSeek 密钥同样含明文 api-key：既绝不能回传明文，
    # 也要脱敏成 HIDDEN 哨兵——前端 hasProvKey 靠「值等于 HIDDEN」判定「已配置」，
    # 不在此集合里会让 GET 返回明文、刷新页面后前端误判成「没配置」（用户以为 key 丢了）。
    "STT_UPSTREAM_API_KEY",
    "TTS_UPSTREAM_API_KEY",
    "STT_DEEPSEEK_API_KEY",
    "TTS_DEEPSEEK_API_KEY",
    "OCR_DEEPSEEK_API_KEY",   # OCR 的 DeepSeek Vision Key（同上，必须打码+哨兵）
}
HIDDEN = "********"

# ── 会话（落库到 voice_db.admin_sessions，重启 / 多实例都一致）──────
SESSION_TTL = 3600 * 8  # 8 小时（仅用于 Cookie 有效期，实际过期由 DB 判断）
SESSION_COOKIE = "voice_admin_session"


def init_admin(conf_path: str, home: str) -> None:
    """主文件在配置路径确定后调用，注入语音服务的配置文件与运行目录。"""
    global VOICE_CONF_PATH, VOICE_HOME_DIR
    VOICE_CONF_PATH = os.path.abspath(os.path.expanduser(conf_path))
    VOICE_HOME_DIR = home


def _parse_kv(path: str) -> dict[str, str]:
    """解析 KEY=VALUE 配置；忽略空行与 # 注释，去掉成对引号与行尾 ` #` 注释。"""
    values: dict[str, str] = {}
    if not path or not os.path.isfile(path):
        return values
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :].lstrip()
            key, sep, value = line.partition("=")
            if not sep:
                continue
            key = key.strip()
            if not key:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            elif " #" in value:
                value = value.split(" #", 1)[0].rstrip()
            values[key] = value
    return values


# ── 管理面板内置管理员 ────────────────────────────────────────────
def load_admin_config() -> dict[str, str]:
    """确保 admin_users 里存在内置管理员；返回其账号密码（供启动日志打印一次）。

    真相源是 admin_users 表（v10）。启动时调用：
      1. 已有 is_builtin=1 账号 → 直接返回（不打印，密码已在首次创建时显示过）；
      2. 没有 → 按 voice.conf 的 ADMIN_USER/ADMIN_PASSWORD → 存量 admin.conf → 随机生成，
         播种为 is_builtin=1 / role=admin 的账号，并打印一次。

    之后一律以库为准——改配置文件不影响已有账号，要改请用重置脚本或在面板改密。
    绝不写 config_kv，避免明文密码被 voice_sync 推到远端 Postgres/Redis。
    """
    users = voice_db.admin_users_list()
    for u in users:
        if u["is_builtin"]:
            # 已有内置管理员，取密码仅用于兼容旧调用；正常不会打印。
            row = voice_db._conn_get().execute(
                "SELECT password FROM admin_users WHERE username=?", (u["username"],)
            ).fetchone()
            return {"user": u["username"], "password": row["password"] if row else ""}

    # 2) voice.conf 显式配置
    conf = _parse_kv(VOICE_CONF_PATH)
    conf_user = (conf.get("ADMIN_USER") or "").strip()
    conf_pw = (conf.get("ADMIN_PASSWORD") or "").strip()
    if conf_pw:
        user = conf_user or "admin"
        voice_db.admin_user_add(user, conf_pw, "admin")
        _mark_builtin(user)
        print(
            f"[local-ai] 管理面板内置管理员已从 {VOICE_CONF_PATH} 播种到数据库",
            flush=True,
        )
        return {"user": user, "password": conf_pw}

    # 3) 存量 admin.conf
    path = os.path.join(VOICE_HOME_DIR, "admin.conf")
    cfg = _parse_kv(path)
    user = (cfg.get("ADMIN_USER") or "admin").strip()
    pw = (cfg.get("ADMIN_PASSWORD") or "").strip()
    if pw:
        voice_db.admin_user_add(user, pw, "admin")
        _mark_builtin(user)
        print(
            f"[local-ai] 管理面板内置管理员已从 {path} 迁移到数据库（原文件保留不动）",
            flush=True,
        )
        return {"user": user, "password": pw}

    # 4) 首次随机
    user = "admin"
    pw = secrets.token_urlsafe(18)
    voice_db.admin_user_add(user, pw, "admin")
    _mark_builtin(user)
    print(
        "[local-ai] 管理面板已生成随机密码（仅显示这一次，真相源在 voice.db 的 admin_users 表）：\n"
        f"[local-ai]   账号: {user}\n"
        f"[local-ai]   密码: {pw}\n"
        "[local-ai] 如需重置，请用 model-proxy/reset-admin.sh 脚本。",
        flush=True,
    )
    return {"user": user, "password": pw}


def _mark_builtin(username: str) -> None:
    """把指定账号标记为内置管理员（仅播种/重置脚本用，唯一索引保证只有一个）。"""
    with voice_db._lock:
        c = voice_db._conn_get()
        c.execute(
            "UPDATE admin_users SET is_builtin=1, role='admin', enabled=1, updated_at=? "
            "WHERE username=?",
            (int(time.time()), username),
        )
        c.commit()


# ── 会话管理（落库，跨重启 / 多实例一致）──────────────────────────
# 会话写入 voice_db.admin_sessions，重启代理也不会掉登录；多实例共享同一本地库时也一致。
def create_session(username: str) -> str:
    tok = secrets.token_urlsafe(32)
    voice_db.session_create(tok, username)
    return tok


def valid_session(token: str | None) -> bool:
    """会话有效 = token 未过期 且 对应账号仍存在且启用（禁用作废即时生效）。"""
    if not voice_db.session_valid(token):
        return False
    username = voice_db.session_username(token)
    user = voice_db.admin_user_get(username) if username else None
    return bool(user and user["enabled"])


def session_role(token: str | None) -> str | None:
    """取会话账号的角色（账号被禁用/删除返回 None）。"""
    if not valid_session(token):
        return None
    username = voice_db.session_username(token)
    user = voice_db.admin_user_get(username) if username else None
    return user["role"] if user else None


def destroy_session(token: str | None) -> None:
    voice_db.session_destroy(token)


# 角色优先级：viewer < operator < admin
ROLE_ORDER = {"viewer": 0, "operator": 1, "admin": 2}


def require_role(min_role: str):
    """构造一个 FastAPI 依赖：会话有效 + 账号启用 + 角色达到 min_role。

    会话无效 401；账号禁用/删除 401；角色不足 403。替代原 require_admin，
    实现后端强制分级——绕过前端直接调接口也拦得住。
    """
    def _dep(session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> None:
        if not valid_session(session):
            raise HTTPException(status_code=401, detail="未登录或会话已过期")
        role = session_role(session)
        if role is None or ROLE_ORDER.get(role, -1) < ROLE_ORDER.get(min_role, 99):
            raise HTTPException(status_code=403, detail="权限不足")
    return _dep


# 分级依赖别名
require_viewer = require_role("viewer")
require_operator = require_role("operator")
require_admin = require_role("admin")


# ── voice.conf 读写（打码 / 哨兵）──────────────────────────────────
# 注：配置真相源已迁到本地 SQLite（经 config_store）。日常读写一律走 config_store，
# voice.conf 仅在建库时空 DB 的播种阶段被读取（见 config_store.seed_from_conf）。
def read_voice_config_masked() -> dict[str, str]:
    """对外暴露的版本：密钥项打码成 HIDDEN（数据来自 config_store / 本地 SQLite）。"""
    cfg = config_store.instance().all()
    return {k: (HIDDEN if (k in MASKED_KEYS and v) else v) for k, v in cfg.items()}


def write_voice_config(patch: dict[str, str]) -> str | None:
    """只更新 patch 里的键（走 config_store -> 本地缓存 + SQLite，按需在保存处推远程）。

    - 值为 HIDDEN 哨兵表示「不想改」，调用方在提交前已替换为原值，这里不再特殊处理；
    - 空字符串表示清空该键。
    """
    config_store.instance().bulk(patch)
    return None


# 切 TTS 提供商时同步把音色归一化到该提供商的合法音色，避免存出「deepseek + edge 音色」
# 这种必然 502 的组合（真机踩坑：health 探 TTS 失败 → 网关一直判「启动中/失败」）。
# 放在服务端而不是前端：任何调用方（管理页 / curl API）切 provider 都受保护，且与前端加载时序无关。
TTS_PROVIDER_MODEL_KEYS = {
    "builtin": "TTS_BUILTIN_MODEL",
    "dashscope": "TTS_UPSTREAM_MODEL",
    "deepseek": "TTS_DEEPSEEK_MODEL",
}


def normalize_tts_voice_on_provider_change(patch: dict[str, str]) -> dict[str, str]:
    """patch 改了 TTS_PROVIDER 且确实切换时，若 TTS_VOICE 不属于新提供商则重置为其默认音色。"""
    if "TTS_PROVIDER" not in patch:
        return patch
    store = config_store.instance()
    new_p = str(patch.get("TTS_PROVIDER") or "").strip().lower()
    old_p = str(store.get("TTS_PROVIDER", "builtin") or "builtin").strip().lower()
    if not new_p or new_p == old_p:
        return patch
    valid = {v["id"] for v in voice_db.list_voices(new_p, None)}
    if not valid:
        return patch  # 目录没数据（未播种）时不猜，保持原样
    voice = str(patch.get("TTS_VOICE") or store.get("TTS_VOICE", "") or "").strip()
    if voice in valid:
        return patch  # 调用方显式选了合法音色，尊重
    # 按新 provider 的当前 model 取默认音色（model 可能随 patch 一起更新）
    model_key = TTS_PROVIDER_MODEL_KEYS.get(new_p, "")
    model = str(patch.get(model_key) or store.get(model_key, "") or "").strip()
    voices = voice_db.list_voices(new_p, model or None)
    default = next((v["id"] for v in voices if v.get("is_default")), None) or (voices[0]["id"] if voices else None)
    if default:
        patch = {**patch, "TTS_VOICE": default}
    return patch


# ── 运行状态 / 日志 / 控制 ─────────────────────────────────────────
def voice_port() -> int:
    # 配置真相源是本地 SQLite（经 config_store），voice.conf 仅在播种阶段被读。
    # 注意：这里不能用不存在的 read_voice_config()，否则会抛 NameError 被上层吞掉、
    # 导致 /admin/api/status 的 health 永远为 null。
    try:
        return int(config_store.instance().all().get("VOICE_PORT") or "19529")
    except Exception:
        return 19529


def voice_status() -> dict[str, Any]:
    """pid 存活 + 自身 /health 探活 + voice.sh status 文本。"""
    running = False
    pid: int | None = None
    pid_path = os.path.join(VOICE_HOME_DIR, "voice.pid")
    if os.path.isfile(pid_path):
        try:
            n = int(open(pid_path, encoding="utf-8").read().strip())
        except ValueError:
            n = 0
        if n > 0:
            try:
                os.kill(n, 0)
                running = True
                pid = n
            except OSError:
                pass

    health: Any = None
    try:
        import httpx

        r = httpx.get(
            f"http://127.0.0.1:{voice_port()}/health",
            timeout=2.0,
        )
        health = r.json()
    except Exception:
        health = None

    status_text = ""
    try:
        out = subprocess.run(
            ["bash", VOICE_SCRIPT, "status"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        status_text = (out.stdout or "") + (out.stderr or "")
    except Exception:
        pass

    try:
        store_status = config_store.instance().status()
    except Exception:
        store_status = None
    return {
        "running": running,
        "pid": pid,
        "voiceHome": VOICE_HOME_DIR,
        "script": VOICE_SCRIPT,
        "health": health,
        "port": voice_port(),
        "statusText": status_text,
        "store": store_status,
    }


def _system_overview() -> dict[str, Any]:
    """概览页系统信息（db/redis/内存/缓存/日志/磁盘/CPU/网络），只读、容错、秒回。

    全部用标准库 + 现成 status()，不引入 psutil 等新依赖；任一采集失败给 "—"，
    不影响其它项，更不影响面板。
    """
    def safe(fn, default="—"):
        try:
            v = fn()
            return v if v not in (None, "") else default
        except Exception:
            return default

    def fmt_bytes(n: int) -> str:
        for unit in ("B", "KB", "MB", "GB", "TB"):
            if n < 1024:
                return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
            n /= 1024
        return f"{n:.1f} TB"

    # ── 进程 / CPU / 内存 ──
    pid = os.getpid()
    cpu_pct, rss_kb = "—", "—"
    def ps_info():
        out = subprocess.run(["ps", "-p", str(pid), "-o", "%cpu=", "-o", "rss="],
                             capture_output=True, text=True, timeout=2).stdout.split()
        return (out[0], out[1]) if len(out) >= 2 else ("—", "—")
    cpu_pct, rss_kb = safe(ps_info, ("—", "—"))
    try:
        rss_mb = f"{int(rss_kb)/1024:.1f} MB" if rss_kb != "—" else "—"
    except (ValueError, TypeError):
        rss_mb = "—"
    load1 = safe(lambda: f"{os.getloadavg()[0]:.2f}")
    ncpu = safe(os.cpu_count, "—")
    os_info = safe(lambda: f"{platform.system()} {platform.release()} ({platform.machine()})")
    python_ver = safe(lambda: platform.python_version())

    # ── 磁盘（voice home 所在盘）──
    disk_total = disk_free = disk_pct = "—"
    def disk_info():
        st = os.statvfs(VOICE_HOME_DIR)
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        pct = (total - free) / total * 100 if total else 0
        return fmt_bytes(total), fmt_bytes(free), f"{pct:.1f}%"
    disk_total, disk_free, disk_pct = safe(disk_info, ("—", "—", "—"))

    # ── 网络（监听端口 + 本机 IP）──
    def local_ip():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    ip = safe(local_ip, "127.0.0.1")

    # ── DB ──
    db_path = os.path.join(VOICE_HOME_DIR, "voice.db")
    db_size = safe(lambda: fmt_bytes(os.path.getsize(db_path))) if os.path.isfile(db_path) else "—"
    db_version = safe(lambda: voice_db._conn_get().execute("SELECT MAX(version) FROM schema_version").fetchone()[0])
    db_stats = safe(voice_db.stats, {})
    db_rows = "—"
    if isinstance(db_stats, dict):
        db_rows = f"{sum(v for v in db_stats.values() if isinstance(v, int))} 行"

    # ── 存储的"类型 + 类型特定详情"─────────────────────────────────
    # 每个组件带 type + details，前端按 type 自然显示不同字段（内存/Redis、SQLite/PG 各有各的）。
    store = safe(lambda: config_store.instance().status(), {}) or {}
    remote = store.get("remote", {}) if isinstance(store, dict) else {}
    if not isinstance(remote, dict):
        remote = {}
    remote_dsn = os.environ.get("VOICE_REMOTE_DSN", "").strip()
    redis_url = os.environ.get("REDIS_URL", "").strip()

    # 从 DSN 解析 host/port/database（脱敏，不含密码）
    def dsn_info(dsn: str) -> tuple[str, str, str]:
        try:
            from urllib.parse import urlparse, unquote
            u = urlparse(dsn)
            return u.hostname or "—", str(u.port or ""), unquote((u.path or "").lstrip("/")) or "—"
        except Exception:
            return "—", "—", "—"

    # ② 纠错词表库类型（默认 sqlite，与主库同一个 voice.db）
    try:
        corr_type = voice_correction_store.get_store().backend_name
    except Exception:
        corr_type = "sqlite"
    # 数据库类型：主库 SQLite；纠错库可能另配 mysql/pgsql
    db_type = "SQLite" if corr_type == "sqlite" else ("PostgreSQL" if corr_type == "postgresql" else corr_type.upper())
    db_ver = sqlite3.sqlite_version if corr_type == "sqlite" else "—"
    # 健康：SELECT 1 计时
    def db_health():
        t0 = time.time()
        voice_db._conn_get().execute("SELECT 1").fetchone()
        return f"正常（{(time.time()-t0)*1000:.1f}ms）"
    databases = {
        "type": db_type,
        "version": db_ver,
        "health": safe(db_health, "异常"),
        "size": db_size,
        "schema_version": db_version,
    }

    # 缓存：极简——类型 + key 数量。
    # 开关 CORRECTION_CACHE 统一控制纠错缓存 + 限流：memory=强制内存，redis/auto=跟随 REDIS_URL。
    # 真相源用限流后端实际值（已跟随开关），避免只配了 REDIS_URL 但开关=memory 时误报 Redis。
    rate_stats = safe(rate_store.stats, {})
    rate_backend = rate_stats.get("backend", "memory") if isinstance(rate_stats, dict) else "memory"
    correction_cache = os.environ.get("CORRECTION_CACHE", "auto").strip().lower()
    cache_disabled = correction_cache == "memory"
    cache_type = "内存" if cache_disabled else ("Redis" if rate_backend == "redis" else "内存")
    cfg_keys = safe(lambda: len(voice_db._cache), 0)
    cache_keys = cfg_keys if isinstance(cfg_keys, int) else 0
    if cache_type == "Redis":
        # 限流后端已成功初始化为 redis（rate_stats.backend=redis）即视为连通；
        # 同步探测 redis_ok 只在配置同步时才更新，平时为 None 不代表不连通。
        rook = remote.get("redis_ok")
        if rook is False:
            cache_health = "异常"
            if remote.get("redis_error"):
                cache_health += f"（{str(remote['redis_error'])[:40]}）"
        elif rate_backend == "redis":
            cache_health = "正常"
        else:
            cache_health = "正常" if rook else "未知"
    else:
        cache_health = "正常（进程内存）"
    caches = {"type": cache_type, "keys": cache_keys, "health": cache_health,
              "switch": "memory" if cache_disabled else "redis"}

    # ── 日志 ──
    log_path = os.path.join(VOICE_HOME_DIR, "voice.log")
    log_size = safe(lambda: fmt_bytes(os.path.getsize(log_path))) if os.path.isfile(log_path) else "—"
    log_mtime = safe(lambda: time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(log_path)))) if os.path.isfile(log_path) else "—"
    # 日志文件数 = 主日志 voice.log（存在则计入）+ 轮转归档 voice.log.*（与 voice.sh do_rotate 命名一致）
    def _log_file_count():
        import glob
        files = [f for f in glob.glob(os.path.join(VOICE_HOME_DIR, "voice.log.*")) if os.path.isfile(f)]
        if os.path.isfile(log_path):
            files.append(log_path)
        return len(set(files))
    log_count = safe(_log_file_count, 0)
    # 日志轮转配置（与 voice.sh do_rotate 同源：config_store / voice.conf，缺省对齐 7/10/both）。
    # 仅展示，不在此处修改——轮转由 voice.sh rotate 按这些值执行。
    _lcfg = safe(lambda: config_store.instance().all(), {}) or {}
    rotate_days = str(_lcfg.get("LOG_ROTATE_DAYS") or "7").strip()
    rotate_max_mb = str(_lcfg.get("LOG_ROTATE_MAX_MB") or "10").strip()
    rotate_by = str(_lcfg.get("LOG_ROTATE_BY") or "both").strip()
    rotate_max_files = str(_lcfg.get("LOG_ROTATE_MAX_FILES") or "20").strip()

    # ── 整机 CPU / 内存（psutil，跨平台；区别于上面单进程的 ps 读数）──
    def host_info():
        import psutil
        vm = psutil.virtual_memory()
        return {
            "cpu_percent": f"{psutil.cpu_percent(interval=0.2):.1f}%",
            "cpu_cores": str(psutil.cpu_count() or ncpu),
            "mem_total": fmt_bytes(vm.total),
            "mem_used": fmt_bytes(vm.used),
            "mem_available": fmt_bytes(vm.available),
            "mem_percent": f"{vm.percent:.1f}%",
        }
    host = safe(host_info, {})

    # ── 应用运行情况（各能力模块就绪状态，复用 health 快照）──
    # 延迟导入避免循环依赖；只挑状态字段，不返回 base_url / api_key 等敏感值。
    def app_info():
        import sys
        import openai_voice_server as ovs
        h = ovs.voice_health()
        # 服务以 `python openai_voice_server.py` 启动时主模块是 __main__，而这里 import 的
        # openai_voice_server 是第二次导入的独立模块对象；lifespan 把标志写在 __main__ 上，
        # 故两个模块都要读，避免 MCP 已挂载却显示未就绪。
        mcp_ready = bool(getattr(sys.modules.get("__main__"), "_MCP_MOUNTED", False)) or \
                    bool(getattr(ovs, "_MCP_MOUNTED", False))
        # 用户手动添加的外部 MCP server 工具数：排除 askdata 内置聚合工具（不算用户添加的）。
        # 没添加外部 server 时显示 0。
        mcp_tools = 0
        try:
            import mcp_gateway
            generic_ids = {
                s["id"] for s in voice_db.mcp_servers_list()
                if str(s.get("biz_type") or "generic").strip().lower() != "askdata"
            }
            mcp_tools = sum(
                1 for meta in (getattr(mcp_gateway, "_upstream_tools", {}) or {}).values()
                if isinstance(meta, dict) and meta.get("server_id") in generic_ids
            )
        except Exception:
            pass

        def pool_ok(cap: str) -> bool:
            """池里有可用（健康且非冷却）上游即 ok。"""
            for x in ovs.upstream_pool.health_snapshot(cap) or []:
                if isinstance(x, dict) and x.get("healthy") and not x.get("cooling"):
                    return True
            return False

        # TTS：edge / kokoro 任一可用即 ok（与页面"测试可用"口径一致）
        tts_ok = bool(h.get("tts_edge_ready") or h.get("tts_kokoro_ready"))
        # LLM 未启用时也算不可用；启用再看健康上游
        llm_on = bool(ovs.llm_enabled())
        return {
            "status": h.get("status") or "—",
            "stt": bool(h.get("stt_ready")),
            "tts": tts_ok,
            "llm": llm_on and pool_ok("LLM"),
            "embed": bool(ovs.upstream_pool.load_pool("EMBED")) and pool_ok("EMBED"),
            "rerank": bool(ovs.upstream_pool.load_pool("RERANK")) and pool_ok("RERANK"),
            "ocr": True,  # OCR 接口常驻可用（内置/DeepSeek 由配置决定，见模型配置页）
            "mcp": mcp_ready,
            "mcp_tools": mcp_tools,
            "auth": bool(h.get("auth_enabled")),
            "rate": bool(h.get("rate_limit_enabled")),
        }
    app = safe(app_info, {})

    return {
        "process": {"pid": pid, "cpu": f"{cpu_pct}%", "memory": rss_mb, "load1": load1, "cpu_cores": ncpu,
                    "uptime": f"{int(time.time()-_START_TS)}s", "os": os_info, "python": python_ver},
        "disk": {"total": disk_total, "free": disk_free, "used_pct": disk_pct, "home": VOICE_HOME_DIR},
        "network": {"ip": ip, "port": voice_port(), "host": "0.0.0.0"},
        "database": databases,
        "cache": caches,
        "host": host,
        "app": app,
        "log": {"size": log_size, "last_write": log_mtime, "files": log_count,
                "rotate_days": rotate_days, "rotate_max_mb": rotate_max_mb, "rotate_by": rotate_by,
                "rotate_max_files": rotate_max_files},
    }


def list_log_files() -> list[str]:
    """列出可查看的日志文件：主日志 voice.log + 轮转归档 voice.log.*（按名称倒序，主日志在前）。"""
    import glob
    names = ["voice.log"]
    for p in glob.glob(os.path.join(VOICE_HOME_DIR, "voice.log.*")):
        if os.path.isfile(p):
            names.append(os.path.basename(p))
    # 主日志在前，归档按名称倒序（最近的在前）
    return ["voice.log"] + sorted((n for n in names if n != "voice.log"), reverse=True)


def voice_logs(n: int = 200, name: str | None = None, q: str | None = None,
               start_date: str | None = None, end_date: str | None = None,
               head: bool = False) -> str:
    """读日志 n 行（head=前 n 行 / tail=后 n 行）；可先按日期范围 + 内容 q 过滤。

    name 仅限 voice.log 或 voice.log.*，防路径穿越。start_date/end_date 为
    YYYY-MM-DDTHH:MM（datetime-local 值），归一化后与行首 YYYY-MM-DD HH:MM 按分钟粒度比较，
    落在 [start, end] 闭区间内（字典序即时间序）；各条件是 AND 关系。
    等价于 `grep ... file | head -n` 或 `| tail -n`。
    """
    name = (name or "voice.log").strip()
    if name != "voice.log" and not re.fullmatch(r"voice\.log\.[A-Za-z0-9._-]+", name):
        return ""
    path = os.path.join(VOICE_HOME_DIR, name)
    if not os.path.isfile(path):
        return ""
    lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
    # datetime-local 传 YYYY-MM-DDTHH:MM；归一化 T→空格，与日志行首 YYYY-MM-DD HH:MM 对齐（分钟粒度）
    start = (start_date or "").strip().replace("T", " ")
    end = (end_date or "").strip().replace("T", " ")
    if start or end:
        def in_range(ln: str) -> bool:
            d = ln[:16]  # 行首 YYYY-MM-DD HH:MM
            if start and d < start:
                return False
            if end and d > end:
                return False
            return True
        lines = [ln for ln in lines if in_range(ln)]
    if q and q.strip():
        needle = q.strip().lower()
        lines = [ln for ln in lines if needle in ln.lower()]
    return "\n".join(lines[:n] if head else lines[-n:])


def voice_action(action: str) -> dict[str, Any]:
    allowed = {"start", "stop", "restart", "check", "status"}
    if action not in allowed:
        return {"ok": False, "stdout": "", "stderr": f"不允许的操作: {action}"}
    try:
        out = subprocess.run(
            ["bash", VOICE_SCRIPT, action],
            capture_output=True,
            text=True,
            timeout=60,
        )
        return {
            "ok": out.returncode == 0,
            "stdout": out.stdout or "",
            "stderr": out.stderr or "",
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "stdout": "", "stderr": str(e)}


# ── 管理页面 HTML ─────────────────────────────────────────────────
# HTML 单独放 admin/panel.html，避免把 4000 行页面塞进 Python 源码。
_ADMIN_HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "admin", "panel.html")
with open(_ADMIN_HTML_PATH, encoding="utf-8") as _f:
    ADMIN_HTML = _f.read()


# 把内嵌的固定测试音频（mp3 base64）注入页面，避免在源码里放大段字面量。
try:
    _asr_b64_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "asr_sample.b64")
    with open(_asr_b64_path, encoding="utf-8") as _f:
        _ASR_SAMPLE_B64 = _f.read().strip()
except Exception:
    _ASR_SAMPLE_B64 = ""
ADMIN_HTML = ADMIN_HTML.replace("__ASR_B64__", _ASR_SAMPLE_B64)


# ── 路由注册 ───────────────────────────────────────────────────────
# ── 路由注册 ───────────────────────────────────────────────────────
def register_admin_routes(
    app,
    stt_builtin_check=None,
    tts_builtin_check=None,
    stt_upstream_test=None,
    tts_upstream_test=None,
) -> None:
    """把管理面板的所有端点挂到 app。按域拆到 admin/routes_*.py。

    会话/页面/middleware 强依赖本模块的模块级状态，留在根；其余按域交给 router。
    router 在运行时 import（此时本模块已完全加载），避免顶层循环 import。
    """
    global _STT_BUILTIN_CHECK, _TTS_BUILTIN_CHECK, _STT_UPSTREAM_TEST, _TTS_UPSTREAM_TEST
    _STT_BUILTIN_CHECK = stt_builtin_check
    _TTS_BUILTIN_CHECK = tts_builtin_check
    _STT_UPSTREAM_TEST = stt_upstream_test
    _TTS_UPSTREAM_TEST = tts_upstream_test

    from admin import routes_config, routes_mcp, routes_ops, routes_users

    @app.middleware("http")
    async def admin_security_headers(request: Request, call_next):
        """仅给管理面板加防御性响应头（点击劫持 / MIME 嗅探 / 来源泄露）。"""
        resp = await call_next(request)
        if request.url.path.startswith("/admin"):
            resp.headers.setdefault("X-Content-Type-Options", "nosniff")
            resp.headers.setdefault("X-Frame-Options", "DENY")
            resp.headers.setdefault("Referrer-Policy", "no-referrer")
        return resp

    @app.get("/admin", response_class=HTMLResponse)
    @app.get("/admin/", response_class=HTMLResponse)
    def admin_page():
        # 页面内自行按 /admin/api/me 决定显示登录还是控制台，无需服务端分流。
        # 禁缓存：页面逻辑全在这份 HTML 里，浏览器缓存旧版会让人以为改动没生效。
        return HTMLResponse(ADMIN_HTML, headers={"Cache-Control": "no-store, must-revalidate"})

    @app.get("/admin/api/captcha")
    def admin_captcha():
        """登录验证码（公开，无需会话）：返回 challenge id + SVG。

        开关关闭时 enabled=false，前端不显示验证码；开启时签发答案到 Redis/内存，
        答案只留服务端，SVG 仅含图形。多实例部署靠 Redis 共享，校验打到任意实例都对。
        """
        if not captcha_store.enabled():
            return {"enabled": False}
        answer = captcha_store.new_answer()
        cid = captcha_store.issue(answer)
        resp = JSONResponse({"enabled": True, "id": cid, "svg": captcha_store.render_svg(answer)})
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
        return resp

    @app.post("/admin/login")
    def admin_login(
        request: Request,
        user: str | None = Form(None),
        password: str | None = Form(None),
        captcha_id: str | None = Form(None),
        captcha: str | None = Form(None),
    ):
        # 表单缺字段时显式返回可读字符串，避免 FastAPI 默认 422 把 detail 写成对象数组
        if not user or not password:
            raise HTTPException(status_code=400, detail="请输入账号和密码")
        client = request.client.host if request.client else "unknown"
        # 验证码：默认开启；开关开时必须提交正确答案（一次性消费，防重放）。
        if captcha_store.enabled():
            if not captcha_id or not captcha or not captcha_store.verify(captcha_id, captcha):
                voice_db.append_audit(client, "admin_captcha_failed", f"user={user}")
                raise HTTPException(status_code=400, detail="验证码错误或已过期")
        # 多账号校验：按 username 查 admin_users（含 enabled 判定）
        if not voice_db.admin_user_auth(user, password):
            voice_db.append_audit(client, "admin_login_failed", f"user={user}")
            raise HTTPException(status_code=401, detail="账号或密码错误")
        acct = voice_db.admin_user_get(user)
        voice_db.append_audit(client, "admin_login_success", f"user={user}")
        tok = create_session(user)
        resp = JSONResponse({
            "ok": True, "user": user,
            "role": acct["role"] if acct else "viewer",
            "is_builtin": bool(acct and acct["is_builtin"]),
        })
        resp.set_cookie(
            SESSION_COOKIE,
            tok,
            httponly=True,
            samesite="lax",
            secure=(request.url.scheme == "https"),
            max_age=SESSION_TTL,
            path="/admin",
        )
        return resp

    @app.post("/admin/logout")
    def admin_logout(session: str | None = Cookie(default=None, alias=SESSION_COOKIE)):
        destroy_session(session)
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(SESSION_COOKIE, path="/admin")
        return resp

    @app.get("/admin/api/me")
    def admin_me(session: str | None = Cookie(default=None, alias=SESSION_COOKIE)):
        if valid_session(session):
            username = voice_db.session_username(session)
            acct = voice_db.admin_user_get(username) if username else None
            return {
                "authenticated": True,
                "user": username,
                "role": acct["role"] if acct else "viewer",
                "is_builtin": bool(acct and acct["is_builtin"]),
            }
        return {"authenticated": False}

    @app.post("/admin/api/me/password")
    def admin_change_own_password(
        request: Request,
        body: dict[str, Any],
        session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    ):
        """所有人改自己密码（含内置管理员）；校验旧密码。"""
        if not valid_session(session):
            raise HTTPException(status_code=401, detail="未登录或会话已过期")
        username = voice_db.session_username(session)
        old = (body or {}).get("old_password") or ""
        new = (body or {}).get("new_password") or ""
        if len(new) < 8:
            raise HTTPException(status_code=400, detail="新密码至少 8 位")
        if not voice_db.admin_user_change_password(username, old, new):
            raise HTTPException(status_code=400, detail="旧密码错误")
        client = request.client.host if request.client else "unknown"
        voice_db.append_audit(client, "admin_password_changed", f"user={username}")
        return {"ok": True}

    # ── 按域挂载（全局检测回调注入 ops，避免模块级可变全局）─────────
    app.include_router(routes_users.build_router())
    app.include_router(routes_config.build_router())
    app.include_router(routes_ops.build_router(
        stt_builtin_check=stt_builtin_check,
        tts_builtin_check=tts_builtin_check,
        stt_upstream_test=stt_upstream_test,
        tts_upstream_test=tts_upstream_test,
    ))
    app.include_router(routes_mcp.build_router())
