/**
 * 版本比较工具（纯逻辑，无 Electron 依赖，可单测）。
 * semver 风格：正确处理 -rc.X / -beta.X / -alpha.X 预发布段与 +build 元数据。
 */

/** 预发布标识排序权重：alpha < beta < rc < 其它字母标识。 */
function preRank(label: string): number {
  const s = label.toLowerCase()
  if (s === 'alpha') return -3
  if (s === 'beta') return -2
  if (s === 'rc') return -1
  return 0
}

/**
 * 单个预发布标识比较（semver 规则）：
 *  - 纯数字标识按数值比较，且**小于**字母数字标识
 *  - 字母数字标识：已知名按 alpha<beta<rc<其它 排序；同名带数字时按数字比（rc10 > rc9）
 */
function preCompare(a: string, b: string): number {
  const numA = /^\d+$/.test(a)
  const numB = /^\d+$/.test(b)
  if (numA && numB) return Number(a) - Number(b)
  if (numA !== numB) return numA ? -1 : 1
  const ma = /^([a-zA-Z]+)(\d*)$/.exec(a)
  const mb = /^([a-zA-Z]+)(\d*)$/.exec(b)
  if (ma && mb) {
    const ra = preRank(ma[1])
    const rb = preRank(mb[1])
    if (ra !== rb) return ra - rb
    const la = ma[1].toLowerCase()
    const lb = mb[1].toLowerCase()
    if (la !== lb) return la < lb ? -1 : 1
    const na = ma[2] ? Number(ma[2]) : 0
    const nb = mb[2] ? Number(mb[2]) : 0
    return na - nb
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 版本比较（semver 风格）：返回 <0 表示 a<b，>0 表示 a>b，0 相等。
 *  - 无预发布（0.2.0）> 有预发布（0.2.0-rc.1）
 *  - 忽略 +build 元数据（semver：build 不参与比较）
 *  - rc.10 > rc.9（数字按数值比）
 */
export function compareDots(a: string, b: string): number {
  const strip = (v: string): string => v.split('+')[0] ?? v
  const pa = strip(a).split(/[.-]/)
  const pb = strip(b).split(/[.-]/)
  // 主版本三段（major.minor.patch）
  for (let i = 0; i < 3; i++) {
    const x = Number(pa[i] ?? 0)
    const y = Number(pb[i] ?? 0)
    if (x !== y) return x - y
  }
  const hasPreA = pa.length > 3
  const hasPreB = pb.length > 3
  if (hasPreA !== hasPreB) return hasPreA ? -1 : 1 // 无预发布更大
  if (!hasPreA) return 0
  // 预发布段逐段比较（rc.7 vs rc.6、rc.10 vs rc.9 等）
  const preA = pa.slice(3)
  const preB = pb.slice(3)
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i]
    const y = preB[i]
    if (x === undefined) return -1 // 段数少者更小（1.0.0-rc < 1.0.0-rc.1）
    if (y === undefined) return 1
    const c = preCompare(x, y)
    if (c !== 0) return c
  }
  return 0
}

/**
 * 在已发布版本列表中取最大者（可排除已知不兼容版本）；无可用版本返回 null。
 * 纯函数，便于单测（打包期 setup-runtime 用它从 npm 全量版本里挑「最新可用」的 dsh）。
 */
export function maxVersion(versions: string[], excluded?: ReadonlySet<string>): string | null {
  let best: string | null = null
  for (const v of versions) {
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+/.test(v)) continue
    if (excluded?.has(v)) continue
    if (best === null || compareDots(v, best) > 0) best = v
  }
  return best
}

/**
 * 更新可用性（纯函数，不触网，便于单测）：
 * 有更新版本，或本地树不一致（混血/残缺，即使 dsh 版本相同也需要重建）。
 * @param local      本地 dsh 版本（可空）
 * @param latest     最新已发布 dsh 版本（可空）
 * @param consistent 本地整树一致性（@deepseek-ai/* 锁步包是否同版本线）
 */
export function updateAvailable(local: string | null, latest: string | null, consistent: boolean): boolean {
  if (!local || !latest) return false
  return compareDots(latest, local) > 0 || !consistent
}
