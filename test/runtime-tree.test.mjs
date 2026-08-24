import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readRuntimeTreeState,
  treeVersions,
  isTreeConsistent,
  treeFingerprint,
} from '../src/main/runtimeTree.ts'

/** 构造一个临时运行时目录（仅 @deepseek-ai scope 下几个包）。 */
function fixtureDir(versions) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-tree-'))
  for (const [name, version] of Object.entries(versions)) {
    const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', name)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version }), 'utf8')
  }
  return dir
}

test('runtimeTree: readRuntimeTreeState 只收集锁步包（-rc.）', () => {
  const dir = fixtureDir({
    dsh: '0.1.1-rc.2',
    'dsh-llm-deepseek': '0.1.1-rc.2',
    'dsh-llm': '0.1.0-rc.7',
    cordis: '4.0.1', // 稳定版 scoped 包：不参与锁步判定
  })
  try {
    const state = readRuntimeTreeState(dir)
    const names = state.map((e) => e.name)
    assert.ok(names.includes('@deepseek-ai/dsh'))
    assert.ok(names.includes('@deepseek-ai/dsh-llm-deepseek'))
    assert.ok(!names.includes('@deepseek-ai/cordis'), '稳定版 scoped 包应被排除')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runtimeTree: readRuntimeTreeState 目录不存在 → 空数组', () => {
  assert.deepEqual(readRuntimeTreeState(path.join(os.tmpdir(), 'dsh-nonexistent-xyz')), [])
})

test('runtimeTree: treeVersions / isTreeConsistent', () => {
  assert.equal(isTreeConsistent([]), true, '空树视为一致')
  assert.equal(isTreeConsistent(['0.1.1-rc.2']), true)
  assert.equal(isTreeConsistent(['0.1.1-rc.2', '0.1.1-rc.2', '0.1.1-rc.2']), true)
  assert.equal(isTreeConsistent(['0.1.1-rc.2', '0.1.0-rc.7']), false, '混血树不一致')
  assert.deepEqual(treeVersions([{ name: 'a', version: '1' }, { name: 'b', version: '2' }]), ['1', '2'])
})

test('runtimeTree: treeFingerprint 确定性与排序无关', () => {
  const a = treeFingerprint([{ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }, { name: '@deepseek-ai/dsh-llm', version: '0.1.1-rc.2' }])
  const b = treeFingerprint([{ name: '@deepseek-ai/dsh-llm', version: '0.1.1-rc.2' }, { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }])
  assert.equal(a, b, '排序无关')
  const c = treeFingerprint([{ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }, { name: '@deepseek-ai/dsh-llm', version: '0.1.0-rc.7' }])
  assert.notEqual(a, c, '版本变化 → 指纹变化')
})
