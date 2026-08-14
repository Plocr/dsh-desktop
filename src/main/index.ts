/**
 * DSH Desktop 主进程入口：
 * 单实例 → 设置/日志 → 确保 desktop profile → 定位运行时 → 生成 overlay →
 * 创建窗口/托盘 → spawn harness → 解析 URL/桥接行 → 加载 Web UI →
 * 桥接事件（徽标/通知/仪表盘）→ 全局快捷键 / dsh:// 深链 / 自动更新 →
 * 面板注入（右栏仪表盘 + 底栏终端）→ 优雅停机。
 */
import { app, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { initLogger, log, logDirPath } from './logger'
import { loadSettings, saveSettings, type AppSettings } from './settings'
import { appResourcesDir, ensureProfile, resolveRuntime, writeOverlay } from './runtime'
import { HarnessManager, type HarnessReady } from './harness'
import { BridgeClient } from './bridge'
import { createWindow, type WindowHandle } from './window'
import { resolveEffectiveTheme, resolveThemePreference } from './theme'
import { createTray, type TrayHandle } from './tray'
import { notify, setBadge } from './notify'
import { handleBridgeEvent, runningJobCount } from './bridgeEvents'
import { registerIpc } from './ipc'
import { parseDeepLink, extractDeepLinkFromArgv, type DeepLinkAction } from './deepLink'
import { registerGlobalShortcut, currentShortcut, unregisterAllShortcuts } from './shortcut'
import { initUpdater, checkNow } from './updater'
import { injectChrome } from './chrome'
import { createDashboardState } from './dashboard'
import { createTerminalManager, type TermManager } from './terminal'
import { resolveShellSpec } from './termShell'
import type { DashLayout, DashLogLine } from '../shared/types'

// dev 模式与已安装版隔离 userData（app 名解析为 productName → 默认同名目录，
// 已安装版运行中时 dev 会因单实例锁冲突直接退出；隔离后两者可并行）
if (process.defaultApp) {
  app.setPath('userData', path.join(app.getPath('appData'), 'dsh-desktop-dev'))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 第二个实例：立即退出（app.exit 不走 before-quit/whenReady，避免 main() 半途执行）
  app.exit(0)
}

app.setAppUserModelId('com.dsh.desktop.workbench')

// 本地地址绕过系统代理（electron-updater/Chromium net 走系统代理时会劫持 127.0.0.1 请求）
app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1;localhost;<local>')

// 【调试】验证导航黑帧是否由深色系统占位背景引起
if (process.env.DSH_DEBUG_THEME_SOURCE) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { nativeTheme } = require('electron') as typeof import('electron')
  nativeTheme.themeSource = process.env.DSH_DEBUG_THEME_SOURCE as 'light' | 'dark'
}

let win: WindowHandle | null = null
let trayHandle: TrayHandle | null = null
let harness: HarnessManager
let bridge: BridgeClient
let terminal: TermManager
let settings: AppSettings
let settingsFile = ''
let quitting = false
let pendingRegisterWorkspace: string | null = null
let lastUrl: string | null = null
let runningJobs = 0
let pendingDeepLinks: DeepLinkAction[] = []

/* ── 仪表盘状态与推送 ────────────────────────────────────────────────── */

const dash = createDashboardState()
let dashPushTimer: NodeJS.Timeout | null = null
let logQueue: DashLogLine[] = []
let logPushTimer: NodeJS.Timeout | null = null

function panelLayout(): DashLayout {
  return {
    sidebar: settings.sidebar.enabled,
    term: settings.terminal.enabled,
    sidebarWidth: settings.sidebar.width,
    termHeight: settings.terminal.height,
  }
}

function uiReady(): boolean {
  const w = win?.win
  if (!w || w.isDestroyed()) return false
  return w.webContents.getURL().startsWith('http://127.0.0.1:')
}

