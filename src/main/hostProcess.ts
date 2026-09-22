/**
 * Host 子进程（官方桌面端形态）：spawn → 等 Node IPC 的 `ready{url,injections}` →
 * 之后所有应用请求都由主进程带 cookie 转发到该 URL。
 *
 * 与旧实现（fd3/fd4 字节管道 + 自研帧协议）的差别：这里**没有管道**，Host 是真正的
 * Web 应用（`runProfile` 起的 127.0.0.1:19387），Electron 只做「本地窗口 + 转发」。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { log } from './logger.ts'
import { authenticateWebHost, forwardWebRequest } from './webDocument.ts'

/** 与 Host 之间变更过的 IPC 契约版本（结构变化时必须递增，壳据此拒绝不匹配的 Host）。 */
export const DESKTOP_HOST_PROTOCOL_VERSION = 4

/** 保留的 stderr 尾巴上限（UTF-16 代码单元；与官方桌面端一致的最后 64 Ki 字符）。 */
export const STDERR_TAIL_LIMIT = 64 * 1024

/** One `ready` event from the owned Host process. */
export interface DesktopHostReady {
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly dshVersion: string
  /** Authenticated base URL of the owned Web Host. */
  readonly url: string
  /** Index injections the application window must apply before boot. */
  readonly injections: readonly unknown[]
}

type HostMessage =
  | { readonly type: 'ready'; readonly dshVersion?: unknown; readonly url?: unknown; readonly injections?: unknown }
  | { readonly type: 'shutdown-complete' }
  | { readonly type: 'fatal'; readonly message?: unknown }

function messageType(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' ? type : null
}

/**
 * One spawned Host process with its authenticated URL and cookie.
 *
 * Lifecycle: `start()` resolves after readiness; `fetch()` forwards application requests;
 * `stop()` asks for a clean shutdown and waits for `shutdown-complete` before killing.
 */
export class DesktopHostProcess {
  // 注意：这里不用 TypeScript 的「构造函数参数属性」——Node 的类型擦除（strip-only）
  // 不支持该语法，而测试会直接 import 本模块（经 release.ts 的链路）。
  private readonly node: string
  private readonly runtimeDir: string
  private readonly projectDir: string
  private readonly inspectPort: number | undefined
  private readonly environment: NodeJS.ProcessEnv
  private readonly onFailure: ((error: Error) => void) | undefined
  private readonly onStdout: ((line: string) => void) | undefined
  private readonly onStderr: ((line: string) => void) | undefined
  private readonly onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  private readonly pnpmEntry: string | undefined
  private readonly allowLinkedPackages: boolean
  private readonly port: number | undefined
  private child: ChildProcess | undefined
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  /**
   * stderr 尾巴（启动失败诊断用）。**必须有上限**：长期运行的 Host 会不停打日志，
   * 无上限累加等于内存泄漏（官方桌面端同样只保留最后 64 Ki 字符）。
   */
  private stderr = ''
  private failureReported = false
  private shutdownSent = false
  private shutdownComplete = false
  private url: string | undefined
  private cookie: string | undefined
  private injections: readonly unknown[] = []
  private stdoutPartial = ''
  private stderrPartial = ''

