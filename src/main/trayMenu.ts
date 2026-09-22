/**
 * 托盘菜单模板（纯逻辑，无 Electron 运行时依赖，可单测）。
 *
 * 0.8.2 重设计：菜单只留用户真正会用的动作——
 *
 *   显示工作台 / 打开浏览器版 / 手机连接（扫描二维码）… [ / 断开手机连接 ]
 *   ─── 一行状态（Harness · 桥接）
 *   重启 Harness / 进入安全模式（安全模式下换成恢复入口）
 *   设置 ▸（自动更新 · 检查更新 / 开机自启 · 系统通知 / 日志 / 卸载）
 *   退出
 *
 * 删掉的项与理由：
 *  - **桌面插件管理**：官方桌面端不提供插件管理 IPC/独立页面，安装/启停/卸载/依赖脚本
 *    授权全在 Web 侧边栏「插件」页（Host 内的官方共享管理器）。托盘只保留
 *    「进入安全模式」这个**原生恢复**动作——Host 起不来时插件页也打不开，这条必须留；
 *  - **切换工作区**：工作区是 harness 自己的注册表，添加/切换在 Web UI 里；
 *  - **最近会话 / 待审批 / API Key 状态行 / 任务数**：界面内更完整，托盘副本只会过期；
 *  - **局域网三行（开关 + 地址 + 复制）**：并成一条「手机连接（扫描二维码）…」；
 *  - **重新修复旧会话日志**：一次性历史迁移，启动时按 dsh 版本自动跑。
 */
import type { MenuItemConstructorOptions } from 'electron'
// 显式 .ts：既满足 esbuild 打包，也让 Node 直跑单测（test/tray-menu.test.mjs）
import { trayStatusLine, type TrayStatusState } from './trayStatus.ts'

export interface TrayState extends TrayStatusState {
  autoStart: boolean
  notifications: boolean
  autoUpdate: boolean
  appVersion: string
  harnessVersion: string | null
  safeMode: boolean
  /** 最近一次 harness 启动失败摘要（ready 后清空） */
  lastHarnessError: string | null
  /** 手机连接（局域网门面）是否开启 */
  phoneOn: boolean
  /**
   * profile 依赖体检发现的漂移（缺失/残留/锁文件脱节）；null = 干净。
   *
   * 只在**检测到漂移**时多出一条「修复插件环境…」。修复本身要用户点一下才跑：
   * 启动时静默跑 `pnpm install` 是"应用自己装软件"的形状，行为启发式（杀软 PDM）最敏感，
   * 也让用户无法预期机器上发生了什么（真机事故见 docs/ANTIVIRUS-FALSE-POSITIVE.md）。
   */
  pluginDrift: { missing: number; residue: number; lockDrift: number } | null
}

/** 菜单动作（由 index.ts 注入，模板只负责摆放）。 */
export interface TrayActions {
  showWindow: () => void
  /** 在系统默认浏览器打开工作台（回环地址 + 本次运行 token）。 */
  openBrowser: () => void
  /** 手机连接：按需拉起局域网门面并打开二维码窗口。 */
  openPhone: () => void
  /** 断开手机连接：关掉局域网门面并关闭二维码窗口。 */
  stopPhone: () => void
  restartHarness: () => void
  openLogs: () => void
  checkUpdate: () => void
  cleanLogs: () => void
  uninstall: () => void
  /** 托盘「退出安全模式」：恢复全部插件 */
  exitSafeMode: () => void
  /** 托盘「进入安全模式」：停用全部插件（仅系统必需） */
  enterSafeMode: () => void
  /** 托盘「修复插件环境」：用随包 pnpm 把 profile 依赖收敛回清单描述的状态。 */
  repairPlugins: () => void
  setAutoStart: (v: boolean) => void
  setNotifications: (v: boolean) => void
  setAutoUpdate: (v: boolean) => void
  quit: () => void
}

