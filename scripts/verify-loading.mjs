/**
 * 验证粒子鲸鱼加载页：导航 → canvas 像素统计 → 动画检测 → 恢复 harness。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 从最新 shell 日志解析当前 harness URL（productName 之后 userData 可能在新路径）
function findHarnessUrl() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'DSH Desktop', 'logs'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'logs'),
  ]
  let best = null
  for (const dir of candidates) {
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      if (files.length && (!best || statSync(files[0]).mtimeMs > statSync(best).mtimeMs)) best = files[0]
    } catch {
      /* skip */
    }
  }
  if (!best) return null
  const text = readFileSync(best, 'utf8')
  const lines = text.split('\n').filter((l) => l.includes('dsh web: '))
  if (!lines.length) return null
  const m = lines[lines.length - 1].match(/dsh web: (https?:\/\/[^\s]+)/)
  return m ? m[1] : null
}

const loadingUrl = 'file:///E:/Dsh/dsh-desktop/resources/shell-pages/loading.html'
const harnessUrl = findHarnessUrl()
console.log('harness url:', harnessUrl)

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')
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
    if (m.error) p.reject(new Error(JSON.stringify(m.error)))
    else p.resolve(m.result)
  }
}
await new Promise((resolve) => (ws.onopen = resolve))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evalJs(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails))
  return r.result?.value
}

const LIT = `(() => {
  const c = document.getElementById('whale');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 16) {
    const a = d[i+3];
    if (a > 30 && (d[i] + d[i+1] + d[i+2]) / 3 > 40) lit++;
  }
  return lit;
})()`

await call('Page.navigate', { url: loadingUrl })
await sleep(2500)
const state = await evalJs(`({ title: document.title, canvas: (() => { const c = document.getElementById('whale'); return c ? [c.width, c.height] : null })(), errs: window.__errs || [] })`)
console.log('state:', JSON.stringify(state))

await sleep(4000)
const a = await evalJs(LIT)
await sleep(700)
const b = await evalJs(LIT)
console.log('lit pixels a/b:', a, b, '| animating:', Math.abs(a - b) > 30 ? 'YES' : 'maybe')

const sys = await evalJs(`({ particles: window.__particles ? window.__particles.length : -1, targets: window.__targets ? window.__targets.length : -1, running: window.__running ? window.__running() : false })`)
console.log('system:', JSON.stringify(sys))

if (harnessUrl) {
  await call('Page.navigate', { url: harnessUrl })
  await sleep(2000)
  console.log('restored to:', await evalJs('location.href'))
}
ws.close()
process.exit(0)
