import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareDots, maxVersion, updateAvailable } from '../src/main/version.ts'

test('compareDots：主版本与常规预发布排序', () => {
  assert.equal(compareDots('0.1.5', '0.1.4'), 1)
  assert.equal(compareDots('0.1.4', '0.1.5'), -1)
  assert.equal(compareDots('0.1.5', '0.1.5'), 0)
  // 无预发布 > 有预发布
  assert.equal(compareDots('0.2.0', '0.2.0-rc.1'), 1)
  assert.equal(compareDots('0.2.0-rc.1', '0.2.0'), -1)
  // 预发布阶段序：alpha < beta < rc
  assert.equal(compareDots('1.0.0-alpha.1', '1.0.0-beta.1'), -1)
  assert.equal(compareDots('1.0.0-beta.1', '1.0.0-rc.1'), -1)
  // 同阶段数字按数值比（rc.10 > rc.9；连写 rc10 > rc9）
  assert.equal(compareDots('1.0.0-rc.10', '1.0.0-rc.9'), 1)
  assert.equal(compareDots('1.0.0-rc10', '1.0.0-rc9'), 1)
  assert.equal(compareDots('1.0.0-alpha10', '1.0.0-alpha9'), 1)
  // 段数少者更小（semver：1.0.0-rc < 1.0.0-rc.1）
  assert.equal(compareDots('1.0.0-rc', '1.0.0-rc.1'), -1)
})

test('compareDots：+build 元数据不参与比较；纯数字预发布低于字母标识', () => {
  assert.equal(compareDots('1.2.3+build.1', '1.2.3'), 0)
  assert.equal(compareDots('1.2.3+build.9', '1.2.3+build.1'), 0)
  // semver：数字标识 < 字母数字标识
  assert.ok(compareDots('1.0.0-1', '1.0.0-rc.1') < 0)
  assert.ok(compareDots('1.0.0-rc.1', '1.0.0-1') > 0)
  // 数字标识之间按数值
  assert.ok(compareDots('1.0.0-2', '1.0.0-10') < 0)
  assert.ok(compareDots('1.0.0-10', '1.0.0-2') > 0)
})

test('compareDots：真实发布序列取最大', () => {
  const versions = [
    '0.1.1-rc.1', '0.1.1-rc.2', '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4',
    '0.1.2-alpha.5', '0.1.2-rc.1', '0.1.3-alpha.2', '0.1.5-alpha.1', '0.1.5-alpha.2',
    '0.1.5-rc.1', '0.1.5-rc.2',
  ]
  let best = versions[0]
  for (const v of versions) if (compareDots(v, best) > 0) best = v
  assert.equal(best, '0.1.5-rc.2')
})

test('updateAvailable：新版或本地树不一致都需要更新', () => {
  assert.equal(updateAvailable('0.1.2-alpha.5', '0.1.5-rc.2', true), true)
  assert.equal(updateAvailable('0.1.5-rc.2', '0.1.5-rc.2', true), false)
  assert.equal(updateAvailable('0.1.5-rc.2', '0.1.5-rc.2', false), true)
  assert.equal(updateAvailable(null, '0.1.5', true), false)
  assert.equal(updateAvailable('0.1.5', null, true), false)
})

test('maxVersion：取最大；排除已知不兼容版本后回退到次新', () => {
  const published = [
    '0.1.2-alpha.5', '0.1.2-rc.1', '0.1.3-alpha.2', '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2',
  ]
  assert.equal(maxVersion(published), '0.1.5-rc.2')
  // 0.1.5 系在 CLI 上拒绝 desktop profile（硬编码守卫）→ 排除后取 0.1.3-alpha.2
  const excluded = new Set(['0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2'])
  assert.equal(maxVersion(published, excluded), '0.1.3-alpha.2')
  // 全部被排除 → null；非法版本号忽略
  assert.equal(maxVersion(published, new Set(published)), null)
  assert.equal(maxVersion(['latest', '', 'x.y.z']), null)
  assert.equal(maxVersion([]), null)
})
