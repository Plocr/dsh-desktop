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

/**
 * Host 入口（0.8.9）：**随壳打进 dist/（→ app.asar）**，不再只依赖运行时树里的散件。
 *
 * 背景（真机事故 2026-09-23 起）：卡巴斯基主动防御把
 * `resources/dsh/node_modules/dsh-desktop-host/lib/index.js` 判成
 * `PDM:Trojan.Win32.Generic` 并**从安装目录里删掉**，壳的启动前置检查因此拒绝启动，
 * 用户看到「运行时缺少随包文件…请加白名单后重装」。那份文件就是本仓 `packages/host`
 * 的构建产物；把它放在安装目录里当散件没有任何好处，却正好落在启发式最敏感的
 * 形状上（深目录里的未签名脚本 + 拉起子进程）。
 *
 * 因此入口改为壳自带：同一份源码在这里打进 `dist/main/host-entry.cjs`，
 * spawn 时优先用它（`src/main/hostEntry.ts`），运行时树里那份只作为开发/兜底。
 *
 * 两个细节：
 *  1. `define: { 'import.meta.main': 'true' }` —— CJS 输出没有 `import.meta`，而本文件
 *     在壳里**就是**进程入口（等价于 ESM 侧的 `import.meta.main`）；
 *  2. banner 把 `<runtimeDir>/node_modules`（argv[2]）加进本模块的搜索路径：
 *     `@deepseek-ai/*` 仍是运行时树提供的（不可变更新单元没被拆开），而入口自身
 *     待在哪里由壳决定——app.asar 里、dist 里都一样。
 */
const HOST_ENTRY_BANNER = `/* dsh-desktop-host CLI - bundled into the shell (MIT, adapted from deepseek-ai/deepseek-harness apps/desktop-host). */
const __dshRuntimeNodeModules = require('node:path').join(process.argv[2] || '', 'node_modules');
if (process.argv[2] && !module.paths.includes(__dshRuntimeNodeModules)) module.paths.unshift(__dshRuntimeNodeModules);
`

await build({
  ...mainCommon,
  entryPoints: ['packages/host/src/index.ts'],
  outfile: 'dist/main/host-entry.cjs',
  external: ['@deepseek-ai/*'],
  define: { 'import.meta.main': 'true' },
  banner: { js: HOST_ENTRY_BANNER },
})
