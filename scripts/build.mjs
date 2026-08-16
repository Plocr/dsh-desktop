/**
 * 构建 main + preload（esbuild → CJS，bundle 到 dist/），
 * 并把 packages/ 下所有插件包复制为 resources/plugins/<name>
 * （打包期随 asar 分发，首启同步进 profile）。
 *
 * 插件包若自带 build-client.js（如 ui-dashboard），复制前先执行一次，
 * 确保 client 构建产物（lib/client.js，.gitignore 忽略）在打包时存在。
 */
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const mainCommon = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron', 'electron-updater'],
  logLevel: 'info',
}

await build({ ...mainCommon, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs' })
await build({ ...mainCommon, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs' })

// packages/ 下每个目录视为一个桌面插件，复制到 resources/plugins/<name>
// （随 asar 分发，首启由 ensureProfile 同步进 profile node_modules）。
const pluginsOut = path.resolve('resources', 'plugins')
rmSync(pluginsOut, { recursive: true, force: true })
mkdirSync(pluginsOut, { recursive: true })

const packagesDir = path.resolve('packages')
for (const name of readdirSync(packagesDir)) {
  const src = path.join(packagesDir, name)
  let isDir = false
  try {
    isDir = statSync(src).isDirectory()
  } catch {
    isDir = false
  }
  if (!name.startsWith('.') && isDir) {
    // 插件自带 client 构建脚本时先构建（保证 lib/client.js 存在）
    const buildClient = path.join(src, 'build-client.js')
    if (existsSync(buildClient)) {
      console.log(`[build] building client bundle for ${name}`)
      execFileSync(process.execPath, [buildClient], { cwd: src, stdio: 'inherit' })
    }
    const dest = path.join(pluginsOut, name)
    cpSync(src, dest, { recursive: true })
    console.log(`[build] plugin copied -> ${dest}`)
  }
}
