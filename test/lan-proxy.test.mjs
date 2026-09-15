import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { clientIpOf, createLanProxy, isLoopbackSource } from '../src/main/lanServer.ts'

/**
 * 对外门面（局域网 / 本机浏览器版）契约测试。
 *
 * 官方桌面架构下后端没有监听端口：请求不是「转发到 127.0.0.1:<port>」，而是直接喂给
 * Host 的管道 fetch（本测试用假 forward 代替 Host）。因此这里验证的是：
 * token 门禁、回环免授权、请求/响应（含流式体）如实透传、端口回退、停机。
 */
function rawRequest(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        text += c
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

/** 起一个假 Host：把收到的 Request 记录下来，返回给定响应。 */
async function startProxy(overrides = {}) {
  const seen = []
  const approvalCalls = []
  const handle = await createLanProxy({
    bindHost: '127.0.0.1',
    port: 0,
    forward: async (request) => {
      seen.push(request)
      return new Response(`echo:${new URL(request.url).pathname}:${request.method}`, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    },
    requestApproval: async (ip) => {
      approvalCalls.push(ip)
      return true
    },
    ...overrides,
  })
  return { handle, seen, approvalCalls }
}

test('clientIpOf：IPv4-mapped 与 IPv6 回环归一化', () => {
  assert.equal(clientIpOf({ remoteAddress: '::ffff:192.168.1.7' }), '192.168.1.7')
  assert.equal(clientIpOf({ remoteAddress: '::1' }), '127.0.0.1')
  assert.equal(clientIpOf(null), '')
})

test('isLoopbackSource：回环免授权，其它网段需要授权', () => {
  assert.equal(isLoopbackSource('127.0.0.1'), true)
  assert.equal(isLoopbackSource('127.5.6.7'), true)
  assert.equal(isLoopbackSource('192.168.1.7'), false)
  assert.equal(isLoopbackSource('10.0.0.2'), false)
})

test('无 token 时直通：请求如实交给 forward，响应如实回写', async () => {
  const { handle, seen, approvalCalls } = await startProxy()
  try {
    const r = await rawRequest(handle.port, '/api/ping?x=1')
    assert.equal(r.status, 200)
    assert.equal(r.text, 'echo:/api/ping:GET')
    assert.equal(seen.length, 1)
    assert.equal(new URL(seen[0].url).search, '?x=1')
    // 回环来源：绝不弹授权
    assert.deepEqual(approvalCalls, [])
  } finally {
    await handle.stop()
  }
})

test('请求体以流方式透传（POST 大 body 不被壳截断）', async () => {
  const payload = 'x'.repeat(200_000)
  let received = ''
  const { handle } = await startProxy({
    forward: async (request) => {
      received = await request.text()
      return new Response('ok')
    },
  })
  try {
    const r = await rawRequest(handle.port, '/api/upload', { method: 'POST', body: payload })
    assert.equal(r.status, 200)
    assert.equal(received.length, payload.length)
  } finally {
    await handle.stop()
  }
})

test('token 门禁：无 token/cookie → 401；?token= → 303 + HttpOnly cookie；随后放行', async () => {
  const { handle } = await startProxy({ token: 'secret-token' })
  try {
    const denied = await rawRequest(handle.port, '/')
    assert.equal(denied.status, 401)

    const exchange = await rawRequest(handle.port, '/?token=secret-token')
    assert.equal(exchange.status, 303)
    assert.equal(exchange.headers.location, '/')
    const cookie = exchange.headers['set-cookie']?.[0] ?? ''
    assert.match(cookie, /dsh-desk-access=secret-token/)
    assert.match(cookie, /HttpOnly/)

    const ok = await rawRequest(handle.port, '/', {
      headers: { cookie: cookie.split(';')[0] },
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.text, 'echo:/:GET')
  } finally {
    await handle.stop()
  }
})

test('token 门禁：错误 token 直接 401，不改 cookie', async () => {
  const { handle } = await startProxy({ token: 'right' })
  try {
    const r = await rawRequest(handle.port, '/?token=wrong')
    assert.equal(r.status, 401)
    assert.equal(r.headers['set-cookie'], undefined)
  } finally {
    await handle.stop()
  }
})

test('流式响应逐帧回写（NDJSON 远端流不被缓冲）', async () => {
  const { handle } = await startProxy({
    forward: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            controller.enqueue(enc.encode('{"type":"item","value":1}\n'))
            controller.enqueue(enc.encode('{"type":"end"}\n'))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'application/x-ndjson' } },
      ),
  })
  try {
    const r = await rawRequest(handle.port, '/.dsh/remote-stream', { method: 'POST', body: '{}' })
    assert.equal(r.status, 200)
    assert.equal(r.headers['content-type'], 'application/x-ndjson')
    assert.equal(r.text, '{"type":"item","value":1}\n{"type":"end"}\n')
  } finally {
    await handle.stop()
  }
})

test('forward 抛错 → 502（不泄露为未处理异常）', async () => {
  const { handle } = await startProxy({
    forward: async () => {
      throw new Error('host is not running')
    },
  })
  try {
    const r = await rawRequest(handle.port, '/api/x')
    assert.equal(r.status, 502)
    assert.match(r.text, /host is not running/)
  } finally {
    await handle.stop()
  }
})

test('固定端口被占用 → 回退随机端口（手机书签场景仍可用）', async () => {
  const blocker = createServer(() => undefined)
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busy = blocker.address().port
  const { handle } = await startProxy({ bindHost: '127.0.0.1', port: busy })
  try {
    assert.notEqual(handle.port, busy)
    const r = await rawRequest(handle.port, '/')
    assert.equal(r.status, 200)
  } finally {
    await handle.stop()
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('stop() 关闭监听（对外立刻不可达）', async () => {
  const { handle } = await startProxy()
  const port = handle.port
  await handle.stop()
  await assert.rejects(() => rawRequest(port, '/'))
})
