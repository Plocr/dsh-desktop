/**
 * 移植自 `deepseek-ai/deepseek-harness` `apps/desktop/src/host-process.ts`（MIT）。
 *
 * [ported] 与上游的差异（仅此五处，其余逐字保留）：
 *  1. 子进程入口路径按本壳的**非作用域**包名解析：
 *     `<runtimeDir>/node_modules/dsh-desktop-host/lib/index.js`；
 *  2. 上游的 `child.stdout?.pipe(process.stdout)` 换成可选回调 `onStdout(line)` +
 *     按字节切行的安全解码（多字节 UTF-8 不会被 chunk 边界切断），不再镜像到
 *     Electron 主进程的 stdout；
 *  3. 新增可选的按行 `onStderr(line)` 回调（stderr 的累加逻辑保持上游原样）；
 *  4. 新增可选 `onExit(code, signal)` 回调（HostManager 需要退出码/信号来决策重启）；
 *  5. 新增 `kill(signal)` 同步强杀（安装/退出兜底用）。
 */

/** Upstream-Node child lifecycle and streaming custom-protocol carrier. */

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
  DesktopHostResponseDecoder,
  encodeDesktopRequestCancel,
  encodeDesktopRequestData,
  encodeDesktopRequestEnd,
  encodeDesktopRequestStart,
  type DesktopHostCommand,
  type DesktopHostEvent,
  type DesktopHostResponseFrame,
} from './hostProtocol.ts'

interface PendingResponse {
  readonly resolve: (response: Response) => void
  readonly reject: (error: Error) => void
  responseStarted: boolean
  uploadOpen: boolean
  controller?: ReadableStreamDefaultController<Uint8Array>
  requestReader?: ReadableStreamDefaultReader<Uint8Array>
  removeAbort?: () => void
}

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'ready':
      return candidate.protocolVersion === DESKTOP_HOST_PROTOCOL_VERSION && typeof candidate.dshVersion === 'string'
    case 'fatal':
      return typeof candidate.message === 'string'
    default:
      return false
  }
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Ready facts reported by one installed dsh child. */
export interface DesktopHostReady {
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly dshVersion: string
}

/** One dsh backend running under the bundled upstream Node.js executable. */
export class DesktopHostProcess {
  private child: ChildProcess | undefined
  private requestPipe: Writable | undefined
  private responsePipe: Readable | undefined
  private readonly responseDecoder = new DesktopHostResponseDecoder()
  private requestWriteTail: Promise<void> = Promise.resolve()
  private nextStreamId = 1
  private readonly pending = new Map<number, PendingResponse>()
  private readonly blockedResponses = new Set<number>()
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stderr = ''
  private failureReported = false
  /** [ported] 未完成行的原始字节缓冲（跨 chunk 的多字节 UTF-8 序列不能被切断解码）。 */
  private stdoutPartial: Buffer = Buffer.alloc(0)
  /** [ported] 未完成行的 stderr 文本缓冲（stderr 走 setEncoding，已是解码后的字符串）。 */
  private stderrPartial = ''

