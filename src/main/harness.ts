/**
 * HarnessManager：管理 `dsh --profile <DESKTOP_PROFILE>`（dsh-workbench）子进程的完整生命周期。
 *
 *  - spawn（cwd=工作区、DSH_HOME、--patch overlay、--port 0）
 *  - 逐行解析 stdout：`dsh web:` URL 行 + `dsh desktop:` 桥接行
 *  - 意外退出指数退避自动重启；stop() 优雅停机（SIGTERM → 5s → SIGKILL）
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { log } from './logger'
import { parseHarnessLine } from './harnessParse'
import { DESKTOP_PROFILE } from './desktopProfile.ts'

export interface HarnessReady {
  url: string
  port: number
  bridgePort: number | null
  token: string | null
}

export type HarnessState = 'starting' | 'ready' | 'stopped'

export interface HarnessHandlers {
  onReady: (r: HarnessReady) => void
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; willRestart: boolean }) => void
  onLog: (stream: 'stdout' | 'stderr', line: string) => void
  onState: (s: HarnessState) => void
}

export interface HarnessOptions {
  node: string
  bin: string
  dshHome: string
  profile: string
  overlay: string
  cwd: string
  maxRestartDelayMs?: number
  /** 局域网访问：web server 绑定 host（具体局域网 IP；0.0.0.0 被官方禁止）。缺省 = 仅回环。 */
  host?: string
  /** 局域网访问：/api 浏览器信任围栏额外放行的主机（host 或 host:port）。 */
  trustedHosts?: string[]
}

export class HarnessManager {
  state: HarnessState = 'stopped'
  ready: HarnessReady | null = null

  private child: ChildProcess | null = null
  /** 子进程世代：每次 spawn/交接递增；exit 回调据此识别「僵尸旧进程」的迟到事件。 */
  private childGen = 0
  private restartTimer: NodeJS.Timeout | null = null
  private restarts = 0
  /** 未完成行的原始字节缓冲（跨 chunk 的多字节 UTF-8 序列不能被切断解码）。 */
  private partial: { stdout: Buffer; stderr: Buffer } = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
  /** 正在做旧进程交接（等待退出）；期间再次 restart 记为 pending，交接完成后重走。 */
  private handoff = false
  private restartPending = false
  private pendingCwd: string | undefined
  private quit = false

  constructor(
    private opts: HarnessOptions,
    private handlers: HarnessHandlers,
  ) {}

  /** 局域网访问：更新绑定 host 与信任主机（应在 restart/start 前调用）。 */
  setNetwork(host: string | undefined, trustedHosts: string[]): void {
    this.opts.host = host
    this.opts.trustedHosts = trustedHosts
  }

  /** 当前绑定 host（局域网访问时为局域网 IP，否则 undefined）。 */
  get bindHost(): string | undefined {
    return this.opts.host
  }

  /** 首次启动（或崩溃后手动重启入口）。 */
  start(): void {
    this.quit = false
    this.restarts = 0
    this.ready = null
    this.handoff = false
    this.restartPending = false
    this.spawn()
  }

