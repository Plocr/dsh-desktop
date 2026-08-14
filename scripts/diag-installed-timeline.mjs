// 安装版完整时间线：重启 harness，30ms 高频轮询 boot 界面颜色与主题属性
const CDP_PORT = 9223
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
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
const evalJ = async (e) => {
  try {
    return (await call('Runtime.evaluate', { expression: e, returnByValue: true })).result.value
  } catch {
    return null
  }
}

const probe = `(() => {
  const boot = [...document.querySelectorAll('div')].find((d) => (d.className + '').includes('boot'));
  const root = getComputedStyle(document.documentElement);
  return {
    url: location.href.slice(0, 45),
    boot: !!boot,
    bootBg: boot ? getComputedStyle(boot).backgroundColor : null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    darkAttr: document.body.hasAttribute('data-ds-dark-theme'),
    rootVar: root.getPropertyValue('--dsw-alias-bg-base').trim(),
    colorScheme: root.colorScheme,
    schemeDark: matchMedia('(prefers-color-scheme: dark)').matches,
  };
})()`

console.log('BEFORE:', JSON.stringify(await evalJ(probe)))

import { execFileSync } from 'node:child_process'
execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--profile desktop*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' })

// 高频轮询 6 秒
const timeline = []
const t0 = Date.now()
while (Date.now() - t0 < 6000) {
  await sleep(30)
  const v = await evalJ(probe)
  if (v && v.boot) {
    timeline.push({ t: Date.now() - t0, ...v })
  }
}
console.log('boot frames captured:', timeline.length)
for (const f of timeline.slice(0, 12)) {
  console.log(`t=${f.t}ms bootBg=${f.bootBg} darkAttr=${f.darkAttr} rootVar=${f.rootVar} scheme=${f.colorScheme} mediaDark=${f.schemeDark}`)
}
if (timeline.length > 12) console.log(`... +${timeline.length - 12} more`)
await sleep(2000)
console.log('FINAL:', JSON.stringify(await evalJ(probe)))
ws.close()
process.exit(0)
