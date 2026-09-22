/**
 * 构建随包运行时（对齐官方 desktop 的「两份资源」布局）：
 *
 *   resources/runtime/   pnpm + versions.json（**不随包 node.exe**）
 *                        —— 解释器用应用自身的 Electron 二进制（`ELECTRON_RUN_AS_NODE=1`，
 *                           与官方桌面端同形：少一个未签名解释器镜像、体积小约 50 MB，
 *                           见 docs/ANTIVIRUS-FALSE-POSITIVE.md）；pnpm 仍随包，插件事务只走它。
 *                           构建期会下载一份便携 Node（nodejs.org + SHASUMS256 校验）当**工具链**用
 *                           （跑 npm 装 dsh 闭包），它不进安装包（electron-builder.yml 里 `!node/**`）。
 *   resources/dsh/       dsh 运行时树：`npm install @deepseek-ai/dsh@<ver>` 的完整生产依赖闭包，
 *                        外加本仓第一方包 dsh-desktop-bridge（插件）与 dsh-desktop-host（Host 入口），
 *                        末尾写 desktop-runtime.json（含每个文件的 sha256 清单）与
 *                        desktop-packages/（第一方 tarball，供 profile 事务引用）
 *
 * 版本绑定（官方「一个签名更新单元」原则）：dsh / node / pnpm 三个版本写在 package.json 的
 * `dshRuntime` 字段里——升级 dsh 就是改这个字段 + 发一次桌面端版本；壳启动时会校验
 * desktop-runtime.json 的 release 与自身版本/共享包是否一致，不一致直接拒绝启动（见 src/main/runtimeTree.ts）。
 *
 * 全部 npm 操作通过便携 Node 自带的 npm-cli.js 执行（不依赖 PATH 中的 npm/cmd）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 便携 Node + pnpm（与 dsh 树分开：升级 dsh 不必重下 Node）。 */
const runtimeDir = path.join(root, 'resources', 'runtime')
/** 不可变 dsh 运行时树（随包分发，启动时按 desktop-runtime.json 校验）。 */
const dshDir = path.join(root, 'resources', 'dsh')

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const dshRuntime = pkg.dshRuntime ?? {}
const DSH_VERSION = process.env.DSH_RUNTIME_DSH_VERSION ?? dshRuntime.dsh
const NODE_VERSION = process.env.DSH_RUNTIME_NODE_VERSION ?? dshRuntime.node
const PNPM_VERSION = process.env.DSH_RUNTIME_PNPM_VERSION ?? dshRuntime.pnpm
// 与 src/main/hostProcess.ts 的 DESKTOP_HOST_PROTOCOL_VERSION 一致；契约变化必须同时递增。
const HOST_PROTOCOL_VERSION = 4
/**
 * Office→PDF 原生引擎（LibreOffice，win32-x64 ≈ 325 MB / 2000 文件）默认随包**不**带：
 * 它只服务应用内文档预览，是本壳体积的绝对大头。需要预览的构建设 `DSH_DESKTOP_OFFICE_RUNTIME=1`。
 */
const OFFICE_RUNTIME = process.env.DSH_DESKTOP_OFFICE_RUNTIME === '1'
if (!DSH_VERSION || !NODE_VERSION || !PNPM_VERSION) {
  throw new Error('package.json 缺少 dshRuntime.{dsh,node,pnpm}（运行时版本绑定的唯一事实来源）')
}
/** 目标 Node 架构：默认宿主架构；交叉构建（x64 runner 上打 arm64 包）用 env 指定。 */
const NODE_ARCH = process.env.DSH_RUNTIME_NODE_ARCH ?? process.arch
/**
 * 随包解释器身份（Electron 版本 + 它内置的 Node 版本）。
 * 构建期就要读一次：descriptor 的 `release.electronVersion/nodeVersion` 记的是**运行时真正用的**解释器。
 */
const ELECTRON = electronIdentity()

const systemTar =
  process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : ''
const TAR = process.env.DSH_RUNTIME_TAR ?? (systemTar && existsSync(systemTar) ? systemTar : 'tar')

/** 工具 Node：npm 操作用宿主 Node 执行 npm-cli.js（目标架构 Node 跑不了）。 */
const toolNode = () => process.execPath

