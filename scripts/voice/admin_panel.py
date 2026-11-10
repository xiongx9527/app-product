"""语音代理的 Web 管理面板（鉴权 + 配置编辑 + 启停 + 日志）。

为什么单独成模块：管理面板要读写 voice.conf、调 voice.sh、读日志，逻辑足够多，
塞进 openai_voice_server.py 会让主文件更难读；独立出来后由主文件调用
init_admin() + register_admin_routes(app) 挂到同一个 FastAPI app 上，端口还是 9529。

鉴权：账号密码来自独立的 admin.conf（与 voice.conf 互不干扰）。登录成功后发一个
httpOnly 的会话 Cookie，后续 /admin/api/* 都校验它；Cookie 不暴露给 JS，降低 XSS
盗用风险。会话只存内存（重启即失效），本地管理工具够用，不引第三方依赖。

为什么不直接复用网关那套 RSA 参数加密：管理面板和代理同进程同端口，没必要把
浏览器到本机的链路再套一层非对称加密；httpOnly Cookie + 本地访问即可。
"""

from __future__ import annotations

import asyncio
import hmac
import os
import re
import secrets
import subprocess
import time
from typing import Any

import config_store  # 统一配置接口：本地缓存 + 本地库 + 远程库，调用方无感
import upstream_pool  # 上游地址池：配置变更后需要清掉池缓存（见 admin_config_save）
import voice_db  # 本地库：配置真相源 + 事件 / 审计 + 会话（落库，跨重启一致）
import httpx  # 探测上游连通性（/admin/api/probe）
import llm_protocols  # 由协议名推导模型列表接口地址（prepare_models）

from fastapi import Cookie, Depends, Form, HTTPException, Request
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


# ── admin.conf 账号密码 ────────────────────────────────────────────
def load_admin_config() -> dict[str, str]:
    """读 admin.conf；缺失时用默认 admin/admin 并提示修改。

    默认账号只在本地开发、且用户还没创建 admin.conf 时兜底，正式用前应改掉。
    """
    path = os.path.join(VOICE_HOME_DIR, "admin.conf")
    cfg = _parse_kv(path)
    user = cfg.get("ADMIN_USER") or "admin"
    pw = cfg.get("ADMIN_PASSWORD") or "admin"
    if not cfg.get("ADMIN_USER"):
        print(
            "[local-ai] 管理面板使用默认账号 admin/admin（未找到 "
            f"{path}，建议创建并改为自定义密码）",
            flush=True,
        )
    return {"user": user, "password": pw}


# ── 会话管理（落库，跨重启 / 多实例一致）──────────────────────────
# 会话写入 voice_db.admin_sessions，重启代理也不会掉登录；多实例共享同一本地库时也一致。
def create_session(username: str) -> str:
    tok = secrets.token_urlsafe(32)
    voice_db.session_create(tok, username)
    return tok


def valid_session(token: str | None) -> bool:
    return voice_db.session_valid(token)


def destroy_session(token: str | None) -> None:
    voice_db.session_destroy(token)


