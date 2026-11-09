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
  .who-wrap { display:flex; align-items:center; gap:12px; }
  main { max-width:920px; margin:0 auto; padding:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  .card h2 { font-size:14px; margin:0 0 12px; color:var(--mut); font-weight:600; text-transform:uppercase; letter-spacing:.04em; cursor:pointer; user-select:none; display:flex; justify-content:space-between; align-items:center; }
  .card h2::after { content:'▾'; font-size:16px; line-height:1; color:var(--fg); opacity:.8; }
  .card.collapsed > *:not(h2) { display:none; }
  .card.collapsed > h2 { margin-bottom:0; }
  .card.collapsed > h2::after { content:'▸'; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  button { background:var(--acc); color:#fff; border:0; border-radius:8px; padding:8px 14px; cursor:pointer; font-size:13px; }
  button.sec { background:#2a2f3a; color:var(--fg); }
  button.danger { background:#3a1f24; color:#ff8a8a; }
  button.full { width:100%; }
  button:disabled { opacity:.5; cursor:default; }
  input[type=text], input[type=password] { background:#0f1115; border:1px solid var(--line); color:var(--fg);
           border-radius:8px; padding:8px 10px; font-size:13px; width:260px; }
  label { display:block; color:var(--mut); margin:10px 0 4px; font-size:12px; }
  textarea { background:#0f1115; border:1px solid var(--line); color:var(--fg); border-radius:8px;
             padding:9px 11px; font-size:14px; font-family:inherit; line-height:1.5; resize:vertical; width:100%; box-sizing:border-box; }
  textarea:focus { outline:none; border-color:var(--acc); }
  select { background:#0f1115; border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:8px 10px; font-size:13px; width:100%; box-sizing:border-box; }
  .chk { display:flex; align-items:center; gap:6px; color:var(--mut); font-size:12px; margin-top:10px; }
  .chk input { width:auto; }
  .tabs { display:flex; gap:8px; margin:0 0 12px; flex-wrap:wrap; }
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
  table.cfg-table th, table.cfg-table td { border:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; font-size:12px; }
  table.cfg-table th { background:#161a22; color:var(--mut); font-weight:600; }
  table.cfg-table input { width:100%; box-sizing:border-box; background:#0f1115; border:1px solid var(--line); color:var(--fg); border-radius:6px; padding:5px 7px; font-size:12px; }
  table.cfg-table .prov-cell { background:#14171f; }
  table.cfg-table .prov-models { color:var(--mut); font-size:11px; margin-top:4px; line-height:1.5; }
  table.cfg-table .row-act { white-space:nowrap; }
  table.cfg-table .mini { padding:4px 8px; font-size:12px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; margin-right:6px; }
  .b-ok { background:#13352a; color:var(--ok); }
  .b-err { background:#3a1f24; color:var(--err); }
  .b-mut { background:#23272f; color:var(--mut); }
  #login { max-width:340px; margin:80px auto; }
  .err { color:var(--err); font-size:13px; font-weight:700; min-height:18px; margin-top:8px; background:#2a1417; border:1px solid #5a2a2f; border-radius:6px; padding:6px 8px; white-space:pre-wrap; word-break:break-all; }
  .muted { color:var(--mut); }
  a { color:var(--acc); }
</style>
</head>
<body>
<header><h1>语音代理管理</h1><div class="who-wrap"><span id="who" class="muted"></span><button class="sec" id="logout">退出登录</button></div></header>
<main id="app"></main>

<script>
const ASR_SAMPLE_B64 = "__ASR_B64__";  // 内嵌的固定测试音频（mp3 base64），由服务端注入
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

// ── 配置卡片（LLM / ASR / TTS / 其它配置 四个 tab，置于测试之上）──
const CFG_TABS = {
  llm: ['LLM_ENABLED','LLM_UPSTREAM_BASE_URL','LLM_UPSTREAM_API_KEY','LLM_UPSTREAM_MODEL','LLM_UPSTREAM_PROTOCOL','LLM_UPSTREAM_VENDOR'],
  asr: ['VOICE_UPSTREAM_BASE_URL','VOICE_UPSTREAM_API_KEY','STT_UPSTREAM_BASE_URL','STT_UPSTREAM_API_KEY','STT_UPSTREAM_MODEL'],
  tts: ['TTS_UPSTREAM_VOICE','TTS_UPSTREAM_MODEL','TTS_UPSTREAM_BASE_URL','TTS_UPSTREAM_API_KEY','TTS_VOICE'],
};
const CFG_LABEL = {
  LLM_ENABLED:'LLM 启用（auto/on/off）', LLM_UPSTREAM_BASE_URL:'上游地址（OpenAI 兼容）', LLM_UPSTREAM_API_KEY:'API Key（留空=不修改）',
  LLM_UPSTREAM_MODEL:'模型名', LLM_UPSTREAM_PROTOCOL:'协议（openai/ollama/...）', LLM_UPSTREAM_VENDOR:'厂商（ollama/deepseek/...）',
  VOICE_UPSTREAM_BASE_URL:'共享上游（ASR/TTS 共用）', VOICE_UPSTREAM_API_KEY:'共享 Key（ASR/TTS 共用）',
  STT_UPSTREAM_BASE_URL:'ASR 专属地址（留空用共享）', STT_UPSTREAM_API_KEY:'ASR 专属 Key（留空用共享）', STT_UPSTREAM_MODEL:'ASR 模型名',
  TTS_UPSTREAM_VOICE:'默认音色', TTS_UPSTREAM_MODEL:'TTS 模型名（可选）', TTS_UPSTREAM_BASE_URL:'TTS 专属地址（留空用共享）',
  TTS_UPSTREAM_API_KEY:'TTS 专属 Key（留空用共享）', TTS_VOICE:'TTS 兜底音色',
};
const CFG_KNOWN = new Set([...CFG_TABS.llm, ...CFG_TABS.asr, ...CFG_TABS.tts]);
const isSecret = k => /API_KEY|PASSWORD|SECRET|DSN/i.test(k);
let cfgOrig = {};
let cfgOtherKeys = [];

function buildConfigCard(){
  const fields = (id,keys)=> keys.map(k=>{
    if(k==='LLM_ENABLED') return `<label>${CFG_LABEL[k]}</label><select id="cfg_${k}"><option value="auto">auto</option><option value="on">on</option><option value="off">off</option></select>`;
    const secret = isSecret(k);
    return `<label>${CFG_LABEL[k]||k}</label><input id="cfg_${k}"${secret?' type="password" placeholder="（留空则不修改）"':''} />`;
  }).join('') + `<div class="row" style="margin-top:12px"><button id="cfgSave_${id}">保存</button><span class="hint" id="cfgStat_${id}" style="margin-left:10px"></span></div>`;
  return el(`<div class="card"><h2>配置</h2>
    <div class="tabs" id="cfgTabs">
      <button class="tab active" data-ctab="llm">LLM</button>
      <button class="tab" data-ctab="asr">ASR</button>
      <button class="tab" data-ctab="tts">TTS</button>
      <button class="tab" data-ctab="other">其它配置</button>
    </div>
    <div id="c-llm" class="cfgpane">${fields('llm',CFG_TABS.llm)}</div>
    <div id="c-asr" class="cfgpane" hidden>${fields('asr',CFG_TABS.asr)}</div>
    <div id="c-tts" class="cfgpane" hidden>${fields('tts',CFG_TABS.tts)}</div>
    <div id="c-other" class="cfgpane" hidden><div id="cfgOther"></div><div class="row" style="margin-top:12px"><button id="cfgSave_other">保存</button><span class="hint" id="cfgStat_other" style="margin-left:10px"></span></div></div>
  </div>`);
}

async function loadConfig(){
  try{
    const r = await fetch('/admin/api/config',{credentials:'same-origin'});
    if(!r.ok) return;
    cfgOrig = await r.json();
    ['llm','asr','tts'].forEach(t=>CFG_TABS[t].forEach(k=>{ const inp=document.getElementById('cfg_'+k); if(inp) inp.value = isSecret(k)?'':(cfgOrig[k]||''); }));
    const other = Object.keys(cfgOrig).filter(k=>!CFG_KNOWN.has(k));
    cfgOtherKeys = other;
    const body=document.getElementById('cfgOther'); if(!body) return;
    body.innerHTML = other.map(k=>`<label>${k}</label><input id="cfg_${k}"${isSecret(k)?' type="password" placeholder="（留空则不修改）"':''} />`).join('');
    other.forEach(k=>{ const inp=document.getElementById('cfg_'+k); if(inp) inp.value = isSecret(k)?'':(cfgOrig[k]||''); });
  }catch(_){}
}

function cfgVal(k){
  const inp=document.getElementById('cfg_'+k); if(!inp) return undefined;
  if(inp.type==='password'){ return inp.value ? inp.value : null; }  // 空=不发送，保留原密钥
  return inp.value;
}

function wireConfig(){
  document.querySelectorAll('#cfgTabs .tab').forEach(t=>{
    t.onclick=()=>{ document.querySelectorAll('#cfgTabs .tab').forEach(x=>x.classList.remove('active')); t.classList.add('active');
      ['llm','asr','tts','other'].forEach(p=>{ const e=document.getElementById('c-'+p); if(e) e.hidden=(t.dataset.ctab!==p); }); };
  });
  const save = async (id,keys,statId)=>{
    const stat=document.getElementById(statId); stat.className='hint'; stat.textContent='保存中…';
    const patch={}; keys.forEach(k=>{ const v=cfgVal(k); if(v!==undefined && v!==null) patch[k]=v; });
    try{
      const r=await fetch('/admin/api/config',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){ stat.className='err'; stat.textContent='失败：'+(d.detail||r.status); return; }
      stat.className='hint'; stat.textContent='已保存'+(d.remote_push&&d.remote_push.ok?'（已同步远端）':'');
      loadConfig();
    }catch(e){ stat.className='err'; stat.textContent='错误：'+e.message; }
  };
  ['llm','asr','tts'].forEach(t=>{ const b=document.getElementById('cfgSave_'+t); if(b) b.onclick=()=>save(t,CFG_TABS[t],'cfgStat_'+t); });
  const ob=document.getElementById('cfgSave_other'); if(ob) ob.onclick=()=>save('other',cfgOtherKeys,'cfgStat_other');
}

async function renderDashboard(){
  const app = document.getElementById('app'); app.innerHTML='';

  app.appendChild(buildConfigCard());

  app.appendChild(el(`<div class="card"><h2>测试</h2>
    <div class="row" style="margin-bottom:12px">
      <span class="muted">鉴权（若推理接口开启了 API Key）：</span>
      <input id="testKey" type="password" placeholder="可选：API Key" />
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="llm">对话 LLM</button>
      <button class="tab" data-tab="asr">语音识别 ASR</button>
      <button class="tab" data-tab="tts">语音合成 TTS</button>
    </div>

    <div id="t-llm" class="tabpane">
      <label>提供商</label>
      <select id="llmProvider"><option value="">（默认路由）</option></select>
      <label>模型（切到本页自动拉取，可留空用默认）</label>
      <select id="llmModel"><option value="">（沿用上游默认）</option></select>
      <label>协议</label>
      <select id="llmProtocol">
        <option value="openai_chat_completions">openai_chat_completions（OpenAI 对话）</option>
        <option value="azure_openai_chat_completions">azure_openai_chat_completions（Azure OpenAI）</option>
        <option value="openai_responses">openai_responses（OpenAI Responses）</option>
        <option value="anthropic_messages">anthropic_messages（Anthropic）</option>
        <option value="gemini">gemini（Google Gemini）</option>
      </select>
      <div class="hint" id="llmProtoDesc" style="margin-top:4px"></div>
      <label class="chk"><input type="checkbox" id="llmStream" checked /> 流式（SSE）</label>
      <label>提示词（固定，不可编辑）</label>
      <div id="llmInput" class="fixed-prompt">请只回复 ok 两个字。</div>
      <div id="llmThinkWrap" hidden style="margin-top:10px">
        <div class="muted" style="margin-bottom:4px">思考过程</div>
        <pre id="llmThink" class="think"></pre>
      </div>
      <div class="muted" style="margin-top:10px">回复</div>
      <pre id="llmOut" class="muted">回复将在这里流式显示。</pre>
      <div class="row" style="margin-top:12px">
        <button id="llmGo" style="flex:1">发送</button>
        <button class="sec" id="llmStop" style="flex:1">停止</button>
      </div>
      <span class="hint" id="llmStatus" style="display:block; margin-top:6px"></span>
    </div>

    <div id="t-asr" class="tabpane" hidden>
      <div class="muted" style="margin-bottom:8px">点录音可把上面的试听音频替换成你录的，识别也用替换后的；「还原」恢复内置样本。</div>
      <audio id="asrPlayer" controls style="width:100%;margin:6px 0 12px"></audio>
      <div class="row">
        <button id="asrRec">录音</button>
        <button id="asrRecStop" class="danger" disabled>停止</button>
        <button id="asrRevert" class="sec" style="display:none">还原</button>
        <span class="hint" id="asrRecMsg"></span>
      </div>
      <pre id="asrOut" class="muted">识别结果将显示在这里。</pre>
      <button id="asrGo" class="full" style="margin-top:12px">识别</button>
      <span class="hint" id="asrMsg" style="display:block; margin-top:6px"></span>
    </div>

    <div id="t-tts" class="tabpane" hidden>
      <label>文本</label>
      <textarea id="ttsText" rows="2">你好。</textarea>
      <label>音色</label>
      <select id="ttsVoice"></select>
      <div class="hint" id="ttsVoiceDesc" style="margin-top:4px"></div>
      <audio id="ttsAudio" controls style="margin-top:10px; width:100%"></audio>
      <button id="ttsGo" class="full" style="margin-top:12px">合成</button>
      <span class="hint" id="ttsMsg" style="display:block; margin-top:6px"></span>
    </div>
  </div>`));

  app.appendChild(el(`<div class="card"><h2>日志（voice.log）</h2>
    <div class="row" style="margin-bottom:10px">
      <button class="sec" id="logRefresh">刷新日志</button>
      <span class="muted">最近 200 行</span></div>
    <pre id="logs">加载中…</pre>
  </div>`));

  document.getElementById('logout').onclick = async ()=>{
    await api('/admin/logout',{method:'POST'}); boot();
  };
  app.querySelector('#logRefresh').onclick = loadLogs;

  wireConfig(); loadConfig();

  // 卡片可折叠：点击标题（配置 / 测试 / 日志）展开或收起
  app.querySelectorAll('.card > h2').forEach(h=>{ h.onclick=()=>h.parentElement.classList.toggle('collapsed'); });

  // ---- 测试面板逻辑 ----
  const authHdr = ()=>{ const k=(document.getElementById('testKey').value||'').trim(); return k?{'Authorization':'Bearer '+k}:{}; };

  // 标签页切换（只作用于测试卡片的 tab，配置卡片的 tab 由 wireConfig 单独处理，互不干扰）
  const tabs = app.querySelectorAll('.tab[data-tab]');
  tabs.forEach(t=>t.onclick=()=>{
    tabs.forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    ['llm','asr','tts'].forEach(k=>{ document.getElementById('t-'+k).hidden = (t.dataset.tab!==k); });
    if(t.dataset.tab==='llm'){ populateLlmModels(); populateLlmProviders(); }
  });

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
    if(def){ const o=document.createElement('option'); o.value=def; o.textContent=def+'（默认）'; voiceSel.appendChild(o); }
    voiceSel.value = def || VOICE_CATALOG[0].id;
    VOICE_DESC.textContent = '音色说明：' + voiceDesc(voiceSel.value) + '　·　参数：音色语言须与文本一致（含方言：台湾腔/粤语配对应文本），否则上游 502';
  };
  voiceSel.onchange = ()=>{ VOICE_DESC.textContent = '音色说明：' + voiceDesc(voiceSel.value) + '　·　参数：音色语言须与文本一致（含方言：台湾腔/粤语配对应文本），否则上游 502'; };
  // 从对外接口拉取最新音色目录（接口不可用时回退兜底）
  fetch('/voide/v1/audio/voices',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(d=>{
    if(d && Array.isArray(d.voices) && d.voices.length){ VOICE_CATALOG=d.voices; fillVoices(d.default); }
  }).catch(()=>{});
  api('/admin/api/status').then(r=>r.ok?r.json():null).then(s=>{
    const def = s && s.health && s.health.tts_voice;
    fillVoices(def||undefined);
  }).catch(()=>fillVoices());

  // TTS 合成
  document.getElementById('ttsGo').onclick = async ()=>{
    const msg=document.getElementById('ttsMsg'), audio=document.getElementById('ttsAudio');
    msg.textContent='合成中…'; msg.className='hint'; audio.src='';
    try{
      const r=await fetch('/voide/v1/audio/speech',{method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json',...authHdr()},
        body:JSON.stringify({input:document.getElementById('ttsText').value,voice:voiceSel.value,response_format:'wav',speed:1.0})});
      if(!r.ok){ msg.textContent='失败 '+r.status+'：'+(await r.text()).slice(0,200); msg.className='err'; return; }
      const blob=await r.blob(); audio.src=URL.createObjectURL(blob);
      msg.textContent='完成（'+(blob.size/1024).toFixed(1)+' KB）'; msg.className='hint';
    }catch(e){ msg.textContent='错误：'+e.message; msg.className='err'; }
  };

  // LLM 模型列表（切到本页自动拉取，无需单独按钮）
  async function populateLlmModels(){
    const sel=document.getElementById('llmModel');
    try{
      const r=await fetch('/llm/v1/models',{credentials:'same-origin',headers:{...authHdr()}});
      if(!r.ok) return;
      const d=await r.json(); const ids=(d.data||[]).map(x=>x.id).filter(Boolean);
      sel.innerHTML='<option value="">（沿用上游默认）</option>';
      ids.forEach(id=>{ const o=document.createElement('option'); o.value=id; o.textContent=id; sel.appendChild(o); });
    }catch(_){}
  }

  // LLM 协议下拉的中文说明（选中后展示）
  const PROTOCOL_DESC = {
    'openai_chat_completions': 'OpenAI Chat Completions 线协议（/v1/chat/completions，deepseek / 通义等大多兼容）',
    'azure_openai_chat_completions': 'Azure OpenAI（路径带 /openai/deployments/{model}，需 api-version）',
    'openai_responses': 'OpenAI Responses API（/v1/responses）',
    'anthropic_messages': 'Anthropic Messages（/v1/messages，请求与流式响应双向翻译）',
    'gemini': 'Google Gemini（generateContent / streamGenerateContent，alt=sse）',
  };
  const updateProtoDesc = ()=>{ document.getElementById('llmProtoDesc').textContent = (PROTOCOL_DESC[document.getElementById('llmProtocol').value]||'') + '；是否流式由下方「流式」勾选框单独控制，与协议无关。'; };
  document.getElementById('llmProtocol').onchange = updateProtoDesc;
  updateProtoDesc();

  // LLM 对话（支持协议 / 提供商 / 流式开关）
  let llmCtrl=null;
  document.getElementById('llmGo').onclick = async ()=>{
    const status=document.getElementById('llmStatus'), out=document.getElementById('llmOut');
    const thinkWrap=document.getElementById('llmThinkWrap'), thinkEl=document.getElementById('llmThink');
    out.textContent=''; thinkEl.textContent=''; thinkWrap.hidden=true; status.textContent='请求中…'; status.className='hint';
    llmCtrl=new AbortController();
    try{
      const model=document.getElementById('llmModel').value.trim();
      const vendor=document.getElementById('llmProvider').value.trim();
      const protocol=document.getElementById('llmProtocol').value.trim();
      const stream=document.getElementById('llmStream').checked;
      const body={messages:[{role:'user',content:document.getElementById('llmInput').textContent}],stream};
      if(model) body.model=model;          // 留空则让代理用上游默认模型，不要发 "default"
      if(vendor) body.vendor=vendor;        // 显式指定提供商，覆盖模型路由
      if(protocol) body.protocol=protocol;  // 显式指定线协议，覆盖入口配置
      const r=await fetch('/llm/v1/chat/completions',{method:'POST',credentials:'same-origin',signal:llmCtrl.signal,
        headers:{'content-type':'application/json',...authHdr()},
        body:JSON.stringify(body)});
      if(!r.ok){ status.textContent='失败 '+r.status+'：'+(await r.text()).slice(0,200); status.className='err'; return; }
      if(stream){
        const reader=r.body.getReader(), dec=new TextDecoder(); let buf='', text='', think='';
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
              if(d.reasoning_content){ think+=d.reasoning_content; thinkEl.textContent=think; thinkWrap.hidden=false; }
              if(d.content){ text+=d.content; out.textContent=text; }
            }catch(_){}
          }
        }
      } else {
        const d=await r.json();
        const ch=(d.choices&&d.choices[0]&&d.choices[0].message)||{};
        const think=ch.reasoning_content||'';
        const text=ch.content||JSON.stringify(d);
        if(think){ thinkEl.textContent=think; thinkWrap.hidden=false; }
        out.textContent=text;
      }
      status.textContent='完成'; status.className='hint';
    }catch(e){ if(e.name==='AbortError'){ status.textContent='已停止'; status.className='hint'; } else { status.textContent='错误：'+e.message; status.className='err'; } }
  };
  document.getElementById('llmStop').onclick = ()=>{ if(llmCtrl) llmCtrl.abort(); };

  // LLM 提供商列表（对外接口拉取，失败则用兜底）
  async function populateLlmProviders(){
    const sel=document.getElementById('llmProvider');
    try{
      const r=await fetch('/llm/v1/providers',{credentials:'same-origin'});
      if(!r.ok) return;
      const d=await r.json(); const ps=(d.providers||[]).filter(p=>p.vendor && p.vendor!=='(未指定)');
      if(!ps.length) return;
      sel.innerHTML='<option value="">（默认路由）</option>';
      ps.forEach(p=>{ const o=document.createElement('option'); o.value=p.vendor; o.textContent=p.vendor+(p.host?('　('+p.host+')'):''); sel.appendChild(o); });
    }catch(_){}
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
        document.getElementById('asrRecMsg').textContent='已替换试听音频（识别将用这段）';
        mediaStream.getTracks().forEach(t=>t.stop());
      };
      mediaRec.start();
      document.getElementById('asrRec').disabled=true; document.getElementById('asrRecStop').disabled=false;
      document.getElementById('asrRecMsg').textContent='录音中…';
    }catch(e){ document.getElementById('asrRecMsg').textContent='无法录音：'+e.message; }
  };
  document.getElementById('asrRecStop').onclick = ()=>{
    if(mediaRec&&mediaRec.state!=='inactive') mediaRec.stop();
    document.getElementById('asrRec').disabled=false; document.getElementById('asrRecStop').disabled=true;
  };
  document.getElementById('asrRevert').onclick = ()=>{
    asrBlob=null;
    if(ASR_SAMPLE_B64) document.getElementById('asrPlayer').src='data:audio/wav;base64,'+ASR_SAMPLE_B64;
    document.getElementById('asrRevert').style.display='none';
    document.getElementById('asrRecMsg').textContent='已还原内置样本';
  };
  document.getElementById('asrGo').onclick = async ()=>{
    const msg=document.getElementById('asrMsg'), out=document.getElementById('asrOut');
    msg.className='hint';
    let blob=asrBlob, fname='record.wav';
    if(!blob){
      if(!ASR_SAMPLE_B64){ msg.textContent='未内嵌音频'; return; }
      const bin=atob(ASR_SAMPLE_B64); const bytes=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      blob=new Blob([bytes],{type:'audio/wav'}); fname='sample.wav';
    }
    msg.textContent='识别中…';
    try{
      const fd=new FormData(); fd.append('file',blob,fname); fd.append('model','whisper-1');
      const r=await fetch('/voide/v1/audio/transcriptions',{method:'POST',credentials:'same-origin',headers:{...authHdr()},body:fd});
      if(!r.ok){ msg.textContent='失败 '+r.status+'：'+(await r.text()).slice(0,200); msg.className='err'; return; }
      const d=await r.json(); out.textContent=d.text||'(空)'; msg.textContent='完成'; msg.className='hint';
    }catch(e){ msg.textContent='错误：'+e.message; msg.className='err'; }
  };
  // 固定音频可直接在页面播放试听
  if(ASR_SAMPLE_B64) document.getElementById('asrPlayer').src='data:audio/wav;base64,'+ASR_SAMPLE_B64;

  populateLlmModels(); populateLlmProviders();  // 初始页就是 LLM，先拉一次模型 / 提供商列表
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

# 把内嵌的固定测试音频（mp3 base64）注入页面，避免在源码里放大段字面量。
try:
    _asr_b64_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "asr_sample.b64")
    with open(_asr_b64_path, encoding="utf-8") as _f:
        _ASR_SAMPLE_B64 = _f.read().strip()
except Exception:
    _ASR_SAMPLE_B64 = ""
ADMIN_HTML = ADMIN_HTML.replace("__ASR_B64__", _ASR_SAMPLE_B64)


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

    @app.get("/admin/api/llm-pool", dependencies=[Depends(require_admin)])
    def admin_llm_pool():
        """LLM 上游按提供商分组返回：每组含厂商、协议、去重模型列表、账号清单（地址/Key）。
        供配置页表格渲染（提供商上下合并、模型映射）使用。"""
        entries = upstream_pool.load_pool("LLM")
        groups: dict[str, Any] = {}
        for e in entries:
            v = (e.get("vendor") or e.get("protocol") or "unknown")
            g = groups.setdefault(v, {"vendor": v, "protocol": e.get("protocol") or "", "models": set(), "accounts": []})
            m = e.get("model")
            if m:
                g["models"].add(m)
            g["accounts"].append({"base_url": e.get("base_url", ""), "api_key": e.get("api_key", "")})
        out = [
            {"vendor": g["vendor"], "protocol": g["protocol"], "models": sorted(g["models"]), "accounts": g["accounts"]}
            for g in groups.values()
        ]
        return {"groups": out}

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
