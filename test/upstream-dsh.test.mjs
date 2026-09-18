import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPlan, nextShellVersion, pickHighestVersion, planSync } from '../scripts/upstream-dsh.mjs'

/**
 * 上游 dsh 更新流水线的纯逻辑（scripts/upstream-dsh.mjs）：
 * 它决定「官方发新版后，桌面端要不要动 pin、动哪些字段」，所以版本判定必须锁死。
 *
 * 最要紧的一条：npm 的 `latest` dist-tag 会低于实际最高版本（当前 latest=0.1.5-rc.2，
 * 而最高是 0.1.6-alpha.2）。如果按 latest 判断，自动化永远收不到官方更新。
 */

test('pickHighestVersion：按语义版本取最高，不看 dist-tag', () => {
  assert.equal(pickHighestVersion(['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2']), '0.1.6-alpha.2')
  assert.equal(pickHighestVersion(['0.1.2-alpha.5', '0.1.2-rc.1']), '0.1.2-rc.1')
  assert.equal(pickHighestVersion(['1.0.0-beta.1', '1.0.0']), '1.0.0')
  assert.equal(pickHighestVersion(['0.1.0', 'garbage', '', null]), '0.1.0')
  assert.equal(pickHighestVersion([]), null)
})

test('nextShellVersion：壳版本 patch+1（electron-updater 只认更高版本）', () => {
  assert.equal(nextShellVersion('0.8.2'), '0.8.3')
  assert.equal(nextShellVersion('1.0.0'), '1.0.1')
  assert.throws(() => nextShellVersion('v0.8'), /无法解析/u)
})

test('planSync：只改跟随 dsh 版本号的 pin，独立版本依赖不动', () => {
  const rootPkg = { version: '0.8.2', dshRuntime: { dsh: '0.1.6-alpha.2', node: 'v24.15.0', pnpm: '11.7.0' } }
  const hostPkg = {
    version: '0.1.6-alpha.2',
    dependencies: {
      '@deepseek-ai/cordis': '4.0.2',
      '@deepseek-ai/cordis-plugin-include': '1.0.7',
      '@deepseek-ai/dsh': '0.1.6-alpha.2',
      '@deepseek-ai/dsh-web-frontend': '0.1.6-alpha.2',
    },
  }
  const plan = planSync(rootPkg, hostPkg, '0.1.6-alpha.3')
  assert.equal(plan.shellVersion, '0.8.3')
  assert.deepEqual(
    plan.changes.map((c) => `${c.file}:${c.field}`).sort(),
    [
      'package.json:dshRuntime.dsh',
      'package.json:version',
      'packages/host/package.json:dependencies.@deepseek-ai/dsh',
      'packages/host/package.json:dependencies.@deepseek-ai/dsh-web-frontend',
      'packages/host/package.json:version',
    ],
  )
})

test('applyPlan：写回内存对象后字段一致；已是目标版本时幂等', () => {
  const rootPkg = { version: '0.8.2', dshRuntime: { dsh: '0.1.6-alpha.2', node: 'v24.15.0', pnpm: '11.7.0' } }
  const hostPkg = { version: '0.1.6-alpha.2', dependencies: { '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/dsh': '0.1.6-alpha.2' } }
  const plan = planSync(rootPkg, hostPkg, '0.1.6-alpha.3')
  applyPlan(rootPkg, hostPkg, plan, '0.1.6-alpha.3')
  assert.equal(rootPkg.version, '0.8.3')
  assert.equal(rootPkg.dshRuntime.dsh, '0.1.6-alpha.3')
  assert.equal(rootPkg.dshRuntime.node, 'v24.15.0') // 其它字段保持
  assert.equal(hostPkg.version, '0.1.6-alpha.3')
  assert.equal(hostPkg.dependencies['@deepseek-ai/dsh'], '0.1.6-alpha.3')
  assert.equal(hostPkg.dependencies['@deepseek-ai/cordis'], '4.0.2')

  const same = planSync(rootPkg, hostPkg, '0.1.6-alpha.3', null)
  assert.equal(same.changes.length, 0)
})
