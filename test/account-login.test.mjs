import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountLoginFailureText,
  accountLoginSteps,
  accountStateOf,
  emptyAccountLoginMemory,
  platformLoginUrl,
} from '../src/main/accountLogin.ts'

/** 桥接 `account.changed` 的实际负载形状（见 packages/bridge 的 minimalAccountState）。 */
function state(attempt) {
  return { status: 'signed-out', attempt }
}

test('accountStateOf：解析桥接负载；缺 id/未知 phase 一律忽略', () => {
  const parsed = accountStateOf({
    status: 'credential-stored',
    attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?x=1', expiresAt: 1 },
  })
  assert.deepEqual(parsed, {
    status: 'credential-stored',
    attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?x=1', errorCode: null },
  })
  assert.equal(accountStateOf(null), null)
  assert.equal(accountStateOf({ attempt: { phase: 'waiting-browser' } }), null)
  assert.equal(accountStateOf({ attempt: { id: 'a1', phase: 'nonsense' } }), null)
  assert.deepEqual(accountStateOf({ status: 'signed-out', attempt: null }), { status: 'signed-out', attempt: null })
})

test('platformLoginUrl：带上主题参数（官方桌面端行为），非法 URL 原样返回', () => {
  assert.equal(
    platformLoginUrl('https://platform.deepseek.com/dsh/authorize?state=abc', true),
    'https://platform.deepseek.com/dsh/authorize?state=abc&theme=dark',
  )
  assert.equal(
    platformLoginUrl('https://platform.deepseek.com/dsh/authorize?theme=light', false),
    'https://platform.deepseek.com/dsh/authorize?theme=light',
  )
  assert.equal(platformLoginUrl('not-a-url', false), 'not-a-url')
})

test('accountLoginSteps：等待浏览器只开一次；失败/超时唤回窗口一次', () => {
  const waiting = state({ id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize' })
  const first = accountLoginSteps(waiting, false, emptyAccountLoginMemory())
  assert.deepEqual(first.steps, [
    { kind: 'open-browser', attemptId: 'a1', url: 'https://platform.deepseek.com/dsh/authorize?theme=light' },
  ])
  // 同一次尝试再推一次状态（例如 exchanging）→ 不再开浏览器
  const again = accountLoginSteps(state({ id: 'a1', phase: 'exchanging' }), false, first.memory)
  assert.deepEqual(again.steps, [])

  const failed = accountLoginSteps(
    state({ id: 'a1', phase: 'failed', errorCode: 'network' }),
    false,
    again.memory,
  )
  assert.deepEqual(failed.steps, [{ kind: 'focus-window', attemptId: 'a1', reason: 'failed', errorCode: 'network' }])
  // 再推一次同一次失败 → 不重复打扰
  assert.deepEqual(accountLoginSteps(state({ id: 'a1', phase: 'failed' }), false, failed.memory).steps, [])
  // 新一轮尝试（新 id）重新开浏览器
  const second = accountLoginSteps(
    state({ id: 'b2', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize' }),
    true,
    failed.memory,
  )
  assert.deepEqual(second.steps, [
    { kind: 'open-browser', attemptId: 'b2', url: 'https://platform.deepseek.com/dsh/authorize?theme=dark' },
  ])
})

test('accountLoginSteps：等待浏览器但没有链接（初始化中）不动作', () => {
  const steps = accountLoginSteps(state({ id: 'a1', phase: 'waiting-browser', authorizeUrl: null }), false, emptyAccountLoginMemory())
  assert.deepEqual(steps.steps, [])
  assert.equal(steps.memory.openedAttemptId, null)
})

test('accountLoginFailureText：按失败分类给出可执行文案', () => {
  assert.match(accountLoginFailureText({ kind: 'focus-window', attemptId: 'a', reason: 'failed', errorCode: 'network' }), /网络/)
  assert.match(accountLoginFailureText({ kind: 'focus-window', attemptId: 'a', reason: 'failed', errorCode: 'storage' }), /凭据/)
  assert.match(accountLoginFailureText({ kind: 'focus-window', attemptId: 'a', reason: 'expired', errorCode: null }), /超时/)
  assert.match(accountLoginFailureText({ kind: 'focus-window', attemptId: 'a', reason: 'failed', errorCode: 'protocol' }), /平台/)
})
