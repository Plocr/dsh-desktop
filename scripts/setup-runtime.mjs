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
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(root, 'resources', 'dsh-runtime')
const NODE_VERSION = process.env.DSH_RUNTIME_NODE_VERSION ?? 'v24.15.0'
/**
 * 随包 harness 版本：官方最新发布版（npm 全量版本里的最大 semver）。
 * 本壳 profile 用自有名 `dsh-workbench`（src/main/desktopProfile.ts），不受官方
 * 「CLI 拒绝 desktop profile」守卫影响（该守卫自 0.1.5-alpha.1 起存在，只针对
 * 官方保留名 desktop）；应用内更新还会在替换前做启动探测兜底（不兼容则回滚）。
 */
const DSH_VERSION = process.env.DSH_RUNTIME_DSH_VERSION ?? '0.1.5-rc.2'
/**
 * 目标 Node 架构：默认宿主架构；交叉构建（如在 x64 runner 上打 arm64 dmg）时
 * 用 DSH_RUNTIME_NODE_ARCH 显式指定（nodejs.org 包名：x64 / arm64）。
 * 运行时打进哪个架构的安装包，便携 Node 就必须是哪个架构。
 */
const NODE_ARCH = process.env.DSH_RUNTIME_NODE_ARCH ?? process.arch
/**
 * tar 可执行文件：Windows 显式用 System32 的 bsdtar（PATH 里的 Git GNU tar
 * 会把 `E:\…` 盘符参数误判为远程主机 host:file 而失败），可经 DSH_RUNTIME_TAR 覆盖。
 */
const systemTar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : ''
const TAR = process.env.DSH_RUNTIME_TAR ?? (systemTar && existsSync(systemTar) ? systemTar : 'tar')
/**
 * 工具 Node：npm 操作用宿主 Node（process.execPath）执行 npm-cli.js——
 * 交叉构建时目标架构 Node 无法在宿主架构上运行，而 npm-cli.js 是纯 JS，
 * 任何 Node 都能执行；目标架构 Node 只作为运行时产物，不用于构建命令。
 */
const toolNode = () => process.execPath

