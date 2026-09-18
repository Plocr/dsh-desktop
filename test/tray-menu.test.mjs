import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trayMenuSignature, trayMenuTemplate } from '../src/main/trayMenu.ts'

/**
 * 托盘菜单结构 = 用户这轮的验收项，所以直接把它锁进测试：
 *  - 手机连接（扫描二维码）必须在，点击要真的走到 openPhone；
 *  - 桌面插件管理、切换工作区、最近会话、待审批、全局快捷键、旧会话修复**不得**再出现；
 *  - 设置子菜单精简（且不再套第二层子菜单）；
 *  - 安全模式是托盘里唯一保留的插件相关入口。
 */

const state = (over = {}) => ({
  autoStart: false,
  notifications: true,
  autoUpdate: true,
  appVersion: '0.8.2',
  harnessVersion: '0.1.6-alpha.2',
  safeMode: false,
  lastHarnessError: null,
  phoneOn: false,
  harnessState: '运行中',
  bridge: { connected: true, jobs: 'present', protocol: 'ok', lastCode: null },
  ...over,
})

/** 动作替身：记录调用顺序。 */
function actions() {
  const calls = []
  const record = (name) => () => calls.push(name)
  return {
    calls,
    a: {
      showWindow: record('showWindow'),
      openBrowser: record('openBrowser'),
      openPhone: record('openPhone'),
      stopPhone: record('stopPhone'),
      restartHarness: record('restartHarness'),
      openLogs: record('openLogs'),
      checkUpdate: record('checkUpdate'),
      cleanLogs: record('cleanLogs'),
      uninstall: record('uninstall'),
      exitSafeMode: record('exitSafeMode'),
      enterSafeMode: record('enterSafeMode'),
      setAutoStart: record('setAutoStart'),
      setNotifications: record('setNotifications'),
      setAutoUpdate: record('setAutoUpdate'),
      quit: record('quit'),
    },
  }
}

const labels = (items) => items.filter((i) => typeof i.label === 'string').map((i) => i.label)

test('托盘一级菜单：窗口 / 浏览器版 / 手机连接 / 状态 / 重启 / 安全模式 / 设置 / 退出', () => {
  const { a, calls } = actions()
  const menu = trayMenuTemplate(state(), a)
  assert.deepEqual(labels(menu), [
    '显示工作台',
    '打开浏览器版',
    '手机连接（扫描二维码）…',
    'Harness：运行中 · 桥接：已连接 · 任务可用',
    '重启 Harness',
    '进入安全模式（停用全部插件）',
    '设置',
    '退出',
  ])
  menu.find((i) => i.label === '打开浏览器版').click()
  menu.find((i) => i.label === '退出').click()
  assert.deepEqual(calls, ['openBrowser', 'quit'])
})

test('手机连接：点击走 openPhone；已开启时多出「断开手机连接」走 stopPhone', () => {
  const { a, calls } = actions()
  const menu = trayMenuTemplate(state({ phoneOn: true }), a)
  assert.ok(labels(menu).includes('断开手机连接'))
  menu.find((i) => i.label === '手机连接（扫描二维码）…').click()
  menu.find((i) => i.label === '断开手机连接').click()
  assert.deepEqual(calls, ['openPhone', 'stopPhone'])
  // 关闭时不该出现断开入口（精简）
  assert.ok(!labels(trayMenuTemplate(state({ phoneOn: false }), a)).includes('断开手机连接'))
})

test('托盘不再有：桌面插件管理 / 切换工作区 / 最近会话 / 待审批 / 全局快捷键 / 旧会话修复', () => {
  const { a } = actions()
  const flat = []
  for (const item of trayMenuTemplate(state(), a)) {
    for (const label of labels([item])) flat.push(label)
    if (Array.isArray(item.submenu)) for (const label of labels(item.submenu)) flat.push(label)
  }
  const banned = ['桌面插件', '插件页', '插件管理', '切换工作区', '最近会话', '待审批', '全局快捷键', '重新修复', 'API Key', '局域网']
  for (const word of banned) {
    assert.ok(!flat.some((label) => label.includes(word)), `托盘仍含被移除的项：${word}`)
  }
})

