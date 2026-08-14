/**
 * DSH Desktop 底栏终端视图（xterm.js，lazy 加载，多会话 tabs）。
 * reasonix/Codex 风格：后端持有 tab 级进程所有权，前端按 id 分发数据；
 * 每会话独立 xterm 实例（保留各自滚动缓冲），tab 切换显示/隐藏。
 * 主题色从 harness 令牌实时读取（三态主题切换自动换肤）。
 */
import { Terminal } from '@xterm/xterm'
import type { PanelApi } from '../shared/types'

const api = window.dshDesktop as PanelApi

function alias(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback
}

function readTheme(): Record<string, string> {
  const bg = alias('--dsw-alias-bg-layer-1', '#ffffff')
  const fg = alias('--dsw-alias-label-primary', '#0f1115')
  const accent = alias('--dsw-alias-state-business-primary', '#4176e6')
  const sel = alias('--dsw-alias-interactive-bg-hover', 'rgba(38,49,72,.14)')
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: sel,
    black: '#1f1f1f',
    red: alias('--dsw-static-red-500', '#ef4444'),
    green: alias('--dsw-static-green-500', '#22c55e'),
    yellow: alias('--dsw-static-amber-500', '#f59e0b'),
    blue: alias('--dsw-static-deepseek-500', '#4176e6'),
    magenta: '#d946ef',
    cyan: '#06b6d4',
    white: alias('--dsw-static-neutral-bluish-400', '#adb4bd'),
    brightBlack: '#5f6368',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#fbbf24',
    brightBlue: '#60a5fa',
    brightMagenta: '#e879f9',
    brightCyan: '#22d3ee',
    brightWhite: alias('--dsw-alias-label-primary', '#f9fafb'),
  }
}

function cellSize(term: Terminal): { w: number; h: number } {
  const el = term.element
  const probe = document.createElement('span')
  probe.textContent = 'W'
  probe.style.cssText =
    `position:absolute;visibility:hidden;white-space:pre;` +
    `font:${getComputedStyle(el as HTMLElement).font};padding:0;margin:0`
  document.body.appendChild(probe)
  const w = probe.getBoundingClientRect().width
  const h = parseFloat(getComputedStyle(el as HTMLElement).lineHeight) || 16
  probe.remove()
  return { w: w || 9, h: h || 16 }
}

function fit(term: Terminal, host: HTMLElement): void {
  const { w, h } = cellSize(term)
  const cols = Math.max(10, Math.floor(host.clientWidth / w) - 1)
  const rows = Math.max(3, Math.floor(host.clientHeight / h) - 1)
  if (cols !== term.cols || rows !== term.rows) {
    term.resize(cols, rows)
    const view = term.element?.closest<HTMLElement>('.dshd-term-view')
    const id = view?.dataset.id
    if (id) void api.termResize(id, cols, rows)
  }
}

interface TermView {
  id: string
  label: string
  term: Terminal
  host: HTMLElement
  dead: boolean
}

const views = new Map<string, TermView>()
let activeId: string | null = null
let booted = false

function container(): HTMLElement | null {
  return document.getElementById('dshd-term-xterm')
}

function overlay(): HTMLElement | null {
  return document.getElementById('dshd-term-overlay')
}

function showOverlay(text: string): void {
  const o = overlay()
  if (o) {
    o.hidden = false
    o.textContent = text
  }
}

function hideOverlay(): void {
  const o = overlay()
  if (o) o.hidden = true
}

function renderTabs(): void {
  const bar = document.getElementById('dshd-term-tabs')
  if (!bar) return
  bar.innerHTML = [...views.values()]
    .map(
      (v) =>
        `<button type="button" class="dshd-term-tab${v.id === activeId ? ' dshd-term-tab-active' : ''}" data-id="${v.id}" title="${v.label}${v.dead ? '（已退出）' : ''}">${v.label}${v.dead ? ' ⚠' : ''}<span class="dshd-term-tab-x" data-id="${v.id}" title="关闭会话">✕</span></button>`,
    )
    .join('')
  // 绑定：tab 点击切换；✕ 关闭（stopPropagation 防止触发切换）
  bar.querySelectorAll('.dshd-term-tab').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.classList.contains('dshd-term-tab-x')) {
        e.stopPropagation()
        const id = target.dataset.id
        if (id) void api.termClose(id)
        return
      }
      const id = (btn as HTMLElement).dataset.id
      if (id && id !== activeId) void api.termActivate(id)
    })
  })
}

