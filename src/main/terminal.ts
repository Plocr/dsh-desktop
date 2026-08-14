/**
 * TerminalManager：底栏嵌入终端（PowerShell/cmd 等）。
 *
 * 双后端：
 *  - PipeBackend（默认）：spawn shell 接管 stdio 管道。零原生依赖、离线可用；
 *    无 TTY（vim/top 类交互程序不可用），Ctrl+C 退化为会话复位。
 *  - PtyBackend（可选）：try-require('node-pty')；需本机为 Electron ABI 构建
 *    （prebuild 只覆盖 Node ABI，electron-builder 又显式 npmRebuild:false），
 *    设置 DSH_DESKTOP_TERM=pty 启用，缺失时自动回落 PipeBackend。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { log } from './logger'
import { resolveShellSpec, stripAnsi } from './termShell'
import type { TermShell, TermShellSpec } from './termShell'

export type { TermShell, TermShellSpec } from './termShell'
export { resolveShellSpec, stripAnsi } from './termShell'

export interface TermHandlers {
  onData: (data: string) => void
  onExit: (info: { code: number | null; reset: boolean }) => void
}

export interface TermManager {
  activeShell: TermShellSpec | null
  backend: 'pipe' | 'pty' | null
  spawn: (shell: TermShell) => boolean
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
}

interface PtyLike {
  onData: (cb: (d: string) => void) => void
  onExit: (cb: (e: { exitCode?: number }) => void) => void
  write: (d: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  pid?: number
}

export function createTerminalManager(handlers: TermHandlers, getCwd: () => string): TermManager {
  let activeShell: TermShellSpec | null = null
  let backend: 'pipe' | 'pty' | null = null
  let pipeChild: ChildProcess | null = null
  let ptyProc: PtyLike | null = null
  let closing = false
  let ptyAvailable: boolean | null = null

  const usePty = (): boolean => {
    if (ptyAvailable !== null) return ptyAvailable
    if (process.env.DSH_DESKTOP_TERM !== 'pty') {
      ptyAvailable = false
      return false
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('node-pty')
      ptyAvailable = typeof mod.spawn === 'function'
    } catch {
      ptyAvailable = false
      log('warn', 'node-pty 不可用（DSH_DESKTOP_TERM=pty 但未为 Electron ABI 构建），回落管道后端')
    }
    return ptyAvailable
  }

  const notifyExit = (code: number | null, reset: boolean): void => {
    if (closing) return
    handlers.onExit({ code, reset })
  }

  const spawnPipe = (spec: TermShellSpec): void => {
    const cwd = getCwd()
    log('info', `terminal spawn (pipe): ${spec.cmd} ${spec.args.join(' ')} cwd=${cwd}`)
    let child: ChildProcess
    try {
      child = spawn(spec.cmd, spec.args, {
        cwd,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      log('error', `terminal spawn threw: ${err instanceof Error ? err.message : String(err)}`)
      handlers.onData(`\r\n[无法启动 ${spec.cmd}: ${err instanceof Error ? err.message : String(err)}]\r\n`)
      return
    }
    pipeChild = child
    // 就绪横幅：明确后端模式与工作目录（管道模式无 TTY，需让用户知情）
    handlers.onData(`\r\n[DSH Desktop 终端 · ${spec.label} · 管道模式 · ${cwd}]\r\n`)
    const onChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (closing) return
      let text = chunk.toString('utf8')
      // 管道模式下 \r\n 会成对出现；去掉多余的 \r 避免双倍行距
      text = stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      handlers.onData(text)
    }
    child.stdout?.on('data', (c: Buffer) => onChunk('stdout', c))
    child.stderr?.on('data', (c: Buffer) => onChunk('stderr', c))
    child.on('error', (err) => {
      log('error', `terminal child error: ${err.message}`)
      handlers.onData(`\r\n[终端进程错误: ${err.message}]\r\n`)
    })
    child.on('exit', (code) => {
      pipeChild = null
      log('info', `terminal exited code=${String(code)}`)
      notifyExit(code, false)
    })
  }

  const spawnPty = (spec: TermShellSpec): void => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('node-pty') as { spawn: (c: string, a: string[], o: unknown) => PtyLike }
    const cwd = getCwd()
    log('info', `terminal spawn (pty): ${spec.cmd} ${spec.args.join(' ')}`)
    let proc: PtyLike
    try {
      proc = mod.spawn(spec.cmd, spec.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      })
    } catch (err) {
      log('error', `terminal pty spawn threw: ${err instanceof Error ? err.message : String(err)}`)
      handlers.onData(`\r\n[无法启动 ${spec.cmd}: ${err instanceof Error ? err.message : String(err)}]\r\n`)
      return
    }
    ptyProc = proc
    proc.onData((d) => {
      if (!closing) handlers.onData(d)
    })
    proc.onExit((e) => {
      ptyProc = null
      notifyExit(e.exitCode ?? null, false)
    })
  }

  const doSpawn = (shell: TermShell): boolean => {
    const spec = resolveShellSpec(shell)
    if (!spec) {
      handlers.onData(`\r\n[shell 不可用: ${shell}]\r\n`)
      return false
    }
    doClose()
    closing = false
    activeShell = spec
    if (usePty()) {
      backend = 'pty'
      spawnPty(spec)
    } else {
      backend = 'pipe'
      spawnPipe(spec)
    }
    return true
  }

  const doWrite = (data: string): void => {
    if (backend === 'pty' && ptyProc) {
      ptyProc.write(data)
      return
    }
    if (backend === 'pipe' && pipeChild && pipeChild.stdin?.writable) {
      // 管道模式没有真实信号：Ctrl+C → 会话复位（杀壳并重开）
      if (data.includes('\x03')) {
        handlers.onData('\r\n[Ctrl+C：管道模式无法发送信号，正在重置会话…]\r\n')
        const spec = activeShell
        doClose()
        closing = false
        if (spec) doSpawn(spec.label === 'PowerShell' ? 'powershell' : (spec.label as TermShell))
        return
      }
      try {
        pipeChild.stdin.write(data)
      } catch (err) {
        log('error', `terminal stdin write failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }
    // 无活动进程：忽略（面板仍显示，提示重开）
  }

  const doResize = (cols: number, rows: number): void => {
    if (backend === 'pty' && ptyProc) {
      try {
        ptyProc.resize(Math.max(10, cols), Math.max(3, rows))
      } catch {
        /* ignore */
      }
    }
    // pipe 模式忽略（行宽由 xterm 视口决定）
  }

  const doClose = (): void => {
    const hadProc = pipeChild !== null || ptyProc !== null
    closing = true
    const child = pipeChild
    if (child && child.exitCode === null) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    pipeChild = null
    const proc = ptyProc
    if (proc) {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }
    ptyProc = null
    // 主动关闭也通知面板（显示"已关闭，可重开"），与进程自然退出同构
    if (hadProc) handlers.onExit({ code: null, reset: true })
  }

  return {
    get activeShell(): TermShellSpec | null {
      return activeShell
    },
    get backend(): 'pipe' | 'pty' | null {
      return backend
    },
    spawn: doSpawn,
    write: doWrite,
    resize: doResize,
    close: doClose,
  }
}
