// CDP 辅助：连 headless Chrome，抓 JS 异常/console，执行表达式
const BASE = 'http://127.0.0.1:9223';

async function newTab(url) {
  const r = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, {method:'PUT'});
  return await r.json();
}
async function closeTab(id) { await fetch(`${BASE}/json/close/${id}`); }

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function makeClient(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  function send(method, params={}) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, {resolve, reject});
      ws.send(JSON.stringify({id: mid, method, params}));
    });
  }
  return {send, events};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evaluate(client, expr) {
  const r = await client.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
  if (r.exceptionDetails) return {error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description||'')};
  return {value: r.result.value};
}

export {newTab, closeTab, connect, makeClient, evaluate, sleep};
