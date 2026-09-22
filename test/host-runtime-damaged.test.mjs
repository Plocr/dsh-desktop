import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostManager } from '../src/main/host.ts'

/**
 * 真机回归（2026-09-23）：卡巴斯基把随包 Host 入口按启发式规则隔离掉之后，
 * 壳把它当「harness 崩溃」连续重启 → 三次失败进安全模式 → 用户看到的是"插件坏了"，
 * 而真实原因是**运行时文件被安全软件删了**。
 *
 * 契约：随包 Host 入口缺失时
 *  1. 不 spawn（`onRuntimeDamaged` 带缺失文件路径上报一次）；
 *  2. 不进入崩溃重启路径（不排重启定时器、`willRestart` 不为 true）；
 *  3. 状态落到 `stopped`（托盘/页面据此说明"文件缺失"，而不是"Harness 崩溃"）。
 */
test('Host 入口缺失：上报运行时损坏、不重启、不进崩溃路径', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-'))
  try {
    const runtimeDir = join(root, 'dsh')
    mkdirSync(join(runtimeDir, 'node_modules', 'dsh-desktop-host', 'lib'), { recursive: true })
    // 刻意不写 lib/index.js —— 模拟被安全软件隔离
    const projectDir = join(root, 'profile')
    mkdirSync(projectDir, { recursive: true })
    const damaged = []
    const exited = []
    const states = []
    const host = new HostManager(
      { node: process.execPath, runtimeDir, projectDir },
      {
        onReady: () => assert.fail('不该就绪'),
        onExit: (info) => exited.push(info),
        onLog: () => {},
        onState: (state) => states.push(state),
        onRuntimeDamaged: (info) => damaged.push(info),
      },
    )
    host.start()
    // 让可能被排上的重启定时器有机会跑（不该有）
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(exited, [], '不该走崩溃/退出路径')
    assert.equal(host.state, 'stopped')
    assert.deepEqual(states, ['stopped'], '唯一的状态转移是 starting 之前的 stopped')
    assert.equal(damaged.length, 1)
    assert.equal(damaged[0].entry, join(runtimeDir, 'node_modules', 'dsh-desktop-host', 'lib', 'index.js'))
    // 再调 start()（例如用户点「重启 Harness」）仍然只上报一次，不炸
    host.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(damaged.length, 2, '用户主动重试时允许再报一次（此时文件仍缺失）')
    await host.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Host 入口存在：照常走 spawn 路径（不误报运行时损坏）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-'))
  try {
    const runtimeDir = join(root, 'dsh')
    const hostLib = join(runtimeDir, 'node_modules', 'dsh-desktop-host', 'lib')
    mkdirSync(hostLib, { recursive: true })
    writeFileSync(join(hostLib, 'index.js'), '/* placeholder: 只验证前置检查不误报 */\n')
    const projectDir = join(root, 'profile')
    mkdirSync(projectDir, { recursive: true })
    const damaged = []
    const host = new HostManager(
      // 用一个不存在的 node 路径：spawn 会失败，但只要走到了 spawn 就说明前置检查通过了
      { node: join(root, 'no-such-node.exe'), runtimeDir, projectDir },
      {
        onReady: () => {},
        onExit: () => {},
        onLog: () => {},
        onState: () => {},
        onRuntimeDamaged: (info) => damaged.push(info),
      },
    )
    host.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(damaged, [], '入口存在时不该报运行时损坏')
    await host.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
