/**
 * 开发启动：build（壳 dist/）→ 增量准备随包运行时树 → electron .
 *
 * 开发与打包走**完全相同**的加载链路：Host 从 resources/dsh 引导 profile，
 * 第一方包（bridge / host）作为共享包 junction 链接进 profile。因此 dev 前必须
 * 先有运行时树（setup-runtime 增量执行，源码未变时不联网、秒过）。
 */
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

await import('./build.mjs')

// 运行时树（resources/runtime + resources/dsh）是 Host 的加载目标：缺失/源码有变时增量重建。
// 增量判据用源码哈希，日常改壳代码不会触发重装（不联网、不重下 Node）。
console.log('[dev] ensuring packaged runtime tree (incremental)…')
const setup = spawnSync(process.execPath, [path.resolve('scripts', 'setup-runtime.mjs')], { stdio: 'inherit' })
if (setup.status !== 0) {
  console.error('[dev] setup-runtime 失败：Host 无法启动（见上方输出）')
  process.exit(setup.status ?? 1)
}

const exe =
  process.platform === 'win32'
    ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
    : path.resolve('node_modules', '.bin', 'electron')
const extra = (process.env.DSH_DESKTOP_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
console.log(`[dev] launching electron: ${exe} ${extra.join(' ')}`)
const child = spawn(exe, [...extra, '.'], { stdio: 'inherit' })
child.on('error', (err) => {
  console.error(`[dev] 启动 Electron 失败：${err.message}`)
  console.error('[dev] 请先运行 npm install（需要 node_modules/electron）。')
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 0))
