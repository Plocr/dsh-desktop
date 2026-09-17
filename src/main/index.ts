/**
 * DSH Desktop 主进程入口（官方桌面架构）：
 * 单实例 → 设置/日志 → 定位随包运行时 → 确保 desktop profile（共享包链接）→
 * 创建窗口/托盘（dsh-app:// 特权方案）→ spawn **Host 子进程**（字节管道，无监听端口）→
 * Host ready → 加载 dsh-app://app/ → 桥接事件（徽标/通知，仅桌面原生部分）→
 * 全局快捷键 / dsh:// 深链 / 自动更新 → 优雅停机。
 *
 * 与官方一致的传输与版本模型：
 *  - 后端是 `packages/host`（官方 apps/desktop-host 的移植），在随包 Node 里**进程内**引导
 *    dsh profile；渲染层只经 dsh-app:// 特权方案访问，壳与 Host 之间是 fd3/fd4 字节管道，
 *    本机不存在 harness 的监听 socket（见 hostProtocol.ts / appProtocol.ts）；
 *  - 壳版本与随包 dsh/Node/pnpm 由 resources/dsh/desktop-runtime.json 绑定为一个签名更新单元，
 *    不存在「单独更新 harness」的通道；
 *  - 插件管理（安装/启停/卸载）由 Host 进程里的**官方共享插件管理器**负责
 *    （Web 侧边栏「插件」页 / `plugin_manager` 工具），壳只提供 profile 与原生恢复
 *    （安全模式隔离，见 pluginfs.ts）。
 */
import { app, clipboard, dialog, session, shell, BrowserWindow } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { initLogger, log, logDirPath } from './logger'
import { loadSettings, saveSettings, type AppSettings } from './settings'
import { appResourcesDir, ensureProfile, resolveRuntime, type RuntimeSpec } from './runtime'
import { readProfileBundles, pruneStaleProfileBundles, isolateProfileForSafeMode, restoreProfileManifest } from './pluginfs.ts'
import { isSafeMode, recordStartFailure, recordStartSuccess, exitSafeMode, activateSafeMode, SAFE_MODE_THRESHOLD, type SafeModeState } from './safeMode'
import {
  apiKeyNeedsAttention,
  checkDeepSeekKey,
  fileFallbackDetail,
  interpretBalanceReply,
  type ApiKeyCheckResult,
} from './apiKeyCheck'
import { HostManager, type HostReady } from './host'
import { BridgeClient } from './bridge'
import { createWindow, UI_PARTITION, type WindowHandle } from './window'
import { APP_ORIGIN, SHELL_ORIGIN, installAppProtocol, registerAppScheme } from './appProtocol'
import { resolveEffectiveTheme, resolveThemePreference } from './theme'
import { createTray, type TrayHandle } from './tray'
import { notify, setBadge } from './notify'
import {
  BRIDGE_PROTOCOL_VERSION,
  handleBridgeEvent,
  handleBridgeSnapshot,
  diagOf,
  latestApproval,
  parseBridgeDiscovery,
  recentSessions,
  redactBridgeLine,
  runningJobCount,
  sessionIndexFrom,
  sessionLabel,
  withApproval,
  withoutApproval,
  type ApprovalIndex,
  type BridgeDiag,
  type SessionIndex,
} from './bridgeEvents'
import { registerIpc } from './ipc'
import { parseDeepLink, extractDeepLinkFromArgv, type DeepLinkAction } from './deepLink'
import { registerGlobalShortcut, currentShortcut, unregisterAllShortcuts } from './shortcut'
import { initUpdater, checkNow, updateDownloadReady, installDownloadedUpdate, type UpdateProgress } from './updater'
import { createLanProxy } from './lanServer'
import { repairLegacySubagentDescriptors, type SessionRepairReport } from './sessionRepair.ts'
import { DESKTOP_PROFILE, desktopProfileDir as sharedDesktopProfileDir, migrateLegacyProfileDir } from './desktopProfile.ts'
import { compareDots } from './version.ts'
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

// dsh-app:// 特权方案必须在 app ready 之前注册（Chromium 只认 ready 前注册的方案）。
// 工作台与壳页面都走它加载，渲染层不直连 harness 的监听端口——见 appProtocol.ts。
registerAppScheme()

let win: WindowHandle | null = null
let trayHandle: TrayHandle | null = null
/** Host 子进程管理器（官方桌面架构：字节管道 + 进程内引导 dsh profile）。 */
let host: HostManager
let bridge: BridgeClient
/** 随包运行时（Node + dsh 树 + pnpm；进程内只解析一次，随包不可变）。 */
let runtime: RuntimeSpec | null = null
let settings: AppSettings
let settingsFile = ''
let quitting = false
/** 用户点击「安装更新」后置位：before-quit 放行正常退出，让 electron-updater 执行安装。 */
let quitForUpdateInstall = false
/** 随包「官方 Harness」（@deepseek-ai/dsh）版本，托盘展示用；来自运行时描述符（不可单独更新）。 */
let harnessVersion: string | null = null
/** bridge 插件（在 Host 进程内的 dsh 插件）发现行给出的本地 WS 目标；未就绪为 null。 */
let bridgeTarget: { port: number; token: string } | null = null
let runningJobs = 0
let pendingDeepLinks: DeepLinkAction[] = []
/** 桥接连接状态 + 插件诊断（托盘「桥接：…」一行；见 refreshTray）。 */
let bridgeConnected = false
let bridgeDiag: BridgeDiag | null = null
/** 插件上报的协议版本（null=对面没报）；与本壳常量不一致时托盘标注。 */
let bridgePeerProtocol: number | null = null
/** 会话目录（快照 + sessions.changed 增量）：托盘「最近会话」与深链标题都用它。 */
let sessionIndex: SessionIndex = new Map()
/** 待审批环（approval.asked 入、approval.decided 出）：托盘「待审批」提醒。 */
let pendingApprovals: ApprovalIndex = new Map()

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

