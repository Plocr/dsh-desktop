// ASCII 形状验证：把 targets 渲染为字符网格，目检是否呈鲸鱼剪影
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
await call('Page.navigate', { url: 'file:///E:/Dsh/dsh-desktop/resources/shell-pages/loading.html' })
await call('Page.bringToFront')
await sleep(2500)
const r = await call('Runtime.evaluate', {
  expression: `(() => {
    const t = window.__targets || [];
    if (!t.length) return 'no targets';
    const CW = 60, CH = 22;
    const grid = new Array(CH).fill(0).map(() => new Array(CW).fill(' '));
    for (const p of t) {
      const gx = Math.min(CW - 1, Math.floor(p.x * CW));
      const gy = Math.min(CH - 1, Math.floor(p.y * CH));
      grid[gy][gx] = '#';
    }
    return grid.map((row) => row.join('')).join('\\n');
  })()`,
  returnByValue: true,
})
console.log(r.result.value)
ws.close()
process.exit(0)
