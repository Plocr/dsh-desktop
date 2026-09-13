/**
 * 运行时依赖树状态（纯逻辑 + 少量 fs，无 Electron 依赖，可单测）。
 *
 * 一致性定义：官方 @deepseek-ai/* 包为锁步发布（同一 rc 线所有包同版本），
 * 因此「一致树」= 所有带 -rc. 预发布段的 @deepseek-ai 包版本完全相同。
 * cordis / cosmokit / schemastery 等稳定版（无预发布段）scoped 包，以及
 * node-addon-* 等非 @deepseek-ai 锁步包，天然被排除在判定之外。
 *
 * 用途：
 *  - shouldExtractBundled：用户自更新标记下，树不一致（混血）视为残缺 → 回退内置运行时；
 *  - harnessCheck：版本检测同时报告树一致性，混血树即使 dsh 版本相同也触发重建；
 *  - harnessUpdate：整树刷新后把新树指纹写进用户标记。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { readTextNoBom } from './pluginfs.ts'

/** 一棵运行时树里的一个锁步包（作用域名 + 版本）。 */
export interface RuntimeTreeEntry {
  name: string
  version: string
}

/** 仅关注带预发布段的锁步包（@deepseek-ai/* 且版本含 -rc.）。 */
function isLockstepVersion(version: string): boolean {
  return /-rc\./.test(version)
}

/**
 * 扫描运行时目录下的 @deepseek-ai/* 包版本（仅锁步包，按包名排序）。
 * 目录不存在 / 包损坏时跳过；返回空数组表示「无树可查」。
 * @param runtimeDir - %LOCALAPPDATA%/DSH Desktop/runtime。
 * @returns 排序后的锁步包条目。
 */
export function readRuntimeTreeState(runtimeDir: string): RuntimeTreeEntry[] {
  const scopeDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai')
  const out: RuntimeTreeEntry[] = []
  let names: string[] = []
  try {
    names = readdirSync(scopeDir)
  } catch {
    return out
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const pkgPath = path.join(scopeDir, name, 'package.json')
    try {
      const pkg = JSON.parse(readTextNoBom(pkgPath)) as { version?: unknown }
      if (typeof pkg.version === 'string' && isLockstepVersion(pkg.version)) {
        out.push({ name: `@deepseek-ai/${name}`, version: pkg.version })
      }
    } catch {
      /* 跳过无法解析的包 */
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

/** 提取版本数组（供一致性判定）。 */
export function treeVersions(state: RuntimeTreeEntry[]): string[] {
  return state.map((entry) => entry.version)
}

/**
 * 树一致性：非空且所有锁步包版本完全相同 → 一致。
 * 空数组（无树可查）视为一致，避免误判为残缺。
 */
export function isTreeConsistent(versions: string[]): boolean {
  if (versions.length === 0) return true
  const first = versions[0]
  return versions.every((version) => version === first)
}

/**
 * 整树指纹：排序后 name@version 逐行 sha256 前 16 位。
 * 内部先按 name 排序，调用方传序无关；用于用户自更新标记记录
 * 「这份树长什么样」，供后续一致性比对。
 */
export function treeFingerprint(state: RuntimeTreeEntry[]): string {
  const sorted = [...state].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const hash = createHash('sha256')
  for (const entry of sorted) hash.update(`${entry.name}@${entry.version}\n`)
  return hash.digest('hex').slice(0, 16)
}
