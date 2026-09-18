/**
 * 局域网访问 / 本机浏览器版：**唯一**会对外开监听口的模块（默认关闭，用户在托盘显式开启）。
 *
 * 与旧实现的差异：这里**不**维护第二套 harness 监听口，而是把 HTTP 请求直接喂给壳自己的
 * forward（官方传输下 = 带 Host cookie 的转发，见 webDocument.ts）。
 * 于是局域网设备拿到的页面、`/api`、WebSocket 流与桌面窗口完全同源同实现。
 *
 * 门禁（两道，缺一不可）：
 *  1. 设备授权：非回环来源首次访问弹原生确认框（按 IP 记一次，本次运行有效）；
 *     **回环来源免授权**——本机浏览器与桌面窗口同级信任；
 *  2. 访问 token：`http://…/?token=<本次运行随机值>` 一次性换取 HttpOnly cookie，
 *     之后靠 cookie 放行（手机端可以把这个地址存成书签）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import type { Duplex } from 'node:stream'
// 显式 .ts：既满足 esbuild 打包，也便于 Node 直跑单测
import { log } from './logger.ts'

/** 局域网代理默认固定端口（被占用时回退随机端口）。可用 DSH_LAN_PROXY_PORT 覆盖（0 = 每次随机）。 */
export const DSH_LAN_PORT = (() => {
  const raw = process.env.DSH_LAN_PROXY_PORT
  if (raw === undefined || raw.trim() === '') return 46123
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 46123
})()

export interface LanProxyOptions {
  /** 转发目标：Host 进程的管道 fetch。 */
  forward: (request: Request) => Promise<Response>
  /**
   * WebSocket 升级转发（官方传输下客户端用 WS mux 拉流；门面必须一并代理）。
   * 门禁（设备授权 + token cookie）在调用它之前已经校验过。
   */
  upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** 监听地址（默认 0.0.0.0；本机浏览器版可传 127.0.0.1）。 */
  bindHost?: string
  /** 监听端口；缺省 DSH_LAN_PORT（占用自动回退随机）。传 0 = 随机。 */
  port?: number
  /** 非回环来源的设备授权回调（允许 → true）。回环来源不会调用它。 */
  requestApproval?: (ip: string) => Promise<boolean>
  /** 本次运行的访问 token（`?token=` 一次性换取 HttpOnly cookie）。缺省不启用门禁（仅测试用）。 */
  token?: string
}

export interface LanProxyHandle {
  /** 代理实际监听端口（对外 URL 用）。 */
  port: number
  stop: () => Promise<void>
}

/** 授权等待上限：超时按拒绝处理（避免请求无限挂起 → 手机一直转圈）。 */
const APPROVAL_TIMEOUT_MS = 90_000
/** 访问 cookie 名（HttpOnly，本会话有效）。 */
const ACCESS_COOKIE = 'dsh-desk-access'

/** 归一化客户端 IP（IPv4-mapped `::ffff:a.b.c.d` → `a.b.c.d`）。 */
export function clientIpOf(socket: object | null | undefined): string {
  // 鸭子类型（真实 net.Socket 与测试替身都能用）
  const addr = (socket as { remoteAddress?: string } | null | undefined)?.remoteAddress ?? ''
  if (addr.startsWith('::ffff:')) return addr.slice('::ffff:'.length)
  if (addr === '::1') return '127.0.0.1'
  return addr
}

/** 是否回环来源（同机浏览器/本应用自身）：免设备授权。导出供单测与诊断。 */
export function isLoopbackSource(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.')
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

/** 逐跳首部：由本机 http 栈自己管理，不得进入 whatwg Request。 */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'])

/**
 * node:http 请求 → whatwg Request（请求体以流方式交给 Host，不整体缓冲）。
 * Host 侧的管道协议按帧搬运请求体，大文件上传不会被壳整份吃进内存。
 */
function toRequest(req: IncomingMessage, origin: string): Request {
  const url = new URL(req.url ?? '/', origin)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  const method = (req.method ?? 'GET').toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const init: RequestInit & { duplex?: 'half' } = { method, headers }
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
    init.duplex = 'half'
  }
  return new Request(url, init)
}

/** whatwg Response → node:http 响应（逐帧写出，带背压）。 */
async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of response.headers) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    if (key.toLowerCase() === 'set-cookie') {
      headers[key] = [...(headers[key] ?? []), value]
      continue
    }
    headers[key] = value
  }
  res.writeHead(response.status, headers)
  const body = response.body
  if (body === null) {
    res.end()
    return
  }
  const reader = body.getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (!res.write(Buffer.from(next.value))) await once(res, 'drain')
    }
  } finally {
    reader.releaseLock()
  }
  res.end()
}

