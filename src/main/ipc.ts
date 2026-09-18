/**
 * IPC：按来源分级的白名单（对齐官方壳的 assertDesktopSender）——
 * 壳页面能力只给 dsh-app://shell，工作台（dsh-app://app）只留更新安装这一个动作。
 *
 * 安全：每个 handler 校验 senderFrame.url 的来源（preload 里那道门是给渲染层看的，
 * 这里才是边界）；工作台里跑的第三方插件 client 代码拿不到文件系统/对话框等能力。
 */
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { BridgeClient } from './bridge'
import { logDirPath } from './logger'

const SHELL_ORIGIN = 'dsh-app://shell'
const APP_ORIGIN = 'dsh-app://app'

export interface IpcDeps {
  getWindow: () => BrowserWindow | null
  bridge: BridgeClient
  pickWorkspace: () => Promise<string | null>
  restartHarness: () => void
  getInfo: () => unknown
  openSession: (sessionId: string) => Promise<void>
  /** 更新下载完成后，由页面右上角「安装更新」按钮触发：确认后退出并安装。 */
  requestUpdateInstall: () => Promise<boolean>
  /** 工作台 boot：返回 Host 的 index 注入片段与流基地址（官方 `dshDesktopBoot.ready`）。 */
  boot: () => { injections: readonly unknown[]; streamBaseUrl: string }
  /** 工作台自报启动失败（官方 `dshDesktopBoot.failed`）：走原生恢复。 */
  bootFailed: (message: string) => void
}

/** 仅放行壳页面（dsh-app://shell 的 loading/error 页）；其他来源拒绝。 */
function fromShellPage(e: IpcMainInvokeEvent): boolean {
  return (e.senderFrame?.url ?? '').startsWith(SHELL_ORIGIN)
}

/** 仅放行工作台主框架（dsh-app://app 的顶层文档）；第三方插件 iframe 等一律拒绝。 */
function fromAppPage(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  return url.startsWith(APP_ORIGIN) && e.senderFrame === e.sender.mainFrame
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

  // 更新「安装更新」：由页面右上角卡片按钮触发（壳页面与工作台都可能点）。
  // 主进程侧 requestUpdateInstall 会再做「就绪检查 + 原生确认」，双保险。
  ipcMain.on('dsh:update-install', (e) => {
    const url = e.senderFrame?.url ?? ''
    if (!url.startsWith(SHELL_ORIGIN) && !url.startsWith(APP_ORIGIN)) return
    void deps.requestUpdateInstall()
  })

  // 工作台 boot（官方契约）：只有 dsh-app://app 的主框架能拿到注入片段。
  ipcMain.handle('dsh:boot', (e) => {
    if (!fromAppPage(e)) throw new Error('forbidden: application page only')
    return deps.boot()
  })

  ipcMain.handle('dsh:boot-failed', (e, message: unknown) => {
    if (!fromAppPage(e)) throw new Error('forbidden: application page only')
    deps.bootFailed(typeof message === 'string' ? message : 'unknown boot failure')
    return true
  })

  // 保留：无窗口时也能触发的原生对话框兜底
  void dialog
  void deps.bridge
}
