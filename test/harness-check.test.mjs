import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareDots } from '../src/main/version.ts'
import { parseHarnessLine } from '../src/main/harnessParse.ts'

test('compareDots: 纯数字版本', () => {
  assert.ok(compareDots('0.2.0', '0.1.0') > 0)
  assert.ok(compareDots('0.1.0', '0.2.0') < 0)
  assert.equal(compareDots('0.1.0', '0.1.0'), 0)
  assert.ok(compareDots('0.10.0', '0.9.0') > 0)
})

test('compareDots: rc 预发布版本', () => {
  // 回归：旧实现 split 后 Number('rc') = NaN，rc 升版永远不触发
  assert.ok(compareDots('0.1.0-rc.7', '0.1.0-rc.6') > 0, 'rc.7 > rc.6')
  assert.ok(compareDots('0.1.0-rc.6', '0.1.0-rc.7') < 0, 'rc.6 < rc.7')
  assert.equal(compareDots('0.1.0-rc.6', '0.1.0-rc.6'), 0, 'rc.6 == rc.6')
  assert.ok(compareDots('0.1.0-rc.10', '0.1.0-rc.9') > 0, 'rc.10 > rc.9（数字段正确比较）')
})

test('compareDots: 预发布与正式版', () => {
  assert.ok(compareDots('0.1.0', '0.1.0-rc.6') > 0, '正式版 > rc')
  assert.ok(compareDots('0.1.0-rc.6', '0.1.0') < 0, 'rc < 正式版')
})

test('compareDots: alpha/beta/rc 排序', () => {
  assert.ok(compareDots('0.1.0-beta.2', '0.1.0-rc.1') < 0, 'beta < rc')
  assert.ok(compareDots('0.1.0-alpha.1', '0.1.0-beta.1') < 0, 'alpha < beta')
})

test('parseHarnessLine: dsh web 行', () => {
  const r = parseHarnessLine('dsh web: http://127.0.0.1:50565', null)
  assert.equal(r?.url, 'http://127.0.0.1:50565')
  assert.equal(r?.port, 50565)
})

test('parseHarnessLine: dsh desktop 桥接行', () => {
  const r = parseHarnessLine('dsh desktop: {"port":62008,"token":"abc123"}', null)
  assert.equal(r?.bridgePort, 62008)
  assert.equal(r?.token, 'abc123')
})

test('parseHarnessLine: 两行合并就绪', () => {
  const web = parseHarnessLine('dsh web: http://127.0.0.1:50565', null)
  const full = parseHarnessLine('dsh desktop: {"port":62008,"token":"abc123"}', web)
  assert.equal(full?.url, 'http://127.0.0.1:50565')
  assert.equal(full?.bridgePort, 62008)
  assert.equal(full?.token, 'abc123')
})

test('parseHarnessLine: 无关行返回 null', () => {
  assert.equal(parseHarnessLine('[bridge] jobs service: present', null), null)
  assert.equal(parseHarnessLine('', null), null)
})

test('parseHarnessLine: 坏行不崩溃', () => {
  assert.equal(parseHarnessLine('dsh web: not-a-url', null), null)
  assert.equal(parseHarnessLine('dsh desktop: {bad json', null), null)
})
