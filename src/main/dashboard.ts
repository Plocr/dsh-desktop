/**
 * 仪表盘状态聚合（主进程侧，纯逻辑可单测）。
 * 输入：harness 状态/日志、bridge 事件、bridge 快照 RPC；
 * 输出：渲染侧 JSON 快照（toSnapshot）+ 日志批量行。
 * 不依赖 Electron；副作用（发送）由调用方完成。
 */
import type { DashApproval, DashBalance, DashJob, DashLogLine, DashRuntime, DashSession, DashSnapshot } from '../shared/types'

export interface RingBufferOptions {
  cap: number
}

/** 定长环形缓冲（丢弃最旧）。 */
export class RingBuffer<T> {
  private items: T[] = []
  private readonly cap: number

  constructor(cap: number) {
    this.cap = cap
  }

  push(item: T): void {
    this.items.push(item)
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap)
  }

  get all(): T[] {
    return this.items
  }

  clear(): void {
    this.items = []
  }
}

/** harness 状态行：过滤发现行/空行，返回是否入流。 */
export function isFeedLine(stream: 'stdout' | 'stderr', line: string): boolean {
  if (!line) return false
  if (stream === 'stdout') {
    if (/^dsh web: /.test(line)) return false
    if (/^dsh desktop: /.test(line)) return false
  }
  return true
}

/** 日志行分级（启发式）：stderr → error；关键字 → warn；其余 info。 */
export function classifyLine(stream: 'stdout' | 'stderr', text: string): 'error' | 'warn' | 'info' {
  if (stream === 'stderr') return 'error'
  if (/\b(error|failed|failure|fatal|exception)\b/i.test(text)) return 'error'
  if (/\b(warn|warning)\b/i.test(text)) return 'warn'
  return 'info'
}

export const RUNNING_STATUSES = new Set(['running', 'starting', 'stopping'])

function runningCount(jobs: DashJob[]): number {
  return jobs.filter((j) => RUNNING_STATUSES.has(String(j.status))).length
}

export interface DashboardState {
  harnessState: string
  readyUrl: string | null
  bridgeConnected: boolean
  runtime: DashRuntime | null
  sessions: DashSession[]
  jobs: DashJob[]
  approvals: DashApproval[]
  balance: DashBalance | null
  startedAt: number
}

export function createDashboardState(): {
  state: DashboardState
  logs: RingBuffer<DashLogLine>
  applyHarnessState: (s: string) => void
  applyHarnessLog: (stream: 'stdout' | 'stderr', line: string) => DashLogLine | null
  setBridge: (connected: boolean) => void
  applyBridgeEvent: (type: string, payload: unknown) => void
  mergeSnapshot: (snap: unknown) => void
  mergeBalance: (balance: unknown) => void
  toSnapshot: () => DashSnapshot
} {
  const state: DashboardState = {
    harnessState: 'stopped',
    readyUrl: null,
    bridgeConnected: false,
    runtime: null,
    sessions: [],
    jobs: [],
    approvals: [],
    balance: null,
    startedAt: Date.now(),
  }
  const logs = new RingBuffer<DashLogLine>(300)

  const applyHarnessState = (s: string): void => {
    state.harnessState = s
  }

  const applyHarnessLog = (stream: 'stdout' | 'stderr', line: string): DashLogLine | null => {
    if (!isFeedLine(stream, line)) return null
    const entry: DashLogLine = { stream, text: line.slice(0, 2000), ts: Date.now() }
    logs.push(entry)
    return entry
  }

  const setBridge = (connected: boolean): void => {
    state.bridgeConnected = connected
  }

  const applyBridgeEvent = (type: string, payload: unknown): void => {
    const p = payload as { jobs?: unknown; job?: unknown; sessionId?: unknown } | undefined
    if (type === 'jobs.changed') {
      const list = Array.isArray(p?.jobs) ? (p.jobs as DashJob[]) : []
      state.jobs = list
    } else if (type === 'job.done') {
      const job = p?.job as DashJob | undefined
      if (job) {
        const idx = state.jobs.findIndex((j) => j.id === job.id)
        if (idx >= 0) state.jobs[idx] = { ...job, status: 'done' }
        else state.jobs = [...state.jobs, { ...job, status: 'done' }]
      }
    } else if (type === 'approval.asked') {
      const sessionId = p?.sessionId
      if (sessionId != null) {
        state.approvals = [...state.approvals, { sessionId, askedAt: Date.now() }].slice(-20)
      }
    }
  }

  const mergeSnapshot = (snap: unknown): void => {
    const s = snap as {
      runtime?: unknown
      sessions?: unknown
      jobs?: unknown
      approvals?: unknown
    } | null
    if (!s || typeof s !== 'object') return
    if (s.runtime && typeof s.runtime === 'object') state.runtime = s.runtime as DashRuntime
    if (Array.isArray(s.sessions)) state.sessions = s.sessions as DashSession[]
    if (Array.isArray(s.jobs)) state.jobs = s.jobs as DashJob[]
    if (Array.isArray(s.approvals)) state.approvals = s.approvals as DashApproval[]
  }

  const mergeBalance = (balance: unknown): void => {
    if (!balance || typeof balance !== 'object') return
    state.balance = balance as DashBalance
  }

  const toSnapshot = (): DashSnapshot => {
    const live = state.sessions.filter((s) => s.live).length
    return {
      harness: { state: state.harnessState, url: state.readyUrl },
      bridge: state.bridgeConnected,
      runtime: state.runtime,
      sessions: { live, persisted: state.sessions.length - live, rows: state.sessions.slice(0, 50) },
      jobs: state.jobs,
      approvals: state.approvals,
      badge: runningCount(state.jobs),
      source: state.bridgeConnected ? 'bridge' : 'dom',
      balance: state.balance,
    }
  }

  return {
    state,
    logs,
    applyHarnessState,
    applyHarnessLog,
    setBridge,
    applyBridgeEvent,
    mergeSnapshot,
    mergeBalance,
    toSnapshot,
  }
}

/** 供测试/复用：布局尺寸夹紧。 */
export function clampSize(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
