/**
 * dsh-desktop-better-setting · Host 半边
 *
 * 桌面端插件管理系统（四类分区：官方 / 桌面 / 用户 / 市场）+ 个性化设置。
 *
 * 通过 connection RPC（channel `/pm-rpc`）暴露给浏览器半边：
 *  - `list`：枚举四类插件
 *      · 官方：harness 的 pluginInventory 服务（Loader 条目，只读投影）
 *      · 桌面：壳打包内置（config.bundledPluginsDir）
 *      · 用户：用户安装（config.userPluginsDir）
 *  - `setEnabled(name, enabled)`：读写壳 settings.json 的 disabledPlugins
 *    （bridge 永远启用）；改动后需重启 Harness 生效（界面提示）。
 *  - `market.search(query)`：GitHub topic dsh-plugin 仓库搜索
 *  - `market.install(owner/repo)`：下载 release zip 到 userPluginsDir（骨架）
 *  - `personalization.*`：个性化设置的读写与壁纸管理
 *
 * 目录/设置路径由壳在 overlay config 注入（src/main/index.ts regenerateOverlay）。
 * RPC 参数容错：payload 可能是 { args } 或直接对象，两处都取。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, createReadStream } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { join, resolve, normalize, basename } from 'node:path'
import path from 'node:path'

export const name = 'dsh-desktop-better-setting'

/**
 * 需要 connection（RPC 通道）与 webServer（壁纸媒体同源 HTTP 流式路由，
 * 参考 dsh-wallpaper-engine 的实现方式：inventory + media/Range）。
 */
export const inject = ['connection', 'webServer']

const GITHUB_SEARCH = 'https://api.github.com/search/repositories'

/** 壁纸媒体服务的 HTTP 路由前缀（webServer 注册，同源）。 */
const WALLPAPER_BASE = '/dsh-desktop-wallpapers'

/** 防御读取 JSON。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 扫描插件目录：子目录且含 package.json → { name, version, dir }。 */
function scanPlugins(dir) {
  if (!dir || !existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const pkgDir = path.join(dir, entry)
    try {
      if (!statSync(pkgDir).isDirectory()) continue
      const pkg = readJson(path.join(pkgDir, 'package.json'))
      if (!pkg || typeof pkg.name !== 'string') continue
      out.push({ name: pkg.name, version: pkg.version ?? null, dir: entry })
    } catch {
      /* skip */
    }
  }
  return out
}

/** 读壳 settings.json 的 disabledPlugins。 */
function readDisabled(config) {
  const s = readJson(config?.settingsFile ?? '')
  return Array.isArray(s?.disabledPlugins) ? s.disabledPlugins.filter((x) => typeof x === 'string') : []
}

