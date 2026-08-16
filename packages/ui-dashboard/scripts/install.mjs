#!/usr/bin/env node
/**
 * install.mjs — 把 ui-dashboard 安装进某个 DSH profile（持久插件，无需构建）。
 *
 * 用法（在仓库根目录执行）：
 *   node scripts/install.mjs                     # 默认安装到 desktop profile
 *   node scripts/install.mjs --profile=web       # 指定 profile
 *   DSH_HOME=/path/to/.dsh node scripts/install.mjs
 *
 * 步骤：
 *   1. 把 package.json + lib/（持久插件双半）复制到
 *      $DSH_HOME/profiles/<profile>/node_modules/ui-dashboard/；
 *   2. 在 $DSH_HOME/profiles/<profile>/cordis.patch.yml 里 insert 插件条目（幂等，
 *      已存在则跳过）；
 *   3. 打印后续步骤（刷新页面 / 重启 app）。
 *
 * cordis.patch.yml 被 DSH 热监听，改动通常立即生效；改动未生效时刷新页面或重启。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'ui-dashboard'
const ENTRY_ID = 'ui-dashboard'

// ---- 参数 ----
const args = process.argv.slice(2)
const profileArg = (args.find((a) => a.startsWith('--profile=')) ?? '--profile=desktop').split('=')[1] ?? 'desktop'
const envHome = process.env.DSH_HOME
const home = envHome !== void 0 && envHome.trim() !== '' ? envHome : join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profileArg)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

function fail(message) {
  console.error(`[ui-dashboard] error: ${message}`)
  process.exit(1)
}

// ---- 1. 复制包文件 ----
const dest = join(profileDir, 'node_modules', PACKAGE_NAME)
try {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(dest, 'lib'), { recursive: true })
  cpSync(join(repoRoot, 'package.json'), join(dest, 'package.json'))
  cpSync(join(repoRoot, 'lib', 'index.js'), join(dest, 'lib', 'index.js'))
  cpSync(join(repoRoot, 'lib', 'client.js'), join(dest, 'lib', 'client.js'))
} catch (error) {
  fail(`failed to install into ${dest}: ${error.message}`)
}
console.log(`[ui-dashboard] package files -> ${dest}`)

// ---- 2. 在 cordis.patch.yml 注册条目（幂等） ----
const patchPath = join(profileDir, 'cordis.patch.yml')
const insertBlock = `- insert:\n    - id: ${ENTRY_ID}\n      name: ${PACKAGE_NAME}\n`
let content = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
if (content.includes(ENTRY_ID)) {
  console.log(`[ui-dashboard] ${patchPath} already lists ${ENTRY_ID} — entry kept`)
} else {
  const stripped = content.replace(/^\s*#.*$/gm, '').trim()
  if (stripped === '' || stripped === '[]') {
    const emptyIdx = content.lastIndexOf('[]')
    content = emptyIdx >= 0
      ? content.slice(0, emptyIdx) + insertBlock
      : (content.replace(/\s+$/, '') + '\n\n' + insertBlock)
  } else {
    content = content.replace(/\n?$/, '\n') + insertBlock
  }
  writeFileSync(patchPath, content, 'utf8')
  console.log(`[ui-dashboard] entry inserted -> ${patchPath}`)
}

// ---- 3. 提示 ----
console.log('[ui-dashboard] installed.')
console.log('[ui-dashboard] next steps:')
console.log(`  - profile: ${profileArg} (home: ${home})`)
console.log('  - refresh the DSH web page (or restart the app) if the change does not hot-apply')
console.log('  - open a session -> header button「仪表盘」opens the right column; tab「仪表盘」sits beside 对话/轨迹')
console.log('  - uninstall: remove the `- insert: ...` block from cordis.patch.yml and delete the ui-dashboard folder under profile node_modules')
