/* 管理面板 UI 回归测试（Chrome CDP 真实执行 JS）。

为什么需要这个：2026-11-20 面板重构时，只做 py_compile + node --check + 静态 HTML 校验，
没真正执行 JS，漏掉了 renderDashboard 里的 insertBefore 异常——导致所有 load 函数没跑、
页面全是「加载中…」。本测试用 headless Chrome + CDP 真实加载页面、抓 JS 异常、检查各页面 DOM 内容。

前置：
  - Google Chrome 已安装（/Applications/Google Chrome.app）
  - 19529 服务已启动且加载了当前代码（改了 admin_panel.py 必须 restart！）
  - node 26+（内置 WebSocket）

运行：node tests/test_admin_ui.mjs
*/
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {newTab, closeTab, connect, makeClient, evaluate, sleep} from './cdp_helper.mjs';

const PORT = 9224;
const ADMIN = 'http://127.0.0.1:19529/admin';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CONF = process.env.VOICE_HOME ? `${process.env.VOICE_HOME}/voice.conf` : `${process.env.HOME}/.app-product/voice/voice.conf`;

let failures = 0;
function check(name, cond, extra='') {
  console.log(`[${cond?'PASS':'FAIL'}] ${name} ${extra}`);
  if (!cond) failures++;
}

// 启动 headless Chrome
const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--disable-gpu',`--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/cdp_admin_ui_${process.pid}`,'about:blank'
], {stdio:'ignore'});
await sleep(1200);

// 覆盖 helper 的 BASE（cdp_helper 用 9223）
const BASE = `http://127.0.0.1:${PORT}`;
async function openTab(url) {
  const r = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, {method:'PUT'});
  return await r.json();
}
async function shutTab(id) { await fetch(`${BASE}/json/close/${id}`); }

try {
  const pw = readFileSync(CONF,'utf8').split('\n').find(l=>l.trim().startsWith('ADMIN_PASSWORD='))?.split('=',2)[1].trim();
  check('voice.conf 有 ADMIN_PASSWORD', !!pw);

  const tab = await openTab(ADMIN);
  const ws = await connect(tab.webSocketDebuggerUrl);
  const c = makeClient(ws);
  await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Page.enable');
  await sleep(1000);

  // 登录 + 重载
  await evaluate(c, `(async()=>{await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'user=admin&password=${pw}'});location.reload();})()`);
  await sleep(2500);

  // 1) 零 JS 异常
  const errs = c.events.filter(e=>e.method==='Runtime.exceptionThrown');
  check('无 JS 异常', errs.length===0, errs.length?errs.map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text).join('; '):'');

  // 2) 6 个页面 section + 导航项
  let r = await evaluate(c, `JSON.stringify({
    sections:[...document.querySelectorAll('.page')].map(s=>s.dataset.page),
    navs:[...document.querySelectorAll('.nav-item')].map(b=>b.dataset.nav)
  })`);
  const v = JSON.parse(r.value||'{}');
  const pages = ['overview','models','accounts','access','security','test','logs'];
  check('7 个页面 section 齐全', pages.every(p=>(v.sections||[]).includes(p)), JSON.stringify(v.sections));
  check('7 个导航项齐全', pages.every(p=>(v.navs||[]).includes(p)), JSON.stringify(v.navs));

  // 3) 各页面内容非空（不是「加载中…」）
  const checks = [
    ['logs', 'logs', null],
    ['models', 'llmTableWrap', null],
    ['accounts', 'userList', null],
    ['access', 'as-keys', null],
    ['access', 'as-rates', '策略'],
    ['security', 'securityBody', 'API-Key'],
  ];
  for (const [page, id, keyword] of checks) {
    await evaluate(c, `document.querySelector('.nav-item[data-nav="${page}"]').click()`);
    await sleep(350);
    if (page==='access') {
      const sub = id==='as-keys'?'keys':'rates';
      await evaluate(c, `document.querySelector('#accessSubTabs [data-astab="${sub}"]').click()`);
      await sleep(300);
    }
    r = await evaluate(c, `(document.getElementById('${id}')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120)`);
    const text = r.value||'';
    const ok = text.length>10 && !text.startsWith('加载中') && (!keyword || text.includes(keyword));
    check(`${page}/${id} 有真实内容`, ok, text.slice(0,50));
  }

  // 4) 全程零异常（切页后）
  const errs2 = c.events.filter(e=>e.method==='Runtime.exceptionThrown');
  check('切页后仍无 JS 异常', errs2.length===0);

  ws.close(); await shutTab(tab.id);
} finally {
  chrome.kill('SIGTERM');
}

console.log(`\n== SUMMARY: ${failures===0?'ALL PASS':failures+' FAILED'} ==`);
process.exit(failures===0?0:1);
