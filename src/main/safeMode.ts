/**
 * 安全模式（保底启动）：
 * 插件问题（如坏插件导致 harness 启动即崩）会让应用陷入「打不开」的死循环。
 * 本模块记录 harness 连续启动失败次数：达到阈值后进入安全模式，
 * 此时 overlay 只加载 dsh-desktop-bridge（系统必需），其他插件全部停用，
 * 保证应用最低限度可用；用户可在托盘「退出安全模式」恢复。
 *
 * 设计：
 *  - 失败判定：某次启动（自上次 ready 以来）harness 以非零码退出 → 记一次失败
 *  - 成功判定：harness ready → 失败计数清零（但不自动退出安全模式，避免反复横跳）
 *  - 安全模式是显式状态，只能由用户手动退出；退出时同时清计数
 *  - 状态存 userData/safe-mode.json，跨重启保留
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readTextNoBom } from './pluginfs.ts'

export interface SafeModeState {
  /** 自上次成功 ready 以来连续启动失败次数 */
  failCount: number
  /** 安全模式是否激活 */
  safeMode: boolean
  /** 最近一次失败时间（epoch ms；null = 从未失败） */
  lastFailAt: number | null
}

export const SAFE_MODE_THRESHOLD = 3

const DEFAULT_STATE: SafeModeState = { failCount: 0, safeMode: false, lastFailAt: null }

export function loadSafeMode(file: string): SafeModeState {
  const out: SafeModeState = { ...DEFAULT_STATE }
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readTextNoBom(file)) as Partial<SafeModeState>
      if (typeof raw.failCount === 'number' && Number.isFinite(raw.failCount) && raw.failCount >= 0) {
        out.failCount = Math.floor(raw.failCount)
      }
      if (typeof raw.safeMode === 'boolean') out.safeMode = raw.safeMode
      if (typeof raw.lastFailAt === 'number' && Number.isFinite(raw.lastFailAt)) out.lastFailAt = raw.lastFailAt
    }
  } catch {
    /* 损坏则回退默认 */
  }
  return out
}

function saveSafeMode(file: string, s: SafeModeState): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    // 原子写：避免写入中途崩溃留下损坏 JSON（会让失败计数/安全模式状态丢失）
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    /* 写失败不影响主流程 */
  }
}

/**
 * 记录一次启动失败。返回更新后的状态（调用方可判断是否达到阈值进入安全模式）。
 */
export function recordStartFailure(file: string): SafeModeState {
  const s = loadSafeMode(file)
  s.failCount += 1
  s.lastFailAt = Date.now()
  if (s.failCount >= SAFE_MODE_THRESHOLD) s.safeMode = true
  saveSafeMode(file, s)
  return s
}

/**
 * 记录一次成功 ready：失败计数清零。
 * 不自动退出安全模式（安全模式由用户显式恢复，避免插件问题反复触发抖动）。
 */
export function recordStartSuccess(file: string): SafeModeState {
  const s = loadSafeMode(file)
  s.failCount = 0
  saveSafeMode(file, s)
  return s
}

/** 是否处于安全模式。 */
export function isSafeMode(file: string): boolean {
  return loadSafeMode(file).safeMode
}

/** 用户手动进入安全模式（同时清计数；退出由 exitSafeMode）。 */
export function activateSafeMode(file: string): SafeModeState {
  const s: SafeModeState = { failCount: 0, safeMode: true, lastFailAt: null }
  saveSafeMode(file, s)
  return s
}

export function exitSafeMode(file: string): SafeModeState {
  const s: SafeModeState = { failCount: 0, safeMode: false, lastFailAt: null }
  saveSafeMode(file, s)
  return s
}