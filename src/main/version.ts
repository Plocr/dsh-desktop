/**
 * 版本比较工具（纯逻辑，无 Electron 依赖，可单测）。
 * semver 风格：正确处理 -rc.X / -beta.X / -alpha.X 预发布段。
 */

/** 解析版本段：数字段转 number，预发布标识（alpha/beta/rc）转排序值。 */
function versionPart(v: string): number {
  const n = Number(v)
  if (!Number.isNaN(n)) return n
  // 预发布标识：alpha < beta < rc < release（release 无标识 = 最大）
  const m = /^([a-zA-Z]+)(\d*)$/.exec(v)
  if (m) {
    const base = m[1].toLowerCase()
    const rank = base === 'alpha' ? -3 : base === 'beta' ? -2 : base === 'rc' ? -1 : 0
    const num = m[2] ? Number(m[2]) : 0
    return rank * 1000 - num
  }
  return 0
}

/**
 * 版本比较（semver 风格，正确处理 -rc.X / -beta.X 预发布段）：
 * 返回 <0 表示 a<b，>0 表示 a>b，0 相等。
 * 无预发布（0.2.0）> 有预发布（0.2.0-rc.1）。
 */
export function compareDots(a: string, b: string): number {
  const pa = a.split(/[.+-]/)
  const pb = b.split(/[.+-]/)
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
    const x = preA[i] === undefined ? 0 : versionPart(preA[i])
    const y = preB[i] === undefined ? 0 : versionPart(preB[i])
    if (x !== y) return x - y
  }
  return 0
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