/** 节流推送仪表盘快照（仅 harness 页接收）。 */
function pushDash(): void {
  if (dashPushTimer) return
  dashPushTimer = setTimeout(() => {
    dashPushTimer = null
    if (!uiReady()) return
    const w = win?.win
    if (!w || w.isDestroyed()) return
    w.webContents.send('dsh:dash:state', dash.toSnapshot())
  }, 200)
}

/** 批量推送日志行（300ms 批）。 */
function pushLogs(): void {
  if (logPushTimer) return
  logPushTimer = setTimeout(() => {
    logPushTimer = null
    if (logQueue.length === 0 || !uiReady()) return
    const w = win?.win
    if (!w || w.isDestroyed()) return
    const batch = logQueue
    logQueue = []
    w.webContents.send('dsh:dash:log', { sync: false, lines: batch })
  }, 300)
}

/** 面板 hello：补发全量基线（state/layout/日志）——面板 boot 可能晚于 dom-ready 推送。 */
function sendPanelBaseline(): void {
  if (!uiReady()) return
  const w = win?.win
  if (!w || w.isDestroyed()) return
  w.webContents.send('dsh:dash:state', dash.toSnapshot())
  w.webContents.send('dsh:dash:layout', panelLayout())
  const lines = dash.logs.all
  if (lines.length > 0) w.webContents.send('dsh:dash:log', { sync: true, lines })
}

