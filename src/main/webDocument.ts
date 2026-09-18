/**
 * 本地 Web 文档与「已认证 Host」转发（移植自官方
 * `deepseek-ai/deepseek-harness` `apps/desktop/src/web-document.ts`，MIT）。
 *
 * 官方桌面端的传输形状：
 *  - 窗口从特权方案 `dsh-app://app/` 加载 **本地 dist**（index 里注入一段
 *    `__DSH_BOOT_READY__` 等待器；preload 拿到 Host 的启动注入后再放行客户端）；
 *  - 其它一切（`/api`、WebSocket 流）由主进程带 **Host 签发的 cookie** 转发到
 *    `127.0.0.1:19387` 上的已认证 Web Host。
 *
 * 与官方的差异只有一处：`forwardWebRequest` 多一个 `allowForeignOrigin` 开关，
 * 供**局域网/浏览器版**门面使用（那条路径的请求来自其它设备，Origin 不是
 * `dsh-app://app`，但已经过本壳自己的设备授权 + token 门禁）。
 */
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

/** 入口文档里的等待器：preload 拿到注入后才 resolve，客户端据此启动。 */
const BOOT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/**
 * Serve one application-owned static asset.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  const directory = resolve(root)
  const target = resolve(directory, '.' + (pathname === '/' ? '/index.html' : pathname))
  if (target !== directory && !target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try {
    body = await readFile(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  const content = pathname === '/' || pathname === '/index.html'
    ? body.toString().replace('<head>', `<head>${BOOT}`)
    : new Uint8Array(body)
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Exchange the Host launch URL for an authority-bound browser cookie.
 * @param url - Authenticated URL reported by the owned Host process.
 * @returns Cookie header for requests forwarded to that Host.
 */
export async function authenticateWebHost(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) {
    throw new Error(`Desktop Host authentication failed (HTTP ${String(response.status)})`)
  }
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/**
 * Forward local application requests to its authenticated Host.
 * @param request - Request from the application origin.
 * @param host - Owned Host URL.
 * @param cookie - Host-issued authentication cookie.
 * @param allowForeignOrigin - Accept requests that do not carry the application origin
 *   (the LAN/browser facade, which has its own device gate).
 * @returns Host response without network-only encoding headers.
 */
export async function forwardWebRequest(
  request: Request,
  host: string,
  cookie: string,
  allowForeignOrigin = false,
): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (!allowForeignOrigin && origin !== null && origin !== 'dsh-app://app') {
    return new Response(null, { status: 403 })
  }
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site', 'content-length']) headers.delete(name)
  headers.set('cookie', cookie)
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    signal: request.signal,
    redirect: 'manual',
    ...(request.body === null ? {} : { body: request.body, duplex: 'half' }),
  }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of ['content-encoding', 'content-length', 'set-cookie']) outgoing.delete(name)
  return new Response(response.body, { status: response.status, headers: outgoing })
}
