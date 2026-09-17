/**
 * Adapted from `deepseek-ai/deepseek-harness` `apps/desktop-host/src/index.ts` (MIT).
 * [ported] Verbatim port apart from this header and the package name in the
 * module tag (`dsh-desktop-host` instead of the upstream scoped name).
 */

/**
 * Electron child-process entry: boots the desktop project without a listening
 * socket and carries API plus validated Web assets over framed byte pipes.
 * @module dsh-desktop-host
 */

import { createRequire } from 'node:module'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { delimiter, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  loadLayeredEnv,
  loadProfileDirectory,
  loadOverlayPatches,
  PROFILE_PATCH_FILENAME,
  readProfileManifest,
  readProfilePatches,
  type ProfileContext,
  type ProfilePnpmInvocation,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-modules'
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
  DesktopHostRequestDecoder,
  encodeDesktopResponseData,
  encodeDesktopResponseEnd,
  encodeDesktopResponseError,
  encodeDesktopResponseStart,
  type DesktopHostRequestFrame,
} from './wire.ts'

export { DESKTOP_HOST_PROTOCOL_VERSION } from './wire.ts'

/** One request forwarded from Electron's `dsh-app://` handler. */
export interface DesktopHostFetchCommand {
  readonly streamId: number
  readonly request: {
    readonly url: string
    readonly method: string
    readonly headers: readonly [string, string][]
  }
}

/** Commands accepted by the desktop child process. */
export type DesktopHostCommand = {
  readonly type: 'shutdown'
}

/** Events emitted by the desktop child process. */
export type DesktopHostEvent = {
  readonly type: 'ready'
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly dshVersion: string
} | {
  readonly type: 'fatal'
  readonly message: string
}

/** Controller returned to tests and the self-executing process entry. */
export interface DesktopHostController {
  /** Installed dsh version carried by this host. */
  readonly dshVersion: string
  /** Dispatch one custom-protocol request and stream its response to the response pipe. */
  fetch(command: DesktopHostFetchCommand, body: ReadableStream<Uint8Array> | null): Promise<void>
  /** Abort one in-flight request. */
  cancel(streamId: number): void
  /** Stop accepting messages and await complete host teardown. */
  dispose(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDesktopHostCommand(message: unknown): message is DesktopHostCommand {
  return typeof message === 'object' && message !== null && 'type' in message
    && (message as Record<string, unknown>).type === 'shutdown'
}

interface PackageManifest {
  readonly name?: string
  readonly version?: string
}

const DESKTOP_PATCH = fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url))
const ROOT_CONFIG = '# Electron desktop composition root; package transactions own this file.\n[]\n'
const ROOT_CONFIG_FILENAME = 'desktop.cordis.yml'
const DESKTOP_STREAM_PATH = '/.dsh/remote-stream'

const DESKTOP_TRANSPORT_SCRIPT = `globalThis.__DSH_TRANSPORT__={
  ownsHost:true,
  async *openStream(endpoint,payload,signal){
    const response=await fetch(${JSON.stringify(DESKTOP_STREAM_PATH)},{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload}),signal
    })
    if(!response.ok||response.body===null)throw new Error('desktop stream transport failed: HTTP '+response.status)
    const reader=response.body.getReader(),decoder=new TextDecoder()
    let pending=''
    for(;;){
      const {done,value}=await reader.read()
      pending+=decoder.decode(value,{stream:!done})
      let newline
      while((newline=pending.indexOf('\\n'))!==-1){
        const line=pending.slice(0,newline);pending=pending.slice(newline+1)
        if(line!=='')yield JSON.parse(line)
      }
      if(done)break
    }
    if(pending!=='')yield JSON.parse(pending)
  }
}`

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

function readManifest(path: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(value)) throw new Error(`dsh desktop: ${path} must contain a package manifest`)
  return {
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
  }
}

function packageManifestPath(projectDir: string, packageName: string): string {
  const path = join(projectDir, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(path)) throw new Error(`dsh desktop: installed package ${JSON.stringify(packageName)} has no manifest`)
  return path
}

function isProjectPath(projectDir: string, target: string): boolean {
  const root = realpathSync(projectDir)
  const path = realpathSync(target)
  return path === root || path.startsWith(root + sep)
}

