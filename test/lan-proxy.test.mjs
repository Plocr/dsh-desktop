import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createLanProxy, clientIpOf } from '../src/main/lanServer.ts'

function startFakeHarness(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
  })
}

/**
 * 原始 http.request（fetch/undici 不允许自定义 Host 头，无法模拟手机侧的
 * 局域网 Host/Origin 组合）。
 */
function rawRequest(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        text += c
      })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

const APPROVE = async () => true

test('lanProxy: 首次访问授权后放行，白名单免重复授权', async () => {
  const harness = await startFakeHarness((req, res) => {
    res.setHeader('content-type', 'text/plain')
    res.end('harness-ok')
  })
  let approvals = 0
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: harness.port,
    port: 0,
    requestApproval: async () => {
      approvals += 1
      return true
    },
  })
  try {
    const r1 = await fetch(`http://127.0.0.1:${proxy.port}/a`)
    assert.equal(r1.status, 200)
    assert.equal(await r1.text(), 'harness-ok')
    const r2 = await fetch(`http://127.0.0.1:${proxy.port}/b`)
    assert.equal(r2.status, 200)
    // 同一个 IP 只授权一次
    assert.equal(approvals, 1)
  } finally {
    await proxy.stop()
    await new Promise((r) => harness.server.close(r))
  }
})

test('lanProxy: 拒绝授权 → 403，且不放行', async () => {
  const harness = await startFakeHarness((req, res) => res.end('harness-ok'))
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: harness.port,
    port: 0,
    requestApproval: async () => false,
  })
  try {
    const r1 = await fetch(`http://127.0.0.1:${proxy.port}/`)
    assert.equal(r1.status, 403)
    const r2 = await fetch(`http://127.0.0.1:${proxy.port}/`)
    assert.equal(r2.status, 403)
  } finally {
    await proxy.stop()
    await new Promise((r) => harness.server.close(r))
  }
})

test('lanProxy: 目标不可达 → 502', async () => {
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: 1, // 没有服务
    port: 0,
    requestApproval: APPROVE,
  })
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 6_000)
    const r = await fetch(`http://127.0.0.1:${proxy.port}/`, { signal: ctrl.signal }).catch((e) => e)
    clearTimeout(t)
    // Node fetch 可能抛 ECONNREFUSED（上游在建立连接时报错）→ 允许 502 或抛错都在预期内
    if (r instanceof Error) assert.ok(/ECONNREFUSED|fetch failed|abort/i.test(r.message))
    else assert.equal(r.status, 502)
  } finally {
    await proxy.stop()
  }
})

test('lanProxy: 授权并发去重与 approve 一次性', async () => {
  const harness = await startFakeHarness((req, res) => res.end('ok'))
  let approvals = 0
  let release = null
  const gate = new Promise((r) => { release = r })
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: harness.port,
    port: 0,
    requestApproval: async () => {
      approvals += 1
      await gate
      return true
    },
  })
  try {
    const p1 = fetch(`http://127.0.0.1:${proxy.port}/1`).then((r) => r.status)
    const p2 = fetch(`http://127.0.0.1:${proxy.port}/2`).then((r2) => r2.status)
    // 同一 IP 的第一个请求正在授权（挂起），第二个应等待而不是叠加授权
    await new Promise((r) => setTimeout(r, 150))
    release(true)
    const [s1, s2] = await Promise.all([p1, p2])
    assert.equal(s1, 200)
    assert.equal(s2, 200)
    assert.equal(approvals, 1)
  } finally {
    await proxy.stop()
    await new Promise((r) => harness.server.close(r))
  }
})

