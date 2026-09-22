/**
 * profile 依赖体检（纯逻辑 + 只读探测，可单测）。
 *
 * **为什么要体检**：profile 的「已装包」由官方插件管理器用随包 pnpm 维护，但它的事务语义是
 * 「失败回滚 `package.json` + `pnpm-lock.yaml`」——`node_modules` **不回滚**。再叠上跨版本换
 * pnpm 主版本（store 布局换代，`ERR_PNPM_UNEXPECTED_STORE`）时每次包操作都会失败，于是很容易
 * 留下三种不一致（全部在真机日志里出现过）：
 *
 *  1. **声明了依赖、包却不在盘上**（`dsh-better-sidebar` 这一档）：卸载/回滚只还原了清单，
 *     包目录已经没了。harness 解析不到这个 bundle 就报
 *     `cannot resolve profile bundle …`（0.1.7 前直接 fatal）。
 *  2. **包在盘上、清单里没有**（`dsh-commandcode-goat` 这一档）：卸载回滚把清单清干净了，
 *     `node_modules` 与 `pnpm-lock.yaml` 还留着——这正是用户看到的「插件残留」。
 *  3. **手链接进来的插件**（`dsh-opencode-go` → `E:\Dsh\Plugins\…`）：pnpm 不认它、
 *     清单里也没有，只有盘上那一份链接。
 *
 * 本模块只**报告**这三档事实（以及 pnpm 自己托管的那部分该由 `pnpm install` 收敛），
 * 由 `profileRepair.ts` 决定怎么修；判定规则见 `residueEntriesOf`。
 */

/** 壳自己的共享包链接：永远不参与依赖对账（既不是第三方依赖，也不该被清掉）。 */
export const PROFILE_OWNED_PACKAGES = ['@deepseek-ai/dsh', 'dsh-desktop-host', 'dsh-desktop-bridge'] as const

/** `node_modules` 里 pnpm / Node 自己的簿记条目（不是包目录）。 */
const NODE_MODULES_METADATA = new Set([
  '.bin',
  '.pnpm',
  '.pnpm-workspace-state-v1.json',
  '.pnpm-workspace-state.json',
  '.modules.yaml',
  '.package-map.json',
])

export interface ProfileDependencyInput {
  /** profile `package.json` 的 `dependencies` 键（声明了什么）。 */
  declared: readonly string[]
  /** `node_modules` 里真的能解析到的包名（装了哪些）。 */
  installed: readonly string[]
  /** pnpm 记录的自己托管过的包名（`.modules.yaml` 的 `hoistedLocations`）；读不到时为空数组。 */
  managed: readonly string[]
  /** `pnpm-lock.yaml` 的 importer 依赖键；解析不出来时为 null（不参与判定）。 */
  lockImports: readonly string[] | null
  /**
   * 「自报是 dsh 插件」的包名（`package.json` 里有 `dsh` 字段）——由调用方只对候选者读盘。
   *
   * **为什么必须卡这一条**：`node_modules` 里绝大多数目录是 pnpm 提升上来的**传递依赖**
   * （真机：`mermaid` 带进来的 `cytoscape-*`、`d3-transition`），而 pnpm 的 `hoistedLocations`
   * 并不逐个记录它们——只看「不在清单、也不在托管表」会把它们误判成残留并删掉。
   * 缺省（不传）时这一档判定返回空：**没有正面识别就不删东西**。
   */
  pluginLike?: readonly string[]
  /** 壳自有共享包（不参与对账）。 */
  owned?: readonly string[]
}

export interface ProfileDependencyReport {
  /** 清单声明的依赖。 */
  declared: string[]
  /** 盘上装了的包（含传递依赖）。 */
  installed: string[]
  /** 声明了、盘上没有（→ harness 解不出对应 bundle）。 */
  missing: string[]
  /** 盘上有的「第三方插件」，pnpm 不认、清单里也没有（→ 用户眼里的残留）。 */
  residue: string[]
  /** 声明了、锁文件 importer 里没有（锁文件与清单脱节）。 */
  lockDrift: string[]
  /** `pnpm-lock.yaml` 的 importer 是否解析成功。 */
  lockKnown: boolean
  /** 只要有任一档不一致就需要一次修复。 */
  needsRepair: boolean
}

/** 从包名取它在 `node_modules` 下的相对路径段（作用域包拆成两段）。 */
export function packagePathSegments(name: string): string[] {
  return name.split('/')
}