function run(cmd, args, opts = {}) {
  console.log(`[runtime] ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

const REG_NPMJS = 'https://registry.npmjs.org/'
const REG_NPMMIRROR = 'https://registry.npmmirror.com/'

/** 便携 Node 内的 npm-cli.js（Windows 在 node_modules/npm，macOS/Linux 在 lib/node_modules/npm）。 */
const npmCli = () => {
  const candidates = [
    path.join(runtimeDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(runtimeDir, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`npm-cli.js not found in portable node (tried: ${candidates.join(', ')})`)
  return found
}

/**
 * 执行一次 npm install：官方源失败自动切 npmmirror。
 * macOS 上 npm arborist 单线程建树会 OOM（V8 老年代），显式放大堆 + 降并发。
 */
function runNpmInstall(prefix, extraArgs) {
  const isDarwin = process.platform === 'darwin'
  const installEnv = isDarwin
    ? { ...process.env, NODE_OPTIONS: `--max-old-space-size=4096 ${process.env.NODE_OPTIONS ?? ''}`.trim() }
    : process.env
  const concurrency = isDarwin ? ['--maxsockets', '2'] : []
  const common = [npmCli(), 'install', '--no-audit', '--no-fund', '--loglevel=error', ...concurrency, '--fetch-retries', '3']
  let lastErr = null
  for (const reg of [REG_NPMJS, REG_NPMMIRROR]) {
    try {
      run(toolNode(), [...common, '--registry', reg, ...extraArgs, '--prefix', prefix], { env: installEnv })
      return
    } catch (err) {
      lastErr = err
      console.log(`[runtime] npm install（registry=${reg}）失败：${err?.message ?? err}，切换源重试…`)
    }
  }
  throw lastErr ?? new Error('npm install 多次失败')
}

/**
 * 随包解释器的身份：**pinned Electron 的版本 + 它内置的 Node 版本**。
 *
 * 0.8.7 起不再随包独立 `node.exe`：Host 与 pnpm 都由应用自身的 Electron 二进制以
 * `ELECTRON_RUN_AS_NODE=1` 运行（少一个未签名解释器镜像 = 少一分杀软行为误报，
 * 体积也少约 50 MB；harness 侧只认 Electron 43.0.0/44.0.0/45.0.0-alpha.6 的指纹，
 * 因此 package.json 把 electron 精确钉在 44.0.0）。descriptor 里如实记录这两个版本。
 */
function electronIdentity() {
  const manifest = path.join(root, 'node_modules', 'electron', 'package.json')
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version
  const exe = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : process.platform === 'darwin'
      ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : path.join(root, 'node_modules', 'electron', 'dist', 'electron')
  if (!existsSync(exe)) {
    // electron 的二进制由它自己的 postinstall 下载（`node_modules/electron/install.js`）。
    // 少数环境会跳过 postinstall（本地配置 / 缓存 / 代理失败），这里补一次，
    // 免得构建在"解释器缺失"上失败——那正是本版新引入的硬前提。
    console.log('[runtime] electron 二进制缺失 → 运行 electron/install.js 补装')
    run(process.execPath, [path.join(root, 'node_modules', 'electron', 'install.js')], { cwd: root })
  }
  if (!existsSync(exe)) {
    throw new Error(`随包解释器缺失：${exe}（先 npm install 把 electron@${version} 装好）`)
  }
  const nodeVersion = execFileSync(exe, ['-e', 'process.stdout.write(process.versions.node)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  }).trim()
  return { version, nodeVersion }
}

/* ── resources/runtime：便携 Node + pnpm ─────────────────────────────── */

async function installNode() {
  const nodeDir = path.join(runtimeDir, 'node')
  const archMarker = path.join(nodeDir, '.dsh-node-arch')
  let existingArch = null
  try {
    existingArch = readFileSync(archMarker, 'utf8').trim()
  } catch {
    /* 无标记 → 视为不匹配，重建 */
  }
  const exeOk = existsSync(path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'bin/node'))
  if (exeOk && existingArch === NODE_ARCH) {
    console.log(`[runtime] node ${NODE_VERSION} (${NODE_ARCH}) already present`)
    return
  }
  rmSync(nodeDir, { recursive: true, force: true })
  mkdirSync(nodeDir, { recursive: true })
  const plat = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const ext = process.platform === 'win32' ? 'zip' : process.platform === 'darwin' ? 'tar.gz' : 'tar.xz'
  const fileName = `node-${NODE_VERSION}-${plat}-${NODE_ARCH}.${ext}`
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${fileName}`
  console.log(`[runtime] downloading ${url}`)
  // 临时文件名必须以 .zip/.tar.gz 结尾：PowerShell Expand-Archive 只认扩展名
  const tmp = path.join(os.tmpdir(), `node-${NODE_VERSION}-${plat}-${NODE_ARCH}-${Date.now()}.${ext}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(tmp, buf)
  console.log(`[runtime] downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`)
  // 供应链校验：官方 SHASUMS256.txt（取不到时仅告警，不阻断离线镜像场景）
  let expectedSha = null
  try {
    const sumRes = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)
    if (sumRes.ok) {
      const line = (await sumRes.text()).split(/\r?\n/).find((l) => l.trim().endsWith(fileName))
      if (line) expectedSha = line.trim().split(/\s+/)[0] ?? null
    }
  } catch {
    /* ignore */
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
    run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path ${JSON.stringify(tmp)} -DestinationPath ${JSON.stringify(tmpDir)} -Force`,
    ])
  } else {
    run(TAR, ['-xf', tmp, '-C', tmpDir])
  }
  cpSync(path.join(tmpDir, `node-${NODE_VERSION}-${plat}-${NODE_ARCH}`), nodeDir, { recursive: true })
  writeFileSync(archMarker, `${NODE_ARCH}\n`, 'utf8')
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(tmp, { force: true })
  console.log(`[runtime] node extracted to ${nodeDir} (arch=${NODE_ARCH})`)
}

