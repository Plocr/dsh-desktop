import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleBridgeEvent, runningJobCount, RUNNING_STATUSES } from '../src/main/bridgeEvents.ts'

test('runningJobCount 只统计非终态任务', () => {
  const jobs = [
    { id: 'bash-1', status: 'running' },
    { id: 'bash-2', status: 'starting' },
    { id: 'bash-3', status: 'stopping' },
    { id: 'bash-4', status: 'done' },
    { id: 'bash-5', status: 'failed' },
    null,
    'junk',
    { id: 'bash-6' },
  ]
  assert.equal(runningJobCount(jobs), 3)
})

test('RUNNING_STATUSES 集合语义', () => {
  assert.ok(RUNNING_STATUSES.has('running'))
  assert.ok(!RUNNING_STATUSES.has('done'))
})

test('job.done 在开启通知时弹通知，关闭时静默', () => {
  const calls = []
  const effects = {
    notify: (title, body) => calls.push(`${title}|${body}`),
    setBadge: () => {},
  }
  handleBridgeEvent('job.done', { job: { id: 'bash-9', label: 'run tests' } }, { notifications: true }, effects)
  assert.deepEqual(calls, ['后台任务完成|任务 bash-9「run tests」已结束'])

  calls.length = 0
  handleBridgeEvent('job.done', { job: { id: 'bash-9' } }, { notifications: false }, effects)
  assert.deepEqual(calls, [])
})

test('jobs.changed 更新徽标', () => {
  let badge = -1
  const effects = { notify: () => {}, setBadge: (n) => (badge = n) }
  handleBridgeEvent(
    'jobs.changed',
    { jobs: [{ id: 'a', status: 'running' }, { id: 'b', status: 'done' }] },
    { notifications: true },
    effects,
  )
  assert.equal(badge, 1)
  handleBridgeEvent('jobs.changed', { jobs: [] }, { notifications: true }, effects)
  assert.equal(badge, 0)
})

test('approval.asked 弹通知', () => {
  const calls = []
  const effects = { notify: (t, b) => calls.push(`${t}|${b}`), setBadge: () => {} }
  handleBridgeEvent('approval.asked', { sessionId: 's-1' }, { notifications: true }, effects)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /需要审批/)
})

test('未知事件不产生副作用', () => {
  let touched = false
  const effects = {
    notify: () => (touched = true),
    setBadge: () => (touched = true),
  }
  handleBridgeEvent('something.else', {}, { notifications: true }, effects)
  assert.equal(touched, false)
})

test('畸形 payload 不抛错', () => {
  const effects = { notify: () => {}, setBadge: () => {} }
  assert.doesNotThrow(() => handleBridgeEvent('job.done', null, { notifications: true }, effects))
  assert.doesNotThrow(() => handleBridgeEvent('jobs.changed', 'junk', { notifications: true }, effects))
  assert.doesNotThrow(() => handleBridgeEvent('approval.asked', undefined, { notifications: true }, effects))
})
