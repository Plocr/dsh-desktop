/**
 * 轻量日志：harness 输出 + 壳自身日志，落盘到 userData/logs。
 * 单文件超过 5MB 时轮转为 .old。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

let logDir = ''
let currentFile = ''
const MAX_BYTES = 5 * 1024 * 1024

function stamp(): string {
  const d = new Date()
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function initLogger(dir: string): void {
  logDir = dir
  mkdirSync(dir, { recursive: true })
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  currentFile = path.join(dir, `harness-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`)
}

export function logDirPath(): string {
  return logDir
}

export function log(level: 'info' | 'error', line: string): void {
  if (!currentFile) return
  try {
    if (existsSync(currentFile) && statSync(currentFile).size > MAX_BYTES) {
      renameSync(currentFile, `${currentFile}.old`)
    }
    appendFileSync(currentFile, `[${stamp()}] [${level}] ${line}\n`, 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
}
