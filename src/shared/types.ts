/**
 * 壳 <-> 面板（注入到 harness 页）共享类型。
 * 仅类型与纯数据形状，禁止引入 electron/主进程依赖（面板在浏览器侧打包）。
 */

export interface DashRuntime {
  pid?: unknown
  dshHome?: unknown
  cwd?: unknown
  node?: unknown
  uptimeMs?: number
  workspaces?: { id?: unknown; title?: unknown }[]
}

export interface DashJob {
  id?: unknown
  kind?: unknown
  label?: unknown
  status?: unknown
  owner?: unknown
}

export interface DashSession {
  id?: unknown
  title?: unknown
  live?: boolean
  createdAt?: unknown
}

export interface DashApproval {
  sessionId?: unknown
  askedAt?: number
}

export interface DashLogLine {
  stream: 'stdout' | 'stderr'
  text: string
  ts: number
}

/** 账户余额（bridge billing.balance 结果，主进程缓存）。 */
export interface DashBalance {
  isAvailable: boolean
  infos: { currency?: unknown; totalBalance?: unknown; grantedBalance?: unknown; toppedUpBalance?: unknown }[]
  fetchedAt: number
  error?: string
}

/** 主进程聚合后的仪表盘快照（dsh:dash:state）。 */
export interface DashSnapshot {
  harness: { state: string; url: string | null }
  bridge: boolean
  runtime: DashRuntime | null
  sessions: { live: number; persisted: number; rows: DashSession[] }
  jobs: DashJob[]
  approvals: DashApproval[]
  badge: number
  /** bridge 在线 = 'bridge'；离线降级 = 'dom'（面板 DOM 探测） */
  source: 'bridge' | 'dom'
  /** DeepSeek 账户余额（未拉取/失败时 null） */
  balance: DashBalance | null
}

/** 面板布局状态（dsh:dash:layout）。 */
export interface DashLayout {
  sidebar: boolean
  term: boolean
  sidebarWidth: number
  termHeight: number
}

/** 日志批：sync=true 表示全量基线（hello 时补发），其余为增量。 */
export interface DashLogBatch {
  sync: boolean
  lines: DashLogLine[]
}

/** 面板可用的 preload API 子集（window.dshDesktop）。 */
export interface PanelApi {
  onDashboardState: (cb: (s: DashSnapshot) => void) => () => void
  onDashboardLog: (cb: (batch: DashLogBatch) => void) => () => void
  onDashboardLayout: (cb: (l: DashLayout) => void) => () => void
  dashAction: (action: string, payload?: unknown) => Promise<unknown>
  termOpen: (shell?: string) => Promise<unknown>
  termWrite: (data: string) => Promise<unknown>
  termResize: (cols: number, rows: number) => Promise<unknown>
  termClose: () => Promise<unknown>
  onTermData: (cb: (data: string) => void) => () => void
  onTermExit: (cb: (info: { code: number | null }) => void) => () => void
}
