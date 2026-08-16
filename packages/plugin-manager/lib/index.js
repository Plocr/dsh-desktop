/**
 * dsh-desktop-plugin-manager · Host 半边
 *
 * 桌面端插件管理系统（四类分区：官方 / 桌面 / 用户 / 市场）。
 *
 * 通过 connection RPC（channel `/rpc`）暴露给浏览器半边：
 *  - `list`：枚举四类插件
 *      · 官方：harness 的 pluginInventory 服务（Loader 条目，只读投影）
 *      · 桌面：壳打包内置（config.bundledPluginsDir）
 *      · 用户：用户安装（config.userPluginsDir）
 *  - `setEnabled(name, enabled)`：读写壳 settings.json 的 disabledPlugins
 *    （bridge 永远启用）；改动后需重启 Harness 生效（界面提示）。
 *  - `market.search(query)`：GitHub topic dsh-plugin 仓库搜索
 *  - `market.install(owner/repo)`：下载 release zip 到 userPluginsDir（骨架）
 *
 * 目录/设置路径由壳在 overlay config 注入（src/main/index.ts regenerateOverlay）。
 * RPC 参数容错：payload 可能是 { args } 或直接对象，两处都取。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

export const name = 'dsh-desktop-plugin-manager'

/** 需要 connection 服务以挂载 RPC 通道。 */
export const inject = ['connection']

const GITHUB_SEARCH = 'https://api.github.com/search/repositories'

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

export function apply(ctx, config) {
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
          return { ok: false, error: { code: 'internal', message: `plugin-manager: unknown rpc "${String(endpoint)}"` } }
        },
        { authority: 'loopback' },
      ),
    'dsh-desktop-plugin-manager: rpc',
  )
}
