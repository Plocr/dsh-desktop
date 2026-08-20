/**
 * Preload：通过 contextBridge 暴露最小白名单。
 * 仅供壳页面（loading/error）使用；harness Web UI 不调用
 * （仪表盘/终端/主题均为 harness 插件，走插件自身 webServer 路由）。
 */
import { contextBridge, ipcRenderer } from 'electron'

const api = {
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

contextBridge.exposeInMainWorld('dshDesktop', api)

export type DshDesktopApi = typeof api
