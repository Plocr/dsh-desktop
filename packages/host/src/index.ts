/**
 * Desktop Host entry —— 与官方 `apps/desktop-host` 同形（MIT）：
 *
 *   runProfile(官方启动器) → 真实 Web Host（默认监听 19387）→ 把**认证 URL** 与
 *   **index 注入片段**经 Node IPC 交给 Electron；Electron 负责静态资源与请求转发。
 *
 * 为什么不再自造传输：官方桌面端就是这么做的——Host 起的是同一个 Web 应用（同一套
 * 认证、注入、WebSocket 流、目录选择），桌面壳只做「本地窗口 + 转发」。历史上的
 * fd3/fd4 字节管道（`--port 0` 无监听端口形态）已随本次迁移删除。
 *
 * 本文件与官方的差异只有两点，都是本壳的发行约束：
 *  1. profile **目录**是本壳自有的 `dsh-workbench`（官方用保留名 `desktop`，其 CLI 会硬拒绝
 *     该名），但交给启动器的 **profile 身份名仍是 `desktop`**——desktop-only 的官方行按它开关，
 *     见下面 `DESKTOP_PROFILE_IDENTITY` 的说明；
 *  2. `packageManager` 指向**随包 pnpm 与桌面自有 store**（离线 + 与既有 profile 的
 *     node_modules 保持同一个 store，避免 pnpm 的 ERR_PNPM_UNEXPECTED_STORE）。
 *
 * @module dsh-desktop-host
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/**
 * 交给官方启动器的 **profile 身份名**：官方桌面端在这里报 `desktop`，而 `desktop` 这个名字
 * 是官方组合树里若干 desktop-only 行的开关（`dsh-base` 的
 * `deepseek-account.desktopPlatform`、`dsh-web-app` 的 `ui-sidebar-browser`）。
 *
 * 本壳的 profile **目录**是自有名 `dsh-workbench`（见 `resolvedProfile` 传入的
 * `loadProfileDirectory(...)` 结果；官方 CLI 会硬拒绝 `--profile desktop`，而那是
 * 官方 Electron 应用的保留名）。目录与身份分开之后：盘上不占用官方保留目录，
 * 组合树里仍是**桌面端**——否则官方账号插件不会带 `x-client-platform: desktop-*`
 * 请求头（登录会被平台拒绝），桌面侧的浏览器标签也不会挂载。
 */
const DESKTOP_PROFILE_IDENTITY = 'desktop'

/** 官方桌面端使用的 loopback 端口（与 Web 的 3080 分开）。 */
const DEFAULT_PORT = 19387

/** Desktop 自有包管理器状态目录（相对 `$DSH_HOME`；与旧事务实现保持同一布局）。 */
const PNPM_STATE_DIR = join('desktop', 'pnpm')

