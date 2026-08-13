/**
 * CDP 驱动脚本：连接 Electron 页面，探查 DOM 结构（辅助 M1 验收）。
 * 用法: node scripts/cdp.mjs <eval-js>
 */
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))
if (!page) {
  console.error('no page target')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data))
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) p.reject(new Error(JSON.stringify(m.error)))
    else p.resolve(m.result)
  }
}
await new Promise((resolve) => (ws.onopen = resolve))
const expr = process.argv[2] ?? 'document.title'
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
if (r.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails))
} else {
  console.log(JSON.stringify(r.result?.value ?? r.result, null, 2))
}
ws.close()
process.exit(0)
