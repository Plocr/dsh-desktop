/**
 * 桌面 profile 的组合与恢复（纯 Node，无 electron 依赖，可单测）。
 *
 * 本模块只负责三件事，全部围绕「Electron 拥有的那个 profile」：
 *  1. 读 `dsh.profile.bundles` 并清理失效条目（`pruneStaleProfileBundles`）；
 *  2. 安全模式的隔离与恢复（`isolateProfileForSafeMode` / `restoreProfileManifest`）
 *     ——等价于官方桌面端的原生恢复「禁用第三方 bundle、保留已装包」；
 *  3. 供 settings / safeMode / theme 复用的去 BOM 文本读取（`readTextNoBom`）。
 *
 * **插件的安装、启停、卸载不在这里**：那是 Host 进程里官方共享插件管理器
 * （Web 侧边栏「插件」页 / `plugin_manager` 工具）的职责，桌面壳只提供 profile
 * 与原生恢复通道——与官方桌面端「Electron 不提供插件管理 IPC 或独立管理页面」一致。
 * 壳也不再自己跑 pnpm：包操作全部由官方管理器用启动器提供的随包 pnpm 执行。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 读取文本文件并去掉 UTF-8 BOM（Windows 记事本/部分编辑器保存的 JSON 带 BOM，
 * 直接 JSON.parse 会抛错并导致「静默回退默认值」）。文件不存在时抛错，由调用方捕获。
 */
export function readTextNoBom(file: string): string {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')
}

/** 系统必需的 bridge 插件包名（随包、永不可卸：壳 ↔ harness 的唯一通道）。 */
export const BRIDGE_PLUGIN_NAME = 'dsh-desktop-bridge'

/** 官方桌面 profile 内置 bundle。 */
const OFFICIAL_DESKTOP_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * 基线 bundle：官方两项 + 本壳 bridge，永不移出 bundles。
 * bridge 是运行时共享包（junction 链接，**不在 dependencies 里**），因此对它的
 * 「是否仍是依赖」判断必须跳过——官方模型里 bundles 本来就可以含非依赖项。
 */
const BUILTIN_BUNDLES = new Set([...OFFICIAL_DESKTOP_BUNDLES, BRIDGE_PLUGIN_NAME])

/** profile manifest 里本模块用到的字段。 */
interface ProfileManifestLike {
  dependencies?: Record<string, unknown>
  dsh?: { profile?: { bundles?: string[] } }
}

/** 读取 profile manifest；缺失/损坏返回 null（调用方按「无组合」处理）。 */
function readProfileManifestLike(profileDir: string): ProfileManifestLike | null {
  try {
    return JSON.parse(readTextNoBom(path.join(profileDir, 'package.json'))) as ProfileManifestLike
  } catch {
    return null
  }
}

/** 写回 bundles 列表（写失败保持内存结果，不抛）。 */
function writeProfileBundlesList(profileDir: string, manifest: ProfileManifestLike, bundles: string[]): void {
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
  try {
    writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  } catch {
    /* 写失败保持内存结果 */
  }
}

/**
 * 读取 profile 的 `dsh.profile.bundles`（官方插件管理器维护的启用列表）。读取失败返回空数组。
 */
export function readProfileBundles(profileDir: string): string[] {
  const manifest = readProfileManifestLike(profileDir)
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles.filter((x): x is string => typeof x === 'string') : []
}

/**
 * 解析根：一个 profile bundle 能从哪里被找到。
 *
 * harness 自己按「profile `node_modules` → dsh 安装树」两处解析 bundle 名
 * （官方 `dsh` 的 `cannot resolve profile bundle` 报错原文里就是这两个来源），
 * 所以壳的对账必须用同一套来源判断，否则会出现「壳认为这项有效、harness 却解不出来」。
 */
function bundleResolveRoots(profileDir: string, extraRoots: readonly string[] = []): string[] {
  return [path.join(profileDir, 'node_modules'), ...extraRoots]
}

/**
 * 这个 bundle 名此刻真的能被 harness 解析出来吗。
 *
 * 只看 `<root>/<name>/package.json` 是否存在（junction/符号链接同样算存在——
 * 共享包就是这样链接进 profile 的）。
 *
 * **为什么必须查这一步**：`dsh.profile.bundles` 里的条目在 harness 侧是硬依赖——
 * 解不出来时 0.1.7 之前的 desktop-host 会直接 fatal（→ 壳连续失败 → 误入安全模式），
 * 0.1.7 起退化成一行 stderr 警告（插件静默缺席）。两种情况都不是用户想要的，
 * 而「声明了依赖、包却没装上」（卸载/回滚只还原了 `package.json`，`node_modules` 没跟上）
 * 正是产生这种条目的典型路径。
 */
export function isBundleResolvable(
  name: string,
  profileDir: string,
  extraRoots: readonly string[] = [],
): boolean {
  for (const root of bundleResolveRoots(profileDir, extraRoots)) {
    if (existsSync(path.join(root, ...name.split('/'), 'package.json'))) return true
  }
  return false
}

