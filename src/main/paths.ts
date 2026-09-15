/**
 * 移植自 `deepseek-ai/deepseek-harness` `apps/desktop/src/paths.ts`（MIT）。
 *
 * [ported] 与上游的差异：
 *  1. 不依赖 `@deepseek-ai/dsh-home-paths`（上游包）：`dshHome` 改成必填参数，
 *     由调用方注入（本壳在 src/main/index.ts 的 dshHome() 里解析）；
 *  2. profile 目录名用本壳的 DESKTOP_PROFILE（`dsh-workbench`）而非官方保留名 `desktop`；
 *  3. 路径结构与目录布局逐字保留（root/lock/pnpm 私有目录）。
 *
 * 语义提醒：这些目录归 Electron 壳所有，解析本身不改动共享数据根
 * （`$DSH_HOME/sessions` 等仍与 CLI 版共用）。
 */

/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { DESKTOP_PROFILE } from './desktopProfile.ts'

/** Stable desktop installation paths under the shared Harness home. */
export interface DesktopPaths {
  readonly root: string
  readonly profile: string
  readonly lock: string
  readonly pnpm: {
    readonly root: string
    readonly store: string
    readonly cache: string
    readonly state: string
    readonly config: string
    readonly home: string
  }
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string): DesktopPaths {
  const root = join(dshHome, 'desktop')
  const pnpm = join(root, 'pnpm')
  const profile = join(dshHome, 'profiles', DESKTOP_PROFILE)
  return {
    root,
    profile,
    lock: join(profile, 'lock'),
    pnpm: {
      root: pnpm,
      store: join(pnpm, 'store'),
      cache: join(pnpm, 'cache'),
      state: join(pnpm, 'state'),
      config: join(pnpm, 'config'),
      home: join(pnpm, 'home'),
    },
  }
}
