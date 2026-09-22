import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROFILE_OWNED_PACKAGES,
  auditProfileDependencies,
  lockImporterDependencies,
  modulesManagedPackages,
  profilePnpmArgs,
  repairCommands,
  repairFingerprint,
  residueEntriesOf,
} from '../src/main/profileDeps.ts'
import { inspectProfile, listInstalledPackages, repairProfileIfNeeded } from '../src/main/profileRepair.ts'

/** 真机 profile 的 `.modules.yaml` 片段（2026-09-23 实测形状）。 */
const MODULES_YAML = `{
  "hoistPattern": [
    "*"
  ],
  "hoistedLocations": {
    "dsh-commandcode-goat@https://codeload.github.com/Plocr/dsh-commandcode-goat/tar.gz/bbafcc": [
      "node_modules\\\\dsh-commandcode-goat"
    ],
    "@standard-schema/spec@1.1.0": [
      "node_modules\\\\@standard-schema\\\\spec"
    ],
    "@deepseek-ai/schemastery@3.18.2": [
      "node_modules\\\\@deepseek-ai\\\\schemastery"
    ]
  },
  "nodeLinker": "hoisted",
  "packageManager": "pnpm@11.7.0"
}
`

/** 真机 `pnpm-lock.yaml` 的 importer 段（2026-09-23 实测形状）。 */
const LOCK_YAML = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false

importers:

  .:
    dependencies:
      dsh-commandcode-goat:
        specifier: github:Plocr/dsh-commandcode-goat
        version: https://codeload.github.com/Plocr/dsh-commandcode-goat/tar.gz/bbafcc
      '@scope/pkg':
        specifier: ^1.0.0
        version: 1.0.0

packages:

  '@scope/pkg@1.0.0':
    resolution: {integrity: sha512-x}

snapshots:

  '@scope/pkg@1.0.0': {}
