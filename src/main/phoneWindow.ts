/**
 * 「手机连接」二维码窗口（壳页面 dsh-app://shell/phone.html）。
 *
 * 为什么单独开一个原生窗口而不是塞进工作台页面：官方桌面壳的约定是**插件/页面不碰原生能力**，
 * 而「把本机地址交给别的设备」是壳的动作（局域网门面 + 设备授权都由主进程管）。
 * 于是托盘里点「手机连接」→ 主进程按需拉起局域网门面 → 这个小窗口把地址渲染成二维码，
 * 手机扫码即打开同一个 Web 工作台（首次访问在本机确认授权）。
 *
 * 页面只拿得到矩阵数据与地址文本（经 ipc.ts 的 shell 白名单），拿不到 Host 的端口/cookie。
 */
import { BrowserWindow } from 'electron'
import path from 'node:path'
import { THEME_COLORS } from './theme'
import { SHELL_ORIGIN } from './appProtocol'
import { UI_PARTITION } from './window'
import { log } from './logger'

/** 手机连接页需要的全部信息（主进程算好，页面只负责画）。 */
export interface PhoneConnectInfo {
  /** ready = 有地址与二维码；starting = Host 还没就绪（页面稍后自动重试）；unavailable = 明确失败 */
  status: 'ready' | 'starting' | 'unavailable'
  /** 手机要访问的地址（含本次运行 token）；未就绪为 null。 */
  url: string | null
  /** 已渲染好的二维码模块矩阵（`modules[row][col]`，true = 深色）。 */
  qr: { size: number; modules: boolean[][] } | null
  /** 给用户看的一句话说明（状态行文案）。 */
  detail: string
}

export interface PhoneWindowDeps {
  /** 壳 preload（与主窗口同一个，按来源分级暴露 API）。 */
  preloadPath: string
  /** 壳资源根（取窗口图标）。 */
  resourcesDir: string
  /** 当前主题（窗口底色 + 页面主题参数）。 */
  theme: () => 'light' | 'dark'
}

let phoneWindow: BrowserWindow | null = null

/** 手机连接窗口是否已打开（托盘勾选/重入判断用）。 */
export function isPhoneWindowOpen(): boolean {
  return phoneWindow !== null && !phoneWindow.isDestroyed()
}

/** 关闭手机连接窗口（断开手机连接时一并关掉，避免留着一个失效地址）。 */
export function closePhoneWindow(): void {
  const win = phoneWindow
  phoneWindow = null
  if (win !== null && !win.isDestroyed()) win.close()
}

/**
 * 打开（或聚焦）手机连接窗口。已打开时只前置，不重新加载——重新加载会让二维码闪一下，
 * 而地址在一次运行内是稳定的（断开/开启才会变）。
 */
export function showPhoneWindow(deps: PhoneWindowDeps): void {
  if (isPhoneWindowOpen()) {
    const win = phoneWindow as BrowserWindow
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  const theme = deps.theme()
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    maximizable: false,
    title: '手机连接 — DSH Desktop',
    backgroundColor: THEME_COLORS[theme].bg,
    icon: path.join(deps.resourcesDir, 'icons', 'icon.png'),
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: UI_PARTITION,
    },
  })
  phoneWindow = win
  win.once('ready-to-show', () => win.show())
  // 这个窗口只显示壳页面：不允许开新窗口、不允许页面自己导航去别处
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win.on('closed', () => {
    phoneWindow = null
  })
  void win.loadURL(`${SHELL_ORIGIN}/phone.html?theme=${theme}`).catch((err: unknown) => {
    log('error', `phone window load failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}
