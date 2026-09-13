/**
 * 开发启动：build（plugins 复制到 resources/plugins）→ electron .
 *
 * 说明：曾用 dev-link（junction 把 packages/* 链接进 profile node_modules），
 * 但 Windows junction 在 ensureProfile 重建/清理时会被 rmSync 穿透，
 * 曾误删 packages/bridge 与 packages/ui-dashboard 源码——已移除该机制；
 * build.mjs 把 packages/* 复制到 resources/plugins，ensureProfile 负责
 * 同步进 profile，dev 与打包版走完全相同的插件加载链路。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

await import('./build.mjs')

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
