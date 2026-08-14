/**
 * 全局快捷键：注册/注销/查询。默认 CommandOrControl+Shift+Space 唤出窗口，
 * 可在 settings.json 的 `globalShortcut` 里改（Electron accelerator 语法）。
 */
import { globalShortcut } from 'electron'
import { log } from './logger'

let current = ''

export function registerGlobalShortcut(accelerator: string, action: () => void): boolean {
  try {
    if (current) globalShortcut.unregister(current)
    current = ''
    if (!accelerator) return false
    const ok = globalShortcut.register(accelerator, action)
    if (ok) {
      current = accelerator
      log('info', `global shortcut registered: ${accelerator}`)
    } else {
      log('error', `global shortcut registration failed (可能被其他应用占用): ${accelerator}`)
    }
    return ok
  } catch (err) {
    log('error', `global shortcut error: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export function currentShortcut(): string {
  return current
}

export function unregisterAllShortcuts(): void {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }
  current = ''
}
