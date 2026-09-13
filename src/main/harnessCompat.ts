/**
 * harness 版本兼容性记录（纯文件操作，路径由调用方传入，避免模块循环依赖）。
 *
 * 写入来源：安装前的启动探测（harnessUpdate → runtime.probeDesktopProfileBoot）与
 * 启动期的运行时自愈探测失败时调用。harness 更新流程读取本清单并跳过这些版本，
 * 避免反复「装几分钟再回滚」。
 *
 * 备注：本清单曾经由官方 CLI 的桌面 profile 守卫（`--profile desktop` 被拒）触发；
 * 本壳已改用自有 profile 名（见 desktopProfile.ts），该守卫不再影响本壳——改名时
 * 旧记录会被一次性清空（index.ts）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 不兼容版本清单文件（位于应用数据目录）。 */
export function incompatibleVersionsFile(appDataRootDir: string): string {
  return path.join(appDataRootDir, 'DSH Desktop', 'harness-incompatible.json')
}

/** 读取已知不兼容版本集合（文件缺失/损坏 → 空集）。 */
export function readIncompatibleVersions(file: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown
    if (Array.isArray(raw)) return new Set(raw.filter((v): v is string => typeof v === 'string'))
  } catch {
    /* 文件缺失/损坏：视为无记录 */
  }
  return new Set()
}

/** 记录一个不兼容版本（幂等；写失败静默）。 */
export function markIncompatibleVersion(file: string, version: string): boolean {
  try {
    const s = readIncompatibleVersions(file)
    if (s.has(version)) return false
    s.add(version)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify([...s].sort(), null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 清空不兼容版本记录（profile 改名后调用一次）。
 * 改名前的记录都是「CLI 拒绝 desktop profile」造成的，改用自有 profile 名后不再适用，
 * 若不清空会永久跳过 0.1.5+ 的正常版本。
 */
export function clearIncompatibleVersions(file: string): boolean {
  try {
    const s = readIncompatibleVersions(file)
    if (s.size === 0 && !existsSync(file)) return false
    rmSync(file, { force: true })
    return s.size > 0
  } catch {
    return false
  }
}