function applyActive(): void {
  for (const v of views.values()) {
    v.host.style.display = v.id === activeId ? '' : 'none'
  }
  const active = activeId ? views.get(activeId) : undefined
  if (active) {
    hideOverlay()
    if (active.dead) showOverlay(`会话已退出 — 点按「＋」新建`)
    const c = container()
    if (c) {
      requestAnimationFrame(() => fit(active.term, c))
    }
  } else {
    showOverlay('无会话 — 点按「＋」新建')
  }
  renderTabs()
}

function createView(id: string, label: string): void {
  const c = container()
  if (!c || views.has(id)) return
  const host = document.createElement('div')
  host.className = 'dshd-term-view'
  host.dataset.id = id
  c.appendChild(host)
  const term = new Terminal({
    fontSize: 12,
    fontFamily: alias('--ds-font-family-code', "Consolas, 'Courier New', monospace"),
    lineHeight: 1.35,
    cursorBlink: true,
    scrollback: 2000,
    convertEol: false,
    theme: readTheme(),
  })
  term.open(host)
  views.set(id, { id, label, term, host, dead: false })
  term.onData((data) => void api.termWrite(id, data))
  const c2 = container()
  if (c2) requestAnimationFrame(() => fit(term, c2))
}

function removeView(id: string): void {
  const v = views.get(id)
  if (!v) return
  try {
    v.term.dispose()
  } catch {
    /* ignore */
  }
  v.host.remove()
  views.delete(id)
  if (activeId === id) activeId = null
  renderTabs()
}

function openSession(shell?: string): void {
  void api.termOpen(shell)
}

function boot(): void {
  if (booted) return
  const c = container()
  if (!c) return
  booted = true
  // 与主进程 injectTerminalAssets 的守卫对齐（防重复注入）
  c.dataset.dshdBooted = '1'

  api.onTermCreated(({ id, label }) => {
    createView(id, label)
    activeId = id
    applyActive()
  })
  api.onTermData(({ id, data }) => {
    const v = views.get(id)
    if (v) v.term.write(data)
  })
  api.onTermExit(({ id, code }) => {
    const v = views.get(id)
    if (v) {
      v.dead = true
      if (activeId === id) showOverlay(`会话已退出（${code === null ? '已关闭' : `code ${String(code)}`}）— 点按「＋」新建`)
      renderTabs()
    }
  })
  api.onTermClosed((id) => removeView(id))
  api.onTermActive((id) => {
    activeId = id
    applyActive()
  })

  // ✕ = 收起面板（会话保留，reasonix 抽屉语义）；⧉ = 系统终端；＋ = 新建会话
  document.getElementById('dshd-term-close')?.addEventListener('click', () => {
    void api.dashAction('toggleTerminal')
  })
  document.getElementById('dshd-term-ext')?.addEventListener('click', () => {
    void api.dashAction('openSystemTerminal')
  })
  document.getElementById('dshd-term-new')?.addEventListener('click', () => openSession())
  document.querySelectorAll('.dshd-term-newshell').forEach((btn) => {
    btn.addEventListener('click', () => openSession((btn as HTMLElement).dataset.shell))
  })

  // 窗口缩放自适应
  let t: number | null = null
  window.addEventListener('resize', () => {
    if (t !== null) clearTimeout(t)
    t = window.setTimeout(() => {
      t = null
      const active = activeId ? views.get(activeId) : undefined
      const c2 = container()
      if (active && c2 && c2.isConnected) fit(active.term, c2)
    }, 150)
  })

  // 主题实时换肤
  const observer = new MutationObserver(() => {
    for (const v of views.values()) v.term.options.theme = readTheme()
  })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    for (const v of views.values()) v.term.options.theme = readTheme()
  })

  // 供 CDP 验证
  Object.defineProperty(window, '__dshdTerm', {
    value: {
      booted: true,
      activeId: () => activeId,
      sessions: () => [...views.keys()],
      write: (data: string) => {
        if (activeId) void api.termWrite(activeId, data)
      },
    },
    configurable: true,
  })

  // 面板展开即启动首个会话（auto → PowerShell/cmd）
  openSession()
}

void boot()
