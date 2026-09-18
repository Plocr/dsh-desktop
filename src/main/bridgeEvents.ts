/**
 * 桥接事件 → 桌面动作（徽标/通知/托盘状态）的纯逻辑，独立成模块以便单元测试。
 * 不依赖 Electron；副作用经 effects 注入。
 */

export const RUNNING_STATUSES = new Set(['running', 'starting', 'stopping'])

/** bridge 发现行前缀（插件在 Host stdout 上打印 `dsh desktop: {"port":…,"token":…}`）。 */
export const BRIDGE_DISCOVERY_PREFIX = 'dsh desktop: '

/**
 * 壳↔插件握手协议版本，必须与 `packages/bridge/lib/index.js` 的常量一致
 * （有跨进程契约测试锁住两个值）。profile 层允许用户替换 bundle，不一致时
 * 壳要能一眼看出"不是同代"，而不是猜为什么通知不响。
 */
export const BRIDGE_PROTOCOL_VERSION = 1

export function runningJobCount(jobs: unknown[]): number {
  return jobs.filter(
    (j) => j && typeof j === 'object' && RUNNING_STATUSES.has(String((j as { status?: unknown }).status)),
  ).length
}

/**
 * 解析 bridge 发现行；非发现行或字段非法返回 null。
 *
 * token 长度下限：历史 overlay 模型下没有 config 注入点时，插件会宣告**空 token**
 * （等于完全不鉴权，本机任何进程都能连上）。宁可不连也不接受这种目标。
 */
