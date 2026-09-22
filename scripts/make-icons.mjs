/**
 * 生成应用图标（纯 JS，无外部依赖）：
 *  - resources/icons/icon.png   (256x256)
 *  - resources/icons/tray.png   (32x32)
 *  - resources/icons/tray@2x.png(64x64)
 *  - resources/icons/icon.ico   (16/32/48/256 多尺寸，PNG-in-ICO)
 *  - resources/installer/header.bmp (150x57)  NSIS 页头品牌条
 *  - resources/installer/sidebar.bmp(164x314) NSIS 欢迎/完成页品牌面板
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

/* ── NSIS 安装向导品牌图（24-bit BMP；NSIS 只认这一种形状） ───────────── */

/**
 * 24-bit 未压缩 BMP（bottom-up、BI_RGB）。
 * @param width - 像素宽
 * @param height - 像素高
 * @param rgb - 长度 width*height*3 的 RGB 缓冲（自上而下）
 * @returns BMP 文件字节
 */
function encodeBmp(width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixels = rowSize * height
  const out = Buffer.alloc(54 + pixels)
  out.write('BM', 0, 'ascii')
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(pixels, 34)
  out.writeInt32LE(2835, 38)
  out.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    let o = 54 + y * rowSize
    const srcY = height - 1 - y
    for (let x = 0; x < width; x++) {
      const i = (srcY * width + x) * 3
      out[o++] = rgb[i + 2]
      out[o++] = rgb[i + 1]
      out[o++] = rgb[i]
    }
  }
  return out
}

/** 读一次鲸鱼 path 多边形（品牌图与图标共用同一份矢量）。 */
let whalePolysCache
function whalePolys() {
  if (whalePolysCache === undefined) {
    const d = readFileSync(path.join(root, 'resources', 'shell-pages', 'whale-path.txt'), 'utf8').trim()
    whalePolysCache = parsePathToPolys(d)
  }
  return whalePolysCache
}

/**
 * 鲸鱼覆盖率图：每像素 3×3 超采样，供小尺寸下拿到平滑边缘。
 * @param width - 图宽
 * @param height - 图高
 * @param opts - 高度占比与中心点（0–1 相对坐标）
 * @returns 长度 width*height 的覆盖率（0–1）
 */
function whaleCoverage(width, height, opts = {}) {
  const scale = opts.scale ?? 0.6
  const cx = opts.cx ?? 0.5
  const cy = opts.cy ?? 0.5
  const polys = whalePolys()
  // 鲸鱼自己的包围盒才是「视觉中心」：path 的 viewBox（24×18）里右侧有留白，
  // 直接按 viewBox 居中会看起来偏左。这里按包围盒缩放 + 居中。
  let bbMinX = Infinity
  let bbMaxX = -Infinity
  let bbMinY = Infinity
  let bbMaxY = -Infinity
  for (const pts of polys) {
    for (const p of pts) {
      if (p.x < bbMinX) bbMinX = p.x
      if (p.x > bbMaxX) bbMaxX = p.x
      if (p.y < bbMinY) bbMinY = p.y
      if (p.y > bbMaxY) bbMaxY = p.y
    }
  }
  const k = (height * scale) / (bbMaxY - bbMinY) // viewBox 单位 → 像素
  const targetW = (bbMaxX - bbMinX) * k
  const ox = width * cx - targetW / 2 - bbMinX * k
  const oy = height * cy - (height * scale) / 2 - bbMinY * k
  // 目标矩形（+1px 余量）：只在这个范围内做绕数判定
  const minX = Math.max(0, Math.floor(ox + bbMinX * k) - 1)
  const maxX = Math.min(width - 1, Math.ceil(ox + bbMaxX * k) + 1)
  const minY = Math.max(0, Math.floor(oy + bbMinY * k) - 1)
  const maxY = Math.min(height - 1, Math.ceil(oy + bbMaxY * k) + 1)
  const coverage = new Float32Array(width * height)
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let hits = 0
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3
          const py = y + (sy + 0.5) / 3
          const wx = (px - ox) / k
          const wy = (py - oy) / k
          if (windingAt({ x: wx, y: wy }, polys) !== 0) hits += 1
        }
      }
      coverage[y * width + x] = hits / 9
    }
  }
  return coverage
}

