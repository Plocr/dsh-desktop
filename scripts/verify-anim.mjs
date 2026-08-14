// 验证白底方块粒子：黑色粒子包围盒（鲸鱼形状）+ 背景白色 + 动画帧
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
await call('Emulation.setFocusEmulationEnabled', { enabled: true })
await sleep(5000)

const state = await call('Runtime.evaluate', {
  expression: `(() => {
    const c = document.getElementById('whale');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const w = c.width, h = c.height;
    let dark = 0, minX = w, maxX = 0, minY = h, maxY = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        if (d[i] < 100 && d[i+1] < 110 && d[i+2] < 150) { // 深色粒子（黑/深蓝）
          dark++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return {
      canvas: [w, h],
      darkPixels: dark,
      spanX: (maxX - minX) / w,
      spanY: (maxY - minY) / h,
      errs: window.__errs || [],
      particles: window.__particles ? window.__particles.length : -1,
      fadeOut: typeof window.__fadeOut === 'function',
      bgSample: Array.from(d.slice(0, 12)).join(','), // 角落背景像素
    };
  })()`,
  returnByValue: true,
})
console.log('state:', JSON.stringify(state.result.value))
ws.close()
process.exit(0)
