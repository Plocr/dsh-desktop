import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validatePluginDir,
  installUserPlugin,
  uninstallUserPlugin,
  listUserPluginNames,
  readPatchInsertedIds,
  cleanPatchStaleEntries,
  isValidPluginSpec,
  isValidPluginName,
  isReservedPluginName,
  discoverPluginsIn,
  listDesktopPlugins,
  pluginProfileTarget,
  readProfileBundles,
  readProfileDependencyNames,
  reconcileProfileBundles,
  setBundleMounted,
  isolateProfileForSafeMode,
  restoreProfileManifest,
  listInstalledBundleNames,
  shouldRetryLowerConcurrency,
  cleanAllowBuildsForRemoved,
} from '../src/main/pluginfs.ts'

function makePlugin(root, name, main = 'index.js', extra = '') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, main }))
  if (main !== 'missing.js') writeFileSync(join(dir, main.endsWith('.js') ? main : 'index.js'), 'export const name = `' + name + '`\n')
  if (extra) writeFileSync(join(dir, 'extra.txt'), extra)
  return dir
}

test('validatePluginDir：拒绝缺 package.json / 坏 JSON / 无名 / 入口缺失 / bridge 覆盖', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const empty = join(root, 'empty')
    mkdirSync(empty)
    assert.equal(validatePluginDir(empty).ok, false)

    const badJson = join(root, 'badjson')
    mkdirSync(badJson)
    writeFileSync(join(badJson, 'package.json'), '{oops')
    assert.equal(validatePluginDir(badJson).ok, false)

    const noName = join(root, 'noname')
    mkdirSync(noName)
    writeFileSync(join(noName, 'package.json'), JSON.stringify({ main: 'index.js' }))
    assert.equal(validatePluginDir(noName).ok, false)

    const noEntry = makePlugin(root, 'noentry', 'missing.js')
    assert.equal(validatePluginDir(noEntry).ok, false)

    const bridge = makePlugin(root, 'dsh-desktop-bridge')
    assert.equal(validatePluginDir(bridge).ok, false)

    const good = makePlugin(root, 'good-plugin', 'index.js')
    const v = validatePluginDir(good)
    assert.deepEqual(v, { ok: true, name: 'good-plugin', version: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installUserPlugin：安装/覆盖/拒绝损坏包；uninstallUserPlugin 删除', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const userDir = join(root, 'user-plugins')
    const src = makePlugin(root, 'my-plugin', 'index.js', 'payload')
    const r = installUserPlugin(src, userDir)
    assert.equal(r.ok, true)
    assert.equal(r.name, 'my-plugin')
    const installedPkg = join(userDir, 'my-plugin', 'package.json')
    assert.equal(existsSync(installedPkg), true)
    assert.equal(readFileSync(join(userDir, 'my-plugin', 'extra.txt'), 'utf8'), 'payload')
    assert.deepEqual(listUserPluginNames(userDir), ['my-plugin'])

    // 重装（先清空源文件再装，模拟更新）——install 先删旧目标
    rmSync(join(userDir, 'my-plugin', 'extra.txt'), { force: true })
    installUserPlugin(src, userDir)
    assert.equal(existsSync(join(userDir, 'my-plugin', 'extra.txt')), true)

    // 拒绝损坏源
    const bad = join(root, 'bad')
    mkdirSync(bad)
    const br = installUserPlugin(bad, userDir)
    assert.equal(br.ok, false)
    if (!br.ok) assert.match(br.reason, /package\.json/)

    // 卸载
    assert.equal(uninstallUserPlugin('my-plugin', userDir), true)
    assert.equal(existsSync(join(userDir, 'my-plugin')), false)
    assert.equal(uninstallUserPlugin('my-plugin', userDir), false)
    assert.deepEqual(listUserPluginNames(userDir), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readPatchInsertedIds：insert 块 id 提取（含注释/多块/单词条目不误判）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const f = join(root, 'cordis.patch.yml')
    writeFileSync(
      f,
      [
        '# comment',
        '- insert:',
        '    - id: ui-dashboard',
        '      name: ui-dashboard',
        '- disable:',
        '    - id: something-else',
        '- insert:',
        '    - id: second-plugin',
      ].join('\n'),
    )
    assert.deepEqual([...readPatchInsertedIds(f)], ['ui-dashboard', 'second-plugin'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanPatchStaleEntries：删除名单外的残留条目，保留合法条目与注释', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const f = join(root, 'cordis.patch.yml')
    writeFileSync(
      f,
      [
        '# keep me',
        '- insert:',
        '    - id: ui-dashboard',
        '      name: ui-dashboard',
        '    - id: ghost-plugin',
        '      name: ghost-plugin',
        '    - id: dsh-desktop-bridge',
        '      config:',
        '        token: abc',
        '- disable:',
        '    - id: never-load',
      ].join('\n'),
    )
    const known = new Set(['ui-dashboard', 'dsh-desktop-bridge'])
    assert.equal(cleanPatchStaleEntries(f, known), true)
    const out = readFileSync(f, 'utf8')
    assert.match(out, /# keep me/)
    assert.match(out, /- id: ui-dashboard/)
    assert.match(out, /- id: dsh-desktop-bridge/)
    assert.doesNotMatch(out, /ghost-plugin/)
    // disable 块不受影响
    assert.match(out, /- id: never-load/)
    // 幂等：二次清理无变化
    assert.equal(cleanPatchStaleEntries(f, known), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanPatchStaleEntries：文件不存在返回 false；不修改 bridge 条目', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    assert.equal(cleanPatchStaleEntries(join(root, 'nope.yml'), new Set()), false)
    const f = join(root, 'c.yml')
    writeFileSync(f, '- insert:\n    - id: dsh-desktop-bridge\n')
    assert.equal(cleanPatchStaleEntries(f, new Set(['ui-dashboard'])), false)
    assert.match(readFileSync(f, 'utf8'), /dsh-desktop-bridge/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isValidPluginSpec：官方 spec 白名单', () => {
  assert.equal(isValidPluginSpec('my-plugin'), true)
  assert.equal(isValidPluginSpec('@scope/my-plugin'), true)
  assert.equal(isValidPluginSpec('@scope/my-plugin@1.2.3'), true)
  assert.equal(isValidPluginSpec('github:user/repo'), true)
  assert.equal(isValidPluginSpec('github:user/repo#abc123'), true)
  assert.equal(isValidPluginSpec('C:\\work\\my-plugin'), true)
  assert.equal(isValidPluginSpec('C:/work/my-plugin-0.1.0.tgz'), true)
  assert.equal(isValidPluginSpec('  @s/p  '), true) // 首尾空白会被 trim
  assert.equal(isValidPluginSpec('my plugin'), false)
  assert.equal(isValidPluginSpec('my;rm -rf /'), false)
  assert.equal(isValidPluginSpec('$(whoami)'), false)
  assert.equal(isValidPluginSpec(''), false)
  assert.equal(isValidPluginSpec('x'.repeat(600)), false)
})

test('reconcileProfileBundles：bundle 依赖补进列表；已卸载依赖从列表移除', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const profileDir = join(root, 'profiles', 'desktop')
    mkdirSync(join(profileDir, 'node_modules', 'dsh-something'), { recursive: true })
    mkdirSync(join(profileDir, 'node_modules', 'plain-lib'), { recursive: true })
    writeFileSync(
      join(profileDir, 'node_modules', 'dsh-something', 'package.json'),
      JSON.stringify({ name: 'dsh-something', dsh: { bundle: { patch: './p.yml' } } }),
    )
    writeFileSync(join(profileDir, 'node_modules', 'plain-lib', 'package.json'), JSON.stringify({ name: 'plain-lib' }))
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-desktop',
        dependencies: { 'dsh-something': 'link:x', 'plain-lib': 'link:y' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'gone'] } },
      }),
    )
    const out = reconcileProfileBundles(profileDir)
    assert.deepEqual(out, ['@deepseek-ai/dsh-base', 'dsh-something'])
    // 写盘后重读一致
    const reread = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(reread.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-something'])
    // 幂等：再次调用无变化
    assert.deepEqual(reconcileProfileBundles(profileDir), ['@deepseek-ai/dsh-base', 'dsh-something'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reconcileProfileBundles：package.json 缺失/损坏时不抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    assert.deepEqual(reconcileProfileBundles(root), [])
    writeFileSync(join(root, 'package.json'), '{broken')
    assert.deepEqual(reconcileProfileBundles(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readProfileDependencyNames：读取 dependencies 键；缺失/损坏返回空', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    assert.deepEqual(readProfileDependencyNames(root), [])
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { '@scope/skin': 'link:x', plain: '^1.0.0' } }),
    )
    assert.deepEqual(readProfileDependencyNames(root), ['@scope/skin', 'plain'])
    writeFileSync(join(root, 'package.json'), '{broken')
    assert.deepEqual(readProfileDependencyNames(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('setBundleMounted：取消挂载移出 bundles（保留依赖）；重新挂载需依赖+bundle 声明', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const profileDir = join(root, 'profiles', 'desktop')
    mkdirSync(join(profileDir, 'node_modules', '@scope', 'skin'), { recursive: true })
    writeFileSync(
      join(profileDir, 'node_modules', '@scope', 'skin', 'package.json'),
      JSON.stringify({ name: '@scope/skin', dsh: { bundle: { patch: './p.yml' } } }),
    )
    const mkManifest = (bundles) =>
      writeFileSync(
        join(profileDir, 'package.json'),
        JSON.stringify({
          name: 'dsh-profile-desktop',
          dependencies: { '@scope/skin': 'link:x' },
          dsh: { profile: { bundles } },
        }),
      )
    // 已挂载 → 取消挂载
    mkManifest(['@deepseek-ai/dsh-base', '@scope/skin'])
    assert.equal(setBundleMounted(profileDir, '@scope/skin', false), false)
    assert.deepEqual(readProfileBundles(profileDir), ['@deepseek-ai/dsh-base'])
    // 重新挂载（依赖还在 + bundle 声明在）→ 成功
    assert.equal(setBundleMounted(profileDir, '@scope/skin', true), true)
    assert.deepEqual(readProfileBundles(profileDir), ['@deepseek-ai/dsh-base', '@scope/skin'])
    // 幂等：再次取消
    assert.equal(setBundleMounted(profileDir, '@scope/skin', false), false)
    // 无 bundle 声明的包重新挂载被拒
    mkdirSync(join(profileDir, 'node_modules', 'plain'), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', 'plain', 'package.json'), JSON.stringify({ name: 'plain' }))
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ name: 'd', dependencies: { plain: 'link:x' }, dsh: { profile: { bundles: [] } } }),
    )
    assert.equal(setBundleMounted(profileDir, 'plain', true), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listInstalledBundleNames：取消挂载后仍列出（代码保留），完整卸载后消失', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const profileDir = join(root, 'p')
    mkdirSync(join(profileDir, 'node_modules', '@scope', 'skin'), { recursive: true })
    writeFileSync(
      join(profileDir, 'node_modules', '@scope', 'skin', 'package.json'),
      JSON.stringify({ name: '@scope/skin', dsh: { bundle: { patch: './p.yml' } } }),
    )
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-desktop',
        dependencies: { '@scope/skin': 'link:x' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@scope/skin'] } },
      }),
    )
    // 已挂载时列出
    assert.deepEqual(listInstalledBundleNames(profileDir), ['@scope/skin'])
    // 取消挂载（移出 bundles，依赖保留）→ 仍列出（这是修复点）
    setBundleMounted(profileDir, '@scope/skin', false)
    assert.deepEqual(listInstalledBundleNames(profileDir), ['@scope/skin'])
    // 完整卸载（删除依赖）→ 不再列出
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    )
    assert.deepEqual(listInstalledBundleNames(profileDir), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isolateProfileForSafeMode / restoreProfileManifest：安全模式隔离与恢复', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const profileDir = join(root, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    const original = {
      name: 'dsh-profile-desktop',
      dependencies: { '@scope/skin': 'link:x' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@scope/skin'] } },
    }
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(original, null, 2))
    // 隔离：bundles 缩到官方内置；dependencies 保留；生成备份
    assert.equal(isolateProfileForSafeMode(profileDir), true)
    const isolated = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(isolated.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    assert.deepEqual(isolated.dependencies, { '@scope/skin': 'link:x' })
    assert.equal(existsSync(join(profileDir, 'package.json.safemode.bak')), true)
    // 恢复
    assert.equal(restoreProfileManifest(profileDir), true)
    const restored = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(restored.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@scope/skin'])
    assert.equal(existsSync(join(profileDir, 'package.json.safemode.bak')), false)
    // 无备份时恢复返回 false
    assert.equal(restoreProfileManifest(profileDir), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('readProfileBundles：读取 dsh.profile.bundles', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    // 无 package.json → 空
    assert.deepEqual(readProfileBundles(root), [])
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-desktop',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-smoke-test'] } },
      }),
    )
    assert.deepEqual(readProfileBundles(root), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-smoke-test'])
    // 损坏 JSON → 空
    writeFileSync(join(root, 'package.json'), '{broken')
    assert.deepEqual(readProfileBundles(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('validatePluginDir：dsh.bundle.patch 相对路径校验', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const pkgDir = join(root, 'plugin')
    mkdirSync(pkgDir)
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {}')
    // 声明了 bundle.patch 且文件存在 → OK
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'dsh-patch-ok', main: 'index.js', dsh: { bundle: { patch: './bundle.patch.yml' } } }),
    )
    writeFileSync(join(pkgDir, 'bundle.patch.yml'), '- insert:\n')
    assert.deepEqual(validatePluginDir(pkgDir), { ok: true, name: 'dsh-patch-ok', version: null })
    // 声明指向不存在的文件 → 拒绝
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'dsh-patch-missing', dsh: { bundle: { patch: './nope.yml' } } }),
    )
    const missing = validatePluginDir(pkgDir)
    assert.equal(missing.ok, false)
    assert.match(missing.ok ? '' : missing.reason, /不存在/)
    // 越界路径 → 拒绝
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'dsh-patch-escape', dsh: { bundle: { patch: '../outside.yml' } } }),
    )
    const escape = validatePluginDir(pkgDir)
    assert.equal(escape.ok, false)
    assert.match(escape.ok ? '' : escape.reason, /越界/)
    // 无 bundle 声明 → 不受影响
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-plain', main: 'index.js' }))
    assert.deepEqual(validatePluginDir(pkgDir), { ok: true, name: 'dsh-plain', version: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shouldRetryLowerConcurrency：网络断流标志识别', () => {
  assert.equal(shouldRetryLowerConcurrency('GET x error (UND_ERR_DESTROYED). Will retry'), true)
  assert.equal(shouldRetryLowerConcurrency('ETIMEDOUT after 10000ms'), true)
  assert.equal(shouldRetryLowerConcurrency('ECONNRESET'), true)
  assert.equal(shouldRetryLowerConcurrency('socket hang up'), true)
  assert.equal(shouldRetryLowerConcurrency('ECONNREFUSED'), false)
  assert.equal(shouldRetryLowerConcurrency('package not found in registry'), false)
  assert.equal(shouldRetryLowerConcurrency(''), false)
})

