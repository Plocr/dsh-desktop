import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bundledHostEntry,
  resolveHostEntry,
  runtimeTreeHostEntry,
} from '../src/main/hostEntry.ts'

/**
 * Host 入口解析（0.8.9 结构性修复）：
 * 壳自带副本（`<appPath>/dist/main/host-entry.cjs`，打包态在 app.asar 里）优先，
 * 运行时树副本兜底——真机事故里被杀软删掉的正是后者，它不能是启动硬前提。
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-entry-'))
  return {
    root,
    appPath: join(root, 'app.asar'),
    runtimeDir: join(root, 'dsh'),
    writeBundled() {
      const file = bundledHostEntry(join(root, 'app.asar'))
      mkdirSync(join(root, 'app.asar', 'dist', 'main'), { recursive: true })
      writeFileSync(file, '/* shell-bundled host entry */\n')
      return file
    },
    writeTree() {
      const file = runtimeTreeHostEntry(join(root, 'dsh'))
      mkdirSync(join(root, 'dsh', 'node_modules', 'dsh-desktop-host', 'lib'), { recursive: true })
      writeFileSync(file, '/* runtime-tree host entry */\n')
      return file
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('壳自带副本与运行时树副本都在：选壳自带副本', () => {
  const fx = fixture()
  try {
    const bundled = fx.writeBundled()
    fx.writeTree()
    assert.deepEqual(resolveHostEntry(fx.appPath, fx.runtimeDir), { entry: bundled, bundled: true })
  } finally {
    fx.cleanup()
  }
})

test('运行时树入口缺失（被杀软隔离）：仍解析到壳自带副本', () => {
  const fx = fixture()
  try {
    const bundled = fx.writeBundled()
    assert.deepEqual(resolveHostEntry(fx.appPath, fx.runtimeDir), { entry: bundled, bundled: true })
  } finally {
    fx.cleanup()
  }
})

test('壳自带副本缺失（开发态直接跑源码）：退回运行时树副本', () => {
  const fx = fixture()
  try {
    const inTree = fx.writeTree()
    assert.deepEqual(resolveHostEntry(fx.appPath, fx.runtimeDir), { entry: inTree, bundled: false })
  } finally {
    fx.cleanup()
  }
})

test('两处都没有：返回 undefined（调用方按运行时被破坏处理）', () => {
  const fx = fixture()
  try {
    assert.equal(resolveHostEntry(fx.appPath, fx.runtimeDir), undefined)
  } finally {
    fx.cleanup()
  }
})
