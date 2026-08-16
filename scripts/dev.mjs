/**
 * 开发启动：build → dev-link（bridge 链接进 profile node_modules）→ electron .
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

await import('./build.mjs')

try {
  // 以子进程运行（dev-link 内部会 process.exit，不能直接 import）
  const link = spawn(process.execPath, ['scripts/dev-link.mjs'], { stdio: 'inherit' })
  const code = await new Promise((resolve) => link.on('exit', resolve))
  if (code !== 0) {
    console.warn(`[dev] 插件链接失败（code=${code}，harness 将无法加载插件）`)
  }
} catch (err) {
  console.warn(`[dev] 插件链接失败: ${err instanceof Error ? err.message : String(err)}`)
}

const exe =
  process.platform === 'win32'
    ? path.resolve('node_modules', 'electron', 'dist', 'electron.exe')
    : path.resolve('node_modules', '.bin', 'electron')
const extra = (process.env.DSH_DESKTOP_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)
console.log(`[dev] launching electron: ${exe} ${extra.join(' ')}`)
const child = spawn(exe, [...extra, '.'], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
