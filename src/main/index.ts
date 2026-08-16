/**
 * DSH Desktop 主进程入口：
 * 单实例 → 设置/日志 → 确保 desktop profile（同步 bridge）→ 定位运行时 → 生成 overlay →
 * 创建窗口/托盘 → spawn harness → 解析 URL/桥接行 → 加载 Web UI →
 * 桥接事件（徽标/通知，仅桌面原生部分）→ 全局快捷键 / dsh:// 深链 / 自动更新 →
 * 优雅停机。
 *
 * 架构（0.4.1）：壳只保留桌面原生能力；与 harness 之间仅通过 dsh-desktop-bridge
 * 插件通信（通知/徽标/深链/工作区注册），壳不注入任何 UI。
 */
import { app, dialog, shell } from 'electron'
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
import { initHarnessCheck, stopHarnessCheck, checkHarnessUpdate } from './harnessCheck'

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

let win: WindowHandle | null = null
let trayHandle: TrayHandle | null = null
let harness: HarnessManager
let bridge: BridgeClient
let settings: AppSettings
let settingsFile = ''
let quitting = false
let pendingRegisterWorkspace: string | null = null
let lastUrl: string | null = null
let runningJobs = 0
let pendingDeepLinks: DeepLinkAction[] = []

/* ── 既有基础设施 ───────────────────────────────────────────────────── */

/** macOS 冷启动时早于 ready 的 dsh:// 动作（ready 后处理）。 */
const openUrlQueue: DeepLinkAction[] = []

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

function uiReady(): boolean {
  const w = win?.win
  if (!w || w.isDestroyed()) return false
  return w.webContents.getURL().startsWith('http://127.0.0.1:')
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

/* ── 主流程 ──────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  initLogger(path.join(app.getPath('userData'), 'logs'))
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  settings = loadSettings(settingsFile)

  const token = randomBytes(16).toString('hex')
  const resourcesDir = appResourcesDir()

  // 先创建窗口并立即显示加载页，再准备运行时——
  // 首启解压运行时 tar.gz（约 200MB）耗时较长，若先 await 再建窗口，
  // 用户在任务管理器里只见进程、长时间看不到界面。
  win = createWindow(path.join(__dirname, '..', 'preload', 'index.cjs'), resourcesDir, {
    isAllowed: (url) => url.startsWith('http://127.0.0.1:') || url.startsWith('file://'),
    theme: resolveEffectiveTheme(dshHome()),
  })
  win.showLoading(undefined, resolveThemePreference(dshHome()))
  win.win.on('close', (e) => {
    if (settings.trayOnClose && !quitting) {
      e.preventDefault()
      win?.win.hide()
    }
  })

  // 确保 profile（同步 bridge 插件）与生成 overlay
  const profileDir = ensureProfile(dshHome(), path.join(resourcesDir, 'profile-template', 'desktop'), path.join(resourcesDir, 'plugins'))
  // 定位运行时（打包模式首启解压到本地目录；窗口与加载页已先行显示）。
  // 解压开始前更新加载页副标题，避免用户误以为卡死。
  const runtime = await resolveRuntime(() => {
    win?.showLoading('首次运行：正在解压运行时…', resolveThemePreference(dshHome()))
  })
  const overlayPath = writeOverlay(app.getPath('userData'), token)

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
        win?.loadApp(r.url)
        bridge.connect()
        refreshTray()
        // UI 加载完成后处理启动时排队的深链
        setTimeout(() => flushPendingDeepLinks(), 2500)
      },
      onExit: ({ code, signal, willRestart }) => {
        log('info', `harness exited code=${code} signal=${String(signal)} willRestart=${willRestart}`)
        if (willRestart) {
          win?.showLoading('Harness 异常退出，正在自动重启…', resolveThemePreference(dshHome()))
        }
        refreshTray()
      },
      onLog: (stream, line) => {
        log(stream === 'stdout' ? 'info' : 'error', `[harness:${stream}] ${line}`)
      },
      onState: (s) => {
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
        if (connected) {
          // 自检：验证 shell -> harness RPC 通路
          void bridge
            .call('ping')
            .then(() => log('info', 'bridge RPC self-test OK'))
            .catch((err) => log('error', `bridge RPC self-test failed: ${err instanceof Error ? err.message : String(err)}`))
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

  trayHandle = createTray(path.join(resourcesDir, 'icons', 'tray.png'), {
    getUrl: () => harness?.ready?.url ?? lastUrl,
    getState: () => ({
      autoStart: settings.autoStart,
      notifications: settings.notifications,
      runningJobs,
      harnessState: harness?.state === 'ready' ? '运行中' : harness?.state === 'starting' ? '启动中' : '已停止',
      globalShortcut: currentShortcut(),
    }),
    showWindow,
    openBrowser,
    pickWorkspace: () => void pickWorkspace(),
    restartHarness: () => {
      lastUrl = null
      harness.restart()
    },
    openLogs: () => void shell.openPath(logDirPath()),
    // 两层检测：桌面端 + 官方 harness
    checkUpdate: () => {
      void checkNow(true)
      void checkHarnessUpdate().then((msg) => log('info', `harnessCheck: manual -> ${msg}`))
    },
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
    quit: () => app.quit(),
  })

  registerIpc({
    getWindow: () => win?.win ?? null,
    harness,
    bridge,
    pickWorkspace,
    restartHarness: () => {
      lastUrl = null
      harness.restart()
    },
    getInfo: currentInfo,
    openSession: (sessionId) => handleDeepLink({ kind: 'session', sessionId }),
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
  // 第 2 层：官方 harness 更新检测（只提示，不自动替换）
  initHarnessCheck()

  app.on('second-instance', (_e, argv) => {
    consumeDeepLinkArgv(argv)
    showWindow()
  })

  // macOS：dsh:// 协议经 open-url 事件拉起（热启动）；冷启动时事件先于 ready，
  // 由本模块顶部收集、就绪后处理（见下方 openUrlQueue）。
  if (process.platform === 'darwin') {
    app.on('open-url', (e, url) => {
      e.preventDefault()
      const action = parseDeepLink(url)
      if (action) {
        if (app.isReady()) void handleDeepLink(action)
        else openUrlQueue.push(action)
      }
    })
    // Dock 点击重新聚焦（无窗口时）
    app.on('activate', () => showWindow())
  }

  // 通过 dsh:// 协议冷启动时，URL 出现在首个实例的 argv 中
  consumeDeepLinkArgv(process.argv)

  // macOS 冷启动队列：ready 后统一处理（与 flushPendingDeepLinks 同时序）
  const queuedMac = openUrlQueue.splice(0)
  if (queuedMac.length > 0) {
    setTimeout(() => {
      for (const action of queuedMac) void handleDeepLink(action)
    }, 1500)
  }

  harness.start()
}

app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  log('info', 'quitting: stopping harness')
  unregisterAllShortcuts()
  stopHarnessCheck()
  bridge?.stop()
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
