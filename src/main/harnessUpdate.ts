/**
 * 官方 Harness（DeepSeek Harness @deepseek-ai/dsh）本地更新 —— 「直接下载最新版替换本地版本」。
 *
 * 术语对齐（与用户一致）：
 *  - 「框架」= DSH Desktop（外壳，版本如 0.6.0）
 *  - 「官方 Harness」= deepseek-ai/deepseek-harness 发行到 npm 的 @deepseek-ai/dsh（本体）
 *
 * 流程：
 *  1. 检测：npm registry（官方失败回退 npmmirror 镜像）取最大已发布版本；
 *  2. 下载：npm tgz（优先 npmmirror 镜像加速），带进度回调 —— 进度条 + 下载地址展示；
 *  3. 解压并用 atomic 替换 runtime/node_modules/@deepseek-ai/dsh（含回滚）；
 *  4. 写入用户自更新 marker（tar=user-*），extractPackagedRuntime 因此不会被重复解压覆盖；
 *  5. 重启 harness 生效。
 *
 * 只替换 dsh 包本体：便携 Node 与 bridge 不变。开发模式跳过。
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { log } from './logger'
import { checkHarnessUpdateResult, readLocalDshVersion } from './harnessCheck'
import { buildUserMarker } from './runtimeMarker'
import { appDataRoot } from './runtime'

const OFFICIAL_TGZ = (v: string) => `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${v}.tgz`
const MIRROR_TGZ = (v: string) => `https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-${v}.tgz`
/** 单源下载超时（毫秒）。 */
const DOWNLOAD_TIMEOUT_MS = 8 * 60_000

export interface HarnessProgress {
  /** 0-100；null 表示不确定（未知总大小）。 */
  pct: number | null
  detail: string
  /** 当前正在下载的 tgz 地址（供用户复制/手动下载）。 */
  url: string | null
}

export interface HarnessUpdateHooks {
  onProgress: (p: HarnessProgress) => void
}

let updating = false

/** 已解压运行时的本地根目录与运行时目录。 */
function runtimePaths(): { localRoot: string; runtimeDir: string } {
  const localRoot = path.join(appDataRoot(), 'DSH Desktop')
  return { localRoot, runtimeDir: path.join(localRoot, 'runtime') }
}

/** 干净地执行 tar -xzf。 */
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

/** 下载 url → dest，流式报告进度。 */
async function downloadFile(url: string, dest: string, onProgress: (p: HarnessProgress) => void): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
  let received = 0
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    const total = Number(res.headers.get('content-length')) || 0
    const body = res.body
    if (!body) throw new Error('响应无数据流')
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(dest)
      const reader = body.getReader()
      const pump = async (): Promise<void> => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            received += value.byteLength
            if (!ws.write(Buffer.from(value))) await new Promise((r) => ws.once('drain', r))
            const pct = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null
            onProgress({ pct, detail: `已下载 ${(received / 1024 / 1024).toFixed(1)} MB${total > 0 ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''}`, url })
          }
          ws.end()
          ws.on('finish', resolve)
          ws.on('error', reject)
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
      void pump()
    })
  } finally {
    clearTimeout(t)
  }
}

