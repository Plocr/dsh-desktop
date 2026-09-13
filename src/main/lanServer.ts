/**
 * 局域网反向代理（跟随框架，壳内实现）——让手机/其它设备经电脑授权后访问
 * 本机 harness Web UI，同时**不改动 harness 的监听地址**（保持 127.0.0.1，
 * 官方默认，浏览器版/本机窗口永不受影响）。
 *
 * 设计：
 *  - 代理监听 0.0.0.0:<固定端口>（默认 DSH_LAN_PORT，占用时退回随机端口），
 *    对外地址 http://<本机局域网IP>:<端口>，端口固定 → 手机链接稳定；
 *  - HTTP 直通转发到 127.0.0.1:<harness web 端口>，WebSocket upgrade 一起转发；
 *  - 首次来自某设备 IP 的请求 → 调用 requestApproval(ip)（壳弹原生授权框）；
 *    允许 → 该 IP 本次运行放行；拒绝 → 403，不加入白名单；
 *  - Host 头原样转发；harness 的 /api 浏览器信任围栏依赖壳在启动时传入
 *    --trusted-host <局域网IP>（host-only 匹配，容忍任意端口）；
 *  - 特例：`/api/host.*`（如 host.pickDirectory）官方「loopback 直连钉死」——
 *    只有回环 Host 才放行。代理本就是从 127.0.0.1 连入，故对这些请求把转发
 *    Host 改写成 127.0.0.1:<目标端口>，让手机也能触发本机原生能力（选目录等）。
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { Socket } from 'node:net'
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
  /** 转发目标 host（固定 127.0.0.1）。 */
  targetHost: string
  /** 转发目标端口（harness web 端口）。 */
  targetPort: number
  /** 首次访问授权回调：允许 → true。 */
  requestApproval: (ip: string) => Promise<boolean>
  /** 代理监听端口；缺省 DSH_LAN_PORT（占用自动回退随机）。传 0 = 随机。 */
  port?: number
  /**
   * harness Web UI 的本次启动 token（`dsh web:` 行 URL 里的 `token=`）。
   * harness ≥ 0.1.2-rc.1 对 Web UI 启用了「URL token 一次性换取 HttpOnly cookie」鉴权：
   * 外部设备首发访问不带 token 会 401。代理在**客户端尚无鉴权 cookie** 时补一次 token，
   * 让手机用稳定 URL 打开并在浏览器侧完成换 cookie；已有 cookie 时不得再带 token
   * （harness 见到 token 就 303 重定向，会与代理补 token 形成死循环）。
   */
  webToken?: string
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

