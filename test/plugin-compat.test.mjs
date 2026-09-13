import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionEventsOf,
  titleOfEvents,
  storedSessionHeads,
  inspectStoredSession,
} from '../packages/bridge/lib/index.js'
import { readStoredEvents } from '../packages/ui-dashboard/lib/index.js'

/**
 * 跨 harness 版本的宿主 API 兼容层回归测试。
 * 背景：dsh 0.1.2-rc.1 起 `Session.events` → `snapshotEvents()`；
 * 0.1.3-alpha.2 起 `sessionPersistence.readFrom()/inspect()` → `open()`+`handle.read()`，
 * 且 `list()` 返回形状由 `{id,createdAt}` 变为 `{header:{id,createdAt},revision,sizeBytes}`。
 * 桌面内置运行时可能被应用内更新到不同版本线，这些 shim 必须两代都成立。
 */

test('sessionEventsOf：新版 snapshotEvents() 与旧版 events 都能读', () => {
  const events = [{ type: 'session/title', data: { title: 'T' } }]
  assert.deepEqual(sessionEventsOf({ snapshotEvents: () => events }), events)
  assert.deepEqual(sessionEventsOf({ events }), events)
  // 两代都没有 / 抛错 → null（调用方降级，不崩）
  assert.equal(sessionEventsOf({}), null)
  assert.equal(sessionEventsOf({ snapshotEvents: () => { throw new Error('x') } }), null)
  assert.equal(sessionEventsOf({ snapshotEvents: () => 'nope' }), null)
})

test('titleOfEvents：取最近一条 session/title', () => {
  assert.equal(
    titleOfEvents([
      { type: 'session/title', data: { title: '旧' } },
      { type: 'other' },
      { type: 'session/title', data: { title: '新' } },
    ]),
    '新',
  )
  assert.equal(titleOfEvents([]), null)
  assert.equal(titleOfEvents(null), null)
  assert.equal(titleOfEvents([{ type: 'session/title', data: {} }]), null)
})

test('storedSessionHeads：新版 {header:{...}} 与旧版扁平形状都能解析', () => {
  assert.deepEqual(
    storedSessionHeads([
      { header: { id: 'a', createdAt: 111 }, revision: 1, sizeBytes: 10 },
      { header: { id: 'b' }, revision: 2 },
    ]),
    [
      { id: 'a', createdAt: 111 },
      { id: 'b', createdAt: null },
    ],
  )
  assert.deepEqual(
    storedSessionHeads([
      { id: 'c', createdAt: 222 },
      { id: '', createdAt: 1 }, // 空 id 跳过
      { notAnId: true },
    ]),
    [{ id: 'c', createdAt: 222 }],
  )
  assert.deepEqual(storedSessionHeads(null), [])
})

test('inspectStoredSession：新版 open→read→close 路径', async () => {
  const calls = []
  const events = [{ type: 'session/title', data: { title: '新版' } }]
  const persistence = {
    async open(id, access) {
      calls.push(['open', id, access])
      return {
        header: { id, createdAt: 999 },
        async read(offset) {
          calls.push(['read', offset])
          return { eventState: 'ok', events }
        },
        async close() {
          calls.push(['close'])
        },
      }
    },
  }
  assert.deepEqual(await inspectStoredSession(persistence, 's1'), { events, createdAt: 999 })
  assert.deepEqual(calls, [['open', 's1', 'read'], ['read', 0], ['close']])
})

test('inspectStoredSession：旧版 inspect 路径（优先）与都不可用 → null', async () => {
  const legacy = {
    async inspect(id) {
      return { events: [{ type: 'x' }], meta: { createdAt: 5 } }
    },
  }
  assert.deepEqual(await inspectStoredSession(legacy, 's2'), { events: [{ type: 'x' }], createdAt: 5 })
  assert.equal(await inspectStoredSession({}, 's3'), null)
})

test('inspectStoredSession：read 抛错时也释放句柄', async () => {
  let closed = false
  const persistence = {
    async open() {
      return {
        header: {},
        async read() {
          throw new Error('bad session')
        },
        async close() {
          closed = true
        },
      }
    },
  }
  await assert.rejects(() => inspectStoredSession(persistence, 's4'), /bad session/)
  assert.equal(closed, true)
})

test('readStoredEvents（ui-dashboard）：新版 open/read 与旧版 readFrom 都可用', async () => {
  const events = [{ type: 'user/message', data: {} }]
  const modern = {
    async open(id, access) {
      assert.equal(access, 'read')
      return { header: {}, read: async () => ({ events }), close: async () => {} }
    },
  }
  assert.deepEqual(await readStoredEvents(modern, 'x'), events)
  const legacy = {
    async readFrom(id, from) {
      assert.equal(from, 0)
      return { events }
    },
  }
  assert.deepEqual(await readStoredEvents(legacy, 'x'), events)
  // 两代都没有 → 明确报错（RPC 层转成 status:error，卡片显示不可用而不是崩溃）
  await assert.rejects(() => readStoredEvents({}, 'x'), /unsupported read API/)
})
