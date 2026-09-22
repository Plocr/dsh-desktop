/**
 * 第 1 层·桌面端自动更新（electron-updater + GitHub provider）。
 *
 *  - 打包版：启动 15s 后自动检查（受托盘「自动检测更新」开关控制）；
 *    托盘「检查更新…」手动检查（只有框架一层：壳 + 随包 dsh 运行时是一个签名更新单元）。
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
import { hasInstallablePayload, unsupportedPayloadReason } from './updatePayload.ts'

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
/** 已下载待安装的版本（安装前由用户在右上角点「安装更新并重启」）。 */
let downloadedVersion: string | null = null
let hooks: UpdaterHooks = {
  onManualResult: () => {},
  onAvailable: () => {},
  onUnsupported: () => {},
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

/** 是否已有可安装的下载完成更新。 */
export function updateDownloadReady(): boolean {
  return downloadedVersion !== null
}

/** 立即退出并安装已下载的更新（由用户点「安装更新并重启」触发）。返回是否启动安装。 */
export function installDownloadedUpdate(): boolean {
  if (!autoUpdater || !downloadedVersion) return false
  try {
    // 参数是 (isSilent, isForceRunAfter)：
    //  - 静默：应用内对话框已经问过一次（「现在将结束应用并安装更新」），再弹一层
    //    NSIS 向导是重复确认；`/S` 对 electron-builder 的向导式安装包同样有效
    //    （`--updated` 会沿用已有安装目录，不需要 /D）。
    //  - 强制重启：对话框承诺的是「安装完成后自动重启」，而默认
    //    isForceRunAfter=false 只会把「运行应用」交给 Finish 页的勾选框，
    //    用户不点就不会重启。
    autoUpdater.quitAndInstall(true, true)
    return true
  } catch (err) {
    log('error', `updater: quitAndInstall failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export interface UpdaterHooks {
  /** 手动检查的最终结果文案（已最新/失败） */
  onManualResult: (msg: string) => void
  /** 检测到新版（本地已开始下载） */
  onAvailable: (info: { version: string; fileUrl: string; proxyUrl: string }) => void
  /**
   * 检测到新版，但**本平台装不了**（macOS 清单里没有 zip，见 updatePayload.ts）：
   * 不再假装在下载，只把手动下载地址交出去。
   */
  onUnsupported: (info: { version: string; fileUrl: string; proxyUrl: string; reason: string }) => void
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

    // 本地下载（进度推送）；安装需用户点「安装更新并重启」（不随退出自动装——
    // 且不能在我们 after-quit 强退时被吞，见 index.ts before-quit 的更新安装分支）
    //
    // autoDownload 必须是 false：自动下载发生在 electron-updater **内部**的
    // update-available 监听器里，壳拦不住。而 macOS 的清单里没有 zip 时
    // downloadUpdate() 必抛 ERR_UPDATER_ZIP_FILE_NOT_FOUND —— 那样壳还没来得及
    // 说「这版装不了」，用户就先看到一条「检查更新失败」。所以下载由壳在
    // update-available 里显式发起（见下），先判断能不能装。
    au.autoDownload = false
    au.autoInstallOnAppQuit = false
    au.disableWebInstaller = true

    const fileUrlOf = (info: { files?: { url?: string }[] }): string =>
      info.files?.[0]?.url && /^https?:\/\//.test(info.files[0].url) ? info.files[0].url : RELEASES_PAGE

    au.on('checking-for-update', () => log('info', 'updater: checking for update'))
    au.on('update-available', (info) => {
      log('info', `updater: update available ${info.version}`)
      const fileUrl = fileUrlOf(info as { files?: { url?: string }[] })
      const files = (info as { files?: unknown }).files
      if (!hasInstallablePayload(files, process.platform)) {
        // 诚实降级：**不**发起下载（注定失败），也**不**说「已开始本地下载」。
        // 自动检查保持安静（每次冷启动都弹通知会很吵），只把卡片摆在右上角；
        // 手动检查给一句明确结论，而不是让用户去看「检查更新失败」。
        const reason = unsupportedPayloadReason(process.platform)
        log('error', `updater: no installable payload for ${process.platform} (${info.version}): ${reason}`)
        hooks.onUnsupported({ version: info.version, fileUrl, proxyUrl: withGhProxy(fileUrl), reason })
        if (lastCheckWasManual) {
          hooks.onManualResult(`${reason}，请到 Release 页手动下载安装`)
          lastCheckWasManual = false
        }
        return
      }
      hooks.onAvailable({ version: info.version, fileUrl, proxyUrl: withGhProxy(fileUrl) })
      notify('发现新版本', `DSH Desktop ${info.version} 已开始本地下载`, () => {
        void shell.openExternal(RELEASES_PAGE).catch((err) => {
          log('error', `updater: open releases page failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      })
      // autoDownload=false 之后由壳显式下载；失败经 'error' 事件统一回报（与之前一致）
      void autoUpdater?.downloadUpdate().catch((err) => {
        log('error', `updater: downloadUpdate rejected: ${err instanceof Error ? err.message : String(err)}`)
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
      downloadedVersion = version
      hooks.onDownloaded({ version, fileUrl })
    })
    au.on('update-not-available', () => {
      log('info', 'updater: no update')
      if (lastCheckWasManual) {
        hooks.onManualResult('已是最新版本')
        lastCheckWasManual = false // 本次手动检查已回报，避免后续事件二次提示
      }
    })
    au.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', `updater: ${msg}`)
      if (lastCheckWasManual) {
        hooks.onManualResult(`检查更新失败：${msg}`)
        lastCheckWasManual = false
      }
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
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('检查超时（更新源不可达？）')), CHECK_TIMEOUT_MS)
  })
  try {
    await Promise.race([autoUpdater.checkForUpdates(), timeout])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('error', `updater check failed: ${msg}`)
    // 本次检查到此结束：底层请求可能仍在跑，其迟到的 error 事件不应再二次弹提示
    lastCheckWasManual = false
    if (manual) {
      // 手动检查失败：提示 + 给出加速下载地址作为兜底
      hooks.onManualResult(`检查更新失败：${msg}`)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
