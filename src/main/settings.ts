/**
 * 壳设置：userData/settings.json。仅存壳层偏好，harness 设置留在 harness 侧。
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
  /** 使用独立 DSH_HOME（userData/dsh-home），默认复用系统 ~/.dsh */
  isolatedHome: boolean
  /** 最近工作区（新→旧），首个存在的作为默认 cwd */
  recentWorkspaces: string[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  trayOnClose: true,
  notifications: true,
  autoStart: false,
  isolatedHome: false,
  recentWorkspaces: [],
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
