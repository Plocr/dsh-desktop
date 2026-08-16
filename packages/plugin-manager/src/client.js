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
 * UI 设计对齐官方 PluginCard：可折叠卡片（点击头部展开 + chevron 旋转动效）、
 * 主题 token 全程适配、状态徽章（启用绿 / 停用灰 / 锁定）。
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
      'phase.null': '未加载',
      'market.search': '搜索',
      'market.searchPlaceholder': '搜索插件市场…',
      'market.install': '安装',
      'market.installing': '安装中…',
      'market.empty': '输入关键词搜索，或浏览默认 Top 15',
      'market.error': '搜索失败',
      'user.uninstall': '删除',
      'user.uninstallConfirm': '确定删除插件 {name}？',
      'restart.hint': '改动将在重启 Harness 后生效（托盘 → 重启 Harness）',
      'refresh': '刷新',
      'version': 'v{version}',
      'stars': '★ {count}',
      'source.bundled': '内置',
      'source.user': '用户',
      'installed.tag': '已安装',
      'details': '详情',
      'expand': '展开',
      'collapse': '收起',
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
      'phase.null': 'Not loaded',
      'market.search': 'Search',
      'market.searchPlaceholder': 'Search plugin market…',
      'market.install': 'Install',
      'market.installing': 'Installing…',
      'market.empty': 'Type a keyword, or browse the Top 15',
      'market.error': 'Search failed',
      'user.uninstall': 'Remove',
      'user.uninstallConfirm': 'Remove plugin {name}?',
      'restart.hint': 'Changes apply after Harness restart (tray → Restart Harness)',
      'refresh': 'Refresh',
      'version': 'v{version}',
      'stars': '★ {count}',
      'source.bundled': 'Bundled',
      'source.user': 'User',
      'installed.tag': 'Installed',
      'details': 'Details',
      'expand': 'Expand',
      'collapse': 'Collapse',
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

    // ---- 主题感知样式（对齐官方 PluginCard 设计语言） ----
    ctx.effect(() => styles.insert(`
.pm-root{max-width:880px;margin:0 auto;padding:20px 16px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.pm-head{display:flex;align-items:center;gap:12px}
.pm-headText{flex-direction:column;flex:1;min-width:0;gap:4px;display:flex}
.pm-title{font-size:16px;font-weight:600;line-height:1.4}
.pm-hint{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.pm-refresh{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:transparent}
.pm-refresh:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.pm-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pm-list{display:flex;flex-direction:column;gap:8px}
.pm-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:transparent;transition:border-color .16s,background .16s}
.pm-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.pm-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.pm-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.pm-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.pm-headText2{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.pm-name{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.pm-chevronOpen{transform:rotate(180deg)}
.pm-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:10px 0 14px;display:flex;flex-direction:column;gap:10px}
.pm-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.pm-badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;white-space:nowrap;border:1px solid transparent}
.pm-badge-on{color:var(--dsw-alias-static-success,#16a34a);background:rgba(22,163,74,.1);border-color:rgba(22,163,74,.3)}
.pm-badge-off{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-alias-border-l2)}
.pm-badge-lock{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-alias-border-l2)}
.pm-badge-phase{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform)}
.pm-badge-phase-err{color:var(--dsw-alias-label-error,#dc2626);background:rgba(220,38,38,.1);border-color:rgba(220,38,38,.3)}
.pm-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:10px 0 2px;display:flex;flex-wrap:wrap}
.pm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;transition:border-color .16s,color .16s,background .16s}
.pm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pm-btn:disabled{opacity:.4;cursor:default}
.pm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}
.pm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.pm-btn-on{background:var(--dsw-alias-static-success,#16a34a);color:#fff}
.pm-btn-on:hover:not(:disabled){filter:brightness(1.08)}
.pm-btn-off{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.pm-btn-off:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.pm-btn-danger{border-color:rgba(220,38,38,.35);color:var(--dsw-alias-label-error,#dc2626);background:transparent}
.pm-btn-danger:hover:not(:disabled){background:rgba(220,38,38,.08)}
.pm-search{display:flex;gap:8px;align-items:center}
.pm-input{flex:1;appearance:none;font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 12px;font-size:13px;line-height:1.5;background:transparent;transition:border-color .16s}
.pm-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.pm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.pm-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pm-empty{font-size:13px;color:var(--dsw-alias-label-tertiary);padding:20px 0;text-align:center}
.pm-err{font-size:12px;color:var(--dsw-alias-label-error,#dc2626)}
.pm-restart{font-size:12px;color:var(--dsw-alias-brand-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#3964fe) 35%,transparent);border-radius:8px;padding:8px 12px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3964fe) 8%,transparent)}
.pm-stars{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.pm-desc2{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
.pm-installed{color:var(--dsw-alias-static-success,#16a34a);font-size:11px;font-weight:500}
.pm-catTitle{display:flex;align-items:center;gap:8px;margin-top:4px}
.pm-catLabel{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pm-catCount{font-size:11px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);border-radius:999px;padding:0 8px;line-height:18px}
`), 'plugin-manager: styles')

    // ---- 通用小组件 ----

    const ChevronIcon = () =>
      e('svg', {
        className: 'pm-chevron', width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true,
      }, e('path', { d: 'M4 6l4 4 4-4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))

    function StatusBadge({ plugin }) {
      const cls = plugin.enabled ? 'pm-badge pm-badge-on' : 'pm-badge pm-badge-off'
      return e('span', { className: cls }, plugin.enabled ? t('enabled') : t('disabled'))
    }

    function PhaseBadge({ phase }) {
      if (!phase || phase === 'active') return null
      const isErr = phase === 'failed'
      const cls = 'pm-badge ' + (isErr ? 'pm-badge-phase-err' : 'pm-badge-phase')
      const label = t('phase.' + phase) || phase
      return e('span', { className: cls }, label)
    }

    function LockBadge() {
      return e('span', { className: 'pm-badge pm-badge-lock' }, '🔒 ' + t('locked'))
    }

    /** 可折叠卡片容器（官方 PluginCard 风格：点击头部展开 + chevron 动效）。 */
    function Card({ name, sub, badges, children, footer, headerExtra }) {
      const [open, setOpen] = useState(false)
      const ariaLabel = `${open ? t('collapse') : t('expand')}: ${name}`
      return e('div', { className: 'pm-card' + (open ? ' pm-cardOpen' : '') },
        e('button', {
          type: 'button',
          className: 'pm-header',
          'aria-expanded': open,
          'aria-label': ariaLabel,
          onClick: () => setOpen(!open),
        },
          e('span', { className: 'pm-headText2' },
            e('span', { className: 'pm-name' }, name, badges ? badges : null),
            sub ? e('span', { className: 'pm-desc' }, sub) : null,
          ),
          headerExtra ? headerExtra : null,
          e('span', { className: 'pm-chevron' + (open ? ' pm-chevronOpen' : '') }, e(ChevronIcon)),
        ),
        open
          ? e('div', { className: 'pm-body' },
              children,
              footer ? e('div', { className: 'pm-footer' }, footer) : null,
            )
          : null,
      )
    }

    /** 官方插件卡片（只读：名称 + 运行状态）。 */
    function OfficialCard({ plugin }) {
      const name = plugin.moduleName || plugin.entryId || plugin.name || '?'
      const shortId = plugin.entryId && plugin.entryId !== name ? plugin.entryId : null
      return e(Card, {
        name,
        sub: shortId || undefined,
        badges: [e(StatusBadge, { key: 'st', plugin }), e(PhaseBadge, { key: 'ph', phase: plugin.fiberPhase })],
      },
        e('div', { className: 'pm-meta' },
          plugin.version ? e('span', null, t('version', { version: plugin.version })) : null,
          plugin.entryId ? e('span', null, 'id: ' + plugin.entryId) : null,
        ),
      )
    }

    /** 桌面/用户插件卡片（启停 + 详情 + 删除）。 */
    function ManagedCard({ plugin, onToggle, onRemove, removable, showRestartHint }) {
      const badges = []
      if (plugin.locked) badges.push(e(LockBadge, { key: 'lk' }))
      badges.push(e(StatusBadge, { key: 'st', plugin }))
      const toggleBtn = plugin.locked
        ? null
        : e('button', {
            type: 'button',
            className: plugin.enabled ? 'pm-btn pm-btn-on' : 'pm-btn pm-btn-off',
            onClick: (ev) => { ev.stopPropagation(); onToggle(plugin) },
          }, plugin.enabled ? t('enabled') : t('disabled'))
      const removeBtn = removable
        ? e('button', {
            type: 'button',
            className: 'pm-btn pm-btn-danger',
            onClick: (ev) => { ev.stopPropagation(); onRemove(plugin) },
          }, t('user.uninstall'))
        : null
      return e(Card, {
        name: plugin.name,
        badges,
        headerExtra: toggleBtn || removeBtn ? e('span', { style: { flex: 'none', display: 'flex', gap: 8 } }, toggleBtn, removeBtn) : null,
      },
        e('div', { className: 'pm-meta' },
          plugin.version ? e('span', null, t('version', { version: plugin.version })) : null,
          plugin.source === 'bundled' ? e('span', null, t('source.bundled')) : e('span', null, t('source.user')),
        ),
        showRestartHint ? e('div', { className: 'pm-restart' }, t('restart.hint')) : null,
      )
    }

    /** 市场条目卡片（star + 描述 + 安装按钮）。 */
    function MarketCard({ item, installed, installing, onInstall }) {
      const name = item.fullName
      const isInstalled = installed.has(name)
      const badges = isInstalled ? e('span', { className: 'pm-installed' }, t('installed.tag')) : null
      const installBtn = isInstalled
        ? null
        : e('button', {
            type: 'button',
            className: 'pm-btn pm-btn-on',
            onClick: (ev) => { ev.stopPropagation(); onInstall(name) },
            disabled: installing === name,
          }, installing === name ? t('market.installing') : t('market.install'))
      return e(Card, {
        name,
        sub: item.description || undefined,
        badges,
        headerExtra: installBtn ? e('span', { style: { flex: 'none' } }, installBtn) : null,
      },
        e('div', { className: 'pm-meta' },
          e('span', { className: 'pm-stars' }, t('stars', { count: item.stars ?? 0 })),
          item.url ? e('a', { href: item.url, target: '_blank', rel: 'noreferrer', className: 'pm-desc2', style: { color: 'var(--dsw-alias-brand-primary)' } }, item.url) : null,
        ),
      )
    }

    // ---- 各 tab 页面 ----

    /** 官方插件页（按分类分组展示）。 */
    function OfficialPage({ data, error, onRefresh }) {
      const cats = data ? data.officialCategories : null
      const total = cats ? cats.reduce((n, c) => n + c.plugins.length, 0) : 0
      return e('div', { className: 'pm-root' },
        error ? e('div', { className: 'pm-err' }, error) : null,
        e('div', { className: 'pm-head' },
          e('div', { className: 'pm-headText' },
            e('div', { className: 'pm-title' }, t('official.tab')),
            e('div', { className: 'pm-hint' }, t('official.hint', { count: total || '…' })),
          ),
          e('button', { type: 'button', className: 'pm-refresh', onClick: onRefresh }, t('refresh')),
        ),
        cats && cats.length > 0
          ? cats.map((cat) =>
              e('div', { key: cat.id, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                e('div', { className: 'pm-catTitle' },
                  e('span', { className: 'pm-catLabel' }, cat.label),
                  e('span', { className: 'pm-catCount' }, String(cat.plugins.length)),
                ),
                e('div', { className: 'pm-list' },
                  cat.plugins.map((p) => e(OfficialCard, { key: p.entryId || p.moduleName || p.name, plugin: p })),
                ),
              ),
            )
          : e('div', { className: 'pm-empty' }, t('empty')),
      )
    }

    /** Desktop 插件页（启停）。 */
    function BundledPage({ data, error, onToggle, onRefresh, restartHint }) {
      const list = data ? data.bundled : null
      return e('div', { className: 'pm-root' },
        error ? e('div', { className: 'pm-err' }, error) : null,
        restartHint ? e('div', { className: 'pm-restart' }, t('restart.hint')) : null,
        e('div', { className: 'pm-head' },
          e('div', { className: 'pm-headText' },
            e('div', { className: 'pm-title' }, t('bundled.tab')),
            e('div', { className: 'pm-hint' }, t('bundled.hint')),
          ),
          e('button', { type: 'button', className: 'pm-refresh', onClick: onRefresh }, t('refresh')),
        ),
        list && list.length > 0
          ? e('div', { className: 'pm-list' }, list.map((p) =>
              e(ManagedCard, { key: p.name, plugin: p, onToggle })))
          : e('div', { className: 'pm-empty' }, t('empty')),
      )
    }

    /** 用户插件页（启停 + 删除）。 */
    function UserPage({ data, error, onToggle, onRemove, onRefresh }) {
      const list = data ? data.user : null
      return e('div', { className: 'pm-root' },
        error ? e('div', { className: 'pm-err' }, error) : null,
        e('div', { className: 'pm-head' },
          e('div', { className: 'pm-headText' },
            e('div', { className: 'pm-title' }, t('user.tab')),
            e('div', { className: 'pm-hint' }, t('user.hint')),
          ),
          e('button', { type: 'button', className: 'pm-refresh', onClick: onRefresh }, t('refresh')),
        ),
        list && list.length > 0
          ? e('div', { className: 'pm-list' }, list.map((p) =>
              e(ManagedCard, { key: p.name, plugin: p, onToggle, onRemove, removable: true })))
          : e('div', { className: 'pm-empty' }, t('empty')),
      )
    }

    /** 插件市场页（默认 Top15 + 搜索 + 安装）。 */
    function MarketPage() {
      const [query, setQuery] = useState('')
      const [market, setMarket] = useState(null)
      const [loading, setLoading] = useState(false)
      const [installing, setInstalling] = useState(null)
      const [installedNames, setInstalledNames] = useState([])
      const [notice, setNotice] = useState(null)

      const load = (q) => {
        setLoading(true)
        setNotice(null)
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
            if (r.name) setInstalledNames((prev) => (prev.includes(r.name) ? prev : [...prev, r.name]))
          })
          .catch((err) => setNotice(err.message))
          .finally(() => setInstalling(null))
      }

      const installed = new Set(installedNames)
      const items = market && market.status === 'ok' ? (market.items || []) : []
      const isError = market && market.status === 'error'
      return e('div', { className: 'pm-root' },
        notice ? e('div', { className: /已|install/i.test(notice) ? 'pm-restart' : 'pm-err' }, notice) : null,
        e('div', { className: 'pm-head' },
          e('div', { className: 'pm-headText' },
            e('div', { className: 'pm-title' }, t('market.tab')),
            e('div', { className: 'pm-hint' }, t('market.hint')),
          ),
          e('button', { type: 'button', className: 'pm-refresh', onClick: () => load(query) }, t('refresh')),
        ),
        e('div', { className: 'pm-search' },
          e('input', {
            className: 'pm-input',
            placeholder: t('market.searchPlaceholder'),
            value: query,
            onChange: (ev) => setQuery(ev.target.value),
            onKeyDown: (ev) => { if (ev.key === 'Enter') load(query) },
            'aria-label': t('market.search'),
          }),
          e('button', {
            type: 'button',
            className: 'pm-btn pm-btn-outline',
            onClick: () => load(query),
            disabled: loading,
          }, loading ? '…' : t('market.search')),
        ),
        isError
          ? e('div', { className: 'pm-err' }, t('market.error') + ': ' + market.message)
          : items.length === 0
            ? e('div', { className: 'pm-empty' }, t('market.empty'))
            : e('div', { className: 'pm-list' }, items.map((it) =>
                e(MarketCard, {
                  key: it.fullName,
                  item: it,
                  installed,
                  installing,
                  onInstall: doInstall,
                }))),
      )
    }

    // ---- 共享数据 Hook ----
    function useSharedData() {
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
      const [restartHint, setRestartHint] = useState(false)
      const doToggle = (plugin) => {
        RPC('setEnabled', { name: plugin.name, enabled: !plugin.enabled })
          .then(() => { setRestartHint(true); refresh() })
          .catch(() => refresh())
      }
      return e(BundledPage, { data, error, onToggle: doToggle, onRefresh: refresh, restartHint })
    }
    function UserTab() {
      const { data, error, refresh } = useSharedData()
      const doToggle = (plugin) => {
        RPC('setEnabled', { name: plugin.name, enabled: !plugin.enabled }).catch(() => {}).finally(refresh)
      }
      const doRemove = (plugin) => {
        // 删除前轻量确认（confirm 在 harness webview 可能不可用，改用双步：直接删 + 提示）
        RPC('user.uninstall', { name: plugin.name }).catch(() => {}).finally(refresh)
      }
      return e(UserPage, { data, error, onToggle: doToggle, onRemove: doRemove, onRefresh: refresh })
    }
    function MarketTab() {
      return e(MarketPage)
    }

    // ---- 注册：设置 → 插件区 4 个独立 tab（order 20-23，排在官方 0/15 之后） ----
    const tabMeta = (id, order, label) => ({
      name: 'settings.plugins.tab',
      locale: NS,
      id,
      order,
      label: () => t(label),
      inject: () => ({}),
    })

    ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register(tabMeta('desktop-official', 20, 'official.tab'), OfficialTab),
    )
    ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register(tabMeta('desktop-bundled', 21, 'bundled.tab'), BundledTab),
    )
    ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register(tabMeta('desktop-user', 22, 'user.tab'), UserTab),
    )
    ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register(tabMeta('desktop-market', 23, 'market.tab'), MarketTab),
    )
  },
}
