/**
 * 维护操作：清理日志、卸载应用（Windows NSIS 卸载器）。
 */
import { app, dialog, BrowserWindow } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { log, logDirPath } from './logger'
import { notify } from './notify'

/** 清理日志目录中的日志文件（保留目录本身，logger 会重建新文件）。 */
export function cleanLogs(): void {
  const dir = logDirPath()
  if (!dir) return
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.log') || name.endsWith('.log.old')) {
        rmSync(path.join(dir, name), { force: true })
        removed++
      }
    }
    log('info', `maintenance: cleaned ${removed} log file(s)`)
    notify('清理完成', removed > 0 ? `已清理 ${removed} 个日志文件` : '没有需要清理的日志')
  } catch (err) {
    log('error', `maintenance: clean logs failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 从注册表读取 NSIS 卸载命令（HKCU 优先，回退 HKLM）。 */
function findUninstallCommand(appId: string): Promise<string | null> {
  const roots = ['HKCU', 'HKLM']
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId}`
  return new Promise((resolve) => {
    let idx = 0
    const tryNext = (): void => {
      if (idx >= roots.length) return resolve(null)
      const root = roots[idx++]
      execFile(
        'reg',
        ['query', `${root}\\${key}`, '/v', 'UninstallString'],
        { windowsHide: true, timeout: 10_000 },
        (err, stdout) => {
          if (err || !stdout) return tryNext()
          // reg 输出形如：  UninstallString    REG_SZ    "C:\...\Uninstall DSH Desktop.exe"
          const m = /UninstallString\s+REG_SZ\s+(.+)/.exec(stdout)
          if (!m) return tryNext()
          resolve(m[1].trim().replace(/^"|"$/g, ''))
        },
      )
    }
    tryNext()
  })
}

/** 卸载 DSH Desktop（仅 Windows）：调用 NSIS 卸载器，随后退出应用。 */
export async function uninstallApp(): Promise<void> {
  if (process.platform !== 'win32') {
    log('info', 'maintenance: uninstall only supported on Windows')
    return
  }
  const appId = 'com.dsh.desktop.workbench'
  let uninstaller: string | null = null
  try {
    uninstaller = await findUninstallCommand(appId)
  } catch (err) {
    log('error', `maintenance: registry query failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  // 回退：常见安装目录（electron-builder NSIS 默认路径）
  if (!uninstaller) {
    const candidates = [
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'dsh-desktop', 'Uninstall dsh-desktop.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH Desktop', 'Uninstall DSH Desktop.exe'),
    ]
    uninstaller = candidates.find((p) => existsSync(p)) ?? null
  }
  if (!uninstaller || !existsSync(uninstaller)) {
    notify('卸载失败', '未找到 DSH Desktop 卸载程序，请通过系统「设置 → 应用」卸载')
    log('error', 'maintenance: uninstaller not found')
    return
  }

  const confirmed = await confirmUninstall()
  if (!confirmed) {
    log('info', 'maintenance: uninstall cancelled by user')
    return
  }

  log('info', `maintenance: launching uninstaller ${uninstaller}`)
  try {
    // 卸载器独立进程运行（不捕获输出），随后退出本应用释放文件占用
    const child = spawn(uninstaller, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    setTimeout(() => app.quit(), 800)
  } catch (err) {
    log('error', `maintenance: spawn uninstaller failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 卸载前确认框（用户取消则不继续）。 */
function confirmUninstall(): Promise<boolean> {
  const win = BrowserWindow.getAllWindows()[0]
  const opts = {
    type: 'warning' as const,
    buttons: ['卸载', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '卸载 DSH Desktop',
    message: '确定要卸载 DSH Desktop 吗？',
    detail: '将启动系统卸载程序。用户数据（运行时缓存、日志、设置）会保留在本地，不会被删除。',
  }
  const p = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
  return p.then((r) => r.response === 0).catch(() => false)
}
