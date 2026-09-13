/**
 * 运行时定位与桌面 profile 管理：
 *  - prod：resources/dsh-runtime.zip + runtime.version（随包分发）。
 *    首启（或版本变化时）解压到 %LOCALAPPDATA%/DSH Desktop/runtime 后复用
 *    （electron-builder 会剔除 extraResources 中的 node_modules，故不能原地使用）。
 *  - dev：全局安装的 @deepseek-ai/dsh（常见全局根探测），或 DSH_DESKTOP_DSH_BIN 覆盖
 * 首次运行把 resources/profile-template/desktop 复制到 $DSH_HOME/profiles/desktop。
 * 每次启动由壳生成 --patch overlay（注入 bridge 行 + 一次性 token）。
 *
 * 插件同步：resources/plugins/bridge 随包分发，首启按版本同步进 profile
 * node_modules——overlay `name:` 行从 profile 目录解析，这是插件被加载的唯一位置。
 */
import { app } from 'electron'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { log } from './logger'
import { isUserMarker, parseMarker, shouldExtractBundled } from './runtimeMarker'
import { isTreeConsistent, readRuntimeTreeState, treeVersions } from './runtimeTree'
import { compareDots } from './version'
import { incompatibleVersionsFile as compatFile, markIncompatibleVersion as markCompatVersion } from './harnessCompat'
import {
  readProfileBundles,
  readProfileDependencyNames,
  isReservedPluginName,
  listDesktopPlugins as listPluginSources,
  pluginProfileTarget,
  readTextNoBom,
  type DesktopPlugin,
} from './pluginfs.ts'
import { DESKTOP_PROFILE } from './desktopProfile.ts'

export type { DesktopPlugin }

/**
 * 汇总全部桌面插件（打包内置 + 用户安装）。
 * 发现/汇总逻辑在 pluginfs（纯 Node，可单测）；这里包一层把被拒条目写进壳日志。
 */
export function listDesktopPlugins(bundledDir: string | undefined, userDir: string | undefined): DesktopPlugin[] {
  // 被拒插件（占用 bridge 保留名 / 非法包名）记日志，便于用户排查「插件为何不出现」
  return listPluginSources(bundledDir, userDir, (m) => log('error', m))
}

/** 清理上次中断解压/更新遗留的临时目录（runtime.tmp-* 与 .harness-update-*）。 */
function cleanStaleTempDirs(localRoot: string, runtimeDir: string): void {
  // localRoot 下：中断的解压暂存（runtime.tmp-*）；runtimeDir 下：中断的整树刷新
  // 暂存（.harness-update-*）与替换备份（.node_modules.bak-*）
  for (const [dir, pattern] of [
    [localRoot, /^runtime\.tmp-/],
    [runtimeDir, /^\.harness-update-/],
    [runtimeDir, /^\.node_modules\.bak-/],
  ] as const) {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!pattern.test(entry)) continue
      const full = path.join(dir, entry)
      try {
        if (statSync(full).isDirectory()) {
          rmSync(full, { recursive: true, force: true })
          log('info', `runtime: cleaned stale temp dir ${entry}`)
        }
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 选择 tar 可执行文件：Windows 显式使用 System32 的 bsdtar。
 * （PATH 里的 Git GNU tar 会把 `E:\…` 盘符路径误判为远程主机 host:file，
 *  报 "Cannot connect to E: resolve failed" 退出码 128；System32 bsdtar 正常处理本地路径。）
 */
function tarExe(): string {
  if (process.platform === 'win32') {
    const sys32Tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(sys32Tar)) return sys32Tar
  }
  return 'tar'
}

/** 以继承 stdio 的方式运行命令并等待退出（不捕获输出，兼容受限环境）。 */
function runInherit(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: true })
    const t = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`命令超时: ${cmd}`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(t)
      if (code === 0) resolve()
      else reject(new Error(`${cmd} 退出码 ${String(code)}`))
    })
  })
}

/**
 * 跨平台的应用数据根目录：
 *  - Windows：%LOCALAPPDATA% （Electron 不支持 app.getPath('localAppData')）
 *  - macOS：~/Library/Application Support
 *  - Linux：$XDG_DATA_HOME 或 ~/.local/share
 */
export function appDataRoot(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_DATA_HOME
    if (xdg) return xdg
    return path.join(os.homedir(), '.local', 'share')
  }
  const env = process.env.LOCALAPPDATA
  if (env) return env
  return path.join(os.homedir(), 'AppData', 'Local')
}

export interface RuntimeSpec {
  node: string
  bin: string
  /** 当前 harness 版本（随包 marker 或用户自更新后的版本；未知时为 undefined）。 */
  dshVersion?: string
}