/** 随包 Node + 随包 pnpm + 桌面自有 store 的启动器调用（官方 `ProfilePnpmInvocation`）。 */
function desktopPackageManager(pnpmEntry: string): {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
} {
  const nodeDir = dirname(process.execPath)
  const root = join(resolveDshHome(), PNPM_STATE_DIR)
  const store = join(root, 'store')
  const cache = join(root, 'cache')
  const state = join(root, 'state')
  const config = join(root, 'config')
  const home = join(root, 'home')
  for (const dir of [store, cache, state, config, home]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const npmrc = join(config, 'npmrc')
  if (!existsSync(npmrc)) {
    try {
      appendFileSync(npmrc, '')
    } catch {
      /* 不可写时交给 pnpm 报错 */
    }
  }
  return {
    command: process.execPath,
    // 子命令之前放全局参数：pnpm 接受 `pnpm --config.x=y <command>`。
    // store-dir 与旧的壳内事务完全一致 —— 既有 profile 的 node_modules 就是从这个 store
    // 链接出来的，换 store 会让 pnpm 直接 ERR_PNPM_UNEXPECTED_STORE。
    //
    // 注意这里的 `command` 是本进程的 execPath：宿主已经跑在**自家 Electron 二进制**上
    // （ELECTRON_RUN_AS_NODE 模式），所以 pnpm 也由同一个二进制执行——不再随包一个独立的
    // node.exe（杀软误报面 + 50 MB 体积，见 docs/ANTIVIRUS-FALSE-POSITIVE.md）。
    // `--expose-internals` 已移除：实测 pnpm 11 的 install/add/remove 都不需要它，
    // 而这个 flag 在行为启发式里非常显眼。
    args: [
      resolve(pnpmEntry),
      '--config.registry=https://registry.npmjs.org/',
      `--config.store-dir=${store}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${npmrc}`,
    ],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ''}`,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      PNPM_HOME: home,
      COREPACK_HOME: home,
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      NPM_CONFIG_STORE_DIR: store,
      NPM_CONFIG_USERCONFIG: npmrc,
    },
  }
}

/** Installed dsh version carried by this Host (read from the runtime tree). */
function dshVersion(runtimeDir: string): string {
  const path = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('dsh desktop: installed dsh manifest has no version')
  return manifest.version
}

/** Events emitted by the desktop child process. */
export type DesktopHostEvent = {
  readonly type: 'ready'
  readonly dshVersion: string
  /** Authenticated base URL of the owned Web Host (carries the one-time token). */
  readonly url: string
  /** Index injections the window must apply before the client boots. */
  readonly injections: readonly unknown[]
} | {
  readonly type: 'shutdown-complete'
} | {
  readonly type: 'fatal'
  readonly message: string
}

/** Controller returned to tests and the self-executing process entry. */
export interface DesktopHostController {
  readonly dshVersion: string
  /** Authenticated URL reported by the owned Host. */
  readonly url: string
  /** Boot injections collected from the Host's index pipeline. */
  readonly injections: readonly unknown[]
  /** Stop the profile and release its resources. Safe to call twice. */
  dispose(): Promise<void>
}

/**
 * Boot one application-owned profile through the official launcher.
 * @param runtimeDir - immutable dsh packages supplied by the Electron application.
 * @param projectDir - active Electron-owned desktop profile.
 * @param options - bundled pnpm entry, loopback port, and the development-only linked-package allowance.
 * @returns controller after the Host accepts application requests.
 */
export async function runDesktopHost(
  runtimeDir: string,
  projectDir: string,
  options: { pnpmEntry?: string; port?: number; allowLinkedPackages?: boolean } = {},
): Promise<DesktopHostController> {
  const absoluteProject = resolve(projectDir)
  mkdirSync(absoluteProject, { recursive: true })
  const installAnchor = join(resolve(runtimeDir), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', absoluteProject, installAnchor)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: DESKTOP_PROFILE_IDENTITY,
    // 官方：打包走 runtime（按解析代强制解析），开发走 link（把链接物化进 profile）。
    resolutionMode: options.allowLinkedPackages === true ? 'link' : 'runtime',
    resolvedProfile: { profile, installAnchor },
    // 官方桌面端不加任何私有补丁文件：桌面与浏览器共用同一套组合，
    // 差异只在「--no-open」与 Electron 侧的原生能力上。
    patchFiles: [],
    // `--no-open` 是官方桌面端的关键参数：绝不在启动时拉起浏览器（用户手动点托盘才开）。
    args: ['--no-open', '--port', String(options.port ?? DEFAULT_PORT)],
    ...(options.pnpmEntry === undefined ? {} : { packageManager: desktopPackageManager(options.pnpmEntry) }),
  })
  let stopping: Promise<void> | undefined
  const dispose = (): Promise<void> => stopping ??= (async () => {
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
  })()
  const { ctx } = await application
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  return {
    dshVersion: dshVersion(resolve(runtimeDir)),
    url,
    injections: ctx.webServer.collectIndexInjections(),
    dispose,
  }
}

async function main(): Promise<void> {
  const runtimeDir = process.argv[2]
  const projectDir = process.argv[3]
  if (runtimeDir === undefined || projectDir === undefined || process.send === undefined) {
    throw new Error('dsh desktop: expected runtime and profile directories plus a Node IPC channel')
  }
  let pnpmEntry: string | undefined
  let port: number | undefined
  let allowLinkedPackages = false
  const argv = process.argv.slice(4)
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--allow-linked-profile') {
      allowLinkedPackages = true
      continue
    }
    if (flag === '--pnpm' || flag === '--port') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`dsh desktop: ${flag} requires a value`)
      if (flag === '--pnpm') pnpmEntry = value
      else {
        const parsed = Number.parseInt(value, 10)
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`dsh desktop: invalid --port ${value}`)
        port = parsed
      }
      index += 1
      continue
    }
    throw new Error(`dsh desktop: unsupported internal option ${JSON.stringify(flag)}`)
  }

  const send = (event: DesktopHostEvent): void => {
    if (process.send === undefined || !process.connected) return
    try {
      process.send(event)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_IPC_CHANNEL_CLOSED') throw error
    }
  }

  const controller = await runDesktopHost(runtimeDir, projectDir, {
    ...(pnpmEntry === undefined ? {} : { pnpmEntry }),
    ...(port === undefined ? {} : { port }),
    allowLinkedPackages,
  })
  send({
    type: 'ready',
    dshVersion: controller.dshVersion,
    url: controller.url,
    injections: controller.injections,
  })

  let requestedExitCode = 0
  let stopping: Promise<void> | undefined
  const stop = (exitCode = 0): Promise<void> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode)
    stopping ??= (async () => {
      await controller.dispose()
      send({ type: 'shutdown-complete' })
      if (process.connected) process.disconnect()
      process.exitCode = requestedExitCode
    })()
    return stopping
  }
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'shutdown') {
      void stop()
      return
    }
    send({ type: 'fatal', message: 'dsh desktop: invalid Electron IPC command' })
    void stop(1)
  })
  process.once('disconnect', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  process.once('SIGINT', () => { void stop() })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (process.send !== undefined && process.connected) process.send({ type: 'fatal', message } satisfies DesktopHostEvent)
    else process.stderr.write(`dsh desktop: ${message}\n`)
    process.exitCode = 1
  })
}
