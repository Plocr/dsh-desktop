/**
 * 运行时版本标记决策（纯逻辑，无 Electron 依赖，可单测）。
 *
 * runtime.version 有两类来源：
 *  - 随包分发（resources/runtime.version）：`dsh=<v>\ntar=<bundled hash>\n`
 *  - 用户自更新（框架本地下载替换后写入 %LOCALAPPDATA%/DSH Desktop/runtime.version）：
 *    `tar=user-<hash>` 前缀，标记「这份运行时不来自当前安装包，是用户手动/自动升级的」。
 *
 * 解压决策 shouldExtractBundled：
 *  - 无本地标记 → 解压；
 *  - 本地标记与随包标记完全一致 → 就绪（不解压）；
 *  - 本地是「用户自更新」标记 → 本地整树不一致（混血/残缺）→ 回退内置；
 *    否则仅当随包内嵌的 dsh 比本地新才解压覆盖
 *    （用户自跑新框架优先，安装包内嵌更新换代时才回切）；
 *  - 其他不匹配 → 解压刷新。
 */

export interface RuntimeMarker {
  dsh: string | null
  tar: string | null
}

/** 解析 marker 文本的 dsh/tar 两行。 */
export function parseMarker(text: string): RuntimeMarker {
  const dsh = /(?:^|\n)dsh=(\S+)/.exec(text)
  const tar = /(?:^|\n)tar=(\S+)/.exec(text)
  return { dsh: dsh ? dsh[1] : null, tar: tar ? tar[1] : null }
}

/** 该标识是否来自用户自更新（tar=user-*）。 */
export function isUserMarker(text: string): boolean {
  const m = /(?:^|\n)tar=user-/.test(text)
  return m
}

export interface ExtractDecisionOptions {
  /**
   * 本地运行时的整树一致性（@deepseek-ai/* 锁步包是否同版本线）。
   * 仅当本地标记为用户自更新时参与判定：树不一致（混血，如 dsh 已升、
   * 兄弟包仍旧）视为残缺 → 回退内置一致运行时；缺省 undefined 时不参与。
   */
  localTreeConsistent?: boolean
  /**
   * 本地运行时能否用本壳 profile（dsh-workbench）启动（真实探测结果）。
   * false 时无条件回退随包运行时——被应用内更新到「CLI 拒绝 desktop profile」
   * 的版本（如 0.1.5-alpha.1+）即使更新、树一致，也必须换回可用运行时，
   * 否则应用每次启动都崩溃重启。缺省 undefined 时不参与。
   */
  localBootable?: boolean
}

/**
 * 决定是否需要用随包内嵌运行时重新解压/覆盖本地运行时。
 * @param bundledText resources/runtime.version 内容
 * @param localText   %LOCALAPPDATA%/DSH Desktop/runtime.version 内容
 * @param compare     (a, b) => a<b 负数 / a=b 0 / a>b 正数（semver 风格，注入 compareDots 便于测试）
 * @param opts        可选：本地整树一致性、本地启动兼容性（用户标记下参与判定）。
 */
export function shouldExtractBundled(
  bundledText: string,
  localText: string | null,
  compare: (a: string, b: string) => number,
  opts?: ExtractDecisionOptions,
): boolean {
  const b = parseMarker(bundledText)
  if (!b.dsh) return false // 随包标记损坏：交给调用方做存在性兜底
  if (!localText) return true // 无本地标记 → 解压
  const l = parseMarker(localText)
  if (!l.dsh) return true
  if (b.tar === l.tar) return false // 与随包一致 → 就绪
  if (opts?.localBootable === false) return true // 本地运行时无法启动本壳 profile → 回退随包
  if (isUserMarker(localText)) {
    // 用户自更新：本地树不一致（混血/残缺）→ 回退内置一致运行时；
    // 否则仅当随包内嵌 dsh 比本地新才覆盖（一致的较新用户树优先保留）
    if (opts?.localTreeConsistent === false) return true
    return compare(b.dsh, l.dsh) > 0
  }
  return true // 其他不匹配 → 解压刷新
}

/** 生成用户自更新后的 marker 文本。 */
export function buildUserMarker(dshVersion: string, contentHash: string): string {
  return `dsh=${dshVersion}\ntar=user-${contentHash}\n`
}
