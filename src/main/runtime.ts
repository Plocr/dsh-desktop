/**
 * 运行时定位与桌面 profile 管理：
 *  - prod：resources/dsh-runtime.zip + runtime.version（随包分发）。
 *    首启（或版本变化时）解压到 %LOCALAPPDATA%/DSH Desktop/runtime 后复用
 *    （electron-builder 会剔除 extraResources 中的 node_modules，故不能原地使用）。
 *  - dev：全局安装的 @deepseek-ai/dsh（常见全局根探测），或 DSH_DESKTOP_DSH_BIN 覆盖
 * 首次运行把 resources/profile-template/desktop 复制到 $DSH_HOME/profiles/desktop。
 * 每次启动由壳生成 --patch overlay（注入 bridge 行 + 一次性 token）。
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

/** Windows 下获取 %LOCALAPPDATA%（Electron 不支持 app.getPath('localAppData')）。 */
function localAppData(): string {
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

/** 打包模式：按需把运行时 tar.gz 解压到用户本地目录，返回就绪的 RuntimeSpec（异步，避免阻塞 UI）。 */
async function extractPackagedRuntime(tarPath: string, markerPath: string): Promise<RuntimeSpec | null> {
  if (!existsSync(tarPath) || !existsSync(markerPath)) {
    log('error', `packaged runtime archive missing: ${tarPath} / ${markerPath}`)
    return null
  }
  const localRoot = path.join(localAppData(), 'DSH Desktop')
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

export async function resolveRuntime(): Promise<RuntimeSpec> {
  if (app.isPackaged) {
    const resources = process.resourcesPath
    const spec = await extractPackagedRuntime(
      path.join(resources, 'dsh-runtime.tar.gz'),
      path.join(resources, 'runtime.version'),
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
 * 确保 desktop profile 存在；若打包内带了 bridge 包（resources/bridge），
 * 则同步（版本不同或缺失时复制）到 profile 的 node_modules——
 * overlay 的 `name:` 行从 profile 目录解析，这是插件被找到的唯一位置。
 */
export function ensureProfile(dshHome: string, templateDir: string, bundledBridgeDir?: string): string {
  const profileDir = path.join(dshHome, 'profiles', 'desktop')
  if (!existsSync(profileDir)) {
    if (!existsSync(templateDir)) {
      throw new Error(`desktop profile 模板缺失: ${templateDir}`)
    }
    copyDir(templateDir, profileDir)
    log('info', `created desktop profile at ${profileDir}`)
  }
  if (bundledBridgeDir && existsSync(bundledBridgeDir)) {
    const target = path.join(profileDir, 'node_modules', 'dsh-desktop-bridge')
    const bundledVersion = readVersion(bundledBridgeDir)
    const currentVersion = readVersion(target)
    if (currentVersion !== bundledVersion) {
      mkdirSync(path.dirname(target), { recursive: true })
      copyDir(bundledBridgeDir, target)
      log('info', `bridge synced to profile (${String(currentVersion)} -> ${String(bundledVersion)})`)
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

/** 生成并写入本次启动的 overlay patch（bridge 行 + token），返回文件路径。 */
export function writeOverlay(userData: string, token: string): string {
  const file = path.join(userData, 'overlay-desktop.yml')
  const content = `# generated by DSH Desktop shell; do not edit
- insert:
    - id: dsh-desktop-bridge
      name: dsh-desktop-bridge
      config:
        token: ${token}
`
  writeFileSync(file, content, 'utf8')
  return file
}