  /**
   * @param node - absolute bundled Node.js executable.
   * @param runtimeDir - immutable packages carried by the current application.
   * @param projectDir - active or staged desktop plugin profile.
   * @param inspectPort - optional loopback inspector port for workspace development.
   * @param environment - Child environment; runtime and package-manager overrides are removed.
   * @param onFailure - Receives the first fatal child or transport failure, including after readiness.
   * @param onStdout - Receives every complete stdout line (CR stripped, empty lines dropped).
   * @param onStderr - Receives every complete stderr line; accumulation below is unchanged.
   * @param onExit - Receives the child's exit code and signal once the process is gone.
   * @param pnpmEntry - Bundled pnpm entry handed to the Host as its launcher-provided package manager.
   * @param allowLinkedPackages - Development-only: allow workspace-linked bundle packages.
   */
  constructor(
    node: string,
    runtimeDir: string,
    projectDir: string,
    inspectPort?: number,
    environment: NodeJS.ProcessEnv = process.env,
    onFailure?: (error: Error) => void,
    onStdout?: (line: string) => void,
    onStderr?: (line: string) => void,
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
    pnpmEntry?: string,
    allowLinkedPackages = false,
    port?: number,
  ) {
    this.node = node
    this.runtimeDir = runtimeDir
    this.projectDir = projectDir
    this.inspectPort = inspectPort
    this.environment = environment
    this.onFailure = onFailure
    this.onStdout = onStdout
    this.onStderr = onStderr
    this.onExit = onExit
    this.pnpmEntry = pnpmEntry
    this.allowLinkedPackages = allowLinkedPackages
    this.port = port
  }

