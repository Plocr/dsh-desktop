/**
 * IPC：壳页面（loading/error）、注入面板与托盘动作的后端。
 * harness Web UI 不调用这些 API（仍保持最小只读白名单）。
 * 面板/终端通道全部校验 sender 为工作台窗口的主 frame。
 */
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { HarnessManager } from './harness'
import type { BridgeClient } from './bridge'
import type { TermManager, TermShell } from './terminal'
import { logDirPath } from './logger'
import { clampSize } from './dashboard'
import { injectTerminalAssets } from './chrome'

export interface IpcDeps {
  getWindow: () => BrowserWindow | null
  harness: HarnessManager
  bridge: BridgeClient
  terminal: TermManager
  pickWorkspace: () => Promise<string | null>
  restartHarness: () => void
  getInfo: () => unknown
  openSession: (sessionId: string) => Promise<void>
  toggleSidebar: () => void
  toggleTerminal: () => void
  setSidebarWidth: (w: number) => void
  setTerminalHeight: (h: number) => void
  /** hello 时向面板补发日志全量基线（sync 批）。 */
  sendLogBacklog: () => void
}

/** 校验调用来自工作台窗口主 frame（防 harness 页内其他 frame/注入滥用）。 */
function isMainFrame(deps: IpcDeps, e: IpcMainInvokeEvent): boolean {
  const win = deps.getWindow()
  if (!win || win.isDestroyed()) return false
  return e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('dsh:pick-workspace', async () => {
    return deps.pickWorkspace()
  })

  ipcMain.handle('dsh:reveal-in-folder', async (_e, p: unknown) => {
    if (typeof p === 'string' && p) {
      shell.showItemInFolder(p)
      return true
    }
    return false
  })

  ipcMain.handle('dsh:open-external', async (_e, u: unknown) => {
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
      await shell.openExternal(u)
      return true
    }
    return false
  })

  ipcMain.handle('dsh:restart-harness', () => {
    deps.restartHarness()
    return true
  })

  ipcMain.handle('dsh:open-logs', () => {
    void shell.openPath(logDirPath())
    return true
  })

  ipcMain.handle('dsh:get-info', () => deps.getInfo())

  ipcMain.handle('dsh:open-dev-console', () => {
    const win = deps.getWindow()
    if (win) win.webContents.openDevTools({ mode: 'detach' })
    return true
  })

  /* ── 仪表盘动作（注入面板） ── */

  ipcMain.handle('dsh:dash:action', (e, action: unknown, payload: unknown) => {
    if (!isMainFrame(deps, e)) return { ok: false, error: 'forbidden' }
    if (typeof action !== 'string') return { ok: false, error: 'bad action' }
    switch (action) {
      case 'hello':
        // 面板就绪：补发日志基线（快照/布局由主进程在 dom-ready 时推送）
        deps.sendLogBacklog()
        return { ok: true }
      case 'toggleSidebar':
        deps.toggleSidebar()
        return { ok: true }
      case 'toggleTerminal':
        deps.toggleTerminal()
        return { ok: true }
      case 'setSidebarWidth':
        deps.setSidebarWidth(clampSize(Number(payload) || 300, 240, 420))
        return { ok: true }
      case 'setTerminalHeight':
        deps.setTerminalHeight(clampSize(Number(payload) || 200, 120, 480))
        return { ok: true }
      case 'openSession':
        if (typeof payload === 'string' && payload) void deps.openSession(payload)
        return { ok: true }
      case 'pickWorkspace':
        void deps.pickWorkspace()
        return { ok: true }
      case 'restartHarness':
        deps.restartHarness()
        return { ok: true }
      case 'openLogs':
        void shell.openPath(logDirPath())
        return { ok: true }
      case 'clearLogs':
        return { ok: true }
      case 'forceSnapshot':
        return { ok: true }
      case 'bootTerm': {
        // 终端 lazy 资产（xterm.css + term.js）由主进程注入，避免自定义协议
        const w = deps.getWindow()
        if (w) injectTerminalAssets(w)
        return { ok: true }
      }
      default:
        return { ok: false, error: `unknown action: ${action}` }
    }
  })

  /* ── 终端（注入面板） ── */

  ipcMain.handle('dsh:term:open', (e, shell: unknown) => {
    if (!isMainFrame(deps, e)) return { ok: false, error: 'forbidden' }
    const ok = deps.terminal.spawn(typeof shell === 'string' && shell ? (shell as TermShell) : 'auto')
    return { ok, backend: deps.terminal.backend }
  })

  ipcMain.handle('dsh:term:write', (e, data: unknown) => {
    if (!isMainFrame(deps, e)) return { ok: false, error: 'forbidden' }
    if (typeof data === 'string') deps.terminal.write(data)
    return { ok: true }
  })

  ipcMain.handle('dsh:term:resize', (e, cols: unknown, rows: unknown) => {
    if (!isMainFrame(deps, e)) return { ok: false, error: 'forbidden' }
    deps.terminal.resize(Number(cols) || 80, Number(rows) || 24)
    return { ok: true }
  })

  ipcMain.handle('dsh:term:close', (e) => {
    if (!isMainFrame(deps, e)) return { ok: false, error: 'forbidden' }
    deps.terminal.close()
    return { ok: true }
  })
}
