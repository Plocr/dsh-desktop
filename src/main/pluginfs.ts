/**
 * 插件文件系统操作（纯 Node，无 electron 依赖，可单测）。
 *
 * 负责：
 *  - validatePluginDir：安装前校验插件包结构（package.json 可解析、name 合法、入口存在）
 *  - installUserPlugin：安装用户插件 → userData/plugins/<name>
 *  - uninstallUserPlugin：删除用户插件目录
 *  - readPatchInsertedIds：解析 cordis.patch.yml 中 `- insert:` 块已注册的 id
 *  - cleanPatchStaleEntries：从 cordis.patch.yml 移除指向「不存在插件包」的残留条目
 *    （历史上持久化安装/卸载不彻底留下的脏数据；残留条目会让 harness 启动报错）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * 读取文本文件并去掉 UTF-8 BOM（Windows 记事本/部分编辑器保存的 JSON 带 BOM，
 * 直接 JSON.parse 会抛错并导致「静默回退默认值/跳过插件」）。文件不存在时抛错，由调用方捕获。
 */
export function readTextNoBom(file: string): string {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
}

/** 深度复制目录（兼容 asar 内只读源：不使用 fs.cp 的复制语义问题最小化）。 */
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const s = path.join(src, entry)
    const d = path.join(dest, entry)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else writeFileSync(d, readFileSync(s))
  }
}

/** 读取包内 version（解析失败返回 null）。 */
function readVersion(pkgDir: string): string | null {
  try {
    const p = JSON.parse(readTextNoBom(path.join(pkgDir, 'package.json'))) as { version?: unknown }
    return typeof p.version === 'string' ? p.version : null
  } catch {
    return null
  }
}

export type ValidateResult = { ok: true; name: string; version: string | null } | { ok: false; reason: string }

/**
 * 插件安装 spec 合法性（官方 dsh plugin add 的取值）：
 *  - npm 包名（含作用域）：`foo` / `@scope/foo` / `foo@1.2.3`
 *  - git 源：`github:user/repo` / `git+https://…` / `github:user/repo#sha`
 *  - 本地路径（目录或 .tgz）：`C:\path` 或 `/path`
 * 仅允许安全字符集（无空格、无 shell 元字符，spawn 参数化传递避免注入）。
 */
