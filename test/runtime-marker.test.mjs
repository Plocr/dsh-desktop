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

test('runtimeMarker: shouldExtractBundled 混血树回退（localTreeConsistent=false）', () => {
  // 用户自更新但本地整树不一致（如 dsh 已升、兄弟包仍旧）→ 回退内置一致运行时
  assert.equal(
    shouldExtractBundled(BUNDLED, buildUserMarker('0.1.0-rc.8', 'u1'), compareDots, { localTreeConsistent: false }),
    true,
  )
  // 用户自更新且树一致、内嵌 dsh 不更新 → 保留用户运行时
  assert.equal(
    shouldExtractBundled(BUNDLED, buildUserMarker('0.1.0-rc.8', 'u1'), compareDots, { localTreeConsistent: true }),
    false,
  )
  // 用户自更新且树一致、内嵌 dsh 更新 → 解压覆盖
  assert.equal(
    shouldExtractBundled(BUNDLED, buildUserMarker('0.1.0-rc.6', 'u2'), compareDots, { localTreeConsistent: true }),
    true,
  )
  // 非用户标记：localTreeConsistent 不参与（缺省 undefined 等价旧行为）
  assert.equal(shouldExtractBundled(BUNDLED, 'dsh=9.9.9\ntar=whatever\n', compareDots, { localTreeConsistent: false }), true)
})

test('runtimeMarker: shouldExtractBundled 本地无法启动 desktop profile 时强制回退内置', () => {
  // 随包 0.1.3，本地被应用内更新到 0.1.5（CLI 硬拒 desktop profile）且整树一致
  const bundled = 'dsh=0.1.3-alpha.2\ntar=bundled-hash\n'
  const local = buildUserMarker('0.1.5-rc.2', 'u9')
  // 无探测结果：一致的较新用户树优先保留（旧行为）
  assert.equal(shouldExtractBundled(bundled, local, compareDots, { localTreeConsistent: true }), false)
  // 探测失败（本地运行时无法启动本壳 profile）→ 无条件回退随包运行时
  assert.equal(
    shouldExtractBundled(bundled, local, compareDots, { localTreeConsistent: true, localBootable: false }),
    true,
  )
  // 探测通过 → 继续使用较新的本地树
  assert.equal(
    shouldExtractBundled(bundled, local, compareDots, { localTreeConsistent: true, localBootable: true }),
    false,
  )
  // 与随包完全一致（tar 相同）→ 早退就绪，不因探测结果重复解压
  assert.equal(shouldExtractBundled(bundled, bundled, compareDots, { localBootable: false }), false)
})

test('runtimeMarker: buildUserMarker 格式', () => {
  const m = buildUserMarker('0.1.0-rc.9', 'aabbccdd')
  assert.equal(isUserMarker(m), true)
  assert.deepEqual(parseMarker(m), { dsh: '0.1.0-rc.9', tar: 'user-aabbccdd' })
})