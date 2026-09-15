/**
 * 构建 main + preload（esbuild → CJS，bundle 到 dist/）。
 *
 * 插件不再随壳分发：官方面向 profile 的模型里，第一方包（bridge / host）由
 * scripts/setup-runtime.mjs 装进 resources/dsh 的运行时树（共享包，junction 链接进
 * profile），第三方插件用随包 pnpm 装进 profile 依赖。因此这里只产出壳自己的 dist/。
 */
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

// 先生成 loading.html（模板 + whale path 合并），再构建
execFileSync(process.execPath, [path.resolve('scripts', 'generate-loading.mjs')], { stdio: 'inherit' })

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
