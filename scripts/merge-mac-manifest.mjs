/**
 * 合并 macOS 两个架构的 latest-mac.yml（GitHub provider 多架构更新）。
 *
 * 背景：arm64 / x64 运行时各自平台生成，CI 分两个 job 各产一个 dmg（文件名含
 * arm64 / x64）。electron-updater 的 GitHub provider 读取单一 `latest-mac.yml`，
 * 按其 `files[]` 里每个条目的 url 是否包含 process.arch 来挑选对应 dmg。
 * 因此只需把两份 dmg 的 url / sha512 / size 合并进同一个 files 数组即可，
 * 两个架构的用户都能应用内更新。
 *
 * 用法（CI merge job）：
 *   在项目根目录运行：
 *     DSH_RELEASE_TAG=v0.4.2 node scripts/merge-mac-manifest.mjs ./dmg <out.yml>
 *   <out.yml> 即合并后的 latest-mac.yml，随后由 CI 上传到该项 Release。
 *   依赖已下载到本机的两份 dmg：
 *     DSH.Desktop-<ver>-arm64.dmg、DSH.Desktop-<ver>-x64.dmg
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

// 参数：<dmg 目录> <输出 yml>
const [dmgDir, outFile] = process.argv.slice(2)
if (!dmgDir || !outFile) {
  console.error('usage: node scripts/merge-mac-manifest.mjs <dmg-dir> <out.yml>')
  process.exit(1)
}
const releaseDate = new Date().toISOString().replace(/\.\d{3}Z$/, '')

function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function entryFor(arch) {
  const name = `DSH.Desktop-${version}-${arch}.dmg`
  const file = path.join(dmgDir, name)
  const blockmap = `${file}.blockmap`
  if (!readable(file)) return null
  const size = statSync(file).size
  if (!readable(blockmap)) {
    console.warn(`[merge] missing blockmap for ${name}，将不带 blockmap（仅整包更新）`)
  }
  return { url: name, sha512: sha512Base64(file), size }
}

function readable(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const arm = entryFor('arm64')
const x64 = entryFor('x64')
const files = [arm, x64].filter(Boolean)
if (files.length === 0) {
  console.error('[merge] no dmg found, abort')
  process.exit(1)
}
// path / sha512：旧字段，指向「默认」dmg（arm64 优先，与 electron-builder 惯例一致）
const primary = arm ?? x64
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
writeFileSync(outFile, yml.join('\n') + '\n', 'utf8')
console.log(`[merge] wrote ${outFile}`)
for (const f of files) console.log(`[merge]   ${f.url} (${f.size} bytes)`)
