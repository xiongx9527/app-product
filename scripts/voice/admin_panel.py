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
    "EMBED_UPSTREAM_POOL",  # 向量上游池（含 api_key 的 JSON，整串打码），与 LLM 池数据独立
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
<title data-i18n="app.title">语音助手模型代理管理</title>
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
  a.sec { background:#2a2f3a; color:var(--fg); text-decoration:none; padding:5px 12px; border-radius:8px; font-size:13px; line-height:1.4; }
  a.sec:hover { background:#343a47; }
  button.danger { background:#3a1f24; color:#ff8a8a; }
  button.full { width:100%; }
  button:disabled { opacity:.5; cursor:default; }
  input[type=text], input[type=password], input[type=number] { background:#0f1115; border:1px solid var(--line); color:var(--fg);
           border-radius:8px; padding:8px 10px; font-size:13px; width:100%; box-sizing:border-box; }
  input::placeholder, textarea::placeholder { color:var(--mut); opacity:1; }
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
  #asrTableWrap, #ttsTableWrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
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
  .modal input[type=text], .modal input[type=password], .modal input[type=number], .modal select {
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
  table.cfg-table td.env-cell { text-align:left; max-width:240px; }
  table.cfg-table .env-req { color:var(--mut); font-size:11px; margin-top:3px; line-height:1.5; text-align:left; }
  /* 模型子表：提供商拥有哪些模型（多选）、哪个是默认、逐个模型是否可用。
     固定布局 + 定宽列：无论模型名长短，ollama / 自定义 两个子表内部列宽完全一致（已对齐）。 */
  .model-pick { min-width:150px; max-height:300px; overflow-y:auto; }
  .proto-tag { color:var(--mut); font-size:10px; line-height:1.3; }
  .model-pick .mp-tools { display:flex; gap:6px; margin-bottom:6px; flex-wrap:wrap; align-items:center; }
  table.model-sub { width:100%; border-collapse:collapse; table-layout:fixed; }
  table.model-sub th, table.model-sub td { border:1px solid var(--line); padding:2px 5px; font-size:11px; text-align:center; vertical-align:middle; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  table.model-sub th { background:#10141b; color:var(--mut); font-weight:600; position:sticky; top:0; z-index:1; white-space:normal; line-height:1.15; }
  table.model-sub th:nth-child(1) { width:24px; }   /* 勾选 */
  table.model-sub th:nth-child(3) { width:58px; }   /* 默认（LLM/向量 通用） */
  table.model-sub th:nth-child(4) { width:46px; }   /* 操作 */
  table.model-sub th:nth-child(5) { width:54px; }   /* 状态 */
  table.model-sub td.mm { color:var(--fg); }         /* 模型列自适应，过长省略号（与上方定宽列配合，两表列宽一致） */
  table.model-sub td.avail-cell { padding:2px 3px; }
  table.model-sub .mini { padding:2px 7px; font-size:11px; }
  /* 勾选/单选去掉浏览器默认外边距，否则在单元格里看着偏左不居中 */
  table.model-sub input[type=checkbox], table.model-sub input[type=radio] { margin:0; vertical-align:middle; }
  /* 只读子表（内置模型）的 disabled 控件：Chrome 会把 disabled+checked 渲染成灰色，
     暗色主题下选中的圆点几乎不可见，像没选。强制保持 accent 高亮，让「默认选中」看得见。 */
  table.model-sub input[type=radio]:disabled:checked,
  table.model-sub input[type=checkbox]:disabled:checked { accent-color: #3b82f6; opacity: 1; }
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
  /* 通用小号加载环（弹框状态、表格内可用作 loading） */
  .spinner { display:inline-block; width:13px; height:13px; vertical-align:-2px; margin-right:6px;
    border:2px solid rgba(205,211,222,.25); border-top-color:var(--acc); border-radius:50%;
    animation:panel-spin .7s linear infinite; }
  /* 测试进行中的状态行：带加载环，明确区别于最终「可用/不可用」 */
  .status-loading { color:var(--acc); font-weight:600; }
  /* 语言切换：顶部两个小按钮（中 | EN） */
  .lang-switch { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .lang-switch .ls { background:#1b1f27; color:var(--mut); border:0; border-radius:0; padding:5px 10px;
    font-size:12px; cursor:pointer; line-height:1; }
  .lang-switch .ls + .ls { border-left:1px solid var(--line); }
  .lang-switch .ls.active { background:var(--acc); color:#0b0d11; font-weight:600; }
</style>
</head>
<body>
<header><h1 data-i18n="app.title">语音助手模型代理管理</h1><div class="who-wrap"><span id="who" class="muted"></span><a class="sec" id="docsLink" data-i18n="common.docs" href="/docs" target="_blank" rel="noopener">文档</a><a class="sec" id="wsDocsLink" data-i18n="common.wsDocs" href="/docs/ws" target="_blank" rel="noopener">WS 文档</a><span class="lang-switch"><button class="ls" data-lang="zh-CN">中</button><button class="ls" data-lang="en">EN</button></span><button class="sec" id="logout" data-i18n="app.logout">退出登录</button></div></header>
<main id="app"></main>
<div id="panelLoading"><div class="loading-box"><span class="spinner"></span><span data-i18n="common.loading">请求中…</span></div></div>

<div class="modal-mask" id="testModal">
  <div class="modal">
    <h3 id="testModalTitle" data-i18n="modal.testTitle">模型测试</h3>
    <label data-i18n="common.protocol">协议</label>
    <select id="testModalProto"></select>
    <div class="hint" id="testModalProtoDesc" style="margin-top:4px"></div>
    <label data-i18n="common.authHint">鉴权（若推理接口开启了 API Key）</label>
    <input id="testModalAuthKey" type="password" data-i18n-ph="common.apiKeyOptional" placeholder="可选：API Key" />
    <div id="testModalExtra"></div>
    <label class="chk"><input type="checkbox" id="testModalStream" checked /> <span data-i18n="common.streaming">流式（SSE）</span></label>
    <div class="hint" style="margin-top:2px" data-i18n="common.streamingHint">开启后逐字返回；关闭则等待完整回复。</div>
    <label class="chk"><input type="checkbox" id="testModalThinkMode" /> <span data-i18n="common.thinkMode">思考模式（推理链）</span></label>
    <div class="hint" style="margin-top:2px" data-i18n="common.thinkOffHint">关闭：界面不显示「思考过程」，并经 X-Proxy-Think 头让代理下发厂商原生参数（如 ollama think=false）真正不推理；开启才显示推理过程。</div>
    <div class="hint" style="margin-top:10px" data-i18n="common.promptFixed">提示词（固定，不可编辑）</div>
    <pre class="m-prompt" id="testModalPrompt" style="margin-top:2px">请只回复 ok 两个字。</pre>
    <div id="testModalThinkWrap" hidden style="margin-top:10px">
      <div class="think-head"><span class="muted" data-i18n="common.thinking">思考过程</span><button class="mini" type="button" id="testModalThinkToggle" data-i18n="common.collapse">折叠</button></div>
      <pre id="testModalThink" class="think"></pre>
    </div>
    <div class="hint" style="margin-top:10px" data-i18n="common.reply">回复</div>
    <pre class="m-out" id="testModalOut" style="margin-top:2px" data-i18n="modal.replyPlaceholder">回复将在这里显示。</pre>
    <div class="hint" id="testModalStatus" style="margin-top:8px"></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px; gap:8px"><button id="testModalRun" data-i18n="common.test">测试</button><button class="sec" id="testModalClose" data-i18n="common.close">关闭</button></div>
  </div>
</div>

<div class="modal-mask" id="embedTestModal">
  <div class="modal">
    <h3 id="embedTestModalTitle">向量模型测试</h3>
    <label data-i18n="llm.embeddingText">待向量化文本</label>
    <textarea id="embedTestModalInput" rows="3">你好，世界</textarea>
    <label style="margin-top:10px" data-i18n="llm.expectDim">期望维度（可选）</label>
    <input id="embedTestModalDim" type="number" min="1" placeholder="如 768" style="width:160px" />
    <div class="hint" style="margin-top:10px" data-i18n="llm.embeddingResult">结果</div>
    <pre class="m-out" id="embedTestModalOut" style="margin-top:2px"></pre>
    <div class="hint" id="embedTestModalStatus" style="margin-top:8px"></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px; gap:8px"><button id="embedTestModalRun" data-i18n="common.test">测试</button><button class="sec" id="embedTestModalClose" data-i18n="common.close">关闭</button></div>
  </div>
</div>

<div class="modal-mask" id="accModal">
  <div class="modal">
    <h3 id="accModalTitle" data-i18n="modal.editTitle">编辑地址与密钥</h3>
    <label data-i18n="common.url">地址</label>
    <input id="accUrl" type="text" autocomplete="off" placeholder="https://..." />
    <label data-i18n="common.apiKey">API Key</label>
    <input id="accKey" type="password" autocomplete="off" data-i18n-ph="modal.keyClearHint" placeholder="（留空=清空）" />
    <div class="row" style="justify-content:flex-end;margin-top:16px; gap:8px">
      <button class="sec" id="accCancel" data-i18n="common.cancel">取消</button>
      <button id="accSave" data-i18n="common.save">保存</button>
    </div>
  </div>
</div>

<div class="modal-mask" id="provModal">
  <div class="modal">
    <h3 id="provModalTitle" data-i18n="cfg.provEditPrefix">编辑提供商</h3>
    <label data-i18n="cfg.provUrl">服务地址（固定）</label>
    <input id="provUrl" type="text" readonly title="${t('cfg.provUrlFixed')}" />
    <label data-i18n="common.apiKey">API Key</label>
    <input id="provKey" type="password" autocomplete="off" data-i18n-ph="common.blankKeep" placeholder="（留空=不修改）" />
    <div class="row" style="justify-content:flex-end;margin-top:16px; gap:8px">
      <button class="sec" id="provCancel" data-i18n="common.cancel">取消</button>
      <button id="provSave" data-i18n="common.save">保存</button>
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
  'zh-CN': {
    "app.logout": "退出登录",
    "app.title": "语音助手模型代理管理",
    "asr.builtinModel": "内置离线模型（无需外部服务）",
    "asr.builtinNote": "当前 ASR 固定使用内置模型，能否用取决于运行环境（点「测试可用」按需验证）；外部上游以后按具体厂商单独接入。",
    "asr.cannotRecord": "无法录音：",
    "asr.detectFailed": "检测失败",
    "asr.detecting": "正在真实加载内置模型并跑一次推理…",
    "asr.detectingTitle": "真实加载内置模型并跑一次推理",
    "asr.modelFile": "模型文件：model.int8.onnx + tokens.txt（~240MB，install-voice 下载至 models/sensevoice/）",
    "asr.noAudio": "未内嵌音频",
    "asr.ok": "内置可用：模型加载与推理均正常",
    "asr.outPlaceholder": "识别结果将显示在这里。",
    "asr.reasonDepMissing": "依赖缺失",
    "asr.reasonException": "检测异常",
    "asr.reasonInferFailed": "模型加载或推理失败",
    "asr.reasonModelMissing": "模型文件缺失",
    "asr.reasonNotWired": "检测能力未注入",
    "asr.recHint": "点录音可把上面的试听音频替换成你录的，识别也用替换后的；「还原」恢复内置样本。",
    "asr.recognize": "识别",
    "asr.recognizing": "识别中…",
    "asr.record": "录音",
    "asr.recording": "录音中…",
    "asr.replaced": "已替换试听音频（识别将用这段）",
    "asr.requestFailed": "内置不可用：请求失败 ",
    "asr.restore": "还原",
    "asr.reverted": "已还原内置样本",
    "asr.unavailPrefix": "内置不可用：",
    "body.fieldName": "字段名",
    "body.label": "自定义 body 参数（作为额外字段透传到上游；不保存，本次填写本次生效）",
    "builtin": "内置",
    "cfg.addModelPh": "输入模型名后点添加",
    "cfg.customApi": "DashScope",
    "cfg.customNotConfigured": "未配置服务地址（点此填写）",
    "cfg.provEditPrefix": "编辑提供商（",
    "cfg.provUrl": "服务地址（固定）",
    "cfg.provUrlFixed": "服务地址固定为官方入口 https://dashscope.aliyuncs.com（无需填写）；模型用「↻ 刷新」拉取后勾选。",
    "cfg.provUrlFixedShort": "官方入口",
    "cfg.provNeedKey": "已选择 DashScope：请先填写 API Key 并保存",
    "cfg.provNeedKeyShort": "未填写 API Key（点此填写）",
    "cfg.provUrlFixed": "服务地址固定为官方入口 https://dashscope.aliyuncs.com",
    "cfg.provUrlFixedShort": "官方入口",
    "cfg.provNeedKey": "已选择 DashScope：请先填写 API Key 并保存",
    "cfg.provNeedKeyShort": "未填写 API Key（点此填写）",
    "cfg.provIncomplete": "已选择上游：请先填写服务地址与模型，再保存",
    "common.blankKeep": "（留空=不修改）",
    "cfg.apiKeyAuth": "是否启用 API-Key 鉴权",
    "cfg.apiKeyList": "API Key 列表（一行一个；填 auto 自动生成）",
    "cfg.ipAllow": "IP 白名单（一行一个 IP 或 CIDR；留空=不限制）",
    "cfg.llmApiKey": "API Key（留空=不修改）",
    "cfg.llmEnabled": "LLM 启用（auto/on/off）",
    "cfg.llmModel": "模型名",
    "cfg.llmProtocol": "协议（openai/ollama/...）",
    "cfg.llmUpstreamUrl": "上游地址（OpenAI 兼容）",
    "cfg.llmVendor": "厂商（ollama/deepseek/...）",
    "llm.embedDefault": "向量默认",
    "cfg.ttsDedicatedKey": "TTS 专属 Key（留空用共享）",
    "cfg.ttsDedicatedUrl": "TTS 专属地址（留空用共享）",
    "cfg.ttsDefaultVoice": "默认音色",
    "cfg.ttsFallbackVoice": "TTS 兜底音色",
    "cfg.ttsModel": "TTS 模型名（可选）",
    "cfg.ttsUpstreamKey": "TTS 上游 Key（留空用共享）",
    "cfg.ttsUpstreamUrl": "TTS 上游地址（留空走内置 edge-tts）",
    "common.action": "操作",
    "common.add": "+ 添加",
    "common.apiKey": "API Key",
    "common.apiKeyOptional": "可选：API Key",
    "common.authHint": "鉴权（若推理接口开启了 API Key）",
    "common.available": "可用",
    "common.cancel": "取消",
    "common.close": "关闭",
    "common.collapse": "折叠",
    "common.default": "默认",
    "common.defaultParen": "（默认）",
    "common.delete": "删除",
    "common.deps": "依赖环境/API-KEY",
    "common.detecting": "检测中…",
    "common.done": "完成",
    "common.empty": "（空）",
    "common.emptyParen": "(空)",
    "common.errorPrefix": "错误：",
    "common.expand": "展开",
    "common.failPrefix": "失败：",
    "common.failed": "失败",
    "common.failedX": "失败 ",
    "common.loadFailed": "加载失败",
    "common.loadFailedX": "加载失败 ",
    "common.loading": "请求中…",
    "common.loadingX": "加载中…",
    "common.model": "模型",
    "common.notTested": "未测",
    "common.promptFixed": "提示词（固定，不可编辑）",
    "common.protocol": "协议",
    "common.provider": "提供商",
    "common.refreshing": "刷新中…",
    "common.reply": "回复",
    "common.save": "保存",
    "common.saved": "已保存",
    "common.saving": "保存中…",
    "common.status": "状态",
    "common.stop": "停止",
    "common.stopped": "已停止",
    "common.streaming": "流式（SSE）",
    "common.streamingHint": "开启后逐字返回；关闭则等待完整回复。",
    "common.syncedRemote": "（已同步远端）",
    "common.test": "测试",
    "common.testAvail": "测试可用",
    "common.testShort": "测",
    "common.text": "文本",
    "common.wsError": "WebSocket 连接失败（检查地址/端口/鉴权）",
    "common.wsMode": "（WS）",
    "common.docs": "文档",
    "common.wsDocs": "WS 文档",
    "common.thinkMode": "思考模式（推理链）",
    "common.thinkOffHint": "关闭：界面不显示「思考过程」，并经 X-Proxy-Think 头让代理下发厂商原生参数（如 ollama think=false）真正不推理；开启才显示推理过程。",
    "common.thinking": "思考过程",
    "common.unavailPrefix": "不可用：",
    "common.unavailReqFail": "不可用：请求失败 ",
    "common.unavailable": "不可用",
    "common.url": "地址",
    "common.value": "值",
    "common.voice": "音色",
    "config.blankNoChange": "（留空则不修改）",
    "config.embed": "向量模型",
    "config.security": "安全",
    "config.title": "配置",
    "hdr.label": "自定义请求头（仅 LLM 对话请求透传到上游；不保存，本次填写本次生效）",
    "hdr.name": "Header 名",
    "llm.defaultModel": "默认模型",
    "llm.defaultProvider": "默认供应商",
    "llm.defaultRoute": "（默认路由）",
    "llm.includeInProvider": "选入提供商",
    "llm.modelHint": "模型（先选提供商，再选该提供商下的模型）",
    "llm.pickProvider": "（请先选提供商）",
    "llm.mode": "模式",
    "llm.modeChat": "对话（chat/completions）",
    "llm.modeEmbed": "向量嵌入（embeddings）",
    "llm.embeddingText": "待嵌入文本（一行一条，可多行）",
    "llm.embedModelTabHint": "模型留空时，使用配置页设置的默认向量模型；指定后优先使用所选模型",
    "llm.apiChat": "将调用：POST /llm/v1/chat/completions",
    "llm.apiEmbed": "将调用：POST /llm/v1/embeddings",
    "llm.embeddingResult": "嵌入结果：",
    "llm.expectDim": "请求维度（可选）：部分模型支持自定义向量维度（如 OpenAI 3 系、Ollama），不填则用模型默认维度",
    "llm.dimMismatchShort": "维度不匹配",
    "llm.embeddingModel": "向量模型（LLM_EMBED_MODEL）",
    "config.embedHint": "向量模型与对话共用同一上游（Ollama / 自定义地址），只需选择用哪个模型做嵌入，无需单独配置地址与密钥。",
    "llm.pickModelFirst": "请先在上方选择一个向量模型",
    "llm.protoDescSuffix": "；是否流式由下方「流式」勾选框单独控制，与协议无关。",
    "llm.refreshModels": "刷新该提供商的模型列表",
    "llm.testAvail": "测可用性",
    "llm.testPrefix": "模型测试：",
    "llm.useUpstreamDefault": "（沿用上游默认）",
    "log.last200": "最近 200 行",
    "log.refresh": "刷新日志",
    "log.title": "日志（voice.log）",
    "login.account": "账号",
    "login.accountPrefix": "账号：",
    "login.failed": "登录失败",
    "login.login": "登录",
    "login.password": "密码",
    "login.badCreds": "账号或密码错误",
    "login.emptyCreds": "请输入账号和密码",
    "modal.editPrefix": "编辑：",
    "modal.editTitle": "编辑地址与密钥",
    "modal.keyClearHint": "（留空=清空）",
    "modal.replyPlaceholder": "回复将在这里显示。",
    "modal.testTitle": "模型测试",
    "proto.anthropic": "Anthropic Messages（/v1/messages，请求与流式响应双向翻译）",
    "proto.azure": "Azure OpenAI（路径带 /openai/deployments/{model}，需 api-version）",
    "proto.gemini": "Google Gemini（generateContent / streamGenerateContent，alt=sse）",
    "proto.openaiChat": "OpenAI Chat Completions 线协议（/v1/chat/completions，deepseek / 通义等大多兼容）",
    "proto.openaiResponses": "OpenAI Responses API（/v1/responses）",
    "sec.ipHint": "一行一个 IP 或 CIDR（如 192.168.1.0/24）。留空=不限制来源",
    "sec.keyHint": "一行一个 Key；或填 auto 自动生成并写入文件。留空则不修改",
    "sec.offDefault": "关闭（默认）",
    "sec.on": "开启",
    "sec.onHint": "开启后 /llm 与 /voice 数据接口须持有效 Key；/health 与管理面板不受影响",
    "test.replyStream": "回复将在这里流式显示。",
    "test.builtin": "内置",
    "test.protoHint": "协议从模型的协议字段总结出来，为必填条件，选中后筛选模型。选 http 走 /voice/v1 HTTP 接口；选 ws 走 /voice/ws/inference（实时 WebSocket，上游同为 ws 协议）。",
    "test.protoRecPrefix": "当前协议：",
    "test.protoNoModel": "未选模型时使用提供商默认模型。",
    "test.protoAsyncWarn": "（http-async 为录音文件异步转写，实时接口暂不支持）",
    "test.modelFollowConfig": "（不选，使用提供商默认模型）",
    "test.send": "发送",
    "test.tabAsr": "语音识别 ASR",
    "test.tabLlm": "对话 LLM",
    "test.tabEmbed": "向量嵌入 Embed",
    "test.tabTts": "语音合成 TTS",
    "tts.builtinNote": "当前 TTS 固定走内置 edge-tts，能否用取决于运行环境（点「测试可用」按需验证）；外部上游以后按具体厂商单独接入。",
    "tts.builtinSynth": "内置合成（edge-tts 在线）",
    "tts.ffmpeg": "ffmpeg：wav 输出需安装（install-voice）",
    "tts.needNetwork": "需联网，无需本地模型",
    "tts.ok": "可用：合成成功",
    "tts.synthTitle": "真实合成一句验证内置 TTS 是否可用",
    "tts.synthcing": "正在按配置合成一句…",
    "tts.synthcingX": "合成中…",
    "tts.synthesize": "合成",
    "tts.voiceNote": "音色说明：",
    "tts.voiceParam": "　·　参数：音色语言须与文本一致（含方言：台湾腔/粤语配对应文本），否则上游 502",
    "vendor.custom": "自定义",
  },
  'en': {
    "app.logout": "Log out",
    "app.title": "Voice Assistant Model Proxy Admin",
    "asr.builtinModel": "Built-in offline model (no external service)",
    "asr.builtinNote": "ASR is fixed to the built-in model; whether it works depends on the runtime (click \"Test availability\" to verify on demand); external upstreams will be added per vendor later.",
    "asr.cannotRecord": "Cannot record: ",
    "asr.detectFailed": "detection failed",
    "asr.detecting": "Loading the built-in model and running one inference…",
    "asr.detectingTitle": "Load the built-in model and run one inference",
    "asr.modelFile": "Model files: model.int8.onnx + tokens.txt (~240MB, install-voice downloads to models/sensevoice/)",
    "asr.noAudio": "No embedded audio",
    "asr.ok": "Built-in OK: model loads and infers normally",
    "asr.outPlaceholder": "Recognition result will appear here.",
    "asr.reasonDepMissing": "Dependency missing",
    "asr.reasonException": "Detection exception",
    "asr.reasonInferFailed": "Model load or inference failed",
    "asr.reasonModelMissing": "Model file missing",
    "asr.reasonNotWired": "Detection capability not injected",
    "asr.recHint": "Tap record to replace the sample audio with yours; recognition uses the replaced clip; \"Restore\" reverts to the built-in sample.",
    "asr.recognize": "Recognize",
    "asr.recognizing": "Recognizing…",
    "asr.record": "Record",
    "asr.recording": "Recording…",
    "asr.replaced": "Sample audio replaced (recognition will use this clip)",
    "asr.requestFailed": "Built-in unavailable: request failed ",
    "asr.restore": "Restore",
    "asr.reverted": "Reverted to built-in sample",
    "asr.unavailPrefix": "Built-in unavailable: ",
    "body.fieldName": "Field name",
    "body.label": "Custom body params (forwarded to upstream as extra fields; not saved, applies to this session)",
    "builtin": "Built-in",
    "cfg.addModelPh": "Type a model name, then Add",
    "cfg.customApi": "DashScope",
    "cfg.customNotConfigured": "No base URL configured (click to edit)",
    "cfg.provEditPrefix": "Edit provider (",
    "cfg.provUrl": "Base URL (fixed)",
    "cfg.provUrlFixed": "Base URL is fixed to the official endpoint https://dashscope.aliyuncs.com (no need to fill); use ↻ Refresh to fetch models.",
    "cfg.provUrlFixedShort": "official endpoint",
    "cfg.provNeedKey": "DashScope selected: fill in the API Key and save first",
    "cfg.provNeedKeyShort": "API Key missing (click to fill)",
    "cfg.provIncomplete": "Upstream selected: fill in the base URL and model before saving",
    "common.blankKeep": "(blank = keep current)",
    "cfg.apiKeyAuth": "Enable API-Key auth",
    "cfg.apiKeyList": "API Key list (one per line; fill \"auto\" to auto-generate)",
    "cfg.ipAllow": "IP allowlist (one IP or CIDR per line; blank = no restriction)",
    "cfg.llmApiKey": "API Key (blank = no change)",
    "cfg.llmEnabled": "LLM enabled (auto/on/off)",
    "cfg.llmModel": "Model name",
    "cfg.llmProtocol": "Protocol (openai/ollama/...)",
    "cfg.llmUpstreamUrl": "Upstream URL (OpenAI-compatible)",
    "cfg.llmVendor": "Vendor (ollama/deepseek/...)",
    "llm.embedDefault": "Embed default",
    "cfg.ttsDedicatedKey": "TTS dedicated Key (blank = shared)",
    "cfg.ttsDedicatedUrl": "TTS dedicated URL (blank = shared)",
    "cfg.ttsDefaultVoice": "Default voice",
    "cfg.ttsFallbackVoice": "TTS fallback voice",
    "cfg.ttsModel": "TTS model name (optional)",
    "cfg.ttsUpstreamKey": "TTS upstream Key (blank = shared)",
    "cfg.ttsUpstreamUrl": "TTS upstream URL (blank = built-in edge-tts)",
    "common.action": "Action",
    "common.add": "+ Add",
    "common.apiKey": "API Key",
    "common.apiKeyOptional": "Optional: API Key",
    "common.authHint": "Auth (if the inference API requires an API Key)",
    "common.available": "Available",
    "common.cancel": "Cancel",
    "common.close": "Close",
    "common.collapse": "Collapse",
    "common.default": "Default",
    "common.defaultParen": "(default)",
    "common.delete": "Delete",
    "common.deps": "Dependencies/API-Key",
    "common.detecting": "Detecting…",
    "common.done": "Done",
    "common.empty": "(empty)",
    "common.emptyParen": "(empty)",
    "common.errorPrefix": "Error: ",
    "common.expand": "Expand",
    "common.failPrefix": "Failed: ",
    "common.failed": "Failed",
    "common.failedX": "Failed ",
    "common.loadFailed": "Load failed",
    "common.loadFailedX": "Load failed ",
    "common.loading": "Loading…",
    "common.loadingX": "Loading…",
    "common.model": "Model",
    "common.notTested": "Not tested",
    "common.promptFixed": "Prompt (fixed, not editable)",
    "common.protocol": "Protocol",
    "common.provider": "Provider",
    "common.refreshing": "Refreshing…",
    "common.reply": "Reply",
    "common.save": "Save",
    "common.saved": "Saved",
    "common.saving": "Saving…",
    "common.status": "Status",
    "common.stop": "Stop",
    "common.stopped": "Stopped",
    "common.streaming": "Streaming (SSE)",
    "common.streamingHint": "On: tokens stream in; off: wait for the full reply.",
    "common.syncedRemote": "(synced to remote)",
    "common.test": "Test",
    "common.testAvail": "Test availability",
    "common.testShort": "Test",
    "common.text": "Text",
    "common.wsError": "WebSocket connection failed (check address/port/auth)",
    "common.wsMode": "(WS)",
    "common.docs": "Docs",
    "common.wsDocs": "WS Docs",
    "common.thinkMode": "Thinking mode (reasoning chain)",
    "common.thinkOffHint": "Off: the \"thinking\" box is hidden and the proxy sends vendor-native params via the X-Proxy-Think header (e.g. ollama think=false) to truly disable reasoning; on: the reasoning is shown.",
    "common.thinking": "Thinking",
    "common.unavailPrefix": "Unavailable: ",
    "common.unavailReqFail": "Unavailable: request failed ",
    "common.unavailable": "Unavailable",
    "common.url": "URL",
    "common.value": "Value",
    "common.voice": "Voice",
    "config.blankNoChange": "(blank = no change)",
    "config.embed": "Embeddings",
    "config.security": "Security",
    "config.title": "Config",
    "hdr.label": "Custom request headers (forwarded to upstream only for LLM chat; not saved, applies to this session)",
    "hdr.name": "Header name",
    "llm.defaultModel": "Default model",
    "llm.defaultProvider": "Default provider",
    "llm.defaultRoute": "(default route)",
    "llm.includeInProvider": "Include in provider",
    "llm.modelHint": "Model (pick a provider first, then a model under it)",
    "llm.pickProvider": "(pick a provider first)",
    "llm.mode": "Mode",
    "llm.modeChat": "Chat (chat/completions)",
    "llm.modeEmbed": "Embeddings",
    "llm.embeddingText": "Text to embed (one per line, multiple lines allowed)",
    "llm.embedModelTabHint": "Model blank = use the default embedding model set on the config page; otherwise the selected model takes priority",
    "llm.apiChat": "Will call: POST /llm/v1/chat/completions",
    "llm.apiEmbed": "Will call: POST /llm/v1/embeddings",
    "llm.embeddingResult": "Embedding result: ",
    "llm.expectDim": "Requested dimension (optional): some models support a custom vector dimension (e.g. OpenAI 3-series, Ollama); leave blank to use the model default",
    "llm.dimMismatchShort": "dimension mismatch",
    "llm.embeddingModel": "Embedding model (LLM_EMBED_MODEL)",
    "config.embedHint": "Embeddings share the same upstream as chat (Ollama / custom address). Just pick which model to embed with; no separate address/key config needed.",
    "llm.pickModelFirst": "Please select an embedding model above first",
    "llm.protoDescSuffix": "; streaming is controlled separately by the \"Streaming\" checkbox below and is independent of the protocol.",
    "llm.refreshModels": "Refresh this provider's model list",
    "llm.testAvail": "Test availability",
    "llm.testPrefix": "Model Test: ",
    "llm.useUpstreamDefault": "(use upstream default)",
    "log.last200": "Last 200 lines",
    "log.refresh": "Refresh logs",
    "log.title": "Logs (voice.log)",
    "login.account": "Account",
    "login.accountPrefix": "Account: ",
    "login.failed": "Login failed",
    "login.login": "Login",
    "login.password": "Password",
    "login.badCreds": "Incorrect account or password",
    "login.emptyCreds": "Please enter your account and password",
    "modal.editPrefix": "Edit: ",
    "modal.editTitle": "Edit URL & Key",
    "modal.keyClearHint": "(leave blank to clear)",
    "modal.replyPlaceholder": "Reply will appear here.",
    "modal.testTitle": "Model Test",
    "proto.anthropic": "Anthropic Messages (/v1/messages, request and streamed response are bidirectionally translated)",
    "proto.azure": "Azure OpenAI (path includes /openai/deployments/{model}, requires api-version)",
    "proto.gemini": "Google Gemini (generateContent / streamGenerateContent, alt=sse)",
    "proto.openaiChat": "OpenAI Chat Completions wire protocol (/v1/chat/completions, compatible with deepseek / Qwen etc.)",
    "proto.openaiResponses": "OpenAI Responses API (/v1/responses)",
    "sec.ipHint": "One IP or CIDR per line (e.g. 192.168.1.0/24). Blank = no source restriction",
    "sec.keyHint": "One Key per line; or fill \"auto\" to auto-generate and write to file. Blank = no change",
    "sec.offDefault": "Off (default)",
    "sec.on": "On",
    "sec.onHint": "On: /llm and /voice data APIs require a valid Key; /health and the admin panel are unaffected",
    "test.replyStream": "Reply will stream here.",
    "test.builtin": "Built-in",
    "test.protoHint": "Protocols are summarized from the models' protocol fields; required, and selecting one filters the model list. http hits the /voice/v1 HTTP API; ws hits /voice/ws/inference (realtime WebSocket, with a ws upstream of the same protocol).",
    "test.protoRecPrefix": "Protocol: ",
    "test.protoNoModel": "With no model selected the provider's default model is used.",
    "test.protoAsyncWarn": "(http-async is async file transcription; not supported by the realtime API yet)",
    "test.modelFollowConfig": "(Not selected — use provider's default model)",
    "test.send": "Send",
    "test.tabAsr": "Speech Recognition ASR",
    "test.tabLlm": "Chat LLM",
    "test.tabEmbed": "Embeddings",
    "test.tabTts": "Speech Synthesis TTS",
    "tts.builtinNote": "TTS is fixed to built-in edge-tts; whether it works depends on the runtime (click \"Test availability\" to verify on demand); external upstreams will be added per vendor later.",
    "tts.builtinSynth": "Built-in synthesis (edge-tts online)",
    "tts.ffmpeg": "ffmpeg: needed for wav output (install-voice)",
    "tts.needNetwork": "Internet required; no local model",
    "tts.ok": "Available: synthesis succeeded",
    "tts.synthTitle": "Synthesize one sentence to verify built-in TTS",
    "tts.synthcing": "Synthesizing one sentence per config…",
    "tts.synthcingX": "Synthesizing…",
    "tts.synthesize": "Synthesize",
    "tts.voiceNote": "Voice note: ",
    "tts.voiceParam": " · Params: voice language must match the text (incl. dialects: Taiwanese/Cantonese need matching text), otherwise upstream returns 502",
    "vendor.custom": "Custom",
  }
};
let curLang = localStorage.getItem('admin_lang') || 'zh-CN';
const t = (zh) => (I18N[curLang] && I18N[curLang][zh]) || zh;
// 仅翻译「自定义」供应商的展示文案；底层存储值 '自定义' 保持不变，避免破坏配置落盘
function vendorLabel(v){ return v==='自定义' ? t('vendor.custom') : v; }
// 服务端返回的中文错误文案按当前语言转译（已知项），未知项原样显示
const SERVER_MSG = { '账号或密码错误':'login.badCreds', '请输入账号和密码':'login.emptyCreds' };
// 把后端 detail（可能是字符串 / 对象数组 / 对象）渲染成可读文案，杜绝 [object Object]
function fmtErr(detail){
  let msg;
  if(!detail) msg = t('login.failed');
  else if(typeof detail === 'string') msg = detail;
  else if(Array.isArray(detail)) msg = detail.map(x=> x && x.msg ? x.msg : (typeof x==='string'?x:'')).filter(Boolean).join('；') || t('login.failed');
  else if(typeof detail === 'object') msg = detail.msg || t('login.failed');
  else msg = String(detail);
  if(SERVER_MSG[msg]) msg = t(SERVER_MSG[msg]);
  return msg;
}
function applyStaticI18n(){
  document.querySelectorAll('[data-i18n]').forEach(e=>{ e.textContent = t(e.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(e=>{ e.placeholder = t(e.getAttribute('data-i18n-ph')); });
}
function rerenderActiveView(){
  const app=document.getElementById('app');
  if(!app || !app.children.length) return;
  // 登录卡片与控制台用同一套 t() 渲染，按当前实际展示的视图重建即可刷新文案
  if(document.getElementById('login')) renderLogin();
  else renderDashboard();
}
function setLang(l){
  curLang = (l==='en') ? 'en' : 'zh-CN';
  localStorage.setItem('admin_lang', curLang);
  document.documentElement.lang = curLang;
  document.querySelectorAll('.lang-switch .ls').forEach(b=> b.classList.toggle('active', b.dataset.lang===curLang));
  applyStaticI18n();
  rerenderActiveView();
}
document.documentElement.lang = curLang;
document.querySelectorAll('.lang-switch .ls').forEach(b=>{
  b.classList.toggle('active', b.dataset.lang===curLang);
  b.addEventListener('click', ()=> setLang(b.dataset.lang));
});
applyStaticI18n();

// 文档入口：强制新标签打开，避免覆盖当前管理页（部分浏览器/内嵌场景对 target=_blank 处理不稳）
const docsLink = document.getElementById('docsLink');
if (docsLink) docsLink.addEventListener('click', (e)=>{ e.preventDefault(); window.open('/docs', '_blank', 'noopener'); });
const wsDocsLink = document.getElementById('wsDocsLink');
if (wsDocsLink) wsDocsLink.addEventListener('click', (e)=>{ e.preventDefault(); window.open('/docs/ws', '_blank', 'noopener'); });

async function boot(){
  const me = await api('/admin/api/me').then(r=>r.ok?r.json():null);
  if(!me || !me.authenticated){ renderLogin(); document.getElementById('logout').style.display='none'; }
  else { document.getElementById('who').textContent = t('login.accountPrefix')+me.user; document.getElementById('logout').style.display=''; renderDashboard(); }
}

function renderLogin(){
  const app=document.getElementById('app');
  // 切换语言会重建登录卡片，保留已输入的账号/密码，避免清空后空提交触发校验错误
  const prevU = app.querySelector('#u') ? app.querySelector('#u').value : '';
  const prevP = app.querySelector('#p') ? app.querySelector('#p').value : '';
  app.innerHTML = '';
  const card = el(`<div class="card" id="login">
    <h2>${t('login.login')}</h2>
    <label>${t('login.account')}</label><input type="text" id="u" autocomplete="username" />
    <label>${t('login.password')}</label><input type="password" id="p" autocomplete="current-password" />
    <div class="err" id="e"></div>
    <div class="row" style="margin-top:12px; justify-content:center"><button id="go">${t('login.login')}</button></div>
  </div>`);
  card.querySelector('#u').value = prevU;
  card.querySelector('#p').value = prevP;
  app.appendChild(card);
  const submit = async ()=>{
    const r = await api('/admin/login', {method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:`user=${encodeURIComponent(document.getElementById('u').value)}&password=${encodeURIComponent(document.getElementById('p').value)}`});
    if(r.ok){ boot(); }
    else { document.getElementById('e').textContent = fmtErr((await r.json()).detail); }
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
  LLM_ENABLED:'cfg.llmEnabled', LLM_UPSTREAM_BASE_URL:'cfg.llmUpstreamUrl', LLM_UPSTREAM_API_KEY:'cfg.llmApiKey',
  LLM_UPSTREAM_MODEL:'cfg.llmModel', LLM_UPSTREAM_PROTOCOL:'cfg.llmProtocol', LLM_UPSTREAM_VENDOR:'cfg.llmVendor',
  VOICE_UPSTREAM_BASE_URL:'cfg.ttsUpstreamUrl', VOICE_UPSTREAM_API_KEY:'cfg.ttsUpstreamKey',
  TTS_UPSTREAM_VOICE:'cfg.ttsDefaultVoice', TTS_UPSTREAM_MODEL:'cfg.ttsModel', TTS_UPSTREAM_BASE_URL:'cfg.ttsDedicatedUrl',
  TTS_UPSTREAM_API_KEY:'cfg.ttsDedicatedKey', TTS_VOICE:'cfg.ttsFallbackVoice',
  VOICE_API_KEY_AUTH:'cfg.apiKeyAuth', VOICE_API_KEY:'cfg.apiKeyList',
  VOICE_IP_ALLOW:'cfg.ipAllow',
};
const isSecret = k => /API_KEY|PASSWORD|SECRET|DSN|_POOL$/i.test(k);
let cfgOrig = {};

function buildConfigCard(){
  const fields = (id,keys)=> keys.map(k=>{
    if(k==='LLM_ENABLED') return `<label>${t(CFG_LABEL[k]||k)}</label><select id="cfg_${k}"><option value="auto">auto</option><option value="on">on</option><option value="off">off</option></select>`;
    const secret = isSecret(k);
    return `<label>${t(CFG_LABEL[k]||k)}</label><input id="cfg_${k}"${secret?` type="password" placeholder="${t('config.blankNoChange')}"`:''} />`;
  }).join('') + `<div class="row" style="margin-top:12px"><button id="cfgSave_${id}">${t('common.save')}</button><span class="hint" id="cfgStat_${id}" style="margin-left:10px"></span></div>`;
  return el(`<div class="card collapsed" id="cfgCard"><h2>${t('config.title')}</h2>
    <div class="tabs" id="cfgTabs">
      <button class="tab active" data-ctab="llm">LLM</button>
      <button class="tab" data-ctab="embed">${t('config.embed')}</button>
      <button class="tab" data-ctab="asr">ASR</button>
      <button class="tab" data-ctab="tts">TTS</button>
      <button class="tab" data-ctab="sec">${t('config.security')}</button>
    </div>
    <div id="c-llm" class="cfgpane"><div id="llmTableWrap" class="hint">${t('common.loadingX')}</div>
      <div class="row" style="margin-top:12px"><button id="cfgSave_llm">${t('common.save')}</button><span class="hint" id="cfgStat_llm" style="margin-left:10px"></span></div></div>
    <div id="c-asr" class="cfgpane" hidden>
      <div id="asrTableWrap" class="hint">${t('common.loadingX')}</div>
      <div class="row" style="margin-top:12px"><button id="cfgSave_asr">${t('common.save')}</button><span class="hint" id="cfgStat_asr" style="margin-left:10px"></span></div>
    </div>
    <div id="c-tts" class="cfgpane" hidden>
      <div id="ttsTableWrap" class="hint">${t('common.loadingX')}</div>
      <div class="row" style="margin-top:12px"><button id="cfgSave_tts">${t('common.save')}</button><span class="hint" id="cfgStat_tts" style="margin-left:10px"></span></div>
    </div>
    <div id="c-sec" class="cfgpane" hidden><div id="secWrap"></div><div class="row" style="margin-top:12px"><button id="cfgSave_sec">${t('common.save')}</button><span class="hint" id="cfgStat_sec" style="margin-left:10px"></span></div></div>
    <div id="c-embed" class="cfgpane" hidden>
      <div id="embedTableWrap" class="hint">${t('common.loadingX')}</div>
      <div class="row" style="margin-top:12px"><button id="cfgSave_embed">${t('common.save')}</button><span class="hint" id="cfgStat_embed" style="margin-left:10px"></span></div>
    </div>
  </div>`);
}

async function loadConfig(){
  try{
    const r = await fetch('/admin/api/config',{credentials:'same-origin'});
    if(!r.ok) return;
    cfgOrig = await r.json();
    ['llm','asr','tts'].forEach(t=>CFG_TABS[t].forEach(k=>{ const inp=document.getElementById('cfg_'+k); if(inp) inp.value = isSecret(k)?'':(cfgOrig[k]||''); }));
    // 向量默认模型（embeddings 测试兜底；向后兼容旧的 LLM_EMBED_MODEL）
    embedDefModel = (cfgOrig.EMBED_UPSTREAM_MODEL || cfgOrig.LLM_EMBED_MODEL || '').trim();
    // ASR/TTS 提供商状态回填：provider、上游地址/模型/模型列表（Key 不回显，留空=不修改）
    asrProvider = cfgOrig.STT_PROVIDER === 'dashscope' ? 'custom' : 'builtin';
    ttsProvider = cfgOrig.TTS_PROVIDER === 'dashscope' ? 'custom' : 'builtin';
    const parseModels = (v) => { try { const a = JSON.parse(v||'[]'); return Array.isArray(a) ? a.filter(x=>typeof x==='string') : []; } catch { return []; } };
    provEdit.stt.model = cfgOrig.STT_UPSTREAM_MODEL || '';
    provEdit.stt.cands = parseModels(cfgOrig.STT_UPSTREAM_MODELS);
    provEdit.stt.sel = new Set(provEdit.stt.cands);
    provEdit.stt.def = cfgOrig.STT_UPSTREAM_MODEL || provEdit.stt.cands[0] || '';
    provEdit.tts.model = cfgOrig.TTS_UPSTREAM_MODEL || '';
    provEdit.tts.cands = parseModels(cfgOrig.TTS_UPSTREAM_MODELS);
    provEdit.tts.sel = new Set(provEdit.tts.cands);
    provEdit.tts.def = cfgOrig.TTS_UPSTREAM_MODEL || provEdit.tts.cands[0] || '';
    await renderLlmTable();
    await renderEmbedTable();
    paintAsrTable();
    paintTtsTable();
    renderSecTable();
    // 勾选模型可能刚回填，刷新底部测试页的模型/协议联动
    if(window.refreshVoiceTestSelects) window.refreshVoiceTestSelects();
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
      ['llm','asr','tts','embed','sec'].forEach(p=>{ const e=document.getElementById('c-'+p); if(e) e.hidden=(t.dataset.ctab!==p); }); };
  });
  const postConfig = async (patch, statId)=>{
    const stat=document.getElementById(statId); stat.className='hint'; stat.textContent=t('common.saving');
    try{
      const r=await fetch('/admin/api/config',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){ stat.className='err'; stat.textContent=t('common.failPrefix')+(d.detail||r.status); return; }
      stat.className='hint'; stat.textContent=t('common.saved')+(d.remote_push&&d.remote_push.ok?t('common.syncedRemote'):'');
      loadConfig();
    }catch(e){ stat.className='err'; stat.textContent=t('common.errorPrefix')+e.message; }
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
  // 向量模型（embeddings）配置：与 LLM 结构完全一致（同一套 provider/地址/Key/模型字段），
  // 但数据独立存储（EMBED_UPSTREAM_POOL / EMBED_UPSTREAM_MODEL），互不干扰、不会同步覆盖。
  // 调用时（embeddings 路由）只取「向量默认」指向的模型，不走对方（LLM）的地址池。
  const eb=document.getElementById('cfgSave_embed'); if(eb) eb.onclick=()=> savePoolTable('embed','cfgStat_embed');
  const lb=document.getElementById('cfgSave_llm'); if(lb) lb.onclick=()=>saveLlmTable();
  const ab=document.getElementById('cfgSave_asr'); if(ab) ab.onclick=saveSttTable;
  const tb=document.getElementById('cfgSave_tts'); if(tb) tb.onclick=saveTtsTable;
}

// ── 上游池表格（按提供商分组；列：默认 | 提供商 | 地址 | API Key | 模型）──
// LLM 与 向量 各用各的池：结构完全一致（同一套 vendor/model/base_url/api_key/protocol），
// 但数据独立存储（LLM_UPSTREAM_POOL vs EMBED_UPSTREAM_POOL），互不影响、不会同步覆盖。
let llmGroups = [];        // LLM 池（cap=LLM）
let llmDefVendor = '';     // LLM 全局默认供应商（LLM_UPSTREAM_VENDOR）
let llmDefModel = '';      // LLM 全局默认模型（LLM_UPSTREAM_MODEL，对话用）
let embedGroups = [];      // 向量池（cap=EMBED），独立数据
let embedDefVendor = '';   // 向量默认供应商（EMBED_UPSTREAM_VENDOR）
let embedDefModel = '';    // 向量默认模型（EMBED_UPSTREAM_MODEL，embeddings 用，独立）
// 5 个线协议（与 llm_protocols.WIRE_PROTOCOLS 对齐）
const LLM_PROTOCOLS = [
  'openai_chat_completions', 'azure_openai_chat_completions',
  'openai_responses', 'anthropic_messages', 'gemini'
];

// 每个 prefix 一套完全独立的上游池：结构（vendor/model/base_url/api_key/protocol）与 LLM 一致，
// 但数据各自存储（LLM_UPSTREAM_POOL vs EMBED_UPSTREAM_POOL），互不干扰、不会同步覆盖。
// 调用方（embeddings 路由 / 测试）按 cap 取自己的池，不走对方的地址池。
function poolConf(prefix){
  if(prefix==='embed') return {
    cap:'EMBED', wrapId:'embedTableWrap',
    groups:()=>embedGroups, setGroups:(g)=>{ embedGroups=g; },
    defVendor:()=>embedDefVendor, setDefVendor:(v)=>{ embedDefVendor=v; },
    defModel:()=>embedDefModel, setDefModel:(v)=>{ embedDefModel=v; },
    poolKey:'EMBED_UPSTREAM_POOL', defVendorKey:'EMBED_UPSTREAM_VENDOR', defModelKey:'EMBED_UPSTREAM_MODEL',
    endpoint:'/admin/api/embed-pool'
  };
  return {
    cap:'LLM', wrapId:'llmTableWrap',
    groups:()=>llmGroups, setGroups:(g)=>{ llmGroups=g; },
    defVendor:()=>llmDefVendor, setDefVendor:(v)=>{ llmDefVendor=v; },
    defModel:()=>llmDefModel, setDefModel:(v)=>{ llmDefModel=v; },
    poolKey:'LLM_UPSTREAM_POOL', defVendorKey:'LLM_UPSTREAM_VENDOR', defModelKey:'LLM_UPSTREAM_MODEL',
    endpoint:'/admin/api/llm-pool'
  };
}

// 从提供商首个账号（含编辑后的值）拉取真实模型列表，供「刷新模型」用
async function probeProviderModels(gi, prefix){
  const S=poolConf(prefix); const g=S.groups()[gi]; const a=g.accounts[0];
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
// prefix 用于区分 LLM 表与「向量模型」表（各自独立上游池，两套 radio 名避免冲突）
function buildModelPick(gi, prefix){
  prefix = prefix||'lp';
  const S=poolConf(prefix); const g=S.groups()[gi];
  if(!g._cands) g._cands=[...g.models];
  if(!g._sel)   g._sel=new Set(g.models);
  if(!g._avail) g._avail={};   // 各模型最近一次测试结果：'ok' / 'err'
  if(g._def===undefined) g._def = (g.vendor===S.defVendor() && S.defModel() && g.models.includes(S.defModel())) ? S.defModel() : (g.models[0]||'');
  const isEmbed = prefix==='embed';
  const defModel = S.defModel() || (prefix==='lp' ? g._def : '');
  let html='<div class="model-pick">';
  // 默认列：LLM 表 = 对话默认；向量表 = 向量默认，统一叫「默认」（用户要求去掉「向量」前缀）。
  html+='<table class="model-sub"><thead><tr><th></th><th>'+t('common.model')+'</th><th>'+t('common.default')+'</th><th>'+t('common.action')+'</th><th>'+t('common.status')+'</th></tr></thead><tbody>';
  g._cands.forEach(m=>{
    const checked=g._sel.has(m)?'checked':'';
    const isDef=defModel===m?'checked':'';
    const av=g._avail[m];
    const badge = av==='ok' ? '<span class="b-ok">'+t('common.available')+'</span>'
                : av==='err' ? '<span class="b-err">'+t('common.unavailable')+'</span>'
                : '<span class="b-mut">'+t('common.notTested')+'</span>';
    html+=`<tr>`
      +`<td><input type="checkbox" class="lp-model" data-g="${gi}" data-m="${escapeAttr(m)}" title="${t('llm.includeInProvider')}" ${checked}/></td>`
      +`<td class="mm" title="${escapeAttr(m)}">${escapeHtml(m)}</td>`
      +`<td><input type="radio" name="${prefix}Def_${gi}" value="${escapeAttr(m)}" title="${t('llm.defaultModel')}" ${isDef}/></td>`
      +`<td><button class="mini" data-test="${gi}" data-m="${escapeAttr(m)}" title="${t('llm.testAvail')}">${t('common.testShort')}</button></td>`
      +`<td class="avail-cell">${badge}</td>`
      +`</tr>`;
  });
  html+='</tbody></table></div>';
  return html;
}

function refreshModelCell(gi){
  const lc=document.querySelector(`#llmTableWrap .lp-modelcell[data-g="${gi}"]`);
  if(lc){ lc.innerHTML=buildModelPick(gi,'lp'); bindModelCell(gi,'lp'); }
  const ec=document.querySelector(`#embedTableWrap .lp-modelcell[data-g="${gi}"]`);
  if(ec){ ec.innerHTML=buildModelPick(gi,'embed'); bindModelCell(gi,'embed'); }
}

function bindModelCell(gi, prefix){
  prefix = prefix||'lp';
  const S=poolConf(prefix);
  const cell=document.querySelector(`#${S.wrapId} .lp-modelcell[data-g="${gi}"]`);
  if(!cell) return;
  // 多选切换：勾选哪些模型进入提供商；取消勾选时若该模型恰是默认，则清空默认并取消其默认单选
  cell.querySelectorAll('.lp-model').forEach(cb=> cb.onchange=()=>{
    const g=S.groups()[gi], m=cb.dataset.m;
    if(cb.checked) g._sel.add(m);
    else {
      g._sel.delete(m);
      const isDef = S.defModel()===m || (prefix==='lp' && g._def===m);
      if(isDef){ S.setDefModel(''); if(prefix==='lp'){ g._def=''; } cell.querySelectorAll(`input[name="${prefix}Def_${gi}"]`).forEach(r=>{ if(r.value===m) r.checked=false; }); }
    }
  });
  // 默认模型单选：设为默认时必须同时勾选（默认模型必须是选中的），并同步勾选框。
  // LLM 表→对话默认（llmDefModel）；向量表→向量默认（embedDefModel），两者相互独立。
  cell.querySelectorAll(`input[name="${prefix}Def_${gi}"]`).forEach(r=> r.onchange=()=>{
    if(r.checked){
      const g=S.groups()[gi];
      g._sel.add(r.value);
      const cb=r.closest('tr') && r.closest('tr').querySelector('.lp-model');
      if(cb) cb.checked=true;
      S.setDefModel(r.value);
      if(prefix!=='embed'){ g._def=r.value; }
    }
  });
  // 逐模型可用性测试：LLM 表→对话测试弹窗；向量表→向量（embeddings）测试弹窗
  cell.querySelectorAll('[data-test]').forEach(b=> b.onclick=()=>{
    const g=S.groups()[gi], m=b.dataset.m;
    if(!g._sel.has(m)) g._sel.add(m);  // 测试即视为选中该模型
    if(prefix==='embed') openEmbedTestModal(gi, m); else openTestModal(gi, m);
  });
}

// 模型测试弹窗：打开后不自动测试，由「测试」按钮触发
const TEST_PROMPT = '请只回复 ok 两个字。';   // 测试用的固定提示词（不可编辑）
// 线协议中文说明：底部测试卡片与配置里的模型测试弹窗共用一份
const PROTOCOL_DESC = {
  'openai_chat_completions': 'proto.openaiChat',
  'azure_openai_chat_completions': 'proto.azure',
  'openai_responses': 'proto.openaiResponses',
  'anthropic_messages': 'proto.anthropic',
  'gemini': 'proto.gemini',
};
const protoDescText = (v)=> t(PROTOCOL_DESC[v]||'') + t('llm.protoDescSuffix');
let testModalG=null, testModalM=null, testModalGi=-1;
function openTestModal(gi, m){
  const g=llmGroups[gi];
  const mask=document.getElementById('testModal');
  const title=document.getElementById('testModalTitle');
  const out=document.getElementById('testModalOut');
  const stat=document.getElementById('testModalStatus');
  if(!mask||!title||!out||!stat||!g) return;
  testModalG=g; testModalM=m; testModalGi=gi;
  title.textContent = t('llm.testPrefix') + vendorLabel(g.vendor) + ' / ' + m;
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
  const tToggle=document.getElementById('testModalThinkToggle'); if(tToggle) tToggle.textContent=t('common.collapse');
  const tk=document.getElementById('testModalThink'); if(tk) tk.textContent='';
  const pm=document.getElementById('testModalPrompt'); if(pm) pm.textContent=TEST_PROMPT;  // 提示词框固定显示
  out.textContent=t('modal.replyPlaceholder');  // 回复框每次打开重置（占位提示，不显示为回复内容）
  mask.classList.add('show');
}
let embedTestGi=-1, embedTestM='', embedTestG=null;
function openEmbedTestModal(gi, m){
  const g=embedGroups[gi];
  const mask=document.getElementById('embedTestModal');
  const title=document.getElementById('embedTestModalTitle');
  const out=document.getElementById('embedTestModalOut');
  const stat=document.getElementById('embedTestModalStatus');
  const input=document.getElementById('embedTestModalInput');
  if(!mask||!title||!out||!stat||!input||!g) return;
  embedTestGi=gi; embedTestM=m; embedTestG=g;
  title.textContent = t('test.tabEmbed') + ' · ' + vendorLabel(g.vendor) + ' / ' + m;
  if(!input.value.trim()) input.value='你好，世界';
  out.textContent=''; stat.textContent=''; stat.className='hint';
  mask.classList.add('show');
}
// 向量模型测试：复用 runLlmEmbeddings（与测试页「向量嵌入」同一链路，调 /llm/v1/embeddings）
function runEmbedModalTest(){
  const g=embedTestG, m=embedTestM, gi=embedTestGi;
  if(!g||!m) return;
  const out=document.getElementById('embedTestModalOut');
  const stat=document.getElementById('embedTestModalStatus');
  const runBtn=document.getElementById('embedTestModalRun');
  const dimEl=document.getElementById('embedTestModalDim');
  const raw=dimEl?dimEl.value.trim():'';
  const dims=raw?parseInt(raw,10):null;
  const dimensions=(dims!=null && !Number.isNaN(dims))?dims:null;
  if(runBtn){ runBtn.disabled=true; runBtn.textContent=t('common.loading'); }
  runLlmEmbeddings({
    vendor:g.vendor, model:m, dimensions, inputId:'embedTestModalInput',
    statusEl: stat, outEl: out,
    onDone:(ok)=>{
      if(runBtn){ runBtn.disabled=false; runBtn.textContent=t('common.test'); }
      stat.textContent = ok ? t('common.available') : t('common.unavailable');
      stat.className = ok ? 'hint' : 'err';
      if(g && m){ g._avail[m] = ok ? 'ok':'err'; if(gi>=0) refreshModelCell(gi); }
    }
  });
}
function runModalTest(){
  const g=testModalG, m=testModalM, gi=testModalGi;
  if(!g||!m) return;
  const out=document.getElementById('testModalOut');
  const stat=document.getElementById('testModalStatus');
  const runBtn=document.getElementById('testModalRun');
  const stream=document.getElementById('testModalStream') ? document.getElementById('testModalStream').checked : true;
  const needThink=document.getElementById('testModalThinkMode') ? document.getElementById('testModalThinkMode').checked : false;
  const protoSel=document.getElementById('testModalProto');
  const proto=protoSel ? protoSel.value : ((g.accounts[0] && g.accounts[0].protocol) || g.protocol);
  const authKey=(document.getElementById('testModalAuthKey')?.value||'').trim();
  // 测试直接用该提供商账号当前填的地址/key（可能尚未保存），与「刷新模型」同一口径；
  // 弹窗单独填的 Key 优先，否则用账号里保存的 Key。
  const acc=g.accounts[0]||{};
  const directUrl=acc.base_url||'';
  const directKey=authKey||acc.api_key||'';
  if(runBtn){ runBtn.disabled=true; runBtn.textContent=t('common.loading'); }
  const opts={ vendor:g.vendor, model:m, protocol:proto, stream, think:needThink, bypassCatalog:true, kind:'modal', authKey,
    direct:true, directUrl, directKey,
    messages:[{role:'user',content:TEST_PROMPT}],
    statusEl: stat, outEl: out,
    thinkEl: document.getElementById('testModalThink'), thinkWrapEl: document.getElementById('testModalThinkWrap'),
    onDone:(ok)=>{
      if(runBtn){ runBtn.disabled=false; runBtn.textContent=t('common.test'); }
      stat.textContent = ok ? t('common.available') : t('common.unavailable'); stat.className = ok ? 'hint' : 'err';
      // 记录测试结果到该模型，刷新子表徽标（可用/不可用/未测）
      if(g && m){ g._avail[m] = ok ? 'ok':'err'; if(gi>=0) refreshModelCell(gi); }
    } };
  runLlmChat(opts);
}

// 地址 / API Key 弹框编辑：避免表格过宽，点单元格弹窗填写（LLM / 向量 各自的池，互不影响）
let editAccGi=-1, editAccAi=-1, editAccPrefix='lp';
function openAccModal(gi, ai, prefix){
  prefix=prefix||'lp';
  const S=poolConf(prefix);
  const g=S.groups()[gi], a=g && g.accounts[ai];
  if(!a) return;
  editAccGi=gi; editAccAi=ai; editAccPrefix=prefix;
  document.getElementById('accModalTitle').textContent = t('modal.editPrefix') + vendorLabel(g.vendor) + '（' + t('login.account') + ' ' + (ai+1) + '）';
  document.getElementById('accUrl').value = a.base_url||'';
  document.getElementById('accKey').value = a.api_key||'';
  document.getElementById('accModal').classList.add('show');
}
function refreshAccCells(gi, ai, prefix){
  const S=poolConf(prefix);
  const a=S.groups()[gi] && S.groups()[gi].accounts[ai]; if(!a) return;
  document.querySelectorAll(`#${S.wrapId} .acc-cell[data-g="${gi}"][data-a="${ai}"]`).forEach(td=>{
    const key=td.querySelector('.acc-key');
    if(key) key.textContent = a.api_key ? '••••••' : t('common.empty');
    else { const u=td.querySelector('.acc-url'); if(u) u.textContent = a.base_url||''; }
  });
}
function saveAccModal(){
  const S=poolConf(editAccPrefix);
  const g=S.groups()[editAccGi], a=g && g.accounts[editAccAi];
  if(a){
    a.base_url = document.getElementById('accUrl').value.trim();
    a.api_key  = document.getElementById('accKey').value;
    refreshAccCells(editAccGi, editAccAi, editAccPrefix);
  }
  document.getElementById('accModal').classList.remove('show');
}

// ── ASR/TTS 上游（dashscope）的弹框编辑与保存 ──
// provEdit[kind] 是编辑暂存；Key 不回显（cfgOrig 里是打码值），留空 = 不修改已存的 Key。
let provModalKind = null;   // 'stt' | 'tts'
function openProvModal(kind){
  provModalKind = kind;
  const e = provEdit[kind];
  document.getElementById('provModalTitle').textContent =
    t('cfg.provEditPrefix') + (kind === 'stt' ? 'ASR' : 'TTS');
  // 服务地址固定为 DashScope 官方入口，只读展示、不可修改
  document.getElementById('provUrl').value = 'https://dashscope.aliyuncs.com';
  document.getElementById('provKey').value = e.key || '';
  document.getElementById('provModal').classList.add('show');
}
function saveProvModal(){
  const kind = provModalKind;
  if (!kind) return;
  const e = provEdit[kind];
  e.url = document.getElementById('provUrl').value.trim();
  const k = document.getElementById('provKey').value;
  if (k) e.key = k;          // 留空 = 不修改已存 Key
  document.getElementById('provModal').classList.remove('show');
  if (kind === 'stt') paintAsrTable(); else paintTtsTable();
}

// 保存 ASR/TTS 提供商配置：提供商类型 + 协议 + 协议列表 + 上游地址/Key/模型/模型列表 全部落库。
// 勾了上游但地址/模型没填时不阻止保存（可以先存一部分），但给出行内提示；语音调用时会如实报错。
async function saveProvConfig(kind){
  const stat = document.getElementById(kind === 'stt' ? 'cfgStat_asr' : 'cfgStat_tts');
  const cap = kind.toUpperCase();
  const e = provEdit[kind];
  const prov = (kind === 'stt' ? asrProvider : ttsProvider) === 'custom' ? 'dashscope' : 'builtin';
  const patch = {};
  patch[cap + '_PROVIDER'] = prov;
  // DashScope 提供商的属性（地址/Key/模型）始终落库——与「当前默认用哪个提供商」解耦：
  // 即使默认是内置，勾选的模型清单也要保存，否则勾选再保存也「没用」。
  // MODELS 落勾选中的模型；MODEL 落子表默认模型（须被勾选）。
  if (e.key) patch[cap + '_UPSTREAM_API_KEY'] = e.key;
  if (Array.isArray(e.cands)) {
    const picked = e.cands.filter(m => e.sel.has(m));
    patch[cap + '_UPSTREAM_MODELS'] = JSON.stringify(picked);
    if (e.def && picked.includes(e.def)) patch[cap + '_UPSTREAM_MODEL'] = e.def;
  }
  if (prov !== 'builtin' && !e.key) {
    if (stat) { stat.className = 'err'; stat.textContent = t('cfg.provNeedKey'); }
    return;
  }
  if (stat) { stat.className = 'hint'; stat.textContent = t('common.saving'); }
  try{
    const r = await api('/admin/api/config', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(patch)});
    const d = await r.json().catch(()=>({}));
    if (stat) {
      stat.className = r.ok ? 'hint' : 'err';
      stat.textContent = r.ok ? t('common.saved') + (d.remote_push && d.remote_push.ok ? t('common.syncedRemote') : '') : t('common.failPrefix') + (d.detail || r.status);
    }
    // 和 LLM 一样：保存成功后重拉配置并重绘，表格立即可见落库后的状态
    if (r.ok) await loadConfig();
  }catch(err){
    if (stat) { stat.className = 'err'; stat.textContent = t('common.failPrefix') + err.message; }
  }
}
function saveSttTable(){ return saveProvConfig('stt'); }
function saveTtsTable(){ return saveProvConfig('tts'); }

async function renderPoolTable(wrapId, prefix){
  const S=poolConf(prefix);
  const wrap = document.getElementById(wrapId);
  if(!wrap) return;
  wrap.className='hint'; wrap.textContent=t('common.loadingX');
  try{
    const r = await fetch(S.endpoint,{credentials:'same-origin'});
    if(!r.ok){ wrap.className='err'; wrap.textContent=t('common.loadFailedX')+r.status; return; }
    const data = await r.json();
    // 固定两个提供商：ollama（预填本机地址）+ 自定义（留空由用户填写）。
    // 池里已有的数据按 vendor 合并进这两行；没有就给默认行。其余 vendor 不展示、保存时不再写回。
    const FIXED_VENDORS = ['ollama', '自定义'];
    const byV = {};
    (data.groups||[]).forEach(g => { byV[g.vendor] = g; });
    const groups = FIXED_VENDORS.map(v => {
      const g = byV[v];
      if (g) return { vendor: v, protocol: g.protocol||'', models: g.models||[], accounts: g.accounts||[] };
      if (v === 'ollama') return { vendor:'ollama', protocol:'openai_chat_completions', models:[], accounts:[{ base_url:'http://127.0.0.1:11434', api_key:'' }] };
      return { vendor:'自定义', protocol:'openai_chat_completions', models:[], accounts:[{ base_url:'', api_key:'' }] };
    });
    // 每个账号补上协议字段（后端只给组级 protocol），默认沿用组协议
    groups.forEach(g=> g.accounts.forEach(a=>{ if(!('protocol' in a)) a.protocol = g.protocol; }));
    S.setGroups(groups);
    S.setDefVendor(data.default_vendor||'');
    S.setDefModel(data.default_model||'');
    let html = '<table class="cfg-table"><thead><tr>'
      // 左列「默认」= 默认提供商（EMBED_UPSTREAM_VENDOR / LLM_UPSTREAM_VENDOR），LLM 与向量一致；
      // 模型子表的「默认」= 默认模型（EMBED_UPSTREAM_MODEL / LLM_UPSTREAM_MODEL）。两者粒度不同、互不干扰。
      + '<th>'+t('common.default')+'</th>'
      + '<th>'+t('common.provider')+'</th><th>'+t('common.url')+'</th><th>API Key</th><th>'+t('common.model')+'</th>'
      + '</tr></thead><tbody>';
    groups.forEach((g, gi)=>{
      const n = g.accounts.length;
      g.accounts.forEach((a, ai)=>{
        const first = ai===0;
        html += '<tr>';
        if(first){
          const provChecked = g.vendor===S.defVendor();
          html += `<td rowspan="${n}" class="row-act"><input type="radio" name="${prefix}Default" value="${escapeAttr(g.vendor)}" ${provChecked?'checked':''} title="${t('llm.defaultProvider')}" /></td>`;
        }
        html += `<td class="prov-cell" rowspan="${n}"><b>${escapeHtml(vendorLabel(g.vendor))}</b> <button class="mini ${prefix}-refresh" data-g="${gi}" title="${t('llm.refreshModels')}">↻</button></td>`;
        html += `<td class="acc-cell" data-g="${gi}" data-a="${ai}"><span class="acc-url">${escapeHtml(a.base_url||'')}</span></td>`;
        html += `<td class="acc-cell" data-g="${gi}" data-a="${ai}"><span class="acc-key">${a.api_key?'••••••':t('common.empty')}</span></td>`;
        if(first){
          html += `<td class="lp-modelcell" rowspan="${n}" data-g="${gi}">${buildModelPick(gi, prefix)}</td>`;
        }
        html += '</tr>';
      });
    });
    html += '</tbody></table>';
    wrap.className=''; wrap.innerHTML = html;
    groups.forEach((g, gi)=> bindModelCell(gi, prefix));
    wrap.querySelectorAll('.acc-cell').forEach(td=> td.onclick=()=> openAccModal(+td.dataset.g, +td.dataset.a, prefix));
    wrap.querySelectorAll('.'+prefix+'-refresh').forEach(b=> b.onclick=()=> refreshProviderModels(+b.dataset.g, prefix));
  }catch(e){ wrap.className='err'; wrap.textContent=t('common.errorPrefix')+e.message; }
}
function renderLlmTable(){ return renderPoolTable('llmTableWrap','lp'); }
function renderEmbedTable(){ return renderPoolTable('embedTableWrap','embed'); }

// 只刷新指定提供商（gi）的模型列表；不刷新其它行，避免误刷无关上游
async function refreshProviderModels(gi, prefix){
  prefix=prefix||'lp';
  const btn=document.querySelector(`.${prefix}-refresh[data-g="${gi}"]`);
  if(btn){ btn.disabled=true; btn.textContent=t('common.refreshing'); }
  try{
    const S=poolConf(prefix); const g=S.groups()[gi];
    if(!g){ return; }
    const models=await probeProviderModels(gi, prefix);
    if(models){ models.forEach(m=>{ if(!g._cands.includes(m)) g._cands.push(m); }); refreshModelCell(gi); }
  }finally{
    if(btn){ btn.disabled=false; btn.textContent='↻'; }
  }
}

// 从各 prefix 自己的上游池重建 patch（LLM / 向量 各自独立存储，互不干扰）
function buildLlmPoolPatch(prefix){
  const S=poolConf(prefix);
  const defRadio=document.querySelector(`input[name="${prefix}Default"]:checked`);
  const defaultVendor = defRadio ? defRadio.value : '';
  // 重建为扁平数组：每个「勾选的模型 × 每个账号地址」各生成一条入口（共享 base_url/Key）
  const pool=[];
  S.groups().forEach((g, gi)=>{
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
  const patch={};
  patch[S.poolKey]= JSON.stringify(pool);
  // 两个能力都把「默认提供商」落库（LLM_UPSTREAM_VENDOR / EMBED_UPSTREAM_VENDOR），数据各自独立。
  if(defaultVendor) patch[S.defVendorKey]=defaultVendor;
  if(prefix==='embed'){
    // 向量表：保存「向量默认模型」（EMBED_UPSTREAM_MODEL），数据独立，不影响对话默认
    patch[S.defModelKey]= S.defModel()||'';
  } else if(defaultVendor){
    // 默认模型 = 默认供应商里「选中且设为默认」的模型（默认模型必须是选中的）
    const g=S.groups().find(x=>x.vendor===defaultVendor);
    if(g && g._def && g._sel.has(g._def)) patch[S.defModelKey]=g._def;
  }
  return patch;
}
async function savePoolTable(prefix, statId){
  const stat=document.getElementById(statId); if(!stat) return;
  stat.className='hint'; stat.textContent=t('common.saving');
  try{
    const patch=buildLlmPoolPatch(prefix);
    const r=await fetch('/admin/api/config',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ stat.className='err'; stat.textContent=t('common.failPrefix')+(d.detail||r.status); return; }
    stat.className='hint'; stat.textContent=t('common.saved')+(d.remote_push&&d.remote_push.ok?t('common.syncedRemote'):'');
    await loadConfig();
  }catch(e){ stat.className='err'; stat.textContent=t('common.errorPrefix')+e.message; }
}
function saveLlmTable(){ return savePoolTable('lp','cfgStat_llm'); }

// ── ASR 配置（固定使用内置模型，取决于运行环境；只展示内置一行 + 按需「测试可用」）──
// 外部上游以后按具体厂商单独接入，暂不在此提供地址/密钥/协议等配置。
const ASR_BUILTIN = 'builtin';
let asrProvider = 'builtin';   // 表格当前选中的提供商（radio 状态；保存时落库 STT_PROVIDER）
let ttsProvider = 'builtin';
// 上游配置的编辑暂存：初始值来自 cfgOrig（loadConfig 回填）；Key 不回显，留空=不修改。
// builtin 槽是固定白名单（只读子表，结构上与上游行统一，不落库）。
let provEdit = {
  stt: { url: '', key: '', model: '', cands: [], sel: new Set(), def: '', avail: {} },
  tts: { url: '', key: '', model: '', cands: [], sel: new Set(), def: '', avail: {} },
  sttBuiltin: { cands: ['sensevoice-small'], sel: new Set(['sensevoice-small']), def: 'sensevoice-small' },
  ttsBuiltin: { cands: ['edge-tts'], sel: new Set(['edge-tts']), def: 'edge-tts' },
};

// 模型 → 支持的调用协议（按模型名分档，对齐 DashScope 官方文档）：
// qwen-audio-tts 系 HTTP 直回音频；qwen-tts/qwen3-asr HTTP（TTS 回 OSS URL / ASR 两步上传）；
// paraformer/fun-asr 非实时为 HTTP 异步；cosyvoice / realtime / streaming 系为 WS 流式。
function modelProtocols(m){
  const id = (m || '').toLowerCase();
  if (/cosyvoice/.test(id)) return ['ws'];
  if (/realtime|streaming/.test(id)) return ['ws'];
  if (/gummy/.test(id)) return ['ws'];
  if (/filetrans/.test(id)) return ['http-async'];
  if (/paraformer|fun-asr/.test(id)) return ['http-async'];
  if (/sensevoice/.test(id)) return ['http'];
  return ['http'];
}

function paintAsrTable(){
  const wrap=document.getElementById('asrTableWrap');
  if(!wrap) return;
  let html='<table class="cfg-table"><thead><tr>'
    + '<th>'+t('common.default')+'</th><th>'+t('common.provider')+'</th><th>'+t('common.deps')+'</th><th>'+t('common.model')+'</th>'
    + '</tr></thead><tbody>';
  // 内置：唯一可用提供商，「默认」单选默认勾选；模型子表与上游行同构（白名单只读：不可加/不可取消）。
  html += `<tr class="asr-builtin" data-builtin="1">
    <td class="row-act"><input type="radio" name="asrDefault" value="builtin" ${asrProvider==='builtin'?'checked':''} title="${t('llm.defaultProvider')}" /></td>
    <td class="prov-cell"><b>${t(ASR_BUILTIN)}</b></td>
    <td class="env-cell">
      <span class="muted">${t('asr.builtinModel')}</span>
      <div class="env-req">${t('asr.modelFile')}</div>
    </td>
    <td class="model-cell">${buildUpstreamModelPick('sttBuiltin', true)}</td>
  </tr>`;
  // 阿里云 DashScope（dashscope 上游）：radio 可选；协议固定 http（OpenAI 兼容）；
  // 模型多选 + 默认单选（与 LLM 同款）；地址/Key 点单元格弹框编辑（Key 不回显），未配置时如实提示。
  const sttCfg = provEdit.stt.key
    ? `<span class="acc-url" title="${t('cfg.provUrlFixed')}">${t('cfg.provUrlFixedShort')}</span>`
    : `<span class="muted">${t('cfg.provNeedKeyShort')}</span>`;
  html += `<tr class="asr-custom">
    <td class="row-act"><input type="radio" name="asrDefault" value="custom" ${asrProvider==='custom'?'checked':''} title="${t('llm.defaultProvider')}" /></td>
    <td class="prov-cell"><b>${t('cfg.customApi')}</b> <button class="mini" data-up-refresh="stt" title="${t('llm.refreshModels')}">↻</button></td>
    <td class="env-cell prov-edit-cell" data-prov="stt" title="${t('cfg.provEditPrefix')}">${sttCfg}</td>
    <td class="model-cell">${buildUpstreamModelPick('stt')}</td>
  </tr>`;
  html += '</tbody></table>';
  wrap.className=''; wrap.innerHTML=html;
  wrap.querySelectorAll('.asr-builtin-test').forEach(b=> b.onclick=testAsrBuiltin);
  wrap.querySelectorAll('.up-test').forEach(b=> b.onclick=()=>testAsrUpstream(b.dataset.m));
  const ec=wrap.querySelector('.prov-edit-cell'); if(ec) ec.onclick=()=>openProvModal('stt');
  bindUpstreamModelPick('stt');
  wrap.querySelectorAll('input[name=asrDefault]').forEach(r=> r.onchange=()=>{ asrProvider=r.value; paintAsrTable(); });
}

// 上游（dashscope）的模型多选子表：勾选启用 + 默认单选（须勾选），行内输入添加。
// 结构与 LLM 的模型子表（model-sub）同款；数据存 provEdit[kind] 的 cands/sel/def。
function buildUpstreamModelPick(kind, readonly, nameLabel){
  const e = provEdit[kind];
  if(!Array.isArray(e.cands)) e.cands = [];
  if(!(e.sel instanceof Set)) e.sel = new Set(e.cands);
  const dis = readonly ? ' disabled' : '';
  const noDefault = nameLabel === 'protocol';
  const colLabel = noDefault ? t('common.protocol') : t('common.model');
  const defHead = noDefault ? '' : '<th>' + t('common.default') + '</th>';
  const opHead = noDefault ? '' : '<th>' + t('common.action') + '</th>';
  const stHead = noDefault ? '' : '<th>' + t('common.status') + '</th>';
  const thead = '<thead><tr><th></th><th>'+colLabel+'</th>'+defHead+opHead+stHead+'</tr></thead>';
  let html = '<div class="model-pick"><table class="model-sub">'+thead+'<tbody>';
  e.cands.forEach(m => {
    const checked = e.sel.has(m) ? 'checked' : '';
    const isDef = e.def === m ? 'checked' : '';
    const defCell = noDefault ? '' :
      `<td><input type="radio" name="upDef_${kind}" value="${escapeAttr(m)}" ${isDef} title="${t('llm.defaultModel')}"/></td>`;
    // 测试/状态是模型级的：内置行的测试走内置检测（类名保留 asr/tts-builtin-test），
    // 上游行的测试带 model 走上游测试端点；状态徽标按模型记录。
    const av = (e.avail || {})[m];
    const badge = av === 'ok' ? '<span class="badge b-ok">'+t('common.available')+'</span>'
                : av === 'err' ? '<span class="badge b-err">'+t('common.unavailable')+'</span>'
                : '<span class="badge b-mut">'+t('common.notTested')+'</span>';
    const testBtn = noDefault ? '' :
      (kind === 'sttBuiltin'
        ? `<button class="mini asr-builtin-test" data-builtin-model="${escapeAttr(m)}" title="${t('asr.detectingTitle')}">${t('common.testShort')}</button>`
        : kind === 'ttsBuiltin'
        ? `<button class="mini tts-builtin-test" data-builtin-model="${escapeAttr(m)}" title="${t('tts.synthTitle')}">${t('common.testShort')}</button>`
        : `<button class="mini up-test" data-kind="${kind}" data-m="${escapeAttr(m)}" title="${t('llm.testAvail')}">${t('common.testShort')}</button>`);
    const opCell = noDefault ? '' : `<td class="row-act">${testBtn}</td>`;
    const stCell = noDefault ? '' : `<td>${badge}</td>`;
    const protoTag = (noDefault ? '' :
      `<div class="proto-tag">${modelProtocols(m).join('/')}</div>`);
    html += `<tr>`
      + `<td><input type="checkbox" class="up-model" data-kind="${kind}" data-m="${escapeAttr(m)}" ${checked}${dis}/></td>`
      + `<td class="mm" title="${escapeAttr(m)}">${escapeHtml(m)}${protoTag}</td>`
      + defCell + opCell + stCell
      + `</tr>`;
  });
  html += '</tbody></table></div>';
  return html;
}

// 绑定上游模型子表的勾选/默认交互（只对可编辑的槽生效；每次重绘后调用）
function bindUpstreamModelPick(kind){
  const e = provEdit[kind];
  document.querySelectorAll(`.up-model[data-kind="${kind}"]`).forEach(cb => cb.onchange = () => {
    const m = cb.dataset.m;
    if (cb.checked) e.sel.add(m);
    else {
      e.sel.delete(m);
      if (e.def === m) { e.def = ''; document.querySelectorAll(`input[name="upDef_${kind}"]`).forEach(r => { if (r.value === m) r.checked = false; }); }
    }
  });
  document.querySelectorAll(`input[name="upDef_${kind}"]`).forEach(r => r.onchange = () => {
    if (r.checked) { e.def = r.value; e.sel.add(r.value); }
    // 默认模型必须是勾选中的：设默认时同步勾上
    const cb = document.querySelector(`.up-model[data-kind="${kind}"][data-m="${r.value}"]`);
    if (cb) cb.checked = true;
  });
}

// 「刷新模型」：从 DashScope 拉全部模型 id，全量并入候选并勾选（不丢已添加/已勾选的）
document.addEventListener('click', async (ev) => {
  const rb = ev.target && ev.target.closest ? ev.target.closest('[data-up-refresh]') : null;
  if (!rb) return;
  const kind = rb.dataset.upRefresh;
  const e = provEdit[kind];
  rb.disabled = true;
  try{
    const r = await fetch('/admin/api/dashscope-models', {method:'POST', credentials:'same-origin',
      headers:{'content-type':'application/json'}, body: JSON.stringify({kind})});
    const d = await r.json().catch(()=>({}));
    if (!d.ok) { console.error('[刷新模型]', d.message || r.status); }
    else {
      // 刷新语义 = 重新拉取最新清单：候选替换，但**保留已有勾选**——
      // 之前勾选保存过的模型不能被刷没；新出现的模型只列出、不自动勾。
      const prevSel = new Set(e.sel);
      e.cands = (d.models || []).slice();
      e.sel = new Set(e.cands.filter(m => prevSel.has(m)));
      if (e.def && !e.cands.includes(e.def)) e.def = '';
    }
  }catch(err){ console.error('[刷新模型]', err); }
  rb.disabled = false;
  if (kind === 'stt') paintAsrTable(); else paintTtsTable();
});

// 「刷新模型」：从 DashScope 拉全部模型 id，全量并入候选并勾选（不丢已添加/已勾选的）
document.addEventListener('click', async (ev) => {
  const rb = ev.target && ev.target.closest ? ev.target.closest('[data-up-refresh]') : null;
  if (!rb) return;
  const kind = rb.dataset.upRefresh;
  const e = provEdit[kind];
  rb.disabled = true;
  try{
    const r = await fetch('/admin/api/dashscope-models', {method:'POST', credentials:'same-origin',
      headers:{'content-type':'application/json'}, body: JSON.stringify({kind})});
    const d = await r.json().catch(()=>({}));
    if (!d.ok) { console.error('[刷新模型]', d.message || r.status); }
    else {
      // 刷新语义 = 重新拉取最新清单：候选替换，但**保留已有勾选**——
      // 之前勾选保存过的模型不能被刷没；新出现的模型只列出、不自动勾。
      const prevSel = new Set(e.sel);
      e.cands = (d.models || []).slice();
      e.sel = new Set(e.cands.filter(m => prevSel.has(m)));
      if (e.def && !e.cands.includes(e.def)) e.def = '';
    }
  }catch(err){ console.error('[刷新模型]', err); }
  rb.disabled = false;
  if (kind === 'stt') paintAsrTable(); else paintTtsTable();
});

// 行内「添加模型」：非空且不重复才进候选并勾选；第一个自动成为默认
document.addEventListener('click', (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest('[data-up-add]') : null;
  if (!btn) return;
  const kind = btn.dataset.upAdd;
  const input = document.querySelector(`.up-add-input[data-kind="${kind}"]`);
  const e = provEdit[kind];
  const m = ((input && input.value) || '').trim();
  if (!m) return;
  if (!e.cands.includes(m)) e.cands.push(m);
  e.sel.add(m);
  if (!e.def) e.def = m;
  if (input) input.value = '';
  if (kind === 'stt') paintAsrTable(); else paintTtsTable();
});

// 内置按需检测：真正加载模型并跑一次推理，启动阶段不做，只在这里点按钮时验证。
// 结果只翻「状态」列的徽标（builtin 子表的 状态 列），不写额外文字。
async function testAsrBuiltin(){
  const wrap=document.getElementById('asrTableWrap');
  const btn=wrap && wrap.querySelector('.asr-builtin-test');
  if(btn){ btn.disabled=true; btn.textContent=t('common.detecting'); }
  try{
    const r=await fetch('/admin/api/stt-builtin-test',{method:'POST',credentials:'same-origin'});
    const d=await r.json().catch(()=>({}));
    const av = d.ok ? 'ok' : 'err';
    (provEdit.sttBuiltin.cands||[]).forEach(m => { (provEdit.sttBuiltin.avail=provEdit.sttBuiltin.avail||{})[m] = av; });
  }catch(e){
    (provEdit.sttBuiltin.cands||[]).forEach(m => { (provEdit.sttBuiltin.avail=provEdit.sttBuiltin.avail||{})[m] = 'err'; });
  }
  paintAsrTable();
}

function paintTtsTable(){
  const wrap=document.getElementById('ttsTableWrap');
  if(!wrap) return;
  let html='<table class="cfg-table"><thead><tr>'
    + '<th>'+t('common.default')+'</th><th>'+t('common.provider')+'</th><th>'+t('common.deps')+'</th><th>'+t('common.model')+'</th>'
    + '</tr></thead><tbody>';
  // 内置：唯一可用提供商，「默认」单选默认勾选；引擎固定 edge-tts（上游是微软 WS，非 HTTP，如实显示「内置」）。
  // 内置：引擎固定 edge-tts（上游是微软 WS，非 HTTP，如实显示「内置」协议口径 http）；模型子表白名单只读。
  html += `<tr class="tts-builtin" data-builtin="1">
    <td class="row-act"><input type="radio" name="ttsDefault" value="builtin" ${ttsProvider==='builtin'?'checked':''} title="${t('llm.defaultProvider')}" /></td>
    <td class="prov-cell"><b>${t('builtin')}</b></td>
    <td class="env-cell">
      <span class="muted">${t('tts.builtinSynth')}</span>
      <div class="env-req">${t('tts.needNetwork')}</div>
      <div class="env-req">${t('tts.ffmpeg')}</div>
    </td>
    <td class="model-cell">${buildUpstreamModelPick('ttsBuiltin', true)}</td>
  </tr>`;
  // 阿里云 DashScope（dashscope 上游）：与 ASR 同构——模型多选 + 默认、地址/Key 弹框编辑、真调测试。
  const ttsCfg = provEdit.tts.key
    ? `<span class="acc-url" title="${t('cfg.provUrlFixed')}">${t('cfg.provUrlFixedShort')}</span>`
    : `<span class="muted">${t('cfg.provNeedKeyShort')}</span>`;
  html += `<tr class="tts-custom">
    <td class="row-act"><input type="radio" name="ttsDefault" value="custom" ${ttsProvider==='custom'?'checked':''} title="${t('llm.defaultProvider')}" /></td>
    <td class="prov-cell"><b>${t('cfg.customApi')}</b> <button class="mini" data-up-refresh="tts" title="${t('llm.refreshModels')}">↻</button></td>
    <td class="env-cell prov-edit-cell" data-prov="tts" title="${t('cfg.provEditPrefix')}">${ttsCfg}</td>
    <td class="model-cell">${buildUpstreamModelPick('tts')}</td>
  </tr>`;
  html += '</tbody></table>';
  wrap.className=''; wrap.innerHTML=html;
  const bt=wrap.querySelector('.tts-builtin-test'); if(bt) bt.onclick=testTtsBuiltin;
  // 模型级测试按钮与 ASR 同构：类名是 .up-test（buildUpstreamModelPick 渲染），逐个绑定
  wrap.querySelectorAll('.up-test').forEach(b=> b.onclick=()=>testTtsUpstream(b.dataset.m));
  const ec=wrap.querySelector('.prov-edit-cell'); if(ec) ec.onclick=()=>openProvModal('tts');
  bindUpstreamModelPick('tts');
  wrap.querySelectorAll('input[name=ttsDefault]').forEach(r=> r.onchange=()=>{ ttsProvider=r.value; paintTtsTable(); });
}

// TTS 内置按需检测：真实合成一句，验证 edge-tts 与 ffmpeg 链路，启动阶段不做。
// 结果只翻「状态」列徽标，不写额外文字。
async function testTtsBuiltin(){
  const wrap=document.getElementById('ttsTableWrap');
  const btn=wrap && wrap.querySelector('.tts-builtin-test');
  if(btn){ btn.disabled=true; btn.textContent=t('common.detecting'); }
  try{
    const r=await fetch('/admin/api/tts-builtin-test',{method:'POST',credentials:'same-origin'});
    const d=await r.json().catch(()=>({}));
    const av = d.ok ? 'ok' : 'err';
    (provEdit.ttsBuiltin.cands||[]).forEach(m => { (provEdit.ttsBuiltin.avail=provEdit.ttsBuiltin.avail||{})[m] = av; });
  }catch(e){
    (provEdit.ttsBuiltin.cands||[]).forEach(m => { (provEdit.ttsBuiltin.avail=provEdit.ttsBuiltin.avail||{})[m] = 'err'; });
  }
  paintTtsTable();
}

// 上游（openai_audio）按需测试：后端按当前 DB 配置真调一次上游（TTS 合成一句 / ASR 识别样例语音）。
// 配置还没保存时测的是「已保存」的状态——提示先保存再测，避免测的和你看到的配置不一致。
async function testAsrUpstream(model){
  const e=provEdit.stt;
  const m = model || e.def || '';
  if(!m){ return; }
  const btn=document.querySelector(`.up-test[data-kind="stt"][data-m="${m}"]`);
  if(btn){ btn.disabled=true; btn.textContent=t('common.detecting'); }
  try{
    const r=await fetch('/admin/api/stt-upstream-test',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({model:m})});
    const d=await r.json().catch(()=>({}));
    e.avail = e.avail || {};
    e.avail[m] = d.ok ? 'ok' : 'err';
  }catch(err){
    e.avail = e.avail || {}; e.avail[m]='err';
  }
  paintAsrTable();
}

async function testTtsUpstream(model){
  const e=provEdit.tts;
  const m = model || e.def || '';
  if(!m){ return; }
  const btn=document.querySelector(`.up-test[data-kind="tts"][data-m="${m}"]`);
  if(btn){ btn.disabled=true; btn.textContent=t('common.detecting'); }
  try{
    const r=await fetch('/admin/api/tts-upstream-test',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({model:m})});
    const d=await r.json().catch(()=>({}));
    e.avail = e.avail || {};
    e.avail[m] = d.ok ? 'ok' : 'err';
  }catch(err){
    e.avail = e.avail || {}; e.avail[m]='err';
  }
  paintTtsTable();
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
        <option value="off"${auth==='off'?' selected':''}>${t('sec.offDefault')}</option>
        <option value="on"${auth==='on'?' selected':''}>${t('sec.on')}</option>
      </select>
      <span class="hint">${t('sec.onHint')}</span>
    </div>
    <div class="row"><label>${t(CFG_LABEL['VOICE_API_KEY'])}</label>
      <textarea id="cfg_VOICE_API_KEY" rows="3" style="width:100%;box-sizing:border-box;font-family:monospace" placeholder="${t('sec.keyHint')}">${escapeHtml(keyVal)}</textarea>
    </div>
    <div class="row"><label>${t(CFG_LABEL['VOICE_IP_ALLOW'])}</label>
      <textarea id="cfg_VOICE_IP_ALLOW" rows="3" style="width:100%;box-sizing:border-box;font-family:monospace" placeholder="${t('sec.ipHint')}">${escapeHtml(ipVal)}</textarea>
    </div>`;
}

// ── 可复用的对话测试：测试 tab 与配置表格（提供商/模型）共用，靠 opts 个性化 ──
// opts: { vendor, model, protocol, stream, messages, statusEl, outEl, thinkEl, thinkWrapEl, onDone }
//   onDone(success:boolean) 在结束（成功/失败/中断）时回调，供调用方自定义结果呈现（如「是否可用」徽标）
let llmCtrl = null;
let embedCtrl = null;
// 测试固定打本代理 http://127.0.0.1:<配置端口>（端口从 /admin/api/status 取），
// LLM / ASR / TTS 共用；状态还没回来时为空，等价走相对路径。
let testOrigin = '';

// 自定义请求头：按 tab 各自独立，每类请求只带自己那张表里的头（当前只启用 LLM）。
// 表格每行一组 Key/Value -> 普通 HTTP 请求头对象（不持久化，每次请求自己带）。
// 客户端填什么头，请求里就是什么头；代理原样透传给上游，无需特殊协议。
function hdrTableHtml(kind){
  return `<label>${t('hdr.label')}</label>
    <table class="hdr-table">
      <thead><tr><th>${t('hdr.name')}</th><th>${t('common.value')}</th><th><button class="mini" type="button" data-add-hdr="${kind}">${t('common.add')}</button></th></tr></thead>
      <tbody data-hdr-body="${kind}"></tbody>
    </table>`;
}
function addHeaderRow(kind, k, v){
  const tb=document.querySelector(`[data-hdr-body="${kind}"]`);
  if(!tb) return;
  const tr=document.createElement('tr');
  tr.innerHTML='<td><input type="text" class="h-k" placeholder="X-Tenant-Id" /></td>'
             + '<td><input type="text" class="h-v" placeholder="'+t('common.value')+'" /></td>'
             + '<td><button class="mini danger" type="button" data-del-hdr>'+t('common.delete')+'</button></td>';
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
  return `<label>${t('body.label')}</label>
    <table class="hdr-table">
      <thead><tr><th>${t('body.fieldName')}</th><th>${t('common.value')}</th><th><button class="mini" type="button" data-add-body="${kind}">${t('common.add')}</button></th></tr></thead>
      <tbody data-extra-body="${kind}"></tbody>
    </table>`;
}
function addBodyRow(kind, k, v){
  const tb=document.querySelector(`[data-extra-body="${kind}"]`);
  if(!tb) return;
  const tr=document.createElement('tr');
  tr.innerHTML='<td><input type="text" class="h-k" placeholder="custom_field" /></td>'
             + '<td><input type="text" class="h-v" placeholder="'+t('common.value')+'" /></td>'
             + '<td><button class="mini danger" type="button" data-del-body>'+t('common.delete')+'</button></td>';
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
  if(t.closest('#embedTestModalRun')){ runEmbedModalTest(); return; }
  // ASR/TTS 上游编辑弹框：保存 / 取消 / 点遮罩
  if(t.closest('#provSave')){ saveProvModal(); return; }
  if(t.closest('#provCancel')){ const m=document.getElementById('provModal'); if(m) m.classList.remove('show'); return; }
  const pmask=document.getElementById('provModal');
  if(pmask && pmask.classList.contains('show') && t===pmask){ pmask.classList.remove('show'); return; }
  const emask=document.getElementById('embedTestModal');
  if(emask && emask.classList.contains('show')){
    if(t.closest('#embedTestModalClose') || t===emask){ emask.classList.remove('show'); if(embedCtrl){ try{ embedCtrl.abort(); }catch(_){} embedCtrl=null; } }
    return;
  }
  const mask=document.getElementById('testModal');
  if(!mask || !mask.classList.contains('show')) return;
  if(t.closest('#testModalClose') || t===mask) closeTestModal();   // 关闭按钮 / 点遮罩
});
document.addEventListener('keydown',(e)=>{
  if(e.key!=='Escape') return;
  closeTestModal();
  const em=document.getElementById('embedTestModal'); if(em) em.classList.remove('show');
  const acc=document.getElementById('accModal'); if(acc) acc.classList.remove('show');
  const prov=document.getElementById('provModal'); if(prov) prov.classList.remove('show');
});

async function runLlmChat(opts){
  const { vendor, model, protocol, stream, messages, statusEl, outEl, thinkEl, thinkWrapEl, onDone, bypassCatalog, think, kind, authKey, direct, directUrl, directKey } = opts;
  // kind 决定读哪一套自定义请求头 / body 参数表格：底部测试卡片='llm'，配置里的模型测试弹窗='modal'。
  const hkind = kind || 'llm';
  // 思考模式开关：关掉时坚决不显示「思考过程」框（不依赖上游是否遵守 think=false），
  // 否则推理模型即使被要求关闭推理仍会回传 reasoning_content，思考框又会冒出来。
  const wantThink = (think !== false);
  if(!statusEl){ if(onDone) onDone(false); return; }
  const setStatus = (t,c)=>{ statusEl.textContent=t; statusEl.className=c; };
  if(outEl) outEl.textContent='';
  if(thinkEl){ thinkEl.textContent=''; if(thinkWrapEl) thinkWrapEl.hidden=true; }
  statusEl.innerHTML='<span class="spinner"></span>'+t('common.loading'); statusEl.className='status-loading';
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
    // 配置表格「测试当前账号地址」：把表格里当前填的 base_url/key 连同标志一起下发，
    // 代理据此直连该上游（未保存也能测），与「刷新模型」同一口径；地址没填则退回池内路由。
    if(direct && directUrl){
      body.base_url=directUrl;
      if(directKey) body.api_key=directKey;
      body.direct_upstream=true;
    }
    // 思考模式：对外固定一个参数，经请求头 X-Proxy-Think 传（body 里也带一份做双通道），
    // 代理收到后由 apply_think 翻译成上游厂商原生的 body 参数，真正让模型不思考。
    if(think!==undefined && think!==null) body.think = !!think;
    const thinkHdr=(think!==undefined && think!==null)?{'X-Proxy-Think':String(!!think)}:{};
    const r=await fetch(testOrigin+'/llm/v1/chat/completions',{method:'POST',credentials:'same-origin',signal:ctrl.signal,
      headers:{'content-type':'application/json',...auth,...thinkHdr,...proxyExtraHeaders(hkind)}, body:JSON.stringify(body)});
    if(!r.ok){
      const txt=await r.text(); let msg=t('common.failedX')+r.status;
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
            // 思考内容字段名各家不统一：deepseek 官方用 reasoning_content，
            // ollama / 通用 OpenAI 兼容端常用 reasoning，两者都要能显示。
            const thinkChunk = d.reasoning_content || d.reasoning || '';
            if(wantThink && thinkEl && thinkChunk){ thinkTxt+=thinkChunk; thinkEl.textContent=thinkTxt; if(thinkWrapEl) thinkWrapEl.hidden=false; }
            if(outEl && d.content){ text+=d.content; outEl.textContent=text; }
          }catch(_){}
        }
      }
    } else {
      const d=await r.json();
      const ch=(d.choices&&d.choices[0]&&d.choices[0].message)||{};
      const reasoning=ch.reasoning_content||ch.reasoning||'';
      const text=ch.content||JSON.stringify(d);
      if(wantThink && thinkEl && reasoning && thinkWrapEl){ thinkEl.textContent=reasoning; thinkWrapEl.hidden=false; }
      if(outEl) outEl.textContent=text;
    }
    setStatus(t('common.done'),'hint'); done=true;
  }catch(e){ if(e.name==='AbortError'){ setStatus(t('common.stopped'),'hint'); } else { setStatus(t('common.errorPrefix')+e.message,'err'); } }
  if(onDone) onDone(done);
}

// 向量嵌入测试：与对话共用提供商 / 协议 / 模型选择，但打 /llm/v1/embeddings，
// 把多行文本逐个嵌入，展示维度与条数（Anthropic / Responses 线协议会被代理返回 501）。
async function runLlmEmbeddings(opts){
  const { vendor, model, protocol, statusEl, outEl, inputId, dimensions, onDone } = opts;
  if(!statusEl){ if(onDone) onDone(false); return; }
  const setStatus=(t,c)=>{ statusEl.textContent=t; statusEl.className=c; };
  if(outEl) outEl.textContent='';
  statusEl.innerHTML='<span class="spinner"></span>'+t('common.loading'); statusEl.className='status-loading';
  try{
    const tkEl=document.getElementById('testKey'); const k=(tkEl?tkEl.value:'').trim();
    const auth = k?{'Authorization':'Bearer '+k}:{};
    const input = ((document.getElementById(inputId||'llmEmbedInput').value)||'').split('\n')
      .map(s=>s.trim()).filter(Boolean);
    if(!input.length){ setStatus(t('common.errorPrefix')+' empty input','err'); if(onDone) onDone(false); return; }
    const body={ input, stream:false };
    if(model) body.model=model;
    if(vendor) body.vendor=vendor;
    if(protocol) body.protocol=protocol;
    // 请求维度（可选）：部分模型支持自定义向量维度（OpenAI 3 系 / Ollama / Gemini），
    // 服务端会按线协议翻译成 dimensions / embedding_length / outputDimensionality；
    // 不支持的模型会忽略或报错，由返回的实际维度来暴露。
    if(dimensions!=null && !Number.isNaN(dimensions)) body.dimensions = dimensions;
    const ctrl=new AbortController(); embedCtrl=ctrl;
    const r=await fetch(testOrigin+'/llm/v1/embeddings',{method:'POST',credentials:'same-origin',
      signal:ctrl.signal,
      headers:{'content-type':'application/json',...auth}, body:JSON.stringify(body)});
    if(!r.ok){
      const txt=await r.text(); let msg=t('common.failedX')+r.status;
      try{ const d=JSON.parse(txt); if(d&&d.error&&d.error.message) msg+=': '+d.error.message; else msg+=': '+txt.slice(0,200); }
      catch(_){ msg+=': '+txt.slice(0,200); }
      setStatus(msg,'err'); if(onDone) onDone(false); return;
    }
    const d=await r.json();
    const list=(d&&d.data)||[];
    const dims = list.length ? (list[0].embedding||[]).length : 0;
    const preview = list.length ? (list[0].embedding||[]).slice(0,5).map(n=>+n.toFixed(4)) : [];
    const head = t('llm.embeddingResult')+' 维度 '+dims+'，共 '+list.length+' 条';
    // 请求维度：填了就对比返回维度——一致说明模型支持该维度；不一致说明模型忽略/不支持。
    let dimInfo='';
    if(dimensions!=null && !Number.isNaN(dimensions)){
      dimInfo = (dims===dimensions) ? '；维度匹配 ✓' : ('；维度不匹配（请求 '+dimensions+'，实际 '+dims+'）✗');
    }
    const tail = preview.length ? '；首条前 5 维: ['+preview.join(', ')+']' : '';
    if(outEl) outEl.textContent = head + dimInfo + tail;
    // 模型可用即标记 ok；维度不符请求时给出警告，但不掩盖「模型可用」事实
    if(dimInfo.indexOf('不匹配')>=0){ setStatus(t('common.done')+'，'+t('llm.dimMismatchShort')+'（请求 '+dimensions+' 实际 '+dims+'）','err'); }
    else { setStatus(t('common.done'),'hint'); }
    if(onDone) onDone(true);
  }catch(e){ embedCtrl=null; if(e.name==='AbortError'){ setStatus(t('common.stopped'),'hint'); } else { setStatus(t('common.errorPrefix')+e.message,'err'); } if(onDone) onDone(false); }
}



async function renderDashboard(){
  const app = document.getElementById('app'); app.innerHTML='';

  app.appendChild(buildConfigCard());

  app.appendChild(el(`<div class="card" id="testCard"><h2>${t('common.test')}</h2>
    <label>${t('common.authHint')}</label>
    <input id="testKey" type="password" placeholder="${t('common.apiKeyOptional')}" />
    <div class="tabs">
      <button class="tab active" data-tab="llm">${t('test.tabLlm')}</button>
      <button class="tab" data-tab="embed">${t('test.tabEmbed')}</button>
      <button class="tab" data-tab="asr">${t('test.tabAsr')}</button>
      <button class="tab" data-tab="tts">${t('test.tabTts')}</button>
    </div>

    <div id="t-llm" class="tabpane">
      <label>${t('common.provider')}</label>
      <select id="llmProvider"><option value="">${t('llm.defaultRoute')}</option></select>
      <label>${t('llm.modelHint')}</label>
      <select id="llmModel" disabled>
        <option value="">${t('llm.pickProvider')}</option>
      </select>
      <div id="llmProtoRow">
        <label>${t('common.protocol')}</label>
        <select id="llmProtocol">
          <option value="openai_chat_completions">openai_chat_completions（OpenAI 对话）</option>
          <option value="azure_openai_chat_completions">azure_openai_chat_completions（Azure OpenAI）</option>
          <option value="openai_responses">openai_responses（OpenAI Responses）</option>
          <option value="anthropic_messages">anthropic_messages（Anthropic）</option>
          <option value="gemini">gemini（Google Gemini）</option>
        </select>
        <div class="hint" id="llmProtoDesc" style="margin-top:4px"></div>
      </div>
      ${hdrTableHtml('llm')}
      ${bodyTableHtml('llm')}
      <label class="chk"><input type="checkbox" id="llmStream" checked /> <span>${t('common.streaming')}</span></label>
      <div class="hint" style="margin-top:2px">${t('common.streamingHint')}</div>
      <label class="chk"><input type="checkbox" id="llmThinkMode" /> <span>${t('common.thinkMode')}</span></label>
      <div class="hint" style="margin-top:2px">${t('common.thinkOffHint')}</div>
      <label id="llmInputLabel">${t('common.promptFixed')}</label>
      <div id="llmInput" class="fixed-prompt">请只回复 ok 两个字。</div>
      <div id="llmThinkWrap" hidden style="margin-top:10px">
        <div class="think-head"><span class="muted">${t('common.thinking')}</span><button class="mini" type="button" id="llmThinkToggle">${t('common.collapse')}</button></div>
        <pre id="llmThink" class="think"></pre>
      </div>
      <div class="muted" style="margin-top:10px">${t('common.reply')}</div>
      <pre id="llmOut" class="muted">${t('test.replyStream')}</pre>
      <div class="row" style="margin-top:12px">
        <button id="llmGo" style="flex:1">${t('test.send')}</button>
        <button class="sec" id="llmStop" style="flex:1">${t('common.stop')}</button>
      </div>
      <span class="hint" id="llmStatus" style="display:block; margin-top:6px"></span>
    </div>

    <div id="t-embed" class="tabpane" hidden>
      <div class="hint" style="margin-bottom:6px">${t('llm.apiEmbed')}</div>
      <label>${t('common.provider')}</label>
      <select id="embedProvider"><option value="">${t('llm.defaultRoute')}</option></select>
      <label>${t('llm.modelHint')}</label>
      <select id="embedModel" disabled>
        <option value="">${t('llm.pickProvider')}</option>
      </select>
      <div class="hint">${t('llm.embedModelTabHint')}</div>
      <label>${t('llm.embeddingText')}</label>
      <textarea id="embedInput" rows="3" style="width:100%">你好，世界</textarea>
      <label style="margin-top:10px">${t('llm.expectDim')}</label>
      <input id="embedDim" type="number" min="1" placeholder="如 768" style="width:160px" />
      <div class="muted" style="margin-top:10px">${t('common.reply')}</div>
      <pre id="embedOut" class="muted">${t('test.replyStream')}</pre>
      <div class="row" style="margin-top:12px">
        <button id="embedGo" style="flex:1">${t('test.send')}</button>
        <button class="sec" id="embedStop" style="flex:1">${t('common.stop')}</button>
      </div>
      <span class="hint" id="embedStatus" style="display:block; margin-top:6px"></span>
    </div>

    <div id="t-asr" class="tabpane" hidden>
      <label>${t('common.provider')}</label>
      <select id="asrProvider">
        <option value="">${t('llm.defaultRoute')}</option>
        <option value="builtin">${t('test.builtin')}</option>
        <option value="dashscope">DashScope</option>
      </select>
      <label>${t('common.protocol')}</label>
      <select id="asrProtocol"></select>
      <div class="hint" id="asrProtoDesc" style="margin-top:4px"></div>
      <label>${t('common.model')}</label>
      <select id="asrModel"></select>
      <div class="muted" style="margin:10px 0 8px">${t('asr.recHint')}</div>
      <audio id="asrPlayer" controls style="width:100%;margin:6px 0 12px"></audio>
      <div class="row">
        <button id="asrRec">${t('asr.record')}</button>
        <button id="asrRecStop" class="danger" disabled>${t('common.stop')}</button>
        <button id="asrRevert" class="sec" style="display:none">${t('asr.restore')}</button>
        <span class="hint" id="asrRecMsg"></span>
      </div>
      <pre id="asrOut" class="muted">${t('asr.outPlaceholder')}</pre>
      <button id="asrGo" class="full" style="margin-top:12px">${t('asr.recognize')}</button>
      <span class="hint" id="asrMsg" style="display:block; margin-top:6px"></span>
    </div>

    <div id="t-tts" class="tabpane" hidden>
      <label>${t('common.provider')}</label>
      <select id="ttsProvider">
        <option value="">${t('llm.defaultRoute')}</option>
        <option value="builtin">${t('test.builtin')}</option>
        <option value="dashscope">DashScope</option>
      </select>
      <label>${t('common.protocol')}</label>
      <select id="ttsProtocol"></select>
      <div class="hint" id="ttsProtoDesc" style="margin-top:4px"></div>
      <label>${t('common.model')}</label>
      <select id="ttsModel"></select>
      <label style="margin-top:10px">${t('common.text')}</label>
      <textarea id="ttsText" rows="2">你好。</textarea>
      <label>${t('common.voice')}</label>
      <select id="ttsVoice"></select>
      <div class="hint" id="ttsVoiceDesc" style="margin-top:4px"></div>
      <audio id="ttsAudio" controls style="margin-top:10px; width:100%"></audio>
      <button id="ttsGo" class="full" style="margin-top:12px">${t('tts.synthesize')}</button>
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

  app.appendChild(el(`<div class="card"><h2>${t('log.title')}</h2>
    <div class="row" style="margin-bottom:10px">
      <button class="sec" id="logRefresh">${t('log.refresh')}</button>
      <span class="muted">${t('log.last200')}</span></div>
    <pre id="logs">${t('common.loadingX')}</pre>
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
    ['llm','asr','tts','embed'].forEach(k=>{ const e=document.getElementById('t-'+k); if(e) e.hidden = (t.dataset.tab!==k); });
    if(t.dataset.tab==='llm' || t.dataset.tab==='embed'){ populateLlmProviders(); }
  });

  // 弹框的关闭 / 测试按钮已在全局用事件委托绑定（见 closeTestModal），此处不再重复绑定。
  // 思考过程折叠：默认展开，可收起长文本
  const tToggle=document.getElementById('testModalThinkToggle');
  if(tToggle){
    tToggle.onclick=()=>{
      const w=document.getElementById('testModalThinkWrap'); if(!w) return;
      const collapsed=w.classList.toggle('collapsed');
      tToggle.textContent=collapsed?t('common.expand'):t('common.collapse');
    };
  }
  // 思考模式开关：关闭时立即隐藏「思考过程」区域（不再展示推理链）
  const tMode=document.getElementById('testModalThinkMode');
  if(tMode){
    tMode.onchange=()=>{
      const w=document.getElementById('testModalThinkWrap'); if(!w) return;
      if(!tMode.checked){
        w.hidden=true; w.classList.remove('collapsed');
        if(tToggle) tToggle.textContent=t('common.collapse');
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
    if(def){ const o=document.createElement('option'); o.value=def; o.textContent=def+t('common.defaultParen'); voiceSel.appendChild(o); }
    voiceSel.value = def || VOICE_CATALOG[0].id;
    VOICE_DESC.textContent = t('tts.voiceNote') + voiceDesc(voiceSel.value) + t('tts.voiceParam');
  };
  voiceSel.onchange = ()=>{ VOICE_DESC.textContent = t('tts.voiceNote') + voiceDesc(voiceSel.value) + t('tts.voiceParam'); };
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
    msg.textContent=t('tts.synthcingX'); msg.className='hint'; audio.src='';
    const proto=(document.getElementById('ttsProtocol').value||'').toLowerCase();
    const model=document.getElementById('ttsModel').value||'';
    const voice=voiceSel.value;
    try{
      if(proto==='ws'){
        const blob=await ttsViaWs(document.getElementById('ttsText').value, voice, model);
        audio.src=URL.createObjectURL(blob);
        msg.textContent=t('common.done')+t('common.wsMode')+'（'+(blob.size/1024).toFixed(1)+' KB）'; msg.className='hint';
      } else {
        const r=await fetch(testOrigin+'/voice/v1/audio/speech',{method:'POST',credentials:'same-origin',
          headers:{'content-type':'application/json',...authHdr()},
          body:JSON.stringify({
            input:document.getElementById('ttsText').value,
            voice:voice, response_format:'wav', speed:1.0,
            provider:document.getElementById('ttsProvider').value,
            model:model,
            protocol:document.getElementById('ttsProtocol').value,
          })});
        if(!r.ok){ msg.textContent=t('common.failed')+' '+r.status+'：'+(await r.text()).slice(0,200); msg.className='err'; return; }
        const blob=await r.blob(); audio.src=URL.createObjectURL(blob);
        msg.textContent=t('common.done')+'（'+(blob.size/1024).toFixed(1)+' KB）'; msg.className='hint';
      }
    }catch(e){ msg.textContent=t('common.errorPrefix')+e.message; msg.className='err'; }
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
    head.value=''; head.textContent = v ? t('llm.useUpstreamDefault') : t('llm.pickProvider');
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
    const vendor=document.getElementById('llmProvider').value.trim();
    const model=document.getElementById('llmModel').value.trim();
    const protocol=document.getElementById('llmProtocol').value.trim();
    const needThink=document.getElementById('llmThinkMode') ? document.getElementById('llmThinkMode').checked : false;
    const opts={
      vendor, model, protocol,
      stream: document.getElementById('llmStream').checked,
      think: needThink,
      messages: [{role:'user',content:document.getElementById('llmInput').textContent}],
      statusEl: llmStatus, outEl: llmOut, thinkEl: llmThink, thinkWrapEl: llmThinkWrap,
    };
    runLlmChat(opts);
  };
  document.getElementById('llmStop').onclick = ()=>{ if(llmCtrl) llmCtrl.abort(); };
  // 向量嵌入测试（独立 tab）：发送 / 停止
  document.getElementById('embedGo').onclick = ()=>{
    const vendor=document.getElementById('embedProvider').value.trim();
    const model=document.getElementById('embedModel').value.trim();
    const dimEl=document.getElementById('embedDim');
    const raw=dimEl?dimEl.value.trim():'';
    const dims=raw?parseInt(raw,10):null;
    const dimensions=(dims!=null && !Number.isNaN(dims))?dims:null;
    runLlmEmbeddings({ vendor, model, dimensions, inputId:'embedInput', statusEl: document.getElementById('embedStatus'), outEl: document.getElementById('embedOut') });
  };
  document.getElementById('embedStop').onclick = ()=>{ if(embedCtrl) embedCtrl.abort(); };
  // 底部测试：思考过程折叠 + 思考模式开关（与模型测试弹窗一致）
  const llmThinkTog=document.getElementById('llmThinkToggle');
  if(llmThinkTog){
    llmThinkTog.onclick=()=>{
      const w=document.getElementById('llmThinkWrap'); if(!w) return;
      const collapsed=w.classList.toggle('collapsed');
      llmThinkTog.textContent=collapsed?t('common.expand'):t('common.collapse');
    };
  }
  const llmThinkMode=document.getElementById('llmThinkMode');
  if(llmThinkMode){
    llmThinkMode.onchange=()=>{
      const w=document.getElementById('llmThinkWrap'); if(!w) return;
      if(!llmThinkMode.checked){
        w.hidden=true; w.classList.remove('collapsed');
        if(llmThinkTog) llmThinkTog.textContent=t('common.collapse');
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
      sel.innerHTML='<option value="">'+t('llm.defaultRoute')+'</option>';
      Object.keys(map).forEach(v=>{
        const o=document.createElement('option'); o.value=v;
        o.textContent=vendorLabel(v)+(hosts[v]?('　('+hosts[v]+')'):''); sel.appendChild(o);
      });
      sel.value = Object.prototype.hasOwnProperty.call(map,cur) ? cur : '';
      sel.onchange = refreshLlmModels;
    }
    refreshLlmModels();
    // embeddings 测试页的提供商下拉复用同一份 providers 数据
    const esel=document.getElementById('embedProvider');
    if(esel){
      esel.innerHTML='<option value="">'+t('llm.defaultRoute')+'</option>';
      Object.keys(map).forEach(v=>{
        const o=document.createElement('option'); o.value=v;
        o.textContent=vendorLabel(v)+(hosts[v]?('　('+hosts[v]+')'):''); esel.appendChild(o);
      });
      esel.onchange = refreshEmbedModels;
      refreshEmbedModels();
    }
  }

  // embeddings 测试页：按所选提供商列出该提供商下的模型（与对话共用 llmProviderModels）
  function refreshEmbedModels(){
    const prov=document.getElementById('embedProvider'), sel=document.getElementById('embedModel');
    if(!prov || !sel) return;
    const v=(prov.value||'').trim();
    const models=llmProviderModels[v]||[];
    sel.innerHTML='';
    const head=document.createElement('option');
    head.value=''; head.textContent = v ? t('llm.useUpstreamDefault') : t('llm.pickProvider');
    sel.appendChild(head);
    models.forEach(m=>{ const o=document.createElement('option'); o.value=m; o.textContent=m; sel.appendChild(o); });
    sel.disabled = !v;
    sel.value='';
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
        document.getElementById('asrRecMsg').textContent=t('asr.replaced');
        mediaStream.getTracks().forEach(t=>t.stop());
      };
      mediaRec.start();
      document.getElementById('asrRec').disabled=true; document.getElementById('asrRecStop').disabled=false;
      document.getElementById('asrRecMsg').textContent=t('asr.recording');
    }catch(e){ document.getElementById('asrRecMsg').textContent=t('asr.cannotRecord')+e.message; }
  };
  document.getElementById('asrRecStop').onclick = ()=>{
    if(mediaRec&&mediaRec.state!=='inactive') mediaRec.stop();
    document.getElementById('asrRec').disabled=false; document.getElementById('asrRecStop').disabled=true;
  };
  document.getElementById('asrRevert').onclick = ()=>{
    asrBlob=null;
    if(ASR_SAMPLE_B64) document.getElementById('asrPlayer').src='data:audio/wav;base64,'+ASR_SAMPLE_B64;
    document.getElementById('asrRevert').style.display='none';
    document.getElementById('asrRecMsg').textContent=t('asr.reverted');
  };
  // ── WS 真连分支：协议=ws 时测试页直接打 /voice/ws/inference（DashScope 协议形状）──
  // 浏览器原生 WebSocket 同源自动带 session cookie；API-Key 走 query 参数（WS 不能带自定义头）。
  function voiceWsUrl(){
    const tkEl=document.getElementById('testKey'); const k=(tkEl?tkEl.value:'').trim();
    let u=testOrigin.replace(/^http/, 'ws')+'/voice/ws/inference';
    if(k) u+='?api_key='+encodeURIComponent(k);
    return u;
  }
  // ASR（ws）：run-task(asr) → 收到 task-started 后发二进制 WAV + finish-task → result-generated 文本。
  function asrViaWs(wavBuf, model){
    return new Promise((resolve,reject)=>{
      const ws=new WebSocket(voiceWsUrl());
      let taskId=null, done=false;
      const fail=(m)=>{ if(!done){ done=true; try{ws.close();}catch{} reject(new Error(m)); } };
      ws.onerror=()=>fail(t('common.wsError'));
      ws.onopen=()=>{ ws.send(JSON.stringify({header:{action:'run-task',task_id:'asr-'+Date.now()},payload:{task:'asr',model:model||''}})); };
      ws.onmessage=(ev)=>{
        if(typeof ev.data!=='string') return;
        let d; try{ d=JSON.parse(ev.data); }catch{ return; }
        const h=d.header||{}, a=(h.action||'').toLowerCase();
        if(a==='task-started'){
          taskId=h.task_id;
          try{ ws.send(wavBuf); }catch(e){ fail('发送音频失败: '+e.message); return; }
          ws.send(JSON.stringify({header:{action:'finish-task',task_id:taskId}}));
        } else if(a==='result-generated'){
          const s=((d.payload||{}).output||{}).sentence; done=true; try{ws.close();}catch{} resolve(s?s.text:'');
        } else if(a==='task-failed'){ fail((h.error_message||'task-failed')); }
      };
      ws.onclose=(e)=>{ if(!done && e.code!==1000) fail('WS 已关闭: '+(e.reason||e.code)); };
    });
  }
  // TTS（ws）：run-task(tts) → continue-task(文本) + finish-task → 二进制音频 + task-finished。
  function ttsViaWs(text, voice, model){
    return new Promise((resolve,reject)=>{
      const ws=new WebSocket(voiceWsUrl());
      let taskId=null, done=false, chunks=[];
      const fail=(m)=>{ if(!done){ done=true; try{ws.close();}catch{} reject(new Error(m)); } };
      ws.onerror=()=>fail(t('common.wsError'));
      ws.onopen=()=>{ ws.send(JSON.stringify({header:{action:'run-task',task_id:'tts-'+Date.now()},payload:{task:'tts',model:model||'',parameters:{voice:voice||''}}})); };
      ws.onmessage=(ev)=>{
        if(typeof ev.data==='string'){
          let d; try{ d=JSON.parse(ev.data); }catch{ return; }
          const h=d.header||{}, a=(h.action||'').toLowerCase();
          if(a==='task-started'){
            taskId=h.task_id;
            ws.send(JSON.stringify({header:{action:'continue-task',task_id:taskId},payload:{input:{text:text}}}));
            ws.send(JSON.stringify({header:{action:'finish-task',task_id:taskId}}));
          } else if(a==='task-finished'){ done=true; try{ws.close();}catch{} resolve(new Blob(chunks,{type:'audio/wav'})); }
          else if(a==='task-failed'){ fail((h.error_message||'task-failed')); }
        } else if(ev.data instanceof Blob){ chunks.push(ev.data); }
      };
      ws.onclose=(e)=>{ if(!done && e.code!==1000) fail('WS 已关闭: '+(e.reason||e.code)); };
    });
  }

  document.getElementById('asrGo').onclick = async ()=>{
    const msg=document.getElementById('asrMsg'), out=document.getElementById('asrOut');
    msg.className='hint';
    let blob=asrBlob, fname='record.wav';
    if(!blob){
      if(!ASR_SAMPLE_B64){ msg.textContent=t('asr.noAudio'); return; }
      const bin=atob(ASR_SAMPLE_B64); const bytes=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      blob=new Blob([bytes],{type:'audio/wav'}); fname='sample.wav';
    }
    const proto=(document.getElementById('asrProtocol').value||'').toLowerCase();
    const model=document.getElementById('asrModel').value||'';
    msg.textContent=t('asr.recognizing');
    try{
      if(proto==='ws'){
        // 内置 SenseVoice 只认 WAV；录制的可能不是，统一转 WAV 再发。
        const wav = (blob.type && blob.type.indexOf('wav')>=0) ? blob : await toWav(blob);
        const wavBuf = await wav.arrayBuffer();
        const text = await asrViaWs(wavBuf, model);
        out.textContent=text||t('common.emptyParen');
        msg.textContent=t('common.done')+t('common.wsMode'); msg.className='hint';
      } else {
        const fd=new FormData(); fd.append('file',blob,fname);
        // 默认路由时模型留空，由后端沿用配置默认；内置/DashScope 用联动下拉里的具体值。
        fd.append('model',model);
        fd.append('provider',document.getElementById('asrProvider').value||'');
        fd.append('protocol',document.getElementById('asrProtocol').value||'');
        const r=await fetch(testOrigin+'/voice/v1/audio/transcriptions',{method:'POST',credentials:'same-origin',headers:{...authHdr()},body:fd});
        if(!r.ok){ msg.textContent=t('common.failed')+' '+r.status+'：'+(await r.text()).slice(0,200); msg.className='err'; return; }
        const d=await r.json(); out.textContent=d.text||t('common.emptyParen'); msg.textContent=t('common.done'); msg.className='hint';
      }
    }catch(e){ msg.textContent=t('common.errorPrefix')+e.message; msg.className='err'; }
  };
  // 固定音频可直接在页面播放试听
  if(ASR_SAMPLE_B64) document.getElementById('asrPlayer').src='data:audio/wav;base64,'+ASR_SAMPLE_B64;

  // 底部测试页 ASR/TTS：提供商 → 协议（筛选条件）→ 模型 三级联动。
  // 模型只列配置里勾选保存的（provEdit[kind].cands）；不选 = 用该提供商的默认模型。
  // 协议下拉的选项一定是从模型集合的协议字段里总结出来的，选中后只列该协议的模型；
  // 协议选「全部」时，实际下发的协议由所选模型（或默认模型）自动确定。
  const VOICE_TEST_BUILTIN = {asr: 'sensevoice-small', tts: 'edge-tts'};
  const voiceTestEdit = (kind)=> kind==='asr' ? provEdit.stt : provEdit.tts;
  // 实际生效的提供商：显式选了就用它；「默认路由」按 DB 里的默认提供商。
  const voiceTestRealProvider = (kind, p)=>{
    if(p) return p;
    return cfgOrig[kind==='asr' ? 'STT_PROVIDER' : 'TTS_PROVIDER'] === 'dashscope' ? 'dashscope' : 'builtin';
  };
  const voiceTestModels = (kind, p)=>{
    if(voiceTestRealProvider(kind,p)==='builtin') return [VOICE_TEST_BUILTIN[kind]];
    const e=voiceTestEdit(kind);
    return (e && Array.isArray(e.cands)) ? e.cands.slice() : [];
  };
  const voiceTestDefaultModel = (kind, p)=>{
    if(voiceTestRealProvider(kind,p)==='builtin') return VOICE_TEST_BUILTIN[kind];
    const e=voiceTestEdit(kind);
    return (e && e.def) || '';
  };
  const modelProto = (m)=> modelProtocols(m).join('/');
  // 协议选项只来自模型：把当前模型集合（含默认模型）里出现过的协议去重列出。
  function voiceTestProtoOptions(kind, p){
    const set=new Set();
    voiceTestModels(kind,p).forEach(m=>set.add(modelProto(m)));
    const dm=voiceTestDefaultModel(kind,p);
    if(dm) set.add(modelProto(dm));
    return [...set];
  }
  function refreshVoiceTestSelects(kind){
    const prov=document.getElementById(kind+'Provider');
    const proto=document.getElementById(kind+'Protocol');
    const mdl=document.getElementById(kind+'Model');
    if(!prov||!proto||!mdl) return;
    const opts=voiceTestProtoOptions(kind, prov.value);
    const keep=proto.value;
    proto.innerHTML='';
    opts.forEach(v=>{ const o=document.createElement('option'); o.value=v; o.textContent=v; proto.appendChild(o); });
    // 协议必填：没有「全部」空选项，始终选中一个具体协议（优先保留已选，否则取第一个）。
    proto.value = opts.includes(keep) ? keep : (opts[0]||'http');
    refreshVoiceTestModels(kind);
  }
  function refreshVoiceTestModels(kind){
    const prov=document.getElementById(kind+'Provider');
    const proto=document.getElementById(kind+'Protocol');
    const mdl=document.getElementById(kind+'Model');
    if(!prov||!proto||!mdl) return;
    const p=prov.value, pf=proto.value;
    mdl.innerHTML='';
    const head=document.createElement('option');
    head.value=''; head.textContent=t('test.modelFollowConfig');
    head.dataset.proto=modelProto(voiceTestDefaultModel(kind,p)||'http');
    mdl.appendChild(head);
    voiceTestModels(kind,p).filter(m=> !pf || modelProto(m)===pf).forEach(m=>{
      const o=document.createElement('option');
      o.value=m; o.textContent=m+' ('+modelProto(m)+')'; o.dataset.proto=modelProto(m);
      mdl.appendChild(o);
    });
    mdl.disabled=false;
    mdl.value='';           // 不替用户自动选模型
    updateVoiceTestProto(kind);
  }
  function updateVoiceTestProto(kind){
    const mdl=document.getElementById(kind+'Model');
    const proto=document.getElementById(kind+'Protocol');
    const desc=document.getElementById(kind+'ProtoDesc');
    if(!mdl||!proto) return;
    // 协议必填：始终有具体值，直接作为请求参数下发。
    const chosen=mdl.value||'';
    const pv = proto.value || 'http';
    if(desc){
      let s=t('test.protoHint')+' '+t('test.protoRecPrefix')+pv;
      if(!chosen) s+=' '+t('test.protoNoModel');
      if(pv.includes('http-async')) s+=' '+t('test.protoAsyncWarn');
      desc.textContent=s;
    }
  }
  ['asr','tts'].forEach(kind=>{
    const prov=document.getElementById(kind+'Provider');
    const proto=document.getElementById(kind+'Protocol');
    const mdl=document.getElementById(kind+'Model');
    if(prov) prov.onchange=()=>refreshVoiceTestSelects(kind);
    if(proto) proto.onchange=()=>refreshVoiceTestModels(kind);
    if(mdl) mdl.onchange=()=>updateVoiceTestProto(kind);
  });
  // loadConfig() 回填完勾选模型后也会刷新；DOM 还没建好时静默跳过。
  window.refreshVoiceTestSelects = ()=>['asr','tts'].forEach(refreshVoiceTestSelects);
  window.refreshVoiceTestSelects();

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
  if(!r.ok){ pre.textContent=t('common.loadFailed'); return; }
  pre.textContent = await r.text();
}

function escapeHtml(s){ return (s||'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escapeAttr(s){ return (s||'').replace(/"/g,'&quot;'); }

// 全局接口 loading：拦截 fetch，仅 /admin/ 管理接口（保存/刷新等）进行中时显示全屏遮罩
// （居中转圈），全部请求结束才隐藏（计数防止并发请求互相抵消）。快速请求（<250ms）延迟显示。
// 能力测试端点 /llm/、/voice/ 自带状态文字与流式进度，不弹这个全屏遮罩——否则弹框测试时
// 遮罩 z-index(40) 被弹框(50) 压在下面，看起来像「loading 在弹框下面」，且会干扰进度。
(function(){
  let _pending = 0;
  let _timer = null;
  const _el = () => document.getElementById('panelLoading');
  const _show = () => { const e = _el(); if (e) e.classList.add('show'); };
  const _hide = () => { const e = _el(); if (e) e.classList.remove('show'); };
  const _orig = window.fetch.bind(window);
  const _isAdmin = (u) => typeof u === 'string' && u.indexOf('/admin/') >= 0;
  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    if (!_isAdmin(url)) return _orig(...args);
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
def register_admin_routes(
    app,
    stt_builtin_check=None,
    tts_builtin_check=None,
    stt_upstream_test=None,
    tts_upstream_test=None,
) -> None:
    global _STT_BUILTIN_CHECK, _TTS_BUILTIN_CHECK, _STT_UPSTREAM_TEST, _TTS_UPSTREAM_TEST
    _STT_BUILTIN_CHECK = stt_builtin_check
    _TTS_BUILTIN_CHECK = tts_builtin_check
    _STT_UPSTREAM_TEST = stt_upstream_test
    _TTS_UPSTREAM_TEST = tts_upstream_test

    @app.get("/admin", response_class=HTMLResponse)
    @app.get("/admin/", response_class=HTMLResponse)
    def admin_page():
        # 页面内自行按 /admin/api/me 决定显示登录还是控制台，无需服务端分流。
        # 禁缓存：页面逻辑全在这份 HTML 里，浏览器缓存旧版会让人以为改动没生效。
        return HTMLResponse(ADMIN_HTML, headers={"Cache-Control": "no-store, must-revalidate"})

    @app.post("/admin/login")
    def admin_login(user: str | None = Form(None), password: str | None = Form(None)):
        # 表单缺字段时显式返回可读字符串，避免 FastAPI 默认 422 把 detail 写成对象数组
        if not user or not password:
            raise HTTPException(status_code=400, detail="请输入账号和密码")
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
        """LLM 上游按提供商分组返回。详见 admin_pool。"""
        return admin_pool("LLM", "LLM_UPSTREAM_VENDOR", "LLM_UPSTREAM_MODEL")

    @app.get("/admin/api/embed-pool", dependencies=[Depends(require_admin)])
    def admin_embed_pool():
        """向量（embeddings）上游按提供商分组返回：与 LLM 结构完全一致，但数据独立存储
        （EMBED_UPSTREAM_POOL），互不影响——改一个不会同步/覆盖另一个。"""
        return admin_pool("EMBED", "EMBED_UPSTREAM_VENDOR", "EMBED_UPSTREAM_MODEL")

    def admin_pool(cap: str, def_vendor_key: str, def_model_key: str):
        """上游池按提供商分组返回：每组含厂商、协议、去重模型列表、账号清单（地址/Key/本账号模型）。
        供配置页表格渲染（提供商上下合并、模型映射）使用。账号里的 api_key 为明文（管理端点，
        仅本地同源可达），前端预填进密码框，留空即视为「清空该 Key」。
        cap 区分 LLM / EMBED，两者各自读各自的池（LLM_UPSTREAM_POOL / EMBED_UPSTREAM_POOL），
        保证 embeddings 配置数据与对话配置数据完全独立。"""
        entries = upstream_pool.load_pool(cap)
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
        default_vendor = config_store.instance().get(def_vendor_key, "") or ""
        default_model = config_store.instance().get(def_model_key, "") or ""
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

    # DashScope 语音模型清单：HTTP 与 WS 协议的模型都列出，面板按协议小字如实
    # 标注（ws 模型当前账号未开通会测试失败，但保留在列表里供用户查看/选择）。
    # 依据：实测（qwen3-tts-flash 合成 / qwen3-asr-flash 识别成功）+ 官方文档
    # model-list-speech-{synthesis,recognition}。
    DASHSCOPE_VOICE_MODELS = {
        "tts": [
            "qwen3-tts-flash",           # ✅ 实测合成成功（http）
            "qwen-tts",                   # 同端点（multimodal-generation，http）
            "qwen-audio-3.0-tts-flash",   # HTTP 直回音频（官方 HTTP SDK 示例）
            "qwen-audio-3.0-tts-plus",
            "qwen-audio-3.1-tts-flash",
            "qwen-audio-3.1-tts-next",
            "cosyvoice-v3-flash",         # ws ✅ 实测可用（音色 longanyang）
            "cosyvoice-v3-plus",          # ws ✅ 实测可用
            "cosyvoice-v2",               # ws ✅ 实测可用（音色 longxiaochun_v2）
            "cosyvoice-v1",               # ws 官方已于 2026-10-10 下线（长尾模型下线公告），
                                          #    全网 Model not exist，非账号问题；留作对照
        ],
        "stt": [
            # Paraformer 系（实时 + 录音文件）
            "paraformer-realtime-v2",     # ws
            "paraformer-realtime-v1",     # ws
            "paraformer-realtime-8k-v2",  # ws（电话 8k）
            "paraformer-realtime-8k-v1",  # ws（电话 8k）
            "paraformer-v2",              # http-async（录音文件）
            "paraformer-v1",              # http-async（录音文件）
            "paraformer-8k-v2",           # http-async（电话 8k）
            "paraformer-8k-v1",           # http-async（电话 8k）
            "paraformer-mtl-v1",          # http-async（多语种）
            # Fun-ASR 系（中英自由切换、噪声鲁棒）
            "fun-asr",                    # http-async（录音文件）
            "fun-asr-realtime",           # ws
            "fun-asr-realtime-2026-02-28",# ws
            "fun-asr-flash-2026-06-15",   # ws
            "fun-asr-flash-8k-realtime",  # ws（电话 8k）
            "fun-asr-mtl",                # http-async（多语种）
            # Qwen-ASR 系
            "qwen3-asr-flash",            # ✅ 实测识别成功（http）
            "qwen3-asr-flash-realtime",   # ws
            "qwen3-asr-flash-filetrans",  # http-async（录音文件）
            "qwen-audio-3.0-asr-flash",
            "qwen-audio-3.0-asr-flash-streaming",   # ws
            "qwen-audio-3.0-asr-flash-filetrans",   # http-async
            "qwen-audio-3.1-asr-flash",
            "qwen-audio-3.1-asr-flash-streaming",   # ws
            "qwen-audio-3.1-asr-flash-filetrans",   # http-async
            "qwen-audio-3.1-asr-flash-message",
            # Gummy 系（识别/翻译）
            "gummy-realtime-v1",          # ws（翻译）
            "gummy-chat-v1",              # ws（翻译）
            # 其他
            "sensevoice-v1",              # http-async（录音文件）
        ],
    }

    @app.post("/admin/api/dashscope-models", dependencies=[Depends(require_admin)])
    async def admin_dashscope_models(request: Request):
        """返回 DashScope 的语音模型清单（按 kind 分族），供面板「刷新模型」列出。

        HTTP 与 WS 协议模型都列出（内置清单，不发网络请求），协议由面板小字标注。
        """
        kind = None
        try:
            b = await request.json()
            if isinstance(b, dict):
                kind = b.get("kind")
        except Exception:
            pass
        kind = (kind or "tts").strip().lower()
        return {"ok": True, "models": list(DASHSCOPE_VOICE_MODELS.get(kind, []))}

    @app.post("/admin/api/stt-upstream-test", dependencies=[Depends(require_admin)])
    async def admin_stt_upstream_test(request: Request):
        """按当前 DB 配置真调一次上游 ASR；可带 {model} 覆盖默认模型（模型级测试）。"""
        model = None
        try:
            b = await request.json()
            if isinstance(b, dict):
                model = b.get("model")
        except Exception:
            pass
        if _STT_UPSTREAM_TEST is None:
            return {"ok": False, "message": "检测能力未注入"}
        return await _STT_UPSTREAM_TEST(model)

    @app.post("/admin/api/tts-upstream-test", dependencies=[Depends(require_admin)])
    async def admin_tts_upstream_test(request: Request):
        """按当前 DB 配置真合成一句验证上游 TTS；可带 {model} 覆盖默认模型。"""
        model = None
        try:
            b = await request.json()
            if isinstance(b, dict):
                model = b.get("model")
        except Exception:
            pass
        if _TTS_UPSTREAM_TEST is None:
            return {"ok": False, "message": "检测能力未注入"}
        return await _TTS_UPSTREAM_TEST(model)

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
                        names = [m.get("id", "") for m in d["data"] if isinstance(m, dict)]
                    elif isinstance(d.get("models"), list):
                        names = [m.get("name", "") for m in d["models"] if isinstance(m, dict)]
            except Exception:
                pass
            # 不截断：模型多时全量返回，由前端子表滚动展示（截断会让用户以为没拉全）。
            return {"ok": ok, "status": r.status_code, "models": [n for n in names if n]}
        except Exception as e:
            return {"ok": False, "error": str(e)}
