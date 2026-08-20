/**
 * HarnessManager：管理 `dsh --profile desktop` 子进程的完整生命周期。
 *
 *  - spawn（cwd=工作区、DSH_HOME、--patch overlay、--port 0）
 *  - 逐行解析 stdout：`dsh web:` URL 行 + `dsh desktop:` 桥接行
 *  - 意外退出指数退避自动重启；stop() 优雅停机（SIGTERM → 5s → SIGKILL）
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { log } from './logger'
import { parseHarnessLine } from './harnessParse'

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
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private restarts = 0
  private pending: { stdout: string; stderr: string } = { stdout: '', stderr: '' }
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
    this.spawn()
  }

  /** 优雅停机，等待子进程退出。 */
  async stop(): Promise<void> {
    this.quit = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child || child.exitCode !== null) {
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
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(t)
        resolve()
      }
    })
    this.setState('stopped')
  }

  /** 同步强杀子进程（更新安装退出兜底用；不等待、不优雅停机）。 */
  killNow(): void {
    this.quit = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    try {
      this.child?.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    this.setState('stopped')
  }

  /** 重启：可切换 cwd（新工作区）。 */
  restart(cwd?: string): void {
    if (cwd) this.opts.cwd = cwd
    this.ready = null
    this.quit = false
    this.restarts = 0
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (child && child.exitCode === null) {
      const prev = this.stopping
      this.stopping = true
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 5000)
      child.once('exit', () => {
        clearTimeout(t)
        this.stopping = prev
        this.spawn()
      })
      try {
        child.kill('SIGTERM')
      } catch {
        this.stopping = prev
        this.spawn()
      }
    } else {
      this.spawn()
    }
  }

  get cwd(): string {
    return this.opts.cwd
  }

  private spawn(): void {
    if (this.quit) return
    this.setState('starting')
    const args = ['--profile', 'desktop', '--patch', this.opts.overlay]
    // 局域网访问：web server 绑定具体局域网 IP + 信任围栏放行该主机
    if (this.opts.host) {
      args.push('--host', this.opts.host)
      for (const h of this.opts.trustedHosts ?? []) args.push('--trusted-host', h)
    }
    args.push('--port', '0')
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
      this.onChildExit(-1, null)
      return
    }
    this.child = child
    this.pending = { stdout: '', stderr: '' }
    child.stdout?.on('data', (c: Buffer) => this.onChunk('stdout', c))
    child.stderr?.on('data', (c: Buffer) => this.onChunk('stderr', c))
    child.on('error', (err) => {
      log('error', `child error: ${err.message}`)
      this.onChildExit(-1, null)
    })
    child.on('exit', (code, signal) => this.onChildExit(code, signal))
  }

  private onChunk(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    this.pending[stream] += chunk.toString('utf8')
    const lines = this.pending[stream].split('\n')
    this.pending[stream] = lines.pop() ?? ''
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

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.child || this.quit) {
      if (this.quit) this.setState('stopped')
      return
    }
    this.child = null
    const willRestart = !this.stopping
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
