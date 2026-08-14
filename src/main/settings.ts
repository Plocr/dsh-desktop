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
  /** 全局唤出快捷键（Electron accelerator 语法；空串禁用） */
  globalShortcut: string
  /** 启动后自动检查更新 */
  autoUpdate: boolean
  /** 右栏仪表盘偏好 */
  sidebar: {
    /** 默认展开 */
    enabled: boolean
    /** 宽度 px（240–420） */
    width: number
  }
  /** 底栏终端偏好 */
  terminal: {
    /** 默认展开 */
    enabled: boolean
    /** auto | powershell | cmd | pwsh | bash | zsh */
    shell: string
    /** 高度 px（120–480） */
    height: number
  }
  /** 窗口内快捷键（非全局；Electron accelerator 语法） */
  panelShortcuts: {
    terminal: string
    sidebar: string
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  trayOnClose: true,
  notifications: true,
  autoStart: false,
  isolatedHome: false,
  recentWorkspaces: [],
  globalShortcut: 'CommandOrControl+Shift+Space',
  autoUpdate: true,
  sidebar: { enabled: true, width: 300 },
  terminal: { enabled: false, shell: 'auto', height: 200 },
  panelShortcuts: { terminal: 'CommandOrControl+Shift+`', sidebar: 'CommandOrControl+Shift+.' },
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
      if (raw.sidebar && typeof raw.sidebar === 'object') {
        if (typeof raw.sidebar.enabled === 'boolean') out.sidebar.enabled = raw.sidebar.enabled
        if (typeof raw.sidebar.width === 'number') out.sidebar.width = clamp(raw.sidebar.width, 240, 420)
      }
      if (raw.terminal && typeof raw.terminal === 'object') {
        if (typeof raw.terminal.enabled === 'boolean') out.terminal.enabled = raw.terminal.enabled
        if (typeof raw.terminal.shell === 'string') out.terminal.shell = raw.terminal.shell
        if (typeof raw.terminal.height === 'number') out.terminal.height = clamp(raw.terminal.height, 120, 480)
      }
      if (raw.panelShortcuts && typeof raw.panelShortcuts === 'object') {
        if (typeof raw.panelShortcuts.terminal === 'string') out.panelShortcuts.terminal = raw.panelShortcuts.terminal
        if (typeof raw.panelShortcuts.sidebar === 'string') out.panelShortcuts.sidebar = raw.panelShortcuts.sidebar
      }
    }
  } catch {
    /* 损坏则回退默认 */
  }
  return out
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function saveSettings(file: string, s: AppSettings): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(s, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}