/**
 * 清理失效条目：`bundles` 里**已不再是 profile 依赖**或**已经解析不出来**的项移出，
 * 其余（含用户停用的状态）原样保留。
 *
 * **绝不激活**任何依赖——`dsh.profile.bundles` 是插件启停的唯一事实来源，官方插件管理器
 * 用「关闭 = 移出列表、保留依赖」实现停用；启动时按依赖重新塞回列表，等于把用户停用的
 * 组合包在下次启动悄悄打开。安装新组合包后的启用由官方管理器自己完成。
 *
 * 解析检查是 0.8.5 补上的（见 `isBundleResolvable`）：只按依赖判断会漏掉
 * 「依赖声明还在、包已不在盘上」这一档，而它恰好是 harness 报
 * `cannot resolve profile bundle …` 的唯一来源。移出列表不会卸载任何东西
 * （依赖与 `node_modules` 原样保留），插件在官方「插件」页里仍可见、可重装/重新启用。
 *
 * @param profileDir - 桌面 profile 目录。
 * @param extraRoots - 额外解析根（壳传随包 dsh 树的 `node_modules`：第一方 bundle 在那里）。
 * @returns 清理后的 bundles 列表。
 */
export function pruneStaleProfileBundles(profileDir: string, extraRoots: readonly string[] = []): string[] {
  const manifest = readProfileManifestLike(profileDir)
  if (manifest === null) return readProfileBundles(profileDir)
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  const dependencies = manifest.dependencies ?? {}
  let changed = false
  for (const name of [...bundles]) {
    if (BUILTIN_BUNDLES.has(name)) continue
    if (!(name in dependencies) || !isBundleResolvable(name, profileDir, extraRoots)) {
      bundles.splice(bundles.indexOf(name), 1)
      changed = true
    }
  }
  if (!changed) return bundles
  writeProfileBundlesList(profileDir, manifest, bundles)
  return bundles
}

/**
 * 安全模式隔离：备份当前 manifest 到 `package.json.safemode.bak`，并把 bundles
 * 收窄到「官方基线 + bridge」（dependencies 保留）；同时把用户 patch 层
 * `cordis.patch.yml` 移出（改名 `cordis.patch.yml.safemode.bak`），让下次启动从一个
 * **空的 patch** 开始——坏 patch 与坏插件一样会让组合树起不来，这是官方
 * `sanitizeProfile` 的恢复语义（官方把 patch 备份后不解析；本壳在显式「退出安全模式」
 * 时把备份还原回去，因为那是用户主动要求回到进入前的状态）。
 *
 * @returns 是否成功进入隔离状态。
 */
export function isolateProfileForSafeMode(profileDir: string): boolean {
  const pkgFile = path.join(profileDir, 'package.json')
  const backupPath = path.join(profileDir, 'package.json.safemode.bak')
  try {
    const manifest = readTextNoBom(pkgFile)
    // 只在首次进入时建立还原点：备份已存在则一律保留。
    // （安全模式期间 manifest 会被多方改写，若在此覆盖会把「进入前的原始清单」丢掉，
    //   退出安全模式时还原成错误内容 → 用户插件列表静默丢失）
    if (!existsSync(backupPath)) {
      writeFileSync(backupPath, manifest, 'utf8')
    }
    const m = JSON.parse(manifest) as ProfileManifestLike
    writeProfileBundlesList(profileDir, m, [...OFFICIAL_DESKTOP_BUNDLES, BRIDGE_PLUGIN_NAME])
    quarantineProfilePatch(profileDir)
    return true
  } catch {
    return false
  }
}

/**
 * 把用户 patch 层移出 profile（安全模式期间不使用坏 patch）。
 * 已有备份时保留原备份（与 manifest 还原点同样的「首次进入才建立」规则）。
 */
function quarantineProfilePatch(profileDir: string): void {
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  const backupPath = path.join(profileDir, 'cordis.patch.yml.safemode.bak')
  if (!existsSync(patchPath) || existsSync(backupPath)) return
  try {
    renameSync(patchPath, backupPath)
  } catch {
    /* 移不动就保持原状：安全模式仍靠 bundles 收窄兜底 */
  }
}

/**
 * 恢复 profile manifest（退出安全模式时还原进入前的 bundles/dependencies 与用户 patch）。
 * 备份文件不存在时返回 false。
 */
export function restoreProfileManifest(profileDir: string): boolean {
  const backupPath = path.join(profileDir, 'package.json.safemode.bak')
  try {
    if (!existsSync(backupPath)) return false
    writeFileSync(path.join(profileDir, 'package.json'), readFileSync(backupPath), 'utf8')
    rmSync(backupPath, { force: true })
    const patchBackup = path.join(profileDir, 'cordis.patch.yml.safemode.bak')
    if (existsSync(patchBackup)) {
      // 还原用户 patch；期间若已被重新创建出空 patch，先删再改名
      // （Windows 的 rename 不覆盖已存在目标）。用户要回的是进入前那份。
      rmSync(path.join(profileDir, 'cordis.patch.yml'), { force: true })
      renameSync(patchBackup, path.join(profileDir, 'cordis.patch.yml'))
    }
    return true
  } catch {
    return false
  }
}
