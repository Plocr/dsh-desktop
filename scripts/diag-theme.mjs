// 验证加载页双主题：dark/light 下背景与鲸鱼颜色
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
await sleep(1500)

async function read() {
  return (await call('Runtime.evaluate', {
    expression: `(() => {
      const body = getComputedStyle(document.body);
      const svg = document.querySelector('.whale');
      const path = document.querySelector('.whale path');
      const dot = document.querySelector('.dots span');
      return {
        scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        bodyBg: body.backgroundColor,
        titleColor: getComputedStyle(document.querySelector('.title')).color,
        whaleColor: getComputedStyle(svg).color,
        pathFill: path.getAttribute('fill'),
        dotBg: getComputedStyle(dot).backgroundColor,
        fadeOut: typeof window.__fadeOut === 'function',
      };
    })()`,
    returnByValue: true,
  })).result.value
}

await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await sleep(300)
console.log('LIGHT:', JSON.stringify(await read()))

await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
await sleep(300)
console.log('DARK :', JSON.stringify(await read()))
ws.close()
process.exit(0)
