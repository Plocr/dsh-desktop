/**
 * 托盘：显示窗口 / 打开浏览器版 / 重启 Harness / 桌面插件 /
 * 设置（自动检测更新·检查更新·全局快捷键·日志·自启·通知·工作区·卸载）/ 退出。
 * 状态变化时重建菜单。
 * （0.4.0：仪表盘/终端开关已随面板移入 harness 插件，托盘不再控制。）
 */
import { Menu, nativeImage, Tray } from 'electron'
import type { AppSettings } from './settings'

export interface DesktopPluginToggle {
  name: string
  enabled: boolean
  locked: boolean
}

export interface TrayDeps {
  getUrl: () => string | null
  getState: () => {
    autoStart: boolean
    notifications: boolean
    autoUpdate: boolean
    runningJobs: number
    harnessState: string
    globalShortcut: string
    appVersion: string
    harnessVersion: string | null
    lanShare: boolean
    lanUrl: string | null
  }
  getPlugins: () => DesktopPluginToggle[]
  showWindow: () => void
  openBrowser: () => void
  pickWorkspace: () => void
  restartHarness: () => void
  openLogs: () => void
  checkUpdate: () => void
  cleanLogs: () => void
  uninstall: () => void
  togglePlugin: (name: string, enabled: boolean) => void
  setAutoStart: (v: boolean) => void
  setNotifications: (v: boolean) => void
  setAutoUpdate: (v: boolean) => void
  setLanShare: (v: boolean) => void
  copyLanUrl: () => void
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
      { label: '重启 Harness', click: () => deps.restartHarness() },
      {
        label: '桌面插件',
        submenu: deps.getPlugins().map((p) => ({
          label: p.locked ? `${p.name}（必需）` : p.name,
          type: 'checkbox' as const,
          checked: p.enabled,
          enabled: !p.locked,
          click: (item) => deps.togglePlugin(p.name, item.checked),
        })),
      },
      { type: 'separator' },
      {
        label: '设置',
        submenu: [
          {
            // 总开关：开 = 冷启动自动检查（框架下载 + 官方 Harness 本地替换）；关 = 仅手动
            // 常显两个当前版本：框架（DSH Desktop） + 官方 Harness（DeepSeek Harness 本体）
            label: `自动更新（框架 v${s.appVersion} · 官方 Harness v${s.harnessVersion ?? '—'}）`,
            type: 'checkbox' as const,
            checked: s.autoUpdate,
            click: (item) => deps.setAutoUpdate(item.checked),
          },
          {
            // 手动：检查外壳 + 框架，有新版自动下载/替换（本地，不跳浏览器）
            label: '检查并更新…',
            click: () => deps.checkUpdate(),
          },
          { type: 'separator' },
          // 局域网访问：壳内反向代理（固定端口），同网段设备经电脑授权后访问
          {
            label: '局域网访问（手机可访问，需本机授权）',
            type: 'checkbox' as const,
            checked: s.lanShare,
            click: (item) => deps.setLanShare(item.checked),
          },
          {
            label: s.lanShare
              ? `局域网地址：${s.lanUrl ?? '获取中…'}`
              : '局域网地址：未开启',
            enabled: !!s.lanUrl,
            click: () => deps.copyLanUrl(),
          },
          { type: 'separator' },
          {
            label: s.globalShortcut ? `全局快捷键：${s.globalShortcut}` : '全局快捷键：未启用',
            enabled: false,
          },
          { label: '切换工作区…', click: () => deps.pickWorkspace() },
          { type: 'separator' },
          { label: '查看日志', click: () => deps.openLogs() },
          { label: '清理日志', click: () => deps.cleanLogs() },
          { type: 'separator' },
          {
            label: '开机自启',
            type: 'checkbox' as const,
            checked: s.autoStart,
            click: (item) => deps.setAutoStart(item.checked),
          },
          {
            label: '系统通知',
            type: 'checkbox' as const,
            checked: s.notifications,
            click: (item) => deps.setNotifications(item.checked),
          },
          { type: 'separator' },
          {
            label: '卸载 DSH Desktop…',
            visible: process.platform === 'win32',
            click: () => deps.uninstall(),
          },
        ],
      },
      { type: 'separator' },
      { label: '退出', click: () => deps.quit() },
    ])
    tray.setContextMenu(menu)
  }

  refresh()
  return { tray, refresh }
}
