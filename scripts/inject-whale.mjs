/**
 * 生成 resources/shell-pages/loading.html：
 * 把 whale-path.txt 里的鲸鱼 SVG path 注入 loading.template.html 的 __WHALE_PATH__ 占位符。
 * 用法: node scripts/inject-whale.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pages = path.join(root, 'resources', 'shell-pages')
const template = readFileSync(path.join(pages, 'loading.template.html'), 'utf8')
const whalePath = readFileSync(path.join(pages, 'whale-path.txt'), 'utf8').trim()

if (!template.includes('__WHALE_PATH__')) throw new Error('template missing __WHALE_PATH__ placeholder')
const out = template.replace('__WHALE_PATH__', whalePath)
writeFileSync(path.join(pages, 'loading.html'), out, 'utf8')
console.log(`[whale] loading.html generated (${out.length} bytes, path ${whalePath.length} chars)`)