/** 归一化清单依赖键（去重、去空、保序）。 */
function normalizeNames(names: readonly string[]): string[] {
  const out: string[] = []
  for (const name of names) {
    if (typeof name !== 'string') continue
    const trimmed = name.trim()
    if (trimmed === '' || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

/**
 * 摘出「第三方插件残留」：盘上存在、**pnpm 没托管**、清单也没声明的包目录。
 *
 * 为什么可以断定是残留而不是有用的传递依赖：
 *  - 传递依赖由 pnpm 物化，必然出现在 `.modules.yaml` 的 `hoistedLocations` 里（`managed`）；
 *  - 因此「不在 managed、也不在 declared」的目录只剩两种可能：手链接/手拷贝进来的插件，
 *    或上一次失败事务没清干净的拷贝——两种都不该留在 profile 里。
 * 壳自己的共享包与 pnpm 簿记条目一律跳过。
 */
export function residueEntriesOf(input: ProfileDependencyInput): string[] {
  const declared = new Set(normalizeNames(input.declared))
  const managed = new Set(normalizeNames(input.managed))
  const owned = new Set(input.owned ?? PROFILE_OWNED_PACKAGES)
  const pluginLike = new Set(normalizeNames(input.pluginLike ?? []))
  return normalizeNames(input.installed).filter(
    (name) => !declared.has(name) && !managed.has(name) && !owned.has(name) && pluginLike.has(name),
  )
}

/**
 * 体检：把「清单 / 盘上 / 锁文件 / pnpm 托管视图」四方摆到一起，给出可执行的结论。
 * 全部是纯函数（调用方负责读盘），便于单测覆盖每一条不一致。
 */
export function auditProfileDependencies(input: ProfileDependencyInput): ProfileDependencyReport {
  const declared = normalizeNames(input.declared)
  const installed = normalizeNames(input.installed)
  const installedSet = new Set(installed)
  const missing = declared.filter((name) => !installedSet.has(name))
  const residue = residueEntriesOf(input)
  const lockKnown = input.lockImports !== null
  const lockSet = new Set(normalizeNames(input.lockImports ?? []))
  // 锁文件与清单脱节：只报「声明了但锁里没有」这一向（反向的锁里多出来的条目由 pnpm install 收敛，
  // 不需要壳判定——它的表现就是第 2 档残留）。
  const lockDrift = lockKnown ? declared.filter((name) => !lockSet.has(name)) : []
  return {
    declared,
    installed,
    missing,
    residue,
    lockDrift,
    lockKnown,
    needsRepair: missing.length > 0 || residue.length > 0 || lockDrift.length > 0,
  }
}

/** 修复动作：`pnpm install` 让 `node_modules` / 锁文件回到清单描述的状态。 */
export function repairCommands(report: ProfileDependencyReport): readonly string[] {
  if (!report.needsRepair) return []
  const commands = ['pnpm install']
  if (report.residue.length > 0) commands.push(`remove ${report.residue.join(', ')}`)
  return commands
}

/**
 * 每次修复尝试的指纹：状态没变就不再重复跑（离线机器每次冷启动都白跑一遍 pnpm 是纯浪费）。
 * 指纹只含包名与三档差异，不含时间/路径。
 */
export function repairFingerprint(report: ProfileDependencyReport): string {
  const stable = JSON.stringify({
    declared: [...report.declared].sort(),
    missing: [...report.missing].sort(),
    residue: [...report.residue].sort(),
    lockDrift: [...report.lockDrift].sort(),
  })
  // 简易 FNV-1a（无需 crypto 依赖；只用于自比较，不做安全用途）
  let hash = 0x811c9dc5
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 随包 pnpm 的调用参数（与 `packages/host/src/index.ts` 的 `desktopPackageManager` 保持同一形态：
 * 同一个 store、同一个 registry、同一个 userconfig，否则 pnpm 会因 store 不一致直接拒绝动手）。
 * 两处必须同步修改——宿主侧那份是官方插件管理器的 `packageManager`，这份是壳自己的修复动作。
 *
 * 不再带 `--expose-internals`：实测 pnpm 11 的 install/add/remove 都不需要它，而这个 flag
 * 在行为启发式（杀软 PDM）里很显眼；解释器本身也换成自家 Electron 二进制（见 profileRepair）。
 */
export function profilePnpmArgs(pnpmEntry: string, stateDir: string, command: 'install'): string[] {
  return [
    // 与宿主/插件管理器同一个理由：用操作系统证书库，穿得过安全软件的 TLS 扫描
    //（Kaspersky 的加密连接扫描会让 Node 的 registry 请求死在 SELF_SIGNED_CERT_IN_CHAIN）。
    '--use-system-ca',
    pnpmEntry,
    '--config.registry=https://registry.npmjs.org/',
    `--config.store-dir=${stateDir}/store`,
    '--config.enable-global-virtual-store=false',
    `--config.userconfig=${stateDir}/config/npmrc`,
    command,
  ]
}

/** 从 `pnpm-lock.yaml` 文本里读 importer `.` 的依赖键；不是 v9 importer 形状时返回 null。 */
export function lockImporterDependencies(lockText: string): string[] | null {
  const lines = lockText.split(/\r?\n/u)
  const importers = lines.findIndex((line) => /^importers:\s*$/u.test(line))
  if (importers < 0) return null
  const names: string[] = []
  let inRootImporter = false
  let inDependencies = false
  for (const line of lines.slice(importers + 1)) {
    if (/^\S/u.test(line)) break // 下一个顶层段（packages:/snapshots:）——importer 块结束
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (/^\.:\s*$/u.test(trimmed)) {
      inRootImporter = true
      inDependencies = false
      continue
    }
    if (!inRootImporter) continue
    if (/^(?:dependencies|devDependencies|optionalDependencies|peerDependencies):\s*$/u.test(trimmed)) {
      inDependencies = trimmed === 'dependencies:'
      continue
    }
    if (!inDependencies) continue
    const match = /^(?:'([^']+)'|"([^"]+)"|([^\s:]+)):\s*$/u.exec(trimmed)
    const name = match?.[1] ?? match?.[2] ?? match?.[3]
    if (name !== undefined && name !== '') names.push(name)
  }
  return names
}

/** 从 `.modules.yaml` 文本里读 pnpm 托管的包名（`hoistedLocations` 的键）。 */
export function modulesManagedPackages(modulesYaml: string): string[] {
  const names: string[] = []
  const lines = modulesYaml.split(/\r?\n/u)
  const start = lines.findIndex((line) => /^\s*"?hoistedLocations"?:\s*\{\s*$/u.test(line))
  if (start < 0) return names
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,2}\S/u.test(line)) break // 回到同级或更外层键
    const match = /^\s+"?([^":\s][^":]*?)@[^"@]*"?:\s*\[/u.exec(line)
    const name = match?.[1]
    if (name !== undefined && name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}