test('cleanAllowBuildsForRemoved：卸载后清理 pnpm-workspace.yaml 残留', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    // 无 workspace 文件 → false
    assert.equal(cleanAllowBuildsForRemoved(root, ['git-dep']), false)
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      [
        'packages:\n  - .\n',
        'allowBuilds:\n',
        '  git+https://github.com/user/git-dep.git:\n',
        '    build:prepare\n',
        '  keep-me:\n',
        '    build:install\n',
      ].join(''),
    )
    // 目标键含 git+ 前缀 → 视为 git-dep 的条目被移除
    assert.equal(cleanAllowBuildsForRemoved(root, ['git-dep']), true)
    const cleaned = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
    assert.equal(cleaned.includes('git-dep.git'), false)
    assert.equal(cleaned.includes('keep-me'), true)
    // 再次清理无目标 → false
    assert.equal(cleanAllowBuildsForRemoved(root, ['git-dep']), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isValidPluginName / isReservedPluginName：路径穿越与保留名防护', () => {
  // 合法：普通名、scope 名、点分名
  assert.equal(isValidPluginName('my-plugin'), true)
  assert.equal(isValidPluginName('@scope/my-plugin'), true)
  assert.equal(isValidPluginName('foo.bar'), true)
  // 非法：穿越、绝对路径、盘符、多级分隔、保留字符、首尾空白、结尾点
  for (const bad of [
    '..', '.', '../evil', '..\\evil', 'a/b/c', '/abs', 'C:\\evil', 'C:evil', 'D:evil',
    'a b', ' foo', 'foo ', 'foo.', '@scope/..', '@scope/', '', 'x'.repeat(300),
    'a<b', 'a|b', 'a\u0000b', '..\\..\\..\\Documents\\x',
  ]) {
    assert.equal(isValidPluginName(bad), false, `should reject ${JSON.stringify(bad)}`)
  }
  assert.equal(isReservedPluginName('dsh-desktop-bridge'), true)
  // 大小写不敏感（Windows 文件系统上同名目录）
  assert.equal(isReservedPluginName('DSH-Desktop-Bridge'), true)
  assert.equal(isReservedPluginName(' dsh-desktop-bridge '), true)
  assert.equal(isReservedPluginName('dsh-desktop-bridge-copy'), false)
  assert.equal(isReservedPluginName('ui-dashboard'), false)
})

