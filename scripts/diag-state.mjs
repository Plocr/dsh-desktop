// 验证 system 偏好：themeSource 应跟随真实系统（深色）
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find((t) => t.type === 'page')
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
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
}
await new Promise((r) => (ws.onopen = r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evalJ = async (e) => (await call('Runtime.evaluate', { expression: e, returnByValue: true })).result.value
console.log('state:', JSON.stringify(await evalJ(`({ darkAttr: document.body.hasAttribute('data-ds-dark-theme'), bodyBg: getComputedStyle(document.body).backgroundColor, mediaDark: matchMedia('(prefers-color-scheme: dark)').matches })`)))
ws.close()
process.exit(0)