/** 计算「决定性」内容指纹：package.json + lib/bin.js 的 sha256。 */
function contentHash(pkgDir: string): string {
  const h = createHash('sha256')
  for (const rel of ['package.json', 'lib/bin.js']) {
    try {
      h.update(readFileSync(path.join(pkgDir, rel)))
    } catch {
      h.update(Buffer.from('missing:' + rel))
    }
  }
  return h.digest('hex').slice(0, 16)
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

/** 下载并替换官方 Harness 到版本 version，返回安装结果。 */
async function installHarness(version: string, hooks: HarnessUpdateHooks): Promise<{ ok: boolean; message: string }> {
  const { localRoot, runtimeDir } = runtimePaths()
  if (!existsSync(runtimeDir)) {
    return { ok: false, message: '运行时目录不存在（尚未解压）' }
  }
  const work = path.join(runtimeDir, `.harness-update-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const tarball = path.join(work, 'dsh.tgz')
  const extractDir = path.join(work, 'x')

  const candidates = [MIRROR_TGZ(version), OFFICIAL_TGZ(version)]
  const tried = new Set<string>()

  try {
    // 下载：优先 npmmirror 镜像，失败回退官方
    let downloadedUrl: string | null = null
    let lastErr: Error | null = null
    for (const url of candidates) {
      if (tried.has(url)) continue
      tried.add(url)
      try {
        hooks.onProgress({ pct: 0, detail: `开始下载官方 Harness v${version}（${candidates.indexOf(url) === 0 ? '镜像' : '官方'}源）…`, url })
        await downloadFile(url, tarball, hooks.onProgress)
        downloadedUrl = url
        break
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))
        log('info', `harnessUpdate: download ${url} failed: ${lastErr.message}`)
      }
    }
    if (!downloadedUrl) {
      return {
        ok: false,
        message: `官方 Harness 下载失败：${lastErr ? lastErr.message : '未知错误'}。可手动下载 ${candidates[0]}`,
      }
    }

    // 解压 npm tgz（内含 package/ 目录）
    hooks.onProgress({ pct: null, detail: '正在解压 Harness 包…', url: downloadedUrl })
    mkdirSync(extractDir, { recursive: true })
    await spawnOk('tar', ['-xzf', tarball, '-C', extractDir], 120_000)
    let pkgDir = path.join(extractDir, 'package')
    if (!existsSync(pkgDir)) {
      // 个别包根目录带版本名
      const inner = readdirSync(extractDir).filter((e) => existsSync(path.join(extractDir, e, 'package.json')) && !e.startsWith('.'))
      if (inner.length === 1) pkgDir = path.join(extractDir, inner[0])
    }
    if (!existsSync(path.join(pkgDir, 'lib', 'bin.js'))) {
      throw new Error('下载的包不完整（缺少 lib/bin.js）')
    }

    hooks.onProgress({ pct: null, detail: '正在替换本地运行时…', url: downloadedUrl })
    const target = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
    const backup = path.join(work, 'old-dsh')
    if (existsSync(target)) renameSync(target, backup)
    try {
      renameSync(pkgDir, target)
    } catch (err) {
      // 目标可能被占用（如正在运行的进程读取）；回滚
      if (existsSync(backup) && !existsSync(target)) renameSync(backup, target)
      throw err
    }
    if (!existsSync(path.join(target, 'lib', 'bin.js'))) {
      rmSync(target, { recursive: true, force: true })
      if (existsSync(backup)) renameSync(backup, target)
      throw new Error('替换后校验失败，已回滚')
    }
    rmSync(backup, { recursive: true, force: true })

    // 写用户自更新 marker（防止 extractPackagedRuntime 用随包覆盖）
    writeFileSync(path.join(localRoot, 'runtime.version'), buildUserMarker(version, contentHash(target)), 'utf8')
    log('info', `harnessUpdate: official harness ${version} installed at ${target}`)
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
  /** 是否真的执行并完成了「下载+替换」。false 时 message 是查询失败/已最新/未开始。 */
  updated: boolean
  message: string
}

/**
 * 执行一次官方 Harness 检查/更新（检测 + 按需下载替换）。
 * - 有新版 → 直接本地下载替换（hooks 驱动进度条），return { ok, updated: true }。
 * - 已最新 → { ok, updated: false }。
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
    if (!res.available) {
      return { ok: true, updated: false, message: `官方 Harness 已是最新：v${installed}` }
    }
    hooks.onProgress({ pct: 0, detail: `发现官方 Harness 新版：本地 v${installed} → v${res.latest}，开始本地更新…`, url: null })
    const r = await installHarness(res.latest, hooks)
    return { ok: r.ok, updated: r.ok, message: r.message }
  } finally {
    updating = false
  }
}
