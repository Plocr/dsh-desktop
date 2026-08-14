/**
 * 主窗口：加载 harness Web UI（http://127.0.0.1:<port>），
 * 内置 loading/error 过渡页；导航锁 + 外链拦截。
 */
import { BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { THEME_COLORS } from './theme'

export interface WindowHandle {
  win: BrowserWindow
  loadApp: (url: string) => void
  showLoading: (state?: string, theme?: 'light' | 'dark') => void
  showError: (msg: string, theme?: 'light' | 'dark') => void
}

export function createWindow(
  preloadPath: string,
  resourcesDir: string,
  opts: { isAllowed: (url: string) => boolean; theme: 'light' | 'dark' },
): WindowHandle {
  const theme = opts.theme
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'DSH Desktop',
    // 窗口底色跟随 harness 主题（与加载页一致，避免绘制前闪错底色）
    backgroundColor: THEME_COLORS[theme].bg,
    icon: path.join(resourcesDir, 'icons', 'icon.png'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:dsh-ui',
    },
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (e, url) => {
    if (!opts.isAllowed(url)) {
      e.preventDefault()
    }
  })

  // 阻止页面尝试打开 devtools 以外的敏感能力；静默即可
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

  const loadingPage = path.join(resourcesDir, 'shell-pages', 'loading.html')
  const errorPage = path.join(resourcesDir, 'shell-pages', 'error.html')

  // 加载页最短显示时长：避免启动很快时 logo 一闪而过
  const MIN_LOADING_MS = 900
  let loadingShownAt = 0

  const loadURL = (url: string): void => {
    if (win.isDestroyed()) return
    void win.loadURL(url).catch((err) => {
      showError(`加载 ${url} 失败: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const loadApp = (url: string): void => {
    if (win.isDestroyed()) return
    const current = win.webContents.getURL()
    const doSwitch = (): void => {
      if (current.startsWith('file://')) {
        // 加载页先淡出（0.35s），再切换——转场不突变
        void win.webContents
          .executeJavaScript(`window.__fadeOut ? window.__fadeOut() : Promise.resolve()`)
          .then(() => loadURL(url))
          .catch(() => loadURL(url))
      } else {
        loadURL(url)
      }
    }
    // 保证加载页至少展示了 MIN_LOADING_MS（避免闪现）
    const shownFor = Date.now() - loadingShownAt
    if (loadingShownAt && shownFor < MIN_LOADING_MS) {
      setTimeout(doSwitch, MIN_LOADING_MS - shownFor)
    } else {
      doSwitch()
    }
  }

  const showLoading = (state?: string, themeArg?: 'light' | 'dark'): void => {
    if (win.isDestroyed()) return
    loadingShownAt = Date.now()
    const query: Record<string, string> = {}
    if (state) query.state = state
    if (themeArg) query.theme = themeArg
    void win.loadFile(loadingPage, { query })
  }

  const showError = (msg: string, themeArg?: 'light' | 'dark'): void => {
    if (win.isDestroyed()) return
    const query: Record<string, string> = { msg }
    if (themeArg) query.theme = themeArg
    void win.loadFile(errorPage, { query })
  }

  return { win, loadApp, showLoading, showError }
}