  /** Start the child once and resolve only after its composition is serving requests. */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    // 本壳的 Host 包为非作用域名（与官方私有包 @deepseek-ai/dsh-desktop-host 的路径不同）。
    const entry = join(this.runtimeDir, 'node_modules', 'dsh-desktop-host', 'lib', 'index.js')
    const child = spawn(this.node, [
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.runtimeDir,
      this.projectDir,
      ...(this.allowLinkedPackages ? ['--allow-linked-profile'] : []),
      ...(this.pnpmEntry === undefined ? [] : ['--pnpm', this.pnpmEntry]),
      ...(this.port === undefined ? [] : ['--port', String(this.port)]),
    ], {
      cwd: this.projectDir,
      env: {
        ...Object.fromEntries(Object.entries(this.environment).filter(([name]) => (
          name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && name !== 'ELECTRON_RUN_AS_NODE'
          && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        // 用自家 Electron 二进制当 Node 跑 Host（不随包 node.exe，见 RuntimeSpec.node）。
        // 该变量会随环境传给 Host 的所有子进程：harness 与插件里任何 `process.execPath`
        // 都应当以 Node 模式启动，而不是弹出第二个应用窗口。
        ELECTRON_RUN_AS_NODE: '1',
      },
      // 官方形态：只有 stdio + Node IPC，没有字节管道。
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_LIMIT)
      this.acceptStderrChunk(chunk)
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.acceptStdoutChunk(chunk) })
    child.on('message', (message: unknown) => { this.handleMessage(message) })
    child.once('error', (error: unknown) => { this.fail(error instanceof Error ? error : new Error(String(error))) })
    child.once('close', (code, signal) => {
      this.child = undefined
      const failure = code === 0 || this.shutdownSent
        ? undefined
        : new Error(`dsh desktop host exited unexpectedly (code=${String(code)} signal=${String(signal)})`)
      if (failure !== undefined) this.fail(failure)
      else this.readyReject(new Error('dsh desktop host exited before readiness'))
      this.onExit?.(code, signal)
    })
    return this.readyPromise
  }

  /** Forward one application request to the authenticated Host. */
  async fetch(request: Request, options: { allowForeignOrigin?: boolean } = {}): Promise<Response> {
    const ready = await this.readyPromise
    if (this.cookie === undefined) throw new Error('dsh host is not authenticated')
    return forwardWebRequest(request, ready.url, this.cookie, options.allowForeignOrigin === true)
  }

  /** Index injections reported by the Host (applied by the window before client boot). */
  getInjections(): readonly unknown[] { return this.injections }

  /** Authenticated Host URL, or undefined before readiness. */
  getUrl(): string | undefined { return this.url }

  /** Host-issued cookie for raw protocol requests (WebSocket upgrade headers). */
  getCookie(): string | undefined { return this.cookie }

  /** Ask for a clean shutdown and wait for the child to report completion. */
  async stop(timeoutMs = 8_000): Promise<void> {
    const child = this.child
    if (child === undefined) return
    const stopAt = Date.now()
    const mark = (label: string): void => {
      log('info', `[perf] host.stop ${label}: ${String(Date.now() - stopAt)}ms`)
    }
    if (!this.shutdownSent) {
      this.shutdownSent = true
      try {
        child.send({ type: 'shutdown' })
        mark('shutdown IPC 已发出')
      } catch {
        /* 通道已断：直接等 exit */
        mark('shutdown IPC 发送失败（通道已断）')
      }
    }
    const settled = await Promise.race([
      this.exitPromise ??= new Promise<void>((resolve) => { child.once('close', () => { resolve() }) }),
      new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, timeoutMs).unref() }),
    ])
    mark(settled === 'timeout' ? `等待 ${String(timeoutMs)}ms 超时（Host 未退）` : 'Host 已退出')
    if (settled === 'timeout') {
      log('error', 'dsh host did not stop in time; killing')
      this.kill('SIGKILL')
      await (this.exitPromise ?? Promise.resolve()).catch(() => undefined)
      mark('SIGKILL 后进程结束')
    }
  }

  /** Terminate immediately without waiting for a graceful stop. */
  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.killTree(signal)
  }

  /** Accumulated stderr tail (diagnostics for startup failures). */
  getStderr(): string { return this.stderr }

  /** True once the child reported a completed shutdown. */
  get isShutdownComplete(): boolean { return this.shutdownComplete }

  private killTree(signal: NodeJS.Signals): void {
    const child = this.child
    if (child === undefined || child.pid === undefined) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        process.kill(-child.pid, signal)
      }
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* 已退出 */
      }
    }
  }

  private handleMessage(message: unknown): void {
    const type = messageType(message)
    if (type === 'ready') {
      const payload = message as Extract<HostMessage, { type: 'ready' }>
      if (typeof payload.dshVersion !== 'string' || typeof payload.url !== 'string' || !Array.isArray(payload.injections)) {
        this.fail(new Error('dsh desktop host sent an invalid ready event'))
        return
      }
      const ready: DesktopHostReady = {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        dshVersion: payload.dshVersion,
        url: payload.url,
        injections: payload.injections,
      }
      this.url = payload.url
      this.injections = payload.injections
      void authenticateWebHost(payload.url).then((cookie) => {
        this.cookie = cookie
        this.readyResolve(ready)
      }, (error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      })
      return
    }
    if (type === 'shutdown-complete') {
      this.shutdownComplete = true
      return
    }
    if (type === 'fatal') {
      const detail = (message as Extract<HostMessage, { type: 'fatal' }>).message
      this.fail(new Error(typeof detail === 'string' ? detail : 'dsh desktop host reported a fatal error'))
      return
    }
    this.fail(new Error('dsh desktop host sent an unknown IPC message'))
  }

  private fail(error: Error): void {
    this.readyReject(error)
    if (this.failureReported) return
    this.failureReported = true
    this.onFailure?.(error)
  }

  private acceptStdoutChunk(chunk: string): void {
    this.stdoutPartial += chunk.replace(/\r\n/gu, '\n')
    while (true) {
      const newline = this.stdoutPartial.indexOf('\n')
      if (newline < 0) break
      const line = this.stdoutPartial.slice(0, newline)
      this.stdoutPartial = this.stdoutPartial.slice(newline + 1)
      if (line !== '') this.onStdout?.(line)
    }
  }

  private acceptStderrChunk(chunk: string): void {
    this.stderrPartial += chunk.replace(/\r\n/gu, '\n')
    while (true) {
      const newline = this.stderrPartial.indexOf('\n')
      if (newline < 0) break
      const line = this.stderrPartial.slice(0, newline)
      this.stderrPartial = this.stderrPartial.slice(newline + 1)
      if (line !== '') this.onStderr?.(line)
    }
  }
}
