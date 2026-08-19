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
 *  - 本地当前版本：resources/runtime.version 里的 dsh=…（随包分发，升级运行时后由 setup-runtime.mjs 重写）
 *  - 官方最新版本：registry.npmjs.org/@deepseek-ai%2Fdsh/latest -> { version }
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { log } from './logger'
import { notify } from './notify'
import { compareDots } from './version'
import { appDataRoot } from './runtime'

export const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest'
/** npmmirror 镜像（downloads 提速；检测用官方即可，失败再回退镜像）。 */
export const REGISTRY_MIRROR_URL = 'https://registry.npmmirror.com/@deepseek-ai/dsh/latest'
const TIMEOUT_MS = 10_000
/** 仅冷启动检查一次：启动后延迟此时长再查（等 harness 就绪、避免瞬时网络抖动）。 */
const FIRST_CHECK_DELAY_MS = 30_000

let timer: NodeJS.Timeout | null = null
let stopped = false

/** 读取已解压运行时的版本（%LOCALAPPDATA%/DSH Desktop/runtime .../dsh/package.json）。 */
async function installedRuntimeVersion(): Promise<string | null> {
  const pkg = path.join(appDataRoot(), 'DSH Desktop', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  try {
    const j = JSON.parse(await fs.readFile(pkg, 'utf8')) as { version?: unknown }
    return typeof j.version === 'string' ? j.version : null
  } catch {
    return null
  }
}

/** 读取当前 harness 版本：优先「已安装运行时」，回退随包 marker（dsh=...）。 */
export async function readLocalDshVersion(): Promise<string | null> {
  const installed = await installedRuntimeVersion()
  if (installed) return installed
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

/** 从 npm registry 拉取官方 dsh 最新 dist-tag 版本（官方失败回退 npmmirror 镜像）。 */
export async function fetchLatestDshVersion(): Promise<string | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const get = async (url: string): Promise<string | null> => {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`npm registry ${res.status}`)
    const data = (await res.json()) as { version?: string }
    return data.version ?? null
  }
  try {
    try {
      return await get(REGISTRY_URL)
    } catch (err) {
      log('info', `harnessCheck: official registry failed, fallback to mirror: ${err instanceof Error ? err.message : String(err)}`)
      return await get(REGISTRY_MIRROR_URL)
    }
  } catch (err) {
    log('error', `harnessCheck: fetch latest failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    clearTimeout(t)
  }
}

/**
 * 结构化检测：区分「有新版 / 已最新 / 查询失败」，供自动替换流程判断。
 */
export async function checkHarnessUpdateResult(): Promise<{
  ok: boolean
  local: string | null
  latest: string | null
  available: boolean
}> {
  const local = await readLocalDshVersion()
  const latest = await fetchLatestDshVersion()
  if (!local || !latest) {
    return { ok: false, local, latest, available: false }
  }
  return {
    ok: true,
    local,
    latest,
    available: compareDots(latest, local) > 0,
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
 * 初始化第 2 层：打包版启动后 30s 自动查「一次」（仅冷启动，不做周期轮询）；
 * 开发模式跳过。
 */
export function initHarnessCheck(): void {
  if (!app.isPackaged) {
    log('info', 'harnessCheck: dev mode, skipped')
    return
  }
  stopped = false
  timer = setTimeout(() => {
    timer = null
    if (!stopped) void checkHarnessUpdate()
  }, FIRST_CHECK_DELAY_MS)
  log('info', `harnessCheck: initialized (one-shot at ${FIRST_CHECK_DELAY_MS}ms after launch)`)
}

/** 关停一次性定时器（应用退出前调用，避免泄漏/退出后仍触发）。 */
export function stopHarnessCheck(): void {
  stopped = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
