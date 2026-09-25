/**
 * HostManager：管理 Desktop Host 子进程（`packages/host`，入口
 * **壳自带副本 `<appPath>/dist/main/host-entry.cjs` 优先**，随包运行时树里的
 * `<runtimeDir>/node_modules/dsh-desktop-host/lib/index.js` 兜底——
 * 后者会被杀软启发式当成可疑散件删掉，不能当启动硬前提，见 src/main/hostEntry.ts）的完整生命周期。
 *
 * 与旧 HarnessManager（`dsh --profile <profile> --port 0` CLI 子进程）一致的语义：
 *  - 崩溃后指数退避自动重启；`childGen` 世代守卫保证僵尸旧进程的迟到事件
 *    不会清掉新进程句柄、不会误报退出、更不会双开；
 *  - `restart()` 可重入（handoff/restartPending）：交接期间再次调用只记 pending，
 *    交接完成后按最新状态重走一次；`stop()`/`restart()` 在 exit 事件失联（句柄僵尸）
 *    时仍有硬超时兜底，绝不让退出/重启流程死等；
 *  - `killNow()` 同步强杀（更新安装与应用退出兜底，不等待、不优雅停机）。
 *
 * 与旧实现的差异：Host 在进程内引导 profile（无 CLI），ready 事实来自子进程 IPC
 * `ready` 事件——**带认证 URL 与 index 注入片段**（官方形态：Host 起真实 Web Host，
 * 默认端口 19387），因此不存在 fd 管道；stdout/stderr 行仍逐行回调给 onLog
 * （bridge 发现行由调用方在 onLog 里自行嗅探）。
 */
import { log } from './logger.ts'
import { DesktopHostProcess } from './hostProcess.ts'
import { runtimeTreeHostEntry } from './hostEntry.ts'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** Host 就绪事实（来自子进程 IPC `ready` 事件；官方形态：认证 URL + index 注入）。 */
export interface HostReady {
  dshVersion: string
  /** 已认证的 Web Host 基地址（带一次性 token，主进程据此换 cookie）。 */
  url: string
  /** 窗口启动时必须应用的 index 注入片段（客户端 boot 等它们）。 */
  injections: readonly unknown[]
}

export type HostState = 'starting' | 'ready' | 'stopped'

export interface HostHandlers {
  onReady: (r: HostReady) => void
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; willRestart: boolean }) => void
  onLog: (stream: 'stdout' | 'stderr', line: string) => void
  onState: (s: HostState) => void
  /**
   * 随包运行时**文件缺失**（不是插件问题）：壳停止重试并由调用方给出可执行的说明。
   * 真机事故（2026-09-23）：安全软件把 Host 入口当启发式误报隔离掉，壳却按
   * 「harness 崩溃」连推三次 → 安全模式，用户看到的是"插件坏了"，排查方向完全错。
   */
  onRuntimeDamaged?: (info: { entry: string }) => void
}

export interface HostOptions {
  /** 随运行时树分发的上游 Node 可执行文件绝对路径。 */
  node: string
  /** dsh 运行时树根（须含 node_modules/@deepseek-ai/dsh 与 dsh-desktop-host）。 */
  runtimeDir: string
  /** Electron 托管的 profile 目录（$DSH_HOME/profiles/<profile>）。 */
  projectDir: string
  /**
   * 随包 pnpm 入口（`resources/runtime/pnpm/bin/pnpm.cjs`）。
   * 交给 Host 后成为官方插件管理器的 `profileContext.packageManager`——插件安装/删除
   * 走随包 pnpm，离线机器不需要系统 pnpm，也不受用户 npmrc 影响（官方语义）。
   */
  pnpmEntry?: string
  /**
   * Web Host 监听端口（官方默认 19387）。**冲突时**首次失败会自动改用随机端口重试一次，
   * 这样「本机另有 DSH 实例占着该端口」不会变成启动失败。
   */
  port?: number
  /** 工作区开发用回环 inspector 端口；给出时 Host 额外允许 workspace 链接的 bundle。 */
  inspectPort?: number
  /** 崩溃重启退避上限（缺省 30s）。 */
  maxRestartDelayMs?: number
  /**
   * 子进程环境（缺省 process.env）。Host 侧会剔除 NODE_OPTIONS/NODE_PATH、
   * `DSH_DESKTOP_` 前缀与 `npm_` / `pnpm_` / `corepack_` 前缀的变量（见 hostProcess.ts），
   * 因此调用方要把本壳需要的变量放在这里——尤其是 `DSH_HOME`
   * （旧 HarnessManager 是 spawn 时注入的），否则 Host 会落到默认 `~/.dsh`。
   */
  env?: NodeJS.ProcessEnv
  /**
   * Host 入口绝对路径（壳自带副本优先，见 src/main/hostEntry.ts）。
   * 缺省 = 运行时树副本，供开发/测试使用。
   */
  hostEntry?: string
}