export function parseBridgeDiscovery(line: string): { port: number; token: string } | null {
  if (typeof line !== 'string' || !line.startsWith(BRIDGE_DISCOVERY_PREFIX)) return null
  let info: { port?: unknown; token?: unknown }
  try {
    info = JSON.parse(line.slice(BRIDGE_DISCOVERY_PREFIX.length)) as { port?: unknown; token?: unknown }
  } catch {
    return null
  }
  const port = Number(info.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  if (typeof info.token !== 'string' || info.token.length < 16) return null
  return { port, token: info.token }
}

/**
 * 日志用：发现行只保留端口，token 一律脱敏。
 * 壳把 Host stdout 逐行落盘到 userData/logs，token 不该进持久化日志。
 */
export function redactBridgeLine(line: string): string {
  const target = parseBridgeDiscovery(line)
  if (target !== null) return `${BRIDGE_DISCOVERY_PREFIX}{"port":${target.port},"token":"<redacted>"}`
  // Web Host 的启动行同样带一次性 token（`dsh web: http://127.0.0.1:19387/?token=…`）：
  // 落盘前一并脱敏，日志里不留任何可用凭据。
  return line.replace(/([?&]token=)[^\s&"']+/gu, '$1<redacted>')
}

/* ── 会话目录（托盘「最近会话」/ 深链标题） ─────────────────────────── */

export interface BridgeSessionEntry {
  id: string
  title: string | null
  live: boolean
  createdAt: number | null
}

export type SessionIndex = Map<string, BridgeSessionEntry>

function sessionEntryOf(raw: unknown): BridgeSessionEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const s = raw as { id?: unknown; title?: unknown; live?: unknown; createdAt?: unknown }
  if (typeof s.id !== 'string' || s.id === '') return null
  return {
    id: s.id,
    title: typeof s.title === 'string' && s.title !== '' ? s.title : null,
    live: s.live === true,
    createdAt: typeof s.createdAt === 'number' && Number.isFinite(s.createdAt) ? s.createdAt : null,
  }
}

/**
 * `dashboard.snapshot` 与 `sessions.changed` 的 `sessions` 字段都是**合并后的全量目录**
 * （live + 持久化），因此两者都直接替换索引，不做增量拼装。
 */
export function sessionIndexFrom(payload: unknown): SessionIndex {
  const raw = (payload as { sessions?: unknown } | undefined)?.sessions
  const index: SessionIndex = new Map()
  if (!Array.isArray(raw)) return index
  for (const item of raw) {
    const entry = sessionEntryOf(item)
    if (entry !== null) index.set(entry.id, entry)
  }
  return index
}

/** 最近会话（新→旧），用于托盘菜单；无 createdAt 的排在最后。 */
export function recentSessions(index: SessionIndex, limit = 8): BridgeSessionEntry[] {
  return [...index.values()]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, Math.max(0, limit))
}

/** 托盘/深链显示用标题：无标题时退回 id 前 8 位。 */
export function sessionLabel(entry: BridgeSessionEntry | undefined, id: string): string {
  if (entry?.title) return entry.title
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/* ── 待审批环（托盘「待审批」提醒） ─────────────────────────────────── */

export interface PendingApproval {
  sessionId: string | null
  requestId: string | null
  toolName: string | null
}

export type ApprovalIndex = Map<string, PendingApproval>

function approvalOf(raw: unknown): PendingApproval | null {
  if (raw === null || typeof raw !== 'object') return null
  const a = raw as { sessionId?: unknown; requestId?: unknown; toolName?: unknown }
  const sessionId = typeof a.sessionId === 'string' && a.sessionId !== '' ? a.sessionId : null
  const requestId = typeof a.requestId === 'string' && a.requestId !== '' ? a.requestId : null
  const toolName = typeof a.toolName === 'string' && a.toolName !== '' ? a.toolName : null
  if (sessionId === null && requestId === null) return null
  return { sessionId, requestId, toolName }
}

/** 环键：优先 requestId（同一会话可以有多条审批排队），退化到 sessionId。 */
export function approvalKeyOf(entry: PendingApproval): string {
  return entry.requestId ?? entry.sessionId ?? 'unknown'
}

export function approvalsFromSnapshot(payload: unknown): ApprovalIndex {
  const raw = (payload as { approvals?: unknown } | undefined)?.approvals
  const index: ApprovalIndex = new Map()
  if (!Array.isArray(raw)) return index
  for (const item of raw) {
    const entry = approvalOf(item)
    if (entry !== null) index.set(approvalKeyOf(entry), entry)
  }
  return index
}

export function withApproval(index: ApprovalIndex, payload: unknown): ApprovalIndex {
  const entry = approvalOf(payload)
  if (entry === null) return index
  const next = new Map(index)
  next.set(approvalKeyOf(entry), entry)
  return next
}

export function withoutApproval(index: ApprovalIndex, payload: unknown): ApprovalIndex {
  const entry = approvalOf(payload)
  if (entry === null) return index
  const next = new Map(index)
  next.delete(approvalKeyOf(entry))
  return next
}

/** 最新一条待审批（托盘点击"去处理"用）。 */
export function latestApproval(index: ApprovalIndex): PendingApproval | null {
  let last: PendingApproval | null = null
  for (const entry of index.values()) last = entry
  return last
}

/* ── 诊断（bridge.diag） ───────────────────────────────────────────── */

export interface BridgeDiag {
  level: 'info' | 'warn' | 'error'
  code: string
  detail: unknown
}

export function diagOf(payload: unknown): BridgeDiag | null {
  if (payload === null || typeof payload !== 'object') return null
  const d = payload as { level?: unknown; code?: unknown; detail?: unknown }
  if (typeof d.code !== 'string' || d.code === '') return null
  const level = d.level === 'warn' || d.level === 'error' ? d.level : 'info'
  return { level, code: d.code, detail: d.detail ?? {} }
}

/* ── 事件 → 副作用 ─────────────────────────────────────────────────── */

export interface BridgeEventEffects {
  notify: (title: string, body: string, onClick?: () => void) => void
  setBadge: (count: number) => void
  /** 点击"需要审批"通知 / 托盘待审批条目 → 跳到该会话（可选，测试里可省） */
  openSession?: (sessionId: string) => void
  /** 插件诊断（连接状态、jobs 服务、协议不匹配…）→ 日志 + 托盘 */
  diag?: (diag: BridgeDiag) => void
}

/** 快照同步只需要徽标这一个副作用。 */
export type BridgeBadgeEffect = Pick<BridgeEventEffects, 'setBadge'>

export interface BridgeEventSettings {
  notifications: boolean
}

export interface BridgeSnapshotState {
  running: number
  sessions: SessionIndex
  approvals: ApprovalIndex
}

/**
 * `dashboard.snapshot` → 壳侧状态（连接/重连后事件增量已丢失，必须整份对齐）。
 */
export function handleBridgeSnapshot(payload: unknown, effects: BridgeBadgeEffect): BridgeSnapshotState {
  const jobs = (payload as { jobs?: unknown } | undefined)?.jobs
  const running = runningJobCount(Array.isArray(jobs) ? jobs : [])
  effects.setBadge(running)
  return { running, sessions: sessionIndexFrom(payload), approvals: approvalsFromSnapshot(payload) }
}

export function handleBridgeEvent(
  type: string,
  payload: unknown,
  settings: BridgeEventSettings,
  effects: BridgeEventEffects,
): void {
  const p = payload as
    | { job?: { id?: unknown; label?: unknown; status?: unknown }; sessionId?: unknown; toolName?: unknown }
    | undefined
  if (type === 'job.done') {
    if (settings.notifications) {
      const job = p?.job
      const label = typeof job?.label === 'string' && job.label ? job.label : ''
      const id = String(job?.id ?? '?')
      effects.notify('后台任务完成', label ? `任务 ${id}「${label.slice(0, 40)}」已结束` : `任务 ${id} 已结束`)
    }
    return
  }
  if (type === 'jobs.changed') {
    const jobs = (p as { jobs?: unknown[] } | undefined)?.jobs ?? []
    effects.setBadge(runningJobCount(jobs))
    return
  }
  if (type === 'approval.asked') {
    if (settings.notifications) {
      const tool = typeof p?.toolName === 'string' && p.toolName ? `（${p.toolName}）` : ''
      const sessionId = typeof p?.sessionId === 'string' && p.sessionId !== '' ? p.sessionId : null
      const onClick = sessionId !== null && effects.openSession ? (): void => effects.openSession?.(sessionId) : undefined
      effects.notify('需要审批', `会话 ${sessionId ?? '?'}${tool} 请求审批一个操作`, onClick)
    }
    return
  }
  if (type === 'bridge.diag') {
    const diag = diagOf(payload)
    if (diag !== null) effects.diag?.(diag)
  }
}
