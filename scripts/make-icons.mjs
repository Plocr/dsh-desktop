/**
 * 生成应用图标（纯 JS，无外部依赖）：
 *  - resources/icons/icon.png   (256x256)
 *  - resources/icons/tray.png   (32x32)
 *  - resources/icons/tray@2x.png(64x64)
 *  - resources/icons/icon.ico   (16/32/48/256 多尺寸，PNG-in-ICO)
 * 设计：白底（与工作台一致）+ 黑色 DeepSeek 鲸鱼 logo（官网品牌 path，whale-path.txt）。
 * 鲸鱼光栅化：SVG path 解析（M/C/Z 绝对坐标）→ 三次贝塞尔采样 → 多边形
 * → nonzero 绕数 ray-casting 逐像素填充。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x]
  }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))])
}

/* ── SVG path 解析与光栅化 ───────────────────────────────────────────── */

/** 解析 M/C/Z 绝对坐标 path → 子路径多边形（贝塞尔采样 40 段）。 */
function parsePathToPolys(d) {
  const tokens = d.match(/[MCZ]|-?\d*\.?\d+(?:e[+-]?\d+)?/gi)
  if (!tokens) return []
  const polys = []
  let cur = null
  let i = 0
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    const cmd = tokens[i++].toUpperCase()
    if (cmd === 'M') {
      if (cur && cur.pts.length > 1) polys.push(cur.pts)
      cur = { pts: [{ x: num(), y: num() }] }
    } else if (cmd === 'C') {
      const c1x = num(), c1y = num(), c2x = num(), c2y = num(), x = num(), y = num()
      const p0 = cur.pts[cur.pts.length - 1]
      const N = 40
      for (let s = 1; s <= N; s++) {
        const t = s / N
        const mt = 1 - t
        cur.pts.push({
          x: mt * mt * mt * p0.x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x,
          y: mt * mt * mt * p0.y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y,
        })
      }
    } else if (cmd === 'Z') {
      if (cur && cur.pts.length > 1) polys.push(cur.pts)
      cur = null
    }
  }
  if (cur && cur.pts.length > 1) polys.push(cur.pts)
  return polys
}

/** nonzero 绕数：点是否在多边形组内。 */
function windingAt(p, polys) {
  let w = 0
  for (const pts of polys) {
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k]
      const b = pts[k + 1]
      if (a.y <= p.y) {
        if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++
      } else {
        if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--
      }
    }
  }
  return w
}

/**
 * 渲染图标：白底圆角方块 + 黑色鲸鱼。
 * @param size 输出边长
 * @param whaleScale 鲸鱼占图标高度的比例
 */
function render(size, whaleScale = 0.66) {
  const out = new Uint8Array(size * size * 4)
  const r = size * 0.2
  const hw = size / 2
  const border = Math.max(1, Math.round(size * 0.01))
  const bg = [255, 255, 255]
  const edge = [228, 231, 236]
  const ink = [15, 17, 21]

  const sdRound = (x, y, cx, cy, hw2, hh2, rr) => {
    const qx = Math.abs(x - cx) - (hw2 - rr)
    const qy = Math.abs(y - cy) - (hh2 - rr)
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr
  }

  const whalePath = readFileSync(path.join(root, 'resources', 'shell-pages', 'whale-path.txt'), 'utf8').trim()
  const polys = parsePathToPolys(whalePath)
  const VB_W = 24
  const VB_H = 18
  const targetH = size * whaleScale
  const targetW = targetH * (VB_W / VB_H)
  const ox = (size - targetW) / 2
  const oy = (size - targetH) / 2
  const toPx = (p) => ({ x: ox + (p.x / VB_W) * targetW, y: oy + (p.y / VB_H) * targetH })

  // 鲸鱼 bbox（裁剪遍历范围，加速）
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const pts of polys) {
    for (const p of pts) {
      const q = toPx(p)
      if (q.x < minX) minX = q.x
      if (q.x > maxX) maxX = q.x
      if (q.y < minY) minY = q.y
      if (q.y > maxY) maxY = q.y
    }
  }
  minX = Math.max(0, Math.floor(minX - 1))
  maxX = Math.min(size - 1, Math.ceil(maxX + 1))
  minY = Math.max(0, Math.floor(minY - 1))
  maxY = Math.min(size - 1, Math.ceil(maxY + 1))

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const o = (y * size + x) * 4
      const d = sdRound(px, py, size / 2, size / 2, hw - 0.5, hw - 0.5, r)
      if (d > 0.5) {
        out[o + 3] = 0
        continue
      }
      let col = bg
      if (d > 0.5 - border) col = edge
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        const wx = ((x + 0.5 - ox) / targetW) * VB_W
        const wy = ((y + 0.5 - oy) / targetH) * VB_H
        if (windingAt({ x: wx, y: wy }, polys) !== 0) col = ink
      }
      out[o] = col[0]
      out[o + 1] = col[1]
      out[o + 2] = col[2]
      out[o + 3] = 255
    }
  }
  return out
}

/* ── ICO ─────────────────────────────────────────────────────────────── */

function encodeIco(sizes, pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  const entries = []
  let offset = 6 + sizes.length * 16
  for (let i = 0; i < sizes.length; i++) {
    const e = Buffer.alloc(16)
    e[0] = sizes[i] >= 256 ? 0 : sizes[i]
    e[1] = sizes[i] >= 256 ? 0 : sizes[i]
    e[2] = 0
    e[3] = 0
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(pngs[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += pngs[i].length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs])
}

/* ── 输出 ────────────────────────────────────────────────────────────── */

const outDir = path.join(root, 'resources', 'icons')
mkdirSync(outDir, { recursive: true })

const sizes = [16, 32, 48, 256]
const pngs = sizes.map((s) => encodePng(s, s, render(s, s <= 32 ? 0.72 : 0.66)))

writeFileSync(path.join(outDir, 'icon.png'), pngs[3])
writeFileSync(path.join(outDir, 'tray.png'), pngs[1])
writeFileSync(path.join(outDir, 'tray@2x.png'), encodePng(64, 64, render(64, 0.7)))
writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(sizes, pngs))
console.log(`[icons] generated ${outDir}`)
