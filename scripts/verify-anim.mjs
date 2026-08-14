// 像素 hash 验证动画循环（三次采样，间隔 400ms）
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
const LOADING = 'file:///E:/Dsh/dsh-desktop/resources/shell-pages/loading.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await call('Page.navigate', { url: LOADING })
await call('Page.bringToFront')
await sleep(3500) // 等待粒子聚合（需窗口可见，hidden 时 rAF 会被暂停）

// 诊断状态
const diag = await call('Runtime.evaluate', {
  expression: `(() => {
    const c = document.getElementById('whale');
    return {
      canvas: c ? [c.width, c.height] : null,
      vis: document.visibilityState,
      errs: window.__errs || [],
      particles: window.__particles ? window.__particles.length : -1,
      running: window.__running ? window.__running() : false,
    };
  })()`,
  returnByValue: true,
})
console.log('diag:', JSON.stringify(diag.result.value))

const hash = () =>
  call('Runtime.evaluate', {
    expression: `(() => {
      const c = document.getElementById('whale');
      if (!c) return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 8) h = ((h * 33) ^ (d[i] + d[i+1] + d[i+2] + d[i+3])) | 0;
      return h;
    })()`,
    returnByValue: true,
  }).then((r) => r.result.value)
const h1 = await hash()
await sleep(400)
const h2 = await hash()
await sleep(400)
const h3 = await hash()
console.log('hashes:', h1, h2, h3, '| frames changing:', h1 !== h2 && h2 !== h3 ? 'YES (animation running)' : 'NO')
ws.close()
process.exit(0)