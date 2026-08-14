// 验证主题兜底变量：:root 兜底存在 + harness body 变量覆盖（值一致）
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
const r = await call('Runtime.evaluate', {
  expression: `(() => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const readVar = (el, n) => el.getPropertyValue(n).trim();
    return {
      url: location.href.slice(0, 60),
      rootBgBase: readVar(root, '--dsw-alias-bg-base'),
      rootLabel: readVar(root, '--dsw-alias-label-primary'),
      bodyBg: body.backgroundColor,
      bodyColor: body.color,
      darkAttr: document.body.hasAttribute('data-ds-dark-theme'),
      bootVisible: [...document.querySelectorAll('div')].some((d) => (d.className + '').includes('boot')),
    };
  })()`,
  returnByValue: true,
})
console.log(JSON.stringify(r.result.value, null, 1))
ws.close()
process.exit(0)
