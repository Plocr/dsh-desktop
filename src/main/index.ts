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
import { app, clipboard, dialog, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { initLogger, log, logDirPath } from './logger'
import { loadSettings, saveSettings, type AppSettings } from './settings'
import { appResourcesDir, ensureProfile, resolveRuntime, writeOverlay, listDesktopPlugins } from './runtime'
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
import { initUpdater, checkNow, type UpdateProgress } from './updater'
import { runHarnessUpdate, type HarnessProgress } from './harnessUpdate'
import { readLocalDshVersion } from './harnessCheck'
import { createLanProxy } from './lanServer'
import { cleanLogs, uninstallApp } from './maintenance'

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

// 主进程兜底：任何未捕获异常/拒绝只记日志，绝不弹「A JavaScript error occurred…」崩溃框
// 卡死（那种情况托盘点不开、只能任务管理器强杀）。局域网代理等任何一处漏处理都不应整机崩。
process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
  try {
    log('error', `uncaughtException: ${msg}`)
  } catch {
    /* ignore */
  }
})
process.on('unhandledRejection', (reason) => {
  try {
    log('error', `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
  } catch {
    /* ignore */
  }
})

// 本地地址绕过系统代理（electron-updater/Chromium net 走系统代理时会劫持 127.0.0.1 请求）
app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1;localhost;<local>')

let win: WindowHandle | null = null
let trayHandle: TrayHandle | null = null
let harness: HarnessManager
let bridge: BridgeClient
let settings: AppSettings
let settingsFile = ''
let quitting = false
/** 当前「官方 Harness」（DeepSeek Harness @deepseek-ai/dsh）版本，供托盘菜单展示；用户自更新后同步刷新。 */
let harnessVersion: string | null = null
let pendingRegisterWorkspace: string | null = null
let lastUrl: string | null = null
let runningJobs = 0
let pendingDeepLinks: DeepLinkAction[] = []
let overlayPath = ''
let launchToken = ''
/** dsh CLI 入口（runtime.bin），供插件管理器执行 dsh plugin 命令。 */
let dshCliPath = ''

/* ── 既有基础设施 ───────────────────────────────────────────────────── */

/** macOS 冷启动时早于 ready 的 dsh:// 动作（ready 后处理）。 */
const openUrlQueue: DeepLinkAction[] = []

function dshHome(): string {
  return settings.isolatedHome ? path.join(app.getPath('userData'), 'dsh-home') : path.join(os.homedir(), '.dsh')
}

/** 递归复制目录（跳过 .git/node_modules/.bin 等）。 */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    if (entry === '.git' || entry === 'node_modules' || entry === '.bin') continue
    const s = path.join(src, entry)
    const d = path.join(dest, entry)
    let isDir = false
    try {
      isDir = statSync(s).isDirectory()
    } catch {
      continue
    }
    if (isDir) copyDirRecursive(s, d)
    else if (!existsSync(d)) copyFileSync(s, d)
  }
}

/**
 * 确保使用独立 DSH_HOME（与 web 版/CLI 共享 ~/.dsh 会并发冲突）。
 * - 若 settings 仍为共享模式（老版本默认 false），自动切换为隔离并迁移数据
 * - 首次切换到隔离 home 时，把旧 ~/.dsh 的桌面端数据迁移过去：
 *   profiles/desktop（含插件同步、会话历史）、sessions、storages、
 *   .credentials.yaml、settings.yaml。已存在则不覆盖（幂等）。
 */
function migrateToIsolatedHome(): void {
  const isolated = path.join(app.getPath('userData'), 'dsh-home')
  const legacy = path.join(os.homedir(), '.dsh')
  const legacyExists = existsSync(legacy)
  // 老版本默认共享模式：若检测到 ~/.dsh 存在（说明在与其他实例共用），
  // 自动切换隔离并迁移，解决共存冲突
  if (!settings.isolatedHome) {
    if (!legacyExists) {
      settings.isolatedHome = true
      saveSettings(settingsFile, settings)
      log('info', 'isolatedHome enabled (no legacy ~/.dsh)')
      return
    }
    settings.isolatedHome = true
    saveSettings(settingsFile, settings)
    log('info', 'switched to isolated DSH_HOME (legacy ~/.dsh detected)')
  }
  // 新 home 已初始化（有 profiles）则跳过
  if (existsSync(path.join(isolated, 'profiles'))) return
  if (!legacyExists) {
    mkdirSync(isolated, { recursive: true })
    return
  }
  log('info', `migrating legacy ~/.dsh -> ${isolated}`)
  try {
    copyDirRecursive(legacy, isolated)
    log('info', 'isolated DSH_HOME migration done')
  } catch (err) {
    log('error', `isolated DSH_HOME migration failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 依据当前设置重新生成 overlay（启停插件后重启 Harness 生效）。只含随包内置插件。 */
function regenerateOverlay(resourcesDir: string, token: string): string {
  const pluginsDir = path.join(resourcesDir, 'plugins')
  const enabled = listDesktopPlugins(pluginsDir, undefined).filter(
    (p) => p.name === 'dsh-desktop-bridge' || !settings.disabledPlugins.includes(p.name),
  )
  const rows = enabled.map((p) => ({ name: p.name }))
  const p = writeOverlay(app.getPath('userData'), token, rows)
  log('info', `overlay regenerated: ${rows.map((x) => x.name).join(', ') || '(none)'}`)
  return p
}

// ---- 局域网访问（壳内反向代理 + 电脑授权）----
/** 当前选定的局域网 IPv4（对外主地址）；null = 未开启或无非内部网卡。 */
let lanIp: string | null = null
/** 局域网访问地址（http://<lanIp>:<代理端口>），ready 后填充。 */
let lanUrl: string | null = null
/** 局域网反向代理句柄（关掉 LAN/退出时 stop）。 */
let lanHandle: import('./lanServer').LanProxyHandle | null = null
/** 当前代理转发的 harness web 端口（harness 重启随机端口变化 → 重建代理）。 */
let lanTargetPort: number | null = null
/** 授权弹窗串行锁（多设备同时来不叠弹窗）。 */
let lanApprovalLock = false

/** 本机全部可用局域网 IPv4（排除 internal/链路本地），best-first 排序。 */
function lanCandidates(): string[] {
  const list: string[] = []
  const ifaces = os.networkInterfaces()
  for (const l of Object.values(ifaces)) {
    for (const f of l ?? []) {
      if (f.family !== 'IPv4' || f.internal) continue
      const ip = f.address
      if (/^(169\.254\.|0\.)\./.test(ip) || /^0\.0\.0\.0$/.test(ip)) continue
      if (!list.includes(ip)) list.push(ip)
    }
  }
  // 优先级：192.168 > 10.x > 172.16-31 > 其它（常见虚拟网段排后）
  const rank = (ip: string): number =>
    /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3
  return list.sort((a, b) => rank(a) - rank(b))
}

/** 默认路由出口 IP（UDP connect 到公网 IP，OS 路由表选源地址，不发数据、断网也安全）。 */
function defaultRouteIp(): Promise<string | null> {
  return new Promise((resolve) => {
    let sock: import('node:dgram').Socket | null = null
    const t = setTimeout(() => {
      try {
        sock?.close()
      } catch {
        /* ignore */
      }
      resolve(null)
    }, 1500)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const dgram = require('node:dgram') as typeof import('node:dgram')
      sock = dgram.createSocket('udp4')
      const s = sock
      s.once('error', () => {
        clearTimeout(t)
        resolve(null)
      })
      s.connect(80, '8.8.8.8', () => {
        clearTimeout(t)
        const addr = s.address().address
        try {
          s.close()
        } catch {
          /* ignore */
        }
        resolve(addr && !addr.startsWith('0.') ? addr : null)
      })
    } catch {
      clearTimeout(t)
      resolve(null)
    }
  })
}

/** 选「对外主」局域网 IP：优先默认路由出口，否则按 192.168/10/172 优先级取候选。 */
async function resolveBestLanIp(): Promise<string | null> {
  const dr = await defaultRouteIp()
  if (dr) return dr
  return lanCandidates()[0] ?? null
}

/**
 * 局域网访问：不改变 harness 监听（保持 127.0.0.1，浏览器版/本机窗口不受影响）；
 * 把所有候选局域网 IP 加入 /api 信任围栏（--trusted-host，host-only，容忍任意端口），
 * 实际对外由壳起的反向代理 + 电脑授权负责。
 */
async function applyLanNetwork(): Promise<void> {
  lanIp = settings.lanShare ? await resolveBestLanIp() : null
  const trusted = settings.lanShare ? lanCandidates() : []
  harness?.setNetwork(undefined, trusted)
  if (settings.lanShare && trusted.length === 0) {
    log('error', 'lanShare: 未发现局域网 IPv4，无法对外提供访问')
  } else if (settings.lanShare && lanIp) {
    log('info', `lanShare: 主地址 ${lanIp}，候选 ${trusted.join(', ')} 加入信任围栏`)
  }
}

/** 依据当前状态启停局域网反向代理：转发到 127.0.0.1:<harnessPort>，首次访问需电脑授权。 */
async function manageLanProxy(harnessPort: number): Promise<void> {
  if (settings.lanShare && lanIp) {
    // 目标端口变化（harness 重启换了随机端口）→ 重建代理
    if (lanTargetPort !== harnessPort) {
      if (lanHandle) {
        await lanHandle.stop()
        lanHandle = null
      }
      lanTargetPort = harnessPort
    }
    if (!lanHandle) {
      lanHandle = await createLanProxy({
        targetHost: '127.0.0.1',
        targetPort: harnessPort,
        requestApproval: (ip) => promptLanApproval(ip),
      })
      lanUrl = `http://${lanIp}:${lanHandle.port}`
      log('info', `lanShare: proxy up -> ${lanUrl}（转发 127.0.0.1:${harnessPort}，需电脑授权）`)
    }
  } else {
    if (lanHandle) {
      await lanHandle.stop()
      lanHandle = null
    }
    lanTargetPort = null
    lanUrl = null
  }
  refreshTray()
}

/** 电脑授权：其它设备首次访问时弹确认框（无父窗口保证可见 + 通知提示 + 串行 + 失败即拒）。 */
async function promptLanApproval(ip: string): Promise<boolean> {
  try {
    // 串行：已有授权弹窗进行中 → 先拒绝后续设备，避免叠弹窗（它们下次再试即可）
    if (lanApprovalLock) return false
    lanApprovalLock = true
    // 先把窗口唤回前台，再发一条可见通知作为提示
    showWindow()
    if (settings.notifications) {
      notify('局域网访问授权', `设备 ${ip} 请求访问 DSH Desktop（点击已唤出授权框）`, () => showWindow())
    }
    const opts = {
      type: 'question' as const,
      buttons: ['允许访问', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      title: '局域网访问授权',
      message: `设备 ${ip} 正在请求访问 DSH Desktop`,
      detail:
        '允许后，该设备可在浏览器中打开本工作台（可读取文件、执行命令）。' +
        '仅本次运行生效，关闭局域网访问后清除。' +
        '\n提示：手机端「看起来像新页面」是正常的——在左上角/搜索里选择工作区（如 Dsh），即可看到与电脑一致的会话历史。',
      noLink: true,
    }
    // 无父窗口的任务栏对话框：窗口最小化/隐藏到托盘也能显示
    const r = await dialog.showMessageBox(opts)
    return r.response === 0
  } catch (err) {
    log('error', `lanShare: approval dialog error: ${err instanceof Error ? err.message : String(err)}`)
    return false // 弹窗异常 → 拒绝，绝不无限挂起
  } finally {
    lanApprovalLock = false
  }
}

/** 重启 Harness：先按当前设置重新同步插件并生成 overlay，再重启。 */
async function restartHarness(dir?: string): Promise<void> {
  try {
    await applyLanNetwork()
    const resourcesDir = appResourcesDir()
    // 同步 profile（插件启停后，profile node_modules 增删）+ 重生成 overlay
    ensureProfile(
      dshHome(),
      path.join(resourcesDir, 'profile-template', 'desktop'),
      path.join(resourcesDir, 'plugins'),
      undefined,
      settings.disabledPlugins,
    )
    overlayPath = regenerateOverlay(resourcesDir, launchToken || randomBytes(16).toString('hex'))
    lastUrl = null
    harness.restart(dir)
  } catch (err) {
    // 同步/生成失败不应导致 unhandled rejection：记日志并照常重启（旧 overlay 仍可用）
    log('error', `restartHarness prepare failed: ${err instanceof Error ? err.message : String(err)}`)
    lastUrl = null
    try {
      harness.restart(dir)
    } catch (err2) {
      log('error', `restartHarness spawn failed: ${err2 instanceof Error ? err2.message : String(err2)}`)
    }
  }
}

function defaultWorkspace(): string {
  const recent = settings.recentWorkspaces.filter((w) => existsSync(w))
  return recent[0] ?? os.homedir()
}

function refreshTray(): void {
  trayHandle?.refresh()
}

// ---- 本地更新反馈：右上角小卡片（进度条 + 下载地址）+ 任务栏进度 ----
type UpdateOverlayState = { pct: number | null; detail: string; url?: string | null }
let updateSink: ((p: UpdateOverlayState) => void) | null = null

/** 打开更新小卡片，返回可推送进度的更新函数（不导航、不占整页、可关闭）。 */
function beginUpdateOverlay(init: UpdateOverlayState): (p: UpdateOverlayState) => void {
  if (!win) return () => undefined
  const sink = win.showUpdateOverlay({ pct: init.pct, detail: init.detail, url: init.url })
  updateSink = sink
  return (p) => sink({ pct: p.pct, detail: p.detail, url: p.url })
}

/** 结束更新卡片：移除卡片并清除任务栏进度。 */
function endUpdateOverlay(): void {
  updateSink = null
  try {
    win?.hideUpdateOverlay()
  } catch {
    /* ignore */
  }
}

/** 刷新托盘显示的「官方 Harness 当前版本」（读已安装运行时，用户自更新后也准确）。 */
function refreshHarnessVersion(): void {
  void readLocalDshVersion()
    .then((v) => {
      if (v && v !== harnessVersion) {
        harnessVersion = v
        refreshTray()
      }
    })
    .catch(() => {})
}

/** 手动/自动提示时的「双版本」文案（框架 = DSH Desktop，官方 = DeepSeek Harness）。 */
function updateVersionLabel(): string {
  return `框架 v${app.getVersion()} · 官方 Harness v${harnessVersion ?? '—'}`
}

/**
 * 官方 Harness 更新：检测 → 下载（进度） → 替换 → 重启。
 * - 页面不被打断：进度是一条右上角小卡片（可关闭、可最小化）；任务栏同步进度。
 * - manual=false：冷启动自动检查；有新版则本地替换，已最新/失败静默（托盘常显版本）。
 * - manual=true：托盘「检查并更新…」；无论结果都明确回报（含框架+官方 Harness 版本）。
 */
async function doHarnessUpdate(manual: boolean): Promise<void> {
  const open = beginUpdateOverlay({ pct: 0, detail: '正在检查官方 Harness 更新…', url: null })
  const r = await runHarnessUpdate(false, {
    onProgress: (p: HarnessProgress) => open({ pct: p.pct, detail: p.detail, url: p.url }),
  })
  endUpdateOverlay()

  if (r.ok && r.updated) {
    // 更新已落地：刷新版本显示 → 通知 → 重启 harness 生效
    refreshHarnessVersion()
    notify('官方 Harness 更新完成', r.message, () => undefined)
    try {
      harness.restart()
    } catch (err) {
      log('error', `harnessUpdate: restart failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }
  if (manual) {
    // 手动检查：明确回报（已最新 / 失败），含框架 + 官方 Harness 当前版本
    const label = updateVersionLabel()
    if (r.ok) notify('检查并更新', `${r.message}（${label}）`, () => showWindow())
    else notify('检查并更新失败', `${r.message}（${label}）`, () => showWindow())
  } else {
    // 自动（冷启动）检查：只记日志，不打扰（托盘菜单已常显两个版本）
    log('info', `harnessUpdate(auto): ${r.message}（${updateVersionLabel()}）`)
  }
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
  void restartHarness(dir)
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
    const clicked = await execJsWithTimeout(w, `(() => {
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
    await execJsWithTimeout(w, `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('展开其余'));
      if (btn) { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return true; }
      return false;
    })()`)
  } catch {
    /* ignore */
  }
}

/** executeJavaScript 带超时保护（页面卡死时不挂死）。 */
function execJsWithTimeout(w: Electron.BrowserWindow, code: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('executeJavaScript 超时')), timeoutMs)
    w.webContents
      .executeJavaScript(code)
      .then((v) => {
        clearTimeout(t)
        resolve(v)
      })
      .catch((e) => {
        clearTimeout(t)
        reject(e)
      })
  })
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
  // 默认独立 DSH_HOME：首次切换时迁移旧 ~/.dsh 数据（与 web 版/CLI 共存不冲突）
  migrateToIsolatedHome()

  const token = randomBytes(16).toString('hex')
  launchToken = token
  const resourcesDir = appResourcesDir()

  // 先创建窗口并立即显示加载页，再准备运行时——
  // 首启解压运行时 tar.gz（约 200MB）耗时较长，若先 await 再建窗口，
  // 用户在任务管理器里只见进程、长时间看不到界面。
  win = createWindow(path.join(__dirname, '..', 'preload', 'index.cjs'), resourcesDir, {
    // 导航锁：file:// 壳页面 + 精确匹配已解析的 harness URL（host+port）。
    // 窗口只加载回环地址；局域网走壳的反向代理，不让窗口直接访问任意主机/端口。
    isAllowed: (url) => {
      if (url.startsWith('file://')) return true
      try {
        const u = new URL(url)
        if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return false
        const known = [lastUrl, harness?.ready?.url].filter((x): x is string => !!x)
        return known.some((k) => {
          try {
            return new URL(k).port === u.port
          } catch {
            return false
          }
        })
      } catch {
        return false
      }
    },
    theme: resolveEffectiveTheme(dshHome()),
  })
  win.showLoading(undefined, resolveThemePreference(dshHome()))
  win.win.on('close', (e) => {
    if (settings.trayOnClose && !quitting) {
      e.preventDefault()
      win?.win.hide()
    }
  })

  // 确保 profile（同步启用的插件）与生成 overlay
  const profileDir = ensureProfile(
    dshHome(),
    path.join(resourcesDir, 'profile-template', 'desktop'),
    path.join(resourcesDir, 'plugins'),
    undefined,
    settings.disabledPlugins,
  )
  // 定位运行时（打包模式首启解压到本地目录；窗口与加载页已先行显示）。
  // 解压开始前更新加载页副标题，避免用户误以为卡死。
  const runtime = await resolveRuntime(() => {
    win?.showLoading('首次运行：正在解压运行时…', resolveThemePreference(dshHome()))
  })
  dshCliPath = runtime.bin
  harnessVersion = runtime.dshVersion ?? null
  refreshHarnessVersion()
  overlayPath = regenerateOverlay(resourcesDir, token)

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
        // 本机窗口永远加载回环地址；局域网经壳的反向代理（manageLanProxy）对外
        const url = r.url
        lastUrl = url
        void manageLanProxy(r.port).then(() => {
          log('info', `harness ready: ${url} bridgePort=${r.bridgePort}${lanUrl ? ` lan=${lanUrl}` : ''}`)
          refreshTray()
        })
        win?.loadApp(url)
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

  // 局域网访问：harness 保持回环监听 + 把候选局域网 IP 加入信任围栏（start 前应用）
  await applyLanNetwork()

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
    getUrl: () => lanUrl ?? harness?.ready?.url ?? lastUrl,
    getState: () => ({
      autoStart: settings.autoStart,
      notifications: settings.notifications,
      autoUpdate: settings.autoUpdate,
      lanShare: settings.lanShare,
      lanUrl,
      runningJobs,
      harnessState: harness?.state === 'ready' ? '运行中' : harness?.state === 'starting' ? '启动中' : '已停止',
      globalShortcut: currentShortcut(),
      appVersion: app.getVersion(),
      harnessVersion,
    }),
    showWindow,
    openBrowser,
    pickWorkspace: () => void pickWorkspace(),
    getPlugins: () =>
      listDesktopPlugins(path.join(appResourcesDir(), 'plugins'), undefined).map((p) => ({
        name: p.name,
        enabled: p.name === 'dsh-desktop-bridge' || !settings.disabledPlugins.includes(p.name),
        locked: p.name === 'dsh-desktop-bridge',
      })),
    togglePlugin: (name, enabled) => {
      if (name === 'dsh-desktop-bridge') return
      if (enabled) settings.disabledPlugins = settings.disabledPlugins.filter((x) => x !== name)
      else if (!settings.disabledPlugins.includes(name)) settings.disabledPlugins.push(name)
      saveSettings(settingsFile, settings)
      refreshTray()
      void restartHarness()
    },
    restartHarness: () => void restartHarness(),
    openLogs: () => void shell.openPath(logDirPath()),
    cleanLogs: () => cleanLogs(),
    uninstall: () => uninstallApp(),
    // 手动「检查并更新…」：外壳 + 框架一起查，有新版就本地下载/替换（右上角小卡片进度）
    checkUpdate: () => {
      void checkNow(true)
      void doHarnessUpdate(true)
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
    setAutoUpdate: (v) => {
      settings.autoUpdate = v
      saveSettings(settingsFile, settings)
      refreshTray()
    },
    // 局域网访问开关：开启 → 重启 harness 加入信任围栏，ready 后台起反向代理（手机访问需电脑授权）；
    // 关闭 → 立即停代理并重启 harness。不改 harness 监听地址，本机 127.0.0.1 始终可用。
    setLanShare: (v) => {
      settings.lanShare = v
      saveSettings(settingsFile, settings)
      refreshTray()
      if (!v) {
        // 立刻断开对外：停止代理，避免未经授权仍可访问
        void (async () => {
          if (lanHandle) {
            await lanHandle.stop()
            lanHandle = null
          }
          lanUrl = null
          refreshTray()
        })()
      } else if (lanCandidates().length === 0) {
        notify('局域网访问已开启', '未发现局域网网卡 IPv4，无法对外提供服务。', () => showWindow())
      } else {
        notify('局域网访问已开启', '正在重启 harness 以开放局域网（手机/其它设备首次访问需在本机授权）。', () => showWindow())
      }
      void restartHarness()
    },
    // 复制局域网地址到剪贴板（供同网段设备浏览器打开）
    copyLanUrl: () => {
      if (!lanUrl) {
        notify('局域网访问', settings.lanShare ? '尚未就绪，稍后在托盘查看地址。' : '局域网访问未开启。', () => showWindow())
        return
      }
      void clipboard.writeText(lanUrl)
      notify('局域网地址已复制', lanUrl, () => showWindow())
    },
    quit: () => app.quit(),
  })

  registerIpc({
    getWindow: () => win?.win ?? null,
    harness,
    bridge,
    pickWorkspace,
    restartHarness: () => void restartHarness(),
    getInfo: currentInfo,
    openSession: (sessionId) => handleDeepLink({ kind: 'session', sessionId }),
  })

  // dsh:// 协议 + 全局快捷键 + 自动更新
  registerProtocol()
  registerGlobalShortcut(settings.globalShortcut, () => showWindow())
  initUpdater(
    {
      onManualResult: (msg) => notify('检查更新', msg, () => showWindow()),
      // 外壳有新版：本地开始下载；通知附官方 + 加速两个下载地址（不打断当前界面）
      onAvailable: (info) => {
        notify(
          '发现新版本（本地下载中）',
          `DSH Desktop ${info.version} 已开始在线下载，退出时自动安装。\n官方地址：${info.fileUrl}\n加速地址：${info.proxyUrl}`,
          () => showWindow(),
        )
      },
      // 外壳下载进度 → 任务栏进度条（Windows/macOS 任务栏可见）
      onProgress: (p: UpdateProgress) => {
        try {
          win?.updateTaskbarProgress(p.percent / 100)
        } catch {
          /* ignore */
        }
      },
      onDownloaded: (info) => {
        try {
          win?.win.setProgressBar(-1)
        } catch {
          /* ignore */
        }
      },
    },
    { autoCheck: settings.autoUpdate },
  )
  // 更新：总开关「自动更新」= 冷启动自动检查一次（外壳 15s 下载 + 框架 30s 本地替换）；
  // 关闭则只保留手动「检查并更新…」。
  if (settings.autoUpdate) {
    // 第 1 层·外壳：启动 15s 后自动检查（electron-updater）
    // 第 2 层·框架：仅冷启动 30s 后检查一次，有新版自动下载替换（进度条 + 重启）
    setTimeout(() => void doHarnessUpdate(false), 30_000)
  }

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
  // 停局域网代理，断开所有外部设备
  if (lanHandle) {
    const h = lanHandle
    lanHandle = null
    void h.stop()
  }
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
