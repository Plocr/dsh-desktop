import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readDesktopRuntime } from '../src/main/runtimeTree.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/main/hostProcess.ts'

/**
 * 随包运行时的**发行前提**校验（不触碰真实文件树：descriptor 是唯一输入）。
 *
 * 这里盯的是「静默哑掉」类故障：随包树少了 bridge，壳仍能启动、窗口仍能开，
 * 但徽标/通知/深链解析/工作区注册全部失灵——必须在启动校验里硬失败。
 */

const RELEASE = {
  schemaVersion: 1,
  version: '0.7.19',
  dshVersion: '0.1.5-rc.2',
  hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
  nodeVersion: '24.15.0',
  pnpmVersion: '10.34.5',
}

/** 写一份最小 descriptor（sharedPackages/files 由调用方给定）。 */
function writeDescriptor(sharedPackages) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-'))
  writeFileSync(
    path.join(dir, 'desktop-runtime.json'),
    JSON.stringify({ schemaVersion: 1, release: RELEASE, platform: process.platform, arch: process.arch, sharedPackages, files: [] }),
    'utf8',
  )
  return dir
}

const shared = (name, version) => ({ name, version, path: `node_modules/${name}` })

test('readDesktopRuntime：三件共享包齐全（dsh/host/bridge）时通过', () => {
  const dir = writeDescriptor([
    shared('@deepseek-ai/dsh', RELEASE.dshVersion),
    shared('dsh-desktop-host', RELEASE.dshVersion),
    shared('dsh-desktop-bridge', '0.4.0'),
  ])
  const descriptor = readDesktopRuntime(dir)
  assert.deepEqual(
    descriptor.sharedPackages.map((p) => p.name),
    ['@deepseek-ai/dsh', 'dsh-desktop-host', 'dsh-desktop-bridge'],
  )
})

test('readDesktopRuntime：缺 bridge 直接失败（防止"哑桥接"随包发行）', () => {
  const dir = writeDescriptor([
    shared('@deepseek-ai/dsh', RELEASE.dshVersion),
    shared('dsh-desktop-host', RELEASE.dshVersion),
  ])
  assert.throws(() => readDesktopRuntime(dir), /missing dsh-desktop-bridge/)
})

test('readDesktopRuntime：缺 host / dsh 版本不符同样失败', () => {
  assert.throws(
    () => readDesktopRuntime(writeDescriptor([shared('@deepseek-ai/dsh', RELEASE.dshVersion), shared('dsh-desktop-bridge', '0.4.0')])),
    /missing dsh-desktop-host/,
  )
  assert.throws(
    () =>
      readDesktopRuntime(
        writeDescriptor([
          shared('@deepseek-ai/dsh', '0.0.1'),
          shared('dsh-desktop-host', RELEASE.dshVersion),
          shared('dsh-desktop-bridge', '0.4.0'),
        ]),
      ),
    /missing or mismatched @deepseek-ai\/dsh/,
  )
})