/** 复制仓库里的 pnpm 包（devDependency）到 runtime/pnpm —— 插件事务只用它，不碰系统 pnpm。 */
function installPnpm() {
  const src = path.join(root, 'node_modules', 'pnpm')
  if (!existsSync(path.join(src, 'package.json'))) {
    throw new Error(`pnpm 未安装：请先 npm install（需要 devDependency pnpm@${PNPM_VERSION}）`)
  }
  const version = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8')).version
  if (version !== PNPM_VERSION) {
    throw new Error(`pnpm 版本不匹配：node_modules=${version}，package.json.dshRuntime.pnpm=${PNPM_VERSION}`)
  }
  const dest = path.join(runtimeDir, 'pnpm')
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  console.log(`[runtime] pnpm ${version} -> ${dest}`)
}

/* ── resources/dsh：dsh 树 + 第一方包 + 完整性清单 ───────────────────── */

/** 第一方包源码树内容哈希（相对路径 + 内容；排除 node_modules/.git）。 */
function sourceHash(srcDir) {
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

/** 打包第一方包（npm pack）到 destDir，返回 tarball 文件名。 */
function packPackage(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  // 先构建产物（host 需要 lib/index.js；bridge 的 lib/ 就是源码，无构建步骤）
  const buildScript = path.join(srcDir, 'build.mjs')
  if (existsSync(buildScript)) {
    console.log(`[runtime] building ${path.basename(srcDir)} (build.mjs)`)
    run(toolNode(), [buildScript], { cwd: srcDir })
  }
  const before = new Set(readdirSync(destDir))
  run(toolNode(), [npmCli(), 'pack', '--pack-destination', destDir, '--silent', srcDir])
  const created = readdirSync(destDir).find((f) => f.endsWith('.tgz') && !before.has(f))
  if (!created) throw new Error(`npm pack 未产出 tarball: ${srcDir}`)
  return created
}

/** 递归列目录（相对路径）。 */
function walkFiles(dir, base = dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, base, out)
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

/** 按文件策略裁剪运行时树（只删构建/诊断残留与可选大件，运行时资源一律保留）。 */
function pruneRuntimeTree(target) {
  const nm = path.join(dshDir, 'node_modules')
  if (!existsSync(nm)) return
  let removed = 0
  const reasons = new Map()
  for (const rel of walkFiles(nm)) {
    const reason = desktopRuntimeFileExclusion(
      `node_modules/${rel}`,
      { platform: target.platform, arch: target.arch },
      { officeRuntime: OFFICE_RUNTIME },
    )
    if (reason === undefined) continue
    try {
      const size = statSync(path.join(nm, rel)).size
      rmSync(path.join(nm, rel), { force: true })
      removed += size
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    } catch {
      /* ignore */
    }
  }
  const dropEmpty = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      dropEmpty(full)
      try {
        if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
  dropEmpty(nm)
  const detail = [...reasons].map(([r, n]) => `${r}×${n}`).join(', ') || 'none'
  console.log(`[runtime] pruned ${(removed / 1024 / 1024).toFixed(1)} MB (${detail})`)
}

/** 写 desktop-runtime.json：release 身份 + 共享包 + 全量文件清单（sha256）。 */
function writeRuntimeDescriptor() {
  const sharedNames = ['@deepseek-ai/dsh', 'dsh-desktop-host', 'dsh-desktop-bridge']
  const sharedPackages = [...new Set(sharedNames)].sort().map((name) => {
    const dir = path.join(dshDir, 'node_modules', name)
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (manifest.name !== name || typeof manifest.version !== 'string') {
      throw new Error(`desktop runtime: invalid shared package manifest ${name}`)
    }
    return { name, version: manifest.version, path: `node_modules/${name}` }
  })
  const files = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(dshDir, full).split(path.sep).join('/')
      if (rel === 'desktop-runtime.json') continue
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (!entry.isFile()) throw new Error(`desktop runtime: unsupported filesystem entry ${rel}`)
      const body = readFileSync(full)
      files.push({
        path: rel,
        bytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
        executable: process.platform !== 'win32' && (statSync(full).mode & 0o111) !== 0,
      })
    }
  }
  visit(dshDir)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const descriptor = {
    schemaVersion: 1,
    release: {
      schemaVersion: 1,
      // 壳版本 = 桌面端发版号；dshVersion = 随包 harness 版本（同一次发版一起绑定）
      version: pkg.version,
      dshVersion: DSH_VERSION,
      hostProtocolVersion: HOST_PROTOCOL_VERSION,
      // 真正跑 harness 的解释器是随包 Electron（以 Node 模式运行），因此记录它与它内置的 Node，
      // 而不是构建期下载的那份便携 Node（那份只用于构建时 npm 操作，不进安装包）。
      electronVersion: ELECTRON.version,
      nodeVersion: ELECTRON.nodeVersion,
      pnpmVersion: PNPM_VERSION,
    },
    platform: process.platform,
    arch: NODE_ARCH,
    sharedPackages,
    files,
  }
  writeFileSync(path.join(dshDir, 'desktop-runtime.json'), `${JSON.stringify(descriptor, undefined, 2)}\n`)
  console.log(
    `[runtime] desktop-runtime.json written: ${files.length} files, shared=[${sharedPackages.map((p) => `${p.name}@${p.version}`).join(', ')}]`,
  )
}

