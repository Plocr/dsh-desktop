/**
 * 构建 main + preload（esbuild → CJS，bundle 到 dist/），
 * 面板前端（browser → resources/panel-dist：panel.js 仪表盘 / term.js 终端 lazy 包），
 * 并把 bridge 插件包复制为 resources/bridge（打包期随 asar 分发，首启同步进 profile）。
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
  external: ['electron', 'electron-updater', 'node-pty'],
  logLevel: 'info',
}

await build({ ...mainCommon, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs' })
await build({ ...mainCommon, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs' })

// 面板前端：注入到 harness 页的资产（经 dsh-shell:// 协议服务）
const panelOut = path.resolve('resources', 'panel-dist')
rmSync(panelOut, { recursive: true, force: true })
mkdirSync(panelOut, { recursive: true })

const panelCommon = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  minify: false,
}

await build({ ...panelCommon, entryPoints: ['src/panel/panel.ts'], outfile: path.join(panelOut, 'panel.js') })
await build({ ...panelCommon, entryPoints: ['src/panel/term.ts'], outfile: path.join(panelOut, 'term.js') })

// 样式：面板自有 CSS + xterm 官方 CSS（lazy 由 term.js 注入）
cpSync(path.resolve('src', 'panel', 'panel.css'), path.join(panelOut, 'panel.css'))
cpSync(path.resolve('node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), path.join(panelOut, 'xterm.css'))
console.log(`[build] panel -> ${panelOut}`)

const bridgeOut = path.resolve('resources', 'bridge')
rmSync(bridgeOut, { recursive: true, force: true })
mkdirSync(bridgeOut, { recursive: true })
cpSync(path.resolve('packages', 'bridge'), bridgeOut, { recursive: true })
console.log(`[build] bridge copied -> ${bridgeOut}`)
