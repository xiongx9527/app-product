import WebSocket from 'ws'
const url = process.argv[2]
const expr = process.argv[3]
const ws = new WebSocket(url)
let id = 1
ws.on('open', () => {
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
})
ws.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.id === id) {
    const r = m.result?.result
    console.log(JSON.stringify(r?.value ?? r ?? m.error, null, 2))
    ws.close(); process.exit(0)
  }
})
setTimeout(() => { console.log('timeout'); process.exit(1) }, 8000)