export function isValidPluginSpec(spec: string): boolean {
  const s = spec.trim()
  if (!s || s.length > 512) return false
  // 字母数字 @ / \ : . _ - + # % ~ 与作用域分隔符；不允许空格和引号等
  return /^[A-Za-z0-9@/\\:._\-+#%~()]+$/.test(s)
}

/** 系统必需的 bridge 插件包名（永远启用、持启动 token，不允许被用户插件占用）。 */
export const BRIDGE_PLUGIN_NAME = 'dsh-desktop-bridge'

/**
 * 插件包名合法性——**任何把 name 拼进文件路径之前必须先过这一关**：
 *  - 非空、≤214 字符、不含任何空白
 *  - 不含 `\`、Windows 保留字符（`<>:"|?*`）与控制字符
 *  - 不以 `.` 结尾（Windows 会静默去掉结尾点，可能指向另一个目录）
 *  - 用 `/` 分段时最多两段；两段仅允许 `@scope/pkg` 形式
 *  - 各段不得为空、`.`、`..`（拒绝路径穿越与绝对路径）
 */
export function isValidPluginName(name: string): boolean {
  if (typeof name !== 'string') return false
  if (name === '' || name.length > 214) return false
  // 任何空白（含首尾与中间）都不是合法 npm 包名字符
  if (/\s/.test(name)) return false
  if (/[\\<>:"|?*\u0000-\u001f]/.test(name)) return false
  if (name.endsWith('.')) return false
  const segs = name.split('/')
  if (segs.length > 2) return false
  if (segs.length === 2 && !segs[0].startsWith('@')) return false
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return false
  }
  return true
}

/** 是否为系统保留插件名（bridge；大小写不敏感——Windows 文件系统不区分大小写）。 */
export function isReservedPluginName(name: string): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === BRIDGE_PLUGIN_NAME
}

/**
 * 读取 profile 的 dsh.profile.bundles（官方 dsh plugin add 维护的组合包列表）。
 * 读取失败返回空数组。
 */
export function readProfileBundles(profileDir: string): string[] {
  try {
    const p = JSON.parse(readTextNoBom(path.join(profileDir, 'package.json'))) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const b = p.dsh?.profile?.bundles
    return Array.isArray(b) ? b.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * 读取 profile 的 dependencies 声明的包名列表（pnpm 管理的已安装依赖）。
 * 读取失败返回空数组。
 */
export function readProfileDependencyNames(profileDir: string): string[] {
  try {
    const p = JSON.parse(readTextNoBom(path.join(profileDir, 'package.json'))) as {
      dependencies?: Record<string, unknown>
    }
    return Object.keys(p.dependencies ?? {})
  } catch {
    return []
  }
}

/**
 * 自愈 profile 的 bundles 列表（与官方 dsh plugin reconcile 同语义，避免官方偶发不生效）：
 *  - dependencies 中声明了 dsh.bundle.patch 的包 → 补进 bundles（按依赖顺序追加）
 *  - bundles 中已不再是 dependencies 的包（移除/降级了 bundle 声明）→ 移出 bundles
 * 返回更新后的 bundles（文件被改写时）。官方内置 bundle（@deepseek-ai/dsh-base 等）不触碰。
 */
export function reconcileProfileBundles(profileDir: string): string[] {
  const pkgFile = path.join(profileDir, 'package.json')
  let m: { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: string[] } } }
  try {
    m = JSON.parse(readTextNoBom(pkgFile)) as typeof m
  } catch {
    return readProfileBundles(profileDir)
  }
  const bundles = [...(m.dsh?.profile?.bundles ?? [])]
  const deps = m.dependencies ?? {}
  // 基线包永不移出 bundles：官方两项 + 本壳 bridge。
  // bridge 是运行时共享包（junction 链接，**不在 dependencies 里**），因此对它的
  // 「是否仍是依赖」判断必须跳过——官方模型里 bundles 本来就可以含非依赖项。
  const BUILTIN = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', BRIDGE_PLUGIN_NAME])
  let changed = false
  // 依赖 → bundle 声明 → 追加
  for (const name of Object.keys(deps)) {
    if (BUILTIN.has(name)) continue
    if (bundles.includes(name)) continue
    let isBundle = false
    try {
      const p = JSON.parse(readTextNoBom(path.join(profileDir, 'node_modules', name, 'package.json'))) as {
        dsh?: { bundle?: { patch?: unknown } }
      }
      isBundle = p.dsh?.bundle?.patch !== void 0
    } catch {
      /* 不可解析则视为非 bundle */
    }
    if (isBundle) {
      bundles.push(name)
      changed = true
    }
  }
  // 已不再是被安装依赖的 bundle → 移除
  for (const b of [...bundles]) {
    if (BUILTIN.has(b)) continue
    if (!(b in deps)) {
      bundles.splice(bundles.indexOf(b), 1)
      changed = true
    }
  }
  if (!changed) return bundles
  m.dsh = {
    ...m.dsh,
    profile: {
      ...m.dsh?.profile,
      bundles,
    },
  }
  try {
    writeFileSync(pkgFile, JSON.stringify(m, null, 2) + '\n', 'utf8')
  } catch {
    /* 写失败保持内存结果 */
  }
  return bundles
}

/**
 * 校验一个插件包目录是否可作为 Cordis 插件加载：
 *  - package.json 存在且可解析
 *  - name 是非空字符串
 *  - 入口文件存在（main 字段，缺省 index.js）
 *  - 若声明了 dsh.bundle.patch（官方组合包协议）：patch 文件必须存在、
 *    且解析后仍在包目录内（拒绝越界路径，与官方 loadProfile 的 fail-loud 对齐）
 *
 * 不满足任一条件即拒绝安装——避免把损坏/残缺的插件包放进 profile
 * 导致 harness 启动失败（应用打不开的常见来源）。
 */
export function validatePluginDir(dir: string): ValidateResult {
  const pkgPath = path.join(dir, 'package.json')
  if (!existsSync(pkgPath)) return { ok: false, reason: `缺少 package.json：${dir}` }
  let pkg: { name?: unknown; main?: unknown; dsh?: { bundle?: { patch?: unknown } } }
  try {
      pkg = JSON.parse(readTextNoBom(pkgPath)) as typeof pkg
  } catch {
    return { ok: false, reason: `package.json 无法解析：${pkgPath}` }
  }
  if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
    return { ok: false, reason: `package.json 缺少合法 name 字段：${pkgPath}` }
  }
  const name = pkg.name.trim()
  // name 会被拼进 userData/plugins/<name> 与 profile/node_modules/<name>：
  // 含 `..`/分隔符/盘符的包名是路径穿越写/删原语，必须先拒绝（不 trim 也不接受）
  if (name !== pkg.name || !isValidPluginName(name)) {
    return { ok: false, reason: `package.json 的 name 不是合法包名（含路径分隔符/保留字符或首尾空白）：${pkg.name}` }
  }
  if (isReservedPluginName(name)) {
    return { ok: false, reason: 'dsh-desktop-bridge 是系统必需插件，不允许覆盖' }
  }
  const main = typeof pkg.main === 'string' && pkg.main.trim() !== '' ? pkg.main.trim() : 'index.js'
  const resolved = main.startsWith('.') ? path.resolve(dir, main) : path.join(dir, main)
  if (!existsSync(resolved)) {
    return { ok: false, reason: `插件入口不存在：${resolved}（package.json main=${main}）` }
  }
  // 官方组合包协议：dsh.bundle.patch 声明必须指向包内存在的 patch 文件（相对路径）
  const declared = pkg.dsh?.bundle?.patch
  if (typeof declared === 'string' && declared.trim() !== '') {
    const patchFile = path.resolve(dir, declared)
    if (patchFile !== dir && !patchFile.startsWith(dir + path.sep)) {
      return { ok: false, reason: `dsh.bundle.patch 越界：${declared}（必须位于插件包目录内）` }
    }
    if (!existsSync(patchFile)) {
      return { ok: false, reason: `dsh.bundle.patch 指向的文件不存在：${declared}` }
    }
  }
  return { ok: true, name, version: readVersion(dir) }
}

