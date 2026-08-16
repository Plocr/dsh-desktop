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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
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

/** GitHub 仓库搜索：topic:dsh-plugin。 */
async function marketSearch(query) {
  const q = ['topic:dsh-plugin']
  if (typeof query === 'string' && query.trim()) q.push(query.trim())
  const url = `${GITHUB_SEARCH}?q=${encodeURIComponent(q.join(' '))}&sort=stars&order=desc&per_page=30`
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

/** 下载仓库 release zip 到用户插件目录（骨架：验证下载链路，解压为下一步）。 */
async function marketInstall(repo, config) {
  const fullName = typeof repo === 'string' ? repo.trim() : ''
  if (!/^[^/]+\/[^/]+$/.test(fullName)) return { status: 'error', message: '仓库格式应为 owner/repo' }
  const userDir = config?.userPluginsDir
  if (!userDir) return { status: 'error', message: 'userPluginsDir 未配置' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 30_000)
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
    const tmp = path.join(userDir, `.install-${Date.now()}.zip`)
    const dl = await fetch(zipUrl, { signal: ctrl.signal })
    if (!dl.ok) return { status: 'error', message: `下载失败: ${dl.status}` }
    const buf = Buffer.from(await dl.arrayBuffer())
    writeFileSync(tmp, buf)
    return {
      status: 'ok',
      message: `已下载 ${fullName}@${tag ?? 'default'}（${(buf.length / 1024).toFixed(0)} KB），解压安装为下一步`,
      tmpZip: tmp,
    }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(t)
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
          return { ok: false, error: { code: 'internal', message: `plugin-manager: unknown rpc "${String(endpoint)}"` } }
        },
        { authority: 'loopback' },
      ),
    'dsh-desktop-plugin-manager: rpc',
  )
}
