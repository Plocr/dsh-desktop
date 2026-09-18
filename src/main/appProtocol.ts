/**
 * dsh-app:// 特权方案 —— 桌面壳的应用面入口（官方桌面端形态）。
 *
 * 渲染层只看得到两个同源地址：
 *  - `dsh-app://shell/<file>`  壳自带页面（loading/error），只读 resources/shell-pages
 *  - `dsh-app://app/<path>`    工作台：
 *      · 入口文档与静态资源从**随包 dist** 直接读（官方 `serveWebDocument`，入口注入
 *        `__DSH_BOOT_READY__` 等待器）；
 *      · 其余请求（`/api`、插件 client bundle、WebSocket 流之外的 HTTP）带 Host 签发的
 *        cookie 转发到已认证的 Host（`forwardWebRequest`）。
 *
 * 与官方完全一致：Host 是真正的 Web 应用（127.0.0.1:19387），Electron 只做本地窗口与转发。
 * 登录凭据（cookie）只存在于主进程，渲染层拿不到。
 */
import { protocol, type Session } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import path from 'node:path'
import { log } from './logger'
import { serveWebDocument } from './webDocument.ts'

export const APP_SCHEME = 'dsh-app'
/** 壳页面 origin（loading/error 等壳自带文档）。 */
export const SHELL_ORIGIN = `${APP_SCHEME}://shell`
/** 应用 origin（harness Web UI）。 */
export const APP_ORIGIN = `${APP_SCHEME}://app`
/** 工作台入口地址（窗口加载它）。 */
export const APP_ENTRY_URL = `${APP_ORIGIN}/`

/** 必须在 app ready 之前调用（Chromium 只接受 ready 前注册的特权方案）。 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // 同源内部传输，不需要跨源语义
        corsEnabled: false,
        stream: true,
        codeCache: true,
      },
    },
  ])
}

/* ── 壳页面（dsh-app://shell/…） ─────────────────────────────────────── */

/** 壳页面白名单：只服务这几个文件，从根上排除目录穿越。 */
const SHELL_FILES = new Set(['/loading.html', '/error.html'])

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function serveShellAsset(request: Request, url: URL, shellPagesDir: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 })
  }
  const rel = url.pathname === '/' ? '/loading.html' : url.pathname
  if (!SHELL_FILES.has(rel)) return new Response('not found', { status: 404 })
  const file = path.join(shellPagesDir, path.basename(rel))
  let size = 0
  try {
    const st = statSync(file)
    if (!st.isFile()) return new Response('not found', { status: 404 })
    size = st.size
  } catch {
    return new Response('not found', { status: 404 })
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  const headers = new Headers({
    'content-type': type,
    'content-length': String(size),
    // 壳页面随包装更新，绝不让 Chromium 缓存旧版本
    'cache-control': 'no-store',
  })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  const node = createReadStream(file)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      node.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 0) <= 0) node.pause()
      })
      node.on('end', () => {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
      node.on('error', (err) => {
        try {
          controller.error(err)
        } catch {
          /* already closed */
        }
      })
    },
    pull() {
      node.resume()
    },
    cancel() {
      node.destroy()
    },
  })
  return new Response(body, { status: 200, headers })
}

/* ── 安装 ──────────────────────────────────────────────────────────── */

/** 后端不可用（Host 未就绪/已退出）时的响应；与官方 Host 的 503 文案对齐。 */
function backendUnavailable(reason: string): Response {
  return new Response(JSON.stringify({ error: `backend unavailable: ${reason}` }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * 在窗口所用 session 上安装 dsh-app:// 处理器。
 * @param target 窗口所在分区的 session —— Electron 的 `protocol` 模块只作用于默认分区。
 * @param shellPagesDir 壳页面目录（asar 内 resources/shell-pages）。
 * @param webDistDir 随包 Web 前端 dist（`@deepseek-ai/dsh-web-frontend/dist`）。
 * @param forward 其余工作台请求的转发目标（已认证 Host，带 cookie）。
 */
export function installAppProtocol(
  target: Session,
  shellPagesDir: string,
  webDistDir: string,
  forward: (request: Request) => Promise<Response>,
): void {
  target.protocol.handle(APP_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (url.hostname === 'shell') return serveShellAsset(request, url, shellPagesDir)
    if (url.hostname !== 'app') return new Response('not found', { status: 404 })
    // 官方桌面端：入口文档与静态资源从本地 dist 读（含 __DSH_BOOT_READY__ 注入），
    // 其余请求才转发给 Host。这样加载页 → 工作台的切换不等网络，也少一次 cookie 转发。
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')
      || url.pathname === '/favicon.svg' || url.pathname === '/manifest.webmanifest') {
      return serveWebDocument(request, webDistDir)
    }
    try {
      return await forward(request)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Host 未就绪是正常时序（加载页期间窗口不会请求工作台），只有异常才记日志
      if (!/not running|stopped|unavailable/i.test(message)) {
        log('error', `app-protocol: ${request.method} ${url.pathname} 失败: ${message}`)
      }
      return backendUnavailable(message)
    }
  })
}
