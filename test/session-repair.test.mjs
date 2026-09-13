import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { repairSessionLogFile, repairLegacySubagentDescriptors } from '../src/main/sessionRepair.ts'

/** 用若干「记录批次」拼一个 zstd 多帧日志（与 harness 的容器布局一致：帧紧邻拼接）。 */
function writeLog(file, batches) {
  const frames = batches.map((lines) => zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8')))
  writeFileSync(file, Buffer.concat(frames))
}

const HEADER = JSON.stringify({
  type: 'session',
  version: 0,
  id: 'sess-1',
  createdAt: 1786857442319,
  cwd: 'E:\\work',
  parentSession: 'session-parent',
  origin: 'subagent',
  delegationDepth: 1,
  agentPreset: 'standard',
})

const DESCRIPTOR_V2 = JSON.stringify({
  type: 'subagent/descriptor',
  seq: 0,
  time: 1786857442313,
  data: { version: 2, mode: 'continuable', provider: 'spawn', label: '调研' },
})

const EVENT = JSON.stringify({ type: 'turn/start', seq: 4, time: 1786857442400, data: { turn: 1 } })

/** 解出所有帧的文本（校验修复后可读）。 */
function decodeFrames(file) {
  const buf = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let i = buf.indexOf(magic)
  while (i !== -1) {
    starts.push(i)
    i = buf.indexOf(magic, i + 4)
  }
  const out = []
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]
    const limit = starts[k + 1] ?? buf.length
    for (let e = limit; e > start + 8; e--) {
      try {
        out.push(zstdDecompressSync(buf.subarray(start, e)).toString('utf8'))
        break
      } catch {
        /* 缩小候选长度 */
      }
    }
  }
  return out.join('\n')
}

test('repairSessionLogFile：把 descriptor v2 改为 3，其余帧字节不变，并留备份', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repair-'))
  try {
    const file = join(root, 'session.jsonl.zstd')
    writeLog(file, [[HEADER], [DESCRIPTOR_V2, EVENT], ['{"type":"turn/end","seq":5,"time":1,"data":{}}']])
    const before = readFileSync(file)
    const thirdFrameBytes = (() => {
      const buf = before
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
      const starts = []
      let i = buf.indexOf(magic)
      while (i !== -1) { starts.push(i); i = buf.indexOf(magic, i + 4) }
      return buf.subarray(starts[2])
    })()

    const r = repairSessionLogFile(file)
    assert.equal(r.status, 'repaired')
    assert.equal(r.patched, 1)

    const text = decodeFrames(file)
    const lines = text.split('\n')
    const desc = JSON.parse(lines.find((l) => l.includes('"subagent/descriptor"')))
    assert.equal(desc.data.version, 3, 'descriptor 版本应改为 3')
    assert.equal(desc.data.label, '调研', '其余字段保持不变')
    // 第三帧未被改写（字节级）
    const after = readFileSync(file)
    assert.deepEqual([...after.subarray(after.length - thirdFrameBytes.length)], [...thirdFrameBytes], '未改动帧应字节级保留')
    // 备份存在且是原始内容
    assert.equal(existsSync(`${file}.v0-original.bak`), true)
    assert.deepEqual([...readFileSync(`${file}.v0-original.bak`)], [...before])
    // 幂等：再跑一次不再改写
    const r2 = repairSessionLogFile(file)
    assert.equal(r2.status, 'skip')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repairSessionLogFile：非 v0 / 无 descriptor / 损坏文件都跳过且不改写', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repair-'))
  try {
    // v2 日志（当前格式）：不动
    const modern = join(root, 'modern.jsonl.zstd')
    writeLog(modern, [[JSON.stringify({ type: 'session', version: 2, id: 'x', createdAt: 1, cwd: 'c', isSeeded: false, origin: 'subagent', delegationDepth: 0 })]])
    const modernBefore = readFileSync(modern)
    assert.equal(repairSessionLogFile(modern).status, 'skip')
    assert.deepEqual([...readFileSync(modern)], [...modernBefore])

    // v0 但没有 descriptor 事件：无需修复
    const noDesc = join(root, 'nodesc.jsonl.zstd')
    writeLog(noDesc, [[HEADER], [EVENT]])
    assert.equal(repairSessionLogFile(noDesc).status, 'skip')

    // 损坏文件（非 zstd）：跳过
    const broken = join(root, 'broken.jsonl.zstd')
    writeFileSync(broken, 'not-zstd-data')
    const brokenBefore = readFileSync(broken)
    assert.equal(repairSessionLogFile(broken).status, 'skip')
    assert.deepEqual([...readFileSync(broken)], [...brokenBefore])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repairLegacySubagentDescriptors：扫描目录并汇总报告', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repair-'))
  try {
    const sessions = join(root, 'sessions')
    const ws = join(sessions, '--E-work--')
    mkdirSync(join(ws, 'a'), { recursive: true })
    mkdirSync(join(ws, 'b'), { recursive: true })
    mkdirSync(join(ws, 'c'), { recursive: true })
    writeLog(join(ws, 'a', 'session.jsonl.zstd'), [[HEADER], [DESCRIPTOR_V2]])
    writeLog(join(ws, 'b', 'session.jsonl.zstd'), [[HEADER], [EVENT]])
    writeLog(join(ws, 'c', 'session.jsonl.zstd'), [[JSON.stringify({ type: 'session', version: 2, id: 'c' })]])
    const report = repairLegacySubagentDescriptors(sessions)
    assert.equal(report.scanned, 3)
    assert.equal(report.repaired, 1)
    assert.equal(report.skipped, 2)
    assert.deepEqual(report.repairedIds, ['a'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
