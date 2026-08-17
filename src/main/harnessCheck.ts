/**
 * 第 2 层更新检测：官方 harness（@deepseek-ai/dsh）是否有新的稳定可用版本。
 *
 * 背景：官方仓库目前没有 Release，harness 通过 npx / npm install 分发，
 * 所以「官方最新版」以 npm registry 的 dist-tag 为准——这正是
 * `npx @deepseek-ai/dsh` / `npm install @deepseek-ai/dsh` 会装到的版本。
 *
 * 本层只做「提示」，绝不自动替换：官方发布节奏/兼容性未定，自动升级运行时
 * 可能破坏已装用户。检测结果仅用于在桌面端提示「官方 harness 有新版」。
 *
 * 版本来源：
 *  - 本地当前版本：resources/runtime.version 里的 dsh=0.1.0-rc.6（随包分发）
 *  - 官方最新版本：registry.npmjs.org/@deepseek-ai%2Fdsh/latest -> { version }
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { log } from './logger'
import { notify } from './notify'
import { compareDots } from './version'

const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest'
const TIMEOUT_MS = 10_000
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 每天一次

let timer: NodeJS.Timeout | null = null
let stopped = false

/** 读取随包分发的 runtime.version，解析出本地 harness 版本（dsh=...）。 */
async function readLocalDshVersion(): Promise<string | null> {
  try {
    const resource = process.resourcesPath
    const bytes = await fs.readFile(path.join(resource, 'runtime.version'), 'utf8')
    const m = /(?:^|\n)dsh=(\S+)/.exec(bytes)
    return m ? m[1] : null
  } catch (err) {
    log('error', `harnessCheck: read runtime.version failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** 从 npm registry 拉取官方 dsh 最新 dist-tag 版本。 */
async function fetchLatestDshVersion(): Promise<string | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`npm registry ${res.status}`)
    const data = (await res.json()) as { version?: string }
    return data.version ?? null
  } catch (err) {
    log('error', `harnessCheck: fetch latest failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    clearTimeout(t)
  }
}

/**
 * 执行一次官方 harness 更新检测。返回 human-readable 结果，供托盘手动检查展示。
 */
export async function checkHarnessUpdate(): Promise<string> {
  const local = await readLocalDshVersion()
  const latest = await fetchLatestDshVersion()
  if (!local || !latest) {
    return latest === null ? '官方 harness 版本查询失败（网络/registry 不可达）' : '无法读取本地 harness 版本'
  }
  if (latest === local) {
    return `官方 harness 已是最新（${local}）`
  }
  if (compareDots(latest, local) > 0) {
    const msg = `官方 harness 有新版：本地 ${local} → 最新 ${latest}`
    log('info', `harnessCheck: ${msg}`)
    notify('检测到官方 harness 更新', msg, () => undefined)
    return msg
  }
  return `本地 harness 版本（${local}）不晚于官方最新（${latest}）`
}

/**
 * 初始化第 2 层：打包版每 24h 自动查一次；开发模式跳过。
 */
export function initHarnessCheck(): void {
  if (!app.isPackaged) {
    log('info', 'harnessCheck: dev mode, skipped')
    return
  }
  stopped = false
  const run = () => void checkHarnessUpdate()
  // 启动 30s 后首查，之后每 24h 一次
  setTimeout(() => {
    if (!stopped) run()
  }, 30_000)
  timer = setInterval(() => {
    if (!stopped) run()
  }, CHECK_INTERVAL_MS)
  timer.unref?.()
  log('info', 'harnessCheck: initialized (daily official-harness check)')
}

/** 关停计时器（应用退出前调用，避免泄漏）。 */
export function stopHarnessCheck(): void {
  stopped = true
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