export function appResourcesDir(): string {
  return path.join(app.getAppPath(), 'resources')
}

/** 全局 npm root 候选（dev 模式定位 @deepseek-ai/dsh；不 spawn 子进程）。 */
function candidateGlobalRoots(): string[] {
  const list: string[] = []
  if (process.env.DSH_DESKTOP_NPM_ROOT) list.push(process.env.DSH_DESKTOP_NPM_ROOT)
  const home = os.homedir()
  list.push(path.join(home, '.npm-global', 'node_modules'))
  list.push(path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules'))
  list.push(path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'npm', 'node_modules'))
  return [...new Set(list)]
}

/**
 * 启动兼容性探测：用指定 node + dsh bin 组装 desktop profile 配置树并退出
 * （`--dump-config`，不启动服务、不写会话）。
 *
 * 用途：识别「CLI 拒绝本壳 profile」的 harness 版本（0.1.5-alpha.1 起硬编码
 * 拒绝官方保留名）——本地运行时被更新到这类版本时必须回退随包运行时。
 * @returns ok=false 时 message 为退出码与错误摘要。
 */
export async function probeDesktopProfileBoot(
  nodeExe: string,
  binJs: string,
  dshHome: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; message: string }> {
  if (!existsSync(nodeExe) || !existsSync(binJs)) {
    return { ok: false, message: `运行时文件缺失（node/bin 不存在）` }
  }
  return new Promise((resolve) => {
    let out = ''
    let child: ChildProcess
    try {
      child = spawn(nodeExe, [binJs, '--profile', DESKTOP_PROFILE, '--dump-config'], {
        env: { ...process.env, DSH_HOME: dshHome, DSH_DESKTOP: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      resolve({ ok: false, message: err instanceof Error ? err.message : String(err) })
      return
    }
    let done = false
    const finish = (r: { ok: boolean; message: string }): void => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve(r)
    }
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({ ok: false, message: '兼容性探测超时' })
    }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    child.on('error', (err) => finish({ ok: false, message: err.message }))
    child.on('exit', (code) => {
      if (code === 0) return finish({ ok: true, message: '' })
      const tail = out.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ')
      finish({ ok: false, message: tail.slice(0, 300) || `退出码 ${String(code)}` })
    })
  })
}

/** 读取运行时树内 dsh 版本（解析失败 → null）。 */
function readRuntimeDshVersion(runtimeDir: string): string | null {
  try {
    const p = JSON.parse(
      readTextNoBom(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
    ) as { version?: unknown }
    return typeof p.version === 'string' ? p.version : null
  } catch {
    return null
  }
}

/**
 * 打包模式：按需把运行时 tar.gz 解压到用户本地目录，返回就绪的 RuntimeSpec（异步，避免阻塞 UI）。
 * onExtract：解压即将开始时回调（用于在加载页提示"正在解压运行时"）。
 */
async function extractPackagedRuntime(
  tarPath: string,
  markerPath: string,
  dshHome: string,
  onExtract?: () => void,
): Promise<RuntimeSpec | null> {
  if (!existsSync(tarPath) || !existsSync(markerPath)) {
    log('error', `packaged runtime archive missing: ${tarPath} / ${markerPath}`)
    return null
  }
  const localRoot = path.join(appDataRoot(), 'DSH Desktop')
  const runtimeDir = path.join(localRoot, 'runtime')
  const marker = readFileSync(markerPath, 'utf8').trim()
  const localMarker = path.join(localRoot, 'runtime.version')
  const nodeExe = path.join(runtimeDir, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  const bin = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

  // 清理上次中断遗留的临时目录（不阻塞就绪判断）
  cleanStaleTempDirs(localRoot, runtimeDir)

  const localText = (() => {
    try {
      return readFileSync(localMarker, 'utf8')
    } catch {
      return null
    }
  })()

  // 就绪判断：node/bin 均存在，且按 marker 决策不需要解压覆盖
  // （用户自更新的运行时不再被误覆盖，除非随包内嵌 dsh 更新；
  //   用户标记下若本地整树不一致（混血）→ 回退内置一致运行时）
  const localTreeConsistent = isUserMarker(localText ?? '')
    ? isTreeConsistent(treeVersions(readRuntimeTreeState(runtimeDir)))
    : undefined
  const baseDecision = shouldExtractBundled(marker, localText, compareDots, { localTreeConsistent })
  const binVersion = (() => {
    try {
      return parseMarker(marker).dsh
    } catch {
      return null
    }
  })()

  // 启动兼容性探测：仅当「本地是用户自更新树、随包又不打算覆盖」时才做
  // （被应用内更新到 0.1.5-alpha.1+ 的树无法启动 desktop profile，必须回退随包运行时；
  //   其他情况跳过探测，避免每次启动多花 1~3s）
  let localBootable: boolean | undefined
  if (!baseDecision && existsSync(nodeExe) && existsSync(bin) && isUserMarker(localText ?? '')) {
    const probe = await probeDesktopProfileBoot(nodeExe, bin, dshHome)
    localBootable = probe.ok
    if (!probe.ok) {
      const localVersion = readRuntimeDshVersion(runtimeDir)
      if (localVersion) {
        // 记入不兼容清单：后续 harness 选版不再挑它（harnessCheck 会跳过）
        if (markCompatVersion(compatFile(appDataRoot()), localVersion)) {
          log('error', `runtime: 记录不兼容 harness 版本 ${localVersion}`)
        }
      }
      log('error', `runtime: 本地运行时无法启动 desktop profile（${probe.message}），回退随包运行时`)
    } else {
      log('info', 'runtime: 本地用户运行时启动探测通过，继续使用')
    }
  }
  const needsExtract = baseDecision || localBootable === false
  if (existsSync(nodeExe) && existsSync(bin) && !needsExtract) {
    // 本地树可能是用户自更新的较新版本：版本以本地 package.json 为准，
    // 随包 marker 只是「是否需要重新解压」的判据（否则托盘会短暂显示旧版本）
    const localVersion = readRuntimeDshVersion(runtimeDir)
    return { node: nodeExe, bin, dshVersion: localVersion ?? binVersion ?? undefined }
  }

  log('info', `extracting packaged runtime -> ${runtimeDir}`)
  onExtract?.()
  const tmp = path.join(localRoot, `runtime.tmp-${Date.now()}`)
  mkdirSync(localRoot, { recursive: true })
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    await runInherit(tarExe(), ['-xf', tarPath, '-C', tmp], 600_000)
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error(`运行时解压失败：${err instanceof Error ? err.message : String(err)}`)
  }
  rmSync(runtimeDir, { recursive: true, force: true })
  renameSync(tmp, runtimeDir)
  writeFileSync(localMarker, marker, 'utf8')
  if (!existsSync(nodeExe) || !existsSync(bin)) {
    throw new Error(`运行时解压后不完整：${runtimeDir}`)
  }
  log('info', `runtime extracted: ${runtimeDir}`)
  return { node: nodeExe, bin, dshVersion: binVersion ?? undefined }
}

export async function resolveRuntime(dshHome: string, onExtract?: () => void): Promise<RuntimeSpec> {
  if (app.isPackaged) {
    const resources = process.resourcesPath
    const spec = await extractPackagedRuntime(
      path.join(resources, 'dsh-runtime.tar.gz'),
      path.join(resources, 'runtime.version'),
      dshHome,
      onExtract,
    )
    if (spec) return spec
  }
  const override = process.env.DSH_DESKTOP_DSH_BIN
  if (override) {
    if (!existsSync(override)) throw new Error(`DSH_DESKTOP_DSH_BIN 指向的文件不存在: ${override}`)
    return { node: 'node', bin: override }
  }
  for (const root of candidateGlobalRoots()) {
    const bin = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(bin)) return { node: 'node', bin }
  }
  throw new Error(
    '找不到 dsh 运行时。开发模式请全局安装 @deepseek-ai/dsh 或设置 DSH_DESKTOP_DSH_BIN；打包模式请先运行 scripts/setup-runtime.mjs。',
  )
}

/** 递归复制（兼容 asar 内的模板目录：不使用 fs.cp）。 */
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const s = path.join(src, entry)
    const d = path.join(dest, entry)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else writeFileSync(d, readFileSync(s))
  }
}

