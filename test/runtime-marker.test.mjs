import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMarker,
  isUserMarker,
  shouldExtractBundled,
  buildUserMarker,
} from '../src/main/runtimeMarker.ts'
import { compareDots } from '../src/main/version.ts'

const BUNDLED = 'dsh=0.1.0-rc.7\ntar=abc123\n'

test('runtimeMarker: parseMarker 解析 dsh/tar', () => {
  assert.deepEqual(parseMarker(BUNDLED), { dsh: '0.1.0-rc.7', tar: 'abc123' })
  assert.deepEqual(parseMarker(''), { dsh: null, tar: null })
  assert.deepEqual(parseMarker('tar=xyz\ndsh=1.2.3\n'), { dsh: '1.2.3', tar: 'xyz' })
})

test('runtimeMarker: isUserMarker 识别用户自更新', () => {
  assert.equal(isUserMarker('tar=user-abc\n'), true)
  assert.equal(isUserMarker('dsh=1.0.0\ntar=user-123\n'), true)
  assert.equal(isUserMarker(BUNDLED), false)
})

test('runtimeMarker: shouldExtractBundled 决策', () => {
  // 无本地标记 → 解压
  assert.equal(shouldExtractBundled(BUNDLED, null, compareDots), true)
  // 与随包完全一致 → 就绪（不解压）
  assert.equal(shouldExtractBundled(BUNDLED, BUNDLED, compareDots), false)
  // 用户自更新（本地更新，内嵌版本）→ 不解压（保留用户运行时）
  assert.equal(shouldExtractBundled(BUNDLED, buildUserMarker('0.1.0-rc.8', 'u1'), compareDots), false)
  // 用户自更新，但安装包内嵌 dsh 更新 → 解压覆盖
  assert.equal(shouldExtractBundled(BUNDLED, buildUserMarker('0.1.0-rc.6', 'u2'), compareDots), true)
  // 无关 marker → 解压刷新
  assert.equal(shouldExtractBundled(BUNDLED, 'dsh=9.9.9\ntar=whatever\n', compareDots), true)
  // 随包 marker 损坏（无 dsh）→ 假（交给调用方存在性兜底）
  assert.equal(shouldExtractBundled('tar=only\n', null, compareDots), false)
})

test('runtimeMarker: buildUserMarker 格式', () => {
  const m = buildUserMarker('0.1.0-rc.9', 'aabbccdd')
  assert.equal(isUserMarker(m), true)
  assert.deepEqual(parseMarker(m), { dsh: '0.1.0-rc.9', tar: 'user-aabbccdd' })
})