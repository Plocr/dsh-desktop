/**
 * QR 码编码器（纯逻辑，无 Electron 依赖，可单测）：托盘「手机连接」把局域网地址
 * 渲染成二维码，手机扫码即打开该地址（自动带 ?token=… 换 cookie 并跳到工作台）。
 *
 * 范围与取舍：
 *  - 只实现**字节模式**（URL 是 ASCII，无需数字/字母数字模式的省位优化）；
 *  - 纠错等级固定 **M**（屏幕 → 摄像头这一场景的常规选择；L 更省容量但容错差，
 *    Q/H 会让本机 URL 直接跳到更高版本、模块更小更难扫）；
 *  - 版本 1–10（字节容量 16–216 字节，等级 M）：本壳的地址形如
 *    `http://192.168.1.123:46123/?token=<32 hex>` ≈ 60–70 字节，落在版本 5–6，
 *    余量足够；超出容量时 `encodeQr` 抛错而不是产出一张扫不出来的图。
 *
 * 实现沿用 ISO/IEC 18004 的标准步骤：数据码字 → RS 纠错与交织 → 功能图形 →
 * 之字形布点 → 8 种掩码里取惩罚分最低者 → 写入格式信息（版本 ≥ 7 还有版本信息）。
 * 正确性由 test/qr.test.mjs 用**独立解码器**（jsqr，仅 devDependency）回读校验。
 */

/** 生成多项式/格式信息用的伽罗华域 GF(256)，本原多项式 0x11d。 */
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if ((x & 0x100) !== 0) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}

/**
 * 各版本的 RS 分块表（纠错等级 M）：`[每块纠错码字, 组1块数, 组1数据码字, 组2块数, 组2数据码字]`。
 * 组2 的数据码字总比组1 多 1（ISO/IEC 18004 表 13–22 的等级 M 行）。
 */
const RS_BLOCKS: Readonly<Record<number, readonly [number, number, number, number, number]>> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
}

/** 各版本的纠错码字总数（= 每块纠错码字 × 块数），用于交织后的完整性断言。 */
const TOTAL_CODEWORDS: Readonly<Record<number, number>> = {
  1: 26,
  2: 44,
  3: 70,
  4: 100,
  5: 134,
  6: 172,
  7: 196,
  8: 242,
  9: 292,
  10: 346,
}

/** 校正图形中心坐标（ISO/IEC 18004 附录 E）。 */
const ALIGNMENT_CENTERS: Readonly<Record<number, readonly number[]>> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
}

/** 支持的版本上限（字节模式 + 等级 M 下容量 216 字节）。 */
export const MAX_QR_VERSION = 10

/** 纠错等级 M 在格式信息里的 2 位编码（L=01 / M=00 / Q=11 / H=10）。 */
const EC_LEVEL_M_BITS = 0b00

export interface QrCode {
  /** 版本号（1–10）。 */
  readonly version: number
  /** 边长（模块数，= 版本 × 4 + 17）。 */
  readonly size: number
  /** `modules[row][col]`；true = 深色（黑）模块。 */
  readonly modules: readonly (readonly boolean[])[]
}

/** GF(256) 乘法。 */
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255]
}

/** 生成多项式：∏(x + α^i)，降幂存储，长度 = degree + 1，首项恒为 1。 */
function rsGenerator(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j] // × x
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]) // × α^i
    }
    poly = next
  }
  return poly
}

/** 一个数据块的 RS 纠错码字（LFSR 多项式除法取余）。 */
function rsRemainder(data: readonly number[], degree: number): number[] {
  const gen = rsGenerator(degree)
  const rem = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.shift()
    rem.push(0)
    if (factor !== 0) {
      for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor)
    }
  }
  return rem
}

/** 版本 → 字节模式的字符计数位宽（版本 1–9 为 8 位，10 起为 16 位）。 */
function charCountBits(version: number): number {
  return version < 10 ? 8 : 16
}

/** 版本 → 数据码字总数（等级 M）。 */
function dataCodewordCount(version: number): number {
  const spec = RS_BLOCKS[version]
  if (spec === undefined) throw new Error(`qr: 不支持的版本 ${String(version)}`)
  return spec[1] * spec[2] + spec[3] * spec[4]
}

/** 版本 → 字节模式可容纳的数据字节数（模式 4 位 + 字符计数 + 数据）。 */
function byteCapacity(version: number): number {
  return Math.floor((dataCodewordCount(version) * 8 - 4 - charCountBits(version)) / 8)
}

/**
 * 按容量选最小版本。
 * @returns 版本号；放不进最大版本时返回 null。
 */
function pickVersion(byteLength: number): number | null {
  for (let version = 1; version <= MAX_QR_VERSION; version++) {
    const capacityBits = dataCodewordCount(version) * 8
    const neededBits = 4 + charCountBits(version) + byteLength * 8
    if (neededBits <= capacityBits) return version
  }
  return null
}

