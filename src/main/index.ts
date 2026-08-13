/**
 * DSH Desktop 主进程入口：
 * 单实例 → 设置/日志 → 确保 desktop profile → 定位运行时 → 生成 overlay →
 * 创建窗口/托盘 → spawn harness → 解析 URL/桥接行 → 加载 Web UI →
 * 桥接事件（徽标/通知）→ 优雅停机。
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
import { createTray, type TrayHandle } from './tray'
import { notify, setBadge } from './notify'
import { handleBridgeEvent, runningJobCount } from './bridgeEvents'
import { registerIpc } from './ipc'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.setAppUserModelId('com.dsh.desktop.workbench')

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

async function main(): Promise<void> {
  initLogger(path.join(app.getPath('userData'), 'logs'))
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  settings = loadSettings(settingsFile)

  const token = randomBytes(16).toString('hex')
  const overlayPath = writeOverlay(app.getPath('userData'), token)
  const resourcesDir = appResourcesDir()

  win = createWindow(path.join(__dirname, '..', 'preload', 'index.cjs'), resourcesDir, {
    isAllowed: (url) => url.startsWith('http://127.0.0.1:') || url.startsWith('file://'),
  })
  win.showLoading()
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
        win?.loadApp(r.url)
        bridge.connect()
        refreshTray()
      },
      onExit: ({ code, willRestart }) => {
        if (willRestart) {
          win?.showLoading('Harness 异常退出，正在自动重启…')
        }
        refreshTray()
      },
      onLog: (stream, line) => log(stream === 'stdout' ? 'info' : 'error', `[harness:${stream}] ${line}`),
      onState: (s) => {
        if (s === 'starting') {
          if (!lastUrl) win?.showLoading()
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
      harnessState:
        harness?.state === 'ready' ? '运行中' : harness?.state === 'starting' ? '启动中' : '已停止',
    }),
    showWindow,
    openBrowser,
    pickWorkspace: () => void pickWorkspace(),
    restartHarness: () => {
      lastUrl = null
      harness.restart()
    },
    openLogs: () => void shell.openPath(logDirPath()),
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
  })

  app.on('second-instance', () => {
    showWindow()
  })

  harness.start()
}

app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  log('info', 'quitting: stopping harness')
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