/** 桌面 profile 目录（$DSH_HOME/profiles/<DESKTOP_PROFILE>；旧名 desktop 为官方保留名）。 */
function desktopProfileDir(): string {
  return sharedDesktopProfileDir(dshHome())
}

/** 安全模式状态文件（跨重启保留）。 */
function safeModeFile(): string {
  return path.join(app.getPath('userData'), 'safe-mode.json')
}

/** 「旧会话修复已跑过」的标记文件（按随包 dsh 版本记，见 runLegacySessionRepair）。 */
function sessionRepairMarkerFile(): string {
  return path.join(app.getPath('userData'), 'session-repair.json')
}

/**
 * 一次性旧会话修复：v0 日志里的 `subagent/descriptor` 版本过旧会让 dsh ≥ 0.1.3 的
 * 迁移整条拒绝（历史会话打不开），这里做最小改写 + 备份（见 sessionRepair.ts）。
 *
 * 为什么要有标记：这是**历史迁移**，同一条日志修好后再扫也无可修。原先每次启动
 * 都全量扫描（读 + 解压全部会话日志），是重用户机器上最拖启动的一项。
 * 现在按随包 dsh 版本只跑一次；需要重扫时走托盘「设置 → 重新修复旧会话日志」。
 *
 * @param dshVersion - 随包 dsh 版本；与标记一致且未 force 时直接跳过。
 * @param options.force - 忽略标记强制重扫（托盘入口用）。
 * @returns 修复报告；跳过或失败返回 null。
 */
