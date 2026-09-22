/**
 * 桌面运行时定位与 profile 托管。
 *
 * 移植自 `deepseek-ai/deepseek-harness` `apps/desktop/src/project-manager.ts`
 * 的 createPluginProfile / 运行时资源解析部分（MIT）。
 *
 * [ported] 与上游的差异（本壳适配；运行时不可变这一不变量与官方一致）：
 *  1. 资源解析：打包态 `resources/{runtime,dsh}` 落在 process.resourcesPath 下，
 *     开发态用仓库 `resources/`（appResourcesDir() 两种模式都给对）。本壳不再解压
 *     tar.gz、不再支持本地用户运行时——extraResources 里的树不可变，只读
 *     desktop-runtime.json（一个签名更新单元）；
 *  2. profile 目录名用本壳的 DESKTOP_PROFILE（`dsh-workbench`），非官方保留名；
 *  3. profile 首次建立仍从随包模板复制（上游 createPluginProfile 只写空 manifest，
 *     本壳模板还带 cordis.yml / cordis.patch.yml 预设）。「无 package.json 的目录」
 *     视为残缺/迁移残留（dev-link 预建目录、旧版残留）→ 整树重建；
 *  4. profile bundles 固定要求官方基线两项 + dsh-desktop-bridge（壳↔harness 通道，
 *     永不可移除）；
 *  5. 已删除：tar.gz 解压、运行时 marker/自更新回退、兼容性探测、插件复制同步与
 *     overlay 生成——profile 组合现在由 Host 自己引导（Host 持有 composition）。
 */

import { app } from 'electron'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DESKTOP_PROFILE } from './desktopProfile.ts'
import { log } from './logger.ts'
import { linkDesktopHostPackages, readDesktopProfileState } from './profilePackages.ts'
import { parseDesktopRelease, type DesktopRelease } from './release.ts'
import { DESKTOP_RUNTIME_FILE, readDesktopRuntime, type DesktopRuntimeDescriptor } from './runtimeTree.ts'

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

/**
 * asar 内资源根目录：随 `files:` 打进 app.asar 的壳自有资源
 * （profile-template / shell-pages / icons）。打包态也在 asar 里，
 * 因此始终以 app.getAppPath() 为基准（Electron 对 asar 路径的 fs 读取透明）。
 */
export function appResourcesDir(): string {
  return path.join(app.getAppPath(), 'resources')
}

/**
 * 随包 extraResources 目录：`runtime/`（便携 Node + pnpm）与 `dsh/`（运行时树）的落点。
 * 打包态 = process.resourcesPath（extraResources 解包在 app.asar 之外）；开发态 = 仓库 resources/。
 */
export function shippedResourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
}

/** 解析出的运行时（路径全部为绝对路径；descriptor 为已校验的发行身份 + 文件清单）。 */
export interface RuntimeSpec {
  /** 随包便携 Node 可执行文件（官方 nodejs.org 发行包，独立于系统 Node）。 */
  node: string
  /** 不可变 dsh 运行时树根（node_modules + desktop-runtime.json）。 */
  runtimeDir: string
  /** 随包 dsh 版本（descriptor.release.dshVersion）。 */
  dshVersion: string
  /** 插件事务用的 pnpm 入口（随包 pnpm，不碰系统 pnpm）。 */
  pnpmEntry: string
  /** 已验证的运行时描述符（共享包清单 + 全量文件 sha256 清单）。 */
  descriptor: DesktopRuntimeDescriptor
}

/** 运行时缺失/不一致时的统一行动指引。 */
const SETUP_RUNTIME_HINT = '请先运行 npm run setup:runtime'

function parseReleaseOrThrow(runtimeDir: string, value: unknown): DesktopRelease {
  try {
    return parseDesktopRelease(value)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `桌面运行时发行身份无效（${path.join(runtimeDir, DESKTOP_RUNTIME_FILE)}）：${reason}。${SETUP_RUNTIME_HINT}`,
    )
  }
}

/**
 * 定位随包运行时并校验其完整性元数据（同步、只读，不复制/解压任何文件）。
 *
 * 目录布局（见 scripts/setup-runtime.mjs 与 electron-builder.yml）：
 *  - `<resources>/runtime/node`  便携 Node（win: node.exe / *nix: bin/node）
 *  - `<resources>/runtime/pnpm`  随包 pnpm（bin/pnpm.cjs）
 *  - `<resources>/dsh`           dsh 运行时树 + desktop-runtime.json
 */
