/**
 * 官方 Harness（DeepSeek Harness @deepseek-ai/dsh）本地更新 —— 整树刷新。
 *
 * 术语对齐（与用户一致）：
 *  - 「框架」= DSH Desktop（外壳，版本如 0.7.3）
 *  - 「官方 Harness」= deepseek-ai/deepseek-harness 发行到 npm 的 @deepseek-ai/dsh（本体）
 *
 * 历史缺陷：旧实现只下载 @deepseek-ai/dsh 单包并原地替换，从不刷新整棵依赖树
 * （dsh-llm-deepseek / dsh-llm / dsh-host-apiproxy / dsh-client-* 等兄弟包保持旧版），
 * 导致新能力（如视觉模型 inputModalities）永远到不了用户机器，且树变成「混血」。
 *
 * 现流程（整树刷新，镜像 scripts/setup-runtime.mjs 的构建方式）：
 *  1. 检测：npm registry（官方失败回退 npmmirror 镜像）取最大已发布版本；
 *     本地树不一致（@deepseek-ai/* 锁步包不同版本线）也视为「需要修复」；
 *  2. 暂存：在 runtime/.harness-update-<ts> 写最小 package.json，
 *     npm pack 已安装的 bridge → _pack/，再 npm install @deepseek-ai/dsh@<v> <bridgeTgz>
 *     （npmjs → npmmirror 自动回退；darwin 放大 V8 堆 + 降并发）；
 *  3. 校验暂存树（web-frontend dist、bridge、dsh bin.js）；
 *  4. 原子替换：onBeforeSwap（调用方停 harness）→ 整目录 rename node_modules 含回滚，
 *     同步 package.json / package-lock.json / _pack；
 *  5. 写用户自更新 marker（tar=user-<整树指纹>），extractPackagedRuntime 因此
 *     不会用随包覆盖「一致的较新用户树」，但会回退「混血/残缺」树；
 *  6. 重启 harness 生效。
 *
 * 便携 Node 与 bridge 不变（bridge 随壳发版，版本号固定）。开发模式跳过。
 */
import { app } from 'electron'
import { copyFileSync, statSync } from 'node:fs'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { log } from './logger'
import { checkHarnessUpdateResult, readLocalDshVersion, updateAvailable } from './harnessCheck'
import { buildUserMarker } from './runtimeMarker'
import { appDataRoot } from './runtime'
import { readRuntimeTreeState, treeFingerprint } from './runtimeTree'
import { compareDots } from './version'

const REG_NPMJS = 'https://registry.npmjs.org/'
const REG_NPMMIRROR = 'https://registry.npmmirror.com/'
/** 供用户手动复制的 registry 地址。 */
const MANUAL_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh'
/** 单步命令超时（npm install 整树耗时较长）。 */
const NPM_INSTALL_TIMEOUT_MS = 20 * 60_000
const NPM_PACK_TIMEOUT_MS = 5 * 60_000

export interface HarnessProgress {
  /** 0-100；null 表示不确定（未知总大小）。 */
  pct: number | null
  detail: string
  /** 当前操作相关的地址（供用户复制/手动下载）。 */
  url: string | null
}

export interface HarnessUpdateHooks {
  onProgress: (p: HarnessProgress) => void
  /** 原子替换前回调（调用方应在此停掉 harness，规避 Windows 下已加载原生模块占用）。 */
  onBeforeSwap?: () => Promise<void> | void
}

let updating = false

/** 已解压运行时的本地根目录与运行时目录。 */
function runtimePaths(): { localRoot: string; runtimeDir: string } {
  const localRoot = path.join(appDataRoot(), 'DSH Desktop')
  return { localRoot, runtimeDir: path.join(localRoot, 'runtime') }
}

/** 便携 Node 的可执行文件路径（Windows: node/node.exe；mac/linux: node/bin/node）。 */
function nodeBin(runtimeDir: string): string {
  return process.platform === 'win32'
    ? path.join(runtimeDir, 'node', 'node.exe')
    : path.join(runtimeDir, 'node', 'bin', 'node')
}

/** 便携 Node 自带的 npm-cli.js（Windows 分发包在 node_modules/npm，macOS/Linux 在 lib/node_modules/npm）。 */
function npmCli(runtimeDir: string): string {
  const candidates = [
    path.join(runtimeDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(runtimeDir, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`npm-cli.js not found in portable node (tried: ${candidates.join(', ')})`)
  return found
}

/** 干净地执行命令，等待退出；超时/非零退出码视为失败。 */
function spawnOk(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, cwd })
    const t = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`${cmd} 超时`))
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
 * 执行一次 npm install（registry 官方 → npmmirror 自动回退）。
 * macOS runner 上便携 Node 装包时 npm arborist 老年代堆 OOM → 放大 V8 堆 + 降并发。
 */