/** 写壳 settings.json 的 disabledPlugins（保留其余字段）。 */
function writeDisabled(config, list) {
  const file = config?.settingsFile
  if (!file) return false
  const s = readJson(file) ?? {}
  s.disabledPlugins = list
  try {
    writeFileSync(file, JSON.stringify(s, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 官方插件：pluginInventory 服务（Loader 只读投影）。 */
function listOfficialPlugins(ctx) {
  const svc = ctx.get('pluginInventory')
  if (svc && typeof svc.list === 'function') {
    try {
      const res = svc.list()
      const entries = res?.entries ?? res
      if (Array.isArray(entries)) {
        return entries.map((e) => ({
          entryId: typeof e?.entryId === 'string' ? e.entryId : null,
          moduleName: typeof e?.moduleName === 'string' ? e.moduleName : null,
          enabled: e?.enabled !== false,
          fiberPhase: typeof e?.fiberPhase === 'string' ? e.fiberPhase : null,
          source: 'official',
        }))
      }
    } catch {
      /* ignore */
    }
  }
  return []
}

/** 官方插件分类：按 moduleName 前缀分组。 */
const OFFICIAL_CATEGORIES = [
  { id: 'ui', label: 'UI', match: (n) => /^@deepseek-ai\/dsh-client-ui-|^@deepseek-ai\/dsh-client-/.test(n) },
  { id: 'settings', label: '设置', match: (n) => /settings|config/.test(n) },
  { id: 'tool', label: '工具', match: (n) => /^@deepseek-ai\/dsh-tool-|^@deepseek-ai\/dsh-tool$/.test(n) },
  { id: 'llm', label: '模型', match: (n) => /llm|model/.test(n) },
  { id: 'session', label: '会话', match: (n) => /session/.test(n) },
  { id: 'agent', label: 'Agent', match: (n) => /agent|subagent/.test(n) },
  { id: 'storage', label: '存储', match: (n) => /storage|persistence|attachment/.test(n) },
  { id: 'web', label: '网络', match: (n) => /web|api|remote|proxy/.test(n) },
  { id: 'core', label: '核心', match: () => true },
]

function categorizeOfficial(moduleName) {
  const n = moduleName || ''
  for (const cat of OFFICIAL_CATEGORIES) {
    if (cat.match(n)) return cat
  }
  return OFFICIAL_CATEGORIES[OFFICIAL_CATEGORIES.length - 1]
}

/** 市场条目过滤：纯本地启发式（不依赖 raw.githubusercontent 可达性）。 */
function looksLikePlugin(item) {
  const fullName = item?.full_name ?? ''
  const name = (fullName.split('/')[1] ?? '').toLowerCase()
  const desc = String(item?.description ?? '')
  const topics = Array.isArray(item?.topics) ? item.topics.join(' ') : ''
  const hint = name + ' ' + desc + ' ' + topics
  // 硬黑名单：harness 本体与知名非插件项目
  const blocked = [
    'deepseek-harness', 'open-design', 'reactive-resume', 'yao', 'petdex',
    'voyager', 'ouroboros', 'openpencil', 'archify', 'openviking',
    'mirage', 'colleague-skill', 'ipollo', 'echo-bird', 'vibe-skills',
  ]
  if (blocked.includes(name)) return false
  // dsh-* / *-plugin / *-harness 命名视为插件
  if (/^dsh[-/]/.test(name)) return true
  if (/plugin|harness/i.test(name)) return true
  // 描述/topic 含插件特征
  if (/(dsh plugin|harness plugin|dsh-|deepseek harness plugin|for deepseek harness|deepseek-harness plugin)/i.test(hint)) return true
  return false
}

/** GitHub 仓库搜索：topic:dsh-plugin。无关键词时返回默认 Top15（按 star 排序，过滤非插件）。 */
async function marketSearch(query) {
  const q = ['topic:dsh-plugin']
  if (typeof query === 'string' && query.trim()) q.push(query.trim())
  const perPage = typeof query === 'string' && query.trim() ? 50 : 30
  const url = `${GITHUB_SEARCH}?q=${encodeURIComponent(q.join(' '))}&sort=stars&order=desc&per_page=${perPage}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop' },
      signal: ctrl.signal,
    })
    if (!res.ok) return { status: 'error', message: `GitHub API ${res.status}` }
    const data = await res.json()
    const raw = Array.isArray(data?.items) ? data.items : []
    const items = raw
      .filter(looksLikePlugin)
      .slice(0, typeof query === 'string' && query.trim() ? 30 : 15)
      .map((r) => ({
        fullName: r?.full_name ?? r?.name ?? '?',
        description: r?.description ?? null,
        stars: r?.stargazers_count ?? 0,
        url: r?.html_url ?? null,
        updatedAt: r?.updated_at ?? null,
      }))
    return { status: 'ok', items }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(t)
  }
}

/** 解压 zip 到临时目录（Windows 用 tar，macOS/Linux 用 unzip）。 */
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'tar' : 'unzip'
    const args = isWin ? ['-xf', zipPath, '-C', destDir] : ['-q', '-o', zipPath, '-d', destDir]
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', (e) => reject(e))
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${String(code)}`))))
  })
}