export function resolveRuntime(): RuntimeSpec {
  const resources = shippedResourcesDir()
  const runtimeDir = path.join(resources, 'dsh')
  let descriptor: DesktopRuntimeDescriptor
  try {
    descriptor = readDesktopRuntime(runtimeDir)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `桌面运行时不可用（${path.join(runtimeDir, DESKTOP_RUNTIME_FILE)}）：${reason}。${SETUP_RUNTIME_HINT}`,
    )
  }
  // readDesktopRuntime 只校验描述符字段类型；这里补上发行身份（dshVersion / hostProtocolVersion）校验
  const release = parseReleaseOrThrow(runtimeDir, descriptor.release)
  // 壳版本绑定（官方「一个签名更新单元」）：运行时树由与本次壳同一次发版封存，
  // 版本对不上说明 resources 被替换过 → 拒绝启动，绝不带着未知组合跑。
  const shellVersion = app.getVersion()
  if (release.version !== shellVersion) {
    throw new Error(
      `桌面运行时与外壳版本不匹配：运行时 ${release.version} ≠ 外壳 ${shellVersion}（请重新安装完整版本）。`,
    )
  }
  const node = process.platform === 'win32'
    ? path.join(resources, 'runtime', 'node', 'node.exe')
    : path.join(resources, 'runtime', 'node', 'bin', 'node')
  const pnpmEntry = path.join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.cjs')
  // 关键文件清单：不逐文件校验 sha256（上万文件，太慢），但**启动必需**的这几处必须在。
  // 真机事故（2026-09-23）：安全软件把 Host 入口按启发式隔离掉，启动时报的是 Node 的
  // `Cannot find module`，用户看不懂；这里给出「哪个文件缺了 + 最可能的原因」。
  const hostEntry = path.join(runtimeDir, 'node_modules', 'dsh-desktop-host', 'lib', 'index.js')
  const essentials = [
    ['Node', node],
    ['pnpm', pnpmEntry],
    ['Host 入口', hostEntry],
    ['bridge 插件', path.join(runtimeDir, 'node_modules', 'dsh-desktop-bridge', 'lib', 'index.js')],
    ['harness 包', path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')],
    ['Web 前端 dist', path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')],
  ] as const
  const missing = essentials.filter(([, file]) => !existsSync(file))
  if (missing.length > 0) {
    const list = missing.map(([label, file]) => `  · ${label}：${file}`).join('\n')
    throw new Error(
      `桌面运行时缺少随包文件（安装不完整，或被杀毒软件/安全软件的启发式规则隔离）：\n${list}\n\n` +
        '未签名的 Electron 应用 + 内嵌 harness（会拉起子进程、加载大量插件文件）容易被误报。' +
        '请把安装目录加入安全软件白名单后重新安装；开发机上也可运行 npm run setup:runtime 重建（' +
        `安装目录：${resources}）。`,
    )
  }
  return { node, runtimeDir, dshVersion: release.dshVersion, pnpmEntry, descriptor }
}

/* ── profile 托管 ─────────────────────────────────────────────────────── */

/** Backend build whose native allowBuilds entry is pinned by the official workspace settings. */
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n'

/**
 * 官方 profile 的 pnpm 工作区文件（逐字移植上游 project-manager.workspaceFile()：
 * `packages: ['.']`、hoisted linker、收紧 peer/依赖脚本策略，allowBuilds 白名单原样）。
 */
function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

/** profile 必须启用的 bundles：官方基线两项（dsh CLI 校验其必须是最前两项）。 */
const PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
/** 本壳壳↔harness 通道：永远在 bundles 里，不可移除。 */
const DESKTOP_BRIDGE_PACKAGE = 'dsh-desktop-bridge'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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
 * 确保 dsh.profile.bundles 含官方基线两项与 bridge：
 * 官方顺序约束（dsh-base / dsh-web-app 必须最前）与用户自装 bundle 的相对顺序都保留，
 * 只做「缺失即补齐」。已满足时不写盘（幂等）。
 */
function ensureProfileBundles(profileDir: string): void {
  const file = path.join(profileDir, 'package.json')
  const manifest = asRecord(JSON.parse(readFileSync(file, 'utf8')))
  if (manifest === undefined) throw new Error(`desktop profile: invalid package manifest ${file}`)
  const dsh = asRecord(manifest.dsh) ?? {}
  const profile = asRecord(dsh.profile) ?? {}
  const current = Array.isArray(profile.bundles)
    ? profile.bundles.filter((name): name is string => typeof name === 'string')
    : []
  const extras = [...new Set(current.filter(
    (name) => !PROFILE_BUNDLES.includes(name) && name !== DESKTOP_BRIDGE_PACKAGE,
  ))]
  const next = [...PROFILE_BUNDLES, ...extras, DESKTOP_BRIDGE_PACKAGE]
  if (next.length === current.length && next.every((name, index) => name === current[index])) return
  manifest.dsh = { ...dsh, profile: { ...profile, bundles: next } }
  writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 })
  log('info', `desktop profile bundles ensured: ${next.join(', ')}`)
}

