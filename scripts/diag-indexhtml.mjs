// 抓 index.html 的 bootThemeScript preference 值
const targets = await (await fetch('http://127.0.0.1:9223/json')).json()
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
const r = await call('Runtime.evaluate', {
  expression: `fetch(location.href).then((r) => r.text()).then((t) => {
    const i = t.indexOf('preference');
    return { around: t.slice(Math.max(0, i - 250), i + 350), hasThemeScript: t.includes('data-ds-dark-theme') };
  })`,
  returnByValue: true,
  awaitPromise: true,
})
console.log(JSON.stringify(r.result.value, null, 1))
ws.close()
process.exit(0)
