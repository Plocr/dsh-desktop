/**
 * dsh-desktop-plugin-manager · Client 半边
 *
 * 在官方设置页的「插件」区注册 4 个独立 tab（order 20-23，排在官方
 * 「插件配置」(0) / 「插件列表」(15) 之后）：
 *  - 官方插件：harness 已加载插件（pluginInventory 只读投影，运行状态徽章）
 *  - Desktop 插件：随包内置（启停开关，bridge 锁定）
 *  - 用户插件：用户安装（启用/停用/删除）
 *  - 插件市场：GitHub topic dsh-plugin，默认 Top15（按 star），可搜索/安装
 *
 * 数据经 connection RPC /pm-rpc 从 host 半边获取。
 * 纯 JS 无 JSX；持久安装版由 build-client.js 转换（React/styles/host 替身）。
 */
return {
  inject: ['slots', 'layout', 'locale', 'connection'],
  apply(ctx) {
    const NS = 'pluginManager'
    const t = ctx.locale.bind(NS)

    const zh = {
      'official.tab': '官方插件',
      'bundled.tab': 'Desktop 插件',
      'user.tab': '用户插件',
      'market.tab': '插件市场',
      'official.hint': '随 harness 分发的官方插件，共 {count} 个',
      'bundled.hint': '随 DSH Desktop 安装包分发的插件',
      'user.hint': '安装到用户插件目录，无需重新打包',
      'market.hint': 'GitHub dsh-plugin 生态，默认展示 Top 15',
      'empty': '暂无插件',
      'enabled': '已启用',
      'disabled': '已停用',
      'locked': '必需',
      'phase.active': '运行中',
      'phase.failed': '失败',
      'phase.loading': '加载中',
      'phase.pending': '等待',
      'market.search': '搜索',
      'market.searchPlaceholder': '搜索插件市场…',
      'market.install': '安装',
      'market.installing': '安装中…',
      'market.empty': '输入关键词搜索，或浏览默认 Top 15',
      'market.error': '搜索失败',
      'user.uninstall': '删除',
      'user.installed': '已安装',
      'restart.hint': '改动将在重启 Harness 后生效（托盘 → 重启 Harness）',
      'refresh': '刷新',
      'version': 'v',
      'stars': '★ {count}',
      'source.bundled': '内置',
      'source.user': '用户',
      'installed.tag': '已装',
    }
    const en = {
      'official.tab': 'Official',
      'bundled.tab': 'Desktop',
      'user.tab': 'User',
      'market.tab': 'Market',
      'official.hint': 'Official plugins shipped with the harness, {count} total',
      'bundled.hint': 'Plugins shipped with the DSH Desktop installer',
      'user.hint': 'Installed into the user plugin directory (no repackaging)',
      'market.hint': 'GitHub dsh-plugin ecosystem, Top 15 by default',
      'empty': 'No plugins',
      'enabled': 'Enabled',
      'disabled': 'Disabled',
      'locked': 'Required',
      'phase.active': 'Running',
      'phase.failed': 'Failed',
      'phase.loading': 'Loading',
      'phase.pending': 'Pending',
      'market.search': 'Search',
      'market.searchPlaceholder': 'Search plugin market…',
      'market.install': 'Install',
      'market.installing': 'Installing…',
      'market.empty': 'Type a keyword, or browse the Top 15',
      'market.error': 'Search failed',
      'user.uninstall': 'Remove',
      'user.installed': 'Installed',
      'restart.hint': 'Changes apply after Harness restart (tray → Restart Harness)',
      'refresh': 'Refresh',
      'version': 'v',
      'stars': '★ {count}',
      'source.bundled': 'Bundled',
      'source.user': 'User',
      'installed.tag': 'Installed',
    }

    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-manager: dictionaries')

    const RPC = (endpoint, args) => {
      const conn = ctx.get('connection')
      if (!conn || !conn.rpc) return Promise.reject(new Error('connection service unavailable'))
      return conn.rpc.call('/pm-rpc', endpoint, args === void 0 ? null : { args }).then((r) => {
        if (r && r.ok) return r.value
        const msg = r && r.error && r.error.message ? r.error.message : 'rpc failed: ' + String(endpoint)
        throw new Error(msg)
      })
    }

    const e = React.createElement
    const { useEffect, useState } = React

    // ---- 主题感知样式（随主题 token 自动深/浅色） ----
    ctx.effect(() => styles.insert(`
.pm-root{max-width:860px;margin:0 auto;padding:20px 16px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;line-height:20px}
.pm-head{display:flex;align-items:center;gap:10px}
.pm-title{flex:1;min-width:0;font-size:16px;font-weight:600}
.pm-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.pm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:10px}
.pm-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-elevated,transparent)}
.pm-cardRow{display:flex;align-items:center;gap:10px}
.pm-cardMain{flex:1;min-width:0}
.pm-name{font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.pm-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;border:1px solid transparent}
.pm-badge-on{color:#16a34a;background:rgba(22,163,74,.12);border-color:rgba(22,163,74,.35)}
.pm-badge-off{color:var(--dsw-alias-label-tertiary,#6b7280);background:var(--dsw-alias-interactive-bg,rgba(128,128,128,.08));border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.25))}
.pm-badge-lock{color:var(--dsw-alias-label-tertiary,#6b7280);background:var(--dsw-alias-interactive-bg,rgba(128,128,128,.08));border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.25))}
.pm-badge-phase{color:var(--dsw-alias-label-tertiary,#6b7280);background:var(--dsw-alias-interactive-bg,rgba(128,128,128,.08))}
.pm-badge-phase-err{color:#dc2626;background:rgba(220,38,38,.12);border-color:rgba(220,38,38,.3)}
.pm-btn{font-size:12px;padding:3px 12px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));background:transparent;color:var(--dsw-alias-label-primary,#0f1115);transition:filter .15s}
.pm-btn:hover{filter:brightness(1.1)}
.pm-btn-on{color:#16a34a;border-color:rgba(22,163,74,.45);background:rgba(22,163,74,.1)}
.pm-btn-off{color:var(--dsw-alias-label-tertiary,#6b7280)}
.pm-btn-danger{color:#dc2626;border-color:rgba(220,38,38,.35);background:transparent}
.pm-btn:disabled{opacity:.45;cursor:not-allowed}
.pm-search{display:flex;gap:8px;margin-bottom:4px}
.pm-input{flex:1;font-size:13px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));background:transparent;color:var(--dsw-alias-label-primary,#0f1115)}
.pm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3964fe)}
.pm-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280);padding:14px 0;text-align:center}
.pm-err{font-size:12px;color:#dc2626}
.pm-restart{font-size:12px;color:var(--dsw-alias-brand-primary,#3964fe);border:1px solid rgba(57,100,254,.35);border-radius:8px;padding:8px 12px;background:rgba(57,100,254,.08)}
.pm-stars{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280);font-variant-numeric:tabular-nums}
`), 'plugin-manager: styles')

    // ---- 通用组件 ----

    function StatusBadge({ plugin }) {
      const cls = plugin.enabled ? 'pm-badge pm-badge-on' : 'pm-badge pm-badge-off'
      return e('span', { className: cls }, plugin.enabled ? t('enabled') : t('disabled'))
    }

    function PhaseBadge({ phase }) {
      if (!phase) return null
      const isErr = phase === 'failed'
      const cls = 'pm-badge ' + (isErr ? 'pm-badge-phase-err' : 'pm-badge-phase')
      const label = t('phase.' + phase) || phase
      return e('span', { className: cls }, label)
    }

    function LockBadge() {
      return e('span', { className: 'pm-badge pm-badge-lock' }, '🔒 ' + t('locked'))
    }

    function ToggleButton({ plugin, onToggle }) {
      if (plugin.locked) return null
      const cls = plugin.enabled ? 'pm-btn pm-btn-on' : 'pm-btn pm-btn-off'
      return e('button', { className: cls, onClick: () => onToggle(plugin) },
        plugin.enabled ? t('disabled') : t('enabled'))
    }

    /** 官方插件卡片（只读：名称 + 运行状态）。 */
    function OfficialCard({ plugin }) {
      const name = plugin.moduleName || plugin.entryId || plugin.name || '?'
      const shortId = plugin.entryId && plugin.entryId !== name ? plugin.entryId : null
      return e('div', { className: 'pm-card' },
        e('div', { className: 'pm-cardRow' },
          e('div', { className: 'pm-cardMain' },
            e('div', { className: 'pm-name' }, name, e(StatusBadge, { plugin })),
            e('div', { className: 'pm-meta' },
              shortId ? e('span', null, shortId) : null,
              e(PhaseBadge, { phase: plugin.fiberPhase }),
            ),
          ),
        ),
      )
    }

    /** 桌面/用户插件卡片（启停开关；用户插件加删除）。 */
    function ManagedCard({ plugin, onToggle, onRemove, removable }) {
      return e('div', { className: 'pm-card' },
        e('div', { className: 'pm-cardRow' },
          e('div', { className: 'pm-cardMain' },
            e('div', { className: 'pm-name' },
              plugin.name,
              plugin.locked ? e(LockBadge) : null,
              e(StatusBadge, { plugin }),
            ),
            e('div', { className: 'pm-meta' },
              plugin.version ? e('span', null, t('version') + plugin.version) : null,
              plugin.source === 'bundled' ? e('span', null, t('source.bundled')) : e('span', null, t('source.user')),
            ),
          ),
          e(ToggleButton, { plugin, onToggle }),
          removable
            ? e('button', { className: 'pm-btn pm-btn-danger', onClick: () => onRemove(plugin) }, t('user.uninstall'))
            : null,
        ),
      )
    }

    /** 市场条目卡片（star + 描述 + 安装按钮）。 */
    function MarketCard({ item, installed, installing, onInstall, onOpen }) {
      const name = item.fullName
      const isInstalled = installed.has(name)
      return e('div', { className: 'pm-card' },
        e('div', { className: 'pm-cardRow' },
          e('div', { className: 'pm-cardMain' },
            e('div', { className: 'pm-name', style: { cursor: item.url ? 'pointer' : 'default' }, onClick: item.url ? () => onOpen(item.url) : undefined },
              name,
              isInstalled ? e('span', { className: 'pm-badge pm-badge-on' }, t('installed.tag')) : null,
            ),
            e('div', { className: 'pm-meta' }, e('span', { className: 'pm-stars' }, t('stars', { count: item.stars ?? 0 }))),
            item.description ? e('div', { className: 'pm-desc' }, item.description) : null,
          ),
          isInstalled
            ? null
            : e('button', {
                className: 'pm-btn',
                onClick: () => onInstall(name),
                disabled: installing === name,
              }, installing === name ? t('market.installing') : t('market.install')),
        ),
      )
    }

    // ---- 各 tab 页面 ----

    /** 官方插件页。 */
    function OfficialPage({ data, error, onRefresh }) {
      const list = data ? data.official : null
      return e('div', { className: 'pm-root' },
        error ? e('div', { className: 'pm-err' }, error) : null,
        e('div', { className: 'pm-head' },
          e('div', null,
            e('div', { className: 'pm-title' }, t('official.tab')),
            e('div', { className: 'pm-hint' }, t('official.hint', { count: list ? list.length : '…' })),
          ),
          e('button', { className: 'pm-btn', onClick: onRefresh }, t('refresh')),
        ),
        list && list.length > 0
          ? e('div', { className: 'pm-grid' }, list.map((p) => e(OfficialCard, { key: p.entryId || p.moduleName || p.name, plugin: p })))
          : e('div', { className: 'pm-empty' }, t('empty')),
      )
    }

    /** Desktop 插件页（启停）。 */
    function BundledPage({ data, error, onToggle, onRefresh }) {
      const list = data ? data.bundled : null
      return e('div', { className: 'pm-root' },
        error ? e('div', { className: 'pm-err' }, error) : null,
        e('div', { className: 'pm-head' },
          e('div', null,
            e('div', { className: 'pm-title' }, t('bundled.tab')),
            e('div', { className: 'pm-hint' }, t('bundled.hint')),
          ),
          e('button', { className: 'pm-btn', onClick: onRefresh }, t('refresh')),
        ),
        list && list.length > 0
          ? e('div', { className: 'pm-grid' }, list.map((p) => e(ManagedCard, { key: p.name, plugin: p, onToggle })))
          : e('div', { className: 'pm-empty' }, t('empty')),
      )
    }

    /** 用户插件页（启停 + 删除）。 */
    function UserPage({ data, error, onToggle, onRemove, onRefresh }) {
      const list = data ? data.user : null
      return e('div', { className: 'pm-root' },
        error ? e('div', { className: 'pm-err' }, error) : null,
        e('div', { className: 'pm-head' },
          e('div', null,
            e('div', { className: 'pm-title' }, t('user.tab')),
            e('div', { className: 'pm-hint' }, t('user.hint')),
          ),
          e('button', { className: 'pm-btn', onClick: onRefresh }, t('refresh')),
        ),
        list && list.length > 0
          ? e('div', { className: 'pm-grid' }, list.map((p) =>
              e(ManagedCard, { key: p.name, plugin: p, onToggle, onRemove, removable: true })))
          : e('div', { className: 'pm-empty' }, t('empty')),
      )
    }

    /** 插件市场页（默认 Top15 + 搜索 + 安装）。 */
    function MarketPage({ error, onRefresh }) {
      const [query, setQuery] = useState('')
      const [market, setMarket] = useState(null)
      const [loading, setLoading] = useState(false)
      const [installing, setInstalling] = useState(null)
      const [installedNames, setInstalledNames] = useState([])
      const [notice, setNotice] = useState(null)

      const load = (q) => {
        setLoading(true)
        RPC('market.search', { query: q })
          .then((r) => setMarket(r))
          .catch((err) => setNotice(err.message))
          .finally(() => setLoading(false))
      }
      useEffect(() => {
        load('')
        RPC('list').then((d) => setInstalledNames([...(d.user || []), ...(d.bundled || [])].map((x) => x.name))).catch(() => {})
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const doInstall = (fullName) => {
        setInstalling(fullName)
        setNotice(null)
        RPC('market.install', { repo: fullName })
          .then((r) => {
            setNotice(r.message)
            setInstalledNames((prev) => (prev.includes(r.name) ? prev : [...prev, r.name]))
          })
          .catch((err) => setNotice(err.message))
          .finally(() => setInstalling(null))
      }

      const installed = new Set(installedNames)
      const items = market && market.status === 'ok' ? (market.items || []) : []
      return e('div', { className: 'pm-root' },
        notice ? e('div', { className: notice && notice.startsWith('已') || notice && notice.includes('install') ? 'pm-restart' : 'pm-err' }, notice) : null,
        e('div', { className: 'pm-head' },
          e('div', null,
            e('div', { className: 'pm-title' }, t('market.tab')),
            e('div', { className: 'pm-hint' }, t('market.hint')),
          ),
          e('button', { className: 'pm-btn', onClick: () => load(query) }, t('refresh')),
        ),
        e('div', { className: 'pm-search' },
          e('input', {
            className: 'pm-input',
            placeholder: t('market.searchPlaceholder'),
            value: query,
            onChange: (ev) => setQuery(ev.target.value),
            onKeyDown: (ev) => { if (ev.key === 'Enter') load(query) },
          }),
          e('button', { className: 'pm-btn', onClick: () => load(query), disabled: loading },
            loading ? '…' : t('market.search')),
        ),
        market && market.status === 'error'
          ? e('div', { className: 'pm-err' }, t('market.error') + ': ' + market.message)
          : items.length === 0
            ? e('div', { className: 'pm-empty' }, t('market.empty'))
            : e('div', { className: 'pm-grid' }, items.map((it) =>
                e(MarketCard, {
                  key: it.fullName,
                  item: it,
                  installed,
                  installing,
                  onInstall: doInstall,
                  onOpen: (url) => { try { window.open(url, '_blank') } catch { /* ignore */ } },
                }))),
      )
    }

    // ---- 注册：设置 → 插件区 4 个独立 tab（order 20-23，排在官方 0/15 之后） ----
    const tabMeta = (id, order, label, Page) => ({
      name: 'settings.plugins.tab',
      locale: NS,
      id,
      order,
      label: () => t(label),
      inject: () => ({}),
    })

    const useSharedData = () => {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const refresh = () => {
        RPC('list').then(setData).catch((err) => setError(err.message))
      }
      useEffect(() => { refresh() }, [])
      return { data, error, refresh }
    }

    function OfficialTab() {
      const { data, error, refresh } = useSharedData()
      return e(OfficialPage, { data, error, onRefresh: refresh })
    }
    function BundledTab() {
      const { data, error, refresh } = useSharedData()
      const doToggle = (plugin) => {
        RPC('setEnabled', { name: plugin.name, enabled: !plugin.enabled }).catch((err) => setErrorLocal(err))
        function setErrorLocal(err) { /* 静默由下次刷新显示 */ void err }
        refresh()
      }
      return e(BundledPage, { data, error, onToggle: doToggle, onRefresh: refresh })
    }
    function UserTab() {
      const { data, error, refresh } = useSharedData()
      const doToggle = (plugin) => {
        RPC('setEnabled', { name: plugin.name, enabled: !plugin.enabled }).catch(() => {}).finally(refresh)
      }
      const doRemove = (plugin) => {
        RPC('user.uninstall', { name: plugin.name }).catch(() => {}).finally(refresh)
      }
      return e(UserPage, { data, error, onToggle: doToggle, onRemove: doRemove, onRefresh: refresh })
    }
    function MarketTab() {
      return e(MarketPage, { error: null, onRefresh: () => {} })
    }

    ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register(
        tabMeta('desktop-official', 20, 'official.tab', OfficialTab),
        OfficialTab,
      ),
    )
    ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register(
        tabMeta('desktop-bundled', 21, 'bundled.tab', BundledTab),
        BundledTab,
      ),
    )
    ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register(
        tabMeta('desktop-user', 22, 'user.tab', UserTab),
        UserTab,
      ),
    )
    ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register(
        tabMeta('desktop-market', 23, 'market.tab', MarketTab),
        MarketTab,
      ),
    )
  },
}