/**
 * 从市场安装插件：按官方文档命令安装。
 *   git 仓库：dsh plugin --profile <name> add github:owner/repo
 *   npm 包：  dsh plugin --profile <name> add <pkg>
 * （官方 publish 文档：https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish）
 */
async function marketInstall(repo, config) {
  const target = typeof repo === 'string' ? repo.trim() : ''
  if (!target) return { status: 'error', message: 'missing repo/package' }
  const profile = config?.profileName ?? 'desktop'
  const dshHome = config?.dshHome
  const dshBin = config?.dshBin
  if (!dshBin || !dshHome) return { status: 'error', message: 'dsh CLI 路径未注入（dshBin/dshHome）' }

  // 参数规范化：owner/repo → github:owner/repo；否则视为 npm 包名
  const spec = /^[^/]+\/[^/]+$/.test(target) && !target.startsWith('github:') ? `github:${target}` : target

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [dshBin, 'plugin', '--profile', profile, 'add', spec], {
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (c) => { out += String(c) })
    child.stderr?.on('data', (c) => { err += String(c) })
    const t = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve({ status: 'error', message: '安装超时（30s）' })
    }, 30_000)
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ status: 'error', message: `无法执行 dsh: ${e.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(t)
      const detail = (out + err).trim().slice(-600)
      if (code === 0) {
        resolve({ status: 'ok', message: `已按官方命令安装 ${spec}（重启 Harness 生效）`, detail })
      } else {
        resolve({ status: 'error', message: `安装失败（exit ${String(code)}）: ${detail || '无输出'}` })
      }
    })
  })
}

/** 递归查找包含 package.json 的插件包目录（优先找 name 形如 dsh-* 的）。 */
function findPluginPackageDir(root) {
  const candidates = []
  const walk = (dir) => {
    let entries
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
      if (isDir) {
        if (existsSync(path.join(full, 'package.json'))) candidates.push(full)
        walk(full)
      }
    }
  }
  walk(root)
  if (candidates.length === 0) return null
  // 优先包名以 dsh- 开头的；否则取第一个
  return candidates.find((c) => {
    const pkg = readJson(path.join(c, 'package.json'))
    return typeof pkg?.name === 'string' && pkg.name.startsWith('dsh-')
  }) ?? candidates[0]
}

/** 递归复制目录（mkdir + 文件写入）。 */
function copyDirTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const s = path.join(src, entry)
    const d = path.join(dest, entry)
    let isDir = false
    try {
      isDir = statSync(s).isDirectory()
    } catch {
      continue
    }
    if (isDir) copyDirTree(s, d)
    else writeFileSync(d, readFileSync(s))
  }
}

/** 卸载用户插件：按官方命令 dsh plugin --profile <name> remove <pkg>。 */
async function userUninstall(name, config) {
  if (typeof name !== 'string' || !name) return { status: 'error', message: 'missing name' }
  if (name === 'dsh-desktop-bridge') return { status: 'error', message: 'bridge 为必需插件，不可删除' }
  const profile = config?.profileName ?? 'desktop'
  const dshHome = config?.dshHome
  const dshBin = config?.dshBin
  if (!dshBin || !dshHome) return { status: 'error', message: 'dsh CLI 路径未注入（dshBin/dshHome）' }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [dshBin, 'plugin', '--profile', profile, 'remove', name], {
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (c) => { out += String(c) })
    child.stderr?.on('data', (c) => { err += String(c) })
    const t = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve({ status: 'error', message: '删除超时（30s）' })
    }, 30_000)
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ status: 'error', message: `无法执行 dsh: ${e.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(t)
      const detail = (out + err).trim().slice(-400)
      if (code === 0) {
        resolve({ status: 'ok', message: `已删除 ${name}（重启 Harness 生效）`, detail })
      } else {
        resolve({ status: 'error', message: `删除失败（exit ${String(code)}）: ${detail || '无输出'}` })
      }
    })
  })
}