  /** 优雅停机，等待子进程退出；exit 事件失联/进程句柄僵尸时 8s 兜底强制结束。 */
  async stop(): Promise<void> {
    this.quit = true
    this.restartPending = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.child = null
      this.ready = null // 停机后不得再对外暴露旧 URL/端口（托盘/打开浏览器版会误用）
      this.setState('stopped')
      return
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 5000)
      // 兜底：kill 后 exit 事件也可能永不触发（句柄失联/僵尸进程）——
      // 8s 后强制结束等待并丢弃句柄，绝不让退出/重启流程死等
      const hard = setTimeout(() => {
        clearTimeout(t)
        this.child = null
        resolve()
      }, 8000)
      child.once('exit', () => {
        clearTimeout(t)
        clearTimeout(hard)
        this.child = null
        resolve()
      })
      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(t)
        clearTimeout(hard)
        this.child = null
        resolve()
      }
    })
    this.ready = null
    this.setState('stopped')
  }

  /** 同步强杀子进程（更新安装退出兜底用；不等待、不优雅停机）。 */
  killNow(): void {
    this.quit = true
    this.handoff = false
    this.restartPending = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    try {
      this.child?.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    this.child = null
    this.ready = null
    this.setState('stopped')
  }

  /**
   * 重启：可切换 cwd（新工作区）。exit 事件失联时 7s 兜底强制重建，绝不卡死。
   *
   * 可重入：交接进行中再次调用只记 pending（交接完成后按最新 cwd 重走一次），
   * 避免并发调用各自 spawn 出多个 harness 进程/旧进程被遗忘成孤儿。
   */
  restart(cwd?: string): void {
    if (cwd) this.opts.cwd = cwd
    this.ready = null
    this.quit = false
    this.restarts = 0
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.handoff) {
      this.restartPending = true
      this.pendingCwd = cwd ?? this.opts.cwd
      return
    }
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.child = null // 丢弃残留/僵尸句柄，避免后续判断 exitCode===null 死等
      this.spawn()
      return
    }
    this.handoff = true
    // 世代递增：旧 child 的 exit 回调变为「非当前世代」，
    // 不会走 onChildExit 的自动重启分支（否则与新进程双开）
    this.childGen += 1
    this.child = null
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      this.handoff = false
      if (this.restartPending) {
        // 交接期间又来了一次重启：按最新 cwd 再走一遍（此时 child 为 null → 直接 spawn）
        const dir = this.pendingCwd
        this.restartPending = false
        this.pendingCwd = undefined
        this.restart(dir)
        return
      }
      this.spawn()
    }
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, 5000)
    // 兜底：exit 事件失联（句柄僵尸）时 7s 后丢弃句柄并直接重建
    const hard = setTimeout(() => {
      clearTimeout(t)
      log('error', 'harness restart: exit 事件超时，强制重建')
      finish()
    }, 7000)
    child.once('exit', () => {
      clearTimeout(t)
      clearTimeout(hard)
      finish()
    })
    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(t)
      clearTimeout(hard)
      finish()
    }
  }

  get cwd(): string {
    return this.opts.cwd
  }

  private spawn(): void {
    if (this.quit) return
    this.setState('starting')
    const gen = ++this.childGen
    const args = ['--profile', DESKTOP_PROFILE, '--patch', this.opts.overlay]
    // 局域网访问：web server 绑定具体局域网 IP + 信任围栏放行该主机
    if (this.opts.host) {
      args.push('--host', this.opts.host)
      for (const h of this.opts.trustedHosts ?? []) args.push('--trusted-host', h)
    }
    args.push('--port', '0')
    // 桌面壳自带窗口：禁止 dsh 再用默认浏览器打开网页端（默认会 open browser）
    args.push('--no-open')
    log('info', `spawn ${this.opts.node} ${this.opts.bin} ${args.join(' ')} (cwd=${this.opts.cwd}, DSH_HOME=${this.opts.dshHome})`)
    let child: ChildProcess
    try {
      child = spawn(this.opts.node, [this.opts.bin, ...args], {
        cwd: this.opts.cwd,
        env: { ...process.env, DSH_HOME: this.opts.dshHome, DSH_DESKTOP: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      log('error', `spawn threw: ${err instanceof Error ? err.message : String(err)}`)
      this.onChildExit(gen, -1, null)
      return
    }
    this.child = child
    this.partial = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    child.stdout?.on('data', (c: Buffer) => this.onChunk('stdout', c))
    child.stderr?.on('data', (c: Buffer) => this.onChunk('stderr', c))
    child.on('error', (err) => {
      log('error', `child error: ${err.message}`)
      this.onChildExit(gen, -1, null)
    })
    child.on('exit', (code, signal) => this.onChildExit(gen, code, signal))
  }

  /**
   * 按字节切行后再整体解码：UTF-8 多字节序列被 chunk 边界切开时不会产生乱码
   * （未读完的最后一行以原始字节留待下个 chunk）。
   */
  private onChunk(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const buf = this.partial[stream].length > 0 ? Buffer.concat([this.partial[stream], chunk]) : chunk
    const lines: string[] = []
    let start = 0
    let idx = buf.indexOf(0x0a, start)
    while (idx !== -1) {
      lines.push(buf.subarray(start, idx).toString('utf8'))
      start = idx + 1
      idx = buf.indexOf(0x0a, start)
    }
    this.partial[stream] = start === 0 ? buf : buf.subarray(start)
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '')
      if (!line) continue
      this.handlers.onLog(stream, line)
      if (stream === 'stdout') this.parseLine(line)
    }
  }

  private parseLine(line: string): void {
    const next = parseHarnessLine(line, this.ready)
    if (next) {
      this.ready = next
      this.maybeReady()
    }
  }

  private maybeReady(): void {
    const r = this.ready
    if (r && r.url && r.bridgePort !== null && r.token !== null && this.state !== 'ready') {
      this.setState('ready')
      this.restarts = 0
      this.handlers.onReady(r)
    }
  }

  private onChildExit(gen: number, code: number | null, signal: NodeJS.Signals | null): void {
    // 僵尸旧进程的迟到 exit：非当前世代一律忽略，绝不清掉新进程句柄/误报退出/重复拉起
    if (gen !== this.childGen) {
      log('info', `harness stale exit ignored (gen=${gen} < ${this.childGen}, code=${String(code)})`)
      return
    }
    if (this.quit) {
      this.setState('stopped')
      return
    }
    this.child = null
    const willRestart = !this.handoff
    this.ready = null // 清空旧 ready，避免重启用旧 URL 触发
    log('info', `harness exited code=${code} signal=${String(signal)} willRestart=${willRestart}`)
    this.handlers.onExit({ code, signal, willRestart })
    this.setState(willRestart ? 'starting' : 'stopped')
    if (willRestart) {
      const delay = Math.min(this.opts.maxRestartDelayMs ?? 30_000, 1000 * 2 ** this.restarts)
      this.restarts += 1
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this.spawn()
      }, delay)
    }
  }

  private setState(s: HarnessState): void {
    this.state = s
    this.handlers.onState(s)
  }

  get overlayPath(): string {
    return this.opts.overlay
  }
}
