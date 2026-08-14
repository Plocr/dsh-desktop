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
import type { DashApproval, DashJob, DashLayout, DashLogLine, DashSession, DashSnapshot } from '../shared/types'
import { WHALE_PATH } from './whale'

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

/** 中段截断：abc…xyz */
function truncMid(s: string, max = 40): string {
  if (s.length <= max) return s
  const half = Math.floor((max - 1) / 2)
  return `${s.slice(0, half)}…${s.slice(-half)}`
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
    <section class="dshd-sec" id="dshd-sec-runtime">
      <div class="dshd-sec-title">运行时</div>
      <div class="dshd-rows" id="dshd-runtime"></div>
    </section>
    <section class="dshd-sec">
      <div class="dshd-sec-title"><span>任务</span><span id="dshd-jobs-badge" class="dshd-badge" hidden></span></div>
      <div class="dshd-list" id="dshd-jobs"></div>
    </section>
    <section class="dshd-sec">
      <div class="dshd-sec-title"><span>会话</span><span id="dshd-sessions-meta" class="dshd-sec-meta"></span></div>
      <div class="dshd-list" id="dshd-sessions"></div>
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
    <button class="dshd-term-tab" data-shell="powershell" type="button">PowerShell</button>
    <button class="dshd-term-tab" data-shell="cmd" type="button">cmd</button>
    <button class="dshd-term-tab" data-shell="pwsh" type="button">pwsh</button>
    <span class="dshd-term-spacer"></span>
    <button id="dshd-term-new" type="button" title="新终端（当前工作区）">＋</button>
    <button id="dshd-term-close" type="button" title="关闭（Ctrl+Shift+\`）">✕</button>
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

function renderRuntime(): void {
  const s = state.snap
  const host = $('#dshd-runtime')
  if (!host) return
  if (!s) {
    host.innerHTML = `<div class="dshd-empty">等待数据…</div>`
    return
  }
  const r = s.runtime
  const rows: [string, string][] = [
    ['Harness', HARNESS_STATE_TEXT[s.harness.state] ?? s.harness.state],
    ['桥接', s.bridge ? '在线' : '离线（DOM 快照）'],
  ]
  if (r) {
    rows.push(['PID', String(r.pid ?? '—')])
    if (r.node) rows.push(['Node', String(r.node)])
    if (r.uptimeMs != null) rows.push(['已运行', fmtDuration(r.uptimeMs)])
    if (typeof r.dshHome === 'string') rows.push(['DSH_HOME', truncMid(r.dshHome, 34)])
    if (typeof r.cwd === 'string') rows.push(['工作区', truncMid(r.cwd, 34)])
  }
  host.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="dshd-row"><span class="dshd-row-k">${esc(k)}</span><span class="dshd-row-v" title="${esc(v)}">${esc(v)}</span></div>`,
    )
    .join('')
  const workspaces = r?.workspaces
  if (Array.isArray(workspaces) && workspaces.length > 0) {
    host.insertAdjacentHTML(
      'beforeend',
      `<div class="dshd-row dshd-row-ws"><span class="dshd-row-k">已注册</span><span class="dshd-ws-chips">${workspaces
        .slice(0, 4)
        .map((w) => `<span class="dshd-ws-chip">${esc(w.title ?? w.id ?? '?')}</span>`)
        .join('')}</span></div>`,
    )
  }
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

function renderSessions(): void {
  const s = state.snap
  const host = $('#dshd-sessions')
  const meta = $('#dshd-sessions-meta')
  if (!host) return
  const rows: DashSession[] = s?.sessions.rows ?? []
  if (meta) meta.textContent = s ? `实时 ${s.sessions.live} · 持久 ${s.sessions.persisted}` : ''
  if (rows.length === 0) {
    host.innerHTML = `<div class="dshd-empty">无会话</div>`
    return
  }
  host.innerHTML = rows
    .slice(0, 12)
    .map((row) => {
      const title = typeof row.title === 'string' && row.title ? row.title : String(row.id ?? '?')
      return `<div class="dshd-sess" data-id="${esc(row.id ?? '')}">
        <span class="dshd-sess-title" title="${esc(title)}">${esc(title)}</span>
        <span class="dshd-pill ${row.live ? 'dshd-st-running' : 'dshd-st-muted'}">${row.live ? '实时' : '持久'}</span>
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
  renderRuntime()
  renderJobs()
  renderSessions()
  renderApprovals()
  renderFoot()
  renderTabBadge()
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
  $('#dshd-sessions')?.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.dshd-sess') as HTMLElement | null
    const id = row?.dataset.id
    if (id) void api.dashAction('openSession', id)
  })
  $('#dshd-runtime')?.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('.dshd-ws-chip') as HTMLElement | null
    if (chip) void api.dashAction('pickWorkspace')
  })
  // 终端按钮（tab/＋/✕）由 term.ts 接管（lazy 加载后绑定，避免双重 spawn）
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
