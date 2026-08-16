/**
 * 第 1 层·桌面端自动更新检测（electron-updater + GitHub provider）。
 *
 *  - 打包版：启动 15s 后自动检查（受托盘「自动检测更新」开关控制）；
 *    托盘「检查更新…」手动检查（仅桌面端一层，官方 harness 层见 harnessCheck.ts）。
 *  - 只检测不自动下载：发现新版本 → 弹通知，点击打开 GitHub 最新 Release 页
 *    （https://github.com/Plocr/dsh-desktop/releases/latest），由用户自行下载安装。
 *  - 更新源：打包时 electron-builder.yml 的 publish（provider: github → 仓库
 *    Plocr/dsh-desktop）写入 app-update.yml；electron-updater 据此查询该仓库
 *    latest release 比对版本。
 *  - 测试/部署覆盖：环境变量 DSH_DESKTOP_UPDATE_URL 存在时切换为 generic 源。
 *  - 检查带 30s 超时保护（更新源不可达时不挂死）；自动检查失败只记日志，
 *    手动检查失败才弹通知。
 *  - 开发模式：跳过（无 app-update.yml）。
 */
import { app, shell } from 'electron'
import { log } from './logger'
import { notify } from './notify'

const RELEASES_PAGE = 'https://github.com/Plocr/dsh-desktop/releases/latest'

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

    // 只检测、不自动下载安装：新版由通知点击跳转 GitHub 发布页
    au.autoDownload = false
    au.autoInstallOnAppQuit = false
    au.disableWebInstaller = true

    au.on('checking-for-update', () => log('info', 'updater: checking for update'))
    au.on('update-available', (info) => {
      log('info', `updater: update available ${info.version}`)
      notify('发现新版本', `DSH Desktop ${info.version} 已发布，点击前往 GitHub 下载`, () => {
        void shell.openExternal(RELEASES_PAGE).catch((err) => {
          log('error', `updater: open releases page failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      })
    })
    au.on('update-not-available', () => {
      log('info', 'updater: no update')
      if (lastCheckWasManual) hooks.onManualResult('已是最新版本')
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
