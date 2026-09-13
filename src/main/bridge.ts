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
    this.disposeSocket()
    if (this.connected) {
      this.connected = false
      this.handlers.onConnected(false)
    }
    // 停机时在途 RPC 直接失败——旧 socket 的 close 事件已被世代守卫忽略，不会替我们 reject
    for (const [, p] of this.pending) p.reject(new Error('bridge 已停止'))
    this.pending.clear()
  }

  /**
   * 丢弃当前 socket：先断开引用再 close，使它的 onclose 判定为「非当前世代」而
   * 不会触发重连/误杀后续连接的在途 RPC。
   */
  private disposeSocket(): void {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    try {
      ws.close()
    } catch {
      /* ignore */
    }
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
    if (!target) return // 无目标（harness 未就绪）：由 ready 后的 connect() 重新驱动
    // 关掉旧连接再建新的：避免 this.ws 被覆盖后旧连接变孤儿（重复推送事件）
    this.disposeSocket()
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://127.0.0.1:${target.port}`)
    } catch (err) {
      log('error', `bridge ws construct failed: ${err instanceof Error ? err.message : String(err)}`)
      this.schedule()
      return
    }
    this.ws = ws
    // 世代守卫：只有当前 socket 的事件才允许改状态/重连/结算 pending；
    // 旧 socket 迟到的 close 不得重连（否则每次启停累积并行连接）也不得误杀新连接的在途 RPC
    const isCurrent = (): boolean => this.ws === ws
    ws.onopen = () => {
      if (!isCurrent()) return
      try {
        ws.send(JSON.stringify({ type: 'auth', token: target.token }))
      } catch {
        /* ignore */
      }
    }
    ws.onmessage = (ev) => {
      if (!isCurrent()) return
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
      if (!isCurrent()) return // 旧世代的关闭事件：忽略
      this.ws = null
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
