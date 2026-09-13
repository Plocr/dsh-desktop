import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadSafeMode,
  activateSafeMode,
  recordStartFailure,
  recordStartSuccess,
  isSafeMode,
  exitSafeMode,
  SAFE_MODE_THRESHOLD,
} from '../src/main/safeMode.ts'

function freshFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sm-'))
  return join(dir, 'safe-mode.json')
}

test('初始状态：非安全模式、零失败', () => {
  const f = freshFile()
  try {
    assert.deepEqual(loadSafeMode(f), { failCount: 0, safeMode: false, lastFailAt: null })
    assert.equal(isSafeMode(f), false)
  } finally {
    rmSync(f, { force: true })
  }
})

test(`连续失败 ${SAFE_MODE_THRESHOLD} 次触发安全模式；成功后计数清零但保留安全模式`, () => {
  const f = freshFile()
  try {
    let s = recordStartFailure(f)
    assert.equal(s.safeMode, false)
    s = recordStartFailure(f)
    assert.equal(s.safeMode, false)
    assert.equal(s.failCount, 2)
    s = recordStartFailure(f)
    assert.equal(s.safeMode, true)
    assert.equal(s.failCount, SAFE_MODE_THRESHOLD)
    assert.equal(isSafeMode(f), true)
    assert.equal(s.lastFailAt !== null, true)

    // 成功 ready：清零计数，但安全模式保持（由用户显式恢复）
    const ok = recordStartSuccess(f)
    assert.equal(ok.failCount, 0)
    assert.equal(ok.safeMode, true)
    assert.equal(isSafeMode(f), true)
  } finally {
    rmSync(f, { force: true })
  }
})

test('exitSafeMode：清计数并退出安全模式；写盘可跨重启', () => {
  const f = freshFile()
  try {
    recordStartFailure(f)
    recordStartFailure(f)
    recordStartFailure(f)
    assert.equal(isSafeMode(f), true)
    const s = exitSafeMode(f)
    assert.equal(s.safeMode, false)
    assert.equal(s.failCount, 0)
    assert.equal(isSafeMode(f), false)
    // 重新加载（模拟重启后读取）仍是退出状态
    assert.deepEqual(loadSafeMode(f), { failCount: 0, safeMode: false, lastFailAt: null })
  } finally {
    rmSync(f, { force: true })
  }
})

test('损坏的状态文件回退默认；文件不存在时 isSafeMode=false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sm-'))
  try {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{broken')
    assert.deepEqual(loadSafeMode(bad), { failCount: 0, safeMode: false, lastFailAt: null })
    assert.equal(isSafeMode(join(dir, 'missing.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('activateSafeMode：主动进入安全模式（不依赖失败计数）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sm-'))
  try {
    const f = join(root, 'safe-mode.json')
    // 从未失败也可主动进入
    const st = activateSafeMode(f)
    assert.equal(st.safeMode, true)
    assert.equal(st.failCount, 0)
    assert.equal(isSafeMode(f), true)
    // 退出后再次进入仍有效
    exitSafeMode(f)
    assert.equal(isSafeMode(f), false)
    const st2 = activateSafeMode(f)
    assert.equal(st2.safeMode, true)
    assert.equal(st2.failCount, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
