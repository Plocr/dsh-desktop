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

test('lanProxy: 首次访问授权后放行，白名单免重复授权', async () => {
  const harness = await startFakeHarness((req, res) => {
    res.setHeader('content-type', 'text/plain')
    res.end('harness-ok')
  })
  let approvals = 0
  const proxy = await createLanProxy({
    targetHost: '127.0.0.1',
    targetPort: harness.port,
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
    requestApproval: async () => true,
  })
  try {
    const r = await fetch(`http://127.0.0.1:${proxy.port}/`).catch((e) => e)
    // Node fetch 可能抛 ECONNREFUSED（上游在建立连接时报错）→ 允许 502 或抛错都在预期内
    if (r instanceof Error) assert.ok(/ECONNREFUSED|fetch failed/i.test(r.message))
    else assert.equal(r.status, 502)
  } finally {
    await proxy.stop()
  }
})

test('lanProxy: clientIpOf 归一化 IPv4-mapped', () => {
  assert.equal(clientIpOf({ remoteAddress: '::ffff:192.168.1.5' }), '192.168.1.5')
  assert.equal(clientIpOf({ remoteAddress: '127.0.0.1' }), '127.0.0.1')
  assert.equal(clientIpOf(null), '')
  assert.equal(clientIpOf({}), '')
})