`

test('modulesManagedPackages：读出 pnpm 托管过的包（作用域包与 github 版本串都要认）', () => {
  assert.deepEqual(modulesManagedPackages(MODULES_YAML), [
    'dsh-commandcode-goat',
    '@standard-schema/spec',
    '@deepseek-ai/schemastery',
  ])
  assert.deepEqual(modulesManagedPackages('{}'), [])
})

test('lockImporterDependencies：只取 importer `.` 的 dependencies（scoped/带引号同样认）', () => {
  assert.deepEqual(lockImporterDependencies(LOCK_YAML), ['dsh-commandcode-goat', '@scope/pkg'])
  assert.equal(lockImporterDependencies('lockfileVersion: 9.0\n'), null)
})

test('auditProfileDependencies：三档不一致（缺包 / 残留 / 锁文件脱节）分别判定', () => {
  const clean = auditProfileDependencies({
    declared: ['dsh-a'],
    installed: ['dsh-a', 'hoisted-transitive'],
    managed: ['dsh-a', 'hoisted-transitive'],
    lockImports: ['dsh-a'],
  })
  assert.deepEqual(clean.missing, [])
  assert.deepEqual(clean.residue, [])
  assert.deepEqual(clean.lockDrift, [])
  assert.equal(clean.needsRepair, false)

  // 真机状态：声明了 better-sidebar/skin，盘上只有上个事务的半成品 + 手链接进来的残留
  const real = auditProfileDependencies({
    declared: ['dsh-better-sidebar', '@linxin666/dsh-client-ui-skin-center'],
    installed: ['dsh-commandcode-goat', '@standard-schema/spec', 'dsh-opencode-go'],
    managed: ['dsh-commandcode-goat', '@standard-schema/spec'],
    lockImports: ['dsh-commandcode-goat'],
    pluginLike: ['dsh-opencode-go'],
  })
  assert.deepEqual(real.missing, ['dsh-better-sidebar', '@linxin666/dsh-client-ui-skin-center'])
  // pnpm 托管的传递依赖不算残留；手链接的插件算
  assert.deepEqual(real.residue, ['dsh-opencode-go'])
  assert.deepEqual(real.lockDrift, ['dsh-better-sidebar', '@linxin666/dsh-client-ui-skin-center'])
  assert.equal(real.needsRepair, true)
  assert.deepEqual(repairCommands(real), [
    'pnpm install',
    'remove dsh-opencode-go',
  ])

  // 锁文件读不出来时不猜（不触发锁文件那一档）
  const unknownLock = auditProfileDependencies({ declared: ['dsh-a'], installed: ['dsh-a'], managed: [], lockImports: null })
  assert.equal(unknownLock.lockKnown, false)
  assert.deepEqual(unknownLock.lockDrift, [])
})

test('residueEntriesOf：壳自有共享包与 pnpm 托管的包都不算残留', () => {
  assert.deepEqual(
    residueEntriesOf({
      declared: [],
      installed: [...PROFILE_OWNED_PACKAGES, 'dsh-managed', 'dsh-linked'],
      managed: ['dsh-managed'],
      lockImports: [],
      pluginLike: ['dsh-linked'],
    }),
    ['dsh-linked'],
  )
})

/**
 * 真机回归（2026-09-23，修复后立刻踩到）：`mermaid` 提升上来的 `cytoscape-cose-bilkent` /
 * `cytoscape-fcose` / `d3-transition` 既不在清单里、也不在 `.modules.yaml` 的托管表里，
 * 但它们**不是 dsh 插件**——只看前两条会误删依赖，把插件的界面直接打坏。
 */
test('residueEntriesOf：提升上来的传递依赖不是残留（没有 dsh 字段就不动它）', () => {
  const input = {
    declared: ['dsh-better-sidebar'],
    installed: ['dsh-better-sidebar', 'cytoscape-fcose', 'd3-transition', 'mermaid'],
    managed: ['dsh-better-sidebar'],
    lockImports: ['dsh-better-sidebar'],
    pluginLike: [], // 传递依赖都不自报插件
  }
  assert.deepEqual(residueEntriesOf(input), [])
  assert.equal(auditProfileDependencies(input).needsRepair, false)
})

test('repairFingerprint：只看包名集合（同状态同指纹，改清单即变）', () => {
  const base = auditProfileDependencies({ declared: ['dsh-a'], installed: [], managed: [], lockImports: [] })
  const same = auditProfileDependencies({ declared: ['dsh-a'], installed: [], managed: [], lockImports: ['dsh-a'] })
  // 锁文件那一档不同 → 指纹不同（否则「上次失败」的静默期会挡住新状态的修复）
  assert.notEqual(repairFingerprint(base), repairFingerprint(same))
  assert.equal(repairFingerprint(base), repairFingerprint({ ...base }))
})

test('profilePnpmArgs：store/registry/userconfig 与 Host 的 packageManager 同一套', () => {
  const args = profilePnpmArgs('/rt/pnpm/bin/pnpm.cjs', '/home/desktop/pnpm', 'install')
  assert.deepEqual(args, [
    '--use-system-ca',
    '/rt/pnpm/bin/pnpm.cjs',
    '--config.registry=https://registry.npmjs.org/',
    '--config.store-dir=/home/desktop/pnpm/store',
    '--config.enable-global-virtual-store=false',
    '--config.userconfig=/home/desktop/pnpm/config/npmrc',
    'install',
  ])
  // 不再带 --expose-internals（杀软行为启发式里很显眼的 flag；实测 pnpm 11 不需要）
  assert.equal(args.includes('--expose-internals'), false)
  // 但要带 --use-system-ca：安全软件的 TLS 扫描会让 Node 的 registry 请求死在自签证书链上
  assert.equal(args.includes('--use-system-ca'), true)
})

test('listInstalledPackages：只认带 package.json 的目录/链接（含作用域包）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deps-'))
  try {
    const profileDir = join(root, 'profile')
    for (const name of ['dsh-a', '@scope/pkg', '.bin', '.pnpm']) {
      mkdirSync(join(profileDir, 'node_modules', name), { recursive: true })
    }
    mkdirSync(join(profileDir, 'node_modules', 'empty-dir'), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', 'dsh-a', 'package.json'), '{"name":"dsh-a"}')
    writeFileSync(join(profileDir, 'node_modules', '@scope', 'pkg', 'package.json'), '{"name":"@scope/pkg"}')
    assert.deepEqual(listInstalledPackages(profileDir).sort(), ['@scope/pkg', 'dsh-a'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inspectProfile：四方状态直接从盘上读（真机形状的 manifest + 锁文件 + .modules.yaml）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deps-'))
  try {
    const profileDir = join(root, 'profile')
    const modules = join(profileDir, 'node_modules')
    mkdirSync(join(modules, 'dsh-commandcode-goat'), { recursive: true })
    writeFileSync(join(modules, 'dsh-commandcode-goat', 'package.json'), '{"name":"dsh-commandcode-goat"}')
    mkdirSync(join(modules, 'dsh-opencode-go'), { recursive: true })
    // 手链接进来的插件自报 dsh 插件（`dsh` 字段）；传递依赖没有这个字段
    writeFileSync(join(modules, 'dsh-opencode-go', 'package.json'), '{"name":"dsh-opencode-go","dsh":{"bundle":{}}}')
    mkdirSync(join(modules, 'cytoscape-fcose'), { recursive: true })
    writeFileSync(join(modules, 'cytoscape-fcose', 'package.json'), '{"name":"cytoscape-fcose"}')
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'dsh-better-sidebar': '^0.17.1' }, dsh: { profile: { bundles: [] } } }),
    )
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), LOCK_YAML)
    writeFileSync(join(modules, '.modules.yaml'), MODULES_YAML)
    const report = inspectProfile(profileDir)
    assert.deepEqual(report.declared, ['dsh-better-sidebar'])
    assert.deepEqual(report.missing, ['dsh-better-sidebar'])
    assert.deepEqual(report.residue, ['dsh-opencode-go'])
    assert.equal(report.lockKnown, true)
    assert.deepEqual(report.lockDrift, ['dsh-better-sidebar'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repairProfileIfNeeded：缺包时跑 pnpm install 并删掉残留插件（链接只删链接）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repair-'))
  try {
    const profileDir = join(root, 'profile')
    const modules = join(profileDir, 'node_modules')
    mkdirSync(join(modules, 'dsh-opencode-go'), { recursive: true })
    writeFileSync(join(modules, 'dsh-opencode-go', 'package.json'), '{"name":"dsh-opencode-go","dsh":{}}')
    mkdirSync(join(modules, 'dsh-desktop-bridge'), { recursive: true })
    writeFileSync(join(modules, 'dsh-desktop-bridge', 'package.json'), '{"name":"dsh-desktop-bridge"}')
    mkdirSync(join(modules, 'cytoscape-fcose'), { recursive: true })
    writeFileSync(join(modules, 'cytoscape-fcose', 'package.json'), '{"name":"cytoscape-fcose"}')
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ name: 'p', dependencies: { 'dsh-better-sidebar': '^0.17.1' }, dsh: { profile: { bundles: [] } } }),
    )
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n")
    writeFileSync(join(modules, '.modules.yaml'), '{\n  "hoistedLocations": {}\n}\n')
    const logs = []
    const spawns = []
    const result = await repairProfileIfNeeded({
      profileDir,
      node: '/rt/node',
      pnpmEntry: '/rt/pnpm.cjs',
      dshHome: root,
      markerFile: join(root, 'plugin-repair.json'),
      log: (level, message) => logs.push(`${level}:${message}`),
      spawnImpl: (command, args) => {
        spawns.push({ command, args })
        // 假 pnpm：立刻成功退出（不真的联网）
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = () => true
        setImmediate(() => child.emit('close', 0))
        return child
      },
    })
    assert.ok(result !== null)
    assert.equal(result.installed, true)
    assert.equal(result.installOk, true)
    assert.deepEqual(result.removed, ['dsh-opencode-go'])
    assert.deepEqual(result.report.missing, ['dsh-better-sidebar'])
    // 残留插件目录已删、壳自有共享包原样保留
    assert.equal(existsSync(join(modules, 'dsh-opencode-go')), false)
    assert.equal(existsSync(join(modules, 'dsh-desktop-bridge')), true)
    // 传递依赖（无 dsh 字段）绝不能被删
    assert.equal(existsSync(join(modules, 'cytoscape-fcose')), true)
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].command, '/rt/node')
    assert.ok(spawns[0].args.includes('install'))
    assert.ok(logs.some((line) => line.includes('插件残留')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
