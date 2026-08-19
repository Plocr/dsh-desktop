/**
 * 局域网反向代理（跟随框架，壳内实现）——让手机/其它设备经电脑授权后访问
 * 本机 harness Web UI，同时**不改动 harness 的监听地址**（保持 127.0.0.1，
 * 官方默认，浏览器版/本机窗口永不受影响）。
 *
 * 设计：
 *  - 代理监听 0.0.0.0:<随机端口>（对外地址 http://<本机局域网IP>:<代理端口>）；
 *  - HTTP 直通转发到 127.0.0.1:<harness web 端口>，WebSocket upgrade 一起转发；
 *  - 首次来自某设备 IP 的请求 → 调用 requestApproval(ip)（壳弹原生授权框）；
 *    允许 → 该 IP 本次运行放行；拒绝 → 403，不加入白名单；
 *  - Host 头原样转发；harness 的 /api 浏览器信任围栏依赖壳在启动时传入
 *    --trusted-host <局域网IP>（host-only 匹配，容忍任意端口）。
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { Socket } from 'node:net'
// 显式 .ts：既满足 esbuild 打包，也便于 Node 直跑单测
import { log } from './logger.ts'

export interface LanProxyOptions {
  /** 转发目标 host（固定 127.0.0.1）。 */
  targetHost: string
  /** 转发目标端口（harness web 端口）。 */
  targetPort: number
  /** 首次访问授权回调：允许 → true。 */
  requestApproval: (ip: string) => Promise<boolean>
}

export interface LanProxyHandle {
  /** 代理实际监听端口（对外 URL 用）。 */
  port: number
  stop: () => Promise<void>
}

/** 授权等待上限：超时按拒绝处理（避免请求无限挂起 → 手机一直转圈）。 */
const APPROVAL_TIMEOUT_MS = 90_000

/** 归一化客户端 IP（IPv4-mapped `::ffff:a.b.c.d` → `a.b.c.d`）。 */
export function clientIpOf(socket: object | null | undefined): string {
  const remote = (socket as { remoteAddress?: unknown } | null | undefined)?.remoteAddress
  const addr = typeof remote === 'string' ? remote : ''
  return addr.replace(/^::ffff:/, '')
}

/** 拒绝响应。 */
function deny(res: import('node:http').ServerResponse): void {
  res.statusCode = 403
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end('denied: 未获得本机授权访问 DSH Desktop')
}

export function createLanProxy(opts: LanProxyOptions): Promise<LanProxyHandle> {
  return new Promise<LanProxyHandle>((resolve, reject) => {
    // 已获授权的设备 IP（本次运行内有效）
    const approvedIps = new Set<string>()
    // 正在授权的请求（同一 IP 并发请求共享一次授权，避免多次弹窗/竞态）
    const pendingApprovals = new Map<string, Promise<boolean>>()

    const gate = (ip: string): Promise<boolean> => {
      if (approvedIps.has(ip)) return Promise.resolve(true)
      let p = pendingApprovals.get(ip)
      if (!p) {
        p = new Promise<boolean>((resolveGate) => {
          let timer: NodeJS.Timeout | undefined
          let settled = false
          const settle = (granted: boolean): void => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            if (granted) {
              approvedIps.add(ip)
              log('info', `lanProxy: ${ip} 已获授权`)
            } else {
              log('info', `lanProxy: ${ip} 未获授权或超时`)
            }
            resolveGate(granted)
          }
          // 授权（弹窗）超时/被忽略 → 按拒绝处理，绝不无限挂起
          timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS)
          opts.requestApproval(ip).then(
            (ok) => settle(ok),
            (err) => {
              log('error', `lanProxy: approval error: ${err instanceof Error ? err.message : String(err)}`)
              settle(false)
            },
          )
        })
        const final = p.finally(() => pendingApprovals.delete(ip))
        pendingApprovals.set(ip, final)
        p = final
      }
      return p
    }

    const server: Server = createServer()
    const sockets = new Set<Socket>()

    server.on('connection', (s) => {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    })

    // 畸形请求：直接 400，不挂连接
    server.on('clientError', (_err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        /* ignore */
      }
    })

    // HTTP 直通
    server.on('request', (req, res) => {
      void (async () => {
        try {
          const ip = clientIpOf(req.socket)
          log('info', `lanProxy: ${req.method} ${req.url} from ${ip}`)
          if (!(await gate(ip))) {
            deny(res)
            return
          }
          const proxyReq = httpRequest({
            host: opts.targetHost,
            port: opts.targetPort,
            method: req.method,
            path: req.url,
            headers: { ...req.headers },
          })
          proxyReq.on('error', (err) => {
            log('error', `lanProxy: forward error: ${err.message}`)
            if (!res.headersSent) {
              res.statusCode = 502
              res.end('harness 不可达')
            } else {
              res.destroy()
            }
          })
          proxyReq.on('response', (upRes) => {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers)
            upRes.pipe(res)
          })
          req.pipe(proxyReq)
        } catch (err) {
          log('error', `lanProxy: request handler error: ${err instanceof Error ? err.message : String(err)}`)
          if (!res.headersSent) {
            res.statusCode = 500
            res.end('internal error')
          } else {
            res.destroy()
          }
        }
      })()
    })

  // WebSocket 升级转发（harness 客户端流式/工具事件走 WS）
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        const ip = clientIpOf(socket)
        log('info', `lanProxy: upgrade ${req.url} from ${ip}`)
        if (!(await gate(ip))) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        const proxyReq = httpRequest({
          host: opts.targetHost,
          port: opts.targetPort,
          method: req.method ?? 'GET',
          path: req.url,
          headers: { ...req.headers },
        })
        proxyReq.on('error', (err) => {
          log('error', `lanProxy: upgrade error: ${err.message}`)
          socket.destroy()
        })
        proxyReq.on('upgrade', (upRes, upSock, upHead) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
        upSock.write(upHead as Buffer)
        upSock.pipe(socket)
        socket.pipe(upSock)
      })
      proxyReq.end(head)
      } catch (err) {
        log('error', `lanProxy: upgrade handler error: ${err instanceof Error ? err.message : String(err)}`)
        socket.destroy()
      }
    })()
  })

  server.on('error', (err) => {
    log('error', `lanProxy: server error: ${err.message}`)
  })

  // 用端口 0 让 OS 分配，监听所有接口（对外用 detectLanIp 构造地址）；等 listening 再取端口
  const ready = new Promise<void>((r, j) => {
    server.once('listening', r)
    server.once('error', j)
  })
  server.listen(0, '0.0.0.0')
  void ready.then(() => {
    const addr = server.address()
    const port = typeof addr === 'object' && addr !== null ? (addr as { port: number }).port : 0
    resolve({
      port,
      stop: async () => {
        for (const s of sockets) {
          try {
            s.destroy()
          } catch {
            /* ignore */
          }
        }
        await new Promise<void>((res2) => {
          server.close(() => res2())
          // 无活动连接时 close 回调可能不触发，兜底
          setTimeout(res2, 500)
        })
      },
    })
  }, reject)
  })
}