def require_admin(session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> None:
    """/admin/api/* 的鉴权依赖：无有效会话直接 401。"""
    if not valid_session(session):
        raise HTTPException(status_code=401, detail="未登录或会话已过期")


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


# ── 运行状态 / 日志 / 控制 ─────────────────────────────────────────
def voice_port() -> int:
    # 配置真相源是本地 SQLite（经 config_store），voice.conf 仅在播种阶段被读。
    # 注意：这里不能用不存在的 read_voice_config()，否则会抛 NameError 被上层吞掉、
    # 导致 /admin/api/status 的 health 永远为 null。
    try:
        return int(config_store.instance().all().get("VOICE_PORT") or "9529")
    except Exception:
        return 9529


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


def voice_logs(n: int = 200) -> str:
    path = os.path.join(VOICE_HOME_DIR, "voice.log")
    if not os.path.isfile(path):
        return ""
    lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
    return "\n".join(lines[-n:])


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
ADMIN_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title data-i18n="语音助手模型代理管理">语音助手模型代理管理</title>
<style>
  :root { --bg:#0f1115; --card:#1a1d24; --line:#2a2f3a; --fg:#e6e8ec; --mut:#9aa3b2;
          --acc:#4f8cff; --ok:#3ecf8e; --warn:#f5a623; --err:#ff5c5c; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;
         background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center;
           justify-content:space-between; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  .who-wrap { display:flex; align-items:center; gap:12px; }
  main { max-width:920px; margin:0 auto; padding:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; transition:padding .15s ease; }
  .card h2 { font-size:14px; margin:0 0 12px; color:var(--mut); font-weight:600; text-transform:uppercase; letter-spacing:.04em; cursor:pointer; user-select:none; display:flex; justify-content:space-between; align-items:center; }
  .card h2::after { content:'▾'; font-size:13px; line-height:1; color:var(--fg); opacity:.6; transition:transform .15s ease; }
  .card#login h2 { cursor:default; }
  .card#login h2::after { content:''; }
  .card.collapsed { padding-top:12px; padding-bottom:12px; }
  .card.collapsed > *:not(h2) { display:none; }
  .card.collapsed > h2 { margin-bottom:0; }
  .card.collapsed > h2::after { content:'▸'; opacity:.45; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  button { background:var(--acc); color:#fff; border:0; border-radius:8px; padding:8px 14px; cursor:pointer; font-size:13px; }
  button.sec { background:#2a2f3a; color:var(--fg); }
  button.danger { background:#3a1f24; color:#ff8a8a; }
  button.full { width:100%; }
  button:disabled { opacity:.5; cursor:default; }
  input[type=text], input[type=password] { background:#0f1115; border:1px solid var(--line); color:var(--fg);
           border-radius:8px; padding:8px 10px; font-size:13px; width:100%; box-sizing:border-box; }
  label { display:block; color:var(--mut); margin:10px 0 4px; font-size:12px; }
  textarea { background:#0f1115; border:1px solid var(--line); color:var(--fg); border-radius:8px;
             padding:9px 11px; font-size:14px; font-family:inherit; line-height:1.5; resize:vertical; width:100%; box-sizing:border-box; }
  textarea:focus { outline:none; border-color:var(--acc); }
  select { background:#0f1115; border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:8px 10px; font-size:13px; width:100%; box-sizing:border-box; }
  .chk { display:flex; align-items:center; gap:6px; color:var(--mut); font-size:12px; margin-top:10px; }
  .chk input { width:auto; }
  .tabs { display:flex; gap:8px; margin:16px 0 12px; flex-wrap:wrap; }
  .tab { background:#1b1f27; color:var(--mut); border:1px solid var(--line); border-radius:8px; padding:6px 14px; cursor:pointer; font-size:13px; }
  .tab.active { background:var(--acc); color:#0b0d11; border-color:var(--acc); font-weight:600; }
  .tabpane { margin-top:4px; }
  .fixed-prompt { background:#0f1115; border:1px solid var(--line); border-radius:8px;
                  padding:8px 10px; font-size:13px; color:var(--fg); margin-bottom:4px; }
  .kv { display:grid; grid-template-columns:240px 1fr; gap:8px 12px; align-items:center; }
  .kv .k { color:var(--mut); font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; word-break:break-all; }
  .kv input { width:100%; }
  .hint { color:var(--mut); font-size:12px; margin-top:6px; }
  pre { background:#0b0d11; border:1px solid var(--line); border-radius:8px; padding:12px;
        overflow:auto; max-height:320px; font-size:12px; color:#cdd3de; white-space:pre-wrap; word-break:break-all; }
  .think { background:#161a22; border:1px solid var(--line); border-left:3px solid var(--warn); border-radius:6px; padding:8px 10px; font-size:12px; color:#c2c9d6; max-height:260px; overflow:auto; white-space:pre-wrap; word-break:break-all; font-style:italic; }
  table.cfg-table { width:100%; border-collapse:collapse; margin:6px 0 4px; }
  #llmTableWrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  table.cfg-table th, table.cfg-table td { border:1px solid var(--line); padding:5px 6px; text-align:center; vertical-align:middle; font-size:12px; }
  table.cfg-table th { background:#161a22; color:var(--mut); font-weight:600; white-space:nowrap; }
  table.cfg-table input { width:100%; box-sizing:border-box; background:#0f1115; border:1px solid var(--line); color:var(--fg); border-radius:6px; padding:5px 7px; font-size:12px; }
  table.cfg-table td.acc-cell { cursor:pointer; width:120px; max-width:120px; vertical-align:middle; }
  table.cfg-table td.acc-cell:hover { background:#1f2530; }
  table.cfg-table td.acc-cell .acc-url, table.cfg-table td.acc-cell .acc-key { display:block; max-width:108px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  table.cfg-table .prov-cell { background:#14171f; vertical-align:middle; white-space:nowrap; }
  table.cfg-table .prov-cell b { font-size:13px; }
  table.cfg-table td.row-act { white-space:nowrap; width:1%; text-align:center; vertical-align:middle; padding:5px 4px; }
  table.cfg-table td.row-act input[type=radio]{ margin:0; }
  table.cfg-table td.prov-cell { white-space:nowrap; width:1%; }
  table.cfg-table td.prov-cell .mini { margin-left:6px; }
  .modal-mask { position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; align-items:center; justify-content:center; z-index:50; }
  .modal-mask.show { display:flex; }
  .modal { background:#11141a; border:1px solid var(--line); border-radius:12px; padding:18px; width:min(560px,92vw); max-height:80vh; overflow:auto; box-shadow:0 18px 50px rgba(0,0,0,.5); }
  .modal h3 { margin:0 0 12px; font-size:14px; }
  .modal label { color:var(--mut); font-size:12px; margin:12px 0 4px; }
  .modal label:first-of-type { margin-top:0; }
  .modal input[type=text], .modal input[type=password], .modal select {
    width:100%; box-sizing:border-box; background:#0f1115; border:1px solid var(--line); color:var(--fg);
    border-radius:8px; padding:8px 10px; font-size:13px; }
  .modal input:focus, .modal select:focus { outline:none; border-color:var(--acc); }
  /* 抑制浏览器自动填充把输入框刷成浅色背景 */
  .modal input:-webkit-autofill, .modal input:-webkit-autofill:hover, .modal input:-webkit-autofill:focus {
    -webkit-text-fill-color:var(--fg); -webkit-box-shadow:0 0 0 1000px #0f1115 inset; transition:background-color 9999s; }
  .modal .m-out { background:#0b0d11; border:1px solid var(--line); border-radius:8px; padding:12px; font-size:12px; color:#cdd3de; white-space:pre-wrap; word-break:break-all; min-height:40px; }
  table.cfg-table .prov-models { color:var(--mut); font-size:11px; margin-top:4px; line-height:1.5; }
  table.cfg-table tr.asr-builtin, table.cfg-table tr.tts-builtin { background:#141821; }
  table.cfg-table .asr-builtin td, table.cfg-table .tts-builtin td { text-align:center; }
  table.cfg-table tr.asr-builtin .mini, table.cfg-table tr.tts-builtin .mini { padding:3px 10px; font-size:12px; }
  table.cfg-table tr.asr-builtin .badge, table.cfg-table tr.tts-builtin .badge { margin:0; }
  table.cfg-table td.env-cell { text-align:left; }
  table.cfg-table .env-req { color:var(--mut); font-size:11px; margin-top:3px; line-height:1.5; text-align:left; }
  /* 模型子表：提供商拥有哪些模型（多选）、哪个是默认、逐个模型是否可用。
     固定布局 + 定宽列：无论模型名长短，ollama / 自定义 两个子表内部列宽完全一致（已对齐）。 */
  .model-pick { min-width:200px; }
  .model-pick .mp-tools { display:flex; gap:6px; margin-bottom:6px; flex-wrap:wrap; align-items:center; }
  table.model-sub { width:100%; border-collapse:collapse; table-layout:fixed; }
  table.model-sub th, table.model-sub td { border:1px solid var(--line); padding:2px 5px; font-size:11px; text-align:center; vertical-align:middle; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  table.model-sub th { background:#10141b; color:var(--mut); font-weight:600; }
  table.model-sub th:nth-child(1) { width:24px; }   /* 勾选 */
  table.model-sub th:nth-child(3) { width:42px; }   /* 默认 */
  table.model-sub th:nth-child(4) { width:46px; }   /* 操作 */
  table.model-sub th:nth-child(5) { width:54px; }   /* 状态 */
  table.model-sub td.mm { color:var(--fg); }         /* 模型列自适应，过长省略号（与上方定宽列配合，两表列宽一致） */
  table.model-sub td.avail-cell { padding:2px 3px; }
  table.model-sub .mini { padding:2px 7px; font-size:11px; }
  /* 勾选/单选去掉浏览器默认外边距，否则在单元格里看着偏左不居中 */
  table.model-sub input[type=checkbox], table.model-sub input[type=radio] { margin:0; vertical-align:middle; }
  table.hdr-table { width:100%; border-collapse:collapse; margin-top:4px; }
  table.hdr-table th, table.hdr-table td { border:1px solid var(--line); padding:4px 6px; font-size:12px; text-align:left; }
  table.hdr-table th { background:#10141b; color:var(--mut); font-weight:600; }
  table.hdr-table th:last-child, table.hdr-table td:last-child { width:1%; white-space:nowrap; text-align:center; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; margin-right:6px; }
  .b-ok { background:#13352a; color:var(--ok); }
  .b-err { background:#3a1f24; color:var(--err); }
  .b-mut { background:#23272f; color:var(--mut); }
  #login { max-width:340px; margin:80px auto; }
  .err { color:var(--err); font-size:13px; font-weight:700; min-height:18px; margin-top:8px; background:#2a1417; border:1px solid #5a2a2f; border-radius:6px; padding:6px 8px; white-space:pre-wrap; word-break:break-all; }
  .err:empty { display:none; }
  .think-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
  #testModalThinkWrap.collapsed > .think { display:none; }
  .muted { color:var(--mut); }
  .m-prompt { background:#161b22; border:1px dashed var(--line); color:var(--mut); font-style:italic; }
  a { color:var(--acc); }
  /* 全局接口调用 loading：全屏遮罩（不阻塞模态框，z-index 低于模态框 50），
     居中转圈 + 文案；快速请求（<250ms）不闪遮罩。 */
  #panelLoading { position:fixed; inset:0; z-index:40; display:none; align-items:center; justify-content:center;
    background:rgba(8,10,14,.55); backdrop-filter:blur(1px); pointer-events:auto; }
  #panelLoading.show { display:flex; }
  #panelLoading .loading-box { display:flex; flex-direction:column; align-items:center; gap:12px;
    background:rgba(20,23,31,.96); border:1px solid var(--line); border-radius:12px; padding:22px 32px;
    color:var(--fg); font-size:13px; box-shadow:0 10px 40px rgba(0,0,0,.5); }
  #panelLoading .spinner { width:30px; height:30px; border:3px solid rgba(205,211,222,.2);
    border-top-color:var(--acc); border-radius:50%; animation:panel-spin .7s linear infinite; }
  @keyframes panel-spin { to { transform:rotate(360deg); } }
  /* 语言切换：顶部两个小按钮（中 | EN） */
  .lang-switch { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .lang-switch .ls { background:#1b1f27; color:var(--mut); border:0; border-radius:0; padding:5px 10px;
    font-size:12px; cursor:pointer; line-height:1; }
  .lang-switch .ls + .ls { border-left:1px solid var(--line); }
  .lang-switch .ls.active { background:var(--acc); color:#0b0d11; font-weight:600; }
</style>
</head>
<body>
<header><h1 data-i18n="语音助手模型代理管理">语音助手模型代理管理</h1><div class="who-wrap"><span id="who" class="muted"></span><span class="lang-switch"><button class="ls" data-lang="zh-CN">中</button><button class="ls" data-lang="en">EN</button></span><button class="sec" id="logout" data-i18n="退出登录">退出登录</button></div></header>
<main id="app"></main>
<div id="panelLoading"><div class="loading-box"><span class="spinner"></span><span data-i18n="请求中…">请求中…</span></div></div>

<div class="modal-mask" id="testModal">
  <div class="modal">
    <h3 id="testModalTitle" data-i18n="模型测试">模型测试</h3>
    <label data-i18n="协议">协议</label>
    <select id="testModalProto"></select>
    <div class="hint" id="testModalProtoDesc" style="margin-top:4px"></div>
    <label data-i18n="鉴权（若推理接口开启了 API Key）">鉴权（若推理接口开启了 API Key）</label>
    <input id="testModalAuthKey" type="password" data-i18n-ph="可选：API Key" placeholder="可选：API Key" />
    <div id="testModalExtra"></div>
    <label class="chk"><input type="checkbox" id="testModalStream" checked /> <span data-i18n="流式（SSE）">流式（SSE）</span></label>
    <div class="hint" style="margin-top:2px" data-i18n="开启后逐字返回；关闭则等待完整回复。">开启后逐字返回；关闭则等待完整回复。</div>
    <label class="chk"><input type="checkbox" id="testModalThinkMode" /> <span data-i18n="思考模式（推理链）">思考模式（推理链）</span></label>
    <div class="hint" style="margin-top:2px" data-i18n="关闭：界面不显示「思考过程」，并经 X-Proxy-Think 头让代理下发厂商原生参数（如 ollama think=false）真正不推理；开启才显示推理过程。">关闭：界面不显示「思考过程」，并经 X-Proxy-Think 头让代理下发厂商原生参数（如 ollama think=false）真正不推理；开启才显示推理过程。</div>
    <div class="hint" style="margin-top:10px" data-i18n="提示词（固定，不可编辑）">提示词（固定，不可编辑）</div>
    <pre class="m-prompt" id="testModalPrompt" style="margin-top:2px">请只回复 ok 两个字。</pre>
    <div id="testModalThinkWrap" hidden style="margin-top:10px">
      <div class="think-head"><span class="muted" data-i18n="思考过程">思考过程</span><button class="mini" type="button" id="testModalThinkToggle" data-i18n="折叠">折叠</button></div>
      <pre id="testModalThink" class="think"></pre>
    </div>
    <div class="hint" style="margin-top:10px" data-i18n="回复">回复</div>
    <pre class="m-out" id="testModalOut" style="margin-top:2px" data-i18n="回复将在这里显示。">回复将在这里显示。</pre>
    <div class="hint" id="testModalStatus" style="margin-top:8px"></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px; gap:8px"><button id="testModalRun" data-i18n="测试">测试</button><button class="sec" id="testModalClose" data-i18n="关闭">关闭</button></div>
  </div>
</div>

<div class="modal-mask" id="accModal">
  <div class="modal">
    <h3 id="accModalTitle" data-i18n="编辑地址与密钥">编辑地址与密钥</h3>
    <label data-i18n="地址">地址</label>
    <input id="accUrl" type="text" autocomplete="off" placeholder="https://..." />
    <label data-i18n="API Key">API Key</label>
    <input id="accKey" type="password" autocomplete="off" data-i18n-ph="（留空=清空）" placeholder="（留空=清空）" />
    <div class="row" style="justify-content:flex-end;margin-top:16px; gap:8px">
      <button class="sec" id="accCancel" data-i18n="取消">取消</button>
      <button id="accSave" data-i18n="保存">保存</button>
    </div>
  </div>
</div>

<script>
const ASR_SAMPLE_B64 = "__ASR_B64__";  // 内嵌的固定测试音频（mp3 base64），由服务端注入
const api = (path, opts={}) => fetch(path, {credentials:'same-origin', ...opts});
function el(html){ const d=document.createElement('div'); d.innerHTML=html; return d.firstElementChild; }

/* ── i18n：只翻译界面文字（标题/按钮/标签/提示/状态），数据值（厂商名/模型名/配置键/音色分组/固定提示词）保持原样。
   以中文原文为 key，zh-CN 为空（源串兜底），en 为译文。 ── */
const I18N = {
  'zh-CN': {},
  'en': {
    // ── 头部 / 弹框 / 静态 ──
    '语音助手模型代理管理': 'Voice Assistant Model Proxy Admin',
    '退出登录': 'Log out',
    '模型测试': 'Model Test',
    '协议': 'Protocol',
    '鉴权（若推理接口开启了 API Key）': 'Auth (if the inference API requires an API Key)',
    '可选：API Key': 'Optional: API Key',
    '流式（SSE）': 'Streaming (SSE)',
    '开启后逐字返回；关闭则等待完整回复。': 'On: tokens stream in; off: wait for the full reply.',
    '思考模式（推理链）': 'Thinking mode (reasoning chain)',
    '关闭：界面不显示「思考过程」，并经 X-Proxy-Think 头让代理下发厂商原生参数（如 ollama think=false）真正不推理；开启才显示推理过程。': 'Off: the "thinking" box is hidden and the proxy sends vendor-native params via the X-Proxy-Think header (e.g. ollama think=false) to truly disable reasoning; on: the reasoning is shown.',
    '提示词（固定，不可编辑）': 'Prompt (fixed, not editable)',
    '思考过程': 'Thinking',
    '折叠': 'Collapse',
    '回复': 'Reply',
    '回复将在这里显示。': 'Reply will appear here.',
    '测试': 'Test',
    '关闭': 'Close',
    '编辑地址与密钥': 'Edit URL & Key',
    '地址': 'URL',
    'API Key': 'API Key',
    '（留空=清空）': '(leave blank to clear)',
    '取消': 'Cancel',
    '保存': 'Save',
    '请求中…': 'Loading…',
    // ── 登录 ──
    '登录': 'Login',
    '账号': 'Account',
    '账号：': 'Account: ',
    '密码': 'Password',
    '登录失败': 'Login failed',
    // ── 配置卡片 ──
    '（留空则不修改）': '(blank = no change)',
    '配置': 'Config',
    '安全': 'Security',
    '加载中…': 'Loading…',
    '保存中…': 'Saving…',
    '失败：': 'Failed: ',
    '已保存': 'Saved',
    '（已同步远端）': '(synced to remote)',
    '错误：': 'Error: ',
    // ── LLM 表格 ──
    '模型': 'Model',
    '默认': 'Default',
    '操作': 'Action',
    '状态': 'Status',
    '可用': 'Available',
    '不可用': 'Unavailable',
    '未测': 'Not tested',
    '选入提供商': 'Include in provider',
    '默认模型': 'Default model',
    '测可用性': 'Test availability',
    '测': 'Test',
    '；是否流式由下方「流式」勾选框单独控制，与协议无关。': '; streaming is controlled separately by the "Streaming" checkbox below and is independent of the protocol.',
    '模型测试：': 'Model Test: ',
    '编辑：': 'Edit: ',
    '（空）': '(empty)',
    '加载失败 ': 'Load failed ',
    '提供商': 'Provider',
    '默认供应商': 'Default provider',
    '刷新该提供商的模型列表': 'Refresh this provider\'s model list',
    '刷新中…': 'Refreshing…',
    // ── ASR / TTS 内置表格 ──
    '依赖环境': 'Dependencies',
    '内置模型（离线推理，无需外部服务）': 'Built-in model (offline inference, no external service)',
    '模型文件：model.int8.onnx + tokens.txt（放在 ~/.app-product/voice/models/sensevoice/，约 240MB，由 install-voice 下载）': 'Model files: model.int8.onnx + tokens.txt (place under ~/.app-product/voice/models/sensevoice/, ~240MB, downloaded by install-voice)',
    '测试可用': 'Test availability',
    '当前 ASR 固定使用内置模型，能否用取决于运行环境（点「测试可用」按需验证）；外部上游以后按具体厂商单独接入。': 'ASR is fixed to the built-in model; whether it works depends on the runtime (click "Test availability" to verify on demand); external upstreams will be added per vendor later.',
    '正在真实加载内置模型并跑一次推理…': 'Loading the built-in model and running one inference…',
    '模型文件缺失': 'Model file missing',
    '依赖缺失': 'Dependency missing',
    '模型加载或推理失败': 'Model load or inference failed',
    '检测能力未注入': 'Detection capability not injected',
    '检测异常': 'Detection exception',
    '内置可用：模型加载与推理均正常': 'Built-in OK: model loads and infers normally',
    '内置不可用：': 'Built-in unavailable: ',
    '检测失败': 'detection failed',
    '内置不可用：请求失败 ': 'Built-in unavailable: request failed ',
    '内置合成（edge-tts 在线服务）': 'Built-in synthesis (edge-tts online service)',
    '需联网访问微软语音服务，无需本地模型文件': 'Requires network access to Microsoft\'s speech service; no local model file needed',
    'ffmpeg：wav 输出需要（由 install-voice 安装）': 'ffmpeg: required for wav output (installed by install-voice)',
    '当前 TTS 固定走内置 edge-tts，能否用取决于运行环境（点「测试可用」按需验证）；外部上游以后按具体厂商单独接入。': 'TTS is fixed to built-in edge-tts; whether it works depends on the runtime (click "Test availability" to verify on demand); external upstreams will be added per vendor later.',
    '正在按配置合成一句…': 'Synthesizing one sentence per config…',
    '可用：合成成功': 'Available: synthesis succeeded',
    '不可用：': 'Unavailable: ',
    '关闭（默认）': 'Off (default)',
    '开启': 'On',
    '开启后 /llm 与 /voice 数据接口须持有效 Key；/health 与管理面板不受影响': 'On: /llm and /voice data APIs require a valid Key; /health and the admin panel are unaffected',
    '一行一个 Key；或填 auto 自动生成并写入文件。留空则不修改': 'One Key per line; or fill "auto" to auto-generate and write to file. Blank = no change',
    '一行一个 IP 或 CIDR（如 192.168.1.0/24）。留空=不限制来源': 'One IP or CIDR per line (e.g. 192.168.1.0/24). Blank = no source restriction',
    // ── 自定义请求头 / body ──
    '自定义请求头（仅 LLM 对话请求透传到上游；不保存，本次填写本次生效）': 'Custom request headers (forwarded to upstream only for LLM chat; not saved, applies to this session)',
    'Header 名': 'Header name',
    '值': 'Value',
    '+ 添加': '+ Add',
    '删除': 'Delete',
    '自定义 body 参数（作为额外字段透传到上游；不保存，本次填写本次生效）': 'Custom body params (forwarded to upstream as extra fields; not saved, applies to this session)',
    '字段名': 'Field name',
    // ── 对话测试 / 状态 ──
    '请求中…': 'Loading…',
    '失败 ': 'Failed ',
    '完成': 'Done',
    '已停止': 'Stopped',
    // ── 测试卡片 ──
    '对话 LLM': 'Chat LLM',
    '语音识别 ASR': 'Speech Recognition ASR',
    '语音合成 TTS': 'Speech Synthesis TTS',
    '（默认路由）': '(default route)',
    '模型（先选提供商，再选该提供商下的模型）': 'Model (pick a provider first, then a model under it)',
    '（请先选提供商）': '(pick a provider first)',
    '回复将在这里流式显示。': 'Reply will stream here.',
    '发送': 'Send',
    '停止': 'Stop',
    '点录音可把上面的试听音频替换成你录的，识别也用替换后的；「还原」恢复内置样本。': 'Tap record to replace the sample audio with yours; recognition uses the replaced clip; "Restore" reverts to the built-in sample.',
    '录音': 'Record',
    '还原': 'Restore',
    '识别结果将显示在这里。': 'Recognition result will appear here.',
    '识别': 'Recognize',
    '文本': 'Text',
    '音色': 'Voice',
    '合成': 'Synthesize',
    // ── 日志 ──
    '日志（voice.log）': 'Logs (voice.log)',
    '刷新日志': 'Refresh logs',
    '最近 200 行': 'Last 200 lines',
    '展开': 'Expand',
    '音色说明：': 'Voice note: ',
    '　·　参数：音色语言须与文本一致（含方言：台湾腔/粤语配对应文本），否则上游 502': ' · Params: voice language must match the text (incl. dialects: Taiwanese/Cantonese need matching text), otherwise upstream returns 502',
    '合成中…': 'Synthesizing…',
    '（沿用上游默认）': '(use upstream default)',
    '已替换试听音频（识别将用这段）': 'Sample audio replaced (recognition will use this clip)',
    '录音中…': 'Recording…',
    '无法录音：': 'Cannot record: ',
    '已还原内置样本': 'Reverted to built-in sample',
    '未内嵌音频': 'No embedded audio',
    '识别中…': 'Recognizing…',
    '(空)': '(empty)',
    '加载失败': 'Load failed',
    // ── 配置标签（CFG_LABEL，经 t() 解析）──
    'LLM 启用（auto/on/off）': 'LLM enabled (auto/on/off)',
    '上游地址（OpenAI 兼容）': 'Upstream URL (OpenAI-compatible)',
    'API Key（留空=不修改）': 'API Key (blank = no change)',
    '模型名': 'Model name',
    '协议（openai/ollama/...）': 'Protocol (openai/ollama/...)',
    '厂商（ollama/deepseek/...）': 'Vendor (ollama/deepseek/...)',
    'TTS 上游地址（留空走内置 edge-tts）': 'TTS upstream URL (blank = built-in edge-tts)',
    'TTS 上游 Key（留空用共享）': 'TTS upstream Key (blank = shared)',
    '默认音色': 'Default voice',
    'TTS 模型名（可选）': 'TTS model name (optional)',
    'TTS 专属地址（留空用共享）': 'TTS dedicated URL (blank = shared)',
    'TTS 专属 Key（留空用共享）': 'TTS dedicated Key (blank = shared)',
    'TTS 兜底音色': 'TTS fallback voice',
    '是否启用 API-Key 鉴权': 'Enable API-Key auth',
    'API Key 列表（一行一个；填 auto 自动生成）': 'API Key list (one per line; fill "auto" to auto-generate)',
    'IP 白名单（一行一个 IP 或 CIDR；留空=不限制）': 'IP allowlist (one IP or CIDR per line; blank = no restriction)',
    // ── 线协议说明（PROTOCOL_DESC，经 t() 解析）──
    'OpenAI Chat Completions 线协议（/v1/chat/completions，deepseek / 通义等大多兼容）': 'OpenAI Chat Completions wire protocol (/v1/chat/completions, compatible with deepseek / Qwen etc.)',
    'Azure OpenAI（路径带 /openai/deployments/{model}，需 api-version）': 'Azure OpenAI (path includes /openai/deployments/{model}, requires api-version)',
    'OpenAI Responses API（/v1/responses）': 'OpenAI Responses API (/v1/responses)',
    'Anthropic Messages（/v1/messages，请求与流式响应双向翻译）': 'Anthropic Messages (/v1/messages, request and streamed response are bidirectionally translated)',
    'Google Gemini（generateContent / streamGenerateContent，alt=sse）': 'Google Gemini (generateContent / streamGenerateContent, alt=sse)',
  }
};
let curLang = localStorage.getItem('admin_lang') || 'zh-CN';
const t = (zh) => (I18N[curLang] && I18N[curLang][zh]) || zh;
function applyStaticI18n(){
  document.querySelectorAll('[data-i18n]').forEach(e=>{ e.textContent = t(e.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(e=>{ e.placeholder = t(e.getAttribute('data-i18n-ph')); });
}
function setLang(l){
  curLang = (l==='en') ? 'en' : 'zh-CN';
  localStorage.setItem('admin_lang', curLang);
  document.documentElement.lang = curLang;
  document.querySelectorAll('.lang-switch .ls').forEach(b=> b.classList.toggle('active', b.dataset.lang===curLang));
  applyStaticI18n();
  // 动态卡片（renderDashboard 内）经 t() 渲染，切换后整体重建即可刷新
  const app=document.getElementById('app');
  if(app && app.children.length) renderDashboard();
}
document.documentElement.lang = curLang;
document.querySelectorAll('.lang-switch .ls').forEach(b=>{
  b.classList.toggle('active', b.dataset.lang===curLang);
  b.addEventListener('click', ()=> setLang(b.dataset.lang));
});
applyStaticI18n();

async function boot(){
  const me = await api('/admin/api/me').then(r=>r.ok?r.json():null);
  if(!me || !me.authenticated){ renderLogin(); document.getElementById('logout').style.display='none'; }
  else { document.getElementById('who').textContent = t('账号：')+me.user; document.getElementById('logout').style.display=''; renderDashboard(); }
}

function renderLogin(){
  document.getElementById('app').innerHTML = '';
  const card = el(`<div class="card" id="login">
    <h2>${t('登录')}</h2>
    <label>${t('账号')}</label><input type="text" id="u" autocomplete="username" />
    <label>${t('密码')}</label><input type="password" id="p" autocomplete="current-password" />
    <div class="err" id="e"></div>
    <div class="row" style="margin-top:12px"><button id="go">${t('登录')}</button></div>
  </div>`);
  document.getElementById('app').appendChild(card);
  const submit = async ()=>{
    const r = await api('/admin/login', {method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:`user=${encodeURIComponent(document.getElementById('u').value)}&password=${encodeURIComponent(document.getElementById('p').value)}`});
    if(r.ok){ boot(); }
    else { document.getElementById('e').textContent = (await r.json()).detail || t('登录失败'); }
  };
  card.querySelector('#go').onclick = submit;
  card.querySelector('#p').addEventListener('keydown', e=>{ if(e.key==='Enter') submit(); });
}

// ── 配置卡片（LLM / ASR / TTS / 安全 四个 tab，置于测试之上）──
const CFG_TABS = {
  llm: ['LLM_ENABLED','LLM_UPSTREAM_BASE_URL','LLM_UPSTREAM_API_KEY','LLM_UPSTREAM_MODEL','LLM_UPSTREAM_PROTOCOL','LLM_UPSTREAM_VENDOR'],
  asr: ['VOICE_UPSTREAM_BASE_URL','VOICE_UPSTREAM_API_KEY'],
  tts: ['TTS_UPSTREAM_VOICE','TTS_UPSTREAM_MODEL','TTS_UPSTREAM_BASE_URL','TTS_UPSTREAM_API_KEY','TTS_VOICE'],
  sec: ['VOICE_API_KEY_AUTH','VOICE_API_KEY','VOICE_IP_ALLOW'],
};
const CFG_LABEL = {
  LLM_ENABLED:'LLM 启用（auto/on/off）', LLM_UPSTREAM_BASE_URL:'上游地址（OpenAI 兼容）', LLM_UPSTREAM_API_KEY:'API Key（留空=不修改）',
  LLM_UPSTREAM_MODEL:'模型名', LLM_UPSTREAM_PROTOCOL:'协议（openai/ollama/...）', LLM_UPSTREAM_VENDOR:'厂商（ollama/deepseek/...）',
  VOICE_UPSTREAM_BASE_URL:'TTS 上游地址（留空走内置 edge-tts）', VOICE_UPSTREAM_API_KEY:'TTS 上游 Key（留空用共享）',
  TTS_UPSTREAM_VOICE:'默认音色', TTS_UPSTREAM_MODEL:'TTS 模型名（可选）', TTS_UPSTREAM_BASE_URL:'TTS 专属地址（留空用共享）',
  TTS_UPSTREAM_API_KEY:'TTS 专属 Key（留空用共享）', TTS_VOICE:'TTS 兜底音色',
  VOICE_API_KEY_AUTH:'是否启用 API-Key 鉴权', VOICE_API_KEY:'API Key 列表（一行一个；填 auto 自动生成）',
  VOICE_IP_ALLOW:'IP 白名单（一行一个 IP 或 CIDR；留空=不限制）',
};
const isSecret = k => /API_KEY|PASSWORD|SECRET|DSN|_POOL$/i.test(k);
let cfgOrig = {};

function buildConfigCard(){
  const fields = (id,keys)=> keys.map(k=>{
    if(k==='LLM_ENABLED') return `<label>${t(CFG_LABEL[k]||k)}</label><select id="cfg_${k}"><option value="auto">auto</option><option value="on">on</option><option value="off">off</option></select>`;
    const secret = isSecret(k);
    return `<label>${t(CFG_LABEL[k]||k)}</label><input id="cfg_${k}"${secret?` type="password" placeholder="${t('（留空则不修改）')}"`:''} />`;
  }).join('') + `<div class="row" style="margin-top:12px"><button id="cfgSave_${id}">${t('保存')}</button><span class="hint" id="cfgStat_${id}" style="margin-left:10px"></span></div>`;
  return el(`<div class="card collapsed" id="cfgCard"><h2>${t('配置')}</h2>
    <div class="tabs" id="cfgTabs">
      <button class="tab active" data-ctab="llm">LLM</button>
      <button class="tab" data-ctab="asr">ASR</button>
      <button class="tab" data-ctab="tts">TTS</button>
      <button class="tab" data-ctab="sec">${t('安全')}</button>
    </div>
    <div id="c-llm" class="cfgpane"><div id="llmTableWrap" class="hint">${t('加载中…')}</div><div class="row" style="margin-top:12px"><button id="cfgSave_llm">${t('保存')}</button><span class="hint" id="cfgStat_llm" style="margin-left:10px"></span></div></div>
    <div id="c-asr" class="cfgpane" hidden>
      <div id="asrTableWrap" class="hint">${t('加载中…')}</div>
    </div>
    <div id="c-tts" class="cfgpane" hidden>
      <div id="ttsTableWrap" class="hint">${t('加载中…')}</div>
    </div>
    <div id="c-sec" class="cfgpane" hidden><div id="secWrap"></div><div class="row" style="margin-top:12px"><button id="cfgSave_sec">${t('保存')}</button><span class="hint" id="cfgStat_sec" style="margin-left:10px"></span></div></div>
  </div>`);
}

async function loadConfig(){
  try{
    const r = await fetch('/admin/api/config',{credentials:'same-origin'});
    if(!r.ok) return;
    cfgOrig = await r.json();
    ['llm','asr','tts'].forEach(t=>CFG_TABS[t].forEach(k=>{ const inp=document.getElementById('cfg_'+k); if(inp) inp.value = isSecret(k)?'':(cfgOrig[k]||''); }));
    renderLlmTable();
    paintAsrTable();
    paintTtsTable();
    renderSecTable();
  }catch(_){}
}

function cfgVal(k){
  const inp=document.getElementById('cfg_'+k); if(!inp) return undefined;
  if(inp.type==='password'){ return inp.value ? inp.value : null; }  // 空=不发送，保留原密钥
  if(inp.tagName==='TEXTAREA'){ return inp.value.trim() ? inp.value : null; }  // 多值，空=不修改
  return inp.value;
}

function wireConfig(){
  document.querySelectorAll('#cfgTabs .tab').forEach(t=>{
    t.onclick=()=>{ document.querySelectorAll('#cfgTabs .tab').forEach(x=>x.classList.remove('active')); t.classList.add('active');
      ['llm','asr','tts','sec'].forEach(p=>{ const e=document.getElementById('c-'+p); if(e) e.hidden=(t.dataset.ctab!==p); }); };
  });
  const postConfig = async (patch, statId)=>{
    const stat=document.getElementById(statId); stat.className='hint'; stat.textContent=t('保存中…');
    try{
      const r=await fetch('/admin/api/config',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){ stat.className='err'; stat.textContent=t('失败：')+(d.detail||r.status); return; }
      stat.className='hint'; stat.textContent=t('已保存')+(d.remote_push&&d.remote_push.ok?t('（已同步远端）'):'');
      loadConfig();
    }catch(e){ stat.className='err'; stat.textContent=t('错误：')+e.message; }
  };
  const save = async (id,keys,statId)=>{
    const patch={}; keys.forEach(k=>{ const v=cfgVal(k); if(v!==undefined && v!==null) patch[k]=v; });
    return postConfig(patch, statId);
  };
  // 安全 tab：开关总要提交；IP 白名单留空=清空（必须显式发空串）；
  // API Key 留空=不修改（保留原 Key），只有填了新值才提交。
  const saveSec = ()=>{
    const patch={ VOICE_API_KEY_AUTH: document.getElementById('cfg_VOICE_API_KEY_AUTH').value,
                  VOICE_IP_ALLOW: document.getElementById('cfg_VOICE_IP_ALLOW').value };
    const k=document.getElementById('cfg_VOICE_API_KEY').value;
    if(k.trim()) patch.VOICE_API_KEY=k;
    return postConfig(patch, 'cfgStat_sec');
  };
  ['tts'].forEach(t=>{ const b=document.getElementById('cfgSave_'+t); if(b) b.onclick=()=>save(t,CFG_TABS[t],'cfgStat_'+t); });
  const sb=document.getElementById('cfgSave_sec'); if(sb) sb.onclick=saveSec;
  const lb=document.getElementById('cfgSave_llm'); if(lb) lb.onclick=()=>saveLlmTable();
}

// ── LLM 上游池表格（按提供商分组；列：默认 | 提供商 | 地址 | API Key | 模型）──
let llmGroups = [];        // 最近一次拉取的池，供保存时重建 JSON
let llmDefVendor = '';     // 全局默认供应商（LLM_UPSTREAM_VENDOR）
let llmDefModel = '';      // 全局默认模型（LLM_UPSTREAM_MODEL）
// 5 个线协议（与 llm_protocols.WIRE_PROTOCOLS 对齐）
const LLM_PROTOCOLS = [
  'openai_chat_completions', 'azure_openai_chat_completions',
  'openai_responses', 'anthropic_messages', 'gemini'
];

// 从提供商首个账号（含编辑后的值）拉取真实模型列表，供「刷新模型」用
async function probeProviderModels(gi){
  const g=llmGroups[gi]; const a=g.accounts[0];
  const base = a ? (a.base_url||'') : '';
  const key  = a ? (a.api_key||'') : '';
  if(!base) return null;
  try{
    const r=await fetch('/admin/api/probe',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
      body:JSON.stringify({base_url:base,api_key:key,protocol:a.protocol||g.protocol})});
    const d=await r.json().catch(()=>({}));
    return (d.ok && Array.isArray(d.models)) ? d.models : null;
  }catch(_){ return null; }
}

// 模型子表 HTML：多选（_sel）、默认模型单选（_def）、逐模型「测试」
function buildModelPick(gi){
  const g=llmGroups[gi];
  if(!g._cands) g._cands=[...g.models];
  if(!g._sel)   g._sel=new Set(g.models);
  if(!g._avail) g._avail={};   // 各模型最近一次测试结果：'ok' / 'err'
  if(g._def===undefined) g._def = (g.vendor===llmDefVendor && llmDefModel && g.models.includes(llmDefModel)) ? llmDefModel : (g.models[0]||'');
  let html='<div class="model-pick">';
  html+='<table class="model-sub"><thead><tr><th></th><th>'+t('模型')+'</th><th>'+t('默认')+'</th><th>'+t('操作')+'</th><th>'+t('状态')+'</th></tr></thead><tbody>';
  g._cands.forEach(m=>{
    const checked=g._sel.has(m)?'checked':'';
    const isDef=g._def===m?'checked':'';
    const av=g._avail[m];
    const badge = av==='ok' ? '<span class="b-ok">'+t('可用')+'</span>'
                : av==='err' ? '<span class="b-err">'+t('不可用')+'</span>'
                : '<span class="b-mut">'+t('未测')+'</span>';
    html+=`<tr>`
      +`<td><input type="checkbox" class="lp-model" data-g="${gi}" data-m="${escapeAttr(m)}" title="${t('选入提供商')}" ${checked}/></td>`
      +`<td class="mm" title="${escapeAttr(m)}">${escapeHtml(m)}</td>`
      +`<td><input type="radio" name="lpDef_${gi}" value="${escapeAttr(m)}" title="${t('默认模型')}" ${isDef}/></td>`
      +`<td><button class="mini" data-test="${gi}" data-m="${escapeAttr(m)}" title="${t('测可用性')}">${t('测')}</button></td>`
      +`<td class="avail-cell">${badge}</td>`
      +`</tr>`;
  });
  html+='</tbody></table></div>';
  return html;
}

function refreshModelCell(gi){
  const cell=document.querySelector(`#llmTableWrap .lp-modelcell[data-g="${gi}"]`);
  if(cell){ cell.innerHTML=buildModelPick(gi); bindModelCell(gi); }
}

function bindModelCell(gi){
  const cell=document.querySelector(`#llmTableWrap .lp-modelcell[data-g="${gi}"]`);
  if(!cell) return;
  // 多选切换：勾选哪些模型进入提供商；取消勾选时若该模型恰是默认，则清空默认并取消其默认单选
  cell.querySelectorAll('.lp-model').forEach(cb=> cb.onchange=()=>{
    const g=llmGroups[gi], m=cb.dataset.m;
    if(cb.checked) g._sel.add(m);
    else {
      g._sel.delete(m);
      if(g._def===m){ g._def=''; cell.querySelectorAll(`input[name="lpDef_${gi}"]`).forEach(r=>{ if(r.value===m) r.checked=false; }); }
    }
  });
  // 默认模型单选：设为默认时必须同时勾选（默认模型必须是选中的），并同步勾选框
  cell.querySelectorAll(`input[name="lpDef_${gi}"]`).forEach(r=> r.onchange=()=>{
    if(r.checked){
      const g=llmGroups[gi];
      g._def=r.value; g._sel.add(r.value);
      const cb=r.closest('tr') && r.closest('tr').querySelector('.lp-model');
      if(cb) cb.checked=true;
    }
  });
  // 逐模型可用性测试：弹窗复用对话测试，按 供应商+模型 直连代理跑一次轻量对话
  cell.querySelectorAll('[data-test]').forEach(b=> b.onclick=()=>{
    const g=llmGroups[gi], m=b.dataset.m;
    if(!g._sel.has(m)) g._sel.add(m);  // 测试即视为选中该模型
    openTestModal(gi, m);
  });
}

// 模型测试弹窗：打开后不自动测试，由「测试」按钮触发
const TEST_PROMPT = '请只回复 ok 两个字。';   // 测试用的固定提示词（不可编辑）
// 线协议中文说明：底部测试卡片与配置里的模型测试弹窗共用一份
const PROTOCOL_DESC = {
  'openai_chat_completions': 'OpenAI Chat Completions 线协议（/v1/chat/completions，deepseek / 通义等大多兼容）',
  'azure_openai_chat_completions': 'Azure OpenAI（路径带 /openai/deployments/{model}，需 api-version）',
  'openai_responses': 'OpenAI Responses API（/v1/responses）',
  'anthropic_messages': 'Anthropic Messages（/v1/messages，请求与流式响应双向翻译）',
  'gemini': 'Google Gemini（generateContent / streamGenerateContent，alt=sse）',
};
const protoDescText = (v)=> t(PROTOCOL_DESC[v]||'') + t('；是否流式由下方「流式」勾选框单独控制，与协议无关。');
let testModalG=null, testModalM=null, testModalGi=-1;
function openTestModal(gi, m){
  const g=llmGroups[gi];
  const mask=document.getElementById('testModal');
  const title=document.getElementById('testModalTitle');
  const out=document.getElementById('testModalOut');
  const stat=document.getElementById('testModalStatus');
  if(!mask||!title||!out||!stat||!g) return;
  testModalG=g; testModalM=m; testModalGi=gi;
  title.textContent = t('模型测试：') + g.vendor + ' / ' + m;
  const defProto=(g.accounts[0] && g.accounts[0].protocol) || g.protocol || '';
  const protoSel=document.getElementById('testModalProto');
  protoSel.innerHTML = LLM_PROTOCOLS.map(p=>`<option value="${p}"${p===defProto?' selected':''}>${p}</option>`).join('');
  const updateModalProtoDesc=()=>{ const d=document.getElementById('testModalProtoDesc'); if(d) d.textContent=protoDescText(protoSel.value); };
  protoSel.onchange=updateModalProtoDesc;
  updateModalProtoDesc();
  out.textContent=TEST_PROMPT;   // 显示固定提示词，而非「点击测试开始」
  stat.textContent=''; stat.className='hint';
  const tw=document.getElementById('testModalThinkWrap');
  if(tw){ tw.hidden=true; tw.classList.remove('collapsed'); }
  const tToggle=document.getElementById('testModalThinkToggle'); if(tToggle) tToggle.textContent=t('折叠');
  const tk=document.getElementById('testModalThink'); if(tk) tk.textContent='';
  const pm=document.getElementById('testModalPrompt'); if(pm) pm.textContent=TEST_PROMPT;  // 提示词框固定显示
  out.textContent=t('回复将在这里显示。');  // 回复框每次打开重置（占位提示，不显示为回复内容）
  mask.classList.add('show');
}
function runModalTest(){
  const g=testModalG, m=testModalM, gi=testModalGi;
  if(!g||!m) return;
  const out=document.getElementById('testModalOut');
  const stat=document.getElementById('testModalStatus');
  const stream=document.getElementById('testModalStream') ? document.getElementById('testModalStream').checked : true;
  const needThink=document.getElementById('testModalThinkMode') ? document.getElementById('testModalThinkMode').checked : false;
  const protoSel=document.getElementById('testModalProto');
  const proto=protoSel ? protoSel.value : ((g.accounts[0] && g.accounts[0].protocol) || g.protocol);
  const authKey=(document.getElementById('testModalAuthKey')?.value||'').trim();
  const opts={ vendor:g.vendor, model:m, protocol:proto, stream, think:needThink, bypassCatalog:true, kind:'modal', authKey,
    messages:[{role:'user',content:TEST_PROMPT}],
    statusEl: stat, outEl: out,
    thinkEl: document.getElementById('testModalThink'), thinkWrapEl: document.getElementById('testModalThinkWrap'),
    onDone:(ok)=>{
      stat.textContent = ok ? t('可用') : t('不可用'); stat.className = ok ? 'hint' : 'err';
      // 记录测试结果到该模型，刷新子表徽标（可用/不可用/未测）
      if(g && m){ g._avail[m] = ok ? 'ok':'err'; if(gi>=0) refreshModelCell(gi); }
    } };
  runLlmChat(opts);
}

// 地址 / API Key 弹框编辑：避免表格过宽，点单元格弹窗填写
let editAccGi=-1, editAccAi=-1;
function openAccModal(gi, ai){
  const g=llmGroups[gi], a=g && g.accounts[ai];
  if(!a) return;
  editAccGi=gi; editAccAi=ai;
  document.getElementById('accModalTitle').textContent = t('编辑：') + g.vendor + '（' + t('账号') + ' ' + (ai+1) + '）';
  document.getElementById('accUrl').value = a.base_url||'';
  document.getElementById('accKey').value = a.api_key||'';
  document.getElementById('accModal').classList.add('show');
}
function refreshAccCells(gi, ai){
  const a=llmGroups[gi] && llmGroups[gi].accounts[ai]; if(!a) return;
  document.querySelectorAll(`#llmTableWrap .acc-cell[data-g="${gi}"][data-a="${ai}"]`).forEach(td=>{
    const key=td.querySelector('.acc-key');
    if(key) key.textContent = a.api_key ? '••••••' : t('（空）');
    else { const u=td.querySelector('.acc-url'); if(u) u.textContent = a.base_url||''; }
  });
}
function saveAccModal(){
  const g=llmGroups[editAccGi], a=g && g.accounts[editAccAi];
  if(a){
    a.base_url = document.getElementById('accUrl').value.trim();
    a.api_key  = document.getElementById('accKey').value;
    refreshAccCells(editAccGi, editAccAi);
  }
  document.getElementById('accModal').classList.remove('show');
}

async function renderLlmTable(){
  const wrap = document.getElementById('llmTableWrap');
  if(!wrap) return;
  wrap.className='hint'; wrap.textContent=t('加载中…');
  try{
    const r = await fetch('/admin/api/llm-pool',{credentials:'same-origin'});
    if(!r.ok){ wrap.className='err'; wrap.textContent=t('加载失败 ')+r.status; return; }
    const data = await r.json();
    // LLM 固定两个提供商：ollama（预填本机地址）+ 自定义（留空由用户填写）。
    // 池里已有的数据按 vendor 合并进这两行；没有就给默认行。其余 vendor 不展示、保存时不再写回。
    const FIXED_VENDORS = ['ollama', '自定义'];
    const byV = {};
    (data.groups||[]).forEach(g => { byV[g.vendor] = g; });
    llmGroups = FIXED_VENDORS.map(v => {
      const g = byV[v];
      if (g) return { vendor: v, protocol: g.protocol||'', models: g.models||[], accounts: g.accounts||[] };
      if (v === 'ollama') return { vendor:'ollama', protocol:'openai_chat_completions', models:[], accounts:[{ base_url:'http://127.0.0.1:11434', api_key:'' }] };
      return { vendor:'自定义', protocol:'openai_chat_completions', models:[], accounts:[{ base_url:'', api_key:'' }] };
    });
    // 每个账号补上协议字段（后端只给组级 protocol），默认沿用组协议
    llmGroups.forEach(g=> g.accounts.forEach(a=>{ if(!('protocol' in a)) a.protocol = g.protocol; }));
    llmDefVendor = data.default_vendor||'';
    llmDefModel  = data.default_model||'';
    let html = '<table class="cfg-table"><thead><tr>'
      + '<th>'+t('默认')+'</th><th>'+t('提供商')+'</th><th>'+t('地址')+'</th><th>API Key</th><th>'+t('模型')+'</th>'
      + '</tr></thead><tbody>';
    llmGroups.forEach((g, gi)=>{
      const n = g.accounts.length;
      g.accounts.forEach((a, ai)=>{
        const first = ai===0;
        html += '<tr>';
        if(first){
          html += `<td rowspan="${n}" class="row-act"><input type="radio" name="lpDefault" value="${escapeAttr(g.vendor)}" ${g.vendor===llmDefVendor?'checked':''} title="${t('默认供应商')}" /></td>`;
          html += `<td class="prov-cell" rowspan="${n}"><b>${escapeHtml(g.vendor)}</b> <button class="mini lp-refresh" data-g="${gi}" title="${t('刷新该提供商的模型列表')}">↻</button></td>`;
        }
        html += `<td class="acc-cell" data-g="${gi}" data-a="${ai}"><span class="acc-url">${escapeHtml(a.base_url||'')}</span></td>`;
        html += `<td class="acc-cell" data-g="${gi}" data-a="${ai}"><span class="acc-key">${a.api_key?'••••••':t('（空）')}</span></td>`;
        if(first){
          html += `<td class="lp-modelcell" rowspan="${n}" data-g="${gi}">${buildModelPick(gi)}</td>`;
        }
        html += '</tr>';
      });
    });
    html += '</tbody></table>';
    wrap.className=''; wrap.innerHTML = html;
    llmGroups.forEach((g, gi)=> bindModelCell(gi));
    wrap.querySelectorAll('.acc-cell').forEach(td=> td.onclick=()=> openAccModal(+td.dataset.g, +td.dataset.a));
    wrap.querySelectorAll('.lp-refresh').forEach(b=> b.onclick=()=> refreshProviderModels(+b.dataset.g));
  }catch(e){ wrap.className='err'; wrap.textContent=t('错误：')+e.message; }
}

// 只刷新指定提供商（gi）的模型列表；不刷新其它行，避免误刷无关上游
async function refreshProviderModels(gi){
  const btn=document.querySelector(`.lp-refresh[data-g="${gi}"]`);
  if(btn){ btn.disabled=true; btn.textContent=t('刷新中…'); }
  try{
    const g=llmGroups[gi];
    if(!g){ return; }
    const models=await probeProviderModels(gi);
    if(models){ models.forEach(m=>{ if(!g._cands.includes(m)) g._cands.push(m); }); refreshModelCell(gi); }
  }finally{
    if(btn){ btn.disabled=false; btn.textContent='↻'; }
  }
}

async function saveLlmTable(){
  const wrap=document.getElementById('llmTableWrap');
  const stat=document.getElementById('cfgStat_llm'); if(!stat) return;
  stat.className='hint'; stat.textContent=t('保存中…');
  try{
    const defRadio=document.querySelector('input[name=lpDefault]:checked');
    const defaultVendor = defRadio ? defRadio.value : '';
    // 重建为扁平数组：每个「勾选的模型 × 每个账号地址」各生成一条入口（共享 base_url/Key）
    const pool=[];
    llmGroups.forEach((g, gi)=>{
      const sel=[...g._sel].filter(Boolean);
      g.accounts.forEach((a, ai)=>{
        const base_url = a.base_url||'';
        const api_key  = a.api_key||'';
        if(sel.length){
          sel.forEach(m=>{
            pool.push({ vendor:g.vendor, protocol:a.protocol||g.protocol||undefined, model:m, base_url, api_key });
          });
        } else if(base_url){
          // 没勾选模型也要把地址/Key 落库，否则刷新后地址丢失（模型留空，下次刷新再补）
          pool.push({ vendor:g.vendor, protocol:a.protocol||g.protocol||undefined, model:'', base_url, api_key });
        }
      });
    });
    const patch={ LLM_UPSTREAM_POOL: JSON.stringify(pool) };
    if(defaultVendor) patch['LLM_UPSTREAM_VENDOR']=defaultVendor;
    // 默认模型 = 默认供应商里「选中且设为默认」的模型（默认模型必须是选中的）
    if(defaultVendor){
      const g=llmGroups.find(x=>x.vendor===defaultVendor);
      if(g && g._def && g._sel.has(g._def)) patch['LLM_UPSTREAM_MODEL']=g._def;
    }
    const r=await fetch('/admin/api/config',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ stat.className='err'; stat.textContent=t('失败：')+(d.detail||r.status); return; }
    stat.className='hint'; stat.textContent=t('已保存')+(d.remote_push&&d.remote_push.ok?t('（已同步远端）'):'');
    renderLlmTable();
  }catch(e){ stat.className='err'; stat.textContent=t('错误：')+e.message; }
}

// ── ASR 配置（固定使用内置模型，取决于运行环境；只展示内置一行 + 按需「测试可用」）──
// 外部上游以后按具体厂商单独接入，暂不在此提供地址/密钥/协议等配置。
const ASR_BUILTIN = '内置';
let asrBuiltinAvail = null;   // 内置最近一次按需检测：'ok' / 'err' / null(未测)
let asrBuiltinDetail = '';    // 内置检测的补充说明（成功/失败原因），在表格下方行内显示
let ttsBuiltinAvail = null;   // TTS 内置最近一次按需检测：'ok' / 'err' / null(未测)
let ttsBuiltinDetail = '';    // TTS 内置检测的补充说明，在表格下方行内显示

function paintAsrTable(){
  const wrap=document.getElementById('asrTableWrap');
  if(!wrap) return;
  const bAvail = asrBuiltinAvail==='ok' ? '<span class="badge b-ok">'+t('可用')+'</span>'
               : asrBuiltinAvail==='err' ? '<span class="badge b-err">'+t('不可用')+'</span>'
               : '<span class="badge b-mut">'+t('未测')+'</span>';
  let html='<table class="cfg-table"><thead><tr>'
    + '<th>'+t('提供商')+'</th><th>'+t('依赖环境')+'</th><th>'+t('状态')+'</th><th>'+t('操作')+'</th>'
    + '</tr></thead><tbody>';
  // 固定只展示内置一行：写清依赖环境要求、无地址/Key、无刷新、无删除；只留「测试可用」按需检测
  html += `<tr class="asr-builtin" data-builtin="1">
    <td class="prov-cell"><b>${t(ASR_BUILTIN)}</b></td>
    <td class="env-cell">
      <span class="muted">${t('内置模型（离线推理，无需外部服务）')}</span>
      <div class="env-req">${t('模型文件：model.int8.onnx + tokens.txt（放在 ~/.app-product/voice/models/sensevoice/，约 240MB，由 install-voice 下载）')}</div>
    </td>
    <td>${bAvail}</td>
    <td class="row-act"><button class="mini asr-builtin-test" title="${t('真实加载内置模型并跑一次推理')}">${t('测试可用')}</button></td>
  </tr>`;
  html += '</tbody></table>';
  html += '<div class="row" style="margin-top:8px"><span class="hint">'+t('当前 ASR 固定使用内置模型，能否用取决于运行环境（点「测试可用」按需验证）；外部上游以后按具体厂商单独接入。')+'</span><span class="hint" id="asrTableHint" style="margin-left:10px"></span></div>';
  wrap.className=''; wrap.innerHTML=html;
  const bt=wrap.querySelector('.asr-builtin-test'); if(bt) bt.onclick=testAsrBuiltin;
  const bh=document.getElementById('asrTableHint');
  if(bh && asrBuiltinDetail){ bh.textContent=asrBuiltinDetail; bh.style.color = asrBuiltinAvail==='err'?'var(--err)':(asrBuiltinAvail==='ok'?'var(--ok)':''); }
}

// 内置按需检测：真正加载模型并跑一次推理，启动阶段不做，只在这里点按钮时验证。
async function testAsrBuiltin(){
  const wrap=document.getElementById('asrTableWrap');
  const btn=wrap && wrap.querySelector('.asr-builtin-test');
  const hint=document.getElementById('asrTableHint');
  if(btn){ btn.disabled=true; btn.textContent=t('检测中…'); }
  if(hint){ hint.className='hint'; hint.style.color=''; hint.textContent=t('正在真实加载内置模型并跑一次推理…'); }
  const REASON={ model_missing:t('模型文件缺失'), dep_missing:t('依赖缺失'), infer_failed:t('模型加载或推理失败'), not_wired:t('检测能力未注入'), exception:t('检测异常') };
  try{
    const r=await fetch('/admin/api/stt-builtin-test',{method:'POST',credentials:'same-origin'});
    const d=await r.json().catch(()=>({}));
    asrBuiltinAvail = d.ok ? 'ok' : 'err';
    asrBuiltinDetail = d.ok
      ? t('内置可用：模型加载与推理均正常')
      : t('内置不可用：') + (REASON[d.reason]||t('检测失败')) + (d.detail?('（'+d.detail+'）'):'');
  }catch(e){
    asrBuiltinAvail='err';
    asrBuiltinDetail=t('内置不可用：请求失败 ')+e.message;
  }
  paintAsrTable();
  const h=document.getElementById('asrTableHint');
  if(h){ h.textContent=asrBuiltinDetail; h.style.color = asrBuiltinAvail==='ok'?'var(--ok)':'var(--err)'; }
}

function paintTtsTable(){
  const wrap=document.getElementById('ttsTableWrap');
  if(!wrap) return;
  const bAvail = ttsBuiltinAvail==='ok' ? '<span class="badge b-ok">'+t('可用')+'</span>'
               : ttsBuiltinAvail==='err' ? '<span class="badge b-err">'+t('不可用')+'</span>'
               : '<span class="badge b-mut">'+t('未测')+'</span>';
  let html='<table class="cfg-table"><thead><tr>'
    + '<th>'+t('提供商')+'</th><th>'+t('依赖环境')+'</th><th>'+t('状态')+'</th><th>'+t('操作')+'</th>'
    + '</tr></thead><tbody>';
  // 固定只展示内置一行：写清依赖环境要求、无地址/Key、无刷新、无删除；只留「测试可用」按需检测
  html += `<tr class="tts-builtin" data-builtin="1">
    <td class="prov-cell"><b>${t('内置')}</b></td>
    <td class="env-cell">
      <span class="muted">${t('内置合成（edge-tts 在线服务）')}</span>
      <div class="env-req">${t('需联网访问微软语音服务，无需本地模型文件')}</div>
      <div class="env-req">${t('ffmpeg：wav 输出需要（由 install-voice 安装）')}</div>
    </td>
    <td>${bAvail}</td>
    <td class="row-act"><button class="mini tts-builtin-test" title="${t('真实合成一句验证内置 TTS 是否可用')}">${t('测试可用')}</button></td>
  </tr>`;
  html += '</tbody></table>';
  html += '<div class="row" style="margin-top:8px"><span class="hint">'+t('当前 TTS 固定走内置 edge-tts，能否用取决于运行环境（点「测试可用」按需验证）；外部上游以后按具体厂商单独接入。')+'</span><span class="hint" id="ttsTableHint" style="margin-left:10px"></span></div>';
  wrap.className=''; wrap.innerHTML=html;
  const bt=wrap.querySelector('.tts-builtin-test'); if(bt) bt.onclick=testTtsBuiltin;
  const bh=document.getElementById('ttsTableHint');
  if(bh && ttsBuiltinDetail){ bh.textContent=ttsBuiltinDetail; bh.style.color = ttsBuiltinAvail==='err'?'var(--err)':(ttsBuiltinAvail==='ok'?'var(--ok)':''); }
}

// TTS 内置按需检测：真实合成一句，验证 edge-tts 与 ffmpeg 链路，启动阶段不做。
async function testTtsBuiltin(){
  const wrap=document.getElementById('ttsTableWrap');
  const btn=wrap && wrap.querySelector('.tts-builtin-test');
  const hint=document.getElementById('ttsTableHint');
  if(btn){ btn.disabled=true; btn.textContent=t('检测中…'); }
  if(hint){ hint.className='hint'; hint.style.color=''; hint.textContent=t('正在按配置合成一句…'); }
  try{
    const r=await fetch('/admin/api/tts-builtin-test',{method:'POST',credentials:'same-origin'});
    const d=await r.json().catch(()=>({}));
    ttsBuiltinAvail = d.ok ? 'ok' : 'err';
    ttsBuiltinDetail = d.ok ? t('可用：合成成功') : t('不可用：')+(d.detail||d.reason||t('检测失败'));
  }catch(e){
    ttsBuiltinAvail='err';
    ttsBuiltinDetail=t('不可用：请求失败 ')+e.message;
  }
  paintTtsTable();
  const h=document.getElementById('ttsTableHint');
  if(h){ h.textContent=ttsBuiltinDetail; h.style.color = ttsBuiltinAvail==='ok'?'var(--ok)':'var(--err)'; }
}

// 安全配置：API-Key 鉴权开关 + 多 Key + IP 白名单（多 IP/CIDR）。
// 默认不开启；开启后可填多个 Key（一行一个）与多个 IP/CIDR（一行一个）。
function renderSecTable(){
  const wrap=document.getElementById('secWrap'); if(!wrap) return;
  const auth = (cfgOrig['VOICE_API_KEY_AUTH']||'off');
  const keyVal = isSecret('VOICE_API_KEY') ? '' : (cfgOrig['VOICE_API_KEY']||'');
  const ipVal = (cfgOrig['VOICE_IP_ALLOW']||'');
  wrap.innerHTML = `
    <div class="row"><label>${t(CFG_LABEL['VOICE_API_KEY_AUTH'])}</label>
      <select id="cfg_VOICE_API_KEY_AUTH">
        <option value="off"${auth==='off'?' selected':''}>${t('关闭（默认）')}</option>
        <option value="on"${auth==='on'?' selected':''}>${t('开启')}</option>
      </select>
      <span class="hint">${t('开启后 /llm 与 /voice 数据接口须持有效 Key；/health 与管理面板不受影响')}</span>
    </div>
    <div class="row"><label>${t(CFG_LABEL['VOICE_API_KEY'])}</label>
      <textarea id="cfg_VOICE_API_KEY" rows="3" style="width:100%;box-sizing:border-box;font-family:monospace" placeholder="${t('一行一个 Key；或填 auto 自动生成并写入文件。留空则不修改')}">${escapeHtml(keyVal)}</textarea>
    </div>
    <div class="row"><label>${t(CFG_LABEL['VOICE_IP_ALLOW'])}</label>
      <textarea id="cfg_VOICE_IP_ALLOW" rows="3" style="width:100%;box-sizing:border-box;font-family:monospace" placeholder="${t('一行一个 IP 或 CIDR（如 192.168.1.0/24）。留空=不限制来源')}">${escapeHtml(ipVal)}</textarea>
    </div>`;
}

// ── 可复用的对话测试：测试 tab 与配置表格（提供商/模型）共用，靠 opts 个性化 ──
// opts: { vendor, model, protocol, stream, messages, statusEl, outEl, thinkEl, thinkWrapEl, onDone }
//   onDone(success:boolean) 在结束（成功/失败/中断）时回调，供调用方自定义结果呈现（如「是否可用」徽标）
let llmCtrl = null;
// 测试固定打本代理 http://127.0.0.1:<配置端口>（端口从 /admin/api/status 取），
// LLM / ASR / TTS 共用；状态还没回来时为空，等价走相对路径。
let testOrigin = '';

// 自定义请求头：按 tab 各自独立，每类请求只带自己那张表里的头（当前只启用 LLM）。
// 表格每行一组 Key/Value -> 普通 HTTP 请求头对象（不持久化，每次请求自己带）。
// 客户端填什么头，请求里就是什么头；代理原样透传给上游，无需特殊协议。
function hdrTableHtml(kind){
  return `<label>${t('自定义请求头（仅 LLM 对话请求透传到上游；不保存，本次填写本次生效）')}</label>
    <table class="hdr-table">
      <thead><tr><th>${t('Header 名')}</th><th>${t('值')}</th><th><button class="mini" type="button" data-add-hdr="${kind}">${t('+ 添加')}</button></th></tr></thead>
      <tbody data-hdr-body="${kind}"></tbody>
    </table>`;
}
function addHeaderRow(kind, k, v){
  const tb=document.querySelector(`[data-hdr-body="${kind}"]`);
  if(!tb) return;
  const tr=document.createElement('tr');
  tr.innerHTML='<td><input type="text" class="h-k" placeholder="X-Tenant-Id" /></td>'
             + '<td><input type="text" class="h-v" placeholder="'+t('值')+'" /></td>'
             + '<td><button class="mini danger" type="button" data-del-hdr>'+t('删除')+'</button></td>';
  tr.querySelector('.h-k').value=k||'';
  tr.querySelector('.h-v').value=v||'';
  tb.appendChild(tr);
}
function proxyExtraHeaders(kind){
  const tb=document.querySelector(`[data-hdr-body="${kind}"]`);
  if(!tb) return {};
  const obj={};
  tb.querySelectorAll('tr').forEach(tr=>{
    const k=((tr.querySelector('.h-k')||{}).value||'').trim();
    const v=((tr.querySelector('.h-v')||{}).value||'').trim();
    if(k) obj[k]=v;
  });
  return obj;
}

// 自定义 body 参数：与请求头表格平行，填的 KV 作为额外字段透传到上游请求体。
// 同样按 tab 隔离、不持久化（当前只启用 LLM）。因各线协议 payload 结构不同，
// 用单独字段 extra_body 承载，由代理统一合并到上游 payload，不覆盖协议自身字段。
function bodyTableHtml(kind){
  return `<label>${t('自定义 body 参数（作为额外字段透传到上游；不保存，本次填写本次生效）')}</label>
    <table class="hdr-table">
      <thead><tr><th>${t('字段名')}</th><th>${t('值')}</th><th><button class="mini" type="button" data-add-body="${kind}">${t('+ 添加')}</button></th></tr></thead>
      <tbody data-extra-body="${kind}"></tbody>
    </table>`;
}
function addBodyRow(kind, k, v){
  const tb=document.querySelector(`[data-extra-body="${kind}"]`);
  if(!tb) return;
  const tr=document.createElement('tr');
  tr.innerHTML='<td><input type="text" class="h-k" placeholder="custom_field" /></td>'
             + '<td><input type="text" class="h-v" placeholder="'+t('值')+'" /></td>'
             + '<td><button class="mini danger" type="button" data-del-body>'+t('删除')+'</button></td>';
  tr.querySelector('.h-k').value=k||'';
  tr.querySelector('.h-v').value=v||'';
  tb.appendChild(tr);
}
function proxyExtraBody(kind){
  const tb=document.querySelector(`[data-extra-body="${kind}"]`);
  if(!tb) return {};
  const obj={};
  tb.querySelectorAll('tr').forEach(tr=>{
    const k=((tr.querySelector('.h-k')||{}).value||'').trim();
    const v=((tr.querySelector('.h-v')||{}).value||'').trim();
    if(k) obj[k]=v;
  });
  return obj;
}

// 弹框交互用全局事件委托：不依赖 renderDashboard 是否执行到某处绑定，
// 避免「有时候关不掉」。每次重新取 DOM，不持有可能失效的旧引用。
function closeTestModal(){
  const mask=document.getElementById('testModal');
  if(mask) mask.classList.remove('show');
  if(llmCtrl){ try{ llmCtrl.abort(); }catch(_){} llmCtrl=null; }
}
document.addEventListener('click',(e)=>{
  const t=e.target; if(!t || !t.closest) return;
  // 自定义请求头 / body 参数表格：增删行（全局委托，不依赖渲染顺序；按 tab 各自独立）
  const addBtn=t.closest('[data-add-hdr]');
  if(addBtn){ addHeaderRow(addBtn.dataset.addHdr); return; }
  if(t.closest('[data-del-hdr]')){ const tr=t.closest('tr'); if(tr) tr.remove(); return; }
  const addBody=t.closest('[data-add-body]');
  if(addBody){ addBodyRow(addBody.dataset.addBody); return; }
  if(t.closest('[data-del-body]')){ const tr=t.closest('tr'); if(tr) tr.remove(); return; }
  if(t.closest('#testModalRun')){ runModalTest(); return; }
  const mask=document.getElementById('testModal');
  if(!mask || !mask.classList.contains('show')) return;
  if(t.closest('#testModalClose') || t===mask) closeTestModal();   // 关闭按钮 / 点遮罩
});
document.addEventListener('keydown',(e)=>{
  if(e.key!=='Escape') return;
  closeTestModal();
  const acc=document.getElementById('accModal'); if(acc) acc.classList.remove('show');
});

async function runLlmChat(opts){
  const { vendor, model, protocol, stream, messages, statusEl, outEl, thinkEl, thinkWrapEl, onDone, bypassCatalog, think, kind, authKey } = opts;
  // kind 决定读哪一套自定义请求头 / body 参数表格：底部测试卡片='llm'，配置里的模型测试弹窗='modal'。
  const hkind = kind || 'llm';
  // 思考模式开关：关掉时坚决不显示「思考过程」框（不依赖上游是否遵守 think=false），
  // 否则推理模型即使被要求关闭推理仍会回传 reasoning_content，思考框又会冒出来。
  const wantThink = (think !== false);
  if(!statusEl){ if(onDone) onDone(false); return; }
  const setStatus = (t,c)=>{ statusEl.textContent=t; statusEl.className=c; };
  if(outEl) outEl.textContent='';
  if(thinkEl){ thinkEl.textContent=''; if(thinkWrapEl) thinkWrapEl.hidden=true; }
  setStatus(t('请求中…'),'hint');
  const ctrl = new AbortController();
  llmCtrl = ctrl;
  let done=false;
  try{
    const k=authKey!==undefined ? authKey : (document.getElementById('testKey').value||'').trim();
    const auth = k?{'Authorization':'Bearer '+k}:{};
    const body={ messages, stream:!!stream };
    const extraBody=proxyExtraBody(hkind);  // 自定义 body 参数：作为额外字段透传到上游
    if(Object.keys(extraBody).length) body.extra_body=extraBody;
    if(model) body.model=model;            // 留空则让代理用上游默认模型，不要发 "default"
    if(vendor) body.vendor=vendor;          // 显式指定提供商，覆盖模型路由
    if(protocol) body.protocol=protocol;    // 显式指定线协议，覆盖入口配置
    if(bypassCatalog) body.bypass_catalog=true;  // 测试场景：跳过模型目录校验，直接探真实上游
    // 思考模式：对外固定一个参数，经请求头 X-Proxy-Think 传（body 里也带一份做双通道），
    // 代理收到后由 apply_think 翻译成上游厂商原生的 body 参数，真正让模型不思考。
    if(think!==undefined && think!==null) body.think = !!think;
    const thinkHdr=(think!==undefined && think!==null)?{'X-Proxy-Think':String(!!think)}:{};
    const r=await fetch(testOrigin+'/llm/v1/chat/completions',{method:'POST',credentials:'same-origin',signal:ctrl.signal,
      headers:{'content-type':'application/json',...auth,...thinkHdr,...proxyExtraHeaders(hkind)}, body:JSON.stringify(body)});
    if(!r.ok){
      const txt=await r.text(); let msg=t('失败 ')+r.status;
      try{ const d=JSON.parse(txt);
        if(d&&d.error&&d.error.message) msg+=': '+d.error.message;
        else if(d&&d.detail) msg+=': '+d.detail;
        else msg+=': '+txt.slice(0,200);
      }catch(_){ msg+=': '+txt.slice(0,200); }
      setStatus(msg,'err'); return;
    }
    if(stream){
      const reader=r.body.getReader(), dec=new TextDecoder(); let buf='', text='', thinkTxt='';
      while(true){
        const {done,value}=await reader.read(); if(done) break;
        buf+=dec.decode(value,{stream:true});
        let idx;
        while((idx=buf.indexOf('\n'))>=0){
          const line=buf.slice(0,idx).trim(); buf=buf.slice(idx+1);
          if(!line.startsWith('data:')) continue;
          const data=line.slice(5).trim(); if(data==='[DONE]') break;
          try{
            const j=JSON.parse(data); const d=j.choices&&j.choices[0]&&j.choices[0].delta; if(!d) continue;
            if(wantThink && thinkEl && d.reasoning_content){ thinkTxt+=d.reasoning_content; thinkEl.textContent=thinkTxt; if(thinkWrapEl) thinkWrapEl.hidden=false; }
            if(outEl && d.content){ text+=d.content; outEl.textContent=text; }
          }catch(_){}
        }
      }
    } else {
      const d=await r.json();
      const ch=(d.choices&&d.choices[0]&&d.choices[0].message)||{};
      const reasoning=ch.reasoning_content||'';
      const text=ch.content||JSON.stringify(d);
      if(wantThink && thinkEl && reasoning && thinkWrapEl){ thinkEl.textContent=reasoning; thinkWrapEl.hidden=false; }
      if(outEl) outEl.textContent=text;
    }
    setStatus(t('完成'),'hint'); done=true;
  }catch(e){ if(e.name==='AbortError'){ setStatus(t('已停止'),'hint'); } else { setStatus(t('错误：')+e.message,'err'); } }
  if(onDone) onDone(done);
}



async function renderDashboard(){
  const app = document.getElementById('app'); app.innerHTML='';

  app.appendChild(buildConfigCard());

  app.appendChild(el(`<div class="card collapsed" id="testCard"><h2>${t('测试')}</h2>
    <label>${t('鉴权（若推理接口开启了 API Key）')}</label>
    <input id="testKey" type="password" placeholder="${t('可选：API Key')}" />
    <div class="tabs">
      <button class="tab active" data-tab="llm">${t('对话 LLM')}</button>
      <button class="tab" data-tab="asr">${t('语音识别 ASR')}</button>
      <button class="tab" data-tab="tts">${t('语音合成 TTS')}</button>
    </div>

    <div id="t-llm" class="tabpane">
      <label>${t('提供商')}</label>
      <select id="llmProvider"><option value="">${t('（默认路由）')}</option></select>
      <label>${t('模型（先选提供商，再选该提供商下的模型）')}</label>
      <select id="llmModel" disabled>
        <option value="">${t('（请先选提供商）')}</option>
      </select>
      <label>${t('协议')}</label>
      <select id="llmProtocol">
        <option value="openai_chat_completions">openai_chat_completions（OpenAI 对话）</option>
        <option value="azure_openai_chat_completions">azure_openai_chat_completions（Azure OpenAI）</option>
        <option value="openai_responses">openai_responses（OpenAI Responses）</option>
        <option value="anthropic_messages">anthropic_messages（Anthropic）</option>
        <option value="gemini">gemini（Google Gemini）</option>
      </select>
      <div class="hint" id="llmProtoDesc" style="margin-top:4px"></div>
      ${hdrTableHtml('llm')}
      ${bodyTableHtml('llm')}
      <label class="chk"><input type="checkbox" id="llmStream" checked /> <span>${t('流式（SSE）')}</span></label>
      <div class="hint" style="margin-top:2px">${t('开启后逐字返回；关闭则等待完整回复。')}</div>
      <label class="chk"><input type="checkbox" id="llmThinkMode" /> <span>${t('思考模式（推理链）')}</span></label>
      <div class="hint" style="margin-top:2px">${t('关闭：界面不显示「思考过程」，并经 X-Proxy-Think 头让代理下发厂商原生参数（如 ollama think=false）真正不推理；开启才显示推理过程。')}</div>
      <label>${t('提示词（固定，不可编辑）')}</label>
      <div id="llmInput" class="fixed-prompt">请只回复 ok 两个字。</div>
      <div id="llmThinkWrap" hidden style="margin-top:10px">
        <div class="think-head"><span class="muted">${t('思考过程')}</span><button class="mini" type="button" id="llmThinkToggle">${t('折叠')}</button></div>
        <pre id="llmThink" class="think"></pre>
      </div>
      <div class="muted" style="margin-top:10px">${t('回复')}</div>
      <pre id="llmOut" class="muted">${t('回复将在这里流式显示。')}</pre>
      <div class="row" style="margin-top:12px">
        <button id="llmGo" style="flex:1">${t('发送')}</button>
        <button class="sec" id="llmStop" style="flex:1">${t('停止')}</button>
      </div>
      <span class="hint" id="llmStatus" style="display:block; margin-top:6px"></span>
    </div>

    <div id="t-asr" class="tabpane" hidden>
      <div class="muted" style="margin-bottom:8px">${t('点录音可把上面的试听音频替换成你录的，识别也用替换后的；「还原」恢复内置样本。')}</div>
      <audio id="asrPlayer" controls style="width:100%;margin:6px 0 12px"></audio>
      <div class="row">
        <button id="asrRec">${t('录音')}</button>
        <button id="asrRecStop" class="danger" disabled>${t('停止')}</button>
        <button id="asrRevert" class="sec" style="display:none">${t('还原')}</button>
        <span class="hint" id="asrRecMsg"></span>
      </div>
      <pre id="asrOut" class="muted">${t('识别结果将显示在这里。')}</pre>
      <button id="asrGo" class="full" style="margin-top:12px">${t('识别')}</button>
      <span class="hint" id="asrMsg" style="display:block; margin-top:6px"></span>
    </div>

    <div id="t-tts" class="tabpane" hidden>
      <label>${t('文本')}</label>
      <textarea id="ttsText" rows="2">你好。</textarea>
      <label>${t('音色')}</label>
      <select id="ttsVoice"></select>
      <div class="hint" id="ttsVoiceDesc" style="margin-top:4px"></div>
      <audio id="ttsAudio" controls style="margin-top:10px; width:100%"></audio>
      <button id="ttsGo" class="full" style="margin-top:12px">${t('合成')}</button>
      <span class="hint" id="ttsMsg" style="display:block; margin-top:6px"></span>
    </div>
  </div>`));

  addHeaderRow('llm'); addBodyRow('llm');  // 目前只启用 LLM 一栏，两张表各给一行空行

  // 配置里的模型测试弹窗：注入它自己的一套自定义请求头 / body 参数表格（与底部互不干扰）。
  // 弹窗是静态 DOM，只在首次渲染时注入一次。
  const modalExtra=document.getElementById('testModalExtra');
  if(modalExtra && !modalExtra.dataset.ready){
    modalExtra.innerHTML=hdrTableHtml('modal')+bodyTableHtml('modal');
    modalExtra.dataset.ready='1';
    addHeaderRow('modal'); addBodyRow('modal');
  }

  app.appendChild(el(`<div class="card"><h2>${t('日志（voice.log）')}</h2>
    <div class="row" style="margin-bottom:10px">
      <button class="sec" id="logRefresh">${t('刷新日志')}</button>
      <span class="muted">${t('最近 200 行')}</span></div>
    <pre id="logs">${t('加载中…')}</pre>
  </div>`));

  document.getElementById('logout').onclick = async ()=>{
    await api('/admin/logout',{method:'POST'}); boot();
  };
  app.querySelector('#logRefresh').onclick = loadLogs;

  wireConfig(); loadConfig();

  // 卡片可折叠：点击标题（配置 / 测试 / 日志）展开或收起；登录卡片不可折叠
  app.querySelectorAll('.card > h2').forEach(h=>{
    if(h.parentElement.id==='login') return;
    h.onclick=()=>h.parentElement.classList.toggle('collapsed');
  });

  // ---- 测试面板逻辑 ----
  const authHdr = ()=>{ const k=(document.getElementById('testKey').value||'').trim(); return k?{'Authorization':'Bearer '+k}:{}; };

  // 标签页切换（只作用于测试卡片的 tab，配置卡片的 tab 由 wireConfig 单独处理，互不干扰）
  const tabs = app.querySelectorAll('.tab[data-tab]');
  tabs.forEach(t=>t.onclick=()=>{
    tabs.forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    ['llm','asr','tts'].forEach(k=>{ document.getElementById('t-'+k).hidden = (t.dataset.tab!==k); });
    if(t.dataset.tab==='llm'){ populateLlmProviders(); }
  });

  // 弹框的关闭 / 测试按钮已在全局用事件委托绑定（见 closeTestModal），此处不再重复绑定。
  // 思考过程折叠：默认展开，可收起长文本
  const tToggle=document.getElementById('testModalThinkToggle');
  if(tToggle){
    tToggle.onclick=()=>{
      const w=document.getElementById('testModalThinkWrap'); if(!w) return;
      const collapsed=w.classList.toggle('collapsed');
      tToggle.textContent=collapsed?t('展开'):t('折叠');
    };
  }
  // 思考模式开关：关闭时立即隐藏「思考过程」区域（不再展示推理链）
  const tMode=document.getElementById('testModalThinkMode');
  if(tMode){
    tMode.onchange=()=>{
      const w=document.getElementById('testModalThinkWrap'); if(!w) return;
      if(!tMode.checked){
        w.hidden=true; w.classList.remove('collapsed');
        if(tToggle) tToggle.textContent=t('折叠');
      }
    };
  }
  // 地址/密钥弹框：保存/取消，关闭时中断在跑请求
  const accModal=document.getElementById('accModal');
  const accSave=document.getElementById('accSave');
  const accCancel=document.getElementById('accCancel');
  if(accSave) accSave.onclick=saveAccModal;
  if(accCancel && accModal) accCancel.onclick=()=> accModal.classList.remove('show');
  if(accModal) accModal.addEventListener('click', e=>{ if(e.target===accModal) accModal.classList.remove('show'); });

  // TTS 音色下拉：按语言分组，每个音色带一句说明（性别 / 风格 / 适用场景）
  const voiceSel = document.getElementById('ttsVoice');
  const VOICE_DESC = document.getElementById('ttsVoiceDesc');
  // 兜底目录：接口拿不到时用（与服务端 VOICE_CATALOG 保持一致）
  let VOICE_CATALOG = [
    {id:'zh-CN-XiaoxiaoNeural',lang:'中文',desc:'女声·温柔自然（默认）'},
    {id:'zh-CN-YunxiNeural',lang:'中文',desc:'男声·年轻活泼'},
    {id:'zh-CN-YunyangNeural',lang:'中文',desc:'男声·专业新闻播报'},
    {id:'zh-CN-XiaoyiNeural',lang:'中文',desc:'女声·活泼可爱'},
    {id:'zh-CN-YunjianNeural',lang:'中文',desc:'男声·成熟稳重'},
    {id:'zh-CN-YunxiaNeural',lang:'中文',desc:'女声·甜美'},
    {id:'zh-CN-XiaoxuanNeural',lang:'中文',desc:'女声·清新'},
    {id:'zh-TW-HsiaoChenNeural',lang:'中文(台湾)',desc:'女声·台湾腔'},
    {id:'zh-TW-YunJheNeural',lang:'中文(台湾)',desc:'男声·台湾腔'},
    {id:'zh-TW-HsiaoYuNeural',lang:'中文(台湾)',desc:'女声·台湾腔·温柔'},
    {id:'zh-HK-HiuGaaiNeural',lang:'粤语',desc:'女声·粤语'},
    {id:'zh-HK-WanLungNeural',lang:'粤语',desc:'男声·粤语'},
    {id:'zh-HK-HiuMaanNeural',lang:'粤语',desc:'女声·粤语·活泼'},
    {id:'en-US-AriaNeural',lang:'英文',desc:'女声·自然通用'},
    {id:'en-US-GuyNeural',lang:'英文',desc:'男声·沉稳'},
    {id:'en-US-JennyNeural',lang:'英文',desc:'女声·亲切'},
    {id:'en-GB-SoniaNeural',lang:'英文(英式)',desc:'女声·优雅英音'},
    {id:'en-GB-RyanNeural',lang:'英文(英式)',desc:'男声·英音'},
    {id:'ja-JP-NanamiNeural',lang:'日文',desc:'女声·柔和'},
    {id:'ja-JP-KeitaNeural',lang:'日文',desc:'男声·清晰'},
  ];
  const voiceDesc = (id)=>{ const f=VOICE_CATALOG.find(v=>v.id===id); return f? f.desc : ''; };
  const fillVoices = (def)=>{
    voiceSel.innerHTML='';
    const groups={};
    VOICE_CATALOG.forEach(v=>{ (groups[v.lang]=groups[v.lang]||[]).push(v); });
    Object.entries(groups).forEach(([g,items])=>{
      const og=document.createElement('optgroup'); og.label=g;
      items.forEach(v=>{ const o=document.createElement('option'); o.value=v.id; o.textContent=v.id+'　'+v.desc; og.appendChild(o); });
      voiceSel.appendChild(og);
    });
    if(def){ const o=document.createElement('option'); o.value=def; o.textContent=def+t('（默认）'); voiceSel.appendChild(o); }
    voiceSel.value = def || VOICE_CATALOG[0].id;
    VOICE_DESC.textContent = t('音色说明：') + voiceDesc(voiceSel.value) + t('　·　参数：音色语言须与文本一致（含方言：台湾腔/粤语配对应文本），否则上游 502');
  };
  voiceSel.onchange = ()=>{ VOICE_DESC.textContent = t('音色说明：') + voiceDesc(voiceSel.value) + t('　·　参数：音色语言须与文本一致（含方言：台湾腔/粤语配对应文本），否则上游 502'); };
  // 从对外接口拉取最新音色目录（接口不可用时回退兜底）
  fetch('/voice/v1/audio/voices',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(d=>{
    if(d && Array.isArray(d.voices) && d.voices.length){ VOICE_CATALOG=d.voices; fillVoices(d.default); }
  }).catch(()=>{});
  api('/admin/api/status').then(r=>r.ok?r.json():null).then(s=>{
    const def = s && s.health && s.health.tts_voice;
    if(s && s.port) testOrigin='http://127.0.0.1:'+s.port;   // 三个 tab 统一打本代理
    fillVoices(def||undefined);
  }).catch(()=>fillVoices());

  // TTS 合成
  document.getElementById('ttsGo').onclick = async ()=>{
    const msg=document.getElementById('ttsMsg'), audio=document.getElementById('ttsAudio');
    msg.textContent=t('合成中…'); msg.className='hint'; audio.src='';
    try{
      const r=await fetch(testOrigin+'/voice/v1/audio/speech',{method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json',...authHdr()},
        body:JSON.stringify({input:document.getElementById('ttsText').value,voice:voiceSel.value,response_format:'wav',speed:1.0})});
      if(!r.ok){ msg.textContent=t('失败')+' '+r.status+'：'+(await r.text()).slice(0,200); msg.className='err'; return; }
      const blob=await r.blob(); audio.src=URL.createObjectURL(blob);
      msg.textContent=t('完成')+'（'+(blob.size/1024).toFixed(1)+' KB）'; msg.className='hint';
    }catch(e){ msg.textContent=t('错误：')+e.message; msg.className='err'; }
  };

  // 模型下拉按所选提供商联动：没选提供商时禁用；选了才列出该提供商下的模型。
  // 归属关系来自 /llm/v1/providers 每条的 vendor + model，见 populateLlmProviders。
  let llmProviderModels = {};
  function refreshLlmModels(){
    const prov=document.getElementById('llmProvider'), sel=document.getElementById('llmModel');
    if(!prov || !sel) return;
    const v=(prov.value||'').trim();
    const models=llmProviderModels[v]||[];
    sel.innerHTML='';
    const head=document.createElement('option');
    head.value=''; head.textContent = v ? t('（沿用上游默认）') : t('（请先选提供商）');
    sel.appendChild(head);
    models.forEach(m=>{ const o=document.createElement('option'); o.value=m; o.textContent=m; sel.appendChild(o); });
    sel.disabled = !v;
    sel.value='';
  }

  // LLM 协议下拉的中文说明（选中后展示，与模型测试弹窗共用 PROTOCOL_DESC）
  const updateProtoDesc = ()=>{ document.getElementById('llmProtoDesc').textContent = protoDescText(document.getElementById('llmProtocol').value); };
  document.getElementById('llmProtocol').onchange = updateProtoDesc;
  updateProtoDesc();

  // LLM 对话（支持协议 / 提供商 / 流式开关）——复用下方 runLlmChat，配置表格的「测试连接」也调它
  const llmStatus=document.getElementById('llmStatus'), llmOut=document.getElementById('llmOut');
  const llmThinkWrap=document.getElementById('llmThinkWrap'), llmThink=document.getElementById('llmThink');
  document.getElementById('llmGo').onclick = ()=>{
    const needThink=document.getElementById('llmThinkMode') ? document.getElementById('llmThinkMode').checked : false;
    const opts={
      vendor: document.getElementById('llmProvider').value.trim(),
      model: document.getElementById('llmModel').value.trim(),
      protocol: document.getElementById('llmProtocol').value.trim(),
      stream: document.getElementById('llmStream').checked,
      think: needThink,
      messages: [{role:'user',content:document.getElementById('llmInput').textContent}],
      statusEl: llmStatus, outEl: llmOut, thinkEl: llmThink, thinkWrapEl: llmThinkWrap,
    };
    runLlmChat(opts);
  };
  document.getElementById('llmStop').onclick = ()=>{ if(llmCtrl) llmCtrl.abort(); };
  // 底部测试：思考过程折叠 + 思考模式开关（与模型测试弹窗一致）
  const llmThinkTog=document.getElementById('llmThinkToggle');
  if(llmThinkTog){
    llmThinkTog.onclick=()=>{
      const w=document.getElementById('llmThinkWrap'); if(!w) return;
      const collapsed=w.classList.toggle('collapsed');
      llmThinkTog.textContent=collapsed?t('展开'):t('折叠');
    };
  }
  const llmThinkMode=document.getElementById('llmThinkMode');
  if(llmThinkMode){
    llmThinkMode.onchange=()=>{
      const w=document.getElementById('llmThinkWrap'); if(!w) return;
      if(!llmThinkMode.checked){
        w.hidden=true; w.classList.remove('collapsed');
        if(llmThinkTog) llmThinkTog.textContent=t('折叠');
      }
    };
  }

  // LLM 提供商列表：按 vendor 去重，同时记下每个 vendor 拥有的模型，供模型下拉联动。
  async function populateLlmProviders(){
    const sel=document.getElementById('llmProvider');
    const cur=sel ? sel.value : '';
    const map={};
    const hosts={};
    try{
      const r=await fetch('/llm/v1/providers',{credentials:'same-origin'});
      if(r.ok){
        const d=await r.json(); const ps=(d.providers||[]).filter(p=>p.vendor && p.vendor!=='(未指定)');
        ps.forEach(p=>{
          const v=p.vendor;
          if(!map[v]) map[v]=[];
          if(p.model && !map[v].includes(p.model)) map[v].push(p.model);
          if(p.host && !hosts[v]) hosts[v]=p.host;
        });
      }
    }catch(_){}
    llmProviderModels=map;
    if(sel){
      sel.innerHTML='<option value="">'+t('（默认路由）')+'</option>';
      Object.keys(map).forEach(v=>{
        const o=document.createElement('option'); o.value=v;
        o.textContent=v+(hosts[v]?('　('+hosts[v]+')'):''); sel.appendChild(o);
      });
      sel.value = Object.prototype.hasOwnProperty.call(map,cur) ? cur : '';
      sel.onchange = refreshLlmModels;
    }
    refreshLlmModels();
  }

  // ASR：可录音（直接替换上方试听音频），或一键识别内嵌的固定音频
  let asrBlob=null, mediaRec=null, mediaStream=null;
  document.getElementById('asrRec').onclick = async ()=>{
    try{
      mediaStream=await navigator.mediaDevices.getUserMedia({audio:true});
      mediaRec=new MediaRecorder(mediaStream); const chunks=[];
      mediaRec.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
      mediaRec.onstop=async ()=>{
        const raw=new Blob(chunks,{type:mediaRec.mimeType||'audio/webm'});
        try{ asrBlob=await toWav(raw); }
        catch(_){ asrBlob=raw; }
        document.getElementById('asrPlayer').src=URL.createObjectURL(asrBlob);
        document.getElementById('asrRevert').style.display='';
        document.getElementById('asrRecMsg').textContent=t('已替换试听音频（识别将用这段）');
        mediaStream.getTracks().forEach(t=>t.stop());
      };
      mediaRec.start();
      document.getElementById('asrRec').disabled=true; document.getElementById('asrRecStop').disabled=false;
      document.getElementById('asrRecMsg').textContent=t('录音中…');
    }catch(e){ document.getElementById('asrRecMsg').textContent=t('无法录音：')+e.message; }
  };
  document.getElementById('asrRecStop').onclick = ()=>{
    if(mediaRec&&mediaRec.state!=='inactive') mediaRec.stop();
    document.getElementById('asrRec').disabled=false; document.getElementById('asrRecStop').disabled=true;
  };
  document.getElementById('asrRevert').onclick = ()=>{
    asrBlob=null;
    if(ASR_SAMPLE_B64) document.getElementById('asrPlayer').src='data:audio/wav;base64,'+ASR_SAMPLE_B64;
    document.getElementById('asrRevert').style.display='none';
    document.getElementById('asrRecMsg').textContent=t('已还原内置样本');
  };
  document.getElementById('asrGo').onclick = async ()=>{
    const msg=document.getElementById('asrMsg'), out=document.getElementById('asrOut');
    msg.className='hint';
    let blob=asrBlob, fname='record.wav';
    if(!blob){
      if(!ASR_SAMPLE_B64){ msg.textContent=t('未内嵌音频'); return; }
      const bin=atob(ASR_SAMPLE_B64); const bytes=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      blob=new Blob([bytes],{type:'audio/wav'}); fname='sample.wav';
    }
    msg.textContent=t('识别中…');
    try{
      const fd=new FormData(); fd.append('file',blob,fname); fd.append('model','whisper-1');
      const r=await fetch(testOrigin+'/voice/v1/audio/transcriptions',{method:'POST',credentials:'same-origin',headers:{...authHdr()},body:fd});
      if(!r.ok){ msg.textContent=t('失败')+' '+r.status+'：'+(await r.text()).slice(0,200); msg.className='err'; return; }
      const d=await r.json(); out.textContent=d.text||t('(空)'); msg.textContent=t('完成'); msg.className='hint';
    }catch(e){ msg.textContent=t('错误：')+e.message; msg.className='err'; }
  };
  // 固定音频可直接在页面播放试听
  if(ASR_SAMPLE_B64) document.getElementById('asrPlayer').src='data:audio/wav;base64,'+ASR_SAMPLE_B64;

  populateLlmProviders();  // 初始页就是 LLM，拉提供商并联动刷新模型下拉
  loadLogs();
}

// 任意音频 blob 转 16-bit PCM WAV（浏览器原生解码后重编码，保证上游能识别）。
async function toWav(blob){
  const arr=await blob.arrayBuffer();
  const Ctx=window.AudioContext||window.webkitAudioContext;
  const ctx=new Ctx();
  const buf=await ctx.decodeAudioData(arr);
  const ch=buf.numberOfChannels, len=buf.length, sr=buf.sampleRate;
  const out=new ArrayBuffer(44+len*ch*2), dv=new DataView(out);
  const wr=(o,s)=>{ for(let i=0;i<s.length;i++) dv.setUint8(o+i,s.charCodeAt(i)); };
  wr(0,'RIFF'); dv.setUint32(4,36+len*ch*2,true); wr(8,'WAVE'); wr(12,'fmt ');
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,ch,true);
  dv.setUint32(24,sr,true); dv.setUint32(28,sr*ch*2,true); dv.setUint16(32,ch*2,true);
  dv.setUint16(34,16,true); wr(36,'data'); dv.setUint32(40,len*ch*2,true);
  let off=44; const data=[]; for(let c=0;c<ch;c++) data.push(buf.getChannelData(c));
  for(let i=0;i<len;i++){ for(let c=0;c<ch;c++){ let s=Math.max(-1,Math.min(1,data[c][i])); dv.setInt16(off,s<0?s*0x8000:s*0x7FFF,true); off+=2; } }
  ctx.close();
  return new Blob([out],{type:'audio/wav'});
}

// 弃用的面板函数（运行状态 / 数据库 / 配置 / 服务控制）已按需求移除，相关
// 业务配置一律存放在本地 SQLite（voice.db），不再通过 Web 面板展示或编辑。

async function loadLogs(){
  const r = await api('/admin/api/logs');
  const pre = document.getElementById('logs');
  if(!r.ok){ pre.textContent=t('加载失败'); return; }
  pre.textContent = await r.text();
}

function escapeHtml(s){ return (s||'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escapeAttr(s){ return (s||'').replace(/"/g,'&quot;'); }

// 全局接口 loading：拦截 fetch，任意 /admin 接口进行中时显示全屏遮罩（居中转圈），
// 全部请求结束才隐藏（计数防止并发请求互相抵消）。遮罩 z-index 低于模态框，
// 所以弹框内的流式测试仍能在遮罩之上正常显示进度。快速请求（<250ms）延迟显示，避免闪烁。
(function(){
  let _pending = 0;
  let _timer = null;
  const _el = () => document.getElementById('panelLoading');
  const _show = () => { const e = _el(); if (e) e.classList.add('show'); };
  const _hide = () => { const e = _el(); if (e) e.classList.remove('show'); };
  const _orig = window.fetch.bind(window);
  window.fetch = async (...args) => {
    _pending++;
    if (_timer === null) _timer = setTimeout(_show, 250);
    try { return await _orig(...args); }
    finally {
      _pending--;
      if (_pending <= 0) {
        _pending = 0;
        if (_timer !== null) { clearTimeout(_timer); _timer = null; }
        _hide();
      }
    }
  };
})();

boot();
</script>
</body>
</html>
"""

# 把内嵌的固定测试音频（mp3 base64）注入页面，避免在源码里放大段字面量。
try:
    _asr_b64_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "asr_sample.b64")
    with open(_asr_b64_path, encoding="utf-8") as _f:
        _ASR_SAMPLE_B64 = _f.read().strip()
except Exception:
    _ASR_SAMPLE_B64 = ""
ADMIN_HTML = ADMIN_HTML.replace("__ASR_B64__", _ASR_SAMPLE_B64)


# ── 路由注册 ───────────────────────────────────────────────────────
def register_admin_routes(app, stt_builtin_check=None, tts_builtin_check=None) -> None:
    global _STT_BUILTIN_CHECK, _TTS_BUILTIN_CHECK
    _STT_BUILTIN_CHECK = stt_builtin_check
    _TTS_BUILTIN_CHECK = tts_builtin_check

    @app.get("/admin", response_class=HTMLResponse)
    @app.get("/admin/", response_class=HTMLResponse)
    def admin_page():
        # 页面内自行按 /admin/api/me 决定显示登录还是控制台，无需服务端分流。
        # 禁缓存：页面逻辑全在这份 HTML 里，浏览器缓存旧版会让人以为改动没生效。
        return HTMLResponse(ADMIN_HTML, headers={"Cache-Control": "no-store, must-revalidate"})

    @app.post("/admin/login")
    def admin_login(user: str = Form(...), password: str = Form(...)):
        cfg = load_admin_config()
        ok = hmac.compare_digest(user, cfg["user"]) and hmac.compare_digest(
            password, cfg["password"]
        )
        if not ok:
            raise HTTPException(status_code=401, detail="账号或密码错误")
        tok = create_session(cfg["user"])
        resp = JSONResponse({"ok": True, "user": cfg["user"]})
        resp.set_cookie(
            SESSION_COOKIE,
            tok,
            httponly=True,
            samesite="lax",
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
            cfg = load_admin_config()
            return {"authenticated": True, "user": cfg["user"]}
        return {"authenticated": False}

    @app.get("/admin/api/status", dependencies=[Depends(require_admin)])
    def admin_status():
        return voice_status()

    @app.get("/admin/api/config", dependencies=[Depends(require_admin)])
    def admin_config():
        return read_voice_config_masked()

    @app.post("/admin/api/config", dependencies=[Depends(require_admin)])
    async def admin_config_save(request: Request):
        try:
            patch = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
        if not isinstance(patch, dict):
            raise HTTPException(status_code=400, detail="请求体必须是对象")
        # 丢弃客户端回传的脱敏哨兵：UI 把密钥 / 地址池打码成 HIDDEN，若原样写回会
        # 把真实密钥 / 池 JSON 覆盖成星号。只有非哨兵的值才允许落地。
        patch = {k: v for k, v in patch.items() if v != HIDDEN}
        err = write_voice_config(patch)
        if err:
            raise HTTPException(status_code=500, detail=err)
        # 配置可能改了上游地址池（LLM/STT/TTS_UPSTREAM_POOL 等），清掉池缓存，
        # 下次请求立即按新配置重新解析，不必重启服务。
        upstream_pool.invalidate()
        # 保存即触发一次远程同步（best-effort，失败不影响本地）。调用方无需关心远程。
        push = None
        try:
            push = await config_store.instance().sync_push()
        except Exception as e:  # noqa: BLE001
            push = {"ok": False, "error": str(e)}
        return {"ok": True, "remote_push": push}

    @app.get("/admin/api/logs", dependencies=[Depends(require_admin)])
    def admin_logs(n: int = 200):
        if n <= 0 or n > 2000:
            n = 200
        return Response(voice_logs(n), media_type="text/plain; charset=utf-8")

    @app.post("/admin/api/action", dependencies=[Depends(require_admin)])
    async def admin_action(request: Request):
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
        action = body.get("action") if isinstance(body, dict) else None
        if not action:
            raise HTTPException(status_code=400, detail="缺少 action")
        return voice_action(action)

    @app.post("/admin/api/sync", dependencies=[Depends(require_admin)])
    async def admin_sync():
        """手动触发双向同步：远端 -> 本地合并，再 本地 -> 远端；缓存与 DB 调用方无感。"""
        store = config_store.instance()
        pulled = await store.sync_pull()
        push = await store.sync_push()
        return {
            "ok": True,
            "pulled_keys": len(pulled),
            "push": push,
            "remote": store.status()["remote"],
        }

    @app.get("/admin/api/llm-pool", dependencies=[Depends(require_admin)])
    def admin_llm_pool():
        """LLM 上游按提供商分组返回：每组含厂商、协议、去重模型列表、账号清单（地址/Key/本账号模型）。
        供配置页表格渲染（提供商上下合并、模型映射）使用。账号里的 api_key 为明文（管理端点，
        仅本地同源可达），前端预填进密码框，留空即视为「清空该 Key」。"""
        entries = upstream_pool.load_pool("LLM")
        groups: dict[str, Any] = {}
        order: list[str] = []
        for e in entries:
            v = (e.get("vendor") or e.get("protocol") or "unknown")
            if v not in groups:
                # 同一提供商下，base_url+api_key 相同的入口视为「同一个账号」，合并成一行；
                # 模型统一挂在组级，不按模型数膨胀出行（否则保存次数越多行越多）。
                groups[v] = {"vendor": v, "protocol": e.get("protocol") or "", "models": set(), "accounts": [], "_seen_acc": set()}
                order.append(v)
            g = groups[v]
            m = e.get("model")
            if m:
                g["models"].add(m)
            acc_key = (e.get("base_url", "") or "", e.get("api_key", "") or "")
            if acc_key not in g["_seen_acc"]:
                g["_seen_acc"].add(acc_key)
                g["accounts"].append({"base_url": acc_key[0], "api_key": acc_key[1]})
        out = [
            {
                "vendor": groups[v]["vendor"],
                "protocol": groups[v]["protocol"],
                "models": sorted(groups[v]["models"]),
                "accounts": groups[v]["accounts"],
            }
            for v in order
        ]
        default_vendor = config_store.instance().get("LLM_UPSTREAM_VENDOR", "") or ""
        default_model = config_store.instance().get("LLM_UPSTREAM_MODEL", "") or ""
        return {"groups": out, "default_vendor": default_vendor, "default_model": default_model}

    @app.post("/admin/api/stt-builtin-test", dependencies=[Depends(require_admin)])
    async def admin_stt_builtin_test():
        """按需真实检测内置（本地 SenseVoice）是否可用。

        启动阶段不做任何检测：内置可用性只在这里点「测试可用」时验证。检测会真正
        加载 240MB 模型并跑一次推理，放到线程里避免阻塞事件循环。
        """
        if _STT_BUILTIN_CHECK is None:
            return {"ok": False, "reason": "not_wired", "detail": "检测能力未注入"}
        try:
            return await asyncio.to_thread(_STT_BUILTIN_CHECK)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "exception", "detail": str(exc)}

    @app.post("/admin/api/tts-builtin-test", dependencies=[Depends(require_admin)])
    async def admin_tts_builtin_test():
        """按需真实检测内置 TTS（edge-tts + ffmpeg）是否可用：合成一句短语。

        启动阶段不做：edge-tts 走微软在线服务，联网合成有耗时，且用户可能改用外部上游。
        检测函数是 async，直接 await，不必再丢线程。
        """
        if _TTS_BUILTIN_CHECK is None:
            return {"ok": False, "reason": "not_wired", "detail": "检测能力未注入"}
        try:
            return await _TTS_BUILTIN_CHECK()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "exception", "detail": str(exc)}

    @app.post("/admin/api/probe", dependencies=[Depends(require_admin)])
    async def admin_probe(request: Request):
        """探测任意上游连通性：给定地址/Key/协议，拉一次模型列表验证可用；支持未保存的配置。"""
        try:
            b = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
        if not isinstance(b, dict):
            raise HTTPException(status_code=400, detail="请求体必须是对象")
        base = (b.get("base_url") or "").strip()
        key = (b.get("api_key") or "").strip()
        protocol = (b.get("protocol") or "openai").strip()
        if not base:
            return {"ok": False, "error": "缺少上游地址"}
        try:
            url, headers = llm_protocols.prepare_models(protocol, base, key)
        except Exception:
            url = base.rstrip("/") + "/v1/models"
            headers = {"Authorization": f"Bearer {key}"} if key else {}
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.get(url, headers=headers)
            ok = r.status_code < 400
            names: list[str] = []
            try:
                d = r.json()
                if isinstance(d, dict):
                    if isinstance(d.get("data"), list):
                        names = [m.get("id", "") for m in d["data"][:20]]
                    elif isinstance(d.get("models"), list):
                        names = [m.get("name", "") for m in d["models"][:20]]
            except Exception:
                pass
            return {"ok": ok, "status": r.status_code, "models": [n for n in names if n][:20]}
        except Exception as e:
            return {"ok": False, "error": str(e)}
