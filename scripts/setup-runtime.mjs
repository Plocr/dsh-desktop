/**
 * 构建自包含运行时 resources/dsh-runtime：
 *  - 便携版 Node（从 nodejs.org 下载，版本可配）
 *  - npm install @deepseek-ai/dsh@<ver>（含 dsh-base/dsh-web-app/dsh-web-frontend dist）
 *  - 安装 bridge 包（自包含，含 vendored ws）
 *
 * 产物结构：
 *   dsh-runtime/
 *     node/node.exe ...
 *     node_modules/@deepseek-ai/dsh/...
 *     node_modules/dsh-desktop-bridge/...
 *
 * 全部 npm 操作通过便携 Node 自带的 npm-cli.js 执行（不依赖 PATH 中的 npm/cmd）。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(root, 'resources', 'dsh-runtime')
const NODE_VERSION = process.env.DSH_RUNTIME_NODE_VERSION ?? 'v24.15.0'
const DSH_VERSION = process.env.DSH_RUNTIME_DSH_VERSION ?? '0.1.0-rc.7'
const TAR = process.env.DSH_RUNTIME_TAR ?? 'tar'

function run(cmd, args) {
  console.log(`[runtime] ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit' })
}

async function downloadNode() {
  const nodeDir = path.join(runtimeDir, 'node')
  if (existsSync(path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'bin/node'))) {
    console.log(`[runtime] node ${NODE_VERSION} already present`)
    return
  }
  rmSync(nodeDir, { recursive: true, force: true })
  mkdirSync(nodeDir, { recursive: true })
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  const plat = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const ext = process.platform === 'win32' ? 'zip' : process.platform === 'darwin' ? 'tar.gz' : 'tar.xz'
  const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${plat}-${arch}.${ext}`
  console.log(`[runtime] downloading ${url}`)
  const tmp = path.join(os.tmpdir(), `node-${NODE_VERSION}-${Date.now()}.${ext}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(tmp, buf)
  console.log(`[runtime] downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`)
  const tmpDir = path.join(runtimeDir, '_tmp')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path ${JSON.stringify(tmp)} -DestinationPath ${JSON.stringify(tmpDir)} -Force`])
  } else {
    run('tar', ['-xf', tmp, '-C', tmpDir])
  }
  const inner = path.join(tmpDir, `node-${NODE_VERSION}-${plat}-${arch}`)
  cpSync(inner, nodeDir, { recursive: true })
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(tmp, { force: true })
  console.log(`[runtime] node extracted to ${nodeDir}`)
}

const nodeBin = () =>
  process.platform === 'win32' ? path.join(runtimeDir, 'node', 'node.exe') : path.join(runtimeDir, 'node', 'bin', 'node')

/** 便携 Node 内的 npm-cli.js：Windows 分发包在 node_modules/npm，macOS/Linux 在 lib/node_modules/npm。 */
const npmCli = () => {
  const candidates = [
    path.join(runtimeDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(runtimeDir, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`npm-cli.js not found in portable node (tried: ${candidates.join(', ')})`)
  return found
}

async function installDsh() {
  writeFileSync(
    path.join(runtimeDir, 'package.json'),
    JSON.stringify({ name: 'dsh-runtime', private: true, type: 'module' }, null, 2),
  )
  // 打包 bridge 插件（唯一保留的插件，输出到 runtimeDir 下的 _pack）
  const packDir = path.join(runtimeDir, '_pack')
  mkdirSync(packDir, { recursive: true })
  const bridgeSrc = path.join(root, 'packages', 'bridge')
  if (!existsSync(bridgeSrc)) throw new Error(`plugin package missing: ${bridgeSrc}`)
  run(nodeBin(), [npmCli(), 'pack', '--pack-destination', packDir, '--silent', bridgeSrc])
  const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'))
  if (!tgz) throw new Error('bridge pack failed')
  const pluginTar = path.join(packDir, tgz)
  // 安装 dsh + bridge（同一次 install，保证解析一致）
  run(nodeBin(), [
    npmCli(),
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    `@deepseek-ai/dsh@${DSH_VERSION}`,
    pluginTar,
    '--prefix',
    runtimeDir,
  ])
  rmSync(packDir, { recursive: true, force: true })
  console.log('[runtime] dsh + bridge installed')
}

// 校验 dsh-web-frontend dist 存在（web-app 运行时强依赖）
function verifyDist() {
  const dist = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
  if (!existsSync(dist)) throw new Error(`frontend dist missing: ${dist} —— dsh-web-app 无法 serve UI`)
  const plugin = path.join(runtimeDir, 'node_modules', 'dsh-desktop-bridge', 'lib', 'index.js')
  if (!existsSync(plugin)) throw new Error(`plugin not installed in runtime: ${plugin}`)
  console.log('[runtime] dist + bridge verified')
}

/**
 * 裁剪运行时体积（保守）：删除各包的构建/文档残留——
 * .d.ts/.d.ts.map、docs/、test/、tests/、locales/（仅保留运行时需要的）。
 * 不删 lib/*.js、dist/、package.json、README 保留。
 */
function pruneRuntime() {
  const nm = path.join(runtimeDir, 'node_modules')
  if (!existsSync(nm)) return
  let removedBytes = 0
  const removeTree = (p) => {
    try {
      const st = statSync(p)
      if (st.isDirectory()) {
        for (const e of readdirSync(p)) removeTree(path.join(p, e))
        rmSync(p, { recursive: true, force: true })
      } else {
        removedBytes += st.size
        rmSync(p, { force: true })
      }
    } catch {
      /* ignore */
    }
  }
  const walk = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      const base = entry.toLowerCase()
      // 文件级：.d.ts / .map / .d.mts
      if (!isDir && (base.endsWith('.d.ts') || base.endsWith('.d.ts.map') || base.endsWith('.d.mts'))) {
        try {
          removedBytes += statSync(full).size
          rmSync(full, { force: true })
        } catch {
          /* ignore */
        }
        continue
      }
      if (isDir) {
        // 目录级：docs/test/tests/coverage 等纯文档/测试目录
        if (base === 'docs' || base === 'test' || base === 'tests' || base === 'coverage' || base === '__tests__') {
          const before = treeSize(full)
          removeTree(full)
          removedBytes += before
          continue
        }
        // 深入 node_modules（含 @deepseek-ai 作用域包）
        if (entry !== '.bin') walk(full)
      }
    }
  }
  walk(nm)
  console.log(`[runtime] pruned ${(removedBytes / 1024 / 1024).toFixed(1)} MB (types/docs/tests)`)
}

