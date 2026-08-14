// 读取 harness UI 背景/主题色
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
  expression: `(() => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const v = (n) => root.getPropertyValue(n).trim();
    return {
      bodyBg: body.backgroundColor,
      bodyColor: body.color,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      cssVars: ['--bg','--bg-1','--bg-2','--surface','--panel','--accent','--primary','--text','--text-1','--border']
        .map(n => n + '=' + v(n))
        .filter(x => !x.endsWith('=')),
      themeAttr: document.documentElement.getAttribute('data-theme') || document.documentElement.className.slice(0, 40),
    };
  })()`,
  returnByValue: true,
})
console.log(JSON.stringify(r.result.value, null, 1))
ws.close()
process.exit(0)
