/**
 * 「登录 DeepSeek」的内置网页窗口（0.8.8）。
 *
 * 背景：账号登录是**浏览器授权**流程——harness 先向平台要一个 `authorize_url`，
 * 用户在那个页面里完成授权，平台再回跳本机 `http://127.0.0.1:<port>/oauth/callback?code=…`。
 * 0.8.7 之前我们只把这条 URL 丢给**系统默认浏览器**（`shell.openExternal`），
 * 于是"机器上没配默认浏览器 / 默认浏览器被劫持 / 用户没注意到切过去的窗口"都会让登录卡住。
 *
 * 0.8.8 起默认**在应用内开一个独立的网页窗口**（独立 session 分区，可保留平台登录态），
 * 加载失败或导航到非允许地址时自动退回系统浏览器——两种方式都在，用户不需要选。
 *
 * 安全边界（这个窗口不许当通用浏览器用）：
 *  - 只允许导航到**平台授权域**与**本机回环回调**（Host 的 `/oauth/callback`）；
 *  - 其它 http(s) 地址一律改为交给系统浏览器打开（页面里的"帮助/条款"这类外链）；
 *  - 不带 preload、不开 nodeIntegration，`sandbox: true`；
 *  - 关闭时机由账号状态驱动（成功/失败/取消/过期都由壳关掉），用户也可以自己关。
 */
import { BrowserWindow, shell } from 'electron'
import { log } from './logger.ts'
// 策略是纯函数（可单测），放在 loginPolicy.ts；这里只做 Electron 窗口
import { loginNavigationAllowed, loginUsesExternalBrowser } from './loginPolicy.ts'

let loginWindow: BrowserWindow | null = null

/** 当前是否有一个内置登录窗口开着（通知去重等用途）。 */
export function hasLoginWindow(): boolean {
  return loginWindow !== null && !loginWindow.isDestroyed()
}

/** 关掉内置登录窗口（账号状态进入终态时由调用方触发；重复调用安全）。 */
export function closeLoginWindow(reason: string): void {
  const window = loginWindow
  loginWindow = null
  if (window === null || window.isDestroyed()) return
  log('info', `login window: closing (${reason})`)
  try {
    window.destroy()
  } catch {
    /* 已经销毁 */
  }
}

/**
 * 打开登录页：默认应用内窗口，失败或显式选择时用系统浏览器。
 * @param authorizeUrl - harness 产出的平台授权地址
 * @returns 实际采用的方式（供日志/诊断）
 */
export function openLoginWindow(authorizeUrl: string): 'embedded' | 'external' {
  const external = (reason: string): 'external' => {
    log('info', `login window: falling back to system browser (${reason})`)
    void shell.openExternal(authorizeUrl).catch((error: unknown) => {
      log('error', `login window: openExternal failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return 'external'
  }

  if (loginUsesExternalBrowser()) return external('DSH_DESKTOP_LOGIN_BROWSER=1')
  closeLoginWindow('replaced by a new attempt')

  try {
    const window = new BrowserWindow({
      width: 520,
      height: 760,
      minWidth: 420,
      minHeight: 560,
      title: '登录 DeepSeek',
      autoHideMenuBar: true,
      // 与工作台窗口同源的窗口图标：资源在 asar 内，直接给绝对路径即可
      webPreferences: {
        // 独立分区（persist: 前缀）→ 平台侧的登录态可复用；与工作台分区隔离
        partition: 'persist:dsh-login',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    loginWindow = window
    window.on('closed', () => {
      if (loginWindow === window) loginWindow = null
    })
    // 站内弹窗（条款/帮助等）交给系统浏览器，不在登录窗口里叠窗口
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/iu.test(url)) void shell.openExternal(url).catch(() => undefined)
      return { action: 'deny' }
    })
    const guard = (event: { preventDefault: () => void }, url: string): void => {
      if (loginNavigationAllowed(url)) return
      event.preventDefault()
      log('info', `login window: external navigation ${new URL(url).origin}`)
      if (/^https?:/iu.test(url)) void shell.openExternal(url).catch(() => undefined)
    }
    window.webContents.on('will-navigate', (event, url) => guard(event, url))
    window.webContents.on('will-redirect', (event, url) => guard(event, url))
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.webContents.on('preload-error', () => closeLoginWindow('preload error'))
    window.webContents.on('render-process-gone', () => closeLoginWindow('renderer gone'))
    void window
      .loadURL(authorizeUrl)
      .then(() => log('info', 'login window: authorize page loaded'))
      .catch((error: unknown) => {
        const aborted = error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ERR_ABORTED'
        // ERR_ABORTED 是页面自己跳转导致的正常中断（例如完成页收尾），不算失败
        if (aborted) return
        closeLoginWindow('load failed')
        external(error instanceof Error ? error.message : String(error))
      })
    return 'embedded'
  } catch (error) {
    log('error', `login window: create failed: ${error instanceof Error ? error.message : String(error)}`)
    return external('window creation failed')
  }
}