/** 崩溃重启退避上限（与原 HarnessManager 一致）。 */
const DEFAULT_MAX_RESTART_DELAY_MS = 30_000
/** 优雅停机发出后仍不退出时的 SIGKILL 延时。 */
const KILL_DELAY_MS = 5_000
/** stop() 等待退出的上限：exit 事件失联也不卡死（原 8s 兜底）。 */
const STOP_HARD_TIMEOUT_MS = 8_000
/** restart() 交接等待旧进程退出的上限（原 7s 兜底）。 */
const RESTART_HARD_TIMEOUT_MS = 7_000
/** 启动/传输失败后等待 exit 事件的看门狗上限（失联则直接进入崩溃路径）。 */
const FAILURE_WATCHDOG_MS = 5_000

export class HostManager {
  state: HostState = 'stopped'
  ready: HostReady | null = null

  private child: DesktopHostProcess | null = null
  /** 子进程世代：每次 spawn/交接递增；回调据此识别「僵尸旧进程」的迟到事件。 */
  private childGen = 0
  private restartTimer: NodeJS.Timeout | null = null
  private restarts = 0
  /** 正在做旧进程交接（等待退出）；期间再次 restart 记为 pending，交接完成后重走。 */
  private handoff: { finish: () => void } | null = null
  private restartPending = false
  /** 失败看门狗：onFailure 之后 exit 事件失联时兜底进入崩溃路径。 */
  private failureWatch: NodeJS.Timeout | null = null
  private quit = false
  /** 端口冲突兜底是否已用过（只切一次随机端口）。 */
  private portFallbackUsed = false

  // 注意：不用 TypeScript 的「构造函数参数属性」——Node 的类型擦除（strip-only）不支持该语法，
  // 而测试会直接 import 本模块（与 hostProcess.ts 同一条约束）。
  private opts: HostOptions
  private handlers: HostHandlers

  constructor(opts: HostOptions, handlers: HostHandlers) {
    this.opts = opts
    this.handlers = handlers
  }

  /** 首次启动（或崩溃后手动重启入口）。已在运行时忽略，避免重复 spawn。 */
  start(): void {
    if (this.child !== null) return
    this.quit = false
    this.restarts = 0
    this.ready = null
    this.handoff = null
    this.restartPending = false
    this.clearRestartTimer()
    this.clearFailureWatch()
    this.spawn()
  }

