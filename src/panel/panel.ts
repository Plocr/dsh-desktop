/**
 * DSH Desktop 右栏仪表盘（注入到 harness Web UI 页面）。
 *
 * 数据三源（主进程聚合后推送）：
 *  - bridge：实时 JSON（任务/会话/审批/运行时）——主数据；
 *  - 日志流：harness stdout/stderr 环形缓冲——活动流；
 *  - DOM 探测：桥接离线时的保底快照（source === 'dom'）。
 *
 * 主题：全部复用 harness 的 --dsw-alias-* 令牌（带兜底值），
 * 三态主题自动跟随；动效对齐 --ds-transition-duration-* / --ds-ease-in-out。
 */
import type { DashApproval, DashJob, DashLayout, DashLogLine, DashSnapshot } from '../shared/types'
import { WHALE_PATH } from './whale'
import { parseHarnessStats, parseContextUsage, type HarnessStats, type ContextUsage } from './stats'
import { estimateCost, formatUsd, formatCny, modelLabel } from './pricing'

const api = window.dshDesktop

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function $(sel: string): HTMLElement | null {
  return document.querySelector(sel)
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function alias(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback
}

/* ── 面板状态 ───────────────────────────────────────────────────────── */

interface PanelState {
  snap: DashSnapshot | null
  logs: DashLogLine[]
  layout: DashLayout
  logAuto: boolean
  lastApprovalCount: number
  termBooted: boolean
}

const state: PanelState = {
  snap: null,
  logs: [],
  layout: { sidebar: true, term: false, sidebarWidth: 300, termHeight: 200 },
  logAuto: true,
  lastApprovalCount: 0,
  termBooted: false,
}

const STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  done: '已完成',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const STATUS_CLS: Record<string, string> = {
  running: 'dshd-st-running',
  starting: 'dshd-st-running',
  stopping: 'dshd-st-running',
  done: 'dshd-st-done',
  completed: 'dshd-st-done',
  failed: 'dshd-st-failed',
  canceled: 'dshd-st-muted',
}

/* ── DOM 骨架 ───────────────────────────────────────────────────────── */

const SHELL_HTML = `
<div id="dshd-root" aria-label="DSH Desktop 仪表盘">
  <div id="dshd-resize" title="拖拽调整宽度"></div>
  <div id="dshd-head">
    <svg class="dshd-whale" viewBox="0 0 24 18" aria-hidden="true"><path d="${WHALE_PATH}"/></svg>
    <span id="dshd-title">仪表盘</span>
    <span id="dshd-dot" class="dshd-dot" title="桥接状态"></span>
    <button id="dshd-collapse" type="button" title="折叠（Ctrl+Shift+.）">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <g transform="translate(16,0) scale(-1,1)">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M9.67272 0.522841C10.8339 0.522841 11.76 0.522714 12.4963 0.602493C13.2453 0.683657 13.8789 0.854248 14.4264 1.25197C14.7504 1.48739 15.0355 1.77247 15.2709 2.0965C15.6686 2.64394 15.8392 3.27758 15.9204 4.02655C16.0002 4.7629 16 5.68895 16 6.85014V9.14986C16 10.3111 16.0002 11.2371 15.9204 11.9735C15.8392 12.7224 15.6686 13.3561 15.2709 13.9035C15.0355 14.2275 14.7504 14.5126 14.4264 14.748C13.8789 15.1458 13.2453 15.3163 12.4963 15.3975C11.76 15.4773 10.8339 15.4772 9.67272 15.4772H6.3273C5.16611 15.4772 4.24006 15.4773 3.50371 15.3975C2.75474 15.3163 2.1211 15.1458 1.57366 14.748C1.24963 14.5126 0.964549 14.2275 0.729131 13.9035C0.331407 13.3561 0.160817 12.7224 0.0796529 11.9735C-0.000126137 11.2371 1.25338e-09 10.3111 1.25338e-09 9.14986V6.85014C1.25329e-09 5.68895 -0.000126137 4.7629 0.0796529 4.02655C0.160817 3.27758 0.331407 2.64394 0.729131 2.0965C0.964549 1.77247 1.24963 1.48739 1.57366 1.25197C2.1211 0.854248 2.75474 0.683657 3.50371 0.602493C4.24006 0.522714 5.16611 0.522841 6.3273 0.522841H9.67272ZM5.54303 1.88715V14.1118C5.78636 14.1128 6.04709 14.1169 6.3273 14.1169H9.67272C10.8639 14.1169 11.7032 14.1164 12.3493 14.0465C12.9824 13.9779 13.3497 13.8494 13.6268 13.6482C13.8354 13.4966 14.0195 13.3125 14.1711 13.1039C14.3723 12.8268 14.5007 12.4595 14.5693 11.8264C14.6393 11.1803 14.6398 10.341 14.6398 9.14986V6.85014C14.6398 5.65896 14.6393 4.81967 14.5693 4.1736C14.5007 3.54048 14.3723 3.17318 14.1711 2.89609C14.0195 2.68747 13.8354 2.50337 13.6268 2.35179C13.3497 2.1506 12.9824 2.02212 12.3493 1.95353C11.7032 1.88358 10.8639 1.88307 9.67272 1.88307H6.3273C6.04709 1.88307 5.78636 1.8862 5.54303 1.88715ZM4.1828 1.91166C3.99125 1.9216 3.8148 1.93577 3.65076 1.95353C3.01764 2.02212 2.65034 2.1506 2.37325 2.35179C2.16463 2.50337 1.98052 2.68747 1.82895 2.89609C1.62776 3.17318 1.49928 3.54048 1.43069 4.1736C1.36074 4.81967 1.36023 5.65896 1.36023 6.85014V9.14986C1.36023 10.341 1.36074 11.1803 1.43069 11.8264C1.49928 12.4595 1.62776 12.8268 1.82895 13.1039C1.98052 13.3125 2.16463 13.4966 2.37325 13.6482C2.65034 13.8494 3.01764 13.9779 3.65076 14.0465C3.81478 14.0642 3.99127 14.0774 4.1828 14.0873V1.91166Z" fill="currentColor"></path>
        </g>
      </svg>
    </button>
  </div>
  <div id="dshd-body">
    <section class="dshd-sec" id="dshd-sec-context">
      <div class="dshd-sec-title"><span>上下文</span><span id="dshd-ctx-meta" class="dshd-sec-meta"></span></div>
      <div class="dshd-ctx" id="dshd-ctx" title="点击查看详情">
        <svg class="dshd-ctx-ring" viewBox="0 0 14 14" aria-hidden="true">
          <circle class="dshd-ctx-track" cx="7" cy="7" r="5.5"></circle>
          <circle class="dshd-ctx-fill" cx="7" cy="7" r="5.5" stroke-dasharray="0 34.55751918948772" transform="rotate(-90 7 7)"></circle>
        </svg>
        <div class="dshd-ctx-info">
          <div class="dshd-ctx-pct" id="dshd-ctx-pct">—</div>
          <div class="dshd-ctx-sub" id="dshd-ctx-sub">—</div>
        </div>
        <div class="dshd-ctx-breakdown" id="dshd-ctx-breakdown"></div>
      </div>
    </section>
    <section class="dshd-sec" id="dshd-sec-stats">
      <div class="dshd-sec-title"><span>会话指标</span><span id="dshd-stats-meta" class="dshd-sec-meta"></span></div>
      <div class="dshd-metrics" id="dshd-metrics"></div>
      <div class="dshd-cost" id="dshd-cost"></div>
    </section>
    <section class="dshd-sec" id="dshd-sec-balance">
      <div class="dshd-sec-title"><span>账户</span><button id="dshd-balance-refresh" type="button" class="dshd-sec-tools-btn" title="刷新余额">↻</button></div>
      <div class="dshd-balance" id="dshd-balance"></div>
    </section>
    <section class="dshd-sec">
      <div class="dshd-sec-title"><span>任务</span><span id="dshd-jobs-badge" class="dshd-badge" hidden></span></div>
      <div class="dshd-list" id="dshd-jobs"></div>
    </section>
    <section class="dshd-sec">
      <div class="dshd-sec-title"><span>审批</span><span id="dshd-approvals-meta" class="dshd-sec-meta"></span></div>
      <div class="dshd-list" id="dshd-approvals"></div>
    </section>
    <section class="dshd-sec dshd-sec-logs">
      <div class="dshd-sec-title">
        <span>活动流</span>
        <span class="dshd-sec-tools">
          <button id="dshd-log-pause" type="button" title="暂停/继续自动滚动">⏸</button>
          <button id="dshd-log-clear" type="button" title="清空">✕</button>
        </span>
      </div>
      <div id="dshd-logs" class="dshd-log"></div>
    </section>
  </div>
  <div id="dshd-foot">
    <span id="dshd-foot-badge">徽标 0</span>
    <span id="dshd-foot-event">—</span>
    <span id="dshd-foot-state">—</span>
  </div>
</div>
<div id="dshd-tab" aria-label="DSH Desktop 面板（已折叠）">
  <button type="button" id="dshd-tab-dash" class="dshd-rail-btn" title="展开仪表盘（Ctrl+Shift+.）">
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g transform="translate(16,0) scale(-1,1)">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M9.67272 0.522841C10.8339 0.522841 11.76 0.522714 12.4963 0.602493C13.2453 0.683657 13.8789 0.854248 14.4264 1.25197C14.7504 1.48739 15.0355 1.77247 15.2709 2.0965C15.6686 2.64394 15.8392 3.27758 15.9204 4.02655C16.0002 4.7629 16 5.68895 16 6.85014V9.14986C16 10.3111 16.0002 11.2371 15.9204 11.9735C15.8392 12.7224 15.6686 13.3561 15.2709 13.9035C15.0355 14.2275 14.7504 14.5126 14.4264 14.748C13.8789 15.1458 13.2453 15.3163 12.4963 15.3975C11.76 15.4773 10.8339 15.4772 9.67272 15.4772H6.3273C5.16611 15.4772 4.24006 15.4773 3.50371 15.3975C2.75474 15.3163 2.1211 15.1458 1.57366 14.748C1.24963 14.5126 0.964549 14.2275 0.729131 13.9035C0.331407 13.3561 0.160817 12.7224 0.0796529 11.9735C-0.000126137 11.2371 1.25338e-09 10.3111 1.25338e-09 9.14986V6.85014C1.25329e-09 5.68895 -0.000126137 4.7629 0.0796529 4.02655C0.160817 3.27758 0.331407 2.64394 0.729131 2.0965C0.964549 1.77247 1.24963 1.48739 1.57366 1.25197C2.1211 0.854248 2.75474 0.683657 3.50371 0.602493C4.24006 0.522714 5.16611 0.522841 6.3273 0.522841H9.67272ZM5.54303 1.88715V14.1118C5.78636 14.1128 6.04709 14.1169 6.3273 14.1169H9.67272C10.8639 14.1169 11.7032 14.1164 12.3493 14.0465C12.9824 13.9779 13.3497 13.8494 13.6268 13.6482C13.8354 13.4966 14.0195 13.3125 14.1711 13.1039C14.3723 12.8268 14.5007 12.4595 14.5693 11.8264C14.6393 11.1803 14.6398 10.341 14.6398 9.14986V6.85014C14.6398 5.65896 14.6393 4.81967 14.5693 4.1736C14.5007 3.54048 14.3723 3.17318 14.1711 2.89609C14.0195 2.68747 13.8354 2.50337 13.6268 2.35179C13.3497 2.1506 12.9824 2.02212 12.3493 1.95353C11.7032 1.88358 10.8639 1.88307 9.67272 1.88307H6.3273C6.04709 1.88307 5.78636 1.8862 5.54303 1.88715ZM4.1828 1.91166C3.99125 1.9216 3.8148 1.93577 3.65076 1.95353C3.01764 2.02212 2.65034 2.1506 2.37325 2.35179C2.16463 2.50337 1.98052 2.68747 1.82895 2.89609C1.62776 3.17318 1.49928 3.54048 1.43069 4.1736C1.36074 4.81967 1.36023 5.65896 1.36023 6.85014V9.14986C1.36023 10.341 1.36074 11.1803 1.43069 11.8264C1.49928 12.4595 1.62776 12.8268 1.82895 13.1039C1.98052 13.3125 2.16463 13.4966 2.37325 13.6482C2.65034 13.8494 3.01764 13.9779 3.65076 14.0465C3.81478 14.0642 3.99127 14.0774 4.1828 14.0873V1.91166Z" fill="currentColor"></path>
      </g>
    </svg>
    <span id="dshd-tab-badge" hidden></span>
  </button>
  <button type="button" id="dshd-tab-term" class="dshd-rail-btn" title="显示终端（Ctrl+Shift+\`）">
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M2 1.5A1.5 1.5 0 0 0 .5 3v10A1.5 1.5 0 0 0 2 14.5h12a1.5 1.5 0 0 0 1.5-1.5V3A1.5 1.5 0 0 0 14 1.5H2Zm0 1.05h12a.45.45 0 0 1 .45.45v10a.45.45 0 0 1-.45.45H2a.45.45 0 0 1-.45-.45V3A.45.45 0 0 1 2 2.55Zm2.4 2.85a.55.55 0 0 0-.78.78l1.9 1.9-1.9 1.9a.55.55 0 1 0 .78.78l2.3-2.3a.55.55 0 0 0 0-.78l-2.28-2.28Zm3.7 4.5h3.3a.55.55 0 0 0 0-1.1H8.1a.55.55 0 1 0 0 1.1Z" fill="currentColor"></path>
    </svg>
  </button>
</div>
<div id="dshd-term" aria-label="DSH Desktop 终端">
  <div id="dshd-term-resize" title="拖拽调整高度"></div>
  <div id="dshd-term-bar">
    <button class="dshd-term-newshell" data-shell="powershell" type="button" title="新建 PowerShell 会话">PS</button>
    <button class="dshd-term-newshell" data-shell="cmd" type="button" title="新建 cmd 会话">cmd</button>
    <button class="dshd-term-newshell" data-shell="pwsh" type="button" title="新建 pwsh 会话">pwsh</button>
    <div id="dshd-term-tabs"></div>
    <span class="dshd-term-spacer"></span>
    <button id="dshd-term-ext" type="button" title="在独立窗口打开系统终端（完整 TTY）">⧉</button>
    <button id="dshd-term-new" type="button" title="新建终端（当前工作区）">＋</button>
    <button id="dshd-term-close" type="button" title="收起终端（Ctrl+Shift+\`）">✕</button>
  </div>
  <div id="dshd-term-xterm"></div>
  <div id="dshd-term-overlay" hidden></div>
</div>
`

/* ── 渲染 ───────────────────────────────────────────────────────────── */

function renderDot(): void {
  const dot = $('#dshd-dot')
  const s = state.snap
  if (!s) {
    dot?.classList.add('dshd-dot-off')
    return
  }
  const cls = s.bridge ? 'dshd-dot-ok' : s.harness.state === 'ready' ? 'dshd-dot-warn' : 'dshd-dot-off'
  dot?.classList.remove('dshd-dot-ok', 'dshd-dot-warn', 'dshd-dot-off')
  dot?.classList.add(cls)
  const title = s.bridge ? '桥接在线' : s.harness.state === 'ready' ? '桥接离线' : 'Harness 未就绪'
  dot?.setAttribute('title', title)
}

const HARNESS_STATE_TEXT: Record<string, string> = {
  ready: '运行中',
  starting: '启动中',
  stopped: '已停止',
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function renderJobs(): void {
  const s = state.snap
  const host = $('#dshd-jobs')
  const badge = $('#dshd-jobs-badge')
  if (!host) return
  const jobs: DashJob[] = s?.jobs ?? []
  const running = jobs.filter((j) => ['running', 'starting', 'stopping'].includes(String(j.status)))
  if (badge) {
    if (running.length > 0) {
      badge.hidden = false
      badge.textContent = String(running.length)
      badge.classList.remove('dshd-bump')
      void badge.offsetWidth // 重启动画
      badge.classList.add('dshd-bump')
    } else {
      badge.hidden = true
    }
  }
  if (jobs.length === 0) {
    host.innerHTML = `<div class="dshd-empty">无任务</div>`
    return
  }
  const order = [...running, ...jobs.filter((j) => !['running', 'starting', 'stopping'].includes(String(j.status)))]
  host.innerHTML = order
    .slice(0, 20)
    .map((j) => {
      const status = String(j.status ?? '?')
      const cls = STATUS_CLS[status] ?? 'dshd-st-muted'
      const label = typeof j.label === 'string' && j.label ? j.label : String(j.id ?? '?')
      const kind = typeof j.kind === 'string' && j.kind ? j.kind : ''
      const owner = typeof j.owner === 'string' && j.owner ? j.owner : ''
      return `<div class="dshd-job" data-status="${esc(status)}">
        <span class="dshd-job-label" title="${esc(label)}">${esc(label)}</span>
        <span class="dshd-job-sub">${esc([kind, owner].filter(Boolean).join(' · '))}</span>
        <span class="dshd-pill ${cls}">${esc(STATUS_TEXT[status] ?? status)}</span>
      </div>`
    })
    .join('')
}

function renderApprovals(): void {
  const s = state.snap
  const host = $('#dshd-approvals')
  const meta = $('#dshd-approvals-meta')
  if (!host) return
  const rows: DashApproval[] = s?.approvals ?? []
  if (meta) meta.textContent = rows.length > 0 ? String(rows.length) : ''
  if (rows.length === 0) {
    host.innerHTML = `<div class="dshd-empty">无待审批</div>`
    return
  }
  const fresh = rows.length > state.lastApprovalCount
  host.innerHTML = rows
    .slice(-8)
    .reverse()
    .map((a) => {
      const t = typeof a.askedAt === 'number' ? fmtTime(a.askedAt) : ''
      return `<div class="dshd-appr${fresh ? ' dshd-flash' : ''}"><span class="dshd-appr-id">${esc(a.sessionId ?? '?')}</span><span class="dshd-appr-t">${esc(t)}</span></div>`
    })
    .join('')
  state.lastApprovalCount = rows.length
}

/** 账户余额：DeepSeek /user/balance（bridge RPC，key 不出 harness）。 */
function renderBalance(): void {
  const host = $('#dshd-balance')
  if (!host) return
  const b = state.snap?.balance
  if (!b) {
    host.innerHTML = `<div class="dshd-empty">余额未拉取</div>`
    return
  }
  if (b.error) {
    host.innerHTML = `<div class="dshd-balance-err">${esc(b.error)}</div>`
    return
  }
  const infos = b.infos ?? []
  if (infos.length === 0) {
    host.innerHTML = `<div class="dshd-empty">暂无余额信息</div>`
    return
  }
  // API 返回的金额可能是字符串（"19.28"），统一数值化
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return null
  }
  host.innerHTML = infos
    .map((info) => {
      const total = num(info.totalBalance)
      const currency = String(info.currency ?? 'CNY')
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `
      const fmt = (n: number | null): string => (n != null ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—')
      const topped = num(info.toppedUpBalance)
      const granted = num(info.grantedBalance)
      const parts: string[] = []
      if (topped != null) parts.push(`充值 ${symbol}${fmt(topped)}`)
      if (granted != null && granted > 0) parts.push(`赠送 ${symbol}${fmt(granted)}`)
      return `<div class="dshd-balance-main"><span class="dshd-balance-v">${symbol}${fmt(total)}</span><span class="dshd-balance-t">${esc(currency)} 可用</span></div>
        <div class="dshd-balance-sub">${esc(parts.join(' · '))}</div>`
    })
    .join('')
}

function renderLogs(): void {
  const host = $('#dshd-logs')
  if (!host) return
  const lines = state.logs.slice(-200)
  const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40
  host.innerHTML = lines
    .map(
      (l) =>
        `<div class="dshd-log-line" data-stream="${l.stream}"><span class="dshd-log-t">${fmtTime(l.ts)}</span><span class="dshd-log-dot"></span><span class="dshd-log-text">${esc(l.text)}</span></div>`,
    )
    .join('')
  // 自动滚动仅在用户位于底部附近时生效（手动上翻阅读不被打断）
  if (state.logAuto && nearBottom) {
    host.scrollTop = host.scrollHeight
  }
}

function renderFoot(): void {
  const s = state.snap
  if (!s) return
  const badge = $('#dshd-foot-badge')
  const ev = $('#dshd-foot-event')
  const st = $('#dshd-foot-state')
  if (badge) badge.textContent = `徽标 ${s.badge}`
  if (ev) ev.textContent = `来源 ${s.source === 'dom' ? 'DOM 快照' : '桥接'}`
  if (st) st.textContent = HARNESS_STATE_TEXT[s.harness.state] ?? s.harness.state
}

/** rail 上仪表盘按钮的运行任务角标（有运行任务时亮蓝点）。 */
function renderTabBadge(): void {
  const b = $('#dshd-tab-badge')
  if (b) b.hidden = !(state.snap && state.snap.badge > 0)
}

function renderAll(): void {
  renderDot()
  renderJobs()
  renderApprovals()
  renderFoot()
  renderTabBadge()
  renderBalance()
}

/* ── DOM 探测兜底（桥接离线时，2s 轮询） ─────────────────────────────── */

let domProbeTimer: number | null = null

function startDomProbe(): void {
  if (domProbeTimer !== null) return
  domProbeTimer = window.setInterval(() => {
    const snap = state.snap
    if (!snap) return
    if (snap.bridge) return // 桥接恢复即停
    const treeItems = document.querySelectorAll('[role="treeitem"]').length
    const runningPills = document.querySelectorAll('[data-state="running"], [data-state="starting"]').length
    const selected = document.querySelector('[role="treeitem"][aria-selected="true"], [role="treeitem"].selected')
    const title = selected?.textContent?.trim().slice(0, 40) ?? null
    snap.sessions = { ...snap.sessions, live: treeItems, persisted: 0, rows: snap.sessions.rows }
    if (title) {
      const first = snap.sessions.rows[0]
      if (first) first.title = title
    }
    // 任务计数仅作近似展示（data-state 可能被其他组件复用）
    const jobs = [...snap.jobs]
    if (runningPills > 0 && jobs.length === 0) {
      for (let i = 0; i < runningPills; i++) jobs.push({ id: `dom-${i}`, kind: 'probe', label: '(DOM 探测)', status: 'running' })
    }
    snap.jobs = jobs
    snap.source = 'dom'
    renderAll()
  }, 2000)
}

function stopDomProbe(): void {
  if (domProbeTimer !== null) {
    clearInterval(domProbeTimer)
    domProbeTimer = null
  }
}

/* ── 上下文环 / 会话指标 / 左栏宽度（harness DOM 常驻轮询，2s） ─────── */

let domPollTimer: number | null = null
let lastCtxBtn: HTMLElement | null = null

/** 格式化 token 数：80600 → "80.6K"，1e6 → "1M"。 */
function fmtTokens(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 1000).toFixed(1)}s`
}

function pollContext(): void {
  const btn = document.querySelector<HTMLElement>('button[aria-label*="上下文已用"]')
  const pctEl = $('#dshd-ctx-pct')
  const subEl = $('#dshd-ctx-sub')
  const ring = document.querySelector<SVGCircleElement>('#dshd-ctx .dshd-ctx-fill')
  const meta = $('#dshd-ctx-meta')
  const breakdown = $('#dshd-ctx-breakdown')
  lastCtxBtn = btn
  if (!btn) {
    if (pctEl) pctEl.textContent = '—'
    if (subEl) subEl.textContent = '未打开会话'
    if (meta) meta.textContent = ''
    if (breakdown) breakdown.innerHTML = ''
    if (ring) ring.setAttribute('stroke-dasharray', '0 34.55751918948772')
    return
  }
  // 明细：上溯含 "~X / Y" 的容器文本
  let detail = ''
  let el: HTMLElement | null = btn
  for (let i = 0; i < 5 && el; i++) {
    const t = el.innerText ?? ''
    if (/~?\s*[\d.]+\s*[KMB]?\s*\/\s*[\d.]+\s*[KMB]?/.test(t)) {
      detail = t
      break
    }
    el = el.parentElement
  }
  const u = parseContextUsage(btn.getAttribute('aria-label') ?? '', detail)
  const pct = u.percent ?? 0
  if (ring) ring.setAttribute('stroke-dasharray', `${(pct / 100) * 34.55751918948772} 34.55751918948772`)
  if (pctEl) pctEl.textContent = u.percent != null ? `${Math.round(u.percent)}%` : '—'
  if (subEl) subEl.textContent = `${fmtTokens(u.usedTokens)} / ${fmtTokens(u.windowTokens)}`
  if (meta) meta.textContent = u.windowTokens != null ? `窗口 ${fmtTokens(u.windowTokens)}` : ''
  if (breakdown) {
    const b = u.breakdown
    const parts: [string, number | null | undefined][] = [
      ['系统', b.system],
      ['工具', b.tools],
      ['对话', b.messages],
    ]
    breakdown.innerHTML = parts
      .filter(([, v]) => v != null)
      .map(([k, v]) => `<span class="dshd-ctx-part">${k} ${fmtTokens(v ?? null)}</span>`)
      .join('')
  }
}

function findStatsEl(): HTMLElement | null {
  let el = document.querySelector<HTMLElement>('.FJxK0a_root')
  if (el) return el
  const span = [...document.querySelectorAll('span')].find(
    (s) => /轮\s*·\s*\d+\s*步/.test(s.textContent || '') && (s.textContent || '').length < 40,
  )
  if (!span) return null
  el = span as HTMLElement
  for (let i = 0; i < 6 && el.parentElement; i++) {
    el = el.parentElement
    if ((el.innerText || '').includes('缓存命中')) break
  }
  return el
}

function detectModel(): string {
  const el = [...document.querySelectorAll('div,span')].find(
    (e) => /DeepSeek-?V?\d/i.test(e.textContent || '') && (e.textContent || '').length < 40,
  )
  const t = el?.textContent ?? ''
  // 只取型号名（如 DeepSeek-V4-Flash），不吞后续模式名（Max/Reasoning 等）
  const m = /DeepSeek[-\s]*V?\d+(?:\.\d+)?(?:-[A-Za-z0-9]+)?/i.exec(t)
  return m ? m[0] : 'deepseek-v4-flash'
}

function renderStats(st: HarnessStats): void {
  const host = $('#dshd-metrics')
  const cost = $('#dshd-cost')
  const meta = $('#dshd-stats-meta')
  if (!host) return
  const runMs = st.llmMs != null || st.toolMs != null ? (st.llmMs ?? 0) + (st.toolMs ?? 0) : null
  const items: [string, string][] = [
    ['缓存命中', st.cacheHitPct != null ? `${Math.round(st.cacheHitPct)}%` : '—'],
    ['运行时间', fmtMs(runMs)],
    ['轮 · 步', st.turns != null ? `${st.turns} · ${st.steps ?? '?'}` : '—'],
    ['首 token', fmtMs(st.ttftAvgMs)],
    ['速率', st.tokPerSec != null ? `${st.tokPerSec} tok/s` : '—'],
    ['输入 / 输出', `${fmtTokens(st.inputTokens)} / ${fmtTokens(st.outputTokens)}`],
  ]
  host.innerHTML = items.map(([k, v]) => `<div class="dshd-metric"><span class="dshd-metric-k">${esc(k)}</span><span class="dshd-metric-v" title="${esc(v)}">${esc(v)}</span></div>`).join('')
  if (meta) meta.textContent = st.raw ? `已更新 ${fmtTime(Date.now())}` : ''
  // 费用估算（deepseek 定价表，见 src/panel/pricing.ts；请求数 harness 未暴露 → 显示 —）
  if (cost) {
    if (st.inputTokens == null) {
      cost.innerHTML = `<span class="dshd-cost-note">计费估算需要输入/输出 tokens</span>`
      return
    }
    const model = detectModel()
    const usd = estimateCost(model, 'current', st.inputTokens, st.outputTokens ?? 0, (st.cacheHitPct ?? 0) / 100)
    const reqText = st.steps != null ? String(st.steps) : '—'
    cost.innerHTML = `<span class="dshd-cost-note">费用（${esc(modelLabel(model))}）</span>
      <span class="dshd-cost-v">${formatUsd(usd)} <span class="dshd-cost-cny">≈ ${formatCny(usd)}</span></span>
      <span class="dshd-cost-req">请求数 ${esc(reqText)}（步骤近似）</span>`
  }
}

function pollStats(): void {
  const el = findStatsEl()
  const host = $('#dshd-metrics')
  const cost = $('#dshd-cost')
  if (!el) {
    if (host) host.innerHTML = `<div class="dshd-empty">未打开会话</div>`
    if (cost) cost.innerHTML = ''
    $('#dshd-stats-meta') && ($('#dshd-stats-meta')!.textContent = '')
    return
  }
  const st = parseHarnessStats(el.innerText)
  if (st.turns == null && st.cacheHitPct == null && st.inputTokens == null) {
    if (host) host.innerHTML = `<div class="dshd-empty">会话暂无统计</div>`
    if (cost) cost.innerHTML = ''
    return
  }
  renderStats(st)
}

/** 左侧 harness 侧边栏宽度 → --dshd-left-w（终端/面板让位用）。 */
function pollLeftWidth(): void {
  const rail = document.querySelector<HTMLElement>('.hHd-Xa_root')
  if (!rail) return
  const w = Math.round(rail.getBoundingClientRect().width)
  if (w > 0) document.documentElement.style.setProperty('--dshd-left-w', `${w}px`)
}

function startDomPoll(): void {
  if (domPollTimer !== null) return
  domPollTimer = window.setInterval(() => {
    pollContext()
    pollStats()
    pollLeftWidth()
  }, 2000)
}

/* ── 拖拽调整尺寸 ───────────────────────────────────────────────────── */

function dragResize(
  handle: HTMLElement,
  mode: 'sidebar' | 'term',
  onMove: (e: PointerEvent) => number | null,
  onDone: (v: number) => void,
): void {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const v = onMove(ev)
      if (v != null) {
        document.documentElement.style.setProperty(mode === 'sidebar' ? '--dshd-w' : '--dshd-h', `${v}px`)
      }
    }
    const up = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      const v = onMove(ev)
      if (v != null) onDone(v)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  })
}