/** 生成数据码字（模式指示 → 字符计数 → 数据 → 终止符 → 字节对齐 → 填充码字）。 */
function buildDataCodewords(bytes: readonly number[], version: number): number[] {
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4) // 字节模式
  push(bytes.length, charCountBits(version))
  for (const byte of bytes) push(byte, 8)
  const capacity = dataCodewordCount(version) * 8
  // 终止符：最多 4 个 0，且不越过容量
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0)
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0)
  // 填充码字 0xEC / 0x11 交替
  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0)
    codewords.push(byte)
  }
  for (let pad = 0; codewords.length < dataCodewordCount(version); pad++) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11)
  }
  return codewords
}

/** 分块 → 逐块 RS 纠错 → 按标准交错（数据在前、纠错在后）。 */
function buildCodewords(data: readonly number[], version: number): number[] {
  const spec = RS_BLOCKS[version]
  if (spec === undefined) throw new Error(`qr: 不支持的版本 ${String(version)}`)
  const [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data] = spec
  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  let offset = 0
  for (const [blocks, perBlock] of [
    [group1Blocks, group1Data] as const,
    [group2Blocks, group2Data] as const,
  ]) {
    for (let i = 0; i < blocks; i++) {
      const block = data.slice(offset, offset + perBlock)
      offset += perBlock
      dataBlocks.push(block)
      ecBlocks.push(rsRemainder(block, ecPerBlock))
    }
  }
  const out: number[] = []
  const maxData = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i])
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i])
  }
  const expected = TOTAL_CODEWORDS[version]
  if (expected !== undefined && out.length !== expected) {
    throw new Error(`qr: 交织后码字数 ${String(out.length)} ≠ 预期 ${String(expected)}（版本 ${String(version)}）`)
  }
  return out
}

/** BCH(15,5) 格式信息：数据 5 位 → 15 位（含固定掩码 0x5412）。 */
function formatInfoBits(data: number): number {
  let d = data << 10
  const digit = (value: number): number => {
    let count = 0
    for (let v = value; v !== 0; v >>>= 1) count++
    return count
  }
  while (digit(d) - digit(0b10100110111) >= 0) d ^= 0b10100110111 << (digit(d) - digit(0b10100110111))
  return ((data << 10) | d) ^ 0b101010000010010
}

/** BCH(18,6) 版本信息（版本 ≥ 7 才写）。 */
function versionInfoBits(version: number): number {
  const digit = (value: number): number => {
    let count = 0
    for (let v = value; v !== 0; v >>>= 1) count++
    return count
  }
  let d = version << 12
  while (digit(d) - digit(0b1111100100101) >= 0) d ^= 0b1111100100101 << (digit(d) - digit(0b1111100100101))
  return (version << 12) | d
}

/** 掩码图案（ISO/IEC 18004 表 10；row = i，col = j）。 */
function maskAt(pattern: number, row: number, col: number): boolean {
  switch (pattern) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0
  }
}

/** 掩码惩罚分（四条规则；分数越低越好）。 */
function lostPoint(modules: readonly (readonly boolean[])[], size: number): number {
  let points = 0
  // 规则 1：同色相邻（3×3 邻域内同色数 > 5）
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const dark = modules[row][col]
      let same = 0
      for (let r = -1; r <= 1; r++) {
        for (let c = -1; c <= 1; c++) {
          if (r === 0 && c === 0) continue
          const rr = row + r
          const cc = col + c
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
          if (modules[rr][cc] === dark) same++
        }
      }
      if (same > 5) points += 3 + same - 5
    }
  }
  // 规则 2：2×2 同色块
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      let count = 0
      if (modules[row][col]) count++
      if (modules[row + 1][col]) count++
      if (modules[row][col + 1]) count++
      if (modules[row + 1][col + 1]) count++
      if (count === 0 || count === 4) points += 3
    }
  }
  // 规则 3：1:1:3:1:1 图形（横竖两向）
  const pattern = (cells: readonly boolean[]): boolean =>
    cells[0] && !cells[1] && cells[2] && cells[3] && cells[4] && !cells[5] && cells[6]
  for (let row = 0; row < size; row++) {
    for (let col = 0; col <= size - 7; col++) {
      const line = [0, 1, 2, 3, 4, 5, 6].map((i) => modules[row][col + i])
      if (pattern(line)) points += 40
    }
  }
  for (let col = 0; col < size; col++) {
    for (let row = 0; row <= size - 7; row++) {
      const line = [0, 1, 2, 3, 4, 5, 6].map((i) => modules[row + i][col])
      if (pattern(line)) points += 40
    }
  }
  // 规则 4：深色比例偏离 50%
  let dark = 0
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) if (modules[row][col]) dark++
  }
  const ratio = Math.abs((100 * dark) / (size * size) - 50) / 5
  points += ratio * 10
  return points
}