function run(cmd, args, opts = {}) {
  console.log(`[runtime] ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

/** npm 源：npmmirror 较快，失败自动切回官方 npmjs。 */
const REG_NPMMIRROR = 'https://registry.npmmirror.com/'
const REG_NPMJS = 'https://registry.npmjs.org/'

/**
 * 执行一次 npm install。
 * macOS runner 上便携 Node 装 453 包时 `V8::FatalProcessOutOfMemory`（npm arborist
 * 单线程建依赖树的老年代堆 OOM，与并发无关）→ darwin 显式放大 V8 堆 + 降并发；
 * win/linux 保持默认（高并发更快）。
 * npmjs 失败自动切 npmmirror 重试。
 */
function runNpmInstall(extraArgs) {
  const isDarwin = process.platform === 'darwin'
  const installEnv = isDarwin ? { ...process.env, NODE_OPTIONS: `--max-old-space-size=4096 ${process.env.NODE_OPTIONS ?? ''}`.trim() } : process.env
  const concurrency = isDarwin ? ['--maxsockets', '2'] : []
  const common = [npmCli(), 'install', '--no-audit', '--no-fund', '--loglevel=error', ...concurrency, '--fetch-retries', '3']
  let lastErr = null
  for (const reg of [REG_NPMJS, REG_NPMMIRROR]) {
    try {
      // npm 操作用宿主 Node 执行（交叉构建时目标架构 Node 无法在宿主上运行）
      run(toolNode(), [...common, '--registry', reg, ...extraArgs, '--prefix', runtimeDir], { env: installEnv })
      return
    } catch (err) {
      lastErr = err
      console.log(`[runtime] npm install（registry=${reg}）失败：${err?.message ?? err}，切换源重试…`)
    }
  }
  throw lastErr ?? new Error('npm install 多次失败')
}

async function downloadNode() {
  const nodeDir = path.join(runtimeDir, 'node')
  const archMarker = path.join(nodeDir, '.dsh-node-arch')
  let existingArch = null
  try {
    existingArch = readFileSync(archMarker, 'utf8').trim()
  } catch {
    /* 旧缓存无架构标记 → 视为不匹配，重建 */
  }
  if (
    existsSync(path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'bin/node')) &&
    existingArch === NODE_ARCH
  ) {
    console.log(`[runtime] node ${NODE_VERSION} (${NODE_ARCH}) already present`)
    return
  }
  rmSync(nodeDir, { recursive: true, force: true })
  mkdirSync(nodeDir, { recursive: true })
  const arch = NODE_ARCH === 'x64' ? 'x64' : NODE_ARCH
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
  // 供应链校验：对照官方 SHASUMS256.txt（获取失败时仅告警，不阻断构建）
  const fileName = `node-${NODE_VERSION}-${plat}-${arch}.${ext}`
  let expectedSha = null
  try {
    const sumRes = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)
    if (sumRes.ok) {
      const line = (await sumRes.text()).split(/\r?\n/).find((l) => l.trim().endsWith(fileName))
      if (line) expectedSha = line.trim().split(/\s+/)[0] ?? null
    }
  } catch {
    /* 校验和获取失败不阻断（离线镜像等场景） */
  }
  const actualSha = createHash('sha256').update(buf).digest('hex')
  if (expectedSha) {
    if (actualSha !== expectedSha) {
      rmSync(tmp, { force: true })
      throw new Error(`node 校验和不匹配：${actualSha} != ${expectedSha}（下载可能被篡改，已中止）`)
    }
    console.log('[runtime] node 校验和已验证（SHASUMS256）')
  } else {
    console.log('[runtime] WARN: 未取到 SHASUMS256，跳过校验')
  }
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
  writeFileSync(archMarker, `${NODE_ARCH}\n`, 'utf8')
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(tmp, { force: true })
  console.log(`[runtime] node extracted to ${nodeDir} (arch=${NODE_ARCH})`)
}

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
  run(toolNode(), [npmCli(), 'pack', '--pack-destination', packDir, '--silent', bridgeSrc])
  const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'))
  if (!tgz) throw new Error('bridge pack failed')
  const pluginTar = path.join(packDir, tgz)
  // 安装 dsh + bridge（同一次 install，保证解析一致；含失败换 npmmirror 重试）
  runNpmInstall([`@deepseek-ai/dsh@${DSH_VERSION}`, pluginTar])
  // 保留 _pack：runtime package.json 的 file:_pack/... 引用不再悬空，
  // 且后续应用内整树刷新（harnessUpdate 的 npm install）可解析 bridge 依赖。
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

// 增量：运行时已就绪、dsh 版本匹配、Node 架构与目标一致、且 bridge 插件内容未变时才跳过
// （交叉构建时缓存里的旧架构 Node 不能复用，必须重建；
//   bridge 随仓库改动，若缓存键不含它，改了 packages/bridge 后 setup:runtime 会静默用旧 tgz）
const BRIDGE_HASH_MARKER = path.join(runtimeDir, '.dsh-bridge-hash')
/** bridge 源码树内容哈希（相对路径 + 文件内容；排除 node_modules/.git）。 */
function bridgeSourceHash(srcDir) {
  const files = []
  const walk = (dir, rel) => {
    let entries = []
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git') continue
      const full = path.join(dir, e)
      const r = rel === '' ? e : `${rel}/${e}`
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) walk(full, r)
      else files.push(r)
    }
  }
  walk(srcDir, '')
  const h = createHash('sha256')
  for (const f of files) {
    h.update(f)
    h.update(readFileSync(path.join(srcDir, f)))
  }
  return h.digest('hex').slice(0, 16)
}
const bridgeHash = bridgeSourceHash(path.join(root, 'packages', 'bridge'))
const dshPkg = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const archMarkerPath = path.join(runtimeDir, 'node', '.dsh-node-arch')
let fresh = false
if (existsSync(dshPkg) && existsSync(archMarkerPath)) {
  try {
    const v = JSON.parse(readFileSync(dshPkg, 'utf8')).version
    const nodeArch = readFileSync(archMarkerPath, 'utf8').trim()
    const cachedBridge = readFileSync(BRIDGE_HASH_MARKER, 'utf8').trim()
    if (v === DSH_VERSION && nodeArch === NODE_ARCH && cachedBridge === bridgeHash) {
      console.log(`[runtime] incremental: dsh@${v} node=${nodeArch} bridge=${cachedBridge} already installed`)
      fresh = true
    } else {
      console.log(
        `[runtime] cache mismatch: dsh=${v} node=${nodeArch} bridge=${cachedBridge} vs target dsh=${DSH_VERSION} node=${NODE_ARCH} bridge=${bridgeHash} -> rebuild`,
      )
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
  writeFileSync(BRIDGE_HASH_MARKER, `${bridgeHash}\n`, 'utf8')
}
// 裁剪（幂等）：全新安装与增量复用都会执行，删 .d.ts/docs/tests
pruneRuntime()

// electron-builder 会剔除 extraResources 中的 node_modules；
// 因此把整个运行时打成 tar.gz 随包分发，由壳在首启解压到 %LOCALAPPDATA%/DSH Desktop/runtime。
// （Windows 10+ 自带 bsdtar；展开速度约为 PowerShell Expand-Archive 的 4 倍以上）
const tarPath = path.join(root, 'resources', 'dsh-runtime.tar.gz')
rmSync(tarPath, { force: true })
// Windows 的 bsdtar（System32）会把「带盘符且尚不存在的 -f 目标」（E:\…）误判为
// 远程主机 URL 而报 "Cannot connect to E: resolve failed"；用相对文件名 + cwd 规避。
run(TAR, ['-czf', path.basename(tarPath), '-C', runtimeDir, '.'], { cwd: path.dirname(tarPath) })
const stat = (await import('node:fs')).statSync(tarPath)
console.log(`[runtime] tar.gz created: ${tarPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)

// 版本标记：随包分发，壳据此判断是否需要重新解压
const buf = readFileSync(tarPath)
const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
writeFileSync(path.join(root, 'resources', 'runtime.version'), `dsh=${DSH_VERSION}\ntar=${hash}\n`)
console.log(`[runtime] version marker: dsh=${DSH_VERSION} tar=${hash}`)
console.log(`[runtime] done -> ${runtimeDir}`)
