// 最终验证：settings=light + 系统深色下，重启 harness 后页面应保持浅色（themeSource 持久=light）
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

const probe = `(() => {
  const boot = [...document.querySelectorAll('div')].find((d) => (d.className + '').includes('boot'));
  return {
    boot: !!boot,
    bootBg: boot ? getComputedStyle(boot).backgroundColor : null,
    darkAttr: document.body.hasAttribute('data-ds-dark-theme'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    mediaDark: matchMedia('(prefers-color-scheme: dark)').matches,
  };
})()`

console.log('BEFORE:', JSON.stringify(await evalJ(probe)))
import { execFileSync } from 'node:child_process'
execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--profile desktop*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' })

let sawBoot = null
const t0 = Date.now()
while (Date.now() - t0 < 6000) {
  await sleep(40)
  try {
    const v = await evalJ(probe)
    if (v && v.boot && !sawBoot) {
      sawBoot = v
      console.log('BOOT at', Date.now() - t0, 'ms:', JSON.stringify(v))
    }
  } catch { /* navigating */ }
}
await sleep(2500)
console.log('FINAL:', JSON.stringify(await evalJ(probe)))
ws.close()
process.exit(0)