/**
 * 安装用户插件：把 srcDir 校验后复制为 userPluginsDir/<name>。
 * 同名旧目录会被覆盖（先删后建，避免残留旧文件）。
 */
export function installUserPlugin(srcDir: string, userPluginsDir: string): ValidateResult {
  const v = validatePluginDir(srcDir)
  if (!v.ok) return v
  mkdirSync(userPluginsDir, { recursive: true })
  const target = path.join(userPluginsDir, v.name)
  try {
    rmSync(target, { recursive: true, force: true })
    copyDir(srcDir, target)
  } catch (err) {
    return { ok: false, reason: `复制插件失败：${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, name: v.name, version: v.version }
}

/**
 * 删除用户插件目录（不存在视为成功）。返回是否实际删除。
 * 名字非法（路径穿越/保留名）或解析后越出插件目录时一律拒绝——
 * 本函数是 rmSync(recursive) 的唯一入口，绝不删除目录外的路径。
 */
export function uninstallUserPlugin(name: string, userPluginsDir: string): boolean {
  if (!isValidPluginName(name) || isReservedPluginName(name)) return false
  const root = path.resolve(userPluginsDir)
  const target = path.resolve(root, name)
  if (target !== root && !target.startsWith(root + path.sep)) return false
  if (!existsSync(target)) return false
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    return false
  }
  return true
}

/**
 * 列出 userPluginsDir 下的插件包名（子目录且含合法 package.json）。
 * 损坏目录会被跳过（与 runtime.listDesktopPlugins 的 discover 策略一致）。
 */
export function listUserPluginNames(userPluginsDir: string): string[] {
  if (!existsSync(userPluginsDir)) return []
  const out: string[] = []
  for (const entry of readdirSync(userPluginsDir)) {
    const dir = path.join(userPluginsDir, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
      const v = validatePluginDir(dir)
      if (v.ok && !out.includes(v.name)) out.push(v.name)
    } catch {
      /* 跳过 */
    }
  }
  return out
}

export interface DiscoveredPlugin {
  name: string
  version: string | null
  /** 插件所在的绝对目录 */
  dir: string
}

/**
 * 发现某目录下的插件包（子目录且含 package.json）。
 * 包名非法的目录一律跳过——包名会被拼进 profile/node_modules/<name> 并做
 * copyDir/rmSync，`..`/分隔符/盘符是路径穿越的写/删原语。
 * onSkip：被跳过时的诊断回调（调用方接日志）。
 */
export function discoverPluginsIn(dir: string | undefined, onSkip?: (message: string) => void): DiscoveredPlugin[] {
  if (!dir || !existsSync(dir)) return []
  const out: DiscoveredPlugin[] = []
  for (const entry of readdirSync(dir)) {
    const pkgDir = path.join(dir, entry)
    try {
      if (!statSync(pkgDir).isDirectory()) continue
      const pkgPath = path.join(pkgDir, 'package.json')
      if (!existsSync(pkgPath)) continue
      const pkg = JSON.parse(readTextNoBom(pkgPath)) as { name?: unknown; version?: unknown }
      if (typeof pkg.name !== 'string' || !pkg.name) continue
      if (!isValidPluginName(pkg.name)) {
        onSkip?.(`plugin ignored: invalid package name ${JSON.stringify(pkg.name)} (${pkgDir})`)
        continue
      }
      out.push({ name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : null, dir: pkgDir })
    } catch {
      /* 跳过无法解析的目录 */
    }
  }
  return out
}

export interface DesktopPlugin {
  /** package.json 的 name（harness 按此解析加载） */
  name: string
  /** 插件目录名（profile node_modules/<dir>） */
  dir: string
  version: string | null
  source: 'bundled' | 'user'
}

/**
 * 汇总全部桌面插件（打包内置 + 用户安装），含来源标记。
 *
 * 用户目录不得占用系统必需插件（bridge）的包名，且比较大小写不敏感：
 * Windows 文件系统上 `DSH-Desktop-Bridge` 与 `dsh-desktop-bridge` 是同一个
 * node_modules 目录，而 overlay 会把每次启动的 bridge token 注入该包——
 * 剔除用户侧占名后，内置 bridge 条目始终保留并覆盖 profile 中的副本。
 */
export function listDesktopPlugins(
  bundledDir: string | undefined,
  userDir: string | undefined,
  onSkip?: (message: string) => void,
): DesktopPlugin[] {
  const bundled = discoverPluginsIn(bundledDir, onSkip).map((p) => ({
    name: p.name,
    dir: path.basename(p.dir),
    version: p.version,
    source: 'bundled' as const,
  }))
  const user = discoverPluginsIn(userDir, onSkip)
    .filter((p) => {
      if (isReservedPluginName(p.name)) {
        onSkip?.(`user plugin rejected: reserved system plugin name "${p.name}" (${p.dir})`)
        return false
      }
      return true
    })
    .map((p) => ({
      name: p.name,
      dir: path.basename(p.dir),
      version: p.version,
      source: 'user' as const,
    }))
  // 同名时用户目录优先（可覆盖/更新内置同名插件）；bridge 除外（用户侧占名已在上方剔除）
  const userNames = new Set(user.map((p) => p.name))
  return [...user, ...bundled.filter((p) => !userNames.has(p.name))]
}

/**
 * 计算插件在 profile 内的安装目录（profile/node_modules/<name>）。
 * 包名非法或解析结果越出 node_modules 时返回 null——调用方必须跳过，
 * 绝不把未校验的 name 拼进 copyDir/rmSync 的目标路径。
 */
export function pluginProfileTarget(profileDir: string, name: string): string | null {
  if (!isValidPluginName(name)) return null
  const nodeModules = path.resolve(profileDir, 'node_modules')
  const target = path.resolve(nodeModules, name)
  if (!target.startsWith(nodeModules + path.sep)) return null
  return target
}

/** 官方桌面 profile 内置 bundle（安全模式隔离后仅保留这些）。 */
const OFFICIAL_DESKTOP_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * 安全模式隔离：备份当前 manifest 到 package.json.safemode.bak，并把 bundles
 * 改写为仅官方内置项（dependencies 保留）。返回是否成功进入隔离状态。
 * 由「退出安全模式」时的 restoreProfileManifest 还原。
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
    const m = JSON.parse(manifest) as { dsh?: { profile?: { bundles?: string[] } } }
    m.dsh = { ...m.dsh, profile: { ...m.dsh?.profile, bundles: [...OFFICIAL_DESKTOP_BUNDLES] } }
    writeFileSync(pkgFile, JSON.stringify(m, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 恢复 profile manifest（退出安全模式时还原进入前的 bundles/dependencies）。
 * 备份文件不存在时返回 false。
 */
export function restoreProfileManifest(profileDir: string): boolean {
  const backupPath = path.join(profileDir, 'package.json.safemode.bak')
  try {
    if (!existsSync(backupPath)) return false
    writeFileSync(path.join(profileDir, 'package.json'), readFileSync(backupPath), 'utf8')
    rmSync(backupPath, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 列出已安装的组合包（dependencies 中声明 dsh.bundle 的包），**含未挂载的**：
 * 取消挂载只移出 bundles，代码与依赖仍保留，托盘需继续显示以便随时重新挂载/卸载。
 */
export function listInstalledBundleNames(profileDir: string): string[] {
  const out = new Set<string>()
  let m: { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: string[] } } }
  try {
    m = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8')) as typeof m
  } catch {
    return []
  }
  // 已挂载的组合包（含 shared package 形式的第一方包，如 bridge）
  for (const name of m.dsh?.profile?.bundles ?? []) {
    if (name === '@deepseek-ai/dsh-base' || name === '@deepseek-ai/dsh-web-app') continue
    out.add(name)
  }
  // 已安装但处于「取消挂载」状态的组合包：依赖仍在、且声明了 dsh.bundle
  for (const name of Object.keys(m.dependencies ?? {})) {
    if (name === '@deepseek-ai/dsh-base' || name === '@deepseek-ai/dsh-web-app') continue
    try {
      const p = JSON.parse(readTextNoBom(path.join(profileDir, 'node_modules', name, 'package.json'))) as {
        dsh?: { bundle?: { patch?: unknown } }
      }
      if (p.dsh?.bundle?.patch !== void 0) out.add(name)
    } catch {
      /* 目录缺失（已整体卸载）则跳过 */
    }
  }
  return [...out]
}

/**
 * 挂载/取消挂载一个组合包（bundle）插件：
 *  - mounted=true ：包已在 dependencies 且声明 dsh.bundle → 追加进 bundles（重新挂载）
 *  - mounted=false：从 bundles 移除（取消挂载；**保留依赖代码**，可随时再挂载）
 * 不存在的包安全忽略。返回操作后该包是否在 bundles。
 */
export function setBundleMounted(profileDir: string, name: string, mounted: boolean): boolean {
  const pkgFile = path.join(profileDir, 'package.json')
  let m: { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: string[] } } }
  try {
    m = JSON.parse(readTextNoBom(pkgFile)) as typeof m
  } catch {
    return false
  }
  const bundles = [...(m.dsh?.profile?.bundles ?? [])]
  const inBundles = bundles.includes(name)
  if (mounted === inBundles) return inBundles // 无变化
  if (mounted) {
    // 重新挂载：要求包仍在 profile 里（依赖或共享包链接）且声明了 dsh.bundle
    let isBundle = false
    try {
      const p = JSON.parse(readTextNoBom(path.join(profileDir, 'node_modules', name, 'package.json'))) as {
        dsh?: { bundle?: { patch?: unknown } }
      }
      isBundle = p.dsh?.bundle?.patch !== void 0
    } catch {
      /* 视为非 bundle */
    }
    if (!isBundle) return false
    bundles.push(name)
  } else {
    bundles.splice(bundles.indexOf(name), 1)
  }
  m.dsh = { ...m.dsh, profile: { ...m.dsh?.profile, bundles } }
  try {
    writeFileSync(pkgFile, JSON.stringify(m, null, 2) + '\n', 'utf8')
  } catch {
    return inBundles
  }
  return mounted
}
export interface DshPluginResult {
  code: number | null
  output: string
}

/**
 * pnpm 网络层失败的标志（受限网络下大批量 metadata 拉取会被断流：
 * UND_ERR_DESTROYED / ETIMEDOUT / ECONNRESET 等）。命中时降并发重试一次。
 * 纯函数便于单测。
 */
export function shouldRetryLowerConcurrency(output: string): boolean {
  return /UND_ERR_DESTROYED|ETIMEDOUT|ECONNRESET|fetch failed|network error|socket hang up/i.test(output)
}

/**
 * allowBuilds 的键（pnpm 报错时的原始 specifier）是否指向包名 name：
 *  - 包名本身：`foo`
 *  - git/本地路径：`git+https://…/foo.git`（取末段去 .git）
 *  - 带版本：`foo@1.2.3` / `@scope/foo@1.2.3`
 */
function allowBuildsKeyMatches(key: string, name: string): boolean {
  if (key === name) return true
  const tail = key.split(/[\\/]/).pop() ?? key
  if (tail.replace(/\.git$/i, '') === name) return true
  const at = key.lastIndexOf('@')
  if (at > 0) {
    const noVer = key.slice(0, at)
    if (noVer === name || (noVer.split(/[\\/]/).pop() ?? '') === name) return true
  }
  return false
}

/**
 * 清理 profile 下 pnpm-workspace.yaml 中指向「已卸载包」的 allowBuilds 条目。
 * 官方对 git 依赖的 prepare 构建脚本要求显式 allowBuilds（pnpm ≥10），
 * 卸载该依赖后允许键会残留成脏配置——按包名移除（连同其缩进子行一起删，
 * 否则残留子行会悬挂到下一个键下，产出非法 YAML）。
 * 返回是否改写文件。workspace 文件不存在/不可解析视为无需清理。
 */
export function cleanAllowBuildsForRemoved(profileDir: string, removedNames: string[]): boolean {
  const wsFile = path.join(profileDir, 'pnpm-workspace.yaml')
  let content: string
  try {
    content = readFileSync(wsFile, 'utf8')
  } catch {
    return false
  }
  const removed = new Set(removedNames)
  let changed = false
  const out: string[] = []
  let inAllowBuilds = false
  /** 正在丢弃的键行缩进；其下缩进更深的子行一并丢弃 */
  let dropIndent: number | null = null
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    // `allowBuilds:` 顶层键（可带注释）；进入其条目段
    if (/^allowBuilds:\s*(#.*)?$/.test(line)) {
      inAllowBuilds = true
      dropIndent = null
      out.push(raw)
      continue
    }
    if (inAllowBuilds) {
      // 缩进条目（`  <key>:` 或 `- <key>:`）；非缩进行说明段结束
      if (!/^\s+/.test(raw)) {
        inAllowBuilds = false
        dropIndent = null
        out.push(raw)
        continue
      }
      const indent = raw.length - raw.trimStart().length
      if (dropIndent !== null && indent > dropIndent) continue // 被删键的附属子行
      dropIndent = null
      const m = line.match(/^(?:-\s*)?([^#\s].*?)\s*:\s*(#.*)?$/)
      if (m) {
        const key = m[1].trim()
        if ([...removed].some((n) => allowBuildsKeyMatches(key, n))) {
          changed = true
          dropIndent = indent
          continue // 丢弃该条目行（及其后续子行）
        }
      }
      out.push(raw)
      continue
    }
    out.push(raw)
  }
  if (!changed) return false
  try {
    writeFileSync(wsFile, out.join('\n'), 'utf8')
  } catch {
    return false
  }
  return true
}

/**
 * 结束子进程：Windows 下连同整棵子进程树（pnpm 会再 spawn 子进程，
 * 只 kill 父进程会留下继续占用 profile 目录的孤儿进程）。
 */
function killChildTree(child: import('node:child_process').ChildProcess): void {
  try {
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    /* ignore */
  }
}

export function runDshPluginCommand(
  nodeBin: string,
  dshBin: string,
  dshHome: string,
  profile: string,
  args: string[],
  timeoutMs = 300_000,
  extraEnv: Record<string, string> = {},
): Promise<DshPluginResult> {
  const runOnce = (finalArgs: string[]): Promise<DshPluginResult> =>
    new Promise((resolve) => {
      const child = spawn(nodeBin, [dshBin, 'plugin', '--profile', profile, ...finalArgs], {
        // 绕开 pnpm 11 的发布年龄门禁（新发布 <24h 的包会被拒绝）：
        // 用户通过 UI 显式输入安装，信任其意图；构建脚本授权仍由 IGNORED_BUILDS 单独提示。
        env: { ...process.env, DSH_HOME: dshHome, npm_config_minimum_release_age: '0', ...extraEnv },
        windowsHide: true,
      })
      let out = ''
      const t = setTimeout(() => {
        killChildTree(child)
      }, timeoutMs)
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.stderr?.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.on('error', (e) => {
        clearTimeout(t)
        resolve({ code: -1, output: out || `spawn 失败：${e.message}` })
      })
      child.on('exit', (code) => {
        clearTimeout(t)
        resolve({ code, output: out })
      })
    })
  return runOnce(args).then((first) => {
    // 受限网络下 pnpm 大批量拉取 metadata 会被断流（UND_ERR_DESTROYED 等）：
    // 失败且输出含网络错误时降并发重试一次，避免用户反复手动重试。
    if (first.code !== 0 && shouldRetryLowerConcurrency(first.output)) {
      return runOnce([...args, '--network-concurrency', '2'])
    }
    return first
  })
}

/** 解析 cordis.patch.yml 中 `- insert:` 块已注册的 loader entry id 集合。 */
export function readPatchInsertedIds(patchPath: string): Set<string> {
  const ids = new Set<string>()
  let content: string
  try {
    content = readFileSync(patchPath, 'utf8')
  } catch {
    return ids
  }
  let inInsert = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    // 顶层 loader entry（如 `- insert:` / `- disable:` / `- config:` …）：整行只有
    // `- 标识符:`（可带行尾注释）；带值的是子条目（`- id: xxx`），不算顶层。
    if (/^-\s+[a-zA-Z-]+:\s*(#.*)?$/.test(line)) {
      inInsert = /^-\s+insert:/.test(line)
      continue
    }
    if (inInsert) {
      const m = line.match(/^-\s+id:\s*(\S+)/)
      if (m) ids.add(m[1])
    }
  }
  return ids
}

/**
 * 清理 cordis.patch.yml 中的残留 insert 条目：
 * 删除「insert id 不在 knownIds 中且非 bridge」的子条目（附带其 name/config 行）。
 * 返回文件是否被改写。knownIds = 当前全部可加载插件名（bundled + user）。
 */
export function cleanPatchStaleEntries(patchPath: string, knownIds: Set<string>): boolean {
  let content: string
  try {
    content = readFileSync(patchPath, 'utf8')
  } catch {
    return false
  }
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  let inInsert = false
  let changed = false
  let dropBlock = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      out.push(raw)
      continue
    }
    if (/^-\s+[a-zA-Z-]+:\s*(#.*)?$/.test(line)) {
      // 顶层面包屑
      inInsert = /^-\s+insert:/.test(line)
      dropBlock = false
      out.push(raw)
      continue
    }
    if (inInsert) {
      const m = line.match(/^-\s+id:\s*(\S+)/)
      if (m) {
        const id = m[1]
        if (id !== 'dsh-desktop-bridge' && !knownIds.has(id)) {
          dropBlock = true
          changed = true
          continue // 删掉条目行
        }
        dropBlock = false
        out.push(raw)
        continue
      }
      // 条目附属行（name:/config: 等）：仅当正在丢弃该条目时跳过
      if (dropBlock) continue
      out.push(raw)
      continue
    }
    out.push(raw)
  }
  if (!changed) return false
  writeFileSync(patchPath, out.join('\n'), 'utf8')
  return true
}