async function runNpmInstall(runtimeDir: string, args: string[], cwd: string): Promise<void> {
  const isDarwin = process.platform === 'darwin'
  const installEnv = isDarwin ? { ...process.env, NODE_OPTIONS: `--max-old-space-size=4096 ${process.env.NODE_OPTIONS ?? ''}`.trim() } : process.env
  const concurrency = isDarwin ? ['--maxsockets', '2'] : []
  const common = [
    npmCli(runtimeDir),
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    ...concurrency,
    '--fetch-retries',
    '3',
  ]
  let lastErr: Error | null = null
  for (const reg of [REG_NPMJS, REG_NPMMIRROR]) {
    try {
      await spawnOk(
        nodeBin(runtimeDir),
        [...common, '--registry', reg, ...args],
        NPM_INSTALL_TIMEOUT_MS,
        cwd,
      )
      return
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      log('info', `harnessUpdate: npm install（registry=${reg}）失败：${lastErr.message}，切换源重试…`)
    }
  }
  throw lastErr ?? new Error('npm install 多次失败')
}

/** 从已解压运行时目录读取当前版本。 */
function installedVersionFromDir(runtimeDir: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
    ) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** 递归复制目录（staging 产物同步进 runtime 用）。 */
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const s = path.join(src, entry)
    const d = path.join(dest, entry)
    let isDir = false
    try {
      isDir = statSync(s).isDirectory()
    } catch {
      continue
    }
    if (isDir) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

/** 打包已安装的 bridge 插件（零依赖，随壳发版），返回 tgz 绝对路径。 */
function packBridge(runtimeDir: string, packDir: string): string {
  const bridgeSrc = path.join(runtimeDir, 'node_modules', 'dsh-desktop-bridge')
  if (!existsSync(path.join(bridgeSrc, 'package.json'))) {
    throw new Error(`bridge 插件缺失：${bridgeSrc}`)
  }
  mkdirSync(packDir, { recursive: true })
  const result = spawnSync(
    nodeBin(runtimeDir),
    [npmCli(runtimeDir), 'pack', '--pack-destination', packDir, '--silent', bridgeSrc],
    { stdio: 'ignore', windowsHide: true, timeout: NPM_PACK_TIMEOUT_MS },
  )
  if (result.status !== 0) {
    throw new Error(`npm pack bridge 失败（退出码 ${String(result.status)}）`)
  }
  const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'))
  if (!tgz) throw new Error('bridge pack 未产出 tgz')
  return path.join(packDir, tgz)
}