test('lanProxy: HTML 响应注入 crypto.randomUUID 垫片（手机非安全上下文）', async () => {
  const harness = await startFakeHarness((req, res) => {
    if (req.url === '/html') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<html><head><title>x</title></head><body>hi</body></html>')
    } else {
      res.setHeader('content-type', 'application/javascript')
      res.end('export const a = 1')
    }
  })
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: harness.port,
    port: 0,
    requestApproval: APPROVE,
  })
  try {
    const r = await fetch(`http://127.0.0.1:${proxy.port}/html`)
    const body = await r.text()
    assert.equal(r.status, 200)
    assert.match(body, /randomUUID/)
    assert.match(body, /<head>/)
    const js = await (await fetch(`http://127.0.0.1:${proxy.port}/a.js`)).text()
    assert.ok(!js.includes('randomUUID'))
    assert.match(js, /export const a = 1/)
  } finally {
    await proxy.stop()
    await new Promise((r) => harness.server.close(r))
  }
})

test('lanProxy: 固定端口（占用则回退随机）', async () => {
  const harness = await startFakeHarness((req, res) => res.end('ok'))
  const fixed = 49301
  const p1 = await createLanProxy({ targetHost: '127.0.0.1', targetPort: harness.port, port: fixed, requestApproval: APPROVE })
  try {
    assert.equal(p1.port, fixed)
    // 占用同一固定端口 → 回退随机（≠fixed）
    const p2 = await createLanProxy({ targetHost: '127.0.0.1', targetPort: harness.port, port: fixed, requestApproval: APPROVE })
    try {
      assert.ok(p2.port !== fixed)
    } finally {
      await p2.stop()
    }
  } finally {
    await p1.stop()
    await new Promise((r) => harness.server.close(r))
  }
})

test('lanProxy: /api/host.* 转发 Host+Origin 改回环（解锁原生能力）', async () => {
  let seenHost = ''
  let seenOrigin = ''
  const harness = await startFakeHarness((req, res) => {
    if (req.url.startsWith('/api/host.')) {
      seenHost = String(req.headers.host ?? '')
      seenOrigin = String(req.headers.origin ?? '')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, value: { path: null } }))
    } else {
      seenHost = String(req.headers.host ?? '')
      seenOrigin = String(req.headers.origin ?? '')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    }
  })
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: harness.port,
    port: 0,
    requestApproval: APPROVE,
  })
  try {
    // 手机侧以局域网 Host/Origin 访问（同源 → 放行）
    const r = await rawRequest(proxy.port, '/api/host.pickDirectory', {
      method: 'POST',
      headers: {
        host: `192.168.30.41:${proxy.port}`,
        origin: `http://192.168.30.41:${proxy.port}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength('{}'),
      },
      body: '{}',
    })
    assert.equal(r.status, 200)
    assert.equal(seenHost, `127.0.0.1:${harness.port}`, 'host.* 的 Host 应改回环')
    assert.equal(seenOrigin, `http://127.0.0.1:${harness.port}`, 'host.* 的 Origin 应改回环')
  } finally {
    await proxy.stop()
    await new Promise((r) => harness.server.close(r))
  }
})

test('lanProxy: 跨站 Origin 被拒（CSRF 防护），同源放行', async () => {
  let forwarded = 0
  const harness = await startFakeHarness((req, res) => {
    forwarded += 1
    res.end('harness-ok')
  })
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: harness.port,
    port: 0,
    requestApproval: APPROVE,
  })
  try {
    // 本机/局域网内恶意网页：Origin 指向外部站点 → 403 且不转发
    const bad = await rawRequest(proxy.port, '/api/workspace.list', {
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(bad.status, 403)
    assert.equal(forwarded, 0, '跨站请求不得转发到 harness')

    // 带 Referer 但非外部站点 → 同样拒绝
    const badRef = await rawRequest(proxy.port, '/api/workspace.list', {
      headers: { referer: 'https://evil.example/page' },
    })
    assert.equal(badRef.status, 403)
    assert.equal(forwarded, 0)

    // 无 Origin/Referer（curl 等非浏览器请求）→ 由 IP 授权把关，放行
    const plain = await rawRequest(proxy.port, '/api/workspace.list')
    assert.equal(plain.status, 200)
    assert.equal(forwarded, 1)

    // 同源（Host 与 Origin 一致）→ 放行
    const good = await rawRequest(proxy.port, '/api/workspace.list', {
      headers: { host: `127.0.0.1:${proxy.port}`, origin: `http://127.0.0.1:${proxy.port}` },
    })
    assert.equal(good.status, 200)
    assert.equal(forwarded, 2)
  } finally {
    await proxy.stop()
    await new Promise((r) => harness.server.close(r))
  }
})

test('lanProxy: 无鉴权 cookie 时补一次 harness token（稳定 URL 换 cookie，不产生 303 循环）', async () => {
  const seen = []
  const harness = await startFakeHarness((req, res) => {
    seen.push(req.url)
    res.setHeader('content-type', 'text/plain')
    res.end('ok')
  })
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: harness.port,
    port: 0,
    requestApproval: APPROVE,
    webToken: 'tok-123',
  })
  try {
    // ① 外部设备首次访问（无 cookie）→ 代理补 token（harness 据此换 HttpOnly cookie）
    await rawRequest(proxy.port, '/')
    assert.equal(seen.at(-1), '/?token=tok-123')
    // ② 已持有鉴权 cookie → 不再补 token（harness 见到 token 就会 303，会与代理形成死循环）
    await rawRequest(proxy.port, '/', { headers: { cookie: 'dsh-auth-abc=xyz' } })
    assert.equal(seen.at(-1), '/')
    // ③ URL 已带 token → 不重复追加
    await rawRequest(proxy.port, '/?token=other')
    assert.equal(seen.at(-1), '/?token=other')
    // ④ 带查询串 → 用 & 追加
    await rawRequest(proxy.port, '/index.html?x=1')
    assert.equal(seen.at(-1), '/index.html?x=1&token=tok-123')
  } finally {
    await proxy.stop()
    await new Promise((r) => harness.server.close(r))
  }
})

