import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BRIDGE_PLUGIN_NAME,
  readTextNoBom,
  readProfileBundles,
  pruneStaleProfileBundles,
  isolateProfileForSafeMode,
  restoreProfileManifest,
} from '../src/main/pluginfs.ts'

/** 造一个 profile 目录：manifest + 若干依赖目录。 */
function makeProfile(root, { bundles = [], dependencies = {} } = {}) {
  const profileDir = join(root, 'profiles', 'dsh-workbench')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-workbench', dependencies, dsh: { profile: { bundles } } }, null, 2),
  )
  for (const name of Object.keys(dependencies)) {
    mkdirSync(join(profileDir, 'node_modules', name), { recursive: true })
    writeFileSync(
      join(profileDir, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    )
  }
  return profileDir
}

test('readTextNoBom：去掉 UTF-8 BOM，文件不存在时抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const file = join(root, 'bom.json')
    writeFileSync(file, '\uFEFF{"a":1}')
    assert.deepEqual(JSON.parse(readTextNoBom(file)), { a: 1 })
    assert.throws(() => readTextNoBom(join(root, 'missing.json')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readProfileBundles：读取 dsh.profile.bundles；缺失/损坏返回空数组', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const profileDir = makeProfile(root, { bundles: ['@deepseek-ai/dsh-base', 'dsh-something'] })
    assert.deepEqual(readProfileBundles(profileDir), ['@deepseek-ai/dsh-base', 'dsh-something'])
    assert.deepEqual(readProfileBundles(join(root, 'nope')), [])
    writeFileSync(join(profileDir, 'package.json'), '{broken')
    assert.deepEqual(readProfileBundles(profileDir), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneStaleProfileBundles：清理已卸载条目，绝不重新启用用户停用的组合包', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    // dsh-kept 已装且在列表；dsh-disabled 仍装着（依赖在）但用户已停用（不在列表）；dsh-gone 已卸载
    const profileDir = makeProfile(root, {
      bundles: ['@deepseek-ai/dsh-base', BRIDGE_PLUGIN_NAME, 'dsh-kept', 'dsh-gone'],
      dependencies: { 'dsh-kept': '1.0.0', 'dsh-disabled': '1.0.0' },
    })
    assert.deepEqual(pruneStaleProfileBundles(profileDir), ['@deepseek-ai/dsh-base', BRIDGE_PLUGIN_NAME, 'dsh-kept'])
    const reread = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(reread.dsh.profile.bundles, ['@deepseek-ai/dsh-base', BRIDGE_PLUGIN_NAME, 'dsh-kept'])
    // 幂等：再次调用不写盘也不改内容
    assert.deepEqual(pruneStaleProfileBundles(profileDir), ['@deepseek-ai/dsh-base', BRIDGE_PLUGIN_NAME, 'dsh-kept'])
    // 基线项（官方两项 + bridge）永不被移出，即使它们不在 dependencies 里
    assert.ok(readProfileBundles(profileDir).includes(BRIDGE_PLUGIN_NAME))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneStaleProfileBundles：manifest 缺失/损坏时不抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    assert.deepEqual(pruneStaleProfileBundles(root), [])
    writeFileSync(join(root, 'package.json'), '{broken')
    assert.deepEqual(pruneStaleProfileBundles(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('安全模式：隔离到官方基线 + bridge（保留依赖）+ 移出用户 patch，退出时全部还原', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const profileDir = makeProfile(root, {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', BRIDGE_PLUGIN_NAME, 'dsh-user-plugin'],
      dependencies: { 'dsh-user-plugin': '1.2.3' },
    })
    // 用户 patch 层：坏 patch 同样会让组合树起不来，安全模式必须一并移出
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: system-prompt\n  disabled: true\n')
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    assert.equal(isolateProfileForSafeMode(profileDir), true)
    assert.deepEqual(readProfileBundles(profileDir), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', BRIDGE_PLUGIN_NAME])
    assert.equal(existsSync(join(profileDir, 'cordis.patch.yml')), false)
    assert.equal(existsSync(join(profileDir, 'cordis.patch.yml.safemode.bak')), true)
    // 依赖保留：隔离只收窄启用列表，不卸载
    const isolated = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(isolated.dependencies, { 'dsh-user-plugin': '1.2.3' })
    // 安全模式期间 harness 会重建一个空 patch：二次隔离不得覆盖还原点
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
    assert.equal(isolateProfileForSafeMode(profileDir), true)
    assert.equal(restoreProfileManifest(profileDir), true)
    assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), before)
    assert.equal(existsSync(join(profileDir, 'package.json.safemode.bak')), false)
    assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), '- id: system-prompt\n  disabled: true\n')
    assert.equal(existsSync(join(profileDir, 'cordis.patch.yml.safemode.bak')), false)
    // 没有备份时还原返回 false
    assert.equal(restoreProfileManifest(profileDir), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
