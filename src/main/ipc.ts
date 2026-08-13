/**
 * IPC：壳页面（loading/error 页）与托盘动作的后端。
 * harness Web UI 不调用这些 API（它们仍会被注入，但保持最小只读白名单）。
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
}
