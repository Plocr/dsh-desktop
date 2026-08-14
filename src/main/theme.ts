/**
 * 读取 harness 的主题偏好（~/.dsh/settings.yaml 的 ui-theme.preference），
 * 让启动页/窗口底色跟随 harness 设置（浅色/深色/跟随系统），而非 Windows 系统主题。
 */
import { nativeTheme } from 'electron'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export type ThemePreference = 'light' | 'dark' | 'system'

/** 从 settings.yaml 读取 ui-theme.preference（轻量行解析，不引入 YAML 依赖）。 */
export function readHarnessThemePreference(dshHome: string): ThemePreference | null {
  try {
    const text = readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8')
    const lines = text.split(/\r?\n/)
    let inUiTheme = false
    for (const line of lines) {
      if (!inUiTheme) {
        if (/^ui-theme\s*:/.test(line)) {
          inUiTheme = true
        }
        continue
      }
      const trimmed = line.trim()
      if (trimmed && !/^\s/.test(line)) break // 进入下一个顶层键
      const m = /^preference\s*:\s*(\w+)/.exec(trimmed)
      if (m) {
        const v = m[1]
        if (v === 'light' || v === 'dark' || v === 'system') return v
      }
    }
  } catch {
    /* 文件缺失/损坏：回退 */
  }
  return null
}

/** 解析出实际生效的明暗主题：system/缺失 → 跟随 Windows 系统。 */
export function resolveEffectiveTheme(dshHome: string): 'light' | 'dark' {
  const pref = readHarnessThemePreference(dshHome)
  if (pref === 'light' || pref === 'dark') return pref
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** 与 harness 深色主题一致的色值（实测：背景 rgb(21,21,23)，文字 rgb(249,250,251)）。 */
export const THEME_COLORS = {
  light: { bg: '#ffffff', ink: '#0f1115', sub: '#6b7280' },
  dark: { bg: '#151517', ink: '#f9fafb', sub: '#9aa0a6' },
} as const
