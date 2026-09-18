/**
 * 主窗口：加载 harness Web UI（dsh-app://app/，由主进程代理到回环 harness，
 * 渲染层拿不到端口 —— 见 appProtocol.ts），内置 loading/error 过渡页；
 * 导航锁 + 外链拦截。
 */
import { BrowserWindow, nativeTheme, shell } from 'electron'
import path from 'node:path'
import { THEME_COLORS } from './theme'
import { APP_ENTRY_URL, APP_ORIGIN, SHELL_ORIGIN } from './appProtocol'

/** 窗口所用 session 分区（dsh-app:// 协议处理器必须装在这个分区上）。 */
export const UI_PARTITION = 'persist:dsh-ui'

export interface WindowHandle {
  win: BrowserWindow
  /** 切到工作台（harness 就绪后调用；地址固定为 dsh-app://app/）。 */
  /**
   * 切到工作台。
   * @param generation - Host 世代（每次 ready 递增）：同一世代且已经在工作台时**不重新加载**，
   *   避免重启流程里反复 loadURL 造成的闪屏；Host 换代（新端口/新 cookie）时必须重载。
   */
  loadApp: (generation?: number) => void
  showLoading: (state?: string, theme?: 'light' | 'dark' | 'system') => void
  showError: (msg: string, theme?: 'light' | 'dark' | 'system') => void
  /**
   * 更新进度小卡片：在当前页面右上角注入一个非阻塞卡片（可关闭、不导航、不影响使用/最小化）。
   * id 区分不同来源的卡片，互不覆盖与移除。
   */
  showUpdateOverlay: (
    init: { pct?: number | null; detail: string; url?: string | null },
    id?: string,
  ) => (p: {
    pct: number | null
    detail: string
    url?: string | null
  }) => void
  /** 移除更新小卡片并清除任务栏进度（id 指定要移除的卡片）。 */
  hideUpdateOverlay: (id?: string) => void
  /** 显示/隐藏「安装更新并重启」按钮（下载完成后调用）。 */
  setUpdateInstallButton: (show: boolean, id?: string) => void
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
      partition: UI_PARTITION,
    },
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 回环地址是壳自己的 Host（`http://127.0.0.1:<port>`），绝不丢到系统浏览器：
    // 那里没有会话 cookie，打开只会得到 401，还会把内部地址暴露给浏览器历史。
    const loopback = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/iu.test(url)
    if (!loopback && /^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (e, url) => {
    if (!opts.isAllowed(url)) {
      e.preventDefault()
    }
  })

  // 阻止页面尝试打开 devtools 以外的敏感能力；静默即可
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

  // 加载页最短显示时长：避免启动很快时 logo 一闪而过
  const MIN_LOADING_MS = 900
  let loadingShownAt = 0
  /** 已加载的工作台对应的 Host 世代（见 loadApp 的重入判定）。 */
  let appLoadedGeneration: number | undefined
  /** 当前加载页显示的状态文案：重复调用被忽略，避免同一状态反复 loadURL。 */
  let loadingState: string | undefined

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

  const loadApp = (generation?: number): void => {
    if (win.isDestroyed()) return
    const current = win.webContents.getURL()
    // 已经在工作台、且 Host 世代没变 → 什么都不做（重启流程里的重复调用不再重载页面，
    // 消除「已经可用了又闪一下加载页」的观感）。
    if (current.startsWith(APP_ORIGIN) && generation !== undefined && generation === appLoadedGeneration) return
    const doSwitch = (): void => {
      appLoadedGeneration = generation
      if (current.startsWith(SHELL_ORIGIN)) {
        // 加载页先淡出（0.35s），再切换——转场不突变
        void win.webContents
          .executeJavaScript(`window.__fadeOut ? window.__fadeOut() : Promise.resolve()`)
          .then(() => loadURL(APP_ENTRY_URL))
          .catch(() => loadURL(APP_ENTRY_URL))
      } else {
        loadURL(APP_ENTRY_URL)
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

  /** 壳页面地址（dsh-app://shell/<page>?…）：由 appProtocol 只读服务 resources/shell-pages。 */
  const shellUrl = (page: string, query: Record<string, string>): string => {
    const q = new URLSearchParams(query).toString()
    return `${SHELL_ORIGIN}/${page}${q ? `?${q}` : ''}`
  }

  const showLoading = (state?: string, themeArg?: 'light' | 'dark' | 'system'): void => {
    if (win.isDestroyed()) return
    // 幂等：已经在加载页且状态未变时不再 loadURL（重启/崩溃回调会重复调用它，
    // 每次重载都会让加载页从头播动画 —— 那正是「闪屏」的主要来源）。
    const current = win.webContents.getURL()
    const themeUnchanged = themeArg === undefined || themeArg === currentBootTheme
    if (current.startsWith(`${SHELL_ORIGIN}/loading.html`) && state === loadingState && themeUnchanged) return
    loadingState = state
    appLoadedGeneration = undefined
    loadingShownAt = Date.now()
    // 记录/注入当前主题（dom-ready 时会再次注入到 harness 文档）
    currentBootTheme = themeArg ?? theme
    applyThemeBoot()
    const query: Record<string, string> = {}
    if (state) query.state = state
    if (themeArg === 'light' || themeArg === 'dark') query.theme = themeArg
    void win.loadURL(shellUrl('loading.html', query)).catch(() => undefined)
  }

  const showError = (msg: string, themeArg?: 'light' | 'dark' | 'system'): void => {
    if (win.isDestroyed()) return
    // 页面用 decodeURIComponent 读取 msg → 这里先编码一次，避免 % 触发解码异常
    const query: Record<string, string> = { msg: encodeURIComponent(msg) }
    if (themeArg === 'light' || themeArg === 'dark') query.theme = themeArg
    void win.loadURL(shellUrl('error.html', query)).catch(() => undefined)
  }

  /**
   * 更新进度小卡片：在当前页面右上角注入一个非阻塞卡片（可关闭、不导航、
   * 不挡操作、可最小化到托盘）。返回一个 setter 供逐帧推送 { pct, detail, url }，
   * setter 同步更新任务栏进度。页面不可用（还没加载）时静默降级为任务栏进度。
   */
  // 注入到页面里的卡片引导脚本：创建固定 div + 更新卡片内容
  // 下载完成时显示「安装更新并重启」按钮 → 调 window.dshDesktop.installUpdate()（壳 IPC 触发安装）
  // id 由调用方传入：不同来源的卡片用不同 id，互不覆盖/移除
  const UPDATE_TOAST = `function(id,pct,detail,url){
  var ID=id;
  var el=document.getElementById(ID);
  if(!el){
    el=document.createElement('div');
    el.id=ID;
    el.style.cssText='position:fixed;top:14px;right:14px;z-index:2147483647;min-width:280px;max-width:360px;font:13px/1.55 system-ui,"Segoe UI",sans-serif;color:#f5f7fa;background:rgba(18,20,26,.93);border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:10px 12px 12px;box-shadow:0 10px 28px rgba(0,0,0,.4)';
    el.innerHTML='<div class="dshut-title" style="font-weight:600;margin-bottom:4px;padding-right:18px">更新</div>'+
      '<div class="dshut-detail" style="opacity:.92;margin-bottom:7px;white-space:pre-wrap;word-break:break-all">…</div>'+
      '<div style="height:4px;border-radius:2px;background:rgba(255,255,255,.18);overflow:hidden"><div class="dshut-bar" style="height:100%;width:0;background:#4d7cfe;transition:width .2s"></div></div>'+
      '<div class="dshut-url" style="opacity:.75;font-size:11px;margin-top:6px;word-break:break-all;display:none">…</div>'+
      '<button class="dshut-install" style="display:none;margin-top:8px;width:100%;border:0;border-radius:8px;padding:7px 10px;font:600 13px/1.4 system-ui,sans-serif;color:#fff;background:#4d7cfe;cursor:pointer">安装更新并重启</button>'+
      '<button class="dshut-close" aria-label="关闭" style="position:absolute;top:7px;right:9px;border:0;background:none;color:#fff;opacity:.65;cursor:pointer;font-size:16px;line-height:1">×</button>';
    document.body.appendChild(el);
    el.querySelector('.dshut-close').onclick=function(){var e=document.getElementById(ID); if(e) e.remove();};
    var ib=el.querySelector('.dshut-install');
    ib.onclick=function(){var d=window.dshDesktop; if(d&&typeof d.installUpdate==='function') d.installUpdate();};
  }
  // 闭包绑定到本卡片元素：两张卡片同时存在时不会互相写错
  var apply=function(p,d,u){
    var de=el.querySelector('.dshut-detail'); if(typeof d==='string'&&d) de.textContent=d;
    var ue=el.querySelector('.dshut-url'); if(typeof u==='string'&&u){ ue.textContent='下载地址：'+u; ue.style.display='block'; }
    var bar=el.querySelector('.dshut-bar'); var n=typeof p==='number'&&Number.isFinite(p);
    if(n) bar.style.width=Math.max(0,Math.min(100,p))+'%';
  };
  window.__dshUpdate=apply;
  apply(pct,detail,url);
}`

  const DEFAULT_TOAST_ID = 'dsh-update-toast'
  const sendToast = (id: string, pct: number | null, detail: string, url?: string | null): void => {
    if (win.isDestroyed()) return
    const code = `(${UPDATE_TOAST})(...${JSON.stringify([id, pct, detail, url ?? null])})`
    void win.webContents.executeJavaScript(code).catch(() => {})
  }

  const showUpdateOverlay = (
    init: { pct?: number | null; detail: string; url?: string | null },
    id: string = DEFAULT_TOAST_ID,
  ): ((p: { pct: number | null; detail: string; url?: string | null }) => void) => {
    if (win.isDestroyed()) return () => undefined
    const setTaskbar = (pct: number | null): void => {
      try {
        if (typeof pct === 'number' && Number.isFinite(pct)) win.setProgressBar(Math.max(0, Math.min(1, pct / 100)))
        else win.setProgressBar(-1)
      } catch {
        /* ignore */
      }
    }
    setTaskbar(typeof init.pct === 'number' ? init.pct : null)
    sendToast(id, init.pct ?? null, init.detail, init.url)
    const setter = (p: { pct: number | null; detail: string; url?: string | null }): void => {
      if (win.isDestroyed()) return
      setTaskbar(p.pct)
      sendToast(id, p.pct, p.detail, p.url)
    }
    return setter
  }

  /** 显示/隐藏「安装更新并重启」按钮（下载完成后调用）。 */
  const setUpdateInstallButton = (show: boolean, id: string = DEFAULT_TOAST_ID): void => {
    if (win.isDestroyed()) return
    const code = `(()=>{var b=document.getElementById(${JSON.stringify(id)}); if(b){var s=b.querySelector('.dshut-install'); if(s) s.style.display='${show ? 'block' : 'none'}';}})()`
    void win.webContents.executeJavaScript(code).catch(() => {})
  }

  /** 移除更新卡片 + 清除任务栏进度。 */
  const hideUpdateOverlay = (id: string = DEFAULT_TOAST_ID): void => {
    if (win.isDestroyed()) return
    void win.webContents
      .executeJavaScript(`(()=>{var e=document.getElementById(${JSON.stringify(id)}); if(e) e.remove();})()`)
      .catch(() => {})
    try {
      win.setProgressBar(-1)
    } catch {
      /* ignore */
    }
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

  return { win, loadApp, showLoading, showError, showUpdateOverlay, hideUpdateOverlay, setUpdateInstallButton, updateTaskbarProgress }
}
