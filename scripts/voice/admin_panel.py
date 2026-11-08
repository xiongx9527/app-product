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

from fastapi import Cookie, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

# ── 路径与配置（由主文件 init_admin 注入）────────────────────────────
VOICE_CONF_PATH = ""
VOICE_HOME_DIR = ""
VOICE_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "voice.sh"
)

# 密钥类配置项：读取时打码，避免明文出现在页面 / 接口里。
# 地址池（*_UPSTREAM_POOL）是含 api_key 的 JSON，整串打码，编辑时按“整段重填”处理。
MASKED_KEYS = {
    "LLM_UPSTREAM_API_KEY",
    "VOICE_UPSTREAM_API_KEY",
    "STT_UPSTREAM_API_KEY",
    "TTS_UPSTREAM_API_KEY",
    "VOICE_API_KEY_FILE",
    "LLM_UPSTREAM_POOL",
    "STT_UPSTREAM_POOL",
    "TTS_UPSTREAM_POOL",
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
    try:
        return int(read_voice_config().get("VOICE_PORT") or "9529")
    except ValueError:
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
<title>语音代理管理</title>
<style>
  :root { --bg:#0f1115; --card:#1a1d24; --line:#2a2f3a; --fg:#e6e8ec; --mut:#9aa3b2;
          --acc:#4f8cff; --ok:#3ecf8e; --warn:#f5a623; --err:#ff5c5c; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;
         background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center;
           justify-content:space-between; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  main { max-width:920px; margin:0 auto; padding:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  .card h2 { font-size:14px; margin:0 0 12px; color:var(--mut); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  button { background:var(--acc); color:#fff; border:0; border-radius:8px; padding:8px 14px; cursor:pointer; font-size:13px; }
  button.sec { background:#2a2f3a; color:var(--fg); }
  button.danger { background:#3a1f24; color:#ff8a8a; }
  button:disabled { opacity:.5; cursor:default; }
  input[type=text], input[type=password] { background:#0f1115; border:1px solid var(--line); color:var(--fg);
           border-radius:8px; padding:8px 10px; font-size:13px; width:260px; }
  label { display:block; color:var(--mut); margin:10px 0 4px; font-size:12px; }
  .kv { display:grid; grid-template-columns:240px 1fr; gap:8px 12px; align-items:center; }
  .kv .k { color:var(--mut); font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; word-break:break-all; }
  .kv input { width:100%; }
  .hint { color:var(--mut); font-size:12px; margin-top:6px; }
  pre { background:#0b0d11; border:1px solid var(--line); border-radius:8px; padding:12px;
        overflow:auto; max-height:320px; font-size:12px; color:#cdd3de; white-space:pre-wrap; word-break:break-all; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; margin-right:6px; }
  .b-ok { background:#13352a; color:var(--ok); }
  .b-err { background:#3a1f24; color:var(--err); }
  .b-mut { background:#23272f; color:var(--mut); }
  #login { max-width:340px; margin:80px auto; }
  .err { color:var(--err); font-size:13px; min-height:18px; margin-top:8px; }
  .muted { color:var(--mut); }
  a { color:var(--acc); }
</style>
</head>
<body>
<header><h1>语音代理管理</h1><div id="who" class="muted"></div></header>
<main id="app"></main>

<script>
const api = (path, opts={}) => fetch(path, {credentials:'same-origin', ...opts});
function el(html){ const d=document.createElement('div'); d.innerHTML=html; return d.firstElementChild; }

async function boot(){
  const me = await api('/admin/api/me').then(r=>r.ok?r.json():null);
  if(!me || !me.authenticated){ renderLogin(); }
  else { document.getElementById('who').textContent = '账号：'+me.user; renderDashboard(); }
}

function renderLogin(){
  document.getElementById('app').innerHTML = '';
  const card = el(`<div class="card" id="login">
    <h2>登录</h2>
    <label>账号</label><input type="text" id="u" autocomplete="username" />
    <label>密码</label><input type="password" id="p" autocomplete="current-password" />
    <div class="err" id="e"></div>
    <div class="row" style="margin-top:12px"><button id="go">登录</button></div>
  </div>`);
  document.getElementById('app').appendChild(card);
  const submit = async ()=>{
    const r = await api('/admin/login', {method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:`user=${encodeURIComponent(document.getElementById('u').value)}&password=${encodeURIComponent(document.getElementById('p').value)}`});
    if(r.ok){ boot(); }
    else { document.getElementById('e').textContent = (await r.json()).detail || '登录失败'; }
  };
  card.querySelector('#go').onclick = submit;
  card.querySelector('#p').addEventListener('keydown', e=>{ if(e.key==='Enter') submit(); });
}

let cfgKeys = [];
async function renderDashboard(){
  const app = document.getElementById('app'); app.innerHTML='';

  app.appendChild(el(`<div class="card"><div class="row" style="justify-content:space-between">
    <h2 style="margin:0">运行状态</h2>
    <button class="sec" id="logout">退出登录</button></div>
    <div id="status" class="muted">加载中…</div>
    <div class="row" style="margin-top:12px">
      <button id="start">启动</button><button id="stop" class="danger">停止</button>
      <button id="restart">重启</button><button id="refresh" class="sec">刷新</button>
    </div>
  </div>`));

  app.appendChild(el(`<div class="card"><h2>数据库</h2>
    <div id="db" class="muted">加载中…</div>
    <div class="row" style="margin-top:10px">
      <button id="sync">同步到远程</button>
      <span id="syncmsg" class="hint"></span>
    </div>
  </div>`));

  app.appendChild(el(`<div class="card"><h2>配置（voice.conf）</h2>
    <div id="cfg" class="muted">加载中…</div>
    <div class="hint">密钥字段留空表示不修改；其余字段留空表示清空。</div>
    <div class="row" style="margin-top:12px">
      <button id="save">保存</button>
      <button id="saveRestart">保存并重启</button>
    </div>
    <div id="cfgmsg" class="hint"></div>
  </div>`));

  app.appendChild(el(`<div class="card"><h2>日志（voice.log）</h2>
    <div class="row" style="margin-bottom:10px">
      <button class="sec" id="logRefresh">刷新日志</button>
      <span class="muted">最近 200 行</span></div>
    <pre id="logs">加载中…</pre>
  </div>`));

  app.querySelector('#logout').onclick = async ()=>{
    await api('/admin/logout',{method:'POST'}); boot();
  };
  app.querySelector('#refresh').onclick = loadStatus;
  app.querySelector('#start').onclick = ()=>doAction('start');
  app.querySelector('#stop').onclick = ()=>doAction('stop');
  app.querySelector('#restart').onclick = ()=>doAction('restart');
  app.querySelector('#save').onclick = ()=>saveConfig(false);
  app.querySelector('#saveRestart').onclick = ()=>saveConfig(true);
  app.querySelector('#logRefresh').onclick = loadLogs;
  app.querySelector('#sync').onclick = doSync;

  loadStatus(); loadConfig(); loadLogs(); loadDb();
}

async function loadDb(){
  const box = document.getElementById('db');
  const r = await api('/admin/api/status');
  if(!r.ok){ box.textContent='加载失败'; return; }
  const s = await r.json();
  const st = s.store || {};
  const stats = st.stats || {};
  let html = `本地库：<code>${escapeHtml(st.db_path||'?')}</code><br>`;
  html += `配置项 ${stats.config||0} · 事件 ${stats.events||0} · 审计 ${stats.audit||0}<br>`;
  const rem = st.remote || {};
  if(rem.configured){
    const cls = rem.last_ok ? 'b-ok' : 'b-err';
    const label = rem.last_ok ? '已同步' : '同步失败';
    html += `<span class="badge ${cls}">远程库：${label}</span>`;
    if(rem.last_error) html += ` <span class="muted">${escapeHtml(rem.last_error)}</span>`;
  } else {
    html += `<span class="badge b-mut">远程库：未配置</span> <span class="muted">（设 VOICE_REMOTE_DSN 启用）</span>`;
  }
  if(rem.redis_configured){
    const rcls = rem.redis_ok ? 'b-ok' : 'b-err';
    const rlabel = rem.redis_ok ? 'Redis 缓存正常' : 'Redis 不可用（回退查远端库）';
    html += `<br><span class="badge ${rcls}">远程缓存：${rlabel}</span>`;
    if(!rem.redis_ok && rem.redis_error) html += ` <span class="muted">${escapeHtml(rem.redis_error)}</span>`;
  } else {
    html += `<br><span class="badge b-mut">远程缓存：未配置（设 REDIS_URL 启用）</span>`;
  }
  box.innerHTML = html;
}

async function doSync(){
  const msg = document.getElementById('syncmsg');
  msg.textContent = '同步中…';
  const r = await api('/admin/api/sync', {method:'POST'});
  if(r.ok){
    const d = await r.json();
    const ok = d.push && d.push.ok;
    msg.innerHTML = ok
      ? `<span style="color:var(--ok)">已同步（拉取 ${d.pulled_keys} 项）</span>`
      : `<span style="color:var(--warn)">本地已更新，远程：${(d.push&&d.push.error)||'未配置'}</span>`;
    loadDb();
  } else {
    msg.innerHTML = '<span style="color:var(--err)">同步失败</span>';
  }
}

function renderUpstreams(title, list){
  if(!list || !list.length) return '';
  // 按线协议分组展示：一个分组 = 一个模型类型，组内多个账号健康优先 + 轮询。
  const groups = {};
  for(const u of list){ const p = u.protocol||'openai_chat_completions'; (groups[p]=groups[p]||[]).push(u); }
  let s = `<div style="margin-top:6px"><span class="muted">${title} 地址池（按线协议分组）：</span>`;
  for(const p in groups){
    s += `<div style="margin-top:4px"><span class="badge b-mut">${escapeHtml(p)}</span>`;
    for(const u of groups[p]){
      const cls = u.healthy ? 'b-ok' : 'b-err';
      let label;
      if(u.healthy) label = '在线';
      else if(u.cooling) label = '冷却中·待探测';
      else label = '离线'+(u.last_error?(' · '+u.last_error):'');
      const vnd = u.vendor ? (' ['+u.vendor+']') : '';
      const mdl = u.model ? (' · '+u.model) : '';
      s += ` <span class="badge ${cls}">${escapeHtml(u.base_url||'?')}${vnd}${mdl} · ${label}</span>`;
    }
    s += '</div>';
  }
  s += '</div>';
  return s;
}

async function loadStatus(){
  const box = document.getElementById('status');
  const r = await api('/admin/api/status');
  if(!r.ok){ box.innerHTML = '<span class="badge b-err">未授权</span>'; return; }
  const s = await r.json();
  const h = s.health || {};
  let html = '';
  html += s.running
    ? `<span class="badge b-ok">运行中</span> pid=${s.pid}`
    : `<span class="badge b-err">未运行</span>`;
  html += ` <span class="badge b-mut">端口 ${h.port ?? '?'}</span>`;
  if(h.llm) html += ` <span class="badge ${h.llm.enabled?'b-ok':'b-mut'}">LLM ${h.llm.enabled?h.llm.base_url:'off'}</span>`;
  if(h.stt_backend) html += ` <span class="badge b-mut">STT ${h.stt_backend}</span>`;
  if(h.tts_backend) html += ` <span class="badge b-mut">TTS ${h.tts_backend}</span>`;
  if(h.upstreams){
    html += renderUpstreams('STT', h.upstreams.STT);
    html += renderUpstreams('TTS', h.upstreams.TTS);
  }
  if(h.llm && h.llm.upstreams) html += renderUpstreams('LLM', h.llm.upstreams);
  html += `<div class="hint" style="margin-top:8px;white-space:pre-wrap">${escapeHtml(s.statusText)}</div>`;
  box.innerHTML = html;
}

async function loadConfig(){
  const r = await api('/admin/api/config');
  const box = document.getElementById('cfg');
  if(!r.ok){ box.textContent='加载失败'; return; }
  const cfg = await r.json();
  cfgKeys = Object.keys(cfg);
  const kv = el('<div class="kv"></div>');
  for(const k of cfgKeys){
    const masked = cfg[k] === '********';
    const inputType = masked ? 'password' : 'text';
    const ph = masked ? '********（留空=不改）' : '';
    kv.appendChild(el(`<div class="k" title="${k}">${k}</div>`));
    kv.appendChild(el(`<input type="${inputType}" data-k="${k}" placeholder="${ph}" value="${masked?'':escapeAttr(cfg[k])}" />`));
  }
  box.innerHTML=''; box.appendChild(kv);
}

async function saveConfig(restart){
  const patch = {};
  for(const k of cfgKeys){
    const inp = document.querySelector(`input[data-k="${k}"]`);
    if(!inp) continue;
    let v = inp.value;
    const orig = await api('/admin/api/config').then(r=>r.json()).then(c=>c[k]);
    // 密钥字段：留空表示不修改 -> 发 HIDDEN 哨兵
    if(orig === '********' && v === '') v = '********';
    patch[k] = v;
  }
  const r = await api('/admin/api/config', {method:'POST',
    headers:{'content-type':'application/json'}, body:JSON.stringify(patch)});
  const msg = document.getElementById('cfgmsg');
  if(r.ok){
    msg.innerHTML = restart
      ? '<span style="color:var(--warn)">已保存，正在重启…</span>'
      : '<span style="color:var(--ok)">已保存（需重启才生效的配置请点“保存并重启”）</span>';
    if(restart) doAction('restart');
  } else {
    msg.innerHTML = '<span style="color:var(--err)">'+(await r.json()).detail+'</span>';
  }
}

async function doAction(action){
  const r = await api('/admin/api/action', {method:'POST',
    headers:{'content-type':'application/json'}, body:JSON.stringify({action})});
  if(action==='restart'){
    // 重启会杀掉当前进程，会话丢失；轮询直到又能连上（可能要求重新登录）。
    await waitReconnect();
    return;
  }
  loadStatus(); loadLogs();
  if(!r.ok){ console.warn(await r.text()); }
}

async function waitReconnect(){
  for(let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,1000));
    const r = await api('/admin/api/me');
    if(r.ok){ boot(); return; }
  }
  document.getElementById('app').innerHTML='<div class="card">重启后未能自动恢复，请刷新页面。</div>';
}

async function loadLogs(){
  const r = await api('/admin/api/logs');
  const pre = document.getElementById('logs');
  if(!r.ok){ pre.textContent='加载失败'; return; }
  pre.textContent = await r.text();
}

function escapeHtml(s){ return (s||'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escapeAttr(s){ return (s||'').replace(/"/g,'&quot;'); }

boot();
</script>
</body>
</html>
"""


# ── 路由注册 ───────────────────────────────────────────────────────
def register_admin_routes(app) -> None:
    @app.get("/admin", response_class=HTMLResponse)
    @app.get("/admin/", response_class=HTMLResponse)
    def admin_page():
        # 页面内自行按 /admin/api/me 决定显示登录还是控制台，无需服务端分流。
        return HTMLResponse(ADMIN_HTML)

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