/** 安装 dsh 闭包 + 第一方包（tarball 留在 desktop-packages/ 供 profile 事务引用）。 */
function installDshTree(target) {
  const packagesDir = path.join(dshDir, 'desktop-packages')
  const bridgeTgz = packPackage(path.join(root, 'packages', 'bridge'), packagesDir)
  const hostTgz = packPackage(path.join(root, 'packages', 'host'), packagesDir)
  const bridgeManifest = JSON.parse(readFileSync(path.join(root, 'packages', 'bridge', 'package.json'), 'utf8'))
  const hostManifest = JSON.parse(readFileSync(path.join(root, 'packages', 'host', 'package.json'), 'utf8'))
  if (hostManifest.version !== DSH_VERSION) {
    // 官方同款约束：Host 与 dsh 版本必须一致（Host 直接使用 dsh 的内部服务契约）
    throw new Error(
      `packages/host 版本 ${hostManifest.version} 与 dshRuntime.dsh ${DSH_VERSION} 不一致：请同步 bump（一个签名更新单元）`,
    )
  }
  for (const [name, spec] of Object.entries(hostManifest.dependencies ?? {})) {
    // 只有 dsh 发行线（@deepseek-ai/dsh 与 @deepseek-ai/dsh-*）必须与随包 dsh 同版本；
    // cordis 等同作用域下的框架包是独立版本线，精确锁定即可
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (spec !== DSH_VERSION) {
      throw new Error(`packages/host 依赖 ${name}@${spec} 未锁到 ${DSH_VERSION}（版本绑定要求精确版本）`)
    }
  }
  writeFileSync(
    path.join(dshDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-desktop-runtime',
        private: true,
        version: '0.0.0',
        dependencies: {
          '@deepseek-ai/dsh': DSH_VERSION,
          'dsh-desktop-bridge': `file:./desktop-packages/${bridgeTgz}`,
          'dsh-desktop-host': `file:./desktop-packages/${hostTgz}`,
        },
      },
      null,
      2,
    ),
  )
  runNpmInstall(dshDir, [])
  const dist = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
  if (!existsSync(dist)) throw new Error(`frontend dist missing: ${dist} —— dsh-web-app 无法 serve UI`)
  // Host 只随包一个构建产物：桌面补丁层已在第三轮移除（Host 以 `patchFiles: []` 启动，
  // 与官方 desktop-host 同形），config/ 目录不再存在——别在这里加回死文件检查。
  for (const rel of ['lib/index.js']) {
    const f = path.join(dshDir, 'node_modules', 'dsh-desktop-host', rel)
    if (!existsSync(f)) throw new Error(`missing Host runtime file: ${f}`)
  }
  const installed = JSON.parse(readFileSync(path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  if (installed.version !== DSH_VERSION) {
    throw new Error(`dsh 版本不符：期望 ${DSH_VERSION}，实际 ${installed.version}`)
  }
  console.log(
    `[runtime] dsh@${installed.version} + ${bridgeManifest.name}@${bridgeManifest.version} + ${hostManifest.name}@${hostManifest.version} installed`,
  )
  pruneRuntimeTree(target)
  writeRuntimeDescriptor()
}

/* ── 增量与主流程 ──────────────────────────────────────────────────── */

// 增量缓存放在 dsh 树**外面**：树里的每个文件都要进 desktop-runtime.json 的 sha256 清单，
// 构建后再往树里写文件会让「清单 vs 实际」对不上、启动校验报 integrity failed。
const CACHE_FILE = path.join(root, 'resources', '.dsh-runtime-cache.json')

async function main() {
  const target = { platform: process.platform, arch: NODE_ARCH }
  console.log(
    `[runtime] office PDF engine: ${OFFICE_RUNTIME ? 'included' : 'excluded'}`
      + (OFFICE_RUNTIME ? '' : '（默认剔除；需要应用内 docx/xlsx/pptx 预览时设 DSH_DESKTOP_OFFICE_RUNTIME=1）'),
  )
  const bridgeHash = sourceHash(path.join(root, 'packages', 'bridge'))
  const hostHash = sourceHash(path.join(root, 'packages', 'host'))
  const key = {
    dsh: DSH_VERSION,
    node: NODE_VERSION,
    pnpm: PNPM_VERSION,
    arch: NODE_ARCH,
    bridge: bridgeHash,
    host: hostHash,
    shell: pkg.version,
    // 打包策略也进缓存键：切换 Office 引擎随包与否必须重建，不能命中旧树。
    officeRuntime: OFFICE_RUNTIME,
  }

  // 先备齐便携 Node + pnpm：npm 操作要用便携 Node 自带的 npm-cli.js（不依赖系统 npm）
  await installNode()
  installPnpm()

  let cached = null
  try {
    cached = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
  } catch {
    /* 无缓存 */
  }
  // shell 版本变化也重建：desktop-runtime.json 记录的是本次壳版本（版本绑定）
  const same = cached && Object.keys(key).every((k) => cached[k] === key[k])
  const treeOk =
    same &&
    existsSync(path.join(dshDir, 'desktop-runtime.json')) &&
    existsSync(path.join(dshDir, 'node_modules', 'dsh-desktop-host', 'lib', 'index.js')) &&
    existsSync(path.join(dshDir, 'node_modules', 'dsh-desktop-bridge', 'lib', 'index.js'))
  if (treeOk) {
    console.log(
      `[runtime] incremental: dsh@${DSH_VERSION} node=${NODE_ARCH} bridge=${bridgeHash} host=${hostHash} already installed`,
    )
  } else {
    if (cached) console.log('[runtime] cache mismatch -> rebuild')
    rmSync(dshDir, { recursive: true, force: true })
    mkdirSync(dshDir, { recursive: true })
    installDshTree(target)
    writeFileSync(CACHE_FILE, `${JSON.stringify(key, null, 2)}\n`)
  }
  writeFileSync(
    path.join(runtimeDir, 'versions.json'),
    // 运行时真正用的解释器 = 随包 Electron（以 Node 模式跑 Host 与 pnpm）；
    // 构建期便携 Node 只是工具链，写在这里会让人误以为它在安装包里。
    `${JSON.stringify(
      { schemaVersion: 1, electron: ELECTRON.version, node: ELECTRON.nodeVersion, pnpm: PNPM_VERSION, toolchainNode: NODE_VERSION },
      null,
      2,
    )}\n`,
  )
  console.log(`[runtime] done -> ${runtimeDir} + ${dshDir}`)
}

await main()
