/**
 * CDP E2E：在 DSH Desktop 窗口中驱动一轮真实 agent 会话。
 * 1) 在 composer 输入消息  2) 提交  3) 轮询等待 assistant 回复
 * 用法: node scripts/e2e-turn.mjs "<message>" [timeoutSec]
 */
import { setTimeout as sleep } from 'node:timers/promises'

const message = process.argv[2] ?? '用一句话介绍你自己'
const timeoutSec = Number(process.argv[3] ?? 180)

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))
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

async function evalJs(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails))
  }
  return r.result?.value
}

// 1) 输入消息（React 受控组件需要原生 setter + input 事件）
const typed = await evalJs(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return 'no-textarea';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(message)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed:' + ta.value.slice(0, 40);
})()`)
console.log('STEP typed:', typed)

// 2) 提交：找 Enter 快捷键（通常 textarea 内 Enter 提交）。先直接派发 keydown Enter。
const submitted = await evalJs(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return 'no-textarea';
  ta.focus();
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  return 'dispatched';
})()`)
console.log('STEP submit:', submitted)

// 3) 轮询：等待最后一个 assistant 消息出现（发送时间之后的新消息块）
// 注意：判定与输出基于 #root（harness 应用区）——面板 DOM 挂在 body 末尾，
// 其文本（终端输出等）会污染 body.innerText 的尾部窗口。
const appText = `(() => {
  const root = document.getElementById('root');
  return (root ? root.innerText : document.body.innerText).slice(-4000);
})()`
const started = Date.now()
let lastText = ''
let found = false
while (Date.now() - started < timeoutSec * 1000) {
  const text = await evalJs(appText)
  // 简化判定：输入框被清空 + 页面新增了 assistant 内容（文本末尾出现非输入内容且包含常见回答词）
  const taValue = await evalJs(`(() => { const ta = document.querySelector('textarea'); return ta ? ta.value : 'none'; })()`)
  if (taValue === '' && text !== lastText) {
    lastText = text
    // 等待流式结束：连续 3 次内容稳定
    let stable = 0
    for (let k = 0; k < 3; k++) {
      await sleep(2500)
      const t2 = await evalJs(appText)
      if (t2 === lastText) stable++
      else {
        lastText = t2
        stable = 0
      }
    }
    if (stable >= 2) {
      found = true
      break
    }
  } else {
    await sleep(3000)
  }
}

console.log('STEP result:', found ? 'FOUND' : 'NOT-FOUND (timeout)')
if (found) {
  console.log('--- tail of page text ---')
  console.log(lastText.slice(-2500))
}
ws.close()
process.exit(found ? 0 : 2)
