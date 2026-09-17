/**
 * 托盘：显示窗口 / 打开浏览器版 / 重启 Harness / 桌面插件 /
 * 设置（自动检测更新·检查更新·全局快捷键·日志·自启·通知·工作区·卸载）/ 退出。
 * 状态变化时重建菜单。
 * （0.4.0：仪表盘/终端开关已随面板移入 harness 插件，托盘不再控制。）
 */
import { Menu, nativeImage, Tray } from 'electron'
import type { AppSettings } from './settings'

export interface TrayDeps {
  getUrl: () => string | null
  getState: () => {
    autoStart: boolean
    notifications: boolean
    autoUpdate: boolean
    runningJobs: number
    harnessState: string
    globalShortcut: string
    appVersion: string
    harnessVersion: string | null
    lanShare: boolean
    lanUrl: string | null
    safeMode: boolean
    /** 最近一次 harness 启动失败摘要（ready 后清空） */
    lastHarnessError: string | null
    /** DeepSeek API Key 自检结果（null=检测中/未检测） */
    apiKey: { ok: boolean; detail: string; verdict: 'ok' | 'invalid' | 'unknown' } | null
    /** 桥接通道状态（壳 ↔ harness 唯一通道；诊断来自插件 bridge.diag 与握手回执） */
    bridge: {
      connected: boolean
      /** jobs 服务是否可见（null=未知）：不可见时徽标/任务通知不可用 */
      jobs: 'present' | 'absent' | null
      protocol: 'ok' | 'mismatch' | 'unknown'
      /** 待审批条数（approval.asked 入、approval.decided 出） */
      pending: number
      /** 最新诊断码（排障用；如 auth.rejected / ws.server.error） */
      lastCode: string | null
    }
    /** 最近会话（快照 + sessions.changed 增量；点击直达） */
    recentSessions: { id: string; label: string }[]
  }
  showWindow: () => void
  /** 点击托盘会话条目 / 待审批条目：跳到该会话（复用 dsh:// 深链路径） */
  openSession: (sessionId: string) => void
  openBrowser: () => void
  pickWorkspace: () => void
  restartHarness: () => void
  openLogs: () => void
  /** 重新扫描并修复历史会话日志（一次性迁移的强制重跑入口） */
  repairSessions: () => void
  checkUpdate: () => void
  cleanLogs: () => void
  uninstall: () => void
  /** 最新一条待审批所属会话；没有可跳转的目标时返回 null（托盘条目据此禁用） */
  pendingSessionId: () => string | null
  /** 打开官方插件页（Web 侧边栏「插件」）：官方设计里插件管理的唯一主场 */
  openPluginPage: () => void
  /** 托盘「退出安全模式」：恢复全部插件 */
  exitSafeMode: () => void
  /** 托盘「进入安全模式」：停用全部插件（仅系统必需） */
  enterSafeMode: () => void
  setAutoStart: (v: boolean) => void
  setNotifications: (v: boolean) => void
  setAutoUpdate: (v: boolean) => void
  setLanShare: (v: boolean) => void
  copyLanUrl: () => void
  quit: () => void
}

export interface TrayHandle {
  tray: Tray
  refresh: () => void
}

/** jobs 服务可见性的托盘文案。 */
function bridgeJobsLabel(jobs: 'present' | 'absent' | null): string {
  if (jobs === 'present') return 'jobs present'
  if (jobs === 'absent') return 'jobs 不可用（任务徽标/通知失效）'
  return 'jobs 未知'
}

