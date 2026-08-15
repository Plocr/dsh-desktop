/**
 * IPC：壳页面（loading/error）白名单。
 * harness Web UI 不调用这些 API（仪表盘/终端/主题均为 harness 插件，
 * 数据走插件自身 webServer 路由，不再经过壳 IPC）。
 */
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import type { HarnessManager } from './harness'
import type { BridgeClient } from './bridge'
import { logDirPath } from './logger'

export interface IpcDeps {
  getWindow: () => BrowserWindow | null
  harness: HarnessManager
  bridge: BridgeClient
  pickWorkspace: () => Promise<string | null>
  restartHarness: () => void
  getInfo: () => unknown
  openSession: (sessionId: string) => Promise<void>
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

  ipcMain.handle('dsh:open-session', (_e, sessionId: unknown) => {
    if (typeof sessionId === 'string' && sessionId) void deps.openSession(sessionId)
    return { ok: true }
  })

  // 保留：无窗口时也能触发的原生对话框兜底
  void dialog
  void deps.bridge
  void deps.harness
}
