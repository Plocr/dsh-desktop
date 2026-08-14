/**
 * TerminalManager：底栏嵌入终端（PowerShell/cmd 等），多会话管理（reasonix/Codex 风格）。
 *
 * 双后端：
 *  - PtyBackend（默认）：node-pty（Windows ConPTY / Unix PTY）——完整 TTY 体验
 *    （ANSI 颜色、方向键历史、vim/top 等交互程序）。node-pty 需为 Electron ABI
 *    编译（prebuild 只覆盖 Node ABI）：`npm run rebuild:native`（需 VS Build Tools）。
 *  - PipeBackend（保底）：spawn shell 接管 stdio 管道。零原生依赖；无 TTY，
 *    Ctrl+C 退化为会话复位。`DSH_DESKTOP_TERM=pipe` 强制启用。
 *
 * 会话模型：tab 级进程所有权（reasonix 同款）——create 生成会话并激活；
 * activate 切换；write/resize 按 id 路由；close 清理并激活相邻会话。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { log } from './logger'
import { resolveShellSpec, stripAnsi } from './termShell'
import type { TermShell, TermShellSpec } from './termShell'

export type { TermShell, TermShellSpec } from './termShell'
export { resolveShellSpec, stripAnsi } from './termShell'

export interface TermHandlers {
  onData: (sessionId: string, data: string) => void
  onExit: (sessionId: string, info: { code: number | null; reset: boolean }) => void
  onCreated: (sessionId: string, info: { label: string; backend: 'pipe' | 'pty' | null }) => void
  onClosed: (sessionId: string) => void
  onActive: (sessionId: string | null) => void
}

export interface TermManager {
  readonly activeId: string | null
  readonly activeLabel: string | null
  readonly activeShell: TermShellSpec | null
  readonly backend: 'pipe' | 'pty' | null
  readonly sessions: { id: string; label: string }[]
  create: (shell: TermShell) => string | null
  activate: (id: string) => boolean
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  close: (id: string) => void
}

interface PtyLike {
  onData: (cb: (d: string) => void) => void
  onExit: (cb: (e: { exitCode?: number }) => void) => void
  write: (d: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  pid?: number
}

interface Session {
  id: string
  label: string
  backend: 'pipe' | 'pty'
  spec: TermShellSpec
  ptyProc: PtyLike | null
  pipeChild: ChildProcess | null
  closing: boolean
}

export function createTerminalManager(handlers: TermHandlers, getCwd: () => string): TermManager {
  const sessions = new Map<string, Session>()
  let activeId: string | null = null
  let seq = 0
  let ptyAvailable: boolean | null = null

  const usePty = (): boolean => {
    if (ptyAvailable !== null) return ptyAvailable
    if (process.env.DSH_DESKTOP_TERM === 'pipe') {
      ptyAvailable = false
      return false
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('node-pty')
      ptyAvailable = typeof mod.spawn === 'function'
      if (!ptyAvailable) log('warn', 'node-pty 加载异常，回落管道后端')
    } catch {
      ptyAvailable = false
      log('warn', 'node-pty 不可用（需为 Electron ABI 编译：npm run rebuild:native），回落管道后端')
    }
    return ptyAvailable
  }

  const setActive = (id: string | null): void => {
    activeId = id
    handlers.onActive(id)
  }

  const notifyExit = (s: Session, code: number | null, reset: boolean): void => {
    if (s.closing) return
    handlers.onExit(s.id, { code, reset })
  }

  const spawnPipe = (s: Session): void => {
    const cwd = getCwd()
    log('info', `terminal spawn (pipe): ${s.spec.cmd} ${s.spec.args.join(' ')} cwd=${cwd}`)
    let child: ChildProcess
    try {
      child = spawn(s.spec.cmd, s.spec.args, {
        cwd,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      log('error', `terminal spawn threw: ${err instanceof Error ? err.message : String(err)}`)
      handlers.onData(s.id, `\r\n[无法启动 ${s.spec.cmd}: ${err instanceof Error ? err.message : String(err)}]\r\n`)
      return
    }
    s.pipeChild = child
    handlers.onData(s.id, `\r\n[DSH Desktop 终端 · ${s.spec.label} · 管道模式 · ${cwd}]\r\n`)
    const onChunk = (_stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (s.closing) return
      let text = chunk.toString('utf8')
      // 管道模式下 \r\n 会成对出现；去掉多余的 \r 避免双倍行距
      text = stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      handlers.onData(s.id, text)
    }
    child.stdout?.on('data', (c: Buffer) => onChunk('stdout', c))
    child.stderr?.on('data', (c: Buffer) => onChunk('stderr', c))
    child.on('error', (err) => {
      log('error', `terminal child error: ${err.message}`)
      handlers.onData(s.id, `\r\n[终端进程错误: ${err.message}]\r\n`)
    })
    child.on('exit', (code) => {
      s.pipeChild = null
      log('info', `terminal exited code=${String(code)}`)
      notifyExit(s, code, false)
    })
  }

  const spawnPty = (s: Session): void => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('node-pty') as { spawn: (c: string, a: string[], o: unknown) => PtyLike }
    const cwd = getCwd()
    log('info', `terminal spawn (pty): ${s.spec.cmd} ${s.spec.args.join(' ')}`)
    let proc: PtyLike
    try {
      // 实测：node-pty 的 ConPTY 在同一进程销毁后重建的会话无输出（疑似句柄/agent 问题），
      // winpty 模式（useConpty:false）无此问题且同样提供完整 TTY。
      proc = mod.spawn(s.spec.cmd, s.spec.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
        useConpty: false,
      } as never)
    } catch (err) {
      log('error', `terminal pty spawn threw: ${err instanceof Error ? err.message : String(err)}`)
      handlers.onData(s.id, `\r\n[无法启动 ${s.spec.cmd}: ${err instanceof Error ? err.message : String(err)}]\r\n`)
      return
    }
    s.ptyProc = proc
    handlers.onData(s.id, `\r\n[DSH Desktop 终端 · ${s.spec.label} · PTY 模式（完整 TTY） · ${cwd}]\r\n`)
    proc.onData((d) => {
      if (!s.closing) handlers.onData(s.id, d)
    })
    proc.onExit((e) => {
      s.ptyProc = null
      notifyExit(s, e.exitCode ?? null, false)
    })
  }

  const doCreate = (shell: TermShell): string | null => {
    const spec = resolveShellSpec(shell)
    if (!spec) {
      handlers.onData('__none__', `\r\n[shell 不可用: ${shell}]\r\n`)
      return null
    }
    const id = `term-${++seq}`
    const s: Session = { id, label: spec.label, backend: usePty() ? 'pty' : 'pipe', spec, ptyProc: null, pipeChild: null, closing: false }
    sessions.set(id, s)
    if (s.backend === 'pty') spawnPty(s)
    else spawnPipe(s)
    handlers.onCreated(id, { label: s.label, backend: s.backend })
    setActive(id)
    return id
  }

  const doActivate = (id: string): boolean => {
    if (!sessions.has(id)) return false
    setActive(id)
    return true
  }

  const doWrite = (id: string, data: string): void => {
    const s = sessions.get(id)
    if (!s) return
    if (s.backend === 'pty' && s.ptyProc) {
      s.ptyProc.write(data)
      return
    }
    if (s.backend === 'pipe' && s.pipeChild && s.pipeChild.stdin?.writable) {
      // 管道模式没有真实信号：Ctrl+C → 会话复位（杀壳并重开）
      if (data.includes('\x03')) {
        handlers.onData(id, '\r\n[Ctrl+C：管道模式无法发送信号，正在重置会话…]\r\n')
        const spec = s.spec
        doClose(id)
        const label = spec.label === 'PowerShell' ? 'powershell' : (spec.label as TermShell)
        void doCreate(label)
        return
      }
      try {
        s.pipeChild.stdin.write(data)
      } catch (err) {
        log('error', `terminal stdin write failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }
    // 无活动进程：忽略（面板仍显示，提示重开）
  }

  const doResize = (id: string, cols: number, rows: number): void => {
    const s = sessions.get(id)
    if (!s) return
    if (s.backend === 'pty' && s.ptyProc) {
      try {
        s.ptyProc.resize(Math.max(10, cols), Math.max(3, rows))
      } catch {
        /* ignore */
      }
    }
    // pipe 模式忽略（行宽由 xterm 视口决定）
  }

  const doClose = (id: string): void => {
    const s = sessions.get(id)
    if (!s) return
    const hadProc = s.pipeChild !== null || s.ptyProc !== null
    s.closing = true
    const child = s.pipeChild
    if (child && child.exitCode === null) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    s.pipeChild = null
    const proc = s.ptyProc
    if (proc) {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }
    s.ptyProc = null
    sessions.delete(id)
    // 主动关闭也通知面板（显示"已关闭，可重开"），与进程自然退出同构
    if (hadProc) handlers.onExit(id, { code: null, reset: true })
    handlers.onClosed(id)
    // 激活相邻会话（优先保留索引位置附近的）
    if (activeId === id) {
      const ids = [...sessions.keys()]
      setActive(ids.length > 0 ? ids[ids.length - 1] : null)
    }
  }

  return {
    get activeId(): string | null {
      return activeId
    },
    get activeLabel(): string | null {
      const s = activeId ? sessions.get(activeId) : undefined
      return s ? s.label : null
    },
    get activeShell(): TermShellSpec | null {
      const s = activeId ? sessions.get(activeId) : undefined
      return s ? s.spec : null
    },
    get backend(): 'pipe' | 'pty' | null {
      const s = activeId ? sessions.get(activeId) : undefined
      return s ? s.backend : null
    },
    get sessions(): { id: string; label: string }[] {
      return [...sessions.values()].map((s) => ({ id: s.id, label: s.label }))
    },
    create: doCreate,
    activate: doActivate,
    write: doWrite,
    resize: doResize,
    close: doClose,
  }
}