/**
 * [ported] 官方 CLI 在引导 profile 前会 heal `$DSH_HOME/profiles/node_modules`
 * （安装依赖闭包的模块回退目录，profile 里的 bundle 条目靠 Node 的父目录向上查找
 * 从这里解析 `@deepseek-ai/*`）。官方 desktop-host **没有**这一步——它的宿主环境
 * 由 CLI 先跑过一次，回退目录已经存在；而本壳只用 Host、从不跑 CLI，
 * 因此在全新 DSH_HOME（新用户首启）下必须自己 heal，否则 profile 引导会以
 * 「Cannot find package '@deepseek-ai/dsh-llm' imported from <profile>」失败。
 */
async function healModuleFallback(runtimeDir: string, projectDir: string): Promise<void> {
  const installAnchor = packageManifestPath(runtimeDir, '@deepseek-ai/dsh')
  const profile = loadProfileDirectory('dsh desktop', projectDir, installAnchor)
  await healProfilesModuleFallback({ installAnchor, profile })
}

/** 本壳 profile 名；必须与 `src/main/desktopProfile.ts` 的 DESKTOP_PROFILE 一致。 */
const DESKTOP_PROFILE_NAME = 'dsh-workbench'

/** 随包 dsh 安装锚点（`<runtimeDir>/node_modules/@deepseek-ai/dsh/package.json`）。 */
function dshInstallAnchor(runtimeDir: string): string {
  return packageManifestPath(runtimeDir, '@deepseek-ai/dsh')
}

/**
 * 本壳自有的额外 patch 层，作为 `profileContext.overlays` 交给启动器。
 *
 * 为什么必须走 overlays 而不是自己拼一份列表：官方插件管理器与 HMR 在配置变化时
 * 会用 `readProfilePatches(binName, profileContext)` 重算整棵组合树。只有把自有层
 * 放进 `overlays`，重算结果才与本进程启动时的层序**逐层一致**——否则任何一次
 * 「装插件/改 patch」都会把自有覆盖（例如 agent 预设根）悄悄丢掉。
 *
 * 层内容与移植前等价：随包 `config/desktop.cordis.patch.yml` + agent 预设根指向
 * 随包 dsh 的 `config/agent-presets`（后者按组合树里 `agent-presets` 行的现有配置追加）。
 */
function desktopOverlays(runtimeDir: string, projectDir: string, allowLinkedPackages: boolean): PatchOptions[] {
  const installAnchor = dshInstallAnchor(runtimeDir)
  const dshRoot = dirname(installAnchor)
  const profile = loadProfileDirectory('dsh desktop', projectDir, installAnchor)
  for (const layer of profile.layers) {
    if (!allowLinkedPackages && !isProjectPath(projectDir, layer.packageDir) && !isProjectPath(runtimeDir, layer.packageDir)) {
      throw new Error(`dsh desktop: profile bundle ${JSON.stringify(layer.packageName)} resolved outside the Desktop runtime and profile`)
    }
  }
  const overlays: PatchOptions[] = [loadOverlayPatches('dsh desktop', DESKTOP_PATCH)]
  const rows = new Map(composeEntries([
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    ...overlays,
  ]).flatMap(row => typeof row.id === 'string' ? [[row.id, row] as const] : []))
  const agentPresets = rows.get('agent-presets')
  if (agentPresets !== undefined) {
    overlays.push([{
      id: 'agent-presets',
      config: {
        ...(agentPresets.config ?? {}) as Record<string, unknown>,
        roots: [{ path: join(dshRoot, 'config', 'agent-presets'), trust: 'system' }],
      },
    }])
  }
  return overlays
}

/**
 * 官方「启动器信息」：桌面壳作为 profile 的拥有者，把启动期事实交给 dsh。
 *
 * 这些字段决定官方 `dsh-plugin-manager` 与 `dsh-hmr` 是否激活——`dsh-base` 的
 * patch 里两行的开关就是 `disabled: !!js "!ctx.get('profileContext')"`。因此
 * 「随包 pnpm + 真 profile 上下文」不是可选增强，而是官方插件系统的前置条件：
 * 缺了它，Web 端「插件」页只会报自己不可用，插件管理只能退回壳自研实现。
 *
 * `packageManager` 是启动器提供的内置包管理器调用（离线前提）：命令用随包 Node，
 * 参数是随包 pnpm 入口，环境只作用于包操作子进程（官方 `ProfilePnpmInvocation` 语义）。
 */
