/**
 * 构建 main + preload（esbuild → CJS，bundle 到 dist/），
 * 并把 bridge 插件包复制为 resources/plugins/bridge（打包期随 asar 分发，首启同步进 profile）。
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
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

// bridge 插件包复制到 resources/plugins/bridge（随 asar 分发，首启同步进 profile）
const pluginsOut = path.resolve('resources', 'plugins')
rmSync(pluginsOut, { recursive: true, force: true })
mkdirSync(pluginsOut, { recursive: true })

const src = path.resolve('packages', 'bridge')
const dest = path.join(pluginsOut, 'bridge')
cpSync(src, dest, { recursive: true })
console.log(`[build] plugin copied -> ${dest}`)
