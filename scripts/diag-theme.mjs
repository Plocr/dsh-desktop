// 验证加载页 ?theme= 强制主题（settings.yaml 当前为 dark）
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

async function read() {
  const r = await call('Runtime.evaluate', {
    expression: `(() => {
      const body = getComputedStyle(document.body);
      const title = getComputedStyle(document.querySelector('.title'));
      const path = document.querySelector('.whale path');
      return {
        url: location.search,
        themeAttr: document.documentElement.dataset.theme || null,
        bodyBg: body.backgroundColor,
        titleColor: title.color,
        pathFill: path ? path.getAttribute('fill') : null,
      };
    })()`,
    returnByValue: true,
  })
  return r.result.value
}

// 1) 无 ?theme：跟随媒体查询（模拟 light）
await call('Page.navigate', { url: 'file:///E:/Dsh/dsh-desktop/resources/shell-pages/loading.html' })
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await sleep(600)
console.log('no-theme + media light:', JSON.stringify(await read()))

// 2) ?theme=dark 强制深色（即使 media light）
await call('Page.navigate', { url: 'file:///E:/Dsh/dsh-desktop/resources/shell-pages/loading.html?theme=dark' })
await sleep(600)
console.log('?theme=dark + media light:', JSON.stringify(await read()))

// 3) ?theme=light 强制浅色（即使 media dark）
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
await call('Page.navigate', { url: 'file:///E:/Dsh/dsh-desktop/resources/shell-pages/loading.html?theme=light' })
await sleep(600)
console.log('?theme=light + media dark:', JSON.stringify(await read()))

// 4) 壳真实流程：settings=dark 时 showLoading 传 ?theme=dark（重启 harness 观察）
ws.close()
process.exit(0)
