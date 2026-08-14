/**
 * DSH Desktop 底栏终端视图（xterm.js，lazy 加载）。
 * 数据经 preload IPC 与主进程 TerminalManager 互通（pipe/pty 双后端）。
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
    void api.termResize(cols, rows)
  }
}

function boot(): void {
  if (document.getElementById('dshd-term-xterm')?.dataset.dshdBooted) return
  const host = document.getElementById('dshd-term-xterm')
  if (!host) return
  host.dataset.dshdBooted = '1'

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
  fit(term, host)

  term.onData((data) => void api.termWrite(data))
  api.onTermData((data) => term.write(data))
  api.onTermExit((info) => {
    const overlay = document.getElementById('dshd-term-overlay')
    if (overlay) {
      overlay.hidden = false
      overlay.textContent = `进程已退出（code ${String(info.code)}）— 点按上方「＋」重新打开`
    }
  })
  const overlay = document.getElementById('dshd-term-overlay')
  if (overlay) overlay.hidden = true

  // 窗口缩放自适应（与 harness 面板共用 CSS 变量变化节流）
  let t: number | null = null
  window.addEventListener('resize', () => {
    if (t !== null) clearTimeout(t)
    t = window.setTimeout(() => {
      t = null
      if (host.isConnected) fit(term, host)
    }, 150)
  })

  // 主题实时换肤：body[data-ds-dark-theme] 属性变化 + prefers-color-scheme
  const observer = new MutationObserver(() => {
    term.options.theme = readTheme()
  })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', () => {
    term.options.theme = readTheme()
  })

  // 供 CDP 验证
  Object.defineProperty(window, '__dshdTerm', {
    value: { booted: true, cols: () => term.cols, rows: () => term.rows, write: (d: string) => term.write(d) },
    configurable: true,
  })
}

void boot()
