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
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { log } from './logger'

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
function appDataRoot(): string {
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
 * 打包模式：按需把运行时 tar.gz 解压到用户本地目录，返回就绪的 RuntimeSpec（异步，避免阻塞 UI）。
 * onExtract：解压即将开始时回调（用于在加载页提示"正在解压运行时"）。
 */
async function extractPackagedRuntime(
  tarPath: string,
  markerPath: string,
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

  const ready =
    existsSync(localMarker) &&
    readFileSync(localMarker, 'utf8').trim() === marker &&
    existsSync(nodeExe) &&
    existsSync(bin)
  if (ready) return { node: nodeExe, bin }

  log('info', `extracting packaged runtime -> ${runtimeDir}`)
  onExtract?.()
  const tmp = path.join(localRoot, `runtime.tmp-${Date.now()}`)
  mkdirSync(localRoot, { recursive: true })
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    await runInherit('tar', ['-xf', tarPath, '-C', tmp], 600_000)
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
  return { node: nodeExe, bin }
}

export async function resolveRuntime(onExtract?: () => void): Promise<RuntimeSpec> {
  if (app.isPackaged) {
    const resources = process.resourcesPath
    const spec = await extractPackagedRuntime(
      path.join(resources, 'dsh-runtime.tar.gz'),
      path.join(resources, 'runtime.version'),
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

/** 发现某目录下的插件包（子目录且含 package.json）。 */
function discoverPluginsIn(
  dir: string | undefined,
): { name: string; version: string | null; dir: string }[] {
  if (!dir || !existsSync(dir)) return []
  const out: { name: string; version: string | null; dir: string }[] = []
  for (const entry of readdirSync(dir)) {
    const pkgDir = path.join(dir, entry)
    try {
      if (!statSync(pkgDir).isDirectory()) continue
      const pkgPath = path.join(pkgDir, 'package.json')
      if (!existsSync(pkgPath)) continue
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown }
      if (typeof pkg.name !== 'string' || !pkg.name) continue
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
  /** 插件目录名（resources/plugins/<dir> 或 userData/plugins/<dir>） */
  dir: string
  version: string | null
  source: 'bundled' | 'user'
}

/** 汇总全部桌面插件（打包内置 + 用户安装），含来源标记。 */
export function listDesktopPlugins(bundledDir: string | undefined, userDir: string | undefined): DesktopPlugin[] {
  const bundled = discoverPluginsIn(bundledDir).map((p) => ({
    name: p.name,
    dir: path.basename(p.dir),
    version: p.version,
    source: 'bundled' as const,
  }))
  const user = discoverPluginsIn(userDir).map((p) => ({
    name: p.name,
    dir: path.basename(p.dir),
    version: p.version,
    source: 'user' as const,
  }))
  // 同名时用户目录优先（可覆盖/更新内置同名插件）
  const userNames = new Set(user.map((p) => p.name))
  return [...user, ...bundled.filter((p) => !userNames.has(p.name))]
}

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
  const profileDir = path.join(dshHome, 'profiles', 'desktop')
  if (!existsSync(profileDir)) {
    if (!existsSync(templateDir)) {
      throw new Error(`desktop profile 模板缺失: ${templateDir}`)
    }
    copyDir(templateDir, profileDir)
    log('info', `created desktop profile at ${profileDir}`)
  }
  // 收集启用插件：bridge 永远启用；其余按 disabledPlugins 过滤
  const disabled = new Set(disabledPlugins)
  const plugins = listDesktopPlugins(bundledPluginsDir, userPluginsDir).filter(
    (p) => p.name === 'dsh-desktop-bridge' || !disabled.has(p.name),
  )
  for (const p of plugins) {
    // 注意：用目录名（dir）定位源，包名（name）作为 profile 内的安装名
    const src = p.source === 'user' ? path.join(userPluginsDir ?? '', p.dir) : path.join(bundledPluginsDir ?? '', p.dir)
    if (!existsSync(src)) continue
    const target = path.join(profileDir, 'node_modules', p.name)
    const bundledVersion = readVersion(src)
    const currentVersion = readVersion(target)
    if (currentVersion !== bundledVersion) {
      mkdirSync(path.dirname(target), { recursive: true })
      copyDir(src, target)
      log('info', `plugin synced to profile: ${p.name} (${String(currentVersion)} -> ${String(bundledVersion)})`)
    }
  }
  // 清理已禁用/已移除插件在 profile 中的残留（bridge 除外）
  const activeNames = new Set(plugins.map((p) => p.name))
  const nmDir = path.join(profileDir, 'node_modules')
  if (existsSync(nmDir)) {
    for (const entry of readdirSync(nmDir)) {
      if (entry.startsWith('.') || entry === 'dsh-desktop-bridge' || activeNames.has(entry)) continue
      const target = path.join(nmDir, entry)
      try {
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
    const p = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof p.version === 'string' ? p.version : null
  } catch {
    return null
  }
}

/** 生成并写入本次启动的 overlay patch（每个启用插件一行 insert），返回文件路径。 */
export function writeOverlay(
  userData: string,
  token: string,
  plugins: { name: string }[] = [],
): string {
  const file = path.join(userData, 'overlay-desktop.yml')
  // bridge 行永远在最前，带每次启动的 token；其余插件无 config（用默认值）。
  const rows = [
    `    - id: dsh-desktop-bridge\n      name: dsh-desktop-bridge\n      config:\n        token: ${token}`,
    ...plugins
      .filter((p) => p.name !== 'dsh-desktop-bridge')
      .map((p) => `    - id: ${p.name}\n      name: ${p.name}`),
  ]
  const content = `# generated by DSH Desktop shell; do not edit
- insert:
${rows.join('\n')}
`
  writeFileSync(file, content, 'utf8')
  return file
}
