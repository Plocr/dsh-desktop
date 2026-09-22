/**
 * 合并 macOS 两个架构的 latest-mac.yml（GitHub provider 多架构更新）。
 *
 * 背景：arm64 / x64 运行时各自平台生成，CI 分两个 job 各产 dmg（+ 签名分支还产 zip）。
 * electron-updater 的 GitHub provider 只读一份 `latest-mac.yml`：
 *  - MacUpdater **只接受 zip**（`findFile(files,'zip',['pkg','dmg'])`，dmg 被显式排除），
 *    zip 才是应用内更新真正安装的载荷；
 *  - dmg 是给「手动下载安装」用的（也是壳在装不了时给用户的兜底）。
 * 所以两个架构的 zip + dmg 都要进同一份 files 数组，各自按 url 里的架构名被挑选。
 *
 * **sha512/size 一律从下载下来的实际文件现算**：electron-builder 打包时写的那份
 * latest-mac.yml 早于公证与钉票（钉票会改 .app，随后 zip 被重打），那组数值已经作废；
 * 用错的 sha512 会让 electron-updater 在下载后校验失败。
 *
 * 用法（CI merge job）：
 *   在项目根目录运行：
 *     node scripts/merge-mac-manifest.mjs <assets-dir> <out.yml>
 *   <out.yml> 即合并后的 latest-mac.yml，随后由 CI 上传到该项 Release。
 *   依赖已下载到本机的 dmg / zip：
 *     DSH.Desktop-<ver>-{arm64,x64}.dmg、DSH.Desktop-<ver>-{arm64,x64}.zip
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function readable(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 一个产物的清单条目。
 *
 * @param {string} assetsDir 产物目录。
 * @param {string} version 壳版本。
 * @param {string} arch 架构（arm64 / x64）。
 * @param {'dmg'|'zip'} ext 扩展名。
 * @returns {{ url: string, sha512: string, size: number } | null} 文件不存在时 null。
 */
function entryFor(assetsDir, version, arch, ext) {
  const name = `DSH.Desktop-${version}-${arch}.${ext}`
  const file = path.join(assetsDir, name)
  if (!readable(file)) return null
  const size = statSync(file).size
  if (ext === 'dmg' && !readable(`${file}.blockmap`)) {
    console.warn(`[merge] missing blockmap for ${name}，将不带 blockmap（仅整包更新）`)
  }
  if (ext === 'zip' && readable(`${file}.blockmap`)) {
    // 钉票后重打的 zip 不该带 blockmap（它对应的是重打之前的字节）。
    // 传上去会让差分下载拿到对不上的基准，最后以 sha512 校验失败告终。
    console.warn(`[merge] ${name}.blockmap 存在，但钉票后重打的 zip 不该带它——CI 上传步骤应显式拒绝`)
  }
  return { url: name, sha512: sha512Base64(file), size }
}

/**
 * 生成合并后的 latest-mac.yml（纯函数：只读传入目录里的文件，返回文本）。
 *
 * @param {{ assetsDir: string, version: string, releaseDate: string }} options 产物目录、壳版本、发布时刻。
 * @returns {{ yml: string, files: { url: string, sha512: string, size: number }[], hasZip: boolean }}
 *   yml 文本、参选条目、以及是否包含应用内更新所需的 zip。
 * @throws {Error} 目录里既没有 dmg 也没有 zip 时。
 */
export function mergeMacManifest(options) {
  const { assetsDir, version, releaseDate } = options
  const zipArm = entryFor(assetsDir, version, 'arm64', 'zip')
  const zipX64 = entryFor(assetsDir, version, 'x64', 'zip')
  const dmgArm = entryFor(assetsDir, version, 'arm64', 'dmg')
  const dmgX64 = entryFor(assetsDir, version, 'x64', 'dmg')
  // zip 在前：MacUpdater 装的是 zip，先列出来便于人读这份 yml
  const files = [zipArm, zipX64, dmgArm, dmgX64].filter(Boolean)
  if (files.length === 0) {
    throw new Error('[merge] no dmg/zip found, abort')
  }
  const hasZip = zipArm !== null || zipX64 !== null
  if (!hasZip) {
    // 未签名的 mac 构建只有 dmg：应用内更新装不了，由壳侧诚实提示手动下载
    console.warn('[merge] 没有 zip：macOS 无法应用内更新（壳会提示手动下载 dmg）')
  }
  // path / sha512：旧字段，只在 files 缺失时才被 electron-updater 读取。
  // 指向 zip（应用内更新的载荷），没有 zip 才退回 dmg。
  const primary = zipArm ?? zipX64 ?? dmgArm ?? dmgX64
  const yml = [
    `version: ${version}`,
    'files:',
    ...files.map((f) => [
      `  - url: ${f.url}`,
      `    sha512: ${f.sha512}`,
      `    size: ${f.size}`,
    ]),
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${releaseDate}'`,
  ].flat()
  return { yml: `${yml.join('\n')}\n`, files, hasZip }
}

async function main() {
  // 参数：<产物目录> <输出 yml>
  const [assetsDir, outFile] = process.argv.slice(2)
  if (!assetsDir || !outFile) {
    console.error('usage: node scripts/merge-mac-manifest.mjs <assets-dir> <out.yml>')
    process.exitCode = 1
    return
  }
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const releaseDate = new Date().toISOString().replace(/\.\d{3}Z$/, '')
  const { yml, files } = mergeMacManifest({ assetsDir, version, releaseDate })
  writeFileSync(outFile, yml, 'utf8')
  console.log(`[merge] wrote ${outFile}`)
  for (const f of files) console.log(`[merge]   ${f.url} (${f.size} bytes)`)
}

if (import.meta.main) {
  await main()
}
