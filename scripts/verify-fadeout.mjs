// 验证 __fadeOut 钩子：调用后 stage 加 fading class 且 opacity 归零
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
await sleep(2000)

const before = await evalJ(`(() => { const st = document.getElementById('stage'); return { cls: st.className, opacity: getComputedStyle(st).opacity }; })()`)
console.log('before:', JSON.stringify(before))

const r = await evalJ('window.__fadeOut().then(() => "resolved")')
console.log('fadeOut promise:', JSON.stringify(r))

const after = await evalJ(`(() => { const st = document.getElementById('stage'); return { cls: st.className, opacity: getComputedStyle(st).opacity }; })()`)
console.log('after:', JSON.stringify(after))
ws.close()
process.exit(0)