/** 从 payload 容错取参：{args:{...}} / {name:..} / 直接参数。 */
function argOf(payload, key) {
  const v = payload?.args?.[key] ?? payload?.[key] ?? payload?.[0]?.[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * 保存壁纸：base64 data URL -> userData/wallpapers/<name>。
 * 支持图片（png/jpg/gif/webp）、视频（mp4/webm）与 HTML 壁纸。
 * 路径由壳注入（config.wallpaperDir，index.ts regenerateOverlay 注入 userData/wallpapers）。
 */
async function saveWallpaper(name, dataUrl, config) {
  const dir = config?.wallpaperDir
  if (!dir) return { status: 'error', message: 'wallpaperDir 未配置' }
  const safe = String(name || '').replace(/[^\w.-]/g, '_')
  if (!safe) return { status: 'error', message: 'missing name' }
  const m = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ''))
  if (!m) return { status: 'error', message: 'invalid data url' }
  try {
    mkdirSync(dir, { recursive: true })
    const ext = (m[1].split('/')[1] || 'bin').replace('jpeg', 'jpg').split('+')[0]
    // 文件名里可能已带同类后缀（如 clip.mp4），追加新后缀前先剥离，避免 clip.mp4.mp4
    const base = safe.replace(/\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|m4v|html?)$/i, '')
    const file = path.join(dir, `${base}.${ext}`)
    writeFileSync(file, Buffer.from(m[2], 'base64'))
    return { status: 'ok', message: `壁纸已保存 ${file}`, file }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** 列出已保存壁纸。 */
async function listWallpapers(config) {
  const dir = config?.wallpaperDir
  if (!dir || !existsSync(dir)) return { status: 'ok', items: [] }
  try {
    const items = []
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) continue
      items.push({ name: entry, size: statSync(full).size, file: full })
    }
    return { status: 'ok', items }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** 删除壁纸。 */
async function removeWallpaper(name, config) {
  const dir = config?.wallpaperDir
  if (!dir) return { status: 'error', message: 'wallpaperDir 未配置' }
  const safe = String(name || '').replace(/[^\w.-]/g, '_')
  if (!safe) return { status: 'error', message: 'missing name' }
  try {
    rmSync(path.join(dir, safe), { force: true })
    return { status: 'ok', message: `已删除 ${safe}` }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** 个性化设置的默认值（skin/accent 为壳独有；壁纸与玻璃旋钮对齐参考实现）。 */
const DEFAULT_PERSONALIZATION = {
  skin: 'default',
  accent: null,
  wallpaper: null, // { source: 'custom'|'we', id: string } | null
  blur: 24,        // 玻璃（面板模糊半径 px）
  wallpaperBlur: 0, // 壁纸自身模糊 px
  scrim: 0.25,     // 暗化遮罩 0..1
  border: 0.35,    // 边框强调 0..1
  playing: true,
}

/** 读 settings.json 的 personalization 字段（缺省合并默认值）。 */
function readPersonalization(config) {
  const s = readJson(config?.settingsFile ?? '')
  const p = s?.personalization
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { ...DEFAULT_PERSONALIZATION }
  return { ...DEFAULT_PERSONALIZATION, ...p }
}

/** 写 settings.json 的 personalization 字段（保留其余字段）。 */
function writePersonalization(config, next) {
  const file = config?.settingsFile
  if (!file) return false
  const s = readJson(file) ?? {}
  const merged = { ...readPersonalization(config), ...(typeof next === 'object' && next !== null ? next : {}) }
  s.personalization = merged
  try {
    writeFileSync(file, JSON.stringify(s, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 读取壁纸文件内容并编码为 data URL（图片/视频/HTML 均可，客户端直接用于预览/应用）。 */
function readWallpaperData(name, config) {
  const dir = config?.wallpaperDir
  if (!dir) return { status: 'error', message: 'wallpaperDir 未配置' }
  const safe = String(name || '').replace(/[^\w.-]/g, '_')
  if (!safe) return { status: 'error', message: 'missing name' }
  const file = path.join(dir, safe)
  if (!existsSync(file)) return { status: 'error', message: 'wallpaper not found' }
  const ext = path.extname(safe).toLowerCase().replace(/^\./, '')
  const mime = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    html: 'text/html', htm: 'text/html',
  }[ext] ?? 'application/octet-stream'
  try {
    const buf = statSync(file).size > 0 ? readFileSync(file) : Buffer.alloc(0)
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    return { status: 'ok', dataUrl, mime, size: buf.length }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

// ── Wallpaper Engine 发现（参考 dsh-wallpaper-engine 的实现方式，MIT） ──────────

/** Steam appid for Wallpaper Engine. */
const WE_APPID = '431960'
/** 常见 Steam 安装目录探测列表（libraryfolders.vdf 缺失时兜底）。 */
const STEAM_PROBE_DIRS = [
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
  'D:\\Steam',
  'D:\\SteamLibrary',
  'E:\\SteamLibrary',
]

/** 从注册表读 Steam 根目录（Windows 安装器记录的权威路径）。 */
function steamPathFromRegistry() {
  if (process.platform !== 'win32') return null
  try {
    const reg = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
    const out = execFileSync(
      reg,
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out)
    return m ? normalize(m[1].trim()) : null
  } catch { return null }
}

/** 探测目录：注册表 Steam 根排最前。 */
function steamProbeDirs() {
  const reg = steamPathFromRegistry()
  return reg ? [reg, ...STEAM_PROBE_DIRS] : STEAM_PROBE_DIRS
}

/** 解析 libraryfolders.vdf（Valve KeyValues 简化版）：拥有 WE 的库目录。 */
function librariesFromVdf(vdfPath) {
  const text = readFileSync(vdfPath, 'utf8')
  const libs = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*"path"\s+"([^"]+)"\s*$/.exec(line)
    if (m) { current = m[1].replace(/\\\\/g, '\\'); continue }
    if (current && line.includes(WE_APPID) && !libs.includes(current)) libs.push(current)
  }
  return libs
}

/** 拥有 WE 的库目录集合（workshop 内容根）。 */
function owningLibraries() {
  const libs = []
  for (const probe of steamProbeDirs()) {
    const vdf = join(probe, 'steamapps', 'libraryfolders.vdf')
    if (existsSync(vdf)) { try { libs.push(...librariesFromVdf(vdf)) } catch { /* skip */ } }
  }
  return [...new Set(libs)]
}

/** 定位 WE 安装目录（存在 wallpaper32.exe 即命中）。 */
function locateWallpaperEngine() {
  const candidates = []
  const libraries = []
  for (const probe of steamProbeDirs()) {
    const vdf = join(probe, 'steamapps', 'libraryfolders.vdf')
    if (existsSync(vdf)) { try { libraries.push(...librariesFromVdf(vdf)) } catch { /* skip */ } }
  }
  for (const root of [...steamProbeDirs(), ...libraries]) candidates.push(join(root, 'steamapps', 'common', 'wallpaper_engine'))
  candidates.push('C:\\Program Files (x86)\\Wallpaper Engine')
  const seen = new Set()
  for (const raw of candidates) {
    const dir = normalize(raw)
    if (seen.has(dir)) continue
    seen.add(dir)
    if (existsSync(join(dir, 'wallpaper32.exe'))) return dir
  }
  return null
}

function weInferType(file) {
  if (/\.(mp4|webm|mkv|avi|mov)$/i.test(file)) return 'video'
  if (/\.(html?|js)$/i.test(file)) return 'web'
  return 'scene'
}

const WE_KINDS = ['scene', 'video', 'web', 'application']

function readWeProject(dir) {
  const pj = join(dir, 'project.json')
  if (!existsSync(pj)) return null
  try {
    const o = JSON.parse(readFileSync(pj, 'utf8'))
    if (!o || typeof o !== 'object' || !o.file) return null
    let type = typeof o.type === 'string' ? o.type.toLowerCase() : weInferType(o.file)
    if (!WE_KINDS.includes(type)) type = 'scene'
    return {
      id: basename(dir),
      title: typeof o.title === 'string' ? o.title : basename(dir),
      type,
      file: o.file,
      preview: typeof o.preview === 'string' ? o.preview : null,
    }
  } catch { return null }
}

/** 枚举 WE 壁纸：defaultprojects/myprojects + workshop/content/431960。 */
function enumerateWeWallpapers(installDir, libraryDirs) {
  const found = new Map()
  const roots = []
  if (installDir) {
    for (const sub of ['defaultprojects', 'myprojects']) {
      const p = join(installDir, 'projects', sub)
      if (existsSync(p)) roots.push(p)
    }
  }
  for (const lib of libraryDirs) {
    const ws = join(lib, 'steamapps', 'workshop', 'content', WE_APPID)
    if (existsSync(ws)) roots.push(ws)
  }
  for (const root of roots) {
    let entries = []
    try { entries = readdirSync(root) } catch { continue }
    for (const entry of entries) {
      const dir = join(root, entry)
      let st
      try { st = statSync(dir) } catch { continue }
      if (!st.isDirectory()) continue
      const proj = readWeProject(dir)
      if (!proj || found.has(proj.id)) continue
      proj.fileAbs = resolve(dir, proj.file)
      found.set(proj.id, proj)
    }
  }
  return [...found.values()].sort((a, b) => (a.title || '').localeCompare(b.title || ''))
}

/** 文件扩展名 → MIME（流式响应用）。 */
function mimeFor(absPath) {
  const ext = absPath.slice(absPath.lastIndexOf('.') + 1).toLowerCase()
  return {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    avi: 'video/x-msvideo', mov: 'video/quicktime',
    html: 'text/html', htm: 'text/html', js: 'text/javascript',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    png: 'image/png', webp: 'image/webp',
  }[ext] || 'application/octet-stream'
}

/**
 * 构建壁纸 inventory（custom + WE），并填充 media 映射。
 * token 为绝对路径的 base64url —— 路由只暴露客户端能从 inventory 拿到的 token，
 * 不会泄露任意文件系统路径。
 */
function buildWallpaperInventory(config, mediaMap) {
  // 自上传壁纸（userData/wallpapers）
  const custom = []
  const dir = config?.wallpaperDir
  if (dir && existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { continue }
      if (isDir) continue
      if (!/\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|m4v|html?)$/i.test(entry)) continue
      const type = /\.(mp4|webm|mov|m4v)$/i.test(entry) ? 'video' : /\.(html?)$/i.test(entry) ? 'web' : 'image'
      const token = Buffer.from(full, 'utf8').toString('base64url')
      mediaMap.set(token, full)
      custom.push({ id: `custom:${entry}`, title: entry, type, playable: true, media: `${WALLPAPER_BASE}/media/${token}` })
    }
  }
  custom.sort((a, b) => a.title.localeCompare(b.title))

  // Wallpaper Engine（仅可移植类型：video/web；scene/application 不可内嵌）
  const weInstallDir = locateWallpaperEngine()
  const weLibraryDirs = owningLibraries()
  const we = []
  for (const w of enumerateWeWallpapers(weInstallDir, weLibraryDirs)) {
    if (w.type !== 'video' && w.type !== 'web') continue
    const abs = w.fileAbs
    if (!existsSync(abs)) continue
    const token = Buffer.from(abs, 'utf8').toString('base64url')
    mediaMap.set(token, abs)
    we.push({ id: `we:${w.id}`, title: `${w.title}（WE）`, type: w.type, playable: true, media: `${WALLPAPER_BASE}/media/${token}` })
  }
  we.sort((a, b) => a.title.localeCompare(b.title))

  return { custom, we, weInstallDir: weInstallDir || null }
}

/** 流式响应（支持 Range，供 <video> 拖动/seek）。 */
function serveFile(absPath, req, res) {
  if (!absPath || !existsSync(absPath)) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  const st = statSync(absPath)
  res.setHeader('Content-Type', mimeFor(absPath))
  res.setHeader('Accept-Ranges', 'bytes')
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1
    if (Number.isNaN(start)) start = 0
    if (Number.isNaN(end) || end >= st.size) end = st.size - 1
    if (start > end) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${st.size}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`)
    res.setHeader('Content-Length', String(end - start + 1))
    createReadStream(absPath, { start, end }).pipe(res)
    return
  }
  res.setHeader('Content-Length', String(st.size))
  createReadStream(absPath).pipe(res)
}

/** 导出供测试/复用：个性化持久化与壁纸纯函数（与应用无关）。 */
export {
  DEFAULT_PERSONALIZATION,
  readPersonalization,
  writePersonalization,
  saveWallpaper,
  listWallpapers,
  removeWallpaper,
  readWallpaperData,
  buildWallpaperInventory,
  serveFile,
}

export function apply(ctx, config) {
  // ── 壁纸媒体同源 HTTP 流式路由（参考 dsh-wallpaper-engine）：
  //    inventory JSON + media/<token>（Range 支持，<video> 可拖动/seek）。
  ctx.effect(() => {
    const webServer = ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    const mediaMap = new Map()
    const disposers = []
    disposers.push(webServer.register({
      kind: 'exact',
      path: `${WALLPAPER_BASE}/inventory`,
      handler: (req, res) => {
        try {
          const payload = JSON.stringify({
            ...buildWallpaperInventory(config, mediaMap),
            weAvailable: !!locateWallpaperEngine(),
          })
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(payload)
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }))
        }
      },
    }))
    disposers.push(webServer.register({
      kind: 'prefix',
      path: `${WALLPAPER_BASE}/media`,
      handler: (req, res) => {
        const pathname = new URL(req.url || '/', 'http://x').pathname
        const token = decodeURIComponent(pathname.slice(`${WALLPAPER_BASE}/media/`.length))
        serveFile(mediaMap.get(token), req, res)
      },
    }))
    return () => {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
      mediaMap.clear()
    }
  }, 'dsh-desktop-better-setting: wallpaper media routes')

  ctx.effect(
    () =>
      // 注意：channel 用 /pm-rpc（不能与 ui-dashboard 等已注册的 /rpc 共享前缀路由冲突；
      // 每个 connection.rpc.handle 注册一个 webServer prefix 路由，同 channel 只能注册一次）
      ctx.connection.rpc.handle(
        '/pm-rpc',
        async (endpoint, payload) => {
          if (endpoint === 'list') {
            const disabled = new Set(readDisabled(config))
            const decorate = (p) => ({
              ...p,
              enabled: p.name === 'dsh-desktop-bridge' || !disabled.has(p.name),
              locked: p.name === 'dsh-desktop-bridge',
            })
            // bundled：优先用壳注入的清单（asar 内目录 harness 读不到，壳枚举后注入）；
            // 兜底：直接扫描 bundledPluginsDir（dev 或非 asar 场景）
            let bundled = Array.isArray(config?.bundledPlugins) ? config.bundledPlugins : []
            if (bundled.length === 0 && config?.bundledPluginsDir) {
              bundled = scanPlugins(config.bundledPluginsDir).map((p) => ({ ...p, source: 'bundled' }))
            }
            const user = scanPlugins(config?.userPluginsDir).map((p) => decorate({ ...p, source: 'user' }))
            // 已安装插件（bundled + user）从官方列表排除，避免重复展示
            const installedNames = new Set([
              ...bundled.map((p) => p.name),
              ...user.map((p) => p.name),
            ])
            const official = listOfficialPlugins(ctx)
              .filter((p) => !installedNames.has(p.moduleName ?? p.name))
              .map((p) => ({ ...p, category: categorizeOfficial(p.moduleName ?? p.name) }))
            // 官方插件按分类聚合
            const officialByCategory = {}
            for (const o of official) {
              const cid = o.category?.id ?? 'core'
              if (!officialByCategory[cid]) officialByCategory[cid] = []
              officialByCategory[cid].push(o)
            }
            return {
              ok: true,
              value: {
                appVersion: config?.appVersion ?? null,
                officialCategories: OFFICIAL_CATEGORIES.map((c) => ({
                  id: c.id,
                  label: c.label,
                  plugins: officialByCategory[c.id] ?? [],
                })).filter((c) => c.plugins.length > 0),
                official,
                bundled: bundled.map((p) => decorate({ ...p, source: p.source ?? 'bundled' })),
                user,
              },
            }
          }
          if (endpoint === 'setEnabled') {
            const name = argOf(payload, 'name')
            const enabled = payload?.args?.enabled ?? payload?.enabled
            if (!name) return { ok: false, error: { code: 'invalid', message: 'missing name' } }
            if (name === 'dsh-desktop-bridge') {
              return { ok: false, error: { code: 'locked', message: 'bridge 为必需插件，不可禁用' } }
            }
            const disabled = readDisabled(config)
            const next = enabled ? disabled.filter((x) => x !== name) : disabled.includes(name) ? disabled : [...disabled, name]
            const wrote = writeDisabled(config, next)
            if (!wrote) return { ok: false, error: { code: 'internal', message: 'settings.json 写入失败' } }
            return { ok: true, value: { name, enabled: !!enabled, restartRequired: true } }
          }
          if (endpoint === 'market.search') {
            const query = argOf(payload, 'query')
            const r = await marketSearch(query)
            return r.status === 'ok'
              ? { ok: true, value: r }
              : { ok: false, error: { code: 'internal', message: r.message } }
          }
          if (endpoint === 'market.install') {
            const repo = argOf(payload, 'repo')
            const r = await marketInstall(repo, config)
            return r.status === 'ok'
              ? { ok: true, value: r }
              : { ok: false, error: { code: 'internal', message: r.message } }
          }
          if (endpoint === 'user.uninstall') {
            const name = argOf(payload, 'name')
            const r = await userUninstall(name, config)
            return r.status === 'ok'
              ? { ok: true, value: r }
              : { ok: false, error: { code: 'internal', message: r.message } }
          }
          if (endpoint === 'personalization.saveWallpaper') {
            const name = argOf(payload, 'name')
            const dataUrl = argOf(payload, 'dataUrl')
            const r = await saveWallpaper(name, dataUrl, config)
            return r.status === 'ok'
              ? { ok: true, value: r }
              : { ok: false, error: { code: 'internal', message: r.message } }
          }
          if (endpoint === 'personalization.listWallpapers') {
            const r = await listWallpapers(config)
            return r.status === 'ok'
              ? { ok: true, value: r }
              : { ok: false, error: { code: 'internal', message: r.message } }
          }
          if (endpoint === 'personalization.removeWallpaper') {
            const name = argOf(payload, 'name')
            const r = await removeWallpaper(name, config)
            return r.status === 'ok'
              ? { ok: true, value: r }
              : { ok: false, error: { code: 'internal', message: r.message } }
          }
          if (endpoint === 'personalization.get') {
            return { ok: true, value: readPersonalization(config) }
          }
          if (endpoint === 'personalization.set') {
            const next = payload?.args?.value ?? payload?.value
            if (typeof next !== 'object' || next === null || Array.isArray(next)) {
              return { ok: false, error: { code: 'invalid', message: 'personalization.set expects { value: {...} }' } }
            }
            const wrote = writePersonalization(config, next)
            if (!wrote) return { ok: false, error: { code: 'internal', message: 'settings.json 写入失败' } }
            return { ok: true, value: readPersonalization(config) }
          }
          if (endpoint === 'personalization.getWallpaperData') {
            const name = argOf(payload, 'name')
            const r = readWallpaperData(name, config)
            return r.status === 'ok'
              ? { ok: true, value: r }
              : { ok: false, error: { code: 'internal', message: r.message } }
          }
          return { ok: false, error: { code: 'internal', message: `better-setting: unknown rpc "${String(endpoint)}"` } }
        },
        { authority: 'loopback' },
      ),
    'dsh-desktop-better-setting: rpc',
  )
}