/** 拉取 DeepSeek 账户余额（bridge RPC，key 不出 harness 进程）。 */
function refreshBalance(): void {
  if (!bridge) return
  void bridge
    .call('billing.balance', undefined, 15_000)
    .then((res) => {
      dash.mergeBalance(res)
      log('info', `balance fetched: ${JSON.stringify(res).slice(0, 200)}`)
      pushDash()
    })
    .catch((err) => {
      dash.mergeBalance({ isAvailable: false, infos: [], fetchedAt: Date.now(), error: err instanceof Error ? err.message : String(err) })
      log('error', `balance fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      pushDash()
    })
}

/** 推送布局状态（面板开合/尺寸）。 */
function pushLayout(): void {
  if (!uiReady()) return
  win?.win.webContents.send('dsh:dash:layout', panelLayout())
}

/** 面板动作：开合/尺寸 → 设置持久化 + 布局推送 + 托盘刷新。 */
function toggleSidebar(): void {
  settings.sidebar.enabled = !settings.sidebar.enabled
  saveSettings(settingsFile, settings)
  pushLayout()
  refreshTray()
}

function toggleTerminal(): void {
  settings.terminal.enabled = !settings.terminal.enabled
  saveSettings(settingsFile, settings)
  pushLayout()
  refreshTray()
}

function setSidebarWidth(w: number): void {
  settings.sidebar.width = w
  saveSettings(settingsFile, settings)
  pushLayout()
}

function setTerminalHeight(h: number): void {
  settings.terminal.height = h
  saveSettings(settingsFile, settings)
  pushLayout()
}

/* ── 既有基础设施 ───────────────────────────────────────────────────── */

function dshHome(): string {
  return settings.isolatedHome ? path.join(app.getPath('userData'), 'dsh-home') : path.join(os.homedir(), '.dsh')
}

function defaultWorkspace(): string {
  const recent = settings.recentWorkspaces.filter((w) => existsSync(w))
  return recent[0] ?? os.homedir()
}

function refreshTray(): void {
  trayHandle?.refresh()
}

function showWindow(): void {
  if (!win) return
  const w = win.win
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

function openBrowser(): void {
  const url = harness.ready?.url ?? lastUrl
  if (url) void shell.openExternal(url)
}

function currentInfo(): unknown {
  return {
    version: app.getVersion(),
    harnessState: harness?.state ?? 'stopped',
    url: harness?.ready?.url ?? lastUrl,
    dshHome: dshHome(),
    cwd: harness?.cwd ?? null,
    runningJobs,
    appData: app.getPath('userData'),
    logsDir: logDirPath(),
    globalShortcut: currentShortcut(),
    panel: panelLayout(),
    terminalBackend: terminal?.backend ?? null,
    terminalShell: terminal?.activeLabel ?? null,
    terminalSessions: terminal?.sessions.length ?? 0,
  }
}

/** 独立窗口打开系统终端（管道模式无 TTY 的逃生口；detached + 新控制台窗口）。 */
function openSystemTerminal(): void {
  const spec = terminal?.activeShell ?? resolveShellSpec('auto')
  if (!spec) return
  try {
    const child = spawn(spec.cmd, spec.args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    log('info', `system terminal opened: ${spec.cmd} ${spec.args.join(' ')}`)
  } catch (err) {
    log('error', `system terminal failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function pickWorkspace(): Promise<string | null> {
  const w = win?.win ?? null
  const r = w
    ? await dialog.showOpenDialog(w, { title: '选择工作区目录', properties: ['openDirectory', 'createDirectory'] })
    : await dialog.showOpenDialog({ title: '选择工作区目录', properties: ['openDirectory', 'createDirectory'] })
  if (r.canceled || !r.filePaths[0]) return null
  const dir = r.filePaths[0]
  settings.recentWorkspaces = [dir, ...settings.recentWorkspaces.filter((x) => x !== dir)].slice(0, 8)
  saveSettings(settingsFile, settings)
  pendingRegisterWorkspace = dir
  log('info', `switch workspace -> ${dir}`)
  harness.restart(dir)
  refreshTray()
  return dir
}

function handleBridgeEventWrapper(type: string, payload: unknown): void {
  if (type === 'job.done' || type === 'jobs.changed' || type === 'approval.asked') {
    log('info', `bridge event: ${type} ${JSON.stringify(payload).slice(0, 300)}`)
  }
  handleBridgeEvent(
    type,
    payload,
    { notifications: settings.notifications },
    {
      notify: (title, body) => notify(title, body, () => showWindow()),
      setBadge,
    },
  )
  if (type === 'jobs.changed') {
    const jobs = ((payload as { jobs?: unknown[] } | undefined)?.jobs) ?? []
    runningJobs = runningJobCount(jobs)
    refreshTray()
  }
  // 仪表盘增量更新
  dash.applyBridgeEvent(type, payload)
  pushDash()
}

/* ── dsh:// 深链 ─────────────────────────────────────────────────────── */

/** 注册 dsh:// 协议（Windows/Linux 注册表；macOS 走 open-url）。 */
function registerProtocol(): void {
  try {
    if (process.defaultApp) {
      // 开发模式：注册到 electron 可执行文件，并带上应用目录（不能用 argv[1]，可能被启动参数占用）
      app.setAsDefaultProtocolClient('dsh', process.execPath, [app.getAppPath()])
    } else {
      app.setAsDefaultProtocolClient('dsh')
    }
    log('info', 'dsh:// protocol registered')
  } catch (err) {
    log('error', `protocol registration failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 在侧边栏按匹配器点击一行（React 合成事件可被冒泡 click 触发）。 */
async function clickSidebarRow(matcherJs: string): Promise<boolean> {
  const w = win?.win
  if (!w || w.isDestroyed() || !uiReady()) return false
  try {
    const clicked = await w.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('[role=treeitem]')];
      const target = rows.find((el) => ${matcherJs});
      if (!target) return false;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    })()`)
    return clicked === true
  } catch (err) {
    log('error', `sidebar click failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** 展开侧边栏折叠的会话区（"展开其余 N 个会话"按钮）。 */
async function expandOverflowSessions(): Promise<void> {
  const w = win?.win
  if (!w || w.isDestroyed() || !uiReady()) return
  try {
    await w.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('展开其余'));
      if (btn) { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return true; }
      return false;
    })()`)
  } catch {
    /* ignore */
  }
}

/** 处理一条深链：聚焦窗口 + 尽力导航（新会话/指定会话）。 */
async function handleDeepLink(action: DeepLinkAction): Promise<void> {
  log('info', `deep link: ${JSON.stringify(action)}`)
  showWindow()
  if (action.kind === 'focus') return
  if (!uiReady()) {
    pendingDeepLinks.push(action)
    return
  }
  if (action.kind === 'new') {
    await clickSidebarRow(`(el.textContent || '').trim() === '新会话'`)
    return
  }
  if (action.kind === 'session' && action.sessionId) {
    let title: unknown = null
    try {
      const res = (await bridge.call('session.resolve', { id: action.sessionId }, 8000)) as { title?: unknown }
      title = res?.title
    } catch (err) {
      log('error', `session.resolve failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (typeof title === 'string' && title) {
      await expandOverflowSessions()
      await new Promise((r) => setTimeout(r, 500))
      const ok = await clickSidebarRow(`(el.textContent || '').trim().startsWith(${JSON.stringify(title)})`)
      if (!ok) log('info', `session row not found in sidebar: ${title}`)
    } else {
      log('info', `session title unavailable (${String(action.sessionId)}); focusing only`)
    }
  }
}

/** 处理启动 argv / 二次实例携带的深链。 */
function consumeDeepLinkArgv(argv: string[]): void {
  const url = extractDeepLinkFromArgv(argv)
  if (!url) return
  const action = parseDeepLink(url)
  if (action) void handleDeepLink(action)
}

/** 处理排队中的深链（UI 就绪后调用）。 */
function flushPendingDeepLinks(): void {
  if (!uiReady() || pendingDeepLinks.length === 0) return
  const queued = pendingDeepLinks
  pendingDeepLinks = []
  // 等 React 渲染完成再点击
  setTimeout(() => {
    for (const action of queued) void handleDeepLink(action)
  }, 1500)
}

/* ── 窗口内快捷键（面板开关，非全局） ───────────────────────────────── */

function acceleratorParts(acc: string): { mods: Set<string>; key: string } {
  const parts = acc.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)
  const key = parts.pop() ?? ''
  return { mods: new Set(parts), key }
}

function matchAccelerator(
  acc: string,
  input: { type: string; key?: string; control?: boolean; shift?: boolean; alt?: boolean },
): boolean {
  if (input.type !== 'keyDown') return false
  const { mods, key } = acceleratorParts(acc)
  const wantCtrl = mods.has('control') || mods.has('commandorcontrol')
  const wantShift = mods.has('shift')
  const wantAlt = mods.has('alt')
  if (wantCtrl !== !!input.control) return false
  if (wantShift !== !!input.shift) return false
  if (wantAlt !== !!input.alt) return false
  const k = (input.key || '').toLowerCase()
  if (k !== key) {
    // 兼容不同键盘布局下的符号键别名
    const alias: Record<string, string> = { '`': 'backquote', '~': 'backquote', '.': 'period', '>': 'period' }
    if (alias[k] !== key && alias[key] !== k) return false
  }
  return true
}

function installPanelShortcuts(): void {
  const w = win?.win
  if (!w) return
  w.webContents.on('before-input-event', (event, input) => {
    if (!uiReady()) return
    const st = settings.panelShortcuts
    if (st.terminal && matchAccelerator(st.terminal, input)) {
      event.preventDefault()
      toggleTerminal()
      return
    }
    if (st.sidebar && matchAccelerator(st.sidebar, input)) {
      event.preventDefault()
      toggleSidebar()
    }
  })
}

/* ── 主流程 ──────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  initLogger(path.join(app.getPath('userData'), 'logs'))
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  settings = loadSettings(settingsFile)

  const token = randomBytes(16).toString('hex')
  const overlayPath = writeOverlay(app.getPath('userData'), token)
  const resourcesDir = appResourcesDir()

  win = createWindow(path.join(__dirname, '..', 'preload', 'index.cjs'), resourcesDir, {
    isAllowed: (url) => url.startsWith('http://127.0.0.1:') || url.startsWith('file://'),
    theme: resolveEffectiveTheme(dshHome()),
    onDomReady: (w) => {
      injectChrome(w)
      // 面板就绪前补发最新状态/布局（panel 订阅早于 hello）
      const url = w.webContents.getURL()
      if (url.startsWith('http://127.0.0.1:')) {
        setTimeout(() => {
          w.webContents.send('dsh:dash:state', dash.toSnapshot())
          w.webContents.send('dsh:dash:layout', panelLayout())
        }, 400)
      }
    },
  })
  win.showLoading(undefined, resolveThemePreference(dshHome()))
  installPanelShortcuts()
  win.win.on('close', (e) => {
    if (settings.trayOnClose && !quitting) {
      e.preventDefault()
      win?.win.hide()
    }
  })

  // profile 确保 + 运行时定位（打包模式含首次解压，窗口此时显示 loading 页）
  const profileDir = ensureProfile(dshHome(), path.join(resourcesDir, 'profile-template', 'desktop'), path.join(resourcesDir, 'bridge'))
  const runtime = await resolveRuntime()

  harness = new HarnessManager(
    {
      node: runtime.node,
      bin: runtime.bin,
      dshHome: dshHome(),
      profile: profileDir,
      overlay: overlayPath,
      cwd: defaultWorkspace(),
    },
    {
      onReady: (r: HarnessReady) => {
        lastUrl = r.url
        log('info', `harness ready: ${r.url} bridgePort=${r.bridgePort}`)
        dash.state.readyUrl = r.url
        win?.loadApp(r.url)
        bridge.connect()
        refreshTray()
        // UI 加载完成后处理启动时排队的深链
        setTimeout(() => flushPendingDeepLinks(), 2500)
      },
      onExit: ({ code, willRestart }) => {
        dash.state.readyUrl = null
        if (willRestart) {
          win?.showLoading('Harness 异常退出，正在自动重启…', resolveThemePreference(dshHome()))
        }
        refreshTray()
      },
      onLog: (stream, line) => {
        log(stream === 'stdout' ? 'info' : 'error', `[harness:${stream}] ${line}`)
        dash.applyHarnessLog(stream, line)
        pushLogs()
      },
      onState: (s) => {
        dash.applyHarnessState(s)
        pushDash()
        if (s === 'starting') {
          if (!lastUrl) win?.showLoading(undefined, resolveThemePreference(dshHome()))
        }
        refreshTray()
      },
    },
  )

  bridge = new BridgeClient(
    () => {
      const r = harness.ready
      return r?.bridgePort != null && r.token ? { port: r.bridgePort, token: r.token } : null
    },
    {
      onEvent: handleBridgeEventWrapper,
      onConnected: (connected) => {
        dash.setBridge(connected)
        pushDash()
        if (connected) {
          // 自检：验证 shell -> harness RPC 通路
          void bridge
            .call('ping')
            .then(() => log('info', 'bridge RPC self-test OK'))
            .catch((err) => log('error', `bridge RPC self-test failed: ${err instanceof Error ? err.message : String(err)}`))
          // 拉取仪表盘全量快照（之后靠事件增量）
          void bridge
            .call('dashboard.snapshot', undefined, 10_000)
            .then((snap) => {
              dash.mergeSnapshot(snap)
              pushDash()
            })
            .catch((err) => log('error', `dashboard.snapshot failed: ${err instanceof Error ? err.message : String(err)}`))
          // 拉取账户余额（异步，不阻塞 ready）
          refreshBalance()
          if (pendingRegisterWorkspace) {
            const dir = pendingRegisterWorkspace
            pendingRegisterWorkspace = null
            void bridge
              .call('workspace.register', { path: dir })
              .then(() => log('info', `workspace registered: ${dir}`))
              .catch((err) => log('error', `workspace register failed: ${err instanceof Error ? err.message : String(err)}`))
          }
        }
      },
    },
  )

  terminal = createTerminalManager(
    {
      onData: (sessionId, data) => {
        if (uiReady()) win?.win.webContents.send('dsh:term:data', { id: sessionId, data })
      },
      onExit: (sessionId, info) => {
        if (uiReady()) win?.win.webContents.send('dsh:term:exit', { id: sessionId, code: info.code })
      },
      onCreated: (sessionId, info) => {
        if (uiReady()) win?.win.webContents.send('dsh:term:created', { id: sessionId, ...info })
      },
      onClosed: (sessionId) => {
        if (uiReady()) win?.win.webContents.send('dsh:term:closed', sessionId)
      },
      onActive: (sessionId) => {
        if (uiReady()) win?.win.webContents.send('dsh:term:active', sessionId)
      },
    },
    () => harness?.cwd ?? defaultWorkspace(),
  )

  trayHandle = createTray(path.join(resourcesDir, 'icons', 'tray.png'), {
    getUrl: () => harness?.ready?.url ?? lastUrl,
    getState: () => ({
      autoStart: settings.autoStart,
      notifications: settings.notifications,
      runningJobs,
      harnessState:
        harness?.state === 'ready' ? '运行中' : harness?.state === 'starting' ? '启动中' : '已停止',
      globalShortcut: currentShortcut(),
      panel: panelLayout(),
    }),
    showWindow,
    openBrowser,
    pickWorkspace: () => void pickWorkspace(),
    restartHarness: () => {
      lastUrl = null
      harness.restart()
    },
    openLogs: () => void shell.openPath(logDirPath()),
    checkUpdate: () => void checkNow(true),
    setAutoStart: (v) => {
      settings.autoStart = v
      saveSettings(settingsFile, settings)
      app.setLoginItemSettings({ openAtLogin: v })
      refreshTray()
    },
    setNotifications: (v) => {
      settings.notifications = v
      saveSettings(settingsFile, settings)
      refreshTray()
    },
    setPanel: (kind, v) => {
      if (kind === 'sidebar') settings.sidebar.enabled = v
      else settings.terminal.enabled = v
      saveSettings(settingsFile, settings)
      pushLayout()
      refreshTray()
    },
    quit: () => app.quit(),
  })

  registerIpc({
    getWindow: () => win?.win ?? null,
    harness,
    bridge,
    terminal,
    pickWorkspace,
    restartHarness: () => {
      lastUrl = null
      harness.restart()
    },
    getInfo: currentInfo,
    openSession: (sessionId) => handleDeepLink({ kind: 'session', sessionId }),
    toggleSidebar,
    toggleTerminal,
    setSidebarWidth,
    setTerminalHeight,
    sendPanelBaseline,
    openSystemTerminal,
    refreshBalance,
  })

  // dsh:// 协议 + 全局快捷键 + 自动更新
  registerProtocol()
  registerGlobalShortcut(settings.globalShortcut, () => showWindow())
  initUpdater(
    {
      onManualResult: (msg) => notify('检查更新', msg, () => showWindow()),
    },
    { autoCheck: settings.autoUpdate },
  )

  app.on('second-instance', (_e, argv) => {
    consumeDeepLinkArgv(argv)
    showWindow()
  })

  // 通过 dsh:// 协议冷启动时，URL 出现在首个实例的 argv 中
  consumeDeepLinkArgv(process.argv)

  harness.start()
}

app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  log('info', 'quitting: stopping harness')
  unregisterAllShortcuts()
  bridge?.stop()
  terminal?.close()
  void harness
    ?.stop()
    .catch((err) => log('error', `stop failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  // 托盘常驻：不因窗口关闭而退出
})

app
  .whenReady()
  .then(() => main())
  .catch((err) => {
    log('error', `main failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    dialog.showErrorBox('DSH Desktop', `启动失败：\n${err instanceof Error ? err.message : String(err)}\n\n详见日志：${logDirPath()}`)
    app.exit(1)
  })
