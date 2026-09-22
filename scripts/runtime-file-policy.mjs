/**
 * 随包运行时树（resources/dsh）里应当剔除的文件策略。
 *
 * 移植自官方 desktop 的 `scripts/runtime-file-policy.ts`（MIT，deepseek-ai/deepseek-harness）。
 * 原则与官方一致：**只剔除构建/诊断残留**，运行时 JS、原生模块、WASM、许可证一律保留，
 * 认不出来的资源默认保留（宁可多带，不可少带）。
 *
 * @param {string} relativePath node_modules 下的相对路径（用 / 或 \ 分隔）
 * @param {{ platform: string, arch: string }} target 目标平台与架构
 * @param {{ officeRuntime?: boolean }} [options] 可选策略开关：
 *   `officeRuntime` 为真时保留 Office→PDF 原生引擎（默认**剔除**，见下）。
 * @returns {string | undefined} 剔除原因；undefined 表示保留
 */
export function desktopRuntimeFileExclusion(relativePath, target, options = {}) {
  const parts = relativePath.split(/[\\/]/u)
  if (parts.some((part) => ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(part))) {
    return 'package-manager metadata'
  }
  const file = parts.at(-1) ?? ''
  if (/\.(?:[cm]?[jt]s|css)\.map$/u.test(file)) return 'source map'
  if (/\.d\.[cm]?ts$/u.test(file)) return 'TypeScript declaration'
  if (/\.tsbuildinfo$/u.test(file)) return 'TypeScript build cache'
  // 包文档：只保留许可证与 NOTICE（法律要求），其余 README/CHANGELOG 等不进安装包。
  if (/\.md$/iu.test(file) && !/^(?:licen[cs]e|notice|third[-_]?party)/iu.test(file)) return 'package documentation'
  const packageParts = parts.slice(parts.lastIndexOf('node_modules') + 1)
  const nameParts = packageParts[0]?.startsWith('@') ? 2 : 1
  const name = packageParts.slice(0, nameParts).join('/')
  const entry = packageParts.slice(nameParts).join('/')
  /**
   * Office→PDF 原生引擎（`@deepseek-ai/libreoffice-kit-<platform>-<arch>`）：
   * 一整份 LibreOffice 运行时（win32-x64 ≈ 325 MB / 2000 文件），是本树里的绝对大头，
   * 而它只服务「在应用内把 docx/xlsx/pptx 转成 PDF 预览」。
   *
   * 本壳是代码工作台：默认不随包（安装包与安装时间因此大幅下降），
   * 需要文档预览的构建显式设置 `DSH_DESKTOP_OFFICE_RUNTIME=1` 把引擎带回来。
   * 剔除后 `@deepseek-ai/dsh-office-to-pdf` 行仍能装配，只有第一次转换会以
   * `unavailable` 明确失败（引擎解析是惰性的，见 libreoffice-kit 的 createConverter）。
   */
  if (options.officeRuntime !== true && /^@deepseek-ai\/libreoffice-kit-(?:win32|darwin|linux)-/u.test(name)) {
    return 'office engine (opt-in)'
  }
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
  /**
   * node-pty 的 ConPTY 第三方二进制（OpenConsole.exe / conpty.dll）：按目标平台+架构各带一份。
   * 非目标架构那份（真机 x64 安装包里就有 win10-arm64）**永远不会被执行**，却正好是被杀软
   * 启发式隔离的那类 PE（真机 2026-09-23：卡巴斯基把 win10-arm64 的两个文件一起清了）。
   * 交叉构建时 target.arch 已经是目标架构，所以这里按同一判据剔除即可。
   */
  if (name === 'node-pty' && entry.startsWith('third_party/conpty/')) {
    const platformDir = entry.split('/')[3] ?? ''
    const expected = `${target.platform === 'win32' ? 'win10' : target.platform === 'darwin' ? 'darwin' : 'linux'}-${target.arch}`
    if (platformDir.startsWith('win10-') || platformDir.startsWith('linux-') || platformDir.startsWith('darwin-')) {
      if (platformDir !== expected) return 'node-pty other platform (conpty)'
    }
  }
  if (name === '@koromix/koffi-win32-x64' && entry === 'win32_x64/koffi.lib') return 'Koffi import library'
  return undefined
}