/**
 * 删除目录树，但先解除沿途全部 junction/symlink 再删除：
 * Node 的 rmSync(recursive) 在 Windows 上会穿透 junction 删除链接指向的
 * 真实目录——dev-link 会把仓库 packages/ 以 junction 链接进 profile
 * node_modules，必须避免重建时误删仓库源码。
 */
function removeTreeWithJunctions(dir: string): void {
  const soften = (d: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const entry of entries) {
      const p = path.join(d, entry)
      let isLink = false
      try {
        isLink = lstatSync(p).isSymbolicLink()
      } catch {
        continue
      }
      if (isLink) {
        try {
          rmSync(p, { force: true }) // 只删链接本身
        } catch {
          /* ignore */
        }
      } else {
        let isDir = false
        try {
          isDir = statSync(p).isDirectory()
        } catch {
          continue
        }
        if (isDir) soften(p)
      }
    }
  }
  try {
    soften(dir)
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/**
 * 插件同步与 overlay 生成（桌面端自带 Cordis 插件）。
 *
 * 插件来源（两类目录，都必须是「目录含 package.json」的 Cordis 插件包）：
 *  - 打包内置：resources/plugins/<name>/（随包分发，随桌面端发版）
 *  - 用户安装：userData/plugins/<name>/（运行时可装，无需重新打包）
 *
 * 加载链路：ensureProfile 把「启用」的插件同步进 profile node_modules →
 * writeOverlay 为每个启用插件生成 `- insert:` 行 → harness 以 --patch 加载。
 * bridge（dsh-desktop-bridge）是壳↔harness 通信通道，永远启用、不可禁用。
 */

/**
 * 确保 desktop profile 存在；同步「启用」的插件到 profile node_modules。
 * disabledPlugins：被禁用的插件 package name 列表（bridge 永远启用，忽略该列表）。
 */
export function ensureProfile(
  dshHome: string,
  templateDir: string,
  bundledPluginsDir?: string,
  userPluginsDir?: string,
  disabledPlugins: string[] = [],
): string {
  const profileDir = path.join(dshHome, 'profiles', DESKTOP_PROFILE)
  // 完整性校验：目录存在 ≠ profile 可用——dev-link 等工具会预创建只含
  // node_modules 的空目录；官方新版 loadProfile 对「无 package.json 的
  // profile」fail-loud（desktop 非官方模板 → 直接报错），残缺目录必须重建。
  if (!existsSync(path.join(profileDir, 'package.json'))) {
    if (!existsSync(templateDir)) {
      throw new Error(`desktop profile 模板缺失: ${templateDir}`)
    }
    if (existsSync(profileDir)) {
      // 先解除全部 junction/symlink 再删整树：rmSync(recursive) 会穿透
      // junction 删除目标真实目录（dev-link 的 node_modules 指向仓库
      // packages/，曾被误删 packages/ui-dashboard 与 packages/bridge）
      removeTreeWithJunctions(profileDir)
      log('info', `desktop profile 残缺（无 package.json），已重建 ${profileDir}`)
    }
    copyDir(templateDir, profileDir)
    log('info', `created desktop profile at ${profileDir}`)
  }
  // 收集启用插件：bridge 永远启用；其余按 disabledPlugins 过滤
  const disabled = new Set(disabledPlugins)
  const plugins = listDesktopPlugins(bundledPluginsDir, userPluginsDir).filter(
    (p) => isReservedPluginName(p.name) || !disabled.has(p.name),
  )
  for (const p of plugins) {
    // 防御：用户插件不得占用 bridge 保留名（发现层已剔除，这里再拦一道）
    if (p.source === 'user' && isReservedPluginName(p.name)) {
      log('error', `plugin skipped in profile sync (reserved name): "${p.name}"`)
      continue
    }
    // 目标路径由 pluginfs 统一计算：包名非法/越界返回 null，绝不拼进 copyDir 目标
    const target = pluginProfileTarget(profileDir, p.name)
    if (target === null) {
      log('error', `plugin skipped in profile sync (unsafe name): ${JSON.stringify(p.name)}`)
      continue
    }
    // 注意：用目录名（dir）定位源，包名（name）作为 profile 内的安装名
    const src = p.source === 'user' ? path.join(userPluginsDir ?? '', p.dir) : path.join(bundledPluginsDir ?? '', p.dir)
    if (!existsSync(src)) continue
    const srcVersion = readVersion(src)
    const currentVersion = readVersion(target)
    // bundled（随包内置）是权威源：始终覆盖 profile 副本，保证代码更新随包生效
    // （版本号相同时旧逻辑会跳过，导致插件迭代代码不同步）；
    // user（用户安装）按版本比较，避免覆盖用户本地修改。
    const needSync = p.source === 'bundled' || currentVersion !== srcVersion
    if (needSync) {
      mkdirSync(path.dirname(target), { recursive: true })
      // 若目标是 junction/symlink（dev 链接），用 unlink 移除链接本身，
      // 再复制真实副本——rmSync(recursive) 会穿透 junction 删除指向的真实目录
      try {
        if (lstatSync(target).isSymbolicLink()) rmSync(target, { force: true })
      } catch {
        /* 不存在或非链接，忽略 */
      }
      copyDir(src, target)
      log('info', `plugin synced to profile: ${p.name} (${String(currentVersion)} -> ${String(srcVersion)})`)
    }
  }
  // 清理已禁用/已移除插件在 profile 中的残留（bridge 除外）。
  // 保护：官方 `dsh plugin add` 安装的组合包（dsh.profile.bundles）由 pnpm 管理，
  // 不在本函数维护的 bundled/user 列表内——不能被当成残留删除。
  const activeNames = new Set(plugins.map((p) => p.name))
  // 保护名单支持 scope 包：pnpm 在 node_modules 顶层按 `@scope` 目录存放，
  // 仅按完整包名保护会漏掉目录本身。对每个名字把其 scope 段也加入保护。
  const protectNames = (name: string): void => {
    activeNames.add(name)
    if (name.startsWith('@')) {
      const scope = name.split('/')[0]
      if (scope) activeNames.add(scope)
    }
  }
  plugins.forEach((p) => protectNames(p.name))
  try {
    for (const b of readProfileBundles(profileDir)) protectNames(b)
    // dependencies 声明的包也要保护：取消挂载只移出 bundles、代码与依赖必须保留，
    // 否则 ensureProfile 会把它们当残留删掉，用户便无法重新挂载。
    for (const d of readProfileDependencyNames(profileDir)) protectNames(d)
  } catch {
    /* 读取失败则按原逻辑，不额外保护 */
  }
  const nmDir = path.join(profileDir, 'node_modules')
  if (existsSync(nmDir)) {
    for (const entry of readdirSync(nmDir)) {
      // 大小写不敏感地保护 bridge 目录：Windows 上 `DSH-Desktop-Bridge` 就是 bridge
      // 的安装目录（activeNames 是精确匹配，漏掉大小写变体会误删刚同步的真 bridge）
      if (entry.startsWith('.') || isReservedPluginName(entry) || activeNames.has(entry)) continue
      const target = path.join(nmDir, entry)
      try {
        // junction/symlink：unlink 只删链接本身（rmSync recursive 会穿透删目标）
        if (lstatSync(target).isSymbolicLink()) {
          rmSync(target, { force: true })
          log('info', `plugin link removed from profile: ${entry}`)
          continue
        }
        if (statSync(target).isDirectory()) {
          rmSync(target, { recursive: true, force: true })
          log('info', `plugin removed from profile: ${entry}`)
        }
      } catch {
        /* ignore */
      }
    }
  }
  return profileDir
}

function readVersion(pkgDir: string): string | null {
  try {
    const p = JSON.parse(readTextNoBom(path.join(pkgDir, 'package.json'))) as { version?: unknown }
    return typeof p.version === 'string' ? p.version : null
  } catch {
    return null
  }
}

/**
 * 解析 cordis.patch.yml（用户持久化插件层）中 `- insert:` 块已注册的 loader entry id。
 * 应用 overlay 生成时需跳过这些 id：同一插件 id 若同时在用户持久层与应用 overlay 层
 * 各 insert 一次，harness 启动会报 `duplicate loader entry id` 并直接退出（应用打不开）。
 * 实现见 pluginfs.ts（纯 Node，可单测）。
 */
export { readPatchInsertedIds } from './pluginfs.ts'

/** 生成并写入本次启动的 overlay patch（每个启用插件一行 insert），返回文件路径。 */
export function writeOverlay(
  userData: string,
  token: string,
  plugins: { name: string; config?: Record<string, unknown> }[] = [],
): string {
  const file = path.join(userData, 'overlay-desktop.yml')
  // bridge 行永远在最前，带每次启动的 token；其余插件按需带 config（YAML 键值）。
  const rows = [
    `    - id: dsh-desktop-bridge\n      name: dsh-desktop-bridge\n      config:\n        token: ${token}`,
    ...plugins
      .filter((p) => !isReservedPluginName(p.name))
      .map((p) => {
        // 包名引号化：`@scope/pkg` 等以 YAML 保留指示符开头的名字不能作裸标量
        const id = yamlScalar(p.name)
        const cfg = p.config
        if (!cfg || Object.keys(cfg).length === 0) return `    - id: ${id}\n      name: ${id}`
        const lines = Object.entries(cfg).map(([k, v]) => `        ${k}: ${yamlScalar(v)}`)
        return `    - id: ${id}\n      name: ${id}\n      config:\n${lines.join('\n')}`
      }),
  ]
  const content = `# generated by DSH Desktop shell; do not edit
- insert:
${rows.join('\n')}
`
  writeFileSync(file, content, 'utf8')
  return file
}

/** 把配置值序列化为 YAML 标量（字符串加引号，其余原样）。 */
function yamlScalar(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null || v === undefined) return 'null'
  return JSON.stringify(v)
}
