/**
 * profile 依赖修复（唯一会动 `node_modules` 的壳侧动作）。
 *
 * 触发条件与动作（判定见 `profileDeps.ts`）：
 *  - **声明了依赖、包不在盘上** → 用随包 pnpm 跑一次 `pnpm install`（pnpm 自己文档给药方：
 *    store 换代后必须重装依赖才能重新链接）；成功后这些 bundle 又能被 harness 解析。
 *  - **盘上有 pnpm 不认、清单也没声明的插件残留** → 删掉那个目录（链接只删链接本身）。
 *  - pnpm install 失败（典型是离线/registry 不通）不阻塞启动：记日志、必要时通知一次，
 *    并按「状态指纹」避免每次冷启动都重跑同一次注定失败的修复（6 小时后允许重试）。
 *
 * 为什么由壳做：官方插件管理器的事务失败语义是「还原 `package.json` + `pnpm-lock.yaml`」，
 * `node_modules` 不回滚；而残留条目既不在清单里（插件页看不到、也删不了），又会挡住 bundle
 * 解析。壳只能在自己这一侧把盘面收敛回清单描述的状态。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  PROFILE_OWNED_PACKAGES,
  auditProfileDependencies,
  lockImporterDependencies,
  modulesManagedPackages,
  packagePathSegments,
  profilePnpmArgs,
  repairFingerprint,
  type ProfileDependencyReport,
} from './profileDeps.ts'
import { readTextNoBom } from './pluginfs.ts'

/** pnpm install 的硬超时（离线机器上 pnpm 自己会重试多次，这里给足但不能无限等）。 */
const PNPM_INSTALL_TIMEOUT_MS = 5 * 60_000

/** 同状态失败后的静默期：这段时间内不再重跑注定失败的修复。 */
const REPAIR_RETRY_INTERVAL_MS = 6 * 60 * 60_000

interface RepairMarker {
  fingerprint: string
  at: number
  ok: boolean
}

export interface ProfileRepairOptions {
  /** profile 目录（`$DSH_HOME/profiles/dsh-workbench`）。 */
  profileDir: string
  /** 随包 Node 可执行文件。 */
  node: string
  /** 随包 pnpm 入口（`resources/runtime/pnpm/bin/pnpm.cjs`）。 */
  pnpmEntry: string
  /** `$DSH_HOME`（pnpm store/state 目录在其中，与 Host 的 `packageManager` 同一处）。 */
  dshHome: string
  /** 修复标记文件（`userData/plugin-repair.json`）。 */
  markerFile: string
  /** 日志出口。 */
  log: (level: 'info' | 'error', message: string) => void
  /** 修复结果（仅在真的动手时回调）。 */
  onRepaired?: (result: ProfileRepairResult) => void
  /** 依赖注入（测试用）。 */
  spawnImpl?: typeof spawn
  now?: () => number
}

export interface ProfileRepairResult {
  /** 是否真的跑了 pnpm（false = 只清了残留 / 什么都没做）。 */
  installed: boolean
  installOk: boolean
  /** 已删除的残留插件目录（包名）。 */
  removed: string[]
  /** 体检结论。 */
  report: ProfileDependencyReport
  /** 人话摘要（日志与通知共用）。 */
  summary: string
}

/** 读 profile 的依赖清单（缺失/损坏时按空处理——不猜）。 */
function readDeclaredDependencies(profileDir: string): string[] {
  try {
    const manifest = JSON.parse(readTextNoBom(path.join(profileDir, 'package.json'))) as {
      dependencies?: Record<string, unknown>
    }
    return Object.keys(manifest.dependencies ?? {})
  } catch {
    return []
  }
}

/**
 * 列出 `node_modules` 里**能解析成包**的顶层名（作用域包展开到二级）。
 * 只认带 `package.json` 的目录/链接：空目录、pnpm 簿记条目一律不算包。
 */
export function listInstalledPackages(profileDir: string): string[] {
  const modulesDir = path.join(profileDir, 'node_modules')
  const names: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(modulesDir)
  } catch {
    return names
  }
  const hasManifest = (segments: string[]): boolean =>
    existsSync(path.join(modulesDir, ...segments, 'package.json'))
  for (const entry of entries) {
    if (entry === '.' || entry === '..') continue
    if (entry.startsWith('@')) {
      let children: string[]
      try {
        children = readdirSync(path.join(modulesDir, entry))
      } catch {
        continue
      }
      for (const child of children) {
        const segments = [entry, child]
        if (hasManifest(segments)) names.push(segments.join('/'))
      }
      continue
    }
    if (hasManifest([entry])) names.push(entry)
  }
  return names
}