function treeSize(dir) {
  let total = 0
  try {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e)
      try {
        if (statSync(p).isDirectory()) total += treeSize(p)
        else total += statSync(p).size
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return total
}

// 增量：运行时已就绪且 dsh 版本匹配时跳过下载/安装，只重建 zip
const dshPkg = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
let fresh = false
if (existsSync(dshPkg)) {
  try {
    const v = JSON.parse(readFileSync(dshPkg, 'utf8')).version
    if (v === DSH_VERSION) {
      console.log(`[runtime] incremental: dsh@${v} already installed`)
      fresh = true
    }
  } catch {
    /* fallthrough */
  }
}
if (!fresh) {
  rmSync(runtimeDir, { recursive: true, force: true })
  mkdirSync(runtimeDir, { recursive: true })
  await downloadNode()
  await installDsh()
  verifyDist()
}
// 裁剪（幂等）：全新安装与增量复用都会执行，删 .d.ts/docs/tests
pruneRuntime()

// electron-builder 会剔除 extraResources 中的 node_modules；
// 因此把整个运行时打成 tar.gz 随包分发，由壳在首启解压到 %LOCALAPPDATA%/DSH Desktop/runtime。
// （Windows 10+ 自带 bsdtar；展开速度约为 PowerShell Expand-Archive 的 4 倍以上）
const tarPath = path.join(root, 'resources', 'dsh-runtime.tar.gz')
rmSync(tarPath, { force: true })
run(TAR, ['-czf', tarPath, '-C', runtimeDir, '.'])
const stat = (await import('node:fs')).statSync(tarPath)
console.log(`[runtime] tar.gz created: ${tarPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)

// 版本标记：随包分发，壳据此判断是否需要重新解压
const { createHash } = await import('node:crypto')
const buf = (await import('node:fs')).readFileSync(tarPath)
const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
writeFileSync(path.join(root, 'resources', 'runtime.version'), `dsh=${DSH_VERSION}\ntar=${hash}\n`)
console.log(`[runtime] version marker: dsh=${DSH_VERSION} tar=${hash}`)
console.log(`[runtime] done -> ${runtimeDir}`)
