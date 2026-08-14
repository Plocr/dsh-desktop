/**
 * 托盘：显示窗口 / 打开浏览器版 / 切换工作区 / 重启 Harness / 查看日志 /
 * 检查更新 / 开机自启 / 通知开关 / 全局快捷键信息 / 退出。状态变化时重建菜单。
 */
import { Menu, nativeImage, Tray } from 'electron'
import type { AppSettings } from './settings'

export interface TrayDeps {
  getUrl: () => string | null
  getState: () => {
    autoStart: boolean
    notifications: boolean
    runningJobs: number
    harnessState: string
    globalShortcut: string
    panel: { sidebar: boolean; term: boolean }
  }
  showWindow: () => void
  openBrowser: () => void
  pickWorkspace: () => void
  restartHarness: () => void
  openLogs: () => void
  checkUpdate: () => void
  setAutoStart: (v: boolean) => void
  setNotifications: (v: boolean) => void
  setPanel: (kind: 'sidebar' | 'terminal', v: boolean) => void
  quit: () => void
}

export interface TrayHandle {
  tray: Tray
  refresh: () => void
}

export function createTray(iconPath: string, deps: TrayDeps): TrayHandle {
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createEmpty()
  const tray = new Tray(image)
  tray.setToolTip('DSH Desktop')

  const refresh = (): void => {
    const s = deps.getState()
    const url = deps.getUrl()
    const menu = Menu.buildFromTemplate([
      { label: '显示工作台', click: () => deps.showWindow() },
      { label: '打开浏览器版', enabled: !!url, click: () => deps.openBrowser() },
      { type: 'separator' },
      {
        label: `Harness: ${s.harnessState}${s.runningJobs > 0 ? `（${s.runningJobs} 个任务运行中）` : ''}`,
        enabled: false,
      },
      { label: '切换工作区…', click: () => deps.pickWorkspace() },
      { label: '重启 Harness', click: () => deps.restartHarness() },
      { label: '查看日志', click: () => deps.openLogs() },
      { label: '检查更新…', click: () => deps.checkUpdate() },
      {
        label: s.globalShortcut ? `全局快捷键：${s.globalShortcut}` : '全局快捷键：未启用',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: s.autoStart,
        click: (item) => deps.setAutoStart(item.checked),
      },
      {
        label: '系统通知',
        type: 'checkbox',
        checked: s.notifications,
        click: (item) => deps.setNotifications(item.checked),
      },
      { type: 'separator' },
      {
        label: '显示仪表盘',
        type: 'checkbox',
        checked: s.panel.sidebar,
        click: (item) => deps.setPanel('sidebar', item.checked),
      },
      {
        label: '显示终端',
        type: 'checkbox',
        checked: s.panel.term,
        click: (item) => deps.setPanel('terminal', item.checked),
      },
      { type: 'separator' },
      { label: '退出', click: () => deps.quit() },
    ])
    tray.setContextMenu(menu)
  }

  refresh()
  return { tray, refresh }
}
