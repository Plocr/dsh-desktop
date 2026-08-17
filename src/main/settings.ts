/**
 * 壳设置：userData/settings.json。仅存壳层偏好；harness 侧设置留在 harness，
 * 插件偏好（仪表盘/终端/主题）由插件自身持久化（profile 目录）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export interface AppSettings {
  /** 关闭窗口时最小化到托盘（false = 直接退出） */
  trayOnClose: boolean
  /** 是否发系统通知（任务完成 / 需要审批） */
  notifications: boolean
  /** 开机自启 */
  autoStart: boolean
  /** 使用独立 DSH_HOME（userData/dsh-home）。默认开启：与 web 版/CLI 共享
   *  ~/.dsh 会因并发读写 sessions/storages 冲突（输入失败、互相干扰）。 */
  isolatedHome: boolean
  /** 最近工作区（新→旧），首个存在的作为默认 cwd */
  recentWorkspaces: string[]
  /** 全局唤出快捷键（Electron accelerator 语法；空串禁用） */
  globalShortcut: string
  /** 启动后自动检查更新 */
  autoUpdate: boolean
  /** 被禁用的桌面插件（package name 列表；bridge 永远启用，不在此列） */
  disabledPlugins: string[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  trayOnClose: true,
  notifications: true,
  autoStart: false,
  isolatedHome: true,
  recentWorkspaces: [],
  globalShortcut: 'CommandOrControl+Shift+Space',
  autoUpdate: true,
  disabledPlugins: [],
}

export function loadSettings(file: string): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS }
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>
      if (typeof raw.trayOnClose === 'boolean') out.trayOnClose = raw.trayOnClose
      if (typeof raw.notifications === 'boolean') out.notifications = raw.notifications
      if (typeof raw.autoStart === 'boolean') out.autoStart = raw.autoStart
      if (typeof raw.isolatedHome === 'boolean') out.isolatedHome = raw.isolatedHome
      if (Array.isArray(raw.recentWorkspaces)) {
        out.recentWorkspaces = raw.recentWorkspaces.filter((w): w is string => typeof w === 'string')
      }
      if (typeof raw.globalShortcut === 'string') out.globalShortcut = raw.globalShortcut
      if (typeof raw.autoUpdate === 'boolean') out.autoUpdate = raw.autoUpdate
      if (Array.isArray(raw.disabledPlugins)) {
        out.disabledPlugins = raw.disabledPlugins.filter((p): p is string => typeof p === 'string')
      }
    }
  } catch {
    /* 损坏则回退默认 */
  }
  return out
}

export function saveSettings(file: string, s: AppSettings): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(s, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}
