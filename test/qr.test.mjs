import { test } from 'node:test'
import assert from 'node:assert/strict'
import jsQR from 'jsqr'
import { MAX_QR_VERSION, encodeQr, tryEncodeQr } from '../src/main/qr.ts'

/**
 * 二维码编码器契约：**用独立解码器回读**（jsqr 只做 devDependency，不随包分发）。
 *
 * 只断言"我们自己觉得画对了"没有意义——扫不出来就是坏功能。这里把模块矩阵按
 * 真实的扫码条件栅格化成像素（含静默区），交给第三方解码器还原文本。
 */

/** 把模块矩阵栅格化成 RGBA 像素（4 模块/像素单元 + 4 模块静默区，与渲染页一致）。 */
function rasterize(qr, scale = 4, quiet = 4) {
  const side = (qr.size + quiet * 2) * scale
  const pixels = new Uint8ClampedArray(side * side * 4)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const col = Math.floor(x / scale) - quiet
      const row = Math.floor(y / scale) - quiet
      const inside = row >= 0 && row < qr.size && col >= 0 && col < qr.size
      const dark = inside && qr.modules[row][col]
      const value = dark ? 0 : 255
      const offset = (y * side + x) * 4
      pixels[offset] = value
      pixels[offset + 1] = value
      pixels[offset + 2] = value
      pixels[offset + 3] = 255
    }
  }
  return { pixels, side }
}

function decode(qr) {
  const { pixels, side } = rasterize(qr)
  const result = jsQR(pixels, side, side)
  assert.ok(result !== null, '解码器没能识别出二维码')
  return result.data
}

test('回读：典型局域网地址（手机连接二维码的内容形态）', () => {
  const url = 'http://192.168.1.123:46123/?token=5f3a9c1d27b4e86a0c4d9f21ab73e5c8'
  const qr = encodeQr(url)
  assert.equal(decode(qr), url)
  assert.equal(qr.size, qr.version * 4 + 17)
  assert.ok(qr.version <= 6, `常规地址不该用到大版本（实际 v${qr.version}）`)
})

test('回读：短文本与长文本（跨版本）', () => {
  for (const text of ['dsh', 'http://10.0.0.2:46123/?token=' + 'a'.repeat(32), 'x'.repeat(120), 'y'.repeat(180)]) {
    const qr = encodeQr(text)
    assert.equal(decode(qr), text, `回读失败：${text.slice(0, 24)}…`)
  }
})

test('回读：非 ASCII（UTF-8 字节模式）', () => {
  const text = '手机连接：http://192.168.31.7:46123/?token=abcDEF1234567890&note=工作台'
  const qr = encodeQr(text)
  assert.equal(decode(qr), text)
})

test('回读：全部 8 种掩码都能解出（掩码选择不是唯一正确路径）', () => {
  const text = 'http://172.16.5.9:46123/?token=0123456789abcdef0123456789abcdef'
  for (let mask = 0; mask < 8; mask++) {
    const qr = encodeQr(text, { mask })
    assert.equal(decode(qr), text, `掩码 ${mask} 回读失败`)
  }
})

test('每个版本/每个掩码都自洽（功能图形 + 尺寸）', () => {
  for (let mask = 0; mask < 8; mask++) {
    for (const length of [1, 20, 60, 120, 200]) {
      const qr = encodeQr('a'.repeat(length), { mask })
      assert.equal(qr.modules.length, qr.size)
      for (const row of qr.modules) assert.equal(row.length, qr.size)
      // 三个角的定位图形：7×7 的外框必须存在
      const corner = (row, col) =>
        qr.modules[row][col] &&
        qr.modules[row][col + 6] &&
        qr.modules[row + 6][col] &&
        qr.modules[row + 6][col + 6]
      assert.ok(corner(0, 0) && corner(0, qr.size - 7) && corner(qr.size - 7, 0))
    }
  }
})

test('容量边界：超出最大版本时不产出扫不出来的图', () => {
  assert.equal(tryEncodeQr('z'.repeat(213))?.version, MAX_QR_VERSION)
  assert.equal(tryEncodeQr('z'.repeat(214)), null)
  assert.throws(() => encodeQr('z'.repeat(400)), /文本过长/u)
  assert.throws(() => encodeQr(''), /不能为空/u)
  assert.throws(() => encodeQr('abc', { mask: 9 }), /非法掩码/u)
})