  /**
   * 优雅停机：Host 侧 shutdown IPC → 关请求管道 → 等退出（其内部有 10s/5s/5s 兜底）。
   * 这里再叠一层 5s SIGKILL + 8s 硬超时：exit 事件失联/进程句柄僵尸时也绝不挂起。
   */
  async stop(): Promise<void> {
    this.quit = true
    this.restartPending = false
    this.clearRestartTimer()
    this.clearFailureWatch()
    const host = this.child
    if (!host) {
      this.child = null
      this.ready = null
      this.setState('stopped')
      return
    }
    await new Promise<void>((resolve) => {
      let done = false
      let killTimer: NodeJS.Timeout | null = null
      let hard: NodeJS.Timeout | null = null
      const finish = (): void => {
        if (done) return
        done = true
        if (killTimer) clearTimeout(killTimer)
        if (hard) clearTimeout(hard)
        this.child = null
        resolve()
      }
      killTimer = setTimeout(() => {
        try {
          host.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, KILL_DELAY_MS)
      // 兜底：kill 后 exit 事件也可能永不触发（句柄失联/僵尸进程）——
      // 8s 后强制结束等待并丢弃句柄，绝不让退出/重启流程死等
      hard = setTimeout(() => {
        this.child = null
        finish()
      }, STOP_HARD_TIMEOUT_MS)
      void host.stop().then(finish, (error: unknown) => {
        log('error', `host stop failed: ${error instanceof Error ? error.message : String(error)}`)
        finish()
      })
    })
    this.ready = null
    this.setState('stopped')
  }

  /** 同步强杀子进程（更新安装退出兜底用；不等待、不优雅停机）。 */
  killNow(): void {
    this.quit = true
    this.handoff = null
    this.restartPending = false
    this.clearRestartTimer()
    this.clearFailureWatch()
    const host = this.child
    this.child = null
    this.ready = null
    try {
      host?.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    this.setState('stopped')
  }

  /**
   * 重启：换一个全新的 Host 子进程。exit 事件失联时 7s 兜底强制重建，绝不卡死。
   *
   * 可重入：交接进行中再次调用只记 pending（交接完成后重走一次），
   * 避免并发调用各自 spawn 出多个 Host 进程 / 旧进程被遗忘成孤儿。
   */
  restart(): void {
    this.ready = null
    this.quit = false
    this.restarts = 0
    this.clearRestartTimer()
    this.clearFailureWatch()
    if (this.handoff !== null) {
      this.restartPending = true
      return
    }
    const host = this.child
    if (!host) {
      this.child = null // 丢弃残留/僵尸句柄
      this.spawn()
      return
    }
    // 世代递增：旧 child 的 exit 回调变为「非当前世代」，
    // 不会走崩溃自动重启分支（否则与新进程双开）
    this.childGen += 1
    this.child = null
    let done = false
    let killTimer: NodeJS.Timeout | null = null
    let hard: NodeJS.Timeout | null = null
    const finish = (): void => {
      if (done) return
      done = true
      if (killTimer) clearTimeout(killTimer)
      if (hard) clearTimeout(hard)
      this.handoff = null
      if (this.restartPending) {
        // 交接期间又来了一次重启：交接完成后重走一遍（此时 child 为 null → 直接 spawn）
        this.restartPending = false
        this.restart()
        return
      }
      this.spawn()
    }
    this.handoff = { finish }
    killTimer = setTimeout(() => {
      try {
        host.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, KILL_DELAY_MS)
    // 兜底：exit 事件失联（句柄僵尸）时 7s 后丢弃句柄并直接重建
    hard = setTimeout(() => {
      log('error', 'host restart: exit 事件超时，强制重建')
      finish()
    }, RESTART_HARD_TIMEOUT_MS)
    try {
      // 旧进程交接只等退出事件，不等 Host 内部优雅停机（shutdown IPC 那条路留给 stop()）
      host.kill('SIGTERM')
    } catch {
      finish()
    }
  }

  /**
   * 转发一条 `dsh-app://` 请求。
   * 懒启动：尚未启动时补一次 start()；Host 未就绪/已停机时抛普通 Error
   * （就绪过程中发出的请求会在 DesktopHostProcess.fetch 内等 ready，启动失败即拒绝）。
   */
  async fetch(request: Request, options: { allowForeignOrigin?: boolean } = {}): Promise<Response> {
    if (this.quit) throw new Error('dsh host is stopped')
    if (this.child === null) this.start()
    const host = this.child
    if (host === null) throw new Error('dsh host is not running')
    return host.fetch(request, options)
  }

  /** index 注入片段（客户端 boot 前必须应用）；Host 未就绪时为空。 */
  getInjections(): readonly unknown[] {
    return this.child?.getInjections() ?? []
  }

  /** 已认证的 Host 基地址；未就绪时为 undefined。 */
  getUrl(): string | undefined {
    return this.child?.getUrl()
  }

  /** Host 签发的 cookie（WebSocket 升级头用）；未就绪时为 undefined。 */
  getCookie(): string | undefined {
    return this.child?.getCookie()
  }

  /**
   * 把一条 WebSocket 升级请求原样代理到已认证 Host（局域网/浏览器版门面用）。
   *
   * 官方传输下客户端用 WS mux 拉远端流，而浏览器只能连门面自己的地址；门面把
   * 握手原样搬过去，并把 Origin/Cookie 改写成 Host 认可的值（渲染层/浏览器拿不到凭据）。
   */
  proxyWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = this.getUrl()
    const cookie = this.getCookie()
    if (url === undefined || cookie === undefined) {
      socket.destroy()
      return
    }
    const target = new URL(url)
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    headers.host = target.host
    headers.origin = target.origin
    headers.cookie = cookie
    headers['sec-fetch-site'] = 'same-origin'
    const proxy = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: request.url ?? '/',
      method: request.method ?? 'GET',
      headers,
    })
    proxy.on('upgrade', (response, upstream, upstreamHead) => {
      const lines = [`HTTP/1.1 ${String(response.statusCode ?? 101)} ${response.statusMessage ?? 'Switching Protocols'}`]
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstream.write(head)
      const shutdown = (): void => {
        socket.destroy()
        upstream.destroy()
      }
      socket.on('close', shutdown)
      upstream.on('close', shutdown)
      socket.on('error', shutdown)
      upstream.on('error', shutdown)
      socket.pipe(upstream).pipe(socket)
    })
    proxy.on('response', (response) => {
      // 未升级（Host 拒绝握手等）：把状态回给客户端后关闭
      const lines = [`HTTP/1.1 ${String(response.statusCode ?? 502)} ${response.statusMessage ?? 'Bad Gateway'}`]
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      response.pipe(socket)
    })
    proxy.on('error', (error: unknown) => {
      log('error', `host: websocket proxy failed: ${error instanceof Error ? error.message : String(error)}`)
      socket.destroy()
    })
    proxy.end()
  }

  private spawn(): void {
    if (this.quit) return
    // 运行时完整性前置检查：Host 入口在不在（壳自带副本优先，运行时树副本兜底）。
    // 只有当**两处都不可用**时才可能是「安装被破坏 / 两处都被安全软件清掉」，
    // 绝不能当成 harness 崩溃去重试——重试只会把应用推进安全模式，把问题伪装成插件故障。
    const hostEntry = this.opts.hostEntry ?? runtimeTreeHostEntry(this.opts.runtimeDir)
    if (!existsSync(hostEntry)) {
      log('error', `host entry missing: ${hostEntry}（壳自带副本与随包运行时树副本都不可用）`)
      this.quit = true
      this.setState('stopped')
      this.handlers.onRuntimeDamaged?.({ entry: hostEntry })
      return
    }
    this.setState('starting')
    const gen = ++this.childGen
    const host = new DesktopHostProcess(
      this.opts.node,
      this.opts.runtimeDir,
      this.opts.projectDir,
      this.opts.inspectPort,
      this.opts.env ?? process.env,
      (error) => { this.onHostFailure(gen, error) },
      (line) => { this.emitLog('stdout', line) },
      (line) => { this.emitLog('stderr', line) },
      (code, signal) => { this.onHostExit(gen, code, signal) },
      this.opts.pnpmEntry,
      // 开发（带 inspector）时放行 workspace 链接的 bundle；打包运行时走官方 runtime 解析。
      this.opts.inspectPort !== undefined,
      this.opts.port,
      hostEntry,
    )
    this.child = host
    log('info', `host spawn ${this.opts.node} ${this.opts.runtimeDir} (project=${this.opts.projectDir}${this.opts.inspectPort === undefined ? '' : `, inspect=${String(this.opts.inspectPort)}`})`)
    void host.start().then((ready) => {
      if (gen !== this.childGen) return
      const result: HostReady = { dshVersion: ready.dshVersion, url: ready.url, injections: ready.injections }
      this.ready = result
      this.restarts = 0
      log('info', `host ready: dsh ${ready.dshVersion} url=${ready.url.replace(/token=[^&]+/u, 'token=***')} injections=${String(ready.injections.length)}`)
      this.setState('ready')
      this.emitReady(result)
    }, (error: unknown) => {
      // 启动失败会经 onFailure 上报；这里兜住 rejection，并保证崩溃路径一定被走到
      this.onHostFailure(gen, error instanceof Error ? error : new Error(String(error)))
    })
  }

  /** Host 已退出（进程已消失）：完成交接、忽略陈旧世代，或走崩溃路径。 */
  private onHostExit(gen: number, code: number | null, signal: NodeJS.Signals | null): void {
    const handoff = this.handoff
    if (handoff !== null) {
      // 交接中的旧进程已退出 → 交接完成（清计时器 → pending 重走 / 直接 spawn）
      this.handoff = null
      handoff.finish()
      return
    }
    // 僵尸旧进程的迟到 exit：非当前世代一律忽略，绝不清掉新进程句柄/误报退出/重复拉起
    if (gen !== this.childGen) {
      log('info', `host stale exit ignored (gen=${gen} < ${this.childGen}, code=${String(code)})`)
      return
    }
    this.child = null
    this.clearFailureWatch()
    if (this.quit) {
      this.setState('stopped')
      return
    }
    this.crash(code, signal)
  }

  /** Host 报告首个致命失败（启动失败、传输失败、子进程异常退出）；进程可能仍活着。 */
  private onHostFailure(gen: number, error: Error): void {
    if (gen !== this.childGen) return
    this.clearFailureWatch()
    if (this.quit) return
    log('error', `host fatal: ${error.message}`)
    // 端口冲突（本机另有 DSH 实例 / Web 版占着 19387）不该算启动失败：
    // 首次遇到就把端口切成 0（随机）再走一次启动路径。只做一次，避免死循环。
    if (this.ready === null && !this.portFallbackUsed && /EADDRINUSE|address already in use/iu.test(error.message)) {
      this.portFallbackUsed = true
      log('info', 'host port is busy: retrying on an ephemeral port')
      const stale = this.child
      this.child = null
      this.childGen += 1
      try {
        stale?.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      this.opts = { ...this.opts, port: 0 }
      this.spawn()
      return
    }
    const host = this.child
    if (host === null) return // 退出事件已经走过崩溃路径
    try {
      host.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    // 失败不保证伴随 exit 事件（传输层错误时进程可能仍活着，或句柄已失联）：
    // 看门狗到点仍未收到 exit 就直接进入崩溃路径
    this.failureWatch = setTimeout(() => {
      this.failureWatch = null
      if (gen !== this.childGen) return
      if (this.handoff !== null) return
      this.child = null
      this.crash(null, null)
    }, FAILURE_WATCHDOG_MS)
  }

  /** 崩溃路径：世代作废、上报退出、按退避重启（quit 时只落状态）。 */
  private crash(code: number | null, signal: NodeJS.Signals | null): void {
    this.clearFailureWatch()
    // 世代递增：该进程其余迟到回调（onFailure/onExit/start 结果）全部作废
    this.childGen += 1
    this.child = null
    this.ready = null // 清空旧 ready，避免重启用旧事实触发
    const willRestart = this.handoff === null
    log('info', `host exited code=${String(code)} signal=${String(signal)} willRestart=${willRestart}`)
    this.emitExit({ code, signal, willRestart })
    this.setState(willRestart ? 'starting' : 'stopped')
    if (willRestart) {
      const delay = Math.min(this.opts.maxRestartDelayMs ?? DEFAULT_MAX_RESTART_DELAY_MS, 1000 * 2 ** this.restarts)
      this.restarts += 1
      log('info', `host restart in ${String(delay)}ms (attempt ${String(this.restarts)})`)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this.spawn()
      }, delay)
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private clearFailureWatch(): void {
    if (this.failureWatch) {
      clearTimeout(this.failureWatch)
      this.failureWatch = null
    }
  }

  private setState(s: HostState): void {
    this.state = s
    try {
      this.handlers.onState(s)
    } catch (error) {
      log('error', `host state handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private emitReady(r: HostReady): void {
    try {
      this.handlers.onReady(r)
    } catch (error) {
      log('error', `host ready handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private emitExit(info: { code: number | null; signal: NodeJS.Signals | null; willRestart: boolean }): void {
    try {
      this.handlers.onExit(info)
    } catch (error) {
      log('error', `host exit handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private emitLog(stream: 'stdout' | 'stderr', line: string): void {
    try {
      this.handlers.onLog(stream, line)
    } catch (error) {
      log('error', `host log handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
