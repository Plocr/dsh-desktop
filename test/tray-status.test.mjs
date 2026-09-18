import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trayStatusLine } from '../src/main/trayStatus.ts'

/**
 * 托盘状态行：0.8.2 把「Harness 状态 / 桥接 / 最近会话 / 待审批」压成一行，
 * 这里锁住那一行的语义——桥接连不上、jobs 不可用、协议不匹配都必须看得出来
 * （它们是通知/徽标/深链失效的唯一可见信号）。
 */

const bridge = (over = {}) => ({ connected: true, jobs: 'present', protocol: 'ok', lastCode: null, ...over })

test('正常状态：一行给出 Host 运行 + 桥接 + 任务可用', () => {
  assert.equal(
    trayStatusLine({ harnessState: '运行中', bridge: bridge() }),
    'Harness：运行中 · 桥接：已连接 · 任务可用',
  )
})

test('jobs 不可用 / 协议不匹配 / 版本未知都带警告', () => {
  assert.equal(
    trayStatusLine({ harnessState: '运行中', bridge: bridge({ jobs: 'absent' }) }),
    'Harness：运行中 · 桥接：已连接 · 任务不可用',
  )
  assert.equal(
    trayStatusLine({ harnessState: '运行中', bridge: bridge({ protocol: 'mismatch' }) }),
    'Harness：运行中 · 桥接：已连接 · 任务可用 · ⚠ 协议不匹配',
  )
  assert.equal(
    trayStatusLine({ harnessState: '运行中', bridge: bridge({ protocol: 'unknown', jobs: null }) }),
    'Harness：运行中 · 桥接：已连接 · ⚠ 版本未知',
  )
})

test('桥接未连接：带最新诊断码；启动中/已停止同样成行', () => {
  assert.equal(
    trayStatusLine({
      harnessState: '启动中',
      bridge: bridge({ connected: false, jobs: null, protocol: 'unknown', lastCode: 'auth.rejected' }),
    }),
    'Harness：启动中 · 桥接：未连接（auth.rejected）',
  )
  assert.equal(
    trayStatusLine({ harnessState: '已停止', bridge: bridge({ connected: false, jobs: null, protocol: 'unknown' }) }),
    'Harness：已停止 · 桥接：未连接',
  )
})