/**
 * 旧壳把 bridge 当普通插件**真实复制**进 profile node_modules（无链接记录，
 * unlinkDesktopHostPackages 看不到它们）；新架构里运行时共享包必须由 junction 链接提供。
 * 首次接管（尚无 desktop-runtime-state.json）时清掉这些同名真实目录，否则官方校验会以
 * 「plugin installed reserved host package」硬失败，老用户升级后无法启动。
 * 只在首次接管时清理：此后完全走官方语义——真实目录/无记录的链接一律硬报错
 * （不越权替换来源不明的包）。
 */
function dropLegacySharedPackageCopies(profileDir: string, runtime: RuntimeSpec): void {
  for (const entry of runtime.descriptor.sharedPackages) {
    const target = path.join(profileDir, 'node_modules', entry.name)
    let info: ReturnType<typeof lstatSync>
    try {
      info = lstatSync(target)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    removeTreeWithJunctions(target)
    log('info', `desktop profile: removed legacy copy of runtime package ${entry.name}`)
  }
}

/**
 * 确保 `$DSH_HOME/profiles/<DESKTOP_PROFILE>` 就绪并绑定到当前运行时：
 *  1. 无 package.json（残缺 / 迁移残留）→ 从随包模板整树重建；
 *  2. 确保 pnpm-workspace.yaml 存在（官方内容，Host 的 pnpm 事务依赖它）；
 *  3. 确保 bundles 含基线两项 + bridge；
 *  4. linkDesktopHostPackages 把运行时共享包链接进 profile 并写入运行时状态。
 * @param opts - dshHome（共享 Harness home）、模板目录、已解析的运行时。
 * @returns profile 目录（绝对路径）。
 */
export function ensureProfile(opts: { dshHome: string; templateDir: string; runtime: RuntimeSpec }): string {
  const { dshHome, templateDir, runtime } = opts
  const profileDir = path.join(dshHome, 'profiles', DESKTOP_PROFILE)
  // 完整性校验：目录存在 ≠ profile 可用——dev-link 等工具会预创建只含
  // node_modules 的空目录；官方新版 loadProfile 对「无 package.json 的
  // profile」fail-loud，残缺目录必须重建。
  if (!existsSync(path.join(profileDir, 'package.json'))) {
    if (!existsSync(templateDir)) {
      throw new Error(`desktop profile 模板缺失: ${templateDir}`)
    }
    if (existsSync(profileDir)) {
      // 先解除全部 junction/symlink 再删整树（见 removeTreeWithJunctions）
      removeTreeWithJunctions(profileDir)
      log('info', `desktop profile 残缺（无 package.json），已重建 ${profileDir}`)
    }
    copyDir(templateDir, profileDir)
    log('info', `created desktop profile at ${profileDir}`)
  }
  const workspace = path.join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) {
    writeFileSync(workspace, workspaceFile(), { mode: 0o600 })
    log('info', `desktop profile workspace written: ${workspace}`)
  }
  ensureProfileBundles(profileDir)
  // 首次接管（无运行时状态）才清理旧壳留下的共享包真实副本；之后完全走官方校验语义
  if (readDesktopProfileState(profileDir) === undefined) {
    dropLegacySharedPackageCopies(profileDir, runtime)
  }
  linkDesktopHostPackages(profileDir, runtime.runtimeDir, runtime.descriptor)
  return profileDir
}
