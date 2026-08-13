/**
 * Preload：通过 contextBridge 暴露最小只读白名单。
 * 仅供壳页面（loading/error）与未来原生集成使用；harness UI 不使用。
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
}

contextBridge.exposeInMainWorld('dshDesktop', api)

export type DshDesktopApi = typeof api