function readModulesManaged(profileDir: string): string[] {
  try {
    return modulesManagedPackages(readTextNoBom(path.join(profileDir, 'node_modules', '.modules.yaml')))
  } catch {
    return []
  }
}

function readLockImports(profileDir: string): string[] | null {
  try {
    return lockImporterDependencies(readTextNoBom(path.join(profileDir, 'pnpm-lock.yaml')))
  } catch {
    return null
  }
}

/**
 * 这个顶层包「自报是 dsh 插件」吗（`package.json` 有 `dsh` 字段）。
 * 只对候选残留读盘——真机上绝大多数 `node_modules` 目录是提升上来的传递依赖，
 * 它们没有 `dsh` 字段，绝不能因为"不在清单里"被当成残留删掉（见 residueEntriesOf 的说明）。
 */
export function isDshPluginPackage(profileDir: string, name: string): boolean {
  try {
    const manifest = JSON.parse(
      readTextNoBom(path.join(profileDir, 'node_modules', ...packagePathSegments(name), 'package.json')),
    ) as { dsh?: unknown }
    return typeof manifest.dsh === 'object' && manifest.dsh !== null
  } catch {
    return false
  }
}

/** 体检（只读）：把 profile 的四方状态摆一起，给出报告。 */
export function inspectProfile(profileDir: string): ProfileDependencyReport {
  const declared = readDeclaredDependencies(profileDir)
  const installed = listInstalledPackages(profileDir)
  const managed = readModulesManaged(profileDir)
  // 候选 = 既没声明、pnpm 也没托管的目录（正常情况为空或一两个）；只对它们读 package.json
  const owned = new Set<string>(PROFILE_OWNED_PACKAGES)
  const declaredSet = new Set(declared)
  const managedSet = new Set(managed)
  const candidates = installed.filter((name) => !declaredSet.has(name) && !managedSet.has(name) && !owned.has(name))
  const pluginLike = candidates.filter((name) => isDshPluginPackage(profileDir, name))
  return auditProfileDependencies({
    declared,
    installed,
    managed,
    lockImports: readLockImports(profileDir),
    pluginLike,
    owned: PROFILE_OWNED_PACKAGES,
  })
}

function readMarker(file: string): RepairMarker | null {
  try {
    const value = JSON.parse(readTextNoBom(file)) as Partial<RepairMarker>
    if (typeof value.fingerprint !== 'string' || typeof value.at !== 'number' || typeof value.ok !== 'boolean') return null
    return { fingerprint: value.fingerprint, at: value.at, ok: value.ok }
  } catch {
    return null
  }
}

function writeMarker(file: string, marker: RepairMarker): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(marker, undefined, 2)}\n`, 'utf8')
  } catch {
    /* 标记写不进去只影响「重试节流」，不影响修复本身 */
  }
}

/**
 * 删除一个残留插件目录。
 * **链接只删链接本身**（Windows 的 junction 在 `lstat` 里就是符号链接）——
 * 否则 `rmSync(recursive)` 有可能顺着链接删掉被指向的真实目录（用户自己的开发目录）。
 */
function removeResidueEntry(profileDir: string, name: string, log: ProfileRepairOptions['log']): boolean {
  const target = path.join(profileDir, 'node_modules', ...packagePathSegments(name))
  try {
    if (lstatSync(target).isSymbolicLink()) unlinkSync(target)
    else rmSync(target, { recursive: true, force: true })
    return true
  } catch (error) {
    log('error', `profile repair: 删除残留 ${name} 失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** 跑一次随包 pnpm install（stdout/stderr 尾巴进日志，便于排障）。 */
