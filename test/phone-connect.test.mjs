import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import jsQR from 'jsqr'
import { encodeQr } from '../src/main/qr.ts'
import { createLanProxy } from '../src/main/lanServer.ts'

/**
 * 「手机连接」全链路（不含 GUI）：主进程把手机地址编码成二维码 → 手机扫码拿到同一个地址 →
 * 首次访问用一次性 token 换 cookie → 带着 cookie 打开工作台。
 *
 * 这一段是用户在托盘里真实走的路：只要有任一环不通（二维码扫不出、门禁太严、cookie 不落地），
 * 手机就只会看到一个空白页，所以这里逐环断言（二维码用独立解码器回读）。
 */

function rawRequest(port, path, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** 把二维码矩阵栅格化后交给独立解码器（与 test/qr.test.mjs 相同的扫码条件）。 */
function scan(qr) {
  const scale = 4
  const quiet = 4
  const side = (qr.size + quiet * 2) * scale
  const pixels = new Uint8ClampedArray(side * side * 4)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const row = Math.floor(y / scale) - quiet
      const col = Math.floor(x / scale) - quiet
      const dark = row >= 0 && row < qr.size && col >= 0 && col < qr.size && qr.modules[row][col]
      const offset = (y * side + x) * 4
      const value = dark ? 0 : 255
      pixels[offset] = value
      pixels[offset + 1] = value
      pixels[offset + 2] = value
      pixels[offset + 3] = 255
    }
  }
  const result = jsQR(pixels, side, side)
  assert.ok(result !== null, '二维码扫不出来（手机端会看到空白页）')
  return result.data
}

test('手机连接：扫码得到的地址与门面发放的一致，换 cookie 后能打开工作台', async () => {
  const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  const handle = await createLanProxy({
    bindHost: '127.0.0.1',
    port: 0,
    token,
    // 假 Host：验证门面把请求原样喂给了后端（真实实现是 Host 的认证 Web 服务）
    forward: async (request) =>
      new Response(`<html>workspace ${new URL(request.url).pathname}</html>`, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
  })
  try {
    const url = `http://127.0.0.1:${handle.port}/?token=${token}`

    // 1) 二维码内容 = 手机要打开的地址
    const scanned = scan(encodeQr(url))
    assert.equal(scanned, url)

    // 2) 手机第一次打开（回环来源免设备授权）：token 换 cookie + 303 跳到干净路径
    const path = new URL(scanned).pathname + new URL(scanned).search
    const first = await rawRequest(handle.port, path)
    assert.equal(first.status, 303)
    assert.equal(first.headers.location, '/')
    const cookie = (first.headers['set-cookie'] ?? [])[0]
    assert.match(cookie, /^dsh-desk-access=/u)
    assert.match(cookie, /HttpOnly/u)

    // 3) 带着 cookie 访问工作台（手机浏览器后续请求走的就是这一条）
    const page = await rawRequest(handle.port, '/', { headers: { cookie: cookie.split(';')[0] } })
    assert.equal(page.status, 200)
    assert.match(page.text, /workspace \//u)

    // 4) 没有 cookie 的裸访问被挡（门禁不是摆设）
    const denied = await rawRequest(handle.port, '/')
    assert.equal(denied.status, 401)
  } finally {
    await handle.stop()
  }
})

test('手机连接：断开（stop）后地址立即失效', async () => {
  const token = 'ffffffffffffffffffffffffffffffff'
  const handle = await createLanProxy({
    bindHost: '127.0.0.1',
    port: 0,
    token,
    forward: async () => new Response('ok', { status: 200 }),
  })
  const url = `http://127.0.0.1:${handle.port}/?token=${token}`
  const ok = await rawRequest(handle.port, new URL(url).pathname + new URL(url).search)
  assert.equal(ok.status, 303)
  await handle.stop()
  // 停机后连接被拒/被重置都算「地址失效」（Windows 上常见 ECONNRESET）
  await assert.rejects(rawRequest(handle.port, '/'), /ECONNREFUSED|ECONNRESET/u)
})