test('lanProxy: 未配置 webToken（旧版 harness 无 token 鉴权）时原样转发', async () => {
  const seen = []
  const harness = await startFakeHarness((req, res) => {
    seen.push(req.url)
    res.end('ok')
  })
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: harness.port,
    port: 0,
    requestApproval: APPROVE,
  })
  try {
    await rawRequest(proxy.port, '/')
    assert.equal(seen.at(-1), '/')
  } finally {
    await proxy.stop()
    await new Promise((r) => harness.server.close(r))
  }
})

test('lanProxy: 客户端中途断开不崩（ECONNRESET 兜底）', async () => {
  const harness = await startFakeHarness((req, res) => {
    if (req.url === '/ok') {
      res.end('ok')
      return
    }
    // /hold 挂起，客户端断开后触发 ECONNRESET
    const hold = setTimeout(() => {
      try {
        res.end('late')
      } catch {
        /* ignored */
      }
    }, 1200)
    res.on('close', () => clearTimeout(hold))
  })
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: harness.port,
    port: 0,
    requestApproval: APPROVE,
  })
  try {
    const ctrl = new AbortController()
    const p = fetch(`http://127.0.0.1:${proxy.port}/hold`, { signal: ctrl.signal }).catch(() => 'aborted')
    await new Promise((r) => setTimeout(r, 40))
    ctrl.abort() // 客户端主动断开 → 上游吞掉 ECONNRESET，不崩
    await p
    // 断开后再发新请求，代理必须仍可用
    await new Promise((r) => setTimeout(r, 150))
    const ok = await fetch(`http://127.0.0.1:${proxy.port}/ok`)
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), 'ok')
  } finally {
    await proxy.stop()
    await new Promise((r) => harness.server.close(r))
  }
})

test('lanProxy: clientIpOf 归一化 IPv4-mapped', () => {
  assert.equal(clientIpOf({ remoteAddress: '::ffff:192.168.1.5' }), '192.168.1.5')
  assert.equal(clientIpOf({ remoteAddress: '127.0.0.1' }), '127.0.0.1')
  assert.equal(clientIpOf(null), '')
  assert.equal(clientIpOf({}), '')
})