/** 把上游响应行 + 全部响应头原样写入原始 socket（101 握手 / 非升级响应共用）。 */
function writeRawResponseHead(
  socket: { write: (chunk: string | Buffer) => unknown },
  upRes: import('node:http').IncomingMessage,
): boolean {
  const lines = [`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ''}`.trimEnd()]
  for (let i = 0; i + 1 < upRes.rawHeaders.length; i += 2) {
    lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`)
  }
  try {
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    return true
  } catch {
    return false
  }
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

    // 每个接受的连接都必须有 error 处理器：手机/设备中途断开会发 ECONNRESET，
    // 没有处理器会变成主进程未捕获异常 → Electron 崩溃弹窗卡死。
    server.on('connection', (s) => {
      s.on('error', () => {})
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    })

    /**
     * 计算转发路径：客户端还没有 harness 鉴权 cookie 时补一次 `token=`，
     * 让外部设备用稳定 URL（http://<lan-ip>:<port>/）完成「token → HttpOnly cookie」换取。
     * 已有 cookie 或 URL 已带 token 时原样转发（否则 harness 会反复 303 重定向）。
     */
    const forwardPath = (req: { url?: string; headers: import('node:http').IncomingHttpHeaders }): string => {
      const p = typeof req.url === 'string' && req.url !== '' ? req.url : '/'
      if (!opts.webToken) return p
      const cookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : ''
      if (/(^|;\s*)dsh-auth-/.test(cookie)) return p
      if (/([?&])token=/.test(p)) return p
      return p + (p.includes('?') ? '&' : '?') + `token=${encodeURIComponent(opts.webToken)}`
    }

    /**
     * 同源校验（浏览器 CSRF 防护）：来自浏览器的请求若携带 Origin/Referer，
     * 其主机必须是本代理自身（请求的 Host 头）或回环；否则拒绝。
     * 仅凭源 IP 授权无法区分「同一 IP 下的不同来源」——本机恶意网页 / 局域网内
     * 其它站点都能借用已授权 IP，故必须额外做同源检查。
     */
    const sameOriginOk = (headers: import('node:http').IncomingHttpHeaders): boolean => {
      const origin = typeof headers.origin === 'string' ? headers.origin : ''
      const referer = typeof headers.referer === 'string' ? headers.referer : ''
      const raw = origin !== '' ? origin : referer
      if (raw === '') return true // 非浏览器请求（curl 等）：由 IP 授权把关
      let host = ''
      try {
        host = new URL(raw).host.toLowerCase()
      } catch {
        return false // Origin: null / 非法值
      }
      if (host === '') return false
      const self = typeof headers.host === 'string' ? headers.host.toLowerCase() : ''
      if (self !== '' && host === self) return true
      const hostname = host.replace(/:\d+$/, '')
      return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
    }

    /**
     * 计算转发请求头。
     * 已授权的设备视为「等同本地」：对 `/api/*` 把 Host/Origin/Referer 改写为回环权威
     * `127.0.0.1:<harness端口>`，绕过 harness 的 trusted/loopback 分级（免得诸如
     * workspace.* / host.* 等「碰本地文件」的接口对手机 403）。静态资源原样走局域网。
     */
    const forwardHeaders = (req: { url?: string; headers: import('node:http').IncomingHttpHeaders }): Record<string, unknown> => {
      const headers: Record<string, unknown> = { ...req.headers }
      // 去掉 accept-encoding：HTML 响应需要缓冲后注入垫片（明文），压缩体会破坏注入
      delete headers['accept-encoding']
      if (typeof req.url === 'string' && req.url.startsWith('/api/')) {
        const loopAuthority = `127.0.0.1:${opts.targetPort}`
        headers.host = loopAuthority
        headers.origin = `http://${loopAuthority}`
        headers.referer = `http://${loopAuthority}/`
      }
      return headers
    }

    // 畸形请求：直接 400，不挂连接
    server.on('clientError', (_err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        /* ignore */
      }
    })

    // 手机端是 http://<LAN-IP>（非安全上下文），浏览器没有 crypto.randomUUID；
    // 对 HTML 响应注入兼容垫片（用 getRandomValues 实现），让手机端等同一个完整浏览器。
    const RANDOM_UUID_SHIM = `<script>(function(){try{if(self.crypto&&typeof self.crypto.randomUUID!=='function'){var g=self.crypto.getRandomValues.bind(self.crypto);self.crypto.randomUUID=function(){var b=new Uint8Array(16);g(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h='';for(var i=0;i<16;i++){if(i===4||i===6||i===8||i===10)h+='-';var v=b[i].toString(16);if(v.length<2)v='0'+v;h+=v;}return h;};}}catch(e){}})();</script>`

    // HTTP 直通（HTML 响应缓冲后注入垫片；其余流式直通）
    server.on('request', (req, res) => {
      req.on('error', () => {})
      res.on('error', () => {})
      void (async () => {
        try {
          const ip = clientIpOf(req.socket)
          log('info', `lanProxy: ${req.method} ${req.url} from ${ip}`)
          if (!sameOriginOk(req.headers)) {
            log('error', `lanProxy: blocked cross-origin request ${req.method} ${req.url} (origin=${String(req.headers.origin ?? req.headers.referer ?? '')})`)
            deny(res)
            return
          }
          if (!(await gate(ip))) {
            deny(res)
            return
          }
          const proxyReq = httpRequest({
            host: opts.targetHost,
            port: opts.targetPort,
            method: req.method,
            path: forwardPath(req),
            headers: forwardHeaders(req) as import('node:http').OutgoingHttpHeaders,
          })
          // 客户端在响应完成前断开 → 立即销毁上游，避免连接泄漏/残留
          res.on('close', () => {
            if (!res.writableEnded) {
              try {
                proxyReq.destroy()
              } catch {
                /* ignore */
              }
            }
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
            const isHtml = /text\/html/i.test(String(upRes.headers['content-type'] ?? ''))
            // 上游若仍压缩（无视我们剔除了 accept-encoding）：明文垫片注入会破坏响应体，
            // 此时按流式直通转发（垫片缺失不影响页面主体）
            const enc = String(upRes.headers['content-encoding'] ?? '').trim().toLowerCase()
            const compressed = enc !== '' && enc !== 'identity'
            if (!isHtml || compressed) {
              upRes.on('error', () => {})
              res.writeHead(upRes.statusCode ?? 502, upRes.headers)
              upRes.pipe(res)
              return
            }
            // 缓冲 HTML 主体 → 注入垫片 → 返回（content-length 失效，按 chunked 发送）
            const chunks: Buffer[] = []
            upRes.on('data', (c: Buffer) => chunks.push(c))
            upRes.on('end', () => {
              const headers: import('node:http').OutgoingHttpHeaders = { ...upRes.headers }
              delete headers['content-length']
              if (!res.headersSent) res.writeHead(upRes.statusCode ?? 200, headers)
              let html = Buffer.concat(chunks).toString('utf8')
              if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + RANDOM_UUID_SHIM)
              else html = RANDOM_UUID_SHIM + html
              res.end(html)
            })
            upRes.on('error', (err) => {
              log('error', `lanProxy: html buffering error: ${err instanceof Error ? err.message : String(err)}`)
              if (!res.headersSent) {
                res.statusCode = 502
                res.end('harness 不可达')
              } else {
                res.destroy()
              }
            })
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
    // WS socket 中途断线（ECONNRESET）同样要有 error 处理器，否则会炸主进程
    socket.on('error', () => {})
    void (async () => {
      try {
        const ip = clientIpOf(socket)
        log('info', `lanProxy: upgrade ${req.url} from ${ip}`)
        if (!sameOriginOk(req.headers)) {
          log('error', `lanProxy: blocked cross-origin upgrade ${String(req.url)} (origin=${String(req.headers.origin ?? req.headers.referer ?? '')})`)
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        if (!(await gate(ip))) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        const proxyReq = httpRequest({
          host: opts.targetHost,
          port: opts.targetPort,
          method: req.method ?? 'GET',
          path: forwardPath(req),
          headers: forwardHeaders(req) as import('node:http').OutgoingHttpHeaders,
        })
        proxyReq.on('error', (err) => {
          log('error', `lanProxy: upgrade error: ${err.message}`)
          socket.destroy()
        })
        proxyReq.on('upgrade', (upRes, upSock, upHead) => {
          upSock.on('error', () => {})
          // 任一端关闭时销毁另一端，避免半开连接泄漏
          socket.on('close', () => {
            try {
              upSock.destroy()
            } catch {
              /* ignore */
            }
          })
          upSock.on('close', () => {
            try {
              socket.destroy()
            } catch {
              /* ignore */
            }
          })
          // 101 必须原样转发上游响应头（含 Sec-WebSocket-Accept 等握手必需头），
          // 否则浏览器/客户端校验失败 → 局域网下所有流式与事件通道不可用
          if (!writeRawResponseHead(socket, upRes)) {
            try {
              upSock.destroy()
            } catch {
              /* ignore */
            }
            return
          }
          // upHead 是上游 101 之后紧跟的首帧（服务端 → 客户端方向），必须写给客户端
          if (upHead && upHead.length > 0) {
            try {
              socket.write(upHead)
            } catch {
              /* ignore */
            }
          }
          upSock.pipe(socket)
          socket.pipe(upSock)
        })
        // 上游拒绝升级（返回普通 HTTP 响应）：转发响应后关闭，避免客户端悬挂到超时
        proxyReq.on('response', (upRes) => {
          upRes.on('error', () => {})
          if (!writeRawResponseHead(socket, upRes)) {
            try {
              socket.destroy()
            } catch {
              /* ignore */
            }
            return
          }
          upRes.pipe(socket)
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

  // 固定端口优先（手机链接稳定）；被占用时回退 OS 随机端口
  let settled = false
  const tryListen = (port: number): void => {
    if (settled) return
    const srv = server
    srv.once('error', (err: NodeJS.ErrnoException) => {
      if (!settled && err.code === 'EADDRINUSE') {
        log('info', `lanProxy: 端口 ${port} 被占用，回退随机端口`)
        tryListen(0)
      } else {
        reject(err)
      }
    })
    srv.listen(port, '0.0.0.0', () => {
      settled = true
      const addr = srv.address()
      const actual = typeof addr === 'object' && addr !== null ? (addr as { port: number }).port : 0
      log('info', `lanProxy: 监听 0.0.0.0:${actual}`)
      resolve({
        port: actual,
        stop: async () => {
          for (const s of sockets) {
            try {
              s.destroy()
            } catch {
              /* ignore */
            }
          }
          await new Promise<void>((res2) => {
            srv.close(() => res2())
            // 无活动连接时 close 回调可能不触发，兜底
            setTimeout(res2, 500)
          })
        },
      })
    })
  }
  tryListen(opts.port ?? DSH_LAN_PORT) // 传 0 → 直接随机
  })
}

