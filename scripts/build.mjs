/**
 * 构建 main + preload（esbuild → CJS，bundle 到 dist/），
 * 并把 bridge 插件包复制为 resources/bridge（打包期随 asar 分发，首启同步进 profile）。
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron', 'electron-updater'],
  logLevel: 'info',
}

await build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs' })
await build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs' })

const bridgeOut = path.resolve('resources', 'bridge')
rmSync(bridgeOut, { recursive: true, force: true })
mkdirSync(bridgeOut, { recursive: true })
cpSync(path.resolve('packages', 'bridge'), bridgeOut, { recursive: true })
console.log(`[build] bridge copied -> ${bridgeOut}`)
