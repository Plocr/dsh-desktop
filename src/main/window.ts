/**
 * 主窗口：加载 harness Web UI（http://127.0.0.1:<port>），
 * 内置 loading/error 过渡页；导航锁 + 外链拦截。
 */
import { BrowserWindow, nativeTheme, shell } from 'electron'
import path from 'node:path'
import { THEME_COLORS } from './theme'

export interface WindowHandle {
  win: BrowserWindow
  loadApp: (url: string) => void
  showLoading: (state?: string, theme?: 'light' | 'dark' | 'system') => void
  showError: (msg: string, theme?: 'light' | 'dark' | 'system') => void
  /** 本地更新覆盖层：加载更新面板并返回实时进度 setter；调用方负责 setProgressBar 之外的任务栏进度。 */
  showUpdateOverlay: (init: { pct?: number | null; detail: string; url?: string | null }, themeArg?: 'light' | 'dark' | 'system') => (p: { pct: number | null; detail: string; url?: string | null }) => void
  updateTaskbarProgress: (fraction: number | null) => void
}

export function createWindow(
  preloadPath: string,
  resourcesDir: string,
  opts: {
    isAllowed: (url: string) => boolean
    theme: 'light' | 'dark'
  },
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

  // 主题兜底 CSS：harness 的插件加载界面（"HARNESS / Loading plugins…"）颜色
  // 全部走 var(--dsw-alias-*, fallback)，插件树激活前变量未定义 → fallback 近白。
  // 在 :root 定义兜底变量（不带 !important）：boot 期间生效（深色/浅色），
  // harness 激活后在 body 上定义同名变量（更近祖先）自动覆盖——无需移除。
  // insertCSS 不跨导航保留 → 在 harness 文档 dom-ready 时（重新）注入。
  //
  // nativeTheme.themeSource 持久设为壳解析的有效主题：
  //  - harness 的 client 端设置同步在某些组合下回退 system（其 ui-theme 读不到
  //    显式偏好），而 system 解析依赖 prefers-color-scheme（= themeSource）；
  //  - 由壳按 settings.yaml 的 preference 驱动 themeSource，显式 light/dark
  //    重启后与 harness 一致，system 时 themeSource=system 跟随系统。
  //  - 副作用：原生标题栏颜色跟随有效主题（浅色主题→浅色标题栏，符合预期）。
  let currentBootTheme: 'light' | 'dark' | 'system' = theme

  const applyThemeBoot = (themeArg?: 'light' | 'dark' | 'system'): void => {
    if (win.isDestroyed()) return
    const pref = themeArg ?? currentBootTheme
    currentBootTheme = pref
    // effective：system → 跟随系统当前状态
    const effective: 'light' | 'dark' = pref === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : pref
    // themeSource：system 偏好保持 'system'（实时跟随系统）；显式偏好锁定
    try {
      nativeTheme.themeSource = pref
    } catch {
      /* ignore */
    }
    const css =
      effective === 'dark'
        ? [
            ':root{--dsw-alias-bg-base:#151517;--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-tertiary:#9aa0a6;--dsw-alias-border-l2:rgb(255 255 255 / 14%);--dsw-alias-brand-primary:#4d7cfe;}',
            'html,body{background:#151517;color:#f9fafb;}',
          ].join('')
        : [
            ':root{--dsw-alias-bg-base:#ffffff;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-tertiary:#6b7280;--dsw-alias-border-l2:rgb(0 0 0 / 10%);--dsw-alias-brand-primary:#3964fe;}',
            'html,body{background:#ffffff;color:#0f1115;}',
          ].join('')
    void win.webContents.insertCSS(css).catch(() => {})
  }

  const loadURL = (url: string): void => {
    if (win.isDestroyed()) return
    // 导航间隙占位帧颜色随 themeSource（已持久设为有效主题）→ 无黑/白闪
    win.webContents.once('dom-ready', () => {
      applyThemeBoot()
    })
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

  const showLoading = (state?: string, themeArg?: 'light' | 'dark' | 'system'): void => {
    if (win.isDestroyed()) return
    loadingShownAt = Date.now()
    // 记录/注入当前主题（dom-ready 时会再次注入到 harness 文档）
    currentBootTheme = themeArg ?? theme
    applyThemeBoot()
    const query: Record<string, string> = {}
    if (state) query.state = state
    if (themeArg === 'light' || themeArg === 'dark') query.theme = themeArg
    void win.loadFile(loadingPage, { query })
  }

  const showError = (msg: string, themeArg?: 'light' | 'dark' | 'system'): void => {
    if (win.isDestroyed()) return
    const query: Record<string, string> = { msg }
    if (themeArg === 'light' || themeArg === 'dark') query.theme = themeArg
    void win.loadFile(errorPage, { query })
  }

  /**
   * 本地更新覆盖层：用 loading.html 的 mode=update 面板显示进度条 + 下载地址。
   * 返回一个 setter 供调用方逐帧推送 { pct, detail, url }；调用时同步更新任务栏进度。
   */
  const showUpdateOverlay = (
    init: { pct?: number | null; detail: string; url?: string | null },
    themeArg?: 'light' | 'dark' | 'system',
  ): ((p: { pct: number | null; detail: string; url?: string | null }) => void) => {
    if (win.isDestroyed()) return () => undefined
    const query: Record<string, string> = { mode: 'update', detail: encodeURIComponent(init.detail) }
    if (init.url) query.url = encodeURIComponent(init.url)
    if (themeArg === 'light' || themeArg === 'dark') query.theme = themeArg
    const setTaskbar = (pct: number | null): void => {
      if (win.isDestroyed()) return
      try {
        if (typeof pct === 'number' && Number.isFinite(pct)) {
          win.setProgressBar(Math.max(0, Math.min(1, pct / 100)))
        } else {
          win.setProgressBar(-1) // 不确定进度
        }
      } catch {
        /* ignore */
      }
    }
    setTaskbar(typeof init.pct === 'number' ? init.pct : null)
    void win.loadFile(loadingPage, { query })
    const setter = (p: { pct: number | null; detail: string; url?: string | null }): void => {
      if (win.isDestroyed()) return
      setTaskbar(p.pct)
      const args = JSON.stringify([p.pct, p.detail, p.url ?? null])
      void win.webContents.executeJavaScript(`window.__setUpdate ? window.__setUpdate(...${args}) : void 0`).catch(() => {})
    }
    return setter
  }

  /** 任务栏叠加进度（Windows/macOS 通用）；null 清除。 */
  const updateTaskbarProgress = (fraction: number | null): void => {
    if (win.isDestroyed()) return
    try {
      if (fraction === null || !Number.isFinite(fraction)) win.setProgressBar(-1)
      else win.setProgressBar(Math.max(0, Math.min(1, fraction)))
    } catch {
      /* ignore */
    }
  }

  return { win, loadApp, showLoading, showError, showUpdateOverlay, updateTaskbarProgress }
}