export function trayMenuTemplate(s: TrayState, a: TrayActions): MenuItemConstructorOptions[] {
  // 兼容旧调用方/测试夹具：缺字段按「无漂移」处理
  const drift = s.pluginDrift ?? null
  return [
    { label: '显示工作台', click: () => a.showWindow() },
    { label: '打开浏览器版', click: () => a.openBrowser() },
    { label: '手机连接（扫描二维码）…', click: () => a.openPhone() },
    // 断开入口只在开启时出现：平时不占位置，开着时又必须一眼看得到
    ...(s.phoneOn ? [{ label: '断开手机连接', click: () => a.stopPhone() }] : []),
    { type: 'separator' },
    { label: trayStatusLine(s), enabled: false },
    { type: 'separator' },
    { label: '重启 Harness', click: () => a.restartHarness() },
    // 安全模式：官方桌面端的原生恢复动作，也是托盘**唯一**保留的插件相关入口
    ...(s.safeMode
      ? [
          { label: '⚠ 安全模式：仅系统必需插件运行', enabled: false },
          ...(s.lastHarnessError ? [{ label: `最近失败：${s.lastHarnessError}`, enabled: false }] : []),
          { label: '退出安全模式（恢复全部插件）', click: () => a.exitSafeMode() },
        ]
      : [{ label: '进入安全模式（停用全部插件）', click: () => a.enterSafeMode() }]),
    // 依赖漂移入口：只在体检发现不一致时出现（干净时托盘里没有这一条）
    ...(drift === null
      ? []
      : [{
          label: `修复插件环境（缺失 ${String(drift.missing)} · 残留 ${String(drift.residue)}）…`,
          click: () => a.repairPlugins(),
        }]),
    { type: 'separator' },
    {
      label: '设置',
      submenu: [
        {
          // 总开关：开 = 冷启动自动检查下载（官方模型：壳 + dsh 运行时是一个签名更新单元）；
          // 关 = 仅手动。常显两个版本号便于核对绑定关系（框架 = 本次发版号，官方 Harness = 随包 dsh）
          label: `自动更新（框架 v${s.appVersion} · 官方 Harness v${s.harnessVersion ?? '—'}）`,
          type: 'checkbox',
          checked: s.autoUpdate,
          click: (item) => a.setAutoUpdate(item.checked),
        },
        { label: '检查更新…', click: () => a.checkUpdate() },
        { type: 'separator' },
        {
          label: '开机自启',
          type: 'checkbox',
          checked: s.autoStart,
          click: (item) => a.setAutoStart(item.checked),
        },
        {
          label: '系统通知',
          type: 'checkbox',
          checked: s.notifications,
          click: (item) => a.setNotifications(item.checked),
        },
        { type: 'separator' },
        { label: '打开日志目录', click: () => a.openLogs() },
        { label: '清理日志', click: () => a.cleanLogs() },
        ...(process.platform === 'win32'
          ? ([
              { type: 'separator' },
              { label: '卸载 DSH Desktop…', click: () => a.uninstall() },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    { type: 'separator' },
    { label: '退出', click: () => a.quit() },
  ]
}

/**
 * 菜单「可见状态」的指纹：只有它变了才值得重建菜单。
 *
 * 为什么必须有：壳在很多事件里调 `refreshTray()`（bridge 事件、会话目录变化、诊断…），
 * 而每次重建都会 `tray.setContextMenu(...)` —— **Windows 上菜单正开着时被替换，点击会丢**
 * （用户体感就是"点了没反应，要再点一次"，比如点「退出」）。0.8.2 起托盘里不含会话/任务数，
 * 那些事件其实完全不影响菜单内容，所以用指纹把它们挡掉。
 */
export function trayMenuSignature(s: TrayState): string {
  const drift = s.pluginDrift ?? null
  return JSON.stringify([
    trayStatusLine(s),
    s.phoneOn,
    s.safeMode,
    s.lastHarnessError,
    drift === null ? null : [drift.missing, drift.residue, drift.lockDrift],
    s.autoUpdate,
    s.autoStart,
    s.notifications,
    s.appVersion,
    s.harnessVersion,
    process.platform === 'win32',
  ])
}