  /**
   * @param node - absolute bundled upstream Node.js executable.
   * @param runtimeDir - immutable packages carried by the current application.
   * @param projectDir - active or staged desktop plugin profile.
   * @param inspectPort - optional loopback inspector port for workspace development.
   * @param environment - Child environment; runtime and package-manager overrides are removed.
   * @param onFailure - Receives the first fatal child or transport failure, including after readiness.
   * @param onStdout - [ported] Receives every complete stdout line (CR stripped, empty lines dropped).
   * @param onStderr - [ported] Receives every complete stderr line; accumulation below is unchanged.
   * @param onExit - [ported] Receives the child's exit code and signal once the process is gone.
   */
  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly onStdout?: (line: string) => void,
    private readonly onStderr?: (line: string) => void,
    private readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) {}

  /** Start the child once and resolve only after its complete composition is active. */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    // [ported] 本壳的 Host 包为**非作用域**名 `dsh-desktop-host`（见 packages/host/package.json），
    // 与官方私有包 `@deepseek-ai/dsh-desktop-host` 的路径不同。
    const entry = join(this.runtimeDir, 'node_modules', 'dsh-desktop-host', 'lib', 'index.js')
    const child = spawn(this.node, [
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.runtimeDir,
      this.projectDir,
      ...(this.inspectPort === undefined ? [] : ['--allow-linked-profile']),
    ], {
      cwd: this.projectDir,
      env: Object.fromEntries(Object.entries(this.environment).filter(([name]) => (
        name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
      ))),
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
    })
    const requestPipe = child.stdio[DESKTOP_REQUEST_PIPE_FD]
    const responsePipe = child.stdio[DESKTOP_RESPONSE_PIPE_FD]
    if (!(requestPipe instanceof Writable) || !(responsePipe instanceof Readable)) {
      child.kill('SIGTERM')
      throw new Error('dsh desktop host did not expose the required byte pipes and IPC channel')
    }
    this.child = child
    this.requestPipe = requestPipe
    this.responsePipe = responsePipe
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr += chunk })
    // [ported] 额外挂一个按行转发监听（上一行的累加逻辑与上游逐字一致；setEncoding 已保证多字节安全）。
    child.stderr?.on('data', (chunk: string) => { this.acceptStderrChunk(chunk) })
    // [ported] 上游把 stdout 原样镜像到主进程 stdout；本壳改为按行回调（bridge 发现行
    // 由 HostManager/index.ts 嗅探）。仍必须持续读取 stdout，否则子进程写满管道会阻塞。
    child.stdout?.on('data', (chunk: Buffer) => { this.acceptStdoutBytes(chunk) })
    responsePipe.on('data', (chunk: Buffer) => { this.acceptResponseBytes(chunk) })
    responsePipe.once('end', () => {
      try {
        this.responseDecoder.finish()
        this.fail(new Error('dsh desktop host response pipe ended'))
      } catch (error) {
        this.fail(errorOf(error, 'dsh desktop host response pipe failed'))
      }
    })
    requestPipe.once('error', (error) => { this.fail(error) })
    responsePipe.once('error', (error) => { this.fail(error) })
    child.on('message', (message: unknown) => {
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      this.handleMessage(message)
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code, signal) => {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`dsh desktop host stopped${suffix}`))
        // [ported] 退出通知：listener 抛错不得让 exitPromise 永远悬着。
        try {
          this.onExit?.(code, signal)
        } catch (listenerError) {
          console.error('desktop host exit listener failed', listenerError)
        }
        resolve()
      })
    })
    return this.readyPromise
  }

  /** Forward one `dsh-app://app` request to the child without buffering its body. */
  async fetch(request: Request): Promise<Response> {
    await this.start()
    const child = this.child
    if (child === undefined || !child.connected || this.requestPipe === undefined) {
      throw new Error('dsh desktop host is unavailable')
    }
    if (this.nextStreamId > 0xffff_ffff) throw new Error('dsh desktop host exhausted its request stream ids')
    const streamId = this.nextStreamId++
    const method = request.method.toUpperCase()
    const hasBody = method !== 'GET' && method !== 'HEAD' && request.body !== null
    return new Promise<Response>((resolve, reject) => {
      const pending: PendingResponse = {
        resolve,
        reject,
        responseStarted: false,
        uploadOpen: hasBody,
      }
      const abort = (): void => {
        if (!this.pending.has(streamId)) return
        const error = errorOf(request.signal.reason, 'request aborted')
        pending.uploadOpen = false
        void pending.requestReader?.cancel(error).catch(() => undefined)
        this.enqueueRequestFrame(encodeDesktopRequestCancel(streamId)).catch((pipeError: unknown) => {
          this.fail(errorOf(pipeError, 'dsh desktop request pipe failed'))
        })
        if (pending.controller === undefined) pending.reject(error)
        else pending.controller.error(error)
        this.finishPending(streamId, false)
      }
      if (request.signal.aborted) {
        reject(errorOf(request.signal.reason, 'request aborted'))
        return
      }
      request.signal.addEventListener('abort', abort, { once: true })
      pending.removeAbort = () => { request.signal.removeEventListener('abort', abort) }
      this.pending.set(streamId, pending)
      this.pumpRequest(streamId, request, hasBody).catch((error: unknown) => {
        this.failPending(streamId, errorOf(error, 'dsh desktop request upload failed'))
      })
    })
  }

  /**
   * [ported] 同步强杀子进程（不等优雅停机）：供安装/退出兜底与重启交接使用。
   * @param signal - signal delivered to the child; defaults to SIGKILL.
   */
  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.child?.kill(signal)
  }

  /** Request graceful teardown, then wait for child exit. */
  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.blockedResponses.clear()
    this.responsePipe?.resume()
    if (child.connected) this.send({ type: 'shutdown' })
    // Closing the parent-owned write end releases the Host's pending Windows pipe read.
    this.requestPipe?.destroy()
    const exited = this.exitPromise ?? Promise.resolve()
    if (!await exitsWithin(exited, 10_000)) child.kill('SIGTERM')
    if (!await exitsWithin(exited, 5_000)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) {
        throw new Error('dsh desktop host did not exit after SIGKILL')
      }
    }
    this.child = undefined
    this.requestPipe = undefined
    this.responsePipe = undefined
  }

  private async pumpRequest(streamId: number, request: Request, hasBody: boolean): Promise<void> {
    await this.enqueueRequestFrame(encodeDesktopRequestStart(streamId, {
      url: request.url,
      method: request.method.toUpperCase(),
      headers: [...request.headers.entries()],
      hasBody,
    }))
    if (!hasBody) return
    const body = request.body
    if (body === null) throw new Error('dsh desktop request body disappeared before upload')
    const reader = body.getReader()
    const pending = this.pending.get(streamId)
    if (pending === undefined) {
      await reader.cancel()
      return
    }
    pending.requestReader = reader
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        for (let offset = 0; offset < next.value.byteLength; offset += DESKTOP_PIPE_CHUNK_BYTES) {
          if (!this.pending.has(streamId)) return
          await this.enqueueRequestFrame(encodeDesktopRequestData(
            streamId,
            next.value.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES),
          ))
        }
      }
      const live = this.pending.get(streamId)
      if (live !== undefined) {
        await this.enqueueRequestFrame(encodeDesktopRequestEnd(streamId))
        live.uploadOpen = false
      }
    } finally {
      reader.releaseLock()
      const live = this.pending.get(streamId)
      if (live?.requestReader === reader) delete live.requestReader
    }
  }

  private enqueueRequestFrame(frame: Buffer): Promise<void> {
    const write = this.requestWriteTail.then(async () => {
      const pipe = this.requestPipe
      if (pipe === undefined || pipe.destroyed) throw new Error('dsh desktop host request pipe is unavailable')
      if (!pipe.write(frame)) await once(pipe, 'drain')
    })
    this.requestWriteTail = write.catch(() => undefined)
    return write
  }

  private send(message: DesktopHostCommand): void {
    const child = this.child
    if (child === undefined || !child.connected) throw new Error('dsh desktop host IPC is unavailable')
    child.send(message, (error) => { if (error !== null) this.fail(error) })
  }

  /**
   * [ported] 按字节（0x0a）切行后再整体解码：UTF-8 多字节序列被 chunk 边界切开时
   * 不会产生乱码（未读完的最后一行以原始字节留待下个 chunk）。
   */
  private acceptStdoutBytes(chunk: Buffer): void {
    const buffer = this.stdoutPartial.byteLength === 0 ? chunk : Buffer.concat([this.stdoutPartial, chunk])
    let start = 0
    let index = buffer.indexOf(0x0a, start)
    while (index !== -1) {
      const line = buffer.subarray(start, index).toString('utf8').replace(/\r$/, '')
      start = index + 1
      index = buffer.indexOf(0x0a, start)
      if (line !== '') this.onStdout?.(line)
    }
    this.stdoutPartial = start === 0 ? buffer : buffer.subarray(start)
  }

  /** [ported] stderr 按行转发（换行切分；`\r` 剥离，空行丢弃）。 */
  private acceptStderrChunk(chunk: string): void {
    const text = this.stderrPartial === '' ? chunk : this.stderrPartial + chunk
    let start = 0
    let index = text.indexOf('\n', start)
    while (index !== -1) {
      const line = text.slice(start, index).replace(/\r$/, '')
      start = index + 1
      index = text.indexOf('\n', start)
      if (line !== '') this.onStderr?.(line)
    }
    this.stderrPartial = start === 0 ? text : text.slice(start)
  }

  private acceptResponseBytes(chunk: Buffer): void {
    try {
      for (const frame of this.responseDecoder.push(chunk)) this.handleResponseFrame(frame)
    } catch (error) {
      this.fail(errorOf(error, 'dsh desktop host response pipe failed'))
      this.child?.kill('SIGTERM')
    }
  }

  private handleResponseFrame(frame: DesktopHostResponseFrame): void {
    const pending = this.pending.get(frame.streamId)
    if (pending === undefined) {
      if (frame.streamId >= this.nextStreamId) {
        throw new Error(`dsh desktop host responded for unknown stream ${String(frame.streamId)}`)
      }
      return
    }
    switch (frame.type) {
      case 'start': {
        if (pending.responseStarted) throw new Error(`dsh desktop host started stream ${String(frame.streamId)} twice`)
        pending.responseStarted = true
        let body: ReadableStream<Uint8Array> | null = null
        if (frame.hasBody) {
          body = new ReadableStream<Uint8Array>({
            start: (controller) => { pending.controller = controller },
            pull: () => {
              this.blockedResponses.delete(frame.streamId)
              this.resumeResponsePipe()
            },
            cancel: (reason) => { this.cancelResponse(frame.streamId, reason) },
          })
        }
        pending.resolve(new Response(body, {
          status: frame.status,
          headers: new Headers(frame.headers.map(([name, value]) => [name, value] as [string, string])),
        }))
        return
      }
      case 'data': {
        const controller = pending.controller
        if (!pending.responseStarted || controller === undefined) {
          throw new Error(`dsh desktop host sent body data before a body start for stream ${String(frame.streamId)}`)
        }
        controller.enqueue(frame.data)
        if ((controller.desiredSize ?? 0) <= 0) {
          this.blockedResponses.add(frame.streamId)
          this.responsePipe?.pause()
        }
        return
      }
      case 'end':
        if (!pending.responseStarted) {
          throw new Error(`dsh desktop host ended stream ${String(frame.streamId)} before its response start`)
        }
        pending.controller?.close()
        this.finishPending(frame.streamId, true)
        return
      case 'error':
        this.failPending(frame.streamId, new Error(frame.message))
        return
      default:
        frame satisfies never
    }
  }

  private cancelResponse(streamId: number, reason: unknown): void {
    const pending = this.pending.get(streamId)
    if (pending === undefined) return
    pending.uploadOpen = false
    void pending.requestReader?.cancel(reason).catch(() => undefined)
    this.enqueueRequestFrame(encodeDesktopRequestCancel(streamId)).catch((error: unknown) => {
      this.fail(errorOf(error, 'dsh desktop request pipe failed'))
    })
    this.finishPending(streamId, false)
  }

  private failPending(streamId: number, error: Error): void {
    const pending = this.pending.get(streamId)
    if (pending === undefined) return
    pending.uploadOpen = false
    void pending.requestReader?.cancel(error).catch(() => undefined)
    if (pending.controller === undefined) pending.reject(error)
    else pending.controller.error(error)
    this.enqueueRequestFrame(encodeDesktopRequestCancel(streamId)).catch((pipeError: unknown) => {
      this.fail(errorOf(pipeError, 'dsh desktop request pipe failed'))
    })
    this.finishPending(streamId, false)
  }

  private finishPending(streamId: number, cancelOpenUpload: boolean): void {
    const pending = this.pending.get(streamId)
    if (pending === undefined) return
    if (cancelOpenUpload && pending.uploadOpen) {
      pending.uploadOpen = false
      void pending.requestReader?.cancel().catch(() => undefined)
      this.enqueueRequestFrame(encodeDesktopRequestCancel(streamId)).catch((error: unknown) => {
        this.fail(errorOf(error, 'dsh desktop request pipe failed'))
      })
    }
    pending.removeAbort?.()
    this.pending.delete(streamId)
    this.blockedResponses.delete(streamId)
    this.resumeResponsePipe()
  }

  private resumeResponsePipe(): void {
    if (this.blockedResponses.size === 0) this.responsePipe?.resume()
  }

  private handleMessage(message: DesktopHostEvent): void {
    switch (message.type) {
      case 'ready':
        this.readyResolve(message)
        return
      case 'fatal':
        this.fail(new Error(message.message))
        return
      default:
        message satisfies never
    }
  }

  private fail(error: Error): void {
    this.readyReject(error)
    if (!this.failureReported) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('desktop host failure listener failed', listenerError)
      }
    }
    for (const pending of this.pending.values()) {
      void pending.requestReader?.cancel(error).catch(() => undefined)
      if (pending.controller === undefined) pending.reject(error)
      else pending.controller.error(error)
      pending.removeAbort?.()
    }
    this.pending.clear()
    this.blockedResponses.clear()
    this.responsePipe?.resume()
  }
}
