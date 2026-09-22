import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasInstallablePayload, unsupportedPayloadReason } from '../src/main/updatePayload.ts'

/**
 * 「这份更新清单在当前平台装得了吗」的回归测试。
 *
 * 背景（真实事故面）：electron-updater 的 MacUpdater 只认 zip
 * （`findFile(files, 'zip', ['pkg','dmg'])`，dmg 被显式排除），清单里没有 zip 时
 * `downloadUpdate()` 必抛 ERR_UPDATER_ZIP_FILE_NOT_FOUND。壳若照样宣告
 * 「已开始本地下载」，用户看到的就是「弹了通知、然后什么都没有」。
 */

test('hasInstallablePayload：macOS 只认 zip（dmg 再多也不算能装）', () => {
  const version = '0.8.4'
  assert.equal(
    hasInstallablePayload([{ url: `DSH.Desktop-${version}-arm64.zip` }, { url: `DSH.Desktop-${version}-arm64.dmg` }], 'darwin'),
    true,
  )
  // 只有 dmg：这正是 0.8.4 之前每次 mac 出包的真实形状
  assert.equal(hasInstallablePayload([{ url: `DSH.Desktop-${version}-arm64.dmg` }], 'darwin'), false)
  assert.equal(
    hasInstallablePayload([{ url: `DSH.Desktop-${version}-arm64.dmg` }, { url: `DSH.Desktop-${version}-x64.dmg` }], 'darwin'),
    false,
  )
})

test('hasInstallablePayload：绝对 URL 与相对文件名都要认（GitHub provider 两种都会出现）', () => {
  assert.equal(
    hasInstallablePayload([{ url: 'https://github.com/Plocr/dsh-desktop/releases/download/v0.8.4/DSH.Desktop-0.8.4-arm64.zip' }], 'darwin'),
    true,
  )
  // 带 query / 大写扩展名（CDN 有时会补 ?download=1）
  assert.equal(hasInstallablePayload([{ url: 'https://example.com/a/B.ZIP?download=1' }], 'darwin'), true)
  assert.equal(hasInstallablePayload([{ url: 'https://example.com/a/b.dmg?x=.zip' }], 'darwin'), false)
})

test('hasInstallablePayload：macOS 上清单缺失/形状异常一律按「装不了」处理', () => {
  assert.equal(hasInstallablePayload(undefined, 'darwin'), false)
  assert.equal(hasInstallablePayload(null, 'darwin'), false)
  assert.equal(hasInstallablePayload([], 'darwin'), false)
  assert.equal(hasInstallablePayload('junk', 'darwin'), false)
  assert.equal(hasInstallablePayload([{ noUrl: true }, null, 42], 'darwin'), false)
})

test('hasInstallablePayload：非 macOS 不额外限制（未知形状交给 electron-updater 自己判断）', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(hasInstallablePayload([{ url: 'DSH.Desktop-0.8.4-setup.exe' }], platform), true)
    assert.equal(hasInstallablePayload(undefined, platform), true)
  }
})

test('unsupportedPayloadReason：给出平台相关的人话原因', () => {
  assert.match(unsupportedPayloadReason('darwin'), /macOS/)
  assert.match(unsupportedPayloadReason('darwin'), /zip/)
  assert.match(unsupportedPayloadReason('linux'), /本平台/)
})
