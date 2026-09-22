/**
 * generate-loading.mjs — 把 whale-path.txt 里的鲸鱼矢量注入壳自带的静态页面。
 *
 *  - loading.template.html → loading.html（加载页）
 *  - error.html             → error.html（启动失败页，原地替换占位符）
 *
 * 两个文件里的 `__WHALE_PATH__` 占位符都替换成 whale-path.txt 的内容（鲸鱼 logo SVG path）。
 * 接入 build.mjs 执行，保证改模板/path 后生成的页面始终最新。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'resources', 'shell-pages')

const whalePath = readFileSync(path.join(dir, 'whale-path.txt'), 'utf8').trim()

/** 替换占位符并写回；模板缺占位符视为错误（否则页面会带着 `__WHALE_PATH__` 上线）。 */
function render(from, to) {
  const template = readFileSync(path.join(dir, from), 'utf8')
  if (!template.includes('__WHALE_PATH__')) {
    throw new Error(`${from} 缺少 __WHALE_PATH__ 占位符`)
  }
  const out = template.replace('__WHALE_PATH__', whalePath)
  writeFileSync(path.join(dir, to), out, 'utf8')
  console.log(`[shell-pages] ${to} generated (${out.length} bytes)`)
}

render('loading.template.html', 'loading.html')
render('error.html.template.html', 'error.html')