/**
 * 启动对外服务：监听 bindHost:port，全部请求交给 forward（Host 管道 fetch）。
 * 监听失败（端口占用等）时：port 非 0 则回退随机端口再试一次。
 */
export async function createLanProxy(opts: LanProxyOptions): Promise<LanProxyHandle> {
  const bindHost = opts.bindHost ?? '0.0.0.0'
  const approved = new Set<string>()
  const origin = `http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}`
  const server = createServer((req, res) => {
    void handle(req, res)
  })

  /**
   * 升级请求同样要过两道门（设备授权 + token cookie）：否则任何设备都能绕过
   * 门禁直接开一条 WebSocket。校验通过后才交给 `upgrade` 代理。
   */
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const ip = clientIpOf(req.socket)
    const rejected = (status: number, text: string): void => {
      socket.write(`HTTP/1.1 ${String(status)} ${text}\r\nconnection: close\r\n\r\n`)
      socket.destroy()
    }
    const authorize = async (): Promise<boolean> => {
      if (!isLoopbackSource(ip) && opts.requestApproval && !approved.has(ip)) {
        let allow = false
        try {
          allow = await Promise.race([
            opts.requestApproval(ip),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), APPROVAL_TIMEOUT_MS)),
          ])
        } catch (err) {
          log('error', `lan: upgrade approval failed: ${err instanceof Error ? err.message : String(err)}`)
          allow = false
        }
        if (!allow) return false
        approved.add(ip)
        log('info', `lan: device ${ip} approved (websocket)`)
      }
      if (opts.token && readCookie(req.headers.cookie, ACCESS_COOKIE) !== opts.token) return false
      return true
    }
    void authorize().then((allowed) => {
      if (!allowed) {
        rejected(401, 'Unauthorized')
        return
      }
      if (opts.upgrade === undefined) {
        rejected(501, 'Not Implemented')
        return
      }
      try {
        opts.upgrade(req, socket, head)
      } catch (err) {
        log('error', `lan: websocket proxy failed: ${err instanceof Error ? err.message : String(err)}`)
        rejected(502, 'Bad Gateway')
      }
    })
  }
  server.on('upgrade', (req, socket, head) => { handleUpgrade(req, socket, head) })

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const ip = clientIpOf(req.socket)
      // 1. 设备授权（回环免授权）
      if (!isLoopbackSource(ip) && opts.requestApproval && !approved.has(ip)) {
        let allow = false
        try {
          allow = await Promise.race([
            opts.requestApproval(ip),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), APPROVAL_TIMEOUT_MS)),
          ])
        } catch (err) {
          log('error', `lan: approval failed: ${err instanceof Error ? err.message : String(err)}`)
          allow = false
        }
        if (!allow) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('设备未获授权')
          return
        }
        approved.add(ip)
        log('info', `lan: device ${ip} approved`)
      }
      // 2. 访问 token（一次性换 cookie）
      if (opts.token) {
        const url = new URL(req.url ?? '/', origin)
        const presented = url.searchParams.get('token')
        if (presented !== null) {
          if (presented !== opts.token) {
            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('unauthorized')
            return
          }
          url.searchParams.delete('token')
          res.writeHead(303, {
            'cache-control': 'no-store',
            location: `${url.pathname}${url.search}`,
            'set-cookie': `${ACCESS_COOKIE}=${opts.token}; Path=/; HttpOnly; SameSite=Lax`,
          })
          res.end()
          return
        }
        if (readCookie(req.headers.cookie, ACCESS_COOKIE) !== opts.token) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('unauthorized（请用带 ?token=… 的地址打开一次）')
          return
        }
      }
      const response = await opts.forward(toRequest(req, origin))
      await writeResponse(res, response)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('error', `lan: request failed: ${message}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`proxy error: ${message}`)
    }
  }

  const listen = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, bindHost)
    })

  const preferred = opts.port ?? DSH_LAN_PORT
  try {
    await listen(preferred)
  } catch (err) {
    if (preferred === 0) throw err
    log('error', `lan: 端口 ${preferred} 监听失败（${err instanceof Error ? err.message : String(err)}），回退随机端口`)
    await listen(0)
  }
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : preferred
  log('info', `lan: listening on ${bindHost}:${port}`)
  return {
    port,
    stop: async () => {
      const closed = once(server, 'close')
      server.closeAllConnections?.()
      server.close()
      await closed.catch(() => undefined)
    },
  }
}

/** 供测试与诊断使用（不要在生产代码里持有）。 */
export type { Server }