/* ── 布局应用 ───────────────────────────────────────────────────────── */

function applyLayout(): void {
  const root = document.documentElement
  const l = state.layout
  root.style.setProperty('--dshd-w', `${l.sidebarWidth}px`)
  root.style.setProperty('--dshd-h', `${l.termHeight}px`)
  root.dataset.dshdSidebar = l.sidebar ? '1' : '0'
  root.dataset.dshdTerm = l.term ? '1' : '0'
  const term = $('#dshd-term')
  if (term) term.dataset.open = l.term ? '1' : '0'
  // rail 展开/折叠由 CSS transform 驱动（保留滑动动画），不设 hidden
  // rail 上终端按钮的激活态（终端打开时高亮）
  $('#dshd-tab-term')?.toggleAttribute('data-active', l.term)
  if (l.term && !state.termBooted) bootTerm()
}

/* ── 终端 ───────────────────────────────────────────────────────────── */

function bootTerm(): void {
  if (state.termBooted) return
  state.termBooted = true
  // 终端资产（xterm.css / term.js）由主进程注入（lazy，首次打开时）
  void api.dashAction('bootTerm')
}

function toggleTerm(): void {
  void api.dashAction('toggleTerminal')
}

function toggleSidebar(): void {
  void api.dashAction('toggleSidebar')
}

