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
 *  - 本地是「用户自更新」标记 → 仅当随包内嵌的 dsh 比本地新才解压覆盖
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

/**
 * 决定是否需要用随包内嵌运行时重新解压/覆盖本地运行时。
 * @param bundledText resources/runtime.version 内容
 * @param localText   %LOCALAPPDATA%/DSH Desktop/runtime.version 内容
 * @param compare     (a, b) => a<b 负数 / a=b 0 / a>b 正数（semver 风格，注入 compareDots 便于测试）
 */
export function shouldExtractBundled(
  bundledText: string,
  localText: string | null,
  compare: (a: string, b: string) => number,
): boolean {
  const b = parseMarker(bundledText)
  if (!b.dsh) return false // 随包标记损坏：交给调用方做存在性兜底
  if (!localText) return true // 无本地标记 → 解压
  const l = parseMarker(localText)
  if (!l.dsh) return true
  if (b.tar === l.tar) return false // 与随包一致 → 就绪
  if (isUserMarker(localText)) {
    // 用户自更新：仅当随包内嵌 dsh 比本地新才覆盖
    return compare(b.dsh, l.dsh) > 0
  }
  return true // 其他不匹配 → 解压刷新
}

/** 生成用户自更新后的 marker 文本。 */
export function buildUserMarker(dshVersion: string, contentHash: string): string {
  return `dsh=${dshVersion}\ntar=user-${contentHash}\n`
}