export function createTray(iconPath: string, deps: TrayDeps): TrayHandle {
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createEmpty()
  const tray = new Tray(image)
  tray.setToolTip('DSH Desktop')

  const refresh = (): void => {
    const s = deps.getState()
    const url = deps.getUrl()
    const menu = Menu.buildFromTemplate([
      { label: '显示工作台', click: () => deps.showWindow() },
      { label: '打开浏览器版', enabled: !!url, click: () => deps.openBrowser() },
      { type: 'separator' },
      {
        label: `Harness: ${s.harnessState}${s.runningJobs > 0 ? `（${s.runningJobs} 个任务运行中）` : ''}`,
        enabled: false,
      },
      {
        // 桥接状态：通知/徽标/深链都走这条通道，"连上了吗、jobs 在不在"必须一眼可见
        label: s.bridge.connected
          ? `桥接：已连接 · ${bridgeJobsLabel(s.bridge.jobs)}${
              s.bridge.protocol === 'mismatch' ? ' ⚠ 协议不匹配' : s.bridge.protocol === 'unknown' ? ' ⚠ 版本未知' : ''
            }`
          : `桥接：未连接${s.bridge.lastCode ? `（${s.bridge.lastCode}）` : ''}`,
        enabled: false,
      },
      ...(s.bridge.pending > 0
        ? ([
            {
              label: `待审批：${s.bridge.pending} 条（点击查看）`,
              click: () => deps.openSession(deps.pendingSessionId() ?? ''),
              enabled: deps.pendingSessionId() !== null,
            },
          ] as const)
        : []),
      ...(s.recentSessions.length > 0
        ? ([
            {
              label: '最近会话',
              submenu: s.recentSessions.map((session) => ({
                label: session.label.length > 60 ? `${session.label.slice(0, 60)}…` : session.label,
                click: () => deps.openSession(session.id),
              })),
            },
          ] as const)
        : []),
      { label: '重启 Harness', click: () => deps.restartHarness() },
      {
        // DeepSeek API Key 自检状态（只读）：防止「key 失效/未落盘」被误判为配置错误
        label: s.apiKey
          ? s.apiKey.verdict === 'ok'
            ? `DeepSeek API Key：有效`
            : s.apiKey.verdict === 'invalid'
              ? 'DeepSeek API Key：无效（请到设置→模型更新）'
              : 'DeepSeek API Key：状态未知（网络/服务异常，见日志）'
          : 'DeepSeek API Key：检测中…',
        enabled: false,
      },
      {
        label: '桌面插件',
        submenu: [
          // 官方设计：插件管理只有一个主场——Web 侧边栏「插件」页（安装、启停、卸载、
          // 依赖脚本授权、包诊断都在那里）。托盘不再复制一套列表/开关/安装器，
          // 只保留原生恢复（安全模式）与这个「去哪儿管」的入口。
          {
            label: '在插件页管理（官方）…',
            click: () => deps.openPluginPage(),
          },
          { type: 'separator' as const },
          // 安全模式：状态 + 恢复入口（置于最前）
          ...(s.safeMode
            ? ([
                {
                  label: '⚠ 安全模式：仅系统必需插件运行',
                  enabled: false,
                },
                ...(s.lastHarnessError
                  ? [
                      {
                        label: `最近失败：${s.lastHarnessError}`,
                        enabled: false,
                      },
                    ]
                  : []),
                {
                  label: '退出安全模式（恢复全部插件）',
                  click: () => deps.exitSafeMode(),
                },
                { type: 'separator' as const },
              ] as const)
            : ([
                {
                  label: '进入安全模式（停用全部插件）',
                  click: () => deps.enterSafeMode(),
                },
              ] as const)),
        ],
      },
      { type: 'separator' },
      {
        label: '设置',
        submenu: [
          {
            // 总开关：开 = 冷启动自动检查下载（官方模型：壳 + dsh 运行时是一个签名更新单元）；
            // 关 = 仅手动。常显两个版本号便于核对绑定关系（框架 = 本次发版号，官方 Harness = 随包 dsh）
            label: `自动更新（框架 v${s.appVersion} · 官方 Harness v${s.harnessVersion ?? '—'}）`,
            type: 'checkbox' as const,
            checked: s.autoUpdate,
            click: (item) => deps.setAutoUpdate(item.checked),
          },
          {
            // 手动：检查桌面端更新（一处更新即同时换壳与随包 dsh 运行时）
            label: '检查并更新…',
            click: () => deps.checkUpdate(),
          },
          { type: 'separator' },
          // 局域网访问：壳内反向代理（固定端口），同网段设备经电脑授权后访问
          {
            label: '局域网访问（手机可访问，需本机授权）',
            type: 'checkbox' as const,
            checked: s.lanShare,
            click: (item) => deps.setLanShare(item.checked),
          },
          {
            label: s.lanShare
              ? `局域网地址：${s.lanUrl ?? '获取中…'}`
              : '局域网地址：未开启',
            enabled: !!s.lanUrl,
            click: () => deps.copyLanUrl(),
          },
          { type: 'separator' },
          {
            label: s.globalShortcut ? `全局快捷键：${s.globalShortcut}` : '全局快捷键：未启用',
            enabled: false,
          },
          { label: '切换工作区…', click: () => deps.pickWorkspace() },
          { type: 'separator' },
          { label: '查看日志', click: () => deps.openLogs() },
          { label: '重新修复旧会话日志', click: () => deps.repairSessions() },
          { label: '清理日志', click: () => deps.cleanLogs() },
          { type: 'separator' },
          {
            label: '开机自启',
            type: 'checkbox' as const,
            checked: s.autoStart,
            click: (item) => deps.setAutoStart(item.checked),
          },
          {
            label: '系统通知',
            type: 'checkbox' as const,
            checked: s.notifications,
            click: (item) => deps.setNotifications(item.checked),
          },
          { type: 'separator' },
          {
            label: '卸载 DSH Desktop…',
            visible: process.platform === 'win32',
            click: () => deps.uninstall(),
          },
        ],
      },
      { type: 'separator' },
      { label: '退出', click: () => deps.quit() },
    ])
    tray.setContextMenu(menu)
  }

  refresh()
  return { tray, refresh }
}