/* ── 订阅 ───────────────────────────────────────────────────────────── */

function subscribe(): void {
  api.onDashboardState((snap) => {
    const prevBridge = state.snap?.bridge
    state.snap = snap
    if (snap.bridge && !prevBridge) stopDomProbe()
    if (!snap.bridge && prevBridge !== false) startDomProbe()
    renderAll()
  })
  api.onDashboardLog((batch) => {
    if (batch.sync) {
      state.logs = [...batch.lines]
    } else {
      state.logs.push(...batch.lines)
      if (state.logs.length > 300) state.logs = state.logs.slice(-300)
    }
    renderLogs()
  })
  api.onDashboardLayout((l) => {
    state.layout = l
    applyLayout()
  })
}

/* ── 事件绑定 ───────────────────────────────────────────────────────── */

function wireEvents(): void {
  $('#dshd-collapse')?.addEventListener('click', toggleSidebar)
  $('#dshd-tab-dash')?.addEventListener('click', toggleSidebar)
  $('#dshd-tab-term')?.addEventListener('click', toggleTerm)
  $('#dshd-log-pause')?.addEventListener('click', () => {
    state.logAuto = !state.logAuto
    const btn = $('#dshd-log-pause')
    if (btn) btn.textContent = state.logAuto ? '⏸' : '▶'
    if (state.logAuto) renderLogs()
  })
  $('#dshd-log-clear')?.addEventListener('click', () => {
    state.logs = []
    renderLogs()
  })
  // 余额刷新
  $('#dshd-balance-refresh')?.addEventListener('click', () => void api.dashAction('refreshBalance'))
  // 上下文环点击 → 转发到 harness 的上下文按钮（打开详情）
  $('#dshd-ctx')?.addEventListener('click', () => {
    if (lastCtxBtn) {
      lastCtxBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    }
  })
  // 终端按钮（tab/＋/✕/系统终端）由 term.ts 接管（lazy 加载后绑定，避免双重 spawn）
  // 侧栏宽度拖拽（左缘 handle）
  const resizer = $('#dshd-resize')
  if (resizer) {
    dragResize(
      resizer,
      'sidebar',
      (e) => {
        const w = window.innerWidth - e.clientX
        return Math.min(420, Math.max(240, w))
      },
      (w) => void api.dashAction('setSidebarWidth', w),
    )
  }
  // 终端高度拖拽（上缘 handle）
  const tResizer = $('#dshd-term-resize')
  if (tResizer) {
    dragResize(
      tResizer,
      'term',
      (e) => {
        const h = window.innerHeight - e.clientY
        return Math.min(480, Math.max(120, h))
      },
      (h) => void api.dashAction('setTerminalHeight', h),
    )
  }
  // 面板内点击不冒泡到 harness（避免误触底部工具条等）
  document.querySelectorAll('#dshd-root, #dshd-tab, #dshd-term').forEach((el) => {
    el.addEventListener('click', (e) => e.stopPropagation())
    el.addEventListener('keydown', (e) => e.stopPropagation())
  })
}

