import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mergeMacManifest } from '../scripts/merge-mac-manifest.mjs'

/**
 * latest-mac.yml 合并逻辑的回归测试（纯函数，不跑 CLI）。
 *
 * 这条链路只在 macOS 上跑，本地/CI 都可能没有 mac 机器：
 *  - electron-updater 的 MacUpdater 只认 zip，清单里没有 zip 就是彻底不能自动更新；
 *  - sha512/size 必须是**实际文件**的（打包时那份早于公证/钉票，已作废），
 *    否则用户下载完会撞 sha512 mismatch。
 */

const VERSION = '9.9.9'

/** 造一个假产物目录（内容是随便的字节，只验证哈希口径与挑选逻辑）。 */
function fixtures(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-mac-manifest-'))
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(entries)) {
    writeFileSync(path.join(dir, name), body)
  }
  return dir
}

const sha512 = (body) => createHash('sha512').update(body).digest('base64')

test('mergeMacManifest：zip + dmg 都在时四份条目齐全，sha512/size 取自实际文件', () => {
  const bodies = {
    [`DSH.Desktop-${VERSION}-arm64.zip`]: Buffer.from('arm64-zip'),
    [`DSH.Desktop-${VERSION}-x64.zip`]: Buffer.from('x64-zip'),
    [`DSH.Desktop-${VERSION}-arm64.dmg`]: Buffer.from('arm64-dmg'),
    [`DSH.Desktop-${VERSION}-x64.dmg`]: Buffer.from('x64-dmg'),
  }
  const dir = fixtures(bodies)
  const { yml, files, hasZip } = mergeMacManifest({ assetsDir: dir, version: VERSION, releaseDate: '2026-01-01T00:00:00' })

  assert.equal(hasZip, true)
  assert.deepEqual(files.map((f) => f.url), [
    `DSH.Desktop-${VERSION}-arm64.zip`,
    `DSH.Desktop-${VERSION}-x64.zip`,
    `DSH.Desktop-${VERSION}-arm64.dmg`,
    `DSH.Desktop-${VERSION}-x64.dmg`,
  ])
  // 哈希确实是文件内容的哈希（不是打包时那份作废的数值）
  for (const f of files) {
    assert.equal(f.sha512, sha512(bodies[f.url]), `${f.url} 的 sha512 必须来自实际文件`)
    assert.equal(f.size, bodies[f.url].length)
  }
  // 旧字段 path/sha512 指向应用内更新真正安装的 zip
  assert.match(yml, new RegExp(`^path: DSH\\.Desktop-${VERSION}-arm64\\.zip$`, 'mu'))
  assert.equal(yml.match(/^sha512: (.+)$/mu)[1], sha512(bodies[`DSH.Desktop-${VERSION}-arm64.zip`]))
  assert.match(yml, /^version: 9\.9\.9$/mu)
  assert.match(yml, /^releaseDate: '2026-01-01T00:00:00'$/mu)
})

test('mergeMacManifest：只有 dmg（未签名构建）时不产出 zip 条目，path 退回 dmg', () => {
  const bodies = {
    [`DSH.Desktop-${VERSION}-arm64.dmg`]: Buffer.from('arm64-dmg'),
    [`DSH.Desktop-${VERSION}-x64.dmg`]: Buffer.from('x64-dmg'),
  }
  const dir = fixtures(bodies)
  const { yml, files, hasZip } = mergeMacManifest({ assetsDir: dir, version: VERSION, releaseDate: '2026-01-01T00:00:00' })

  assert.equal(hasZip, false)
  assert.deepEqual(files.map((f) => f.url), [`DSH.Desktop-${VERSION}-arm64.dmg`, `DSH.Desktop-${VERSION}-x64.dmg`])
  assert.doesNotMatch(yml, /\.zip/)
  assert.match(yml, new RegExp(`^path: DSH\\.Desktop-${VERSION}-arm64\\.dmg$`, 'mu'))
})

test('mergeMacManifest：单架构（只有 x64）也能出清单，path 落到 x64 zip', () => {
  const dir = fixtures({ [`DSH.Desktop-${VERSION}-x64.zip`]: Buffer.from('x64-zip') })
  const { yml, files } = mergeMacManifest({ assetsDir: dir, version: VERSION, releaseDate: '2026-01-01T00:00:00' })
  assert.deepEqual(files.map((f) => f.url), [`DSH.Desktop-${VERSION}-x64.zip`])
  assert.match(yml, new RegExp(`^path: DSH\\.Desktop-${VERSION}-x64\\.zip$`, 'mu'))
})

test('mergeMacManifest：什么都不存在时抛错（不能生成一份空清单把用户挂住）', () => {
  const dir = fixtures({ 'README.txt': Buffer.from('nope') })
  assert.throws(() => mergeMacManifest({ assetsDir: dir, version: VERSION, releaseDate: 'x' }), /no dmg\/zip found/)
})

test('mergeMacManifest：产物名按版本号拼装（版本不匹配的文件不会被误收）', () => {
  const dir = fixtures({
    'DSH.Desktop-1.2.3-arm64.zip': Buffer.from('old'),
    [`DSH.Desktop-${VERSION}-arm64.zip`]: Buffer.from('new'),
  })
  const { files } = mergeMacManifest({ assetsDir: dir, version: VERSION, releaseDate: 'x' })
  assert.deepEqual(files.map((f) => f.url), [`DSH.Desktop-${VERSION}-arm64.zip`])
  assert.equal(readFileSync(path.join(dir, 'DSH.Desktop-1.2.3-arm64.zip'), 'utf8'), 'old')
})
