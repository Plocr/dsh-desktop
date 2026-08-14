// 受控可见性验证：CDP 强制页面 visible 后测帧增长
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

await call('Page.navigate', { url: 'file:///E:/Dsh/dsh-desktop/resources/shell-pages/loading.html' })
await call('Emulation.setFocusEmulationEnabled', { enabled: true })
try {
  await call('Emulation.setPageVisibilityState', { visibilityState: 'visible' })
  console.log('forced visibility: visible')
} catch (e) {
  console.log('setPageVisibilityState unsupported:', e.message.slice(0, 80))
}
await sleep(2500)
console.log('vis:', await evalJ('document.visibilityState'))
const f1 = await evalJ('window.__frames || 0')
await sleep(1200)
const f2 = await evalJ('window.__frames || 0')
console.log('frames in 1.2s:', f2 - f1)
const lit = await evalJ(`(() => {
  const c = document.getElementById('whale');
  if (!c) return -1;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 8) {
    const lum = (d[i] + d[i+1] + d[i+2]) / 3;
    if (lum > 90) n++;
  }
  return n;
})()`)
console.log('lit pixels:', lit)
ws.close()
process.exit(0)
