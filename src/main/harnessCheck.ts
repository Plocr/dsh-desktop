/**
 * 第 2 层更新检测：官方 harness（@deepseek-ai/dsh）是否有更新的已发布版本。
 *
 * 背景：官方仓库没有 Release，harness 通过 npm 分发。官方并不总是刷新
 * `latest` dist-tag（例如 rc.8 已发布但 latest 仍指 rc.7）——所以这里不依赖
 * dist-tag，而是**枚举全部已发布版本、取 semver 最大的一个**作为「最新」。
 *
 * 本层只负责「检测 + 供上层决定是否本地替换」；版本来源：
 *  - 本地当前版本：优先 readLocalDshVersion（已解压运行时 package.json，
 *    回退 resources/runtime.version 的 dsh=…）
 *  - 官方最新版本：registry packument 的 versions 最大值（官方失败回退 npmmirror 镜像）
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { log } from './logger'
import { compareDots } from './version'
import { appDataRoot } from './runtime'

/** packument 元数据（含全部 versions / dist-tags）。 */
export const REGISTRY_META_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh'
export const REGISTRY_MIRROR_META_URL = 'https://registry.npmmirror.com/@deepseek-ai/dsh'
const TIMEOUT_MS = 10_000

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

/** 从 npm registry 拉取官方 dsh 最新已发布版本（官方失败回退 npmmirror 镜像）。 */
export async function fetchLatestDshVersion(): Promise<string | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const get = async (url: string): Promise<string | null> => {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/vnd.npm.install-v1+json' } })
    if (!res.ok) throw new Error(`npm registry ${res.status}`)
    const data = (await res.json()) as {
      versions?: Record<string, unknown>
      'dist-tags'?: Record<string, string>
    }
    const semverish = Object.keys(data.versions ?? {}).filter((v) => /^\d+\.\d+\.\d+/.test(v))
    if (semverish.length > 0) {
      let best = semverish[0]
      for (const v of semverish) if (compareDots(v, best) > 0) best = v
      return best
    }
    const tagVals = Object.values(data['dist-tags'] ?? {}).filter((t): t is string => typeof t === 'string')
    if (tagVals.length > 0) {
      let best = tagVals[0]
      for (const v of tagVals) if (compareDots(v, best) > 0) best = v
      return best
    }
    return null
  }
  try {
    try {
      return await get(REGISTRY_META_URL)
    } catch (err) {
      log('info', `harnessCheck: official registry failed, fallback to mirror: ${err instanceof Error ? err.message : String(err)}`)
      return await get(REGISTRY_MIRROR_META_URL)
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