/* ── 引导 ───────────────────────────────────────────────────────────── */

function waitForApp(msLeft: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tick = (): void => {
      const root = document.getElementById('root')
      const ok =
        !!root &&
        root.childElementCount > 0 &&
        getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim() !== ''
      if (ok || msLeft <= 0) resolve(ok)
      else setTimeout(tick, 250)
    }
    tick()
  })
}

async function boot(): Promise<void> {
  if (document.getElementById('dshd-root')) return
  const ready = await waitForApp(30_000)
  if (!ready) return // harness UI 未就绪（长时间 boot/失败页）——不注入，避免干扰

  const host = document.createElement('div')
  host.id = 'dshd-shell'
  host.innerHTML = SHELL_HTML
  // 必须挂到 body 下：--dsw-alias-* 令牌定义在 body，挂 html 下不继承
  document.body.appendChild(host)

  subscribe()
  wireEvents()
  applyLayout()
  await api.dashAction('hello')

  // 常驻 DOM 轮询（上下文/指标/左栏宽），立即执行一次再进入 2s 周期
  pollContext()
  pollStats()
  pollLeftWidth()
  startDomPoll()

  // CDP 验证钩子
  Object.defineProperty(window, '__dshd', {
    value: {
      version: '0.3.0',
      toggleSidebar,
      toggleTerm,
      getState: () => state.snap,
      getLayout: () => ({ ...state.layout }),
    },
    configurable: true,
  })
}

void boot()