test('validatePluginDir：拒绝路径穿越包名与大小写变体 bridge', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const dir = join(root, 'payload')
    mkdirSync(dir)
    writeFileSync(join(dir, 'index.js'), '')
    for (const evil of ['..\\..\\..\\evil', '../../evil', 'C:evil', '/abs/evil', '@scope/../../../evil', '..']) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: evil, main: 'index.js' }))
      const v = validatePluginDir(dir)
      assert.equal(v.ok, false, `should reject ${JSON.stringify(evil)}`)
      if (!v.ok) assert.match(v.reason, /name/)
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'DSH-Desktop-Bridge', main: 'index.js' }))
    assert.equal(validatePluginDir(dir).ok, false)
    // 合法名（含 scope）不受影响
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/ok', main: 'index.js' }))
    assert.deepEqual(validatePluginDir(dir), { ok: true, name: '@scope/ok', version: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uninstallUserPlugin：拒绝穿越/保留名，绝不删除目录外路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const userDir = join(root, 'plugins')
    mkdirSync(userDir, { recursive: true })
    const victim = join(root, 'victim')
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, 'keep.txt'), 'keep')
    for (const evil of ['..\\victim', '../victim', join('..', '..', 'victim'), 'dsh-desktop-bridge', 'DSH-Desktop-Bridge']) {
      assert.equal(uninstallUserPlugin(evil, userDir), false, `should refuse ${evil}`)
    }
    assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'keep')
    // 正常名与 scope 名可删除（不误伤合法用法）
    mkdirSync(join(userDir, '@scope', 'pkg'), { recursive: true })
    assert.equal(uninstallUserPlugin('@scope/pkg', userDir), true)
    assert.equal(existsSync(join(userDir, '@scope', 'pkg')), false)
    const ok = join(userDir, 'ok-plugin')
    mkdirSync(ok, { recursive: true })
    assert.equal(uninstallUserPlugin('ok-plugin', userDir), true)
    assert.equal(existsSync(ok), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listUserPluginNames：跳过非法包名与 bridge 占名目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const userDir = join(root, 'user')
    const mk = (dirName, name) => {
      const d = join(userDir, dirName)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
      writeFileSync(join(d, 'index.js'), '')
    }
    mk('good', 'good-plugin')
    mk('evil', '..\\..\\evil')
    mk('fake-bridge', 'dsh-desktop-bridge')
    mk('also-bridge', 'DSH-Desktop-Bridge')
    assert.deepEqual(listUserPluginNames(userDir), ['good-plugin'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listDesktopPlugins：用户插件不得占用 bridge 保留名；同名用户插件覆盖内置', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const bundledDir = join(root, 'bundled')
    const userDir = join(root, 'user')
    const mk = (base, dirName, name, version) => {
      const d = join(base, dirName)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }))
      writeFileSync(join(d, 'index.js'), '')
    }
    mk(bundledDir, 'bridge', 'dsh-desktop-bridge', '1.0.0')
    mk(bundledDir, 'ui-dashboard', 'ui-dashboard', '2.0.0')
    mk(userDir, 'fake-bridge', 'dsh-desktop-bridge', '9.9.9')
    mk(userDir, 'fake-bridge-2', 'DSH-Desktop-Bridge', '9.9.9')
    mk(userDir, 'evil', '..\\..\\evil', '1.0.0')
    mk(userDir, 'ui-dashboard', 'ui-dashboard', '3.0.0')
    mk(userDir, 'extra', 'extra-plugin', '1.0.0')

    const skips = []
    const list = listDesktopPlugins(bundledDir, userDir, (m) => skips.push(m))
    // 用户侧：合法插件保留并覆盖内置同名；bridge 占名/穿越名被剔除
    // （readdirSync 顺序不保证，排序后比较）
    assert.deepEqual(
      list.map((p) => [p.name, p.source, p.version]).sort(),
      [
        ['dsh-desktop-bridge', 'bundled', '1.0.0'],
        ['extra-plugin', 'user', '1.0.0'],
        ['ui-dashboard', 'user', '3.0.0'],
      ].sort(),
    )
    assert.equal(skips.some((m) => m.includes('reserved system plugin name')), true)
    assert.equal(skips.some((m) => m.includes('invalid package name')), true)

    // 发现层同样跳过非法名（供 ensureProfile 等消费方复用）
    assert.deepEqual(
      discoverPluginsIn(userDir).map((p) => p.name).sort(),
      ['DSH-Desktop-Bridge', 'dsh-desktop-bridge', 'extra-plugin', 'ui-dashboard'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pluginProfileTarget：合法名拼进 node_modules；非法名返回 null', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pfs-'))
  try {
    const profileDir = join(root, 'profiles', 'desktop')
    assert.equal(
      pluginProfileTarget(profileDir, '@scope/pkg'),
      join(profileDir, 'node_modules', '@scope', 'pkg'),
    )
    // 保留名本身是合法路径（内置 bridge 需要同步到该目录），由调用方按来源决定放行
    assert.equal(
      pluginProfileTarget(profileDir, 'dsh-desktop-bridge'),
      join(profileDir, 'node_modules', 'dsh-desktop-bridge'),
    )
    for (const bad of ['..\\..\\evil', '../evil', 'C:evil', '/abs', '..', 'a/b/c']) {
      assert.equal(pluginProfileTarget(profileDir, bad), null, `should refuse ${JSON.stringify(bad)}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
