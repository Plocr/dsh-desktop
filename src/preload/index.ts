/**
 * Preload：通过 contextBridge 暴露最小白名单，且**按来源分级**。
 *
 *  - 壳页面（dsh-app://shell/*，loading/error）：完整壳能力（选工作区、打开日志/外部链接…）；
 *  - 工作台（dsh-app://app/*，harness Web UI）：只有 { protocolVersion, installUpdate }。
 *    Web UI 里跑的是 harness 自己的 client（含第三方插件的 client 半边），拿不到文件系统、
 *    对话框、任意 shell 打开等能力；它需要的一切都走 /api（由主进程代理）。
 *    installUpdate 例外：右上角更新卡片的「安装更新并重启」按钮点在这里，而它是壳的动作。
 *  - 其他文档（about:blank 等过渡态）：什么都不暴露。
 *
 * 主进程侧 ipc.ts 会再按 sender frame 的来源校验一次（这里的门是给渲染层看的，
 * 那道门才是真正的边界）。
 */
import { contextBridge, ipcRenderer } from 'electron'

const SHELL_ORIGIN = 'dsh-app://shell'
const APP_ORIGIN = 'dsh-app://app'

const shellApi = {
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('dsh:pick-workspace'),
  revealInFolder: (p: string): Promise<boolean> => ipcRenderer.invoke('dsh:reveal-in-folder', p),
  openExternal: (u: string): Promise<boolean> => ipcRenderer.invoke('dsh:open-external', u),
  restartHarness: (): Promise<boolean> => ipcRenderer.invoke('dsh:restart-harness'),
  openLogs: (): Promise<boolean> => ipcRenderer.invoke('dsh:open-logs'),
  getInfo: (): Promise<unknown> => ipcRenderer.invoke('dsh:get-info'),
  openDevConsole: (): Promise<boolean> => ipcRenderer.invoke('dsh:open-dev-console'),
  openSession: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('dsh:open-session', sessionId),
  /** 更新下载完成后，由右上角卡片按钮触发：让壳重启并安装更新。 */
  installUpdate: (): void => ipcRenderer.send('dsh:update-install'),
}

/** 工作台（harness Web UI）可见的最小面：载体标记 + 更新安装动作。 */
const appApi = {
  protocolVersion: 1,
  installUpdate: (): void => ipcRenderer.send('dsh:update-install'),
}

const origin = `${location.protocol}//${location.hostname}`
const api = origin === SHELL_ORIGIN ? shellApi : origin === APP_ORIGIN ? appApi : null
if (api) contextBridge.exposeInMainWorld('dshDesktop', api)

export type DshDesktopApi = typeof shellApi
