// 验证主题兜底 CSS 是否跨导航保留（加载页上可见）
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
const r = await call('Runtime.evaluate', {
  expression: `({
    url: location.search,
    hasBootCss: [...document.styleSheets].some((s) => {
      try {
        return [...s.cssRules].some((r2) => r2.cssText.includes('151517'));
      } catch { return false; }
    }),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  })`,
  returnByValue: true,
})
console.log(JSON.stringify(r.result.value))
ws.close()
process.exit(0)