/** 按给定掩码渲染一版完整矩阵（功能图形 + 数据 + 格式/版本信息）。 */
function render(codewords: readonly number[], version: number, mask: number): boolean[][] {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (row: number, col: number, dark: boolean): void => {
    modules[row][col] = dark
    reserved[row][col] = true
  }

  // 定位图形 + 分隔符（三个角）
  const probe = (row: number, col: number): void => {
    for (let r = -1; r <= 7; r++) {
      if (row + r < 0 || row + r >= size) continue
      for (let c = -1; c <= 7; c++) {
        if (col + c < 0 || col + c >= size) continue
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        set(row + r, col + c, dark)
      }
    }
  }
  probe(0, 0)
  probe(size - 7, 0)
  probe(0, size - 7)

  // 校正图形
  const centers = ALIGNMENT_CENTERS[version] ?? []
  for (const row of centers) {
    for (const col of centers) {
      if (reserved[row][col]) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)
          set(row + r, col + c, dark)
        }
      }
    }
  }

  // 时序图形
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[i][6]) set(i, 6, i % 2 === 0)
    if (!reserved[6][i]) set(6, i, i % 2 === 0)
  }

  // 格式信息（纠错等级 + 掩码）与固定深色模块
  const bits = formatInfoBits((EC_LEVEL_M_BITS << 3) | mask)
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1
    if (i < 6) set(i, 8, dark)
    else if (i < 8) set(i + 1, 8, dark)
    else set(size - 15 + i, 8, dark)
    if (i < 8) set(8, size - i - 1, dark)
    else if (i < 9) set(8, 15 - i - 1 + 1, dark)
    else set(8, 15 - i - 1, dark)
  }
  set(size - 8, 8, true)

  // 版本信息（版本 ≥ 7）
  if (version >= 7) {
    const vbits = versionInfoBits(version)
    for (let i = 0; i < 18; i++) {
      const dark = ((vbits >> i) & 1) === 1
      set(Math.floor(i / 3), (i % 3) + size - 8 - 3, dark)
      set((i % 3) + size - 8 - 3, Math.floor(i / 3), dark)
    }
  }

  // 数据布点：右下角起之字形，按掩码翻转
  let bitIndex = 7
  let byteIndex = 0
  let row = size - 1
  let inc = -1
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const target = col - c
        if (reserved[row][target]) continue
        let dark = false
        if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1
        if (maskAt(mask, row, target)) dark = !dark
        modules[row][target] = dark
        bitIndex--
        if (bitIndex === -1) {
          byteIndex++
          bitIndex = 7
        }
      }
      row += inc
      if (row < 0 || row >= size) {
        row -= inc
        inc = -inc
        break
      }
    }
  }
  return modules
}

/**
 * 把文本编码成二维码。
 * @param text - 任意文本（按 UTF-8 编码为字节模式数据）。
 * @param options.mask - 指定掩码（0–7，主要给测试用）；缺省按惩罚分自动选最优。
 * @throws 文本超出支持容量（版本 > {@link MAX_QR_VERSION}）时抛错。
 */
export function encodeQr(text: string, options: { mask?: number } = {}): QrCode {
  if (typeof text !== 'string' || text === '') throw new Error('qr: 文本不能为空')
  const bytes = [...new TextEncoder().encode(text)]
  const version = pickVersion(bytes.length)
  if (version === null) {
    throw new Error(
      `qr: 文本过长（${String(bytes.length)} 字节；版本 ${String(MAX_QR_VERSION)} 等级 M 上限 ${String(byteCapacity(MAX_QR_VERSION))} 字节）`,
    )
  }
  const codewords = buildCodewords(buildDataCodewords(bytes, version), version)
  const fixed = options.mask
  if (fixed !== undefined) {
    if (!Number.isInteger(fixed) || fixed < 0 || fixed > 7) throw new Error(`qr: 非法掩码 ${String(fixed)}`)
    return { version, size: version * 4 + 17, modules: render(codewords, version, fixed) }
  }
  let best: boolean[][] | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    const modules = render(codewords, version, mask)
    const score = lostPoint(modules, version * 4 + 17)
    if (score < bestScore) {
      bestScore = score
      best = modules
    }
  }
  return { version, size: version * 4 + 17, modules: best as boolean[][] }
}

/** `encodeQr` 的不抛错版本：超出容量时返回 null（调用方给用户一句可读提示）。 */
export function tryEncodeQr(text: string, options: { mask?: number } = {}): QrCode | null {
  try {
    return encodeQr(text, options)
  } catch {
    return null
  }
}
