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

/** GitHub 仓库搜索：topic:dsh-plugin。无关键词时返回默认 Top15（按 star 排序）。 */
async function marketSearch(query) {
  const q = ['topic:dsh-plugin']
  if (typeof query === 'string' && query.trim()) q.push(query.trim())
  const perPage = typeof query === 'string' && query.trim() ? 30 : 15
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
    const items = Array.isArray(data?.items) ? data.items : []
    return {
      status: 'ok',
      items: items.map((r) => ({
        fullName: r?.full_name ?? r?.name ?? '?',
        description: r?.description ?? null,
        stars: r?.stargazers_count ?? 0,
        url: r?.html_url ?? null,
        updatedAt: r?.updated_at ?? null,
      })),
    }
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
 * 从市场安装插件：下载仓库 zip → 解压 → 找到含 package.json 的插件目录
 * → 以包名安装到 userPluginsDir。
 */
async function marketInstall(repo, config) {
  const fullName = typeof repo === 'string' ? repo.trim() : ''
  if (!/^[^/]+\/[^/]+$/.test(fullName)) return { status: 'error', message: '仓库格式应为 owner/repo' }
  const userDir = config?.userPluginsDir
  if (!userDir) return { status: 'error', message: 'userPluginsDir 未配置' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 60_000)
  try {
    const rel = await fetch(`https://api.github.com/repos/${fullName}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop' },
      signal: ctrl.signal,
    })
    let zipUrl = null
    let tag = null
    if (rel.ok) {
      const data = await rel.json()
      zipUrl = data?.zipball_url ?? null
      tag = data?.tag_name ?? null
    }
    if (!zipUrl) {
      const repoRes = await fetch(`https://api.github.com/repos/${fullName}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop' },
        signal: ctrl.signal,
      })
      if (!repoRes.ok) return { status: 'error', message: `仓库不可达: ${repoRes.status}` }
      const repoData = await repoRes.json()
      zipUrl = repoData?.default_branch
        ? `https://github.com/${fullName}/archive/refs/heads/${repoData.default_branch}.zip`
        : null
    }
    if (!zipUrl) return { status: 'error', message: '无法确定下载地址' }

    mkdirSync(userDir, { recursive: true })
    const tmpZip = path.join(userDir, `.install-${Date.now()}.zip`)
    const tmpDir = path.join(userDir, `.install-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    try {
      const dl = await fetch(zipUrl, { signal: ctrl.signal })
      if (!dl.ok) return { status: 'error', message: `下载失败: ${dl.status}` }
      const buf = Buffer.from(await dl.arrayBuffer())
      writeFileSync(tmpZip, buf)
      await extractZip(tmpZip, tmpDir)
      // 在解压结果里找含 package.json 的插件包目录（zip 通常包一层仓库根目录）
      const pkgDir = findPluginPackageDir(tmpDir)
      if (!pkgDir) return { status: 'error', message: '仓库未包含插件包（无 package.json）' }
      const pkg = readJson(path.join(pkgDir, 'package.json'))
      const name = typeof pkg?.name === 'string' && pkg.name ? pkg.name : fullName.split('/')[1]
      const dest = path.join(userDir, name)
      rmSync(dest, { recursive: true, force: true })
      copyDirTree(pkgDir, dest)
      return { status: 'ok', message: `已安装 ${name}@${tag ?? 'default'}（重启 Harness 生效）`, name }
    } finally {
      rmSync(tmpZip, { force: true })
      rmSync(tmpDir, { recursive: true, force: true })
    }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(t)
  }
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

/** 卸载用户插件：删除 userPluginsDir 下的插件目录。 */
async function userUninstall(name, config) {
  const userDir = config?.userPluginsDir
  if (!userDir) return { status: 'error', message: 'userPluginsDir 未配置' }
  if (typeof name !== 'string' || !name) return { status: 'error', message: 'missing name' }
  if (name === 'dsh-desktop-bridge') return { status: 'error', message: 'bridge 为必需插件，不可删除' }
  // 按包名或目录名匹配
  const target = path.join(userDir, name)
  if (!existsSync(target)) {
    // 尝试目录名匹配（包名可能 ≠ 目录名）
    const found = scanPlugins(userDir).find((p) => p.name === name)
    if (!found) return { status: 'error', message: `未找到用户插件 ${name}` }
    return userUninstall(found.dir, config)
  }
  try {
    rmSync(target, { recursive: true, force: true })
    return { status: 'ok', message: `已删除 ${name}` }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
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
            return {
              ok: true,
              value: {
                appVersion: config?.appVersion ?? null,
                official: listOfficialPlugins(ctx),
                bundled: bundled.map((p) => decorate({ ...p, source: p.source ?? 'bundled' })),
                user: scanPlugins(config?.userPluginsDir).map((p) => decorate({ ...p, source: 'user' })),
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
