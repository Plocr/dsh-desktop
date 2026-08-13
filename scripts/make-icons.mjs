/**
 * 生成应用图标（纯 JS，无外部依赖）：
 *  - resources/icons/icon.png   (256x256)
 *  - resources/icons/tray.png   (32x32)
 *  - resources/icons/tray@2x.png(64x64)
 *  - resources/icons/icon.ico   (16/32/48/256 多尺寸，PNG-in-ICO)
 * 图案：品牌蓝圆角方块 + 白色 "H"（Harness）。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/* ── PNG 编码 ────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x]
    }
  }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))])
}

/* ── 绘制 ────────────────────────────────────────────────────────────── */

const clamp01 = (v) => Math.min(1, Math.max(0, v))

/** 圆角矩形 SDF。 */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r)
  const qy = Math.abs(y - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

function render(size) {
  const SS = 4 // 超采样
  const S = size * SS
  const buf = new Float32Array(S * S * 4) // premultiplied alpha
  const cx = S / 2
  const cy = S / 2
  const hw = S * 0.46
  const hh = S * 0.46
  const r = S * 0.22
  const top = [0x4d, 0x7c, 0xff]
  const bottom = [0x35, 0x54, 0xd8]

  // 白色 "H" 条（圆角 SDF）
  const barR = S * 0.06
  const bars = [
    { x: S * 0.30, w: S * 0.10, y: S * 0.25, h: S * 0.50 }, // 左竖
    { x: S * 0.60, w: S * 0.10, y: S * 0.25, h: S * 0.50 }, // 右竖
    { x: S * 0.30, w: S * 0.40, y: S * 0.44, h: S * 0.12 }, // 横梁
  ]

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const x = px + 0.5
      const y = py + 0.5
      const d = sdRoundRect(x, y, cx, cy, hw, hh, r)
      const bgA = clamp01(0.5 - d)
      if (bgA <= 0) continue
      const t = (y / S) * 0.6 // 背景垂直渐变
      const bg = [top[0] + (bottom[0] - top[0]) * t, top[1] + (bottom[1] - top[1]) * t, top[2] + (bottom[2] - top[2]) * t]
      let glyphA = 0
      for (const b of bars) {
        const gd = sdRoundRect(x, y, b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, barR)
        glyphA = Math.max(glyphA, clamp01(0.5 - gd))
      }
      const i = (py * S + px) * 4
      // 混合：白条覆盖背景（完整预乘 alpha，供降采样后反预乘）
      const r_ = bg[0] * (1 - glyphA) + 255 * glyphA
      const g_ = bg[1] * (1 - glyphA) + 255 * glyphA
      const b_ = bg[2] * (1 - glyphA) + 255 * glyphA
      buf[i] = r_ * bgA * 255
      buf[i + 1] = g_ * bgA * 255
      buf[i + 2] = b_ * bgA * 255
      buf[i + 3] = bgA * 255
    }
  }

  // 盒式降采样（含 alpha 归一化）
  const out = new Uint8Array(size * size * 4)
  const step = SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < step; sy++) {
        for (let sx = 0; sx < step; sx++) {
          const i = ((y * step + sy) * S + (x * step + sx)) * 4
          r += buf[i]
          g += buf[i + 1]
          b += buf[i + 2]
          a += buf[i + 3]
        }
      }
      const n = step * step
      const o = (y * size + x) * 4
      const alpha = a / n // 平均 alpha（0..255）
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(alpha)
    }
  }
  return out
}

/* ── ICO ─────────────────────────────────────────────────────────────── */

function encodeIco(sizes, pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sizes.length, 4)
  const entries = []
  let offset = 6 + sizes.length * 16
  for (let i = 0; i < sizes.length; i++) {
    const e = Buffer.alloc(16)
    e[0] = sizes[i] >= 256 ? 0 : sizes[i]
    e[1] = sizes[i] >= 256 ? 0 : sizes[i]
    e[2] = 0 // colors
    e[3] = 0 // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bit count
    e.writeUInt32LE(pngs[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += pngs[i].length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs])
}

/* ── 输出 ────────────────────────────────────────────────────────────── */

const outDir = path.resolve('resources', 'icons')
mkdirSync(outDir, { recursive: true })

const sizes = [16, 32, 48, 256]
const pngs = sizes.map((s) => encodePng(s, s, render(s)))

writeFileSync(path.join(outDir, 'icon.png'), pngs[3]) // 256
writeFileSync(path.join(outDir, 'tray.png'), pngs[1]) // 32
writeFileSync(path.join(outDir, 'tray@2x.png'), encodePng(64, 64, render(64)))
writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(sizes, pngs))
console.log(`[icons] generated ${outDir}`)
