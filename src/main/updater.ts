/**
 * 第 1 层·桌面端自动更新（electron-updater + GitHub provider）。
 *
 *  - 打包版：启动 15s 后自动检查（受托盘「自动检测更新」开关控制）；
 *    托盘「检查更新…」手动检查（仅桌面端一层，官方 harness 层见 harnessCheck.ts）。
 *  - 本地下载不跳浏览器：autoDownload=true，下载进度实时推给更新覆盖层
 *    （进度条 + 下载地址）；下载完成后退出时自动安装（autoInstallOnAppQuit）。
 *  - 展示下载地址（官方 GitHub 地址 + GitHub 免费加速代理地址，便于复制/备用）。
 *    GitHub 加速前缀可用 DSH_DESKTOP_GH_PROXY 覆盖，默认 ghfast.top。
 *  - 更新源：打包时 electron-builder.yml 的 publish（provider: github → 仓库
 *    Plocr/dsh-desktop）写入 app-update.yml；electron-updater 据此查询该仓库
 *    latest release 比对版本。
 *  - 测试/部署覆盖：环境变量 DSH_DESKTOP_UPDATE_URL 存在时切换为 generic 源。
 *  - 检查带 30s 超时保护（更新源不可达时不挂死）；自动检查失败只记日志、
 *    手动检查失败才弹通知。
 *  - 开发模式：跳过（无 app-update.yml）。
 */
import { app, shell } from 'electron'
import { log } from './logger'
import { notify } from './notify'

const RELEASES_PAGE = 'https://github.com/Plocr/dsh-desktop/releases/latest'

// GitHub 免费加速代理前缀（仅用于「展示/手动下载」的加速地址；主下载仍走 electron-updater）
// ghfast.top / ghproxy.com 等为社区代理，地址可变，可用 DSH_DESKTOP_GH_PROXY 覆盖。
const DEFAULT_GH_PROXY = 'https://ghfast.top/'

export function ghProxyPrefix(): string {
  return process.env.DSH_DESKTOP_GH_PROXY || DEFAULT_GH_PROXY
}

/** 把官方 GitHub 地址拼成加速代理地址（无前缀则原样）。 */
export function withGhProxy(url: string): string {
  const p = ghProxyPrefix().trim()
  if (!p) return url
  return p.endsWith('/') ? p + url : p + '/' + url
}

let autoUpdater: import('electron-updater').AppUpdater | null = null
let initialized = false
let hooks: UpdaterHooks = {
  onManualResult: () => {},
  onAvailable: () => {},
  onProgress: () => {},
  onDownloaded: () => {},
}
let lastCheckWasManual = false
const CHECK_TIMEOUT_MS = 30_000

export interface UpdateProgress {
  /** 0-100 */
  percent: number
  /** 已下载字节 */
  transferred: number
  /** 总字节 */
  total: number
  bytesPerSecond: number
}

export interface UpdaterHooks {
  /** 手动检查的最终结果文案（已最新/失败） */
  onManualResult: (msg: string) => void
  /** 检测到新版（本地已开始下载） */
  onAvailable: (info: { version: string; fileUrl: string; proxyUrl: string }) => void
  /** 下载进度 */
  onProgress: (p: UpdateProgress) => void
  /** 下载完成（等待退出安装/点击立即安装） */
  onDownloaded: (info: { version: string; fileUrl: string }) => void
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

    // 本地下载（进度可观测）、退出时自动安装；Web 安装器关闭（用 NSIS 静默安装）
    au.autoDownload = true
    au.autoInstallOnAppQuit = true
    au.disableWebInstaller = true

    const fileUrlOf = (info: { files?: { url?: string }[] }): string =>
      info.files?.[0]?.url && /^https?:\/\//.test(info.files[0].url) ? info.files[0].url : RELEASES_PAGE

    au.on('checking-for-update', () => log('info', 'updater: checking for update'))
    au.on('update-available', (info) => {
      log('info', `updater: update available ${info.version}`)
      const fileUrl = fileUrlOf(info as { files?: { url?: string }[] })
      hooks.onAvailable({ version: info.version, fileUrl, proxyUrl: withGhProxy(fileUrl) })
      notify('发现新版本', `DSH Desktop ${info.version} 已开始本地下载`, () => {
        void shell.openExternal(RELEASES_PAGE).catch((err) => {
          log('error', `updater: open releases page failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      })
    })
    au.on('download-progress', (p) => {
      hooks.onProgress({
        percent: Math.round(p.percent),
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond,
      })
    })
    au.on('update-downloaded', (info) => {
      const version = typeof info?.version === 'string' ? info.version : '未知版本'
      const fileUrl = fileUrlOf(info as { files?: { url?: string }[] })
      log('info', `updater: update downloaded ${version}`)
      hooks.onDownloaded({ version, fileUrl })
      notify('更新已就绪', `DSH Desktop ${version} 下载完成，退出时自动安装；点击立即重启安装`, () => {
        try {
          au.quitAndInstall()
        } catch (err) {
          log('error', `updater: quitAndInstall failed: ${err instanceof Error ? err.message : String(err)}`)
        }
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
    if (manual) {
      // 手动检查失败：提示 + 给出加速下载地址作为兜底
      hooks.onManualResult(`检查更新失败：${msg}`)
    }
  }
}