function runPnpmInstall(options: ProfileRepairOptions): Promise<{ ok: boolean; tail: string }> {
  const spawnImpl = options.spawnImpl ?? spawn
  const stateDir = path.join(options.dshHome, 'desktop', 'pnpm')
  for (const dir of [path.join(stateDir, 'store'), path.join(stateDir, 'config')]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* pnpm 自己会报错 */
    }
  }
  const args = profilePnpmArgs(options.pnpmEntry, stateDir, 'install')
  return new Promise((resolve) => {
    let tail = ''
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve({ ok, tail: tail.trim() })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawnImpl(options.node, args, {
        cwd: options.profileDir,
        env: {
          ...process.env,
          // 与 Host 侧一致：registry / store 由参数给出，别让用户 npmrc 干扰
          npm_config_registry: 'https://registry.npmjs.org/',
          npm_config_store_dir: path.join(stateDir, 'store'),
          npm_config_userconfig: path.join(stateDir, 'config', 'npmrc'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(false)
      return
    }
    const append = (chunk: Buffer): void => {
      tail = `${tail}${chunk.toString('utf8')}`.slice(-4000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      options.log('error', 'profile repair: pnpm install 超时，放弃本次修复')
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish(false)
    }, PNPM_INSTALL_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code === 0)
    })
  })
}

/**
 * 体检 + 必要时修复（启动路径调用一次，**绝不抛错**：坏了也只是插件不可用）。
 * @returns 修复结果；不需要修复时返回 null。
 */
export async function repairProfileIfNeeded(options: ProfileRepairOptions): Promise<ProfileRepairResult | null> {
  const mode = process.env.DSH_DESKTOP_PROFILE_REPAIR
  if (mode === 'off' || mode === '0' || mode === 'false') return null
  const forced = mode === 'force'

  let report: ProfileDependencyReport
  try {
    report = inspectProfile(options.profileDir)
  } catch (error) {
    options.log('error', `profile repair: 体检失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (!report.needsRepair) return null

  const now = options.now ?? Date.now
  const fingerprint = repairFingerprint(report)
  const marker = readMarker(options.markerFile)
  if (!forced && marker !== null && marker.fingerprint === fingerprint && !marker.ok
    && now() - marker.at < REPAIR_RETRY_INTERVAL_MS) {
    options.log('info', 'profile repair: 同状态上次修复失败，静默期内跳过（联网或改动清单后会自动重试）')
    return null
  }

  options.log(
    'info',
    `profile repair: 需要修复（缺失 ${report.missing.length}｜残留 ${report.residue.length}｜锁文件脱节 ${report.lockDrift.length}${
      report.lockKnown ? '' : '｜锁文件未解析'
    }）`,
  )
  if (report.missing.length > 0) options.log('info', `profile repair: 声明但未安装：${report.missing.join(', ')}`)
  if (report.residue.length > 0) options.log('error', `profile repair: 插件残留（清单未声明、pnpm 不认）：${report.residue.join(', ')}`)

  // 1) 盘上残留：先清（与 pnpm install 互不依赖；清单没声明的东西不该留在 profile 里）
  const removed: string[] = []
  for (const name of report.residue) {
    if (removeResidueEntry(options.profileDir, name, options.log)) removed.push(name)
  }
  if (removed.length > 0) options.log('info', `profile repair: 已清理残留插件 ${removed.join(', ')}`)

  // 2) 让 node_modules / 锁文件回到清单描述的状态
  const needsInstall = report.missing.length > 0 || report.lockDrift.length > 0
  let installOk = true
  if (needsInstall) {
    options.log('info', 'profile repair: 运行随包 pnpm install（对齐清单与已装包）')
    const result = await runPnpmInstall(options)
    installOk = result.ok
    if (result.ok) options.log('info', 'profile repair: pnpm install 成功')
    else {
      options.log('error', `profile repair: pnpm install 失败（插件可能仍不可用）：${result.tail.slice(-500)}`)
    }
  }

  const summaryParts: string[] = []
  if (needsInstall) summaryParts.push(installOk ? `已按清单重装依赖（${String(report.declared.length)} 项）` : '依赖重装失败（检查网络后重启应用会重试）')
  if (removed.length > 0) summaryParts.push(`已清理残留插件 ${String(removed.length)} 个（${removed.join('、')}）`)
  const result: ProfileRepairResult = {
    installed: needsInstall,
    installOk,
    removed,
    report,
    summary: summaryParts.join('；') || '无需修复',
  }
  writeMarker(options.markerFile, { fingerprint, at: now(), ok: installOk })
  options.onRepaired?.(result)
  return result
}
