/**
 * 自动更新（electron-updater + generic feed）。
 *
 *  - 打包版：启动 15s 后自动检查；托盘「检查更新…」手动检查；
 *    发现更新 → 后台下载 → 就绪后通知，点击即退出并安装。
 *  - 更新源：打包时 electron-builder.yml 的 publish（generic url）写入
 *    app-update.yml；运行时可用 DSH_DESKTOP_UPDATE_URL 覆盖。
 *  - 检查带 30s 超时保护（更新源不可达时不挂死）；自动检查失败只记日志，
 *    手动检查失败才弹通知。
 *  - 开发模式：跳过（无 app-update.yml）。
 */
import { app } from 'electron'
import { log } from './logger'
import { notify } from './notify'

let autoUpdater: import('electron-updater').AppUpdater | null = null
let initialized = false
let hooks: UpdaterHooks = { onManualResult: () => {} }
let lastCheckWasManual = false
const CHECK_TIMEOUT_MS = 30_000

interface UpdaterHooks {
  onManualResult: (msg: string) => void
}

export function initUpdater(initHooks: UpdaterHooks, opts: { autoCheck: boolean }): void {
  hooks = initHooks
  if (!app.isPackaged) {
    log('info', 'updater: dev mode, skipped')
    return
  }
  try {
    // electron-updater 是外部依赖（asar 内 node_modules），esbuild 不打包
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater: au } = require('electron-updater') as typeof import('electron-updater')
    autoUpdater = au
    // 转发 electron-updater 内部日志（诊断更新链路）
    const toStr = (m: unknown): string => (typeof m === 'string' ? m : m instanceof Error ? m.message : JSON.stringify(m))
    au.logger = {
      debug: (m: unknown) => log('info', `[updater:debug] ${toStr(m)}`),
      info: (m: unknown) => log('info', `[updater:debug] ${toStr(m)}`),
      warn: (m: unknown) => log('error', `[updater:warn] ${toStr(m)}`),
      error: (m: unknown) => log('error', `[updater:error] ${toStr(m)}`),
    }
    const feed = process.env.DSH_DESKTOP_UPDATE_URL
    if (feed) {
      au.setFeedURL({ provider: 'generic', url: feed })
      log('info', `updater: feed overridden -> ${feed}`)
    }

    au.autoDownload = true
    au.autoInstallOnAppQuit = true
    au.disableWebInstaller = true

    au.on('checking-for-update', () => log('info', 'updater: checking for update'))
    au.on('update-available', (info) => {
      log('info', `updater: update available ${info.version}`)
      notify('发现新版本', `DSH Desktop ${info.version} 正在后台下载…`)
    })
    au.on('update-not-available', () => {
      log('info', 'updater: no update')
      if (lastCheckWasManual) hooks.onManualResult('已是最新版本')
    })
    au.on('download-progress', (p) => {
      if (p && typeof p.percent === 'number' && Math.floor(p.percent) % 25 === 0 && p.percent > 0) {
        log('info', `updater: download ${p.percent.toFixed(0)}%`)
      }
    })
    au.on('update-downloaded', (info) => {
      log('info', `updater: downloaded ${info.version}, ready to install`)
      notify('更新已就绪', `DSH Desktop ${info.version} 已下载完成，点击重启并安装`, () => {
        try {
          au.quitAndInstall(false, true)
        } catch (err) {
          log('error', `updater: quitAndInstall failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
    })
    au.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', `updater: ${msg}`)
      if (lastCheckWasManual) hooks.onManualResult(`检查更新失败：${msg}`)
    })

    initialized = true
    if (opts.autoCheck) {
      setTimeout(() => {
        void checkNow(false)
      }, 15_000)
    }
  } catch (err) {
    log('error', `updater init failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function checkNow(manual: boolean): Promise<void> {
  if (!app.isPackaged) {
    log('info', 'updater: dev mode, skipped')
    return
  }
  if (!autoUpdater || !initialized) {
    log('error', 'updater: not initialized')
    return
  }
  lastCheckWasManual = manual
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('检查超时（更新源不可达？）')), CHECK_TIMEOUT_MS)
  })
  try {
    await Promise.race([autoUpdater.checkForUpdates(), timeout])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('error', `updater check failed: ${msg}`)
    if (manual) hooks.onManualResult(`检查更新失败：${msg}`)
  }
}