/**
 * NSIS 品牌图：白/浅灰底 + 黑色鲸鱼 + 一条发丝分隔线。
 *  - `header`（150×57，MUI 页头右侧）：鲸鱼居中，底部发丝线；
 *  - `sidebar`（164×314，欢迎/完成页左侧）：浅灰渐变面板，鲸鱼偏上、下方发丝线。
 * @param width - 图宽
 * @param height - 图高
 * @param kind - 图类型
 * @returns RGB 缓冲（自上而下）
 */
function brandPanel(width, height, kind) {
  const rgb = new Uint8Array(width * height * 3)
  const ink = [15, 17, 21]
  const from = [255, 255, 255]
  const to = kind === 'sidebar' ? [236, 239, 243] : [255, 255, 255]
  for (let y = 0; y < height; y++) {
    const t = height <= 1 ? 0 : y / (height - 1)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      for (let c = 0; c < 3; c++) rgb[i + c] = Math.round(from[c] + (to[c] - from[c]) * t)
    }
  }
  const coverage = kind === 'sidebar'
    ? whaleCoverage(width, height, { scale: 0.3, cx: 0.5, cy: 0.42 })
    : whaleCoverage(width, height, { scale: 0.62, cx: 0.5, cy: 0.5 })
  for (let i = 0; i < coverage.length; i++) {
    const a = coverage[i]
    if (a <= 0) continue
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(rgb[i * 3 + c] * (1 - a) + ink[c] * a)
  }
  // 发丝线：只在 sidebar 上、鲸鱼正下方留一笔（页头自带下边框，不需要画）
  if (kind === 'sidebar') {
    const ruleY = Math.round(height * 0.58)
    for (let x = Math.round(width * 0.32); x <= Math.round(width * 0.68); x++) {
      const i = (ruleY * width + x) * 3
      rgb[i] = 214
      rgb[i + 1] = 219
      rgb[i + 2] = 226
    }
  }
  return rgb
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

/* ── ICNS 编码（macOS 图标容器：header + 每尺寸 PNG chunk） ─────────── */

function encodeIcns(entries) {
  // ICNS 头部：'icns' magic + 总长度（含 8 字节头）
  let total = 8
  const chunks = []
  for (const { type, data } of entries) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length + 8)
    chunks.push(Buffer.concat([Buffer.from(type, 'ascii'), len, data]))
    total += data.length + 8
  }
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(total, 4)
  return Buffer.concat([header, ...chunks])
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
// macOS：icns 需要 16/32/128/256/512/1024 的 PNG 内嵌（icp4/icp5/ic07/ic08/ic09）
const icnsSizes = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
]
const icnsEntries = icnsSizes.map(({ type, size }) => ({
  type,
  data: encodePng(size, size, render(size, 0.66)),
}))
writeFileSync(path.join(outDir, 'icon.icns'), encodeIcns(icnsEntries))
console.log(`[icons] generated ${outDir}`)

// NSIS 安装向导品牌图（electron-builder: nsis.installerHeader / installerSidebar /
// uninstallerSidebar）。150×57 与 164×314 是 MUI2 写死的尺寸，不能再大也不能再小。
const installerDir = path.join(root, 'resources', 'installer')
mkdirSync(installerDir, { recursive: true })
writeFileSync(path.join(installerDir, 'header.bmp'), encodeBmp(150, 57, brandPanel(150, 57, 'header')))
writeFileSync(path.join(installerDir, 'sidebar.bmp'), encodeBmp(164, 314, brandPanel(164, 314, 'sidebar')))
console.log(`[icons] generated ${installerDir} (NSIS header + sidebar BMP)`)
