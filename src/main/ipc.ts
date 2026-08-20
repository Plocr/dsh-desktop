/**
 * IPC：壳页面（loading/error）白名单。
 * harness Web UI 不调用这些 API（仪表盘/终端/主题均为 harness 插件，
 * 数据走插件自身 webServer 路由，不再经过壳 IPC）。
 *
 * 安全：每个 handler 校验 senderFrame.url 为 file:// 壳页面——
 * harness Web UI（http://127.0.0.1:*）内的插件 client 代码拿不到这些能力。
 */
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
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
  /** 更新下载完成后，由页面右上角「安装更新」按钮触发：确认后退出并安装。 */
  requestUpdateInstall: () => Promise<boolean>
}

/** 仅放行壳页面（file:// 加载的 loading/error 页）；其他来源拒绝。 */
function fromShellPage(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  return url.startsWith('file://')
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('dsh:pick-workspace', async (e) => {
    if (!fromShellPage(e)) throw new Error('forbidden: shell page only')
    return deps.pickWorkspace()
  })

  ipcMain.handle('dsh:reveal-in-folder', async (e, p: unknown) => {
    if (!fromShellPage(e)) throw new Error('forbidden: shell page only')
    if (typeof p === 'string' && p) {
      shell.showItemInFolder(p)
      return true
    }
    return false
  })

  ipcMain.handle('dsh:open-external', async (e, u: unknown) => {
    if (!fromShellPage(e)) throw new Error('forbidden: shell page only')
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
      await shell.openExternal(u)
      return true
    }
    return false
  })

  ipcMain.handle('dsh:restart-harness', (e) => {
    if (!fromShellPage(e)) throw new Error('forbidden: shell page only')
    deps.restartHarness()
    return true
  })

  ipcMain.handle('dsh:open-logs', (e) => {
    if (!fromShellPage(e)) throw new Error('forbidden: shell page only')
    void shell.openPath(logDirPath())
    return true
  })

  ipcMain.handle('dsh:get-info', (e) => {
    if (!fromShellPage(e)) throw new Error('forbidden: shell page only')
    return deps.getInfo()
  })

  ipcMain.handle('dsh:open-dev-console', (e) => {
    if (!fromShellPage(e)) throw new Error('forbidden: shell page only')
    const win = deps.getWindow()
    if (win) win.webContents.openDevTools({ mode: 'detach' })
    return true
  })

  ipcMain.handle('dsh:open-session', (e, sessionId: unknown) => {
    if (!fromShellPage(e)) throw new Error('forbidden: shell page only')
    if (typeof sessionId === 'string' && sessionId) void deps.openSession(sessionId)
    return { ok: true }
  })

  // 更新「安装更新」：由页面右上角卡片按钮触发（harness 页，不 gate file://）。
  // 主进程侧 requestUpdateInstall 会再做「就绪检查 + 原生确认」，双保险。
  ipcMain.on('dsh:update-install', () => {
    void deps.requestUpdateInstall()
  })

  // 保留：无窗口时也能触发的原生对话框兜底
  void dialog
  void deps.bridge
  void deps.harness
}
