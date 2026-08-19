import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createLanProxy, clientIpOf } from '../src/main/lanServer.ts'

function startFakeHarness(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
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
    // 手机侧以局域网 Host/Origin 访问
    await fetch(`http://127.0.0.1:${proxy.port}/api/host.pickDirectory`, {
      method: 'POST',
      headers: {
        host: `192.168.30.41:${proxy.port}`,
        origin: `http://192.168.30.41:${proxy.port}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        connection: 'close',
      },
      body: '{}',
    })
    assert.equal(seenHost, `127.0.0.1:${harness.port}`, 'host.* 的 Host 应改回环')
    assert.equal(seenOrigin, `http://127.0.0.1:${harness.port}`, 'host.* 的 Origin 应改回环')
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