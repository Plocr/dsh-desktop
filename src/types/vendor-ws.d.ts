/**
 * vendored ws（packages/bridge/vendor/ws，无运行时依赖的 ws@8 副本）的最小类型声明。
 * 主进程需要它而不是 Node 内建 WebSocket：只有 ws 允许自定义握手头
 * （Host / Cookie —— harness 的 /api 信任围栏与浏览器会话 cookie 都依赖它们）。
 */
declare module '*/vendor/ws/wrapper.mjs' {
  export interface WebSocketOptions {
    headers?: Record<string, string>
    handshakeTimeout?: number
  }

  export class WebSocket {
    constructor(url: string, options?: WebSocketOptions)
    static readonly OPEN: number
    static readonly CLOSED: number
    readonly readyState: number
    on(event: 'open', listener: () => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'message', listener: (data: Buffer | string) => void): this
    on(event: 'unexpected-response', listener: (req: unknown, res: { statusCode?: number }) => void): this
    send(data: string): void
    close(code?: number, reason?: string): void
  }

  export default WebSocket
}
