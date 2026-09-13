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
import { compareDots, maxVersion } from './version'
import { appDataRoot } from './runtime'
import { isTreeConsistent, readRuntimeTreeState, treeVersions } from './runtimeTree'
import { readTextNoBom } from './pluginfs'
import {
  incompatibleVersionsFile as compatFile,
  markIncompatibleVersion as markCompatVersion,
  readIncompatibleVersions as readCompatVersions,
} from './harnessCompat'

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

/** 已知与本壳不兼容的 harness 版本清单文件（探测失败时记录）。 */
export function incompatibleVersionsFile(): string {
  return compatFile(appDataRoot())
}

/**
 * 读取已知不兼容版本集合。
 * 由启动探测写入（harnessUpdate 的替换前探测 / 启动期运行时自愈探测）：某个版本
 * 无法用本壳 profile 启动时记入，本层选「最新可用版本」时直接跳过，避免反复
 * 「装几分钟再回滚」。详见 harnessCompat.ts。
 */
export function readIncompatibleVersions(): Set<string> {
  return readCompatVersions(incompatibleVersionsFile())
}

/** 记录一个不兼容版本（后续检查选版时跳过）。 */
export function markIncompatibleVersion(version: string): void {
  if (markCompatVersion(incompatibleVersionsFile(), version)) {
    log('error', `harnessCheck: 记录不兼容版本 ${version}（后续更新将跳过该版本）`)
  }
}

/** 从 npm registry 拉取官方 dsh 最新已发布版本（官方失败回退 npmmirror 镜像）。 */
export async function fetchLatestDshVersion(): Promise<string | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const excluded = readIncompatibleVersions()
  const get = async (url: string): Promise<string | null> => {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/vnd.npm.install-v1+json' } })
    if (!res.ok) throw new Error(`npm registry ${res.status}`)
    const data = (await res.json()) as {
      versions?: Record<string, unknown>
      'dist-tags'?: Record<string, string>
    }
    const best = maxVersion(Object.keys(data.versions ?? {}), excluded)
    if (best !== null) return best
    const tagVals = Object.values(data['dist-tags'] ?? {}).filter((t): t is string => typeof t === 'string' && !excluded.has(t))
    if (tagVals.length > 0) {
      let fallback = tagVals[0]
      for (const v of tagVals) if (compareDots(v, fallback) > 0) fallback = v
      return fallback
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

/** 运行时目录（%LOCALAPPDATA%/DSH Desktop/runtime）。 */
export function runtimeDirPath(): string {
  return path.join(appDataRoot(), 'DSH Desktop', 'runtime')
}

/**
 * 本地运行时整树一致性（@deepseek-ai/* 锁步包是否同版本线）。
 * 混血树（如 dsh 已升、兄弟包仍旧）即使 dsh 版本已最新也不可用，视为需修复。
 * 目录不存在 / 无锁步包时视为一致（无树可查，不误判）。
 */
export async function localTreeConsistent(): Promise<boolean> {
  const versions = treeVersions(readRuntimeTreeState(runtimeDirPath()))
  return isTreeConsistent(versions)
}

/**
 * 更新可用性判定：见 src/main/version.ts（纯函数，便于单测）。
 */
import { updateAvailable } from './version'
export { updateAvailable }

/**
 * 结构化检测：区分「有新版 / 已最新 / 查询失败」，供自动替换流程判断。
 */
export async function checkHarnessUpdateResult(): Promise<{
  ok: boolean
  local: string | null
  latest: string | null
  available: boolean
  consistent: boolean
}> {
  const local = await readLocalDshVersion()
  const latest = await fetchLatestDshVersion()
  const consistent = await localTreeConsistent()
  if (!local || !latest) {
    return { ok: false, local, latest, available: false, consistent }
  }
  return {
    ok: true,
    local,
    latest,
    available: updateAvailable(local, latest, consistent),
    consistent,
  }
}
