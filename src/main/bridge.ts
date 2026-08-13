/**
 * BridgeClient（壳侧）：连接 harness 内 dsh-desktop-bridge 插件的本地 WebSocket。
 *  - token 鉴权握手
 *  - 事件推送（jobs.changed / job.done / approval.asked）→ onEvent
 *  - RPC（workspace.register / runtime.info / ping）→ call()
 *  - 断线 1s 退避重连（harness 重启后 token/端口会更新，connect() 重新读取目标）
 */
import { log } from './logger'

export interface BridgeTarget {
  port: number
  token: string
}

export interface BridgeHandlers {
  onEvent: (type: string, payload: unknown) => void
  onConnected: (connected: boolean) => void
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class BridgeClient {
  private ws: WebSocket | null = null
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private nextId = 1
  private pending = new Map<number, Pending>()
  private connected = false

  constructor(
    private getTarget: () => BridgeTarget | null,
    private handlers: BridgeHandlers,
  ) {}

  connect(): void {
    this.stop() // 先关旧连接/定时器，避免重复连接
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }

  /** shell -> harness RPC；未连接时 reject。 */
  call(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.connected) {
      return Promise.reject(new Error('bridge 未连接'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge call timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(t)
          reject(e)
        },
      })
      try {
        ws.send(JSON.stringify({ type: 'call', id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(t)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private open(): void {
    if (this.stopped) return
    const target = this.getTarget()
    if (!target) return
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://127.0.0.1:${target.port}`)
    } catch (err) {
      log('error', `bridge ws construct failed: ${err instanceof Error ? err.message : String(err)}`)
      this.schedule()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'auth', token: target.token }))
      } catch {
        /* ignore */
      }
    }
    ws.onmessage = (ev) => {
      let msg: { type?: string; payload?: unknown; id?: number; result?: unknown; error?: string }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (!msg || typeof msg.type !== 'string') return
      if (msg.type === 'authed') {
        this.connected = true
        this.handlers.onConnected(true)
        log('info', 'bridge connected')
      } else if (msg.type === 'result') {
        const id = msg.id
        if (id === undefined) return
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
      } else {
        this.handlers.onEvent(msg.type, msg.payload)
      }
    }
    ws.onclose = () => {
      this.connected = false
      this.handlers.onConnected(false)
      for (const [, p] of this.pending) p.reject(new Error('bridge 连接断开'))
      this.pending.clear()
      this.schedule()
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, 1000)
  }
}
