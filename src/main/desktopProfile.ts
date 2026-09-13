/**
 * 桌面壳的 harness profile 名与目录迁移（纯 Node，可单测）。
 *
 * 为什么不用 `desktop`：@deepseek-ai/dsh 自 0.1.5-alpha.1 起在 CLI 里硬编码拒绝
 * `--profile desktop`（`profile "desktop" is managed exclusively by the Electron
 * application`，无环境变量旁路），官方把该名字留给自家 Electron 应用。本壳是独立外壳，
 * 改用自有名 `dsh-workbench` 后可正常使用 0.1.5+（否则只能停在 0.1.3-alpha.2）。
 *
 * 迁移：首次启动把旧目录 `$DSH_HOME/profiles/desktop` 整体改名为新名，保留用户已装的
 * 组合包与 cordis.patch.yml；目标已存在时不动（幂等）。
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'

/** 本壳使用的 profile 名（勿改成官方保留名 `desktop`）。 */
export const DESKTOP_PROFILE = 'dsh-workbench'

/** 历史 profile 名（官方保留名，CLI 拒绝启动；仅用于迁移）。 */
export const LEGACY_PROFILE = 'desktop'

/** profile 根目录（`$DSH_HOME/profiles`）。 */
export function profilesRoot(dshHome: string): string {
  return path.join(dshHome, 'profiles')
}

/** 本壳 profile 目录（`$DSH_HOME/profiles/<DESKTOP_PROFILE>`）。 */
export function desktopProfileDir(dshHome: string): string {
  return path.join(profilesRoot(dshHome), DESKTOP_PROFILE)
}

/** 旧 profile 目录（`$DSH_HOME/profiles/desktop`）。 */
export function legacyProfileDir(dshHome: string): string {
  return path.join(profilesRoot(dshHome), LEGACY_PROFILE)
}

/**
 * 一次性迁移：profiles/desktop → profiles/<DESKTOP_PROFILE>。
 * @returns 是否实际执行了改名（调用方据此清理旧的兼容性记录）。
 */
export function migrateLegacyProfileDir(dshHome: string): boolean {
  const legacy = legacyProfileDir(dshHome)
  const target = desktopProfileDir(dshHome)
  if (!existsSync(legacy) || existsSync(target)) return false
  // 只迁移真正的 profile（含 package.json），避免误搬残缺目录
  try {
    if (!existsSync(path.join(legacy, 'package.json'))) return false
  } catch {
    return false
  }
  try {
    renameSync(legacy, target)
    return true
  } catch {
    return false
  }
}

/** 读取 profile manifest 里的 dsh 版本线（诊断用；失败返回 null）。 */
export function readProfileName(dshHome: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(desktopProfileDir(dshHome), 'package.json'), 'utf8')) as {
      name?: unknown
    }
    return typeof pkg.name === 'string' ? pkg.name : null
  } catch {
    return null
  }
}