/** 整树刷新官方 Harness 到版本 version（暂存构建 + 原子替换），返回安装结果。 */
async function installHarness(version: string, hooks: HarnessUpdateHooks): Promise<{ ok: boolean; message: string }> {
  const { localRoot, runtimeDir } = runtimePaths()
  if (!existsSync(runtimeDir)) {
    return { ok: false, message: '运行时目录不存在（尚未解压）' }
  }
  const work = path.join(runtimeDir, `.harness-update-${Date.now()}`)
  mkdirSync(work, { recursive: true })

  try {
    // 1. 暂存目录：最小 package.json（与 setup-runtime.mjs 一致）
    hooks.onProgress({ pct: null, detail: `准备整树刷新到官方 Harness v${version}…`, url: MANUAL_URL })
    writeFileSync(
      path.join(work, 'package.json'),
      JSON.stringify({ name: 'dsh-runtime', private: true, type: 'module' }, null, 2),
    )

    // 2. 打包 bridge + npm install @deepseek-ai/dsh@<v>（整树解析到同一 rc 线）
    //    以相对路径传 bridge tgz（相对暂存目录），npm 会写入 package.json 的
    //    file:_pack/... 引用；随后 _pack 整体同步进 runtime，引用不悬空。
    const bridgeTgz = packBridge(runtimeDir, path.join(work, '_pack'))
    const bridgeTgzRel = path.relative(work, bridgeTgz)
    hooks.onProgress({ pct: null, detail: `正在安装官方 Harness v${version}（含全部依赖，约数分钟）…`, url: MANUAL_URL })
    await runNpmInstall(runtimeDir, [`@deepseek-ai/dsh@${version}`, bridgeTgzRel], work)

    // 3. 校验暂存树
    const stagedNm = path.join(work, 'node_modules')
    if (!existsSync(path.join(stagedNm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
      throw new Error('安装后校验失败（缺少 dsh lib/bin.js）')
    }
    if (!existsSync(path.join(stagedNm, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'))) {
      throw new Error('安装后校验失败（缺少 dsh-web-frontend dist）')
    }
    if (!existsSync(path.join(stagedNm, 'dsh-desktop-bridge', 'lib', 'index.js'))) {
      throw new Error('安装后校验失败（缺少 dsh-desktop-bridge）')
    }
    const fingerprint = treeFingerprint(readRuntimeTreeState(work))

    // 4. 原子替换：先停 harness（onBeforeSwap），再整目录替换，失败回滚
    hooks.onProgress({ pct: null, detail: '正在替换本地运行时…', url: MANUAL_URL })
    await hooks.onBeforeSwap?.()
    const nmTarget = path.join(runtimeDir, 'node_modules')
    const backup = path.join(runtimeDir, `.node_modules.bak-${Date.now()}`)
    if (existsSync(nmTarget)) renameSync(nmTarget, backup)
    try {
      renameSync(stagedNm, nmTarget)
    } catch (err) {
      // 目标可能被占用；回滚
      if (existsSync(backup) && !existsSync(nmTarget)) renameSync(backup, nmTarget)
      throw err
    }
    // 同步 package.json / package-lock.json / _pack（含回滚保护）
    try {
      copyFileSync(path.join(work, 'package.json'), path.join(runtimeDir, 'package.json'))
      const lockSrc = path.join(work, 'package-lock.json')
      if (existsSync(lockSrc)) copyFileSync(lockSrc, path.join(runtimeDir, 'package-lock.json'))
      rmSync(path.join(runtimeDir, '_pack'), { recursive: true, force: true })
      copyDir(path.join(work, '_pack'), path.join(runtimeDir, '_pack'))
    } catch (err) {
      rmSync(nmTarget, { recursive: true, force: true })
      if (existsSync(backup)) renameSync(backup, nmTarget)
      throw err
    }
    if (!existsSync(path.join(nmTarget, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
      rmSync(nmTarget, { recursive: true, force: true })
      if (existsSync(backup)) renameSync(backup, nmTarget)
      throw new Error('替换后校验失败，已回滚')
    }
    rmSync(backup, { recursive: true, force: true })

    // 5. 写用户自更新 marker（整树指纹；防 extractPackagedRuntime 用随包覆盖一致的新树）
    writeFileSync(path.join(localRoot, 'runtime.version'), buildUserMarker(version, fingerprint), 'utf8')
    log('info', `harnessUpdate: official harness ${version} installed (tree ${fingerprint})`)
    return { ok: true, message: `官方 Harness 已更新到 v${version}，重启后生效` }
  } catch (err) {
    log('error', `harnessUpdate: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    return { ok: false, message: `官方 Harness 更新失败：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export interface HarnessUpdateResult {
  ok: boolean
  /** 是否真的执行并完成了「整树刷新」。false 时 message 是查询失败/已最新/未开始。 */
  updated: boolean
  message: string
}

/**
 * 执行一次官方 Harness 检查/更新（检测 + 按需整树刷新）。
 * - 有新版 / 本地树不一致（混血）→ 整树刷新（hooks 驱动进度），return { ok, updated: true }。
 * - 已最新且树一致 → { ok, updated: false }。
 * - 失败   → { ok: false, updated: false }。
 * 开发模式直接返回（不做）。
 */
export async function runHarnessUpdate(
  manual: boolean,
  hooks: HarnessUpdateHooks,
): Promise<HarnessUpdateResult> {
  if (!app.isPackaged) {
    log('info', 'harnessUpdate: dev mode, skipped')
    return { ok: false, updated: false, message: '开发模式不执行 Harness 更新' }
  }
  if (updating) {
    return { ok: false, updated: false, message: '官方 Harness 更新已在运行' }
  }
  updating = true
  try {
    const res = await checkHarnessUpdateResult()
    const local = res.local ?? (await readLocalDshVersion())
    if (!res.ok || !res.latest) {
      const msg = '官方 Harness 版本查询失败（网络/registry 不可达）'
      log('info', `harnessUpdate: query failed -> ${msg}`)
      return { ok: false, updated: false, message: msg }
    }
    const { runtimeDir } = runtimePaths()
    const installed = installedVersionFromDir(runtimeDir) ?? local
    if (!updateAvailable(res.local, res.latest, res.consistent)) {
      return { ok: true, updated: false, message: `官方 Harness 已是最新：v${installed}` }
    }
    const versionNewer = res.latest != null && res.local != null && compareDots(res.latest, res.local) > 0
    hooks.onProgress({
      pct: 0,
      detail: versionNewer
        ? `发现官方 Harness 新版：本地 v${installed} → v${res.latest}，开始整树刷新…`
        : `检测到官方 Harness 运行时不完整（依赖树不一致），正在重建到 v${res.latest}…`,
      url: MANUAL_URL,
    })
    const r = await installHarness(res.latest, hooks)
    return { ok: r.ok, updated: r.ok, message: r.message }
  } finally {
    updating = false
  }
}
