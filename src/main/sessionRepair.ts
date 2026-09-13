/**
 * 旧会话日志修复（v0 容器的 subagent descriptor 版本）。
 *
 * 背景：dsh ≥ 0.1.3 的 v0→v1 迁移要求 `subagent/descriptor` 事件的 `data.version === 3`；
 * 更早版本写下的 v0 日志里该字段是 2，迁移会整条拒绝（`uses unsupported descriptor
 * version 2; source v0 artifact remains unchanged`），表现为这些历史会话在 UI 里打不开。
 *
 * 修复方式：**最小改写**——只把该字段 2 → 3，其余帧字节原样保留，官方迁移链随后在
 * 打开会话时完成真正的格式转换；原文件另存为 `<名>.v0-original.bak`（不匹配 harness 的
 * 工件命名规则，不会被当作会话读取）。
 *
 * 安全边界：
 *  - 仅处理首帧为 `{"type":"session","version":0}` 的日志，且确实存在 descriptor v2；
 *  - 帧必须完整覆盖整个文件才写盘；任何异常（解帧失败/覆盖不全/写失败）跳过该文件，
 *    绝不半写；
 *  - 幂等：修复后再次运行无字段可改 → 不改写文件。
 * 纯 Node（fs/zlib），无 Electron 依赖，可单测。
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（小端读取 `28 b5 2f fd`）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 单文件大小上限（防御性：异常大文件不处理）。 */
const MAX_FILE_BYTES = 128 * 1024 * 1024

export interface SessionRepairReport {
  /** 扫描到的会话日志数 */
  scanned: number
  /** 实际修复（改写了 descriptor 版本）的日志数 */
  repaired: number
  /** 跳过数（非 v0 / 无需修复 / 解析失败） */
  skipped: number
  /** 被修复的会话 id（诊断用，最多 20 条） */
  repairedIds: string[]
}

/**
 * 按 zstd 魔数切帧（帧与帧紧邻）。每帧的真实结束位置用「从下一个魔数往前试解」确定
 * （帧尾可能带内容校验和，不能仅靠块头推算）。
 * @returns 帧区间数组；有任一帧解不开 → null（调用方跳过该文件）
 */
function splitZstdFrames(buf: Buffer): { start: number; end: number }[] | null {
  const starts: number[] = []
  let i = buf.indexOf(ZSTD_MAGIC)
  while (i !== -1) {
    starts.push(i)
    i = buf.indexOf(ZSTD_MAGIC, i + 4)
  }
  if (starts.length === 0) return null
  const frames: { start: number; end: number }[] = []
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]
    const limit = starts[k + 1] ?? buf.length
    let end = -1
    for (let e = limit; e > start + 8; e--) {
      try {
        zstdDecompressSync(buf.subarray(start, e))
        end = e
        break
      } catch {
        /* 继续缩小候选长度 */
      }
    }
    if (end === -1) return null
    frames.push({ start, end })
  }
  return frames
}

/** 把一帧里 `subagent/descriptor` 事件的 `data.version: 2` 改为 3。 */
function patchDescriptorLine(line: string): { line: string; patched: boolean } {
  if (!line.includes('"subagent/descriptor"')) return { line, patched: false }
  try {
    const ev = JSON.parse(line) as { type?: unknown; data?: { version?: unknown } }
    if (ev?.type === 'subagent/descriptor' && ev.data !== null && typeof ev.data === 'object' && ev.data.version === 2) {
      ev.data.version = 3
      return { line: JSON.stringify(ev), patched: true }
    }
  } catch {
    /* 非 JSON 行：保持原样 */
  }
  return { line, patched: false }
}

/**
 * 尝试修复单个日志文件。
 * @returns 'repaired' | 'skip'（含原因）
 */
export function repairSessionLogFile(file: string): { status: 'repaired' | 'skip'; reason?: string; patched?: number } {
  let buf: Buffer
  try {
    const st = statSync(file)
    if (!st.isFile()) return { status: 'skip', reason: 'not a file' }
    if (st.size > MAX_FILE_BYTES) return { status: 'skip', reason: 'too large' }
    buf = readFileSync(file)
  } catch (err) {
    return { status: 'skip', reason: `read failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  const frames = splitZstdFrames(buf)
  if (frames === null) return { status: 'skip', reason: 'unreadable zstd frames' }
  const header = (() => {
    try {
      const text = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8')
      return JSON.parse(text.split('\n')[0] ?? '') as { type?: unknown; version?: unknown }
    } catch {
      return null
    }
  })()
  if (header === null || header.type !== 'session' || header.version !== 0) {
    return { status: 'skip', reason: 'not a v0 session log' }
  }
  const out: Buffer[] = []
  let patched = 0
  for (const f of frames) {
    const raw = buf.subarray(f.start, f.end)
    let text: string
    try {
      text = zstdDecompressSync(raw).toString('utf8')
    } catch {
      return { status: 'skip', reason: 'frame decode failed' }
    }
    if (!text.includes('"subagent/descriptor"')) {
      out.push(raw) // 未改动的帧：原样保留（字节级不变）
      continue
    }
    let changed = false
    const next = text
      .split('\n')
      .map((line) => {
        const r = patchDescriptorLine(line)
        if (r.patched) {
          changed = true
          patched++
        }
        return r.line
      })
      .join('\n')
    out.push(changed ? zstdCompressSync(Buffer.from(next, 'utf8')) : raw)
  }
  if (patched === 0) return { status: 'skip', reason: 'no descriptor v2 to patch' }
  // 帧必须完整覆盖文件，否则放弃（避免写坏）
  const covered = frames[frames.length - 1]?.end ?? 0
  if (covered !== buf.length) return { status: 'skip', reason: `frames do not cover file (${covered}/${buf.length})` }
  const tmp = `${file}.repair-tmp`
  try {
    copyFileSync(file, `${file}.v0-original.bak`)
    writeFileSync(tmp, Buffer.concat(out))
    renameSync(tmp, file)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    return { status: 'skip', reason: `write failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { status: 'repaired', patched }
}

/** 会话根目录下的日志文件名（v0 代际沿用无版本后缀的名字）。 */
const LOG_NAME = 'session.jsonl.zstd'

/**
 * 扫描 `<dshHome>/sessions/<workspace>/<sessionId>/session.jsonl.zstd` 并修复。
 * @param sessionsDir `<dshHome>/sessions`
 */
export function repairLegacySubagentDescriptors(sessionsDir: string): SessionRepairReport {
  const report: SessionRepairReport = { scanned: 0, repaired: 0, skipped: 0, repairedIds: [] }
  if (!existsSync(sessionsDir)) return report
  let workspaces: string[] = []
  try {
    workspaces = readdirSync(sessionsDir)
  } catch {
    return report
  }
  for (const ws of workspaces) {
    const wsDir = path.join(sessionsDir, ws)
    let sessions: string[] = []
    try {
      if (!statSync(wsDir).isDirectory()) continue
      sessions = readdirSync(wsDir)
    } catch {
      continue
    }
    for (const id of sessions) {
      const file = path.join(wsDir, id, LOG_NAME)
      if (!existsSync(file)) continue
      report.scanned++
      const r = repairSessionLogFile(file)
      if (r.status === 'repaired') {
        report.repaired++
        if (report.repairedIds.length < 20) report.repairedIds.push(id)
      } else {
        report.skipped++
      }
    }
  }
  return report
}
