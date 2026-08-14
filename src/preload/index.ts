/**
 * Preload：通过 contextBridge 暴露最小白名单。
 * 供壳页面（loading/error）与注入面板（harness 页）使用；harness UI 本体不调用。
 * 面板通道（dashboard/terminal）在主进程侧按 mainFrame + 白名单动作校验。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { DashLayout, DashLogBatch, DashSnapshot, PanelApi } from '../shared/types'

const api = {
  /* ── 壳页面（loading/error）与既有能力 ── */
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('dsh:pick-workspace'),
  revealInFolder: (p: string): Promise<boolean> => ipcRenderer.invoke('dsh:reveal-in-folder', p),
  openExternal: (u: string): Promise<boolean> => ipcRenderer.invoke('dsh:open-external', u),
  restartHarness: (): Promise<boolean> => ipcRenderer.invoke('dsh:restart-harness'),
  openLogs: (): Promise<boolean> => ipcRenderer.invoke('dsh:open-logs'),
  getInfo: (): Promise<unknown> => ipcRenderer.invoke('dsh:get-info'),
  openDevConsole: (): Promise<boolean> => ipcRenderer.invoke('dsh:open-dev-console'),

  /* ── 仪表盘数据（注入面板） ── */
  onDashboardState: (cb: (s: DashSnapshot) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, snap: DashSnapshot): void => cb(snap)
    ipcRenderer.on('dsh:dash:state', listener)
    return () => ipcRenderer.removeListener('dsh:dash:state', listener)
  },
  onDashboardLog: (cb: (batch: DashLogBatch) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, batch: DashLogBatch): void => cb(batch)
    ipcRenderer.on('dsh:dash:log', listener)
    return () => ipcRenderer.removeListener('dsh:dash:log', listener)
  },
  onDashboardLayout: (cb: (l: DashLayout) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, l: DashLayout): void => cb(l)
    ipcRenderer.on('dsh:dash:layout', listener)
    return () => ipcRenderer.removeListener('dsh:dash:layout', listener)
  },
  dashAction: (action: string, payload?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('dsh:dash:action', action, payload),

  /* ── 终端（注入面板，多会话） ── */
  termOpen: (shell?: string): Promise<{ ok: boolean; id?: string; backend?: string | null }> =>
    ipcRenderer.invoke('dsh:term:open', shell),
  termActivate: (id: string): Promise<unknown> => ipcRenderer.invoke('dsh:term:activate', id),
  termWrite: (id: string, data: string): Promise<unknown> => ipcRenderer.invoke('dsh:term:write', id, data),
  termResize: (id: string, cols: number, rows: number): Promise<unknown> =>
    ipcRenderer.invoke('dsh:term:resize', id, cols, rows),
  termClose: (id: string): Promise<unknown> => ipcRenderer.invoke('dsh:term:close', id),
  onTermData: (cb: (msg: { id: string; data: string }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: { id: string; data: string }): void => cb(msg)
    ipcRenderer.on('dsh:term:data', listener)
    return () => ipcRenderer.removeListener('dsh:term:data', listener)
  },
  onTermExit: (cb: (msg: { id: string; code: number | null }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: { id: string; code: number | null }): void => cb(msg)
    ipcRenderer.on('dsh:term:exit', listener)
    return () => ipcRenderer.removeListener('dsh:term:exit', listener)
  },
  onTermCreated: (cb: (msg: { id: string; label: string; backend: string | null }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: { id: string; label: string; backend: string | null }): void => cb(msg)
    ipcRenderer.on('dsh:term:created', listener)
    return () => ipcRenderer.removeListener('dsh:term:created', listener)
  },
  onTermClosed: (cb: (id: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on('dsh:term:closed', listener)
    return () => ipcRenderer.removeListener('dsh:term:closed', listener)
  },
  onTermActive: (cb: (id: string | null) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string | null): void => cb(id)
    ipcRenderer.on('dsh:term:active', listener)
    return () => ipcRenderer.removeListener('dsh:term:active', listener)
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)

export type DshDesktopApi = typeof api

// 面板侧类型视图：确保结构兼容（面板只消费 PanelApi 子集）
const _panelCheck: PanelApi = api
void _panelCheck