function desktopProfileContext(
  runtimeDir: string,
  projectDir: string,
  allowLinkedPackages: boolean,
  packageManager: ProfilePnpmInvocation | undefined,
): ProfileContext {
  const installAnchor = dshInstallAnchor(runtimeDir)
  return {
    name: DESKTOP_PROFILE_NAME,
    dir: projectDir,
    patchPath: join(projectDir, PROFILE_PATCH_FILENAME),
    installAnchor,
    cwd: process.cwd(),
    home: resolveDshHome(),
    startedBundles: [...(readProfileManifest('dsh desktop', projectDir).dsh?.profile?.bundles ?? [])],
    overlays: desktopOverlays(runtimeDir, projectDir, allowLinkedPackages),
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    ...(packageManager === undefined ? {} : { packageManager }),
  }
}

/**
 * 随包 pnpm 的启动器调用形式：`<随包 Node> --expose-internals <pnpm 入口> <子命令…>`。
 * `PATH` 前缀让 pnpm 内部再 spawn `node` 时仍命中随包 Node；其余环境由官方
 * `runProfilePnpm` 自行清理（`extendEnv: false` + scrubbedParentEnv）。
 */
function desktopPackageManager(pnpmEntry: string | undefined): ProfilePnpmInvocation | undefined {
  if (pnpmEntry === undefined) return undefined
  const nodeDir = dirname(process.execPath)
  return {
    command: process.execPath,
    args: ['--expose-internals', resolve(pnpmEntry)],
    env: {
      DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ''}`,
    },
  }
}

/**
 * 启动器就绪信号（与官方 `@deepseek-ai/dsh/profile-boot` 的 `createAppReady` 同语义）。
 *
 * 为什么必须有：`dsh-hmr` 在 `profileContext` 在场时会 `ctx.get('appReady')`，拿不到就直接
 * 抛 `Profile HMR requires application readiness`（组合树启动失败）。官方 launcher 在树
 * 安定（fiber ACTIVE + loader 在场）后 `commit()`；我们照同判据提交。
 */
function createAppReady(): {
  readonly service: { readonly onReady: (listener: () => void) => () => void }
  readonly commit: () => void
} {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener: () => void): () => void {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    commit(): void {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

function dshVersion(runtimeDir: string): string {
  const manifest = readManifest(packageManifestPath(runtimeDir, '@deepseek-ai/dsh'))
  if (typeof manifest.version !== 'string') throw new Error('dsh desktop: installed dsh manifest has no version')
  return manifest.version
}

function assetHandler(ctx: Context, runtimeDir: string): ConnectionFetchHandler {
  const require = createRequire(join(runtimeDir, 'package.json'))
  const distIndex = require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  const distRoot = realpathSync(dirname(distIndex))
  const renderIndex = async (): Promise<Response> => {
    const rows: IndexInjection[] = [{ kind: 'script', placement: 'head', text: DESKTOP_TRANSPORT_SCRIPT }]
    ctx.emit('webserver/index-inject', rows)
    const body = renderIndexInjections(await readFile(distIndex, 'utf8'), rows)
    return new Response(body, { headers: { 'content-type': MIME['.html'] ?? 'text/html; charset=utf-8' } })
  }
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
      const url = new URL(request.url)
      if (url.pathname.startsWith('/plugins/')) return ctx.clientModules.fetchBundle(request)
      let pathname: string
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        return new Response(null, { status: 400 })
      }
      if (pathname === '/' || pathname === '/index.html') return renderIndex()
      const target = resolve(normalize(join(distRoot, pathname)))
      if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
      try {
        const realTarget = realpathSync(target)
        if (realTarget !== distRoot && !realTarget.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
        return new Response(request.method === 'HEAD' ? null : await readFile(realTarget), {
          headers: { 'content-type': MIME[extname(realTarget)] ?? 'application/octet-stream' },
        })
      } catch {
        return renderIndex()
      }
    },
  }
}

function remoteStreamHandler(ctx: Context): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request): Promise<Response> {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const gateway = ctx.get('typertGateway')
      if (gateway === undefined) return new Response('gateway unavailable', { status: 503 })
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      if (!isRecord(body) || typeof body.endpoint !== 'string') {
        return new Response('invalid stream request', { status: 400 })
      }
      const abort = new AbortController()
      const cancel = (): void => { abort.abort(request.signal.reason) }
      request.signal.addEventListener('abort', cancel, { once: true })
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const values = await gateway.wireStream.open(body.endpoint as string, body.payload, abort.signal)
            for await (const value of values) {
              controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
            }
            controller.close()
          } catch (error) {
            controller.error(error)
          } finally {
            request.signal.removeEventListener('abort', cancel)
          }
        },
        cancel(reason) {
          abort.abort(reason)
          request.signal.removeEventListener('abort', cancel)
        },
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
    },
  }
}

interface NodeRequestInit extends RequestInit {
  readonly duplex?: 'half'
}

/**
 * Boot one installed desktop npm project.
 * @param runtimeDir - immutable dsh packages supplied by the Electron application.
 * @param projectDir - active or staged Electron-owned desktop profile.
 * @param writeResponse - serialized response-pipe writer that applies byte backpressure.
 * @param options - development-only allowance for workspace-linked bundle packages, plus the
 *   bundled pnpm entry that becomes the profile's launcher-provided package manager.
 * @returns controller after every Host and client-manifest row is active.
 */
export async function runDesktopHost(
  runtimeDir: string,
  projectDir: string,
  writeResponse: (frame: Buffer) => Promise<void>,
  options: { allowLinkedPackages?: boolean; pnpmEntry?: string } = {},
): Promise<DesktopHostController> {
  const absoluteProject = resolve(projectDir)
  mkdirSync(absoluteProject, { recursive: true })
  const rootConfig = join(absoluteProject, ROOT_CONFIG_FILENAME)
  writeFileSync(rootConfig, ROOT_CONFIG)
  const environment = loadLayeredEnv('dsh desktop')
  // 见 healModuleFallback：全新 DSH_HOME 下 profile 的模块回退目录必须先就位
  await healModuleFallback(resolve(runtimeDir), absoluteProject)
  const profileContext = desktopProfileContext(
    resolve(runtimeDir),
    absoluteProject,
    options.allowLinkedPackages === true,
    desktopPackageManager(options.pnpmEntry),
  )
  const appReady = createAppReady()
  let current: Context | undefined
  // 层序由官方 `readProfilePatches` 计算：bundle 层 → profile patch → home patch → 自有 overlays。
  // 与插件管理器/HMR 的重算入口同一个函数，保证运行中的树与磁盘配置永不漂移。
  const ctx = await boot('dsh desktop', rootConfig, readProfilePatches('dsh desktop', profileContext), (hostCtx) => {
    current = hostCtx
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    // 官方插件系统（dsh-plugin-manager / dsh-hmr）的激活条件；见 desktopProfileContext 的说明。
    hostCtx.provide('profileContext', profileContext)
    // appReady 同样是 dsh-hmr 的硬前提（缺了会以「Profile HMR requires application readiness」拒绝启动）。
    provideCmdline(hostCtx, { args: [], exit: () => {}, ready: appReady.service })
  })
  // 官方判据：树已安定（fiber ACTIVE = 2）且 loader 服务在场才提交就绪。
  if (ctx.fiber.state === 2 && ctx.get('loader') !== undefined) appReady.commit()
  current = ctx
  const connection = ctx.get('connection')
  const clientModules = ctx.get('clientModules')
  const gateway = ctx.get('typertGateway')
  if (connection === undefined || clientModules === undefined || gateway === undefined) {
    await ctx.fiber.dispose()
    throw new Error('dsh desktop: composition did not provide connection, typertGateway, and clientModules')
  }
  const api = connection.createSharedFetchHandler('/api')
  const assets = assetHandler(ctx, resolve(runtimeDir))
  const streams = remoteStreamHandler(ctx)
  const requests = new Map<number, AbortController>()
  let disposing: Promise<void> | undefined

  const dispose = async (): Promise<void> => {
    disposing ??= (async () => {
      for (const controller of requests.values()) controller.abort()
      requests.clear()
      await current?.fiber.dispose()
      current = undefined
    })()
    await disposing
  }

  return {
    dshVersion: dshVersion(resolve(runtimeDir)),
    cancel(streamId) {
      requests.get(streamId)?.abort()
    },
    async fetch(command, body) {
      if (disposing !== undefined) throw new Error('dsh desktop: host is disposing')
      const controller = new AbortController()
      requests.set(command.streamId, controller)
      try {
        const url = new URL(command.request.url)
        const init: NodeRequestInit = {
          method: command.request.method,
          headers: new Headers(command.request.headers.map(([name, value]) => [name, value] as [string, string])),
          ...(body === null ? {} : { body, duplex: 'half' }),
          signal: controller.signal,
        }
        const request = new Request(url, init)
        const response = url.pathname === DESKTOP_STREAM_PATH
          ? await streams.fetch(request)
          : url.pathname.startsWith('/api/')
            ? await api.fetch(request)
            : await assets.fetch(request)
        await writeResponse(encodeDesktopResponseStart(command.streamId, {
          status: response.status,
          headers: [...response.headers.entries()],
          hasBody: response.body !== null,
        }))
        if (response.body !== null) {
          for await (const chunk of response.body) {
            const bytes = Buffer.from(chunk)
            for (let offset = 0; offset < bytes.byteLength; offset += DESKTOP_PIPE_CHUNK_BYTES) {
              await writeResponse(encodeDesktopResponseData(
                command.streamId,
                bytes.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES),
              ))
            }
          }
        }
        await writeResponse(encodeDesktopResponseEnd(command.streamId))
      } catch (error) {
        if (!controller.signal.aborted) {
          await writeResponse(encodeDesktopResponseError(
            command.streamId,
            error instanceof Error ? error.message : String(error),
          ))
        }
      } finally {
        requests.delete(command.streamId)
      }
    },
    dispose,
  }
}

async function main(): Promise<void> {
  const runtimeDir = process.argv[2]
  const projectDir = process.argv[3]
  if (runtimeDir === undefined || projectDir === undefined || process.send === undefined) {
    throw new Error('dsh desktop: expected runtime and profile directories, byte pipes, and a Node IPC channel')
  }
  // 内部选项：`--allow-linked-profile`（开发：放行 workspace 链接的 bundle）、
  // `--pnpm <入口>`（随包 pnpm，作为启动器提供的包管理器交给 profileContext）。
  let allowLinkedPackages = false
  let pnpmEntry: string | undefined
  const argv = process.argv.slice(4)
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--allow-linked-profile') {
      allowLinkedPackages = true
      continue
    }
    if (flag === '--pnpm') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('dsh desktop: --pnpm requires a path')
      pnpmEntry = value
      index += 1
      continue
    }
    throw new Error(`dsh desktop: unsupported internal option ${JSON.stringify(flag)}`)
  }
  const requestPipe = createReadStream('', { fd: DESKTOP_REQUEST_PIPE_FD, autoClose: false })
  const responsePipe = createWriteStream('', { fd: DESKTOP_RESPONSE_PIPE_FD, autoClose: false })
  let responseWriteTail: Promise<void> = Promise.resolve()
  const writeResponse = (frame: Buffer): Promise<void> => {
    const write = responseWriteTail.then(async () => {
      if (responsePipe.destroyed) throw new Error('dsh desktop: Electron response pipe is unavailable')
      if (!responsePipe.write(frame)) await once(responsePipe, 'drain')
    })
    responseWriteTail = write.catch(() => undefined)
    return write
  }
  const send = (event: DesktopHostEvent): void => {
    if (process.send === undefined || !process.connected) return
    try {
      process.send(event)
    } catch (error) {
      // A concurrent parent disconnect owns teardown; only that closed-channel
      // condition is safe to discard while streamed responses unwind.
      if ((error as NodeJS.ErrnoException).code !== 'ERR_IPC_CHANNEL_CLOSED') throw error
    }
  }
  const controller = await runDesktopHost(runtimeDir, projectDir, writeResponse, {
    allowLinkedPackages,
    ...(pnpmEntry === undefined ? {} : { pnpmEntry }),
  })
  send({
    type: 'ready',
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    dshVersion: controller.dshVersion,
  })
  const decoder = new DesktopHostRequestDecoder()
  const requestBodies = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
  const blockedRequests = new Set<number>()
  const discardedRequestBodies = new Set<number>()
  const runs = new Set<Promise<void>>()
  let lastStreamId = 0
  let requestedExitCode = 0
  let stopping: Promise<void> | undefined

  const resumeRequestPipe = (): void => {
    if (blockedRequests.size === 0) requestPipe.resume()
  }

  const stop = (exitCode = 0): Promise<void> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode)
    stopping ??= (async () => {
      requestPipe.pause()
      requestPipe.removeAllListeners('data')
      const stopped = new Error('dsh desktop: Host is stopping')
      for (const body of requestBodies.values()) body.error(stopped)
      requestBodies.clear()
      blockedRequests.clear()
      discardedRequestBodies.clear()
      requestPipe.destroy()
      closeSync(DESKTOP_REQUEST_PIPE_FD)
      await controller.dispose()
      await Promise.allSettled([...runs])
      await responseWriteTail.catch(() => undefined)
      if (!responsePipe.destroyed) {
        await new Promise<void>((resolvePromise) => { responsePipe.end(resolvePromise) })
        responsePipe.destroy()
      }
      closeSync(DESKTOP_RESPONSE_PIPE_FD)
      if (process.connected) process.disconnect()
      process.exitCode = requestedExitCode
    })()
    return stopping
  }

  const failTransport = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    send({ type: 'fatal', message })
    void stop(1)
  }

  const beginRequest = (frame: Extract<DesktopHostRequestFrame, { type: 'start' }>): void => {
    if (frame.streamId <= lastStreamId) {
      throw new Error(`dsh desktop: Electron reused or reordered request stream ${String(frame.streamId)}`)
    }
    lastStreamId = frame.streamId
    let body: ReadableStream<Uint8Array> | null = null
    if (frame.hasBody) {
      body = new ReadableStream<Uint8Array>({
        start(controllerOfBody) {
          requestBodies.set(frame.streamId, controllerOfBody)
        },
        pull() {
          blockedRequests.delete(frame.streamId)
          resumeRequestPipe()
        },
        cancel() {
          requestBodies.delete(frame.streamId)
          blockedRequests.delete(frame.streamId)
          controller.cancel(frame.streamId)
          resumeRequestPipe()
        },
      })
    }
    const run = controller.fetch({
      streamId: frame.streamId,
      request: {
        url: frame.url,
        method: frame.method,
        headers: frame.headers,
      },
    }, body)
    runs.add(run)
    void run.catch(failTransport).finally(() => {
      runs.delete(run)
      const openBody = requestBodies.get(frame.streamId)
      if (openBody === undefined) return
      openBody.error(new Error('dsh desktop: response completed before the request body ended'))
      requestBodies.delete(frame.streamId)
      blockedRequests.delete(frame.streamId)
      discardedRequestBodies.add(frame.streamId)
      resumeRequestPipe()
    })
  }

  const handleRequestFrame = (frame: DesktopHostRequestFrame): void => {
    switch (frame.type) {
      case 'start':
        beginRequest(frame)
        return
      case 'data': {
        const body = requestBodies.get(frame.streamId)
        if (body === undefined) {
          if (discardedRequestBodies.has(frame.streamId)) return
          throw new Error(`dsh desktop: Electron sent body data for inactive stream ${String(frame.streamId)}`)
        }
        body.enqueue(frame.data)
        if ((body.desiredSize ?? 0) <= 0) {
          blockedRequests.add(frame.streamId)
          requestPipe.pause()
        }
        return
      }
      case 'end': {
        const body = requestBodies.get(frame.streamId)
        if (body === undefined) {
          if (discardedRequestBodies.delete(frame.streamId)) return
          throw new Error(`dsh desktop: Electron ended inactive body stream ${String(frame.streamId)}`)
        }
        body.close()
        requestBodies.delete(frame.streamId)
        blockedRequests.delete(frame.streamId)
        resumeRequestPipe()
        return
      }
      case 'cancel': {
        if (frame.streamId > lastStreamId) {
          throw new Error(`dsh desktop: Electron canceled unknown stream ${String(frame.streamId)}`)
        }
        const body = requestBodies.get(frame.streamId)
        body?.error(new Error('dsh desktop: Electron canceled the request'))
        requestBodies.delete(frame.streamId)
        blockedRequests.delete(frame.streamId)
        discardedRequestBodies.delete(frame.streamId)
        controller.cancel(frame.streamId)
        resumeRequestPipe()
        return
      }
      default:
        frame satisfies never
    }
  }

  requestPipe.on('data', (chunk: string | Buffer) => {
    try {
      for (const frame of decoder.push(Buffer.from(chunk))) handleRequestFrame(frame)
    } catch (error) {
      failTransport(error)
    }
  })
  requestPipe.once('end', () => {
    if (stopping !== undefined) return
    try {
      decoder.finish()
      failTransport(new Error('dsh desktop: Electron request pipe ended'))
    } catch (error) {
      failTransport(error)
    }
  })
  requestPipe.once('error', failTransport)
  responsePipe.once('error', failTransport)
  process.on('message', (message: unknown) => {
    if (!isDesktopHostCommand(message)) {
      send({ type: 'fatal', message: 'dsh desktop: invalid Electron IPC command' })
      void stop(1)
      return
    }
    void stop()
  })
  process.once('disconnect', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  process.once('SIGINT', () => { void stop() })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (process.send !== undefined) process.send({ type: 'fatal', message } satisfies DesktopHostEvent)
    else process.stderr.write(`dsh desktop: ${message}\n`)
    process.exitCode = 1
  })
}