test('安全模式：托盘里唯一保留的插件相关入口，进入/退出互相替换', () => {
  const { a, calls } = actions()
  const normal = trayMenuTemplate(state(), a)
  normal.find((i) => i.label === '进入安全模式（停用全部插件）').click()
  assert.deepEqual(calls, ['enterSafeMode'])
  assert.ok(!labels(normal).some((l) => l.includes('安全模式：仅系统必需')))

  const safe = trayMenuTemplate(state({ safeMode: true, lastHarnessError: 'Error: bad plugin' }), a)
  const safeLabels = labels(safe)
  assert.ok(safeLabels.includes('⚠ 安全模式：仅系统必需插件运行'))
  assert.ok(safeLabels.includes('最近失败：Error: bad plugin'))
  assert.ok(!safeLabels.includes('进入安全模式（停用全部插件）'))
  safe.find((i) => i.label === '退出安全模式（恢复全部插件）').click()
  assert.deepEqual(calls, ['enterSafeMode', 'exitSafeMode'])
})

test('设置子菜单精简：无第二层子菜单，每项都是动作或开关', () => {
  const { a, calls } = actions()
  const settings = trayMenuTemplate(state(), a).find((i) => i.label === '设置')
  assert.ok(Array.isArray(settings.submenu))
  assert.deepEqual(labels(settings.submenu), [
    '自动更新（框架 v0.8.2 · 官方 Harness v0.1.6-alpha.2）',
    '检查更新…',
    '开机自启',
    '系统通知',
    '打开日志目录',
    '清理日志',
    ...(process.platform === 'win32' ? ['卸载 DSH Desktop…'] : []),
  ])
  for (const item of settings.submenu) {
    if (item.type === 'separator') continue
    assert.equal(typeof item.click, 'function', `设置项缺少点击动作：${String(item.label)}`)
    assert.equal(item.submenu, undefined, `设置里不该再有子菜单：${String(item.label)}`)
  }
  settings.submenu.find((i) => i.label === '检查更新…').click()
  // 复选项由 Electron 传入（checked 为勾选后的状态），这里照契约喂一个
  settings.submenu.find((i) => i.label === '开机自启').click({ checked: true })
  assert.deepEqual(calls, ['checkUpdate', 'setAutoStart'])
  const auto = settings.submenu.find((i) => String(i.label).startsWith('自动更新'))
  assert.equal(auto.type, 'checkbox')
  assert.equal(auto.checked, true)
  auto.click({ checked: false })
  assert.deepEqual(calls, ['checkUpdate', 'setAutoStart', 'setAutoUpdate'])
})

test('每个一级项要么是动作，要么是明确禁用的状态行，要么是分隔线', () => {
  const { a } = actions()
  for (const item of trayMenuTemplate(state(), a)) {
    if (item.type === 'separator') continue
    if (item.label === '设置') {
      assert.ok(Array.isArray(item.submenu))
      continue
    }
    assert.ok(typeof item.click === 'function' || item.enabled === false, `死项：${String(item.label)}`)
  }
})

test('菜单指纹：内容没变就不重建（避免开着菜单被替换导致点击丢失）', () => {
  const base = trayMenuSignature(state())
  // 与菜单无关的变化（会话/任务数/待审批这类 0.8.2 起已不在托盘里的信息）不影响指纹
  assert.equal(trayMenuSignature(state({ harnessState: '运行中' })), base)
  // 影响菜单内容的变化必须改变指纹
  assert.notEqual(trayMenuSignature(state({ phoneOn: true })), base)
  assert.notEqual(trayMenuSignature(state({ safeMode: true })), base)
  assert.notEqual(trayMenuSignature(state({ lastHarnessError: 'Error: boom' })), base)
  assert.notEqual(trayMenuSignature(state({ autoUpdate: false })), base)
  assert.notEqual(trayMenuSignature(state({ harnessVersion: null })), base)
  assert.notEqual(
    trayMenuSignature(state({ bridge: { connected: false, jobs: null, protocol: 'unknown', lastCode: 'auth.rejected' } })),
    base,
  )
  assert.notEqual(trayMenuSignature(state({ bridge: { connected: true, jobs: 'absent', protocol: 'ok', lastCode: null } })), base)
})
