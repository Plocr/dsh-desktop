/**
 * 为 Electron ABI 重编原生模块（node-pty，Windows ConPTY）。
 * 用法：npm run rebuild:native
 * 需要：VS Build Tools（MSVC）+ Python（node-gyp 前置）。
 *
 * node-pty 的 prebuild 只覆盖 Node ABI；electron-builder 的 npmRebuild 又为 false，
 * 故显式重编。Windows 上若缺 Spectre 缓解库（MSB8040），本脚本用
 * `/p:SpectreMitigation=false` 直接调 MSBuild 绕过（编译产物为 Release 即可用）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ptyDir = path.join(root, 'node_modules', 'node-pty')
const ptyNode = path.join(ptyDir, 'build', 'Release', 'pty.node')

const run = (cmd, args, opts = {}) => {
  console.log(`[rebuild] ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd ?? root, shell: opts.shell ?? false })
  return r.status ?? -1
}

// 1) 先让 node-gyp 完成 configure + 生成工程（目标 Electron ABI）
const electronMajor = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))
    return pkg.version
  } catch {
    return '43.0.0'
  }
})()

const gyp = run('npx', ['node-gyp', 'rebuild', '--runtime=electron', `--target=${electronMajor}`, '--dist-url=https://electronjs.org/headers', '--arch=x64'], { cwd: ptyDir, shell: true })
if (gyp === 0) {
  console.log('[rebuild] node-pty rebuilt for Electron ABI')
  process.exit(0)
}
console.log('[rebuild] node-gyp 失败，尝试 MSBuild 直编（绕过 Spectre 库缺失）…')

// 2) 兜底：MSBuild 直编（node-gyp 已生成 sln；/p:SpectreMitigation=false 规避 MSB8040）
if (!existsSync(path.join(ptyDir, 'build', 'binding.sln'))) {
  console.error('[rebuild] 无 binding.sln，无法兜底。请安装 VS Build Tools 的 MSVC + Spectre 组件后重试。')
  process.exit(1)
}
const candidates = [
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe',
]
const msbuild = candidates.find((p) => existsSync(p))
if (!msbuild) {
  console.error('[rebuild] 未找到 MSBuild.exe')
  process.exit(1)
}
const code = run(msbuild, ['build\\binding.sln', '/p:Configuration=Release', '/p:Platform=x64', '/p:SpectreMitigation=false', '/m', '/v:minimal', '/nologo'], { cwd: ptyDir, shell: false })
if (code === 0 && existsSync(ptyNode)) {
  console.log('[rebuild] node-pty rebuilt (MSBuild fallback):', ptyNode)
  process.exit(0)
}
console.error('[rebuild] 重编失败')
process.exit(code === 0 ? 1 : code)