function runLegacySessionRepair(dshVersion: string, options: { force?: boolean } = {}): SessionRepairReport | null {
  if (compareDots(dshVersion, '0.1.3-alpha.2') < 0) return null
  const marker = sessionRepairMarkerFile()
  if (options.force !== true) {
    try {
      const seen = JSON.parse(readFileSync(marker, 'utf8')) as { dshVersion?: unknown }
      if (seen.dshVersion === dshVersion) return null
    } catch {
      /* 无标记 → 需要扫描 */
    }
  }
  let report: SessionRepairReport
  try {
    report = repairLegacySubagentDescriptors(path.join(dshHome(), 'sessions'))
  } catch (err) {
    // 不写标记：下次启动重试（绝不在失败后假装已修复）
    log('error', `sessions: legacy repair failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  try {
    writeFileSync(
      marker,
      `${JSON.stringify({ dshVersion, scanned: report.scanned, repaired: report.repaired, scannedAt: new Date().toISOString() }, undefined, 2)}\n`,
    )
  } catch (err) {
    log('error', `sessions: cannot write repair marker: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (report.repaired > 0) {
    log('info', `sessions: repaired ${report.repaired}/${report.scanned} legacy logs (${report.repairedIds.slice(0, 5).join(', ')})`)
  } else {
    log('info', `sessions: legacy repair scanned ${report.scanned} logs, nothing to fix`)
  }
  return report
}

/**
 * 插件启停后把 profile 组合拉回一致：
 *  - 安全模式：bundles 只留官方基线 + bridge（`isolateProfileForSafeMode`，带备份可恢复）；
 *  - 常规启动：只清理「已不再安装」的失效条目，**绝不重新启用**依赖；
 *  - 官方依赖（dsh-base/dsh-web-app）与 bridge 永不可停用。
 * 组合由 profile 的 package.json 承载，Host 启动时读取——不需要额外的 overlay 文件。
 *
 * 为什么启停不再由壳决定：`dsh.profile.bundles` 是启停的唯一事实来源，官方插件管理器
 * （Web「插件」页 / `plugin_manager` 工具，由 Host 侧的 profileContext 激活）拥有写权——
 * 连安装后的启用动作也由它完成。壳若在启动时按依赖重写列表，用户在官方页面停用的
 * 组合包下次启动就会被悄悄打开。
 */
function reconcilePluginBundles(): void {
  const profileDir = desktopProfileDir()
  try {
    if (isSafeMode(safeModeFile())) {
      // 安全模式只需保住基线 + bridge：Host 读的就是 profile 的 bundles
      const isolated = isolateProfileForSafeMode(profileDir)
      log('info', `safe mode bundles ${isolated ? 'isolated' : 'already isolated'}`)
      return
    }
    // 只清理失效条目（用户停用的组合包保持停用）
    pruneStaleProfileBundles(profileDir)
    log('info', `profile bundles: ${readProfileBundles(profileDir).join(', ') || '(none)'}`)
  } catch (err) {
    log('error', `reconcilePluginBundles failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---- 局域网访问 / 本机浏览器版（Host 管道 fetch 的对外门面）----
/** 当前选定的局域网 IPv4（对外主地址）；null = 未开启或无非内部网卡。 */
let lanIp: string | null = null
/** 对外地址（http://<lanIp>:<端口>?token=…），开启后填充。 */
let lanUrl: string | null = null
/** 对外服务句柄（关掉 LAN/退出时 stop）。 */
let lanHandle: import('./lanServer').LanProxyHandle | null = null
/** 本次运行的访问 token（手机书签 / 本机浏览器版都用它换 cookie）。 */
let lanToken: string | null = null
/** 授权弹窗串行锁（多设备同时来不叠弹窗）。 */
let lanApprovalLock = false
/** 本次进程启动以来 harness 是否成功 ready 过（用于安全模式失败计数判定）。 */
let harnessEverReady = false
/** API Key 自检结果（null=尚未检测；托盘展示用）。 */
let apiKeyStatus: ApiKeyCheckResult | null = null
/** 是否已就当前 key 状态提示过用户（避免每次 ready 重复弹通知）。 */
let apiKeyNotified = false
/** 桥接协议不匹配只提示一次（每次重连都弹会很吵）。 */
let bridgeProtocolNotified = false
/** 最近一次 harness 启动失败摘要（stderr 的 Error 行）；onReady 时清空。 */
let lastHarnessError: string | null = null

/** 本机全部可用局域网 IPv4（排除 internal/链路本地），best-first 排序。 */
function lanCandidates(): string[] {
  const list: string[] = []
  const ifaces = os.networkInterfaces()
  for (const l of Object.values(ifaces)) {
    for (const f of l ?? []) {
      if (f.family !== 'IPv4' || f.internal) continue
      const ip = f.address
      // 排除链路本地（169.254.x.x）与 0.x.x.x（未配置/无效地址）
      if (/^(169\.254|0)\./.test(ip)) continue
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
 * 依据当前设置启停对外服务（局域网 / 本机浏览器版共用同一个门面）。
 * 官方架构下**没有 harness 端口可转发**：对外服务把请求直接交给 Host 的管道 fetch
 * （与桌面窗口同一实现），因此没有「宿主监听地址」需要保护——对外只有一个门面，
 * 门禁是设备授权 + 本次运行 token（见 lanServer.ts）。
 *
 * 局域网 IP 在这里**按需解析**（首选默认路由出口，失败回退网卡候选）：解析要发一次
 * UDP connect，最坏 1.5s 超时——绝不能放在窗口/后端启动的关键路径上（只有开启
 * 局域网共享的用户才付这笔钱，而且是在 Host ready 之后的异步路径里）。
 */
async function manageLanServer(): Promise<void> {
  if (settings.lanShare) {
    lanIp = lanIp ?? await resolveBestLanIp()
    if (lanIp === null) {
      log('error', 'lanShare: 未发现局域网 IPv4，无法对外提供访问')
      refreshTray()
      return
    }
    if (!lanHandle) {
      lanToken = lanToken ?? randomBytes(16).toString('hex')
      lanHandle = await createLanProxy({
        bindHost: '0.0.0.0',
        forward: (request) => host.fetch(request),
        requestApproval: (ip) => promptLanApproval(ip),
        token: lanToken,
      })
      lanUrl = `http://${lanIp}:${lanHandle.port}/?token=${lanToken}`
      log('info', `lanShare: serving on ${lanIp}:${lanHandle.port}（设备首访需本机授权）`)
    }
  } else if (lanHandle) {
    await lanHandle.stop()
    lanHandle = null
    lanUrl = null
    lanIp = null
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

/** 重启 Host：先按当前设置把 profile 组合拉回一致（安全模式 / 失效条目），再重启。 */
async function restartHarness(): Promise<void> {
  // 手动重启 = 新启动会话：重置 ready 标记，让本次启动的连续失败重新计数（坏插件崩溃可触发安全模式）
  harnessEverReady = false
  try {
    if (runtime) {
      ensureProfile({
        dshHome: dshHome(),
        templateDir: path.join(appResourcesDir(), 'profile-template', 'dsh-workbench'),
        runtime,
      })
    }
    reconcilePluginBundles()
  } catch (err) {
    // 准备失败不应导致 unhandled rejection：记日志并照常重启（profile 仍是上一次的可用状态）
    log('error', `restartHarness prepare failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    host.restart()
  } catch (err) {
    log('error', `restartHarness failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 解析 Host stdout 上的 bridge 发现行（`dsh desktop: {"port":N,"token":"…"}`）。
 * bridge 是壳↔harness 的通道（通知/徽标/深链/工作区注册），它在 Host 进程内起一个
 * 本地 WS server 并把端口与本次运行 token 打到 stdout；壳据此连接（token 防本机劫持）。
 * 解析/校验在 bridgeEvents.parseBridgeDiscovery（纯函数，可单测；非法目标一律拒绝）。
 */
function parseBridgeLine(line: string): void {
  const target = parseBridgeDiscovery(line)
  if (target === null) return
  bridgeTarget = target
  bridge?.connect()
}

function refreshTray(): void {
  trayHandle?.refresh()
}

/** jobs 服务可见性（诊断码 jobs.present/jobs.absent 是唯一事实来源）。 */
function bridgeJobsState(): 'present' | 'absent' | null {
  if (bridgeDiag?.code === 'jobs.present') return 'present'
  if (bridgeDiag?.code === 'jobs.absent') return 'absent'
  return null
}

/** 协议同代判断：对面没报版本（老插件）也算 unknown，托盘要能看出来。 */
function bridgeProtocolState(): 'ok' | 'mismatch' | 'unknown' {
  if (!bridgeConnected) return 'unknown'
  if (bridgePeerProtocol === null) return 'unknown'
  return bridgePeerProtocol === BRIDGE_PROTOCOL_VERSION ? 'ok' : 'mismatch'
}

// ---- 本地更新反馈：右上角小卡片（进度条 + 下载地址）+ 任务栏进度 ----
type UpdateOverlayState = { pct: number | null; detail: string; url?: string | null }
/** 更新卡使用独立 DOM id，避免与其他注入卡片互相覆盖/移除。 */
const SHELL_UPDATE_TOAST_ID = 'dsh-update-toast'
/** 外壳（electron-updater）下载进度卡的推送句柄：下载完成前一直显示。 */
let shellUpdateSink: ((p: UpdateOverlayState) => void) | null = null

/** 打开更新小卡片，返回可推送进度的更新函数（不导航、不占整页、可关闭）。 */
function beginUpdateOverlay(
  init: UpdateOverlayState,
  id: string = SHELL_UPDATE_TOAST_ID,
): (p: UpdateOverlayState) => void {
  if (!win) return () => undefined
  const sink = win.showUpdateOverlay({ pct: init.pct, detail: init.detail, url: init.url }, id)
  if (id === SHELL_UPDATE_TOAST_ID) shellUpdateSink = sink
  return (p) => sink({ pct: p.pct, detail: p.detail, url: p.url })
}

/** 结束更新卡片：移除卡片并清除任务栏进度（只移除指定 id 的卡片）。 */
function endUpdateOverlay(id: string = SHELL_UPDATE_TOAST_ID): void {
  if (id === SHELL_UPDATE_TOAST_ID) shellUpdateSink = null
  try {
    win?.hideUpdateOverlay(id)
  } catch {
    /* ignore */
  }
}

/** 更新已下载 → 右上角卡片变成「安装更新并重启」按钮；点按（卡片或系统通知）进入安装。 */
async function requestUpdateInstall(): Promise<boolean> {
  if (!updateDownloadReady()) {
    // 刚重启过：electron-updater 的下载缓存需一次检查来重新确认（确认完自动进安装）
    if (settings.pendingUpdateVersion) {
      autoInstallAfterDownload = true
      notify('更新', `检测到已下载的 ${settings.pendingUpdateVersion}，正在确认…`, () => showWindow())
      void checkNow(false)
      return false
    }
    notify('更新', '暂无已下载的更新', () => showWindow())
    return false
  }
  const r = await dialog.showMessageBox({
    type: 'question',
    buttons: ['立即安装并重启', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '安装更新',
    message: 'DSH Desktop 更新已下载完成',
    detail: '现在将结束应用并安装更新，安装完成后自动重启。你的配置与会话会保留。',
    noLink: true,
  })
  if (r.response !== 0) return false
  quitForUpdateInstall = true
  const ok = installDownloadedUpdate()
  if (ok || settings.pendingUpdateVersion === app.getVersion()) {
    // 安装已启动 / 已处于该版本 → 清掉待安装标记
    if (settings.pendingUpdateVersion) {
      settings.pendingUpdateVersion = null
      saveSettings(settingsFile, settings)
    }
  }
  return ok
}

/** 已下载待安装的版本（跨重启保留）：启动时若存在则重新显示「安装更新」卡片。 */
let autoInstallAfterDownload = false
function maybeResumePendingUpdate(): void {
  const pending = settings.pendingUpdateVersion
  if (!pending) return
  if (pending === app.getVersion()) {
    // 已在该版本（装完重启）→ 清理标记
    settings.pendingUpdateVersion = null
    saveSettings(settingsFile, settings)
    return
  }
  shellUpdateSink = beginUpdateOverlay({
    pct: 100,
    detail: `已下载的 DSH Desktop ${pending} 待安装，点下方按钮或通知安装`,
    url: null,
  })
  try {
    win?.setUpdateInstallButton(true)
  } catch {
    /* ignore */
  }
  notify('更新待安装', `DSH Desktop ${pending} 已下载完成，点击立即安装并重启。`, () => void requestUpdateInstall())
}

/** 托盘展示用的「双版本」文案（框架 = DSH Desktop，官方 = 随包 Harness）。 */
function updateVersionLabel(): string {
  return `框架 v${app.getVersion()} · 官方 Harness v${harnessVersion ?? '—'}`
}

function showWindow(): void {
  if (!win) return
  const w = win.win
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

/**
 * 在系统浏览器打开工作台。
 * 官方架构下后端没有监听端口（Host 走字节管道），所以本机浏览器版复用对外门面：
 * 已开启局域网访问 → 直接开回环地址（回环免设备授权，仍需本次运行 token）；
 * 未开启 → 明确提示先开启（不偷偷为本机再开一个长期监听口）。
 */
function openBrowser(): void {
  if (!lanHandle || !lanToken) {
    notify('打开浏览器版', '官方桌面架构下后端不监听端口：请先在托盘菜单开启「局域网访问」，本机浏览器版与它共用同一个对外地址。', () => showWindow())
    return
  }
  void shell.openExternal(`http://127.0.0.1:${lanHandle.port}/?token=${lanToken}`)
}

function currentInfo(): unknown {
  return {
    version: app.getVersion(),
    harnessState: host?.state ?? 'stopped',
    url: lanUrl,
    dshHome: dshHome(),
    transport: 'byte-pipes (dsh-app://app)',
    runningJobs,
    appData: app.getPath('userData'),
    logsDir: logDirPath(),
    globalShortcut: currentShortcut(),
    safeMode: isSafeMode(safeModeFile()),
    lastHarnessError,
    bridge: {
      connected: bridgeConnected,
      jobs: bridgeJobsState(),
      protocol: bridgeProtocolState(),
      peerProtocol: bridgePeerProtocol,
      pending: pendingApprovals.size,
      lastDiag: bridgeDiag,
      sessions: sessionIndex.size,
    },
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
  log('info', `register workspace -> ${dir}`)
  // 工作区是 harness 自己的注册表（$DSH_HOME/storages），Host 以 profile 为 cwd 常驻：
  // 注册走 bridge RPC（与 Web UI 的「添加工作区」同一实现），无需重启 Host。
  try {
    await bridge.call('workspace.register', { path: dir })
  } catch (err) {
    log('error', `workspace.register failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  refreshTray()
  return dir
}

/** 插件操作前停止 Host：官方要求 profile 改动前后端必须停止（避免热监听回滚 package.json）。 */
async function stopHostBeforePluginOp(): Promise<void> {
  if (host && (host.state === 'ready' || host.state === 'starting')) {
    log('info', 'plugin op: stopping host first（官方：profile 改动前必须停后端）')
    await host.stop()
  }
}

/**
 * 托盘「在插件页管理（官方）…」：把工作台带到前台，并指出官方插件页在侧边栏。
 *
 * 官方桌面设计里 Electron **不提供**独立的插件管理页面；插件管理统一由共享的
 * Web 插件管理器（侧边栏「插件」页 + `plugin_manager` 工具）承担，桌面壳只提供
 * 原生恢复与包管理器。托盘的安装/卸载入口是为离线与救急保留的补充通道。
 */
function openPluginPage(): void {
  showWindow()
  notify('插件页', '在左侧边栏打开「插件」页：安装、启停、卸载与依赖脚本授权都在那里。')
}

/** 托盘「进入安全模式」：停用全部插件（先停 Host，避免热监听把 manifest 改动回滚）。 */
async function enterSafeModeFromTray(): Promise<void> {
  activateSafeMode(safeModeFile())
  await stopHostBeforePluginOp()
  log('info', 'safe mode entered manually（插件已全部停用）')
  if (isolateProfileForSafeMode(desktopProfileDir())) {
    log('info', 'safe mode: profile bundles isolated (only official bundles kept)')
  }
  notify('已进入安全模式', '全部插件已停用（仅保留系统必需 bridge 与官方 bundle）。可在托盘「桌面插件 → 退出安全模式」恢复。')
  refreshTray()
  // 内部重新生成 overlay（安全模式只注入 bridge）并按新状态重启
  await restartHarness()
}

/** 托盘「退出安全模式」：恢复全部插件（清失败计数 + 还原 bundle 清单）。 */
async function exitSafeModeFromTray(): Promise<void> {
  const st: SafeModeState = exitSafeMode(safeModeFile())
  // 先停 Host：否则运行中的热监听会把还原后的 manifest 又改回隔离态
  await stopHostBeforePluginOp()
  const restored = restoreProfileManifest(desktopProfileDir())
  log('info', `safe mode exited by user (failCount=${st.failCount}, safeMode=${st.safeMode}, manifestRestored=${restored})`)
  notify('已退出安全模式', '全部插件已恢复，正在重启工作台…')
  refreshTray()
  await restartHarness()
}

/**
 * API Key 自检：**优先走桥接**（harness 的 credentials 服务会读环境变量 / credentials 文件 /
 * dotenv 回退），桥接不可用时回退本地 `.credentials.yaml` 解析。
 * 只有官方明确拒绝（401/403）或"未配置"才报警；网络类失败记为 unknown，绝不误报"无效"。
 */
async function checkApiKey(): Promise<{ result: ApiKeyCheckResult; via: 'bridge' | 'file' }> {
  if (bridgeConnected) {
    try {
      const reply = await bridge.call('billing.balance', undefined, 12_000)
      return { result: interpretBalanceReply(reply, null), via: 'bridge' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const mapped = interpretBalanceReply(undefined, message)
      if (mapped.verdict !== 'unknown') return { result: mapped, via: 'bridge' }
      log('error', `api key check via bridge inconclusive: ${message}`)
    }
  }
  return { result: await checkDeepSeekKey(path.join(dshHome(), '.credentials.yaml')), via: 'file' }
}

/** 自检并更新托盘/通知（只在明确无效时通知一次）。 */
async function runApiKeyCheck(): Promise<void> {
  try {
    const { result, via } = await checkApiKey()
    apiKeyStatus = via === 'file' ? { ...result, detail: fileFallbackDetail(result) } : result
    log(result.ok ? 'info' : 'error', `api key check (${via}): ${result.detail}`)
    refreshTray()
    if (apiKeyNeedsAttention(result, via) && !apiKeyNotified) {
      apiKeyNotified = true
      notify('DeepSeek API Key 检测', `${result.detail}。更新后立即生效（无需重启应用）。`)
    }
  } catch {
    /* 自检失败不影响主流程 */
  }
}

function handleBridgeEventWrapper(type: string, payload: unknown): void {
  if (
    type === 'job.done' ||
    type === 'jobs.changed' ||
    type === 'approval.asked' ||
    type === 'approval.decided' ||
    type === 'sessions.changed' ||
    type === 'bridge.diag'
  ) {
    log('info', `bridge event: ${type} ${JSON.stringify(payload).slice(0, 300)}`)
  }
  handleBridgeEvent(
    type,
    payload,
    { notifications: settings.notifications },
    {
      // 通知点击：审批通知直接落到那个会话；其余只聚焦窗口
      notify: (title, body, onClick) => notify(title, body, onClick ?? (() => showWindow())),
      setBadge,
      openSession: (sessionId) => void handleDeepLink({ kind: 'session', sessionId }),
      diag: (d) => {
        bridgeDiag = d
        log(d.level === 'info' ? 'info' : 'error', `bridge diag(${d.level}): ${d.code} ${JSON.stringify(d.detail)}`)
        refreshTray()
      },
    },
  )
  if (type === 'jobs.changed') {
    const jobs = ((payload as { jobs?: unknown[] } | undefined)?.jobs) ?? []
    runningJobs = runningJobCount(jobs)
    refreshTray()
    return
  }
  // 会话目录增量：托盘「最近会话」、深链标题缓存（改标题/新建后不重启即生效）
  if (type === 'sessions.changed') {
    sessionIndex = sessionIndexFrom(payload)
    refreshTray()
    return
  }
  if (type === 'approval.asked') {
    pendingApprovals = withApproval(pendingApprovals, payload)
    refreshTray()
    return
  }
  if (type === 'approval.decided') {
    pendingApprovals = withoutApproval(pendingApprovals, payload)
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
  // 工作台地址是 dsh-app://app/（壳页面是 dsh-app://shell/，两者不会混淆）
  return w.webContents.getURL().startsWith(APP_ORIGIN)
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
    // 目录里已有标题就不打扰 harness（会话目录由 dashboard.snapshot + sessions.changed 维护）
    let title: unknown = sessionIndex.get(action.sessionId)?.title ?? null
    if (typeof title !== 'string' || title === '') {
      try {
        const res = (await bridge.call('session.resolve', { id: action.sessionId }, 8000)) as { title?: unknown }
        title = res?.title
      } catch (err) {
        log('error', `session.resolve failed: ${err instanceof Error ? err.message : String(err)}`)
      }
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

  const resourcesDir = appResourcesDir()

  // 先创建窗口并立即显示加载页，再准备运行时/后端。
  win = createWindow(path.join(__dirname, '..', 'preload', 'index.cjs'), resourcesDir, {
    // 导航锁：只允许本壳的两个 dsh-app:// 来源（shell 壳页面 / app 工作台）。
    // 后端没有监听端口，页面也无从访问任何 http/ws 地址。
    isAllowed: (url) => url.startsWith(SHELL_ORIGIN) || url.startsWith(APP_ORIGIN),
    theme: resolveEffectiveTheme(dshHome()),
  })
  // dsh-app:// 处理器要装在窗口所在分区（Electron 的 protocol 模块只管默认分区）；
  // 工作台请求全部转给 Host 的管道 fetch。
  installAppProtocol(session.fromPartition(UI_PARTITION), path.join(resourcesDir, 'shell-pages'), (request) =>
    host.fetch(request),
  )
  win.showLoading(undefined, resolveThemePreference(dshHome()))
  win.win.on('close', (e) => {
    if (settings.trayOnClose && !quitting) {
      e.preventDefault()
      win?.win.hide()
    }
  })

  // 一次性迁移旧 profile 名（desktop 是官方保留名；本壳自有名 dsh-workbench）。
  if (migrateLegacyProfileDir(dshHome())) {
    log('info', `profile migrated: profiles/desktop -> profiles/${DESKTOP_PROFILE}`)
  }

  // 定位随包运行时（不可变：Node + dsh 树 + pnpm，见 resources/dsh/desktop-runtime.json）。
  // 版本绑定校验失败会在这里直接抛出——绝不带着未知组合启动。
  runtime = resolveRuntime()
  harnessVersion = runtime.dshVersion

  // 确保 profile（模板 + pnpm workspace + bundles + 共享包链接）就绪
  ensureProfile({
    dshHome: dshHome(),
    templateDir: path.join(resourcesDir, 'profile-template', 'dsh-workbench'),
    runtime,
  })

  // 旧会话修复：v0 日志里的 subagent descriptor 版本过旧会让 dsh ≥ 0.1.3 的迁移整条拒绝
  // （历史会话打不开）。纯本地最小改写 + 备份。
  //
  // **一次性**：这是历史迁移，按随包 dsh 版本记标记，同一个版本只扫一次。
  // 原来每次启动都全量扫描（读+解压全部会话日志），是重用户机器上最拖启动的一项；
  // 需要重新扫描时走托盘「设置 → 重新修复旧会话日志」。
  runLegacySessionRepair(runtime.dshVersion)

  // 插件启停 / 安全模式 → profile 组合
  // 启动期只清理失效条目：bundles 列表由官方插件管理器拥有，不在这里重新启用任何依赖。
  reconcilePluginBundles()

  host = new HostManager(
    {
      node: runtime.node,
      runtimeDir: runtime.runtimeDir,
      projectDir: desktopProfileDir(),
      // 随包 pnpm → Host 的 profileContext.packageManager：官方插件管理器据此工作（离线可用）
      pnpmEntry: runtime.pnpmEntry,
      // Host 在随包 Node 里引导 profile：DSH_HOME 必须显式传入（官方 Host 不读壳的设置）
      env: { ...process.env, DSH_HOME: dshHome(), DSH_DESKTOP: '1' },
    },
    {
      onReady: (r: HostReady) => {
        // 成功 ready：清安全模式失败计数（不自动退出安全模式，由用户显式恢复）
        harnessEverReady = true
        lastHarnessError = null
        recordStartSuccess(safeModeFile())
        harnessVersion = r.dshVersion
        // 对外服务（默认关闭）：官方架构下没有 harness 端口，门面直连 Host 管道 fetch
        void manageLanServer().then(() => refreshTray())
        // 切到工作台：dsh-app://app/ 的所有请求都由 Host 处理（含 __DSH_TRANSPORT__ 注入）
        win?.loadApp()
        refreshTray()
        // API Key 自检（异步，不阻塞）：失效时托盘/通知给出明确提示
        void runApiKeyCheck()
        // UI 加载完成后处理启动时排队的深链
        setTimeout(() => flushPendingDeepLinks(), 2500)
      },
      onExit: ({ code, signal, willRestart }) => {
        log('info', `host exited code=${code} signal=${String(signal)} willRestart=${willRestart}`)
        // 保底启动（安全模式）：自上次 ready 以来非零码退出 → 记一次失败；
        // 连续失败达阈值 → 自动进入安全模式：profile bundles 只留官方基线 + bridge，
        // Host 的自动重启会读到同一 profile → 插件全部停用，应用保底可打开
        if (code !== 0 && !harnessEverReady) {
          const st = recordStartFailure(safeModeFile())
          log('error', `safe mode: 连续启动失败 ${st.failCount}/${SAFE_MODE_THRESHOLD}${st.safeMode ? ' → 已进入安全模式' : ''}`)
          if (st.safeMode) {
            if (isolateProfileForSafeMode(desktopProfileDir())) {
              log('info', 'safe mode: profile bundles isolated (only official bundles kept)')
            }
            notify(
              'DSH Desktop 已进入安全模式',
              `工作台连续 ${SAFE_MODE_THRESHOLD} 次启动失败，已停用全部插件（仅保留系统必需 bridge 与官方 bundle）。可在托盘「桌面插件 → 退出安全模式」恢复。`,
            )
            refreshTray()
          }
        }
        if (willRestart) {
          win?.showLoading('Harness 异常退出，正在自动重启…', resolveThemePreference(dshHome()))
        }
        refreshTray()
      },
      onLog: (stream, line) => {
        // 发现行带本次运行 token：日志脱敏后再落盘（token 只该存在于内存里的握手）
        log(stream === 'stdout' ? 'info' : 'error', `[host:${stream}] ${redactBridgeLine(line)}`)
        // bridge 插件的发现行（stdout）：壳↔harness 通道的 ws 端口 + 本次运行 token
        if (stream === 'stdout') parseBridgeLine(line)
        // 记录启动失败摘要（onReady 时清空）：安全模式托盘区向用户展示可读原因
        if (stream === 'stderr' && /^Error:/.test(line.trim())) {
          lastHarnessError = line.trim().slice(0, 220)
        }
      },
      onState: (s) => {
        if (s === 'starting' && !harnessEverReady) win?.showLoading(undefined, resolveThemePreference(dshHome()))
        refreshTray()
      },
    },
  )

  // 局域网访问：不在这里解析目标地址——那要发一次 UDP connect（最坏 1.5s 超时），
  // 会拖慢「窗口出来 → 后端启动」这一段。改为 Host ready 后由 manageLanServer 按需解析。
  bridge = new BridgeClient(
    () => (bridgeTarget !== null ? bridgeTarget : null),
    {
      onEvent: handleBridgeEventWrapper,
      onConnected: (connected, hello) => {
        bridgeConnected = connected
        if (!connected) {
          bridgePeerProtocol = null
          // 断开 = harness 进程已退出/重启：后台任务/待审批随进程消失，必须复位
          // （新进程的增量只会覆盖、不会清零，否则徽标/提醒会一直挂着旧状态）
          if (runningJobs !== 0 || pendingApprovals.size !== 0) {
            runningJobs = 0
            pendingApprovals = new Map()
            setBadge(0)
          }
          refreshTray()
          return
        }
        bridgePeerProtocol = hello?.protocolVersion ?? null
        if (hello?.diag !== undefined && hello.diag !== null) {
          const d = diagOf(hello.diag)
          if (d !== null) {
            bridgeDiag = d
            log('info', `bridge diag(${d.level}): ${d.code} ${JSON.stringify(d.detail)}`)
          }
        }
        // 协议不同代（profile 层替换过 bundle / 版本漂移）：报错并标注在托盘，但不掐断——
        // 增量字段是加法式的，旧壳仍能用已认识的部分。
        if (bridgePeerProtocol !== BRIDGE_PROTOCOL_VERSION) {
          log(
            'error',
            `bridge protocol mismatch: shell v${BRIDGE_PROTOCOL_VERSION} vs plugin v${String(bridgePeerProtocol ?? 'unknown')}`,
          )
          if (!bridgeProtocolNotified) {
            bridgeProtocolNotified = true
            notify('桥接协议不匹配', 'dsh-desktop-bridge 与本应用版本不同步，部分桌面功能可能失效。请重新安装或更新应用。')
          }
        }
        refreshTray()
        // 自检：验证 shell -> harness RPC 通路
        void bridge
          .call('ping')
          .then(() => log('info', 'bridge RPC self-test OK'))
          .catch((err) => log('error', `bridge RPC self-test failed: ${err instanceof Error ? err.message : String(err)}`))
        // 重连/重启后事件增量已丢失：拉一次快照整份对齐（徽标 + 会话目录 + 待审批）
        void bridge
          .call('dashboard.snapshot')
          .then((snapshot) => {
            const state = handleBridgeSnapshot(snapshot, { setBadge })
            runningJobs = state.running
            sessionIndex = state.sessions
            pendingApprovals = state.approvals
            refreshTray()
          })
          .catch((err) => log('error', `bridge snapshot failed: ${err instanceof Error ? err.message : String(err)}`))
        // 桥接可用后重跑一次 API Key 自检：首启那次可能走的是文件回退（非权威），
        // 而用环境变量/dotenv 配的 key 只有 harness 的凭据服务看得见。
        void runApiKeyCheck()
      },
    },
  )

  trayHandle = createTray(path.join(resourcesDir, 'icons', 'tray.png'), {
    getUrl: () => lanUrl,
    getState: () => ({
      autoStart: settings.autoStart,
      notifications: settings.notifications,
      autoUpdate: settings.autoUpdate,
      lanShare: settings.lanShare,
      lanUrl,
      runningJobs,
      harnessState: host?.state === 'ready' ? '运行中' : host?.state === 'starting' ? '启动中' : '已停止',
      globalShortcut: currentShortcut(),
      appVersion: app.getVersion(),
      harnessVersion,
      safeMode: isSafeMode(safeModeFile()),
      lastHarnessError,
      apiKey: apiKeyStatus,
      bridge: {
        connected: bridgeConnected,
        jobs: bridgeJobsState(),
        protocol: bridgeProtocolState(),
        pending: pendingApprovals.size,
        lastCode: bridgeDiag?.code ?? null,
      },
      recentSessions: recentSessions(sessionIndex, 8).map((entry) => ({
        id: entry.id,
        label: entry.live ? `${sessionLabel(entry, entry.id)}` : `${sessionLabel(entry, entry.id)}（历史）`,
      })),
    }),
    pendingSessionId: () => latestApproval(pendingApprovals)?.sessionId ?? null,
    openSession: (sessionId) => {
      if (!sessionId) return
      void handleDeepLink({ kind: 'session', sessionId })
    },
    showWindow,
    openBrowser,
    pickWorkspace: () => void pickWorkspace(),
    openPluginPage: () => openPluginPage(),
    exitSafeMode: () => void exitSafeModeFromTray(),
    enterSafeMode: () => void enterSafeModeFromTray(),
    restartHarness: () => void restartHarness(),
    openLogs: () => void shell.openPath(logDirPath()),
    // 一次性迁移的强制重跑：按菜单点击先返回，扫描在下一个 tick 做（避免卡住托盘）
    repairSessions: () => {
      setTimeout(() => {
        const version = harnessVersion ?? runtime?.dshVersion ?? ''
        const report = runLegacySessionRepair(version, { force: true })
        notify(
          '旧会话修复完成',
          report === null
            ? '本次未扫描（dsh 版本不支持或扫描失败，详见日志）。'
            : `扫描 ${report.scanned} 个会话日志，修复 ${report.repaired} 个。`,
        )
        refreshTray()
      }, 0)
    },
    cleanLogs: () => cleanLogs(),
    uninstall: () => uninstallApp(),
    // 手动「检查并更新…」：官方桌面端只有一个更新单元（壳 + dsh 运行时一起换），
    // 因此查的就是外壳自己的更新流（electron-updater → GitHub Releases）
    checkUpdate: () => {
      void checkNow(true)
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
    // 局域网访问开关：开启 → 立即起对外门面（手机首访需本机授权）；关闭 → 立即断开。
    // 后端无监听端口，因此不重启 Host、也不影响本机窗口。
    setLanShare: (v) => {
      settings.lanShare = v
      saveSettings(settingsFile, settings)
      if (!v) {
        void manageLanServer().then(() => {
          refreshTray()
          notify('局域网访问已关闭', '对外地址已停止服务。', () => showWindow())
        })
        return
      }
      void (async () => {
        lanIp = await resolveBestLanIp()
        if (lanIp === null) {
          log('error', 'lanShare: 未发现局域网 IPv4，无法对外提供访问')
          notify('局域网访问已开启', '未发现局域网网卡 IPv4，无法对外提供服务。', () => showWindow())
          refreshTray()
          return
        }
        await manageLanServer()
        refreshTray()
        notify(
          '局域网访问已开启',
          `地址已复制到剪贴板：${lanUrl ?? ''}\n手机/其它设备首次访问需在本机确认授权。`,
          () => showWindow(),
        )
        if (lanUrl) void clipboard.writeText(lanUrl)
      })()
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
    bridge,
    pickWorkspace,
    restartHarness: () => void restartHarness(),
    getInfo: currentInfo,
    openSession: (sessionId) => handleDeepLink({ kind: 'session', sessionId }),
    requestUpdateInstall: () => requestUpdateInstall(),
  })

  // dsh:// 协议 + 全局快捷键 + 自动更新
  registerProtocol()
  registerGlobalShortcut(settings.globalShortcut, () => showWindow())
  initUpdater(
    {
      onManualResult: (msg) => notify('检查更新', msg, () => showWindow()),
      // 外壳有新版：右上角进度卡从下载开始一直显示，直到装完/关闭
      onAvailable: (info) => {
        shellUpdateSink = beginUpdateOverlay({
          pct: 0,
          detail: `发现新版 DSH Desktop ${info.version}，正在下载…`,
          url: info.fileUrl,
        })
        notify(
          '发现新版本（下载中）',
          `DSH Desktop ${info.version} 已开始在线下载。\n官方地址：${info.fileUrl}\n加速地址：${info.proxyUrl}`,
          () => showWindow(),
        )
      },
      // 外壳下载进度 → 任务栏 + 右上角卡片实时百分比
      onProgress: (p: UpdateProgress) => {
        try {
          win?.updateTaskbarProgress(p.percent / 100)
        } catch {
          /* ignore */
        }
        if (shellUpdateSink) {
          shellUpdateSink({ pct: p.percent, detail: `正在下载 DSH Desktop 更新… ${p.percent}%`, url: undefined })
        }
      },
      // 下载完成：卡片变「安装更新并重启」按钮 + 系统通知可点击直接安装
      onDownloaded: (info) => {
        try {
          win?.win.setProgressBar(-1)
        } catch {
          /* ignore */
        }
        if (shellUpdateSink) {
          shellUpdateSink({ pct: 100, detail: `DSH Desktop ${info.version} 下载完成，点下方按钮或通知安装`, url: undefined })
        }
        try {
          win?.setUpdateInstallButton(true)
        } catch {
          /* ignore */
        }
        // 持久化「待安装」：即使重启也能再次提示/一键安装
        if (info.version && info.version !== settings.pendingUpdateVersion) {
          settings.pendingUpdateVersion = info.version
          saveSettings(settingsFile, settings)
        }
        notify('更新已就绪', `DSH Desktop ${info.version} 下载完成，点击立即安装并重启。`, () => void requestUpdateInstall())
        // 重启后点过安装但 electron-updater 需重新确认时：确认完自动进入安装确认
        if (autoInstallAfterDownload) {
          autoInstallAfterDownload = false
          setTimeout(() => void requestUpdateInstall(), 500)
        }
      },
    },
    { autoCheck: settings.autoUpdate },
  )
  // 启动后：若上次下载完但没装，重新显示「安装更新」卡片（跨重启不丢）
  setTimeout(() => maybeResumePendingUpdate(), 4000)

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

  host.start()
}

app.on('before-quit', (e) => {
  // 更新安装：放行正常退出，让 electron-updater 执行安装（禁止走下面的强退 app.exit(0)）
  if (quitForUpdateInstall) {
    quitForUpdateInstall = false
    log('info', 'before-quit: update install flow, allowing normal quit')
    try {
      host?.killNow()
    } catch {
      /* ignore */
    }
    return
  }
  if (quitting) return
  e.preventDefault()
  quitting = true
  log('info', 'quitting: stopping host')
  unregisterAllShortcuts()
  // 停局域网代理，断开所有外部设备
  if (lanHandle) {
    const h = lanHandle
    lanHandle = null
    void h.stop()
  }
  bridge?.stop()
  void host
    ?.stop()
    .catch((err) => log('error', `stop failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  // trayOnClose=false：关闭窗口即退出（与设置说明一致）；true 时托盘常驻
  if (!settings.trayOnClose) app.quit()
})

app
  .whenReady()
  .then(() => main())
  .catch((err) => {
    log('error', `main failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    dialog.showErrorBox('DSH Desktop', `启动失败：\n${err instanceof Error ? err.message : String(err)}\n\n详见日志：${logDirPath()}`)
    app.exit(1)
  })
