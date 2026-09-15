/**
 * 随包运行时树（resources/dsh）里应当剔除的文件策略。
 *
 * 移植自官方 desktop 的 `scripts/runtime-file-policy.ts`（MIT，deepseek-ai/deepseek-harness）。
 * 原则与官方一致：**只剔除构建/诊断残留**，运行时 JS、原生模块、WASM、许可证一律保留，
 * 认不出来的资源默认保留（宁可多带，不可少带）。
 *
 * @param {string} relativePath node_modules 下的相对路径（用 / 或 \ 分隔）
 * @param {{ platform: string, arch: string }} target 目标平台与架构
 * @returns {string | undefined} 剔除原因；undefined 表示保留
 */
export function desktopRuntimeFileExclusion(relativePath, target) {
  const parts = relativePath.split(/[\\/]/u)
  if (parts.some((part) => ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(part))) {
    return 'package-manager metadata'
  }
  const file = parts.at(-1) ?? ''
  if (/\.(?:[cm]?[jt]s|css)\.map$/u.test(file)) return 'source map'
  if (/\.d\.[cm]?ts$/u.test(file)) return 'TypeScript declaration'
  if (/\.tsbuildinfo$/u.test(file)) return 'TypeScript build cache'
  const packageParts = parts.slice(parts.lastIndexOf('node_modules') + 1)
  const nameParts = packageParts[0]?.startsWith('@') ? 2 : 1
  const name = packageParts.slice(0, nameParts).join('/')
  const entry = packageParts.slice(nameParts).join('/')
  if (name === 'fs-ext' && /^build\/(?:Release|Debug)\/(?:obj(?:\/|$)|fs_ext\.(?:exp|lib|pdb|iobj|ipdb)$)/u.test(entry)) {
    return 'fs-ext compiler output'
  }
  if (name === 'fs-ext' && /^build\/(?:binding\.sln|config\.gypi|fs_ext\.vcxproj(?:\.filters)?)$/u.test(entry)) {
    return 'fs-ext build configuration'
  }
  if (name === '@mixmark-io/domino' && (entry === 'test' || entry.startsWith('test/'))) return 'Domino test fixtures'
  if (name === 'node-pty' && entry.startsWith('prebuilds/')) {
    const platform = packageParts[nameParts + 1]
    if (platform !== undefined && platform !== `${target.platform}-${target.arch}`) return 'node-pty other platform'
    if (file.endsWith('.pdb')) return 'node-pty debug symbols'
  }
  if (name === '@koromix/koffi-win32-x64' && entry === 'win32_x64/koffi.lib') return 'Koffi import library'
  return undefined
}
