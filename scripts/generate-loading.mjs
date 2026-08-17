/**
 * generate-loading.mjs — 从 loading.template.html + whale-path.txt 生成 loading.html。
 *
 * 模板里 `__WHALE_PATH__` 占位符替换为 whale-path.txt 的内容（鲸鱼 logo SVG path）。
 * 接入 build.mjs 执行，保证改模板/path 后生成的 loading.html 始终最新。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'resources', 'shell-pages')

const template = readFileSync(path.join(dir, 'loading.template.html'), 'utf8')
const whalePath = readFileSync(path.join(dir, 'whale-path.txt'), 'utf8').trim()

if (!template.includes('__WHALE_PATH__')) {
  throw new Error('loading.template.html 缺少 __WHALE_PATH__ 占位符')
}

const out = template.replace('__WHALE_PATH__', whalePath)
writeFileSync(path.join(dir, 'loading.html'), out, 'utf8')
console.log(`[loading] loading.html generated (${out.length} bytes)`)
