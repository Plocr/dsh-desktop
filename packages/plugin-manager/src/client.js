/**
 * dsh-desktop-plugin-manager · Client 半边
 *
 * 在官方设置页的「插件」区新增一个管理 tab（settings.plugins.tab 加法席位），
 * 四类分区：
 *  - 官方：harness 已加载插件（pluginInventory 只读投影，含运行状态）
 *  - 桌面：壳打包内置插件（可启停，bridge 锁定）
 *  - 用户：用户安装插件（可启停）
 *  - 市场：GitHub topic dsh-plugin 搜索 + 安装
 *
 * 数据经 connection RPC `/rpc` 从 host 半边获取。
 * 纯 JS 无 JSX（React.createElement）；持久安装版由 build-client.js 转换。
 */
return {
  inject: ['slots', 'layout', 'locale', 'connection'],
  apply(ctx) {
    const NS = 'pluginManager'
    const t = ctx.locale.bind(NS)

    const zh = {
      'title': '插件管理',
      'tab.label': '桌面插件',
      'official.title': '官方插件',
      'bundled.title': '桌面插件（随包内置）',
      'user.title': '用户插件',
      'market.title': '插件市场',
      'official.hint': '官方插件由 harness 随包加载，启停请到官方「插件」列表管理',
      'bundled.hint': '随 DSH Desktop 安装包分发的插件',
      'user.hint': '安装到用户插件目录（无需重新打包）',
      'empty': '暂无插件',
      'enabled': '已启用',
      'disabled': '已停用',
      'locked': '必需',
      'phase.active': '运行中',
      'phase.failed': '失败',
      'phase.loading': '加载中',
      'market.search': '搜索',
      'market.searchPlaceholder': '搜索 dsh-plugin 市场…',
      'market.install': '安装',
      'market.installing': '安装中…',
      'market.empty': '输入关键词搜索 GitHub dsh-plugin 插件',
      'market.error': '搜索失败',
      'restart.hint': '启停改动将在重启 Harness 后生效（托盘 → 重启 Harness）',
      'refresh': '刷新',
      'version': '版本',
      'source.bundled': '内置',
      'source.user': '用户',
    }
    const en = {
      'title': 'Plugin Manager',
      'tab.label': 'Desktop Plugins',
      'official.title': 'Official',
      'bundled.title': 'Bundled (desktop)',
      'user.title': 'User',
      'market.title': 'Market',
      'official.hint': 'Official plugins ship with the harness; manage them in the official Plugins list',
      'bundled.hint': 'Shipped with the DSH Desktop installer',
      'user.hint': 'Installed into the user plugin directory (no repackaging)',
      'empty': 'No plugins',
      'enabled': 'Enabled',
      'disabled': 'Disabled',
      'locked': 'Required',
      'phase.active': 'Running',
      'phase.failed': 'Failed',
      'phase.loading': 'Loading',
      'market.search': 'Search',
      'market.searchPlaceholder': 'Search dsh-plugin market…',
      'market.install': 'Install',
      'market.installing': 'Installing…',
      'market.empty': 'Type a keyword to search GitHub dsh-plugin plugins',
      'market.error': 'Search failed',
      'restart.hint': 'Toggle changes apply after Harness restart (tray → Restart Harness)',
      'refresh': 'Refresh',
      'version': 'Version',
      'source.bundled': 'Bundled',
      'source.user': 'User',
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

    function PluginRow({ plugin, onToggle, locked }) {
      const stateLabel = plugin.enabled ? t('enabled') : t('disabled')
      const phase = plugin.fiberPhase ? t('phase.' + plugin.fiberPhase) || plugin.fiberPhase : null
      return e(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, #eee)' } },
        e('div', { style: { flex: 1, minWidth: 0 } },
          e('div', { style: { fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            plugin.name || plugin.entryId || plugin.fullName || '?'),
          e('div', { style: { fontSize: 11, opacity: 0.65, display: 'flex', gap: 8, flexWrap: 'wrap' } },
            plugin.version ? e('span', null, t('version') + ' ' + plugin.version) : null,
            plugin.source === 'bundled' ? e('span', null, t('source.bundled')) : plugin.source === 'user' ? e('span', null, t('source.user')) : null,
            phase ? e('span', null, phase) : null,
            plugin.description ? e('span', { style: { maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, plugin.description) : null,
          ),
        ),
        locked
          ? e('span', { style: { fontSize: 11, opacity: 0.5 } }, t('locked'))
          : e('button', {
              style: {
                fontSize: 12, padding: '2px 10px', borderRadius: 4, cursor: 'pointer',
                border: '1px solid var(--dsw-alias-border-l2, #ccc)',
                background: plugin.enabled ? 'var(--dsw-alias-brand-primary, #3964fe)' : 'transparent',
                color: plugin.enabled ? '#fff' : 'inherit',
              },
              onClick: () => onToggle(plugin),
            }, stateLabel),
      )
    }

    function Section({ title, hint, plugins, onToggle }) {
      return e('div', { style: { marginBottom: 16 } },
        e('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 4 } }, title),
        hint ? e('div', { style: { fontSize: 11, opacity: 0.6, marginBottom: 6 } }, hint) : null,
        plugins && plugins.length > 0
          ? e('div', null, plugins.map((p) => e(PluginRow, { key: p.entryId || p.name || p.fullName, plugin: p, onToggle, locked: p.locked })))
          : e('div', { style: { fontSize: 12, opacity: 0.5, padding: '4px 0' } }, t('empty')),
      )
    }

    function PluginManagerPage() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [marketQuery, setMarketQuery] = useState('')
      const [market, setMarket] = useState(null)
      const [marketLoading, setMarketLoading] = useState(false)
      const [installing, setInstalling] = useState(null)
      const [changed, setChanged] = useState(false)

      const refresh = () => {
        RPC('list').then(setData).catch((err) => setError(err.message))
      }
      useEffect(() => {
        refresh()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const doToggle = (plugin) => {
        RPC('setEnabled', { name: plugin.name, enabled: !plugin.enabled })
          .then(() => {
            setChanged(true)
            refresh()
          })
          .catch((err) => setError(err.message))
      }

      const doSearch = () => {
        setMarketLoading(true)
        RPC('market.search', { query: marketQuery })
          .then((r) => setMarket(r))
          .catch((err) => setError(err.message))
          .finally(() => setMarketLoading(false))
      }

      const doInstall = (fullName) => {
        setInstalling(fullName)
        RPC('market.install', { repo: fullName })
          .then((r) => setMarket((m) => ({ ...m, lastInstall: r })))
          .catch((err) => setError(err.message))
          .finally(() => setInstalling(null))
      }

      return e('div', { style: { padding: '4px 2px', maxWidth: 720 } },
        error ? e('div', { style: { color: '#d33', fontSize: 12, marginBottom: 8 } }, error) : null,
        changed ? e('div', { style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary, #3964fe)', marginBottom: 8 } }, t('restart.hint')) : null,
        e('div', { style: { marginBottom: 8 } },
          e('button', { style: { fontSize: 12, padding: '3px 12px', cursor: 'pointer', borderRadius: 4, border: '1px solid var(--dsw-alias-border-l2, #ccc)', background: 'transparent' }, onClick: refresh }, t('refresh')),
        ),
        e(Section, {
          title: t('official.title') + (data ? '（' + (data.official || []).length + '）' : ''),
          hint: t('official.hint'),
          plugins: data ? data.official : null,
          onToggle: doToggle,
        }),
        e(Section, {
          title: t('bundled.title'),
          hint: t('bundled.hint'),
          plugins: data ? data.bundled : null,
          onToggle: doToggle,
        }),
        e(Section, {
          title: t('user.title'),
          hint: t('user.hint'),
          plugins: data ? data.user : null,
          onToggle: doToggle,
        }),

        e('div', { style: { marginTop: 8 } },
          e('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 6 } }, t('market.title')),
          e('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
            e('input', {
              style: { flex: 1, fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--dsw-alias-border-l2, #ccc)', background: 'transparent', color: 'inherit' },
              placeholder: t('market.searchPlaceholder'),
              value: marketQuery,
              onChange: (ev) => setMarketQuery(ev.target.value),
              onKeyDown: (ev) => { if (ev.key === 'Enter') doSearch() },
            }),
            e('button', { style: { fontSize: 12, padding: '4px 14px', cursor: 'pointer', borderRadius: 4, border: '1px solid var(--dsw-alias-border-l2, #ccc)', background: 'transparent' }, onClick: doSearch, disabled: marketLoading },
              marketLoading ? '…' : t('market.search')),
          ),
          !market
            ? e('div', { style: { fontSize: 12, opacity: 0.5 } }, t('market.empty'))
            : market.status === 'error'
              ? e('div', { style: { fontSize: 12, color: '#d33' } }, t('market.error') + ': ' + market.message)
              : e('div', null,
                  market.lastInstall ? e('div', { style: { fontSize: 12, marginBottom: 6 } }, market.lastInstall.message) : null,
                  market.items && market.items.length === 0
                    ? e('div', { style: { fontSize: 12, opacity: 0.5 } }, t('empty'))
                    : (market.items || []).map((it) =>
                        e('div', { key: it.fullName, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, #eee)' } },
                          e('div', { style: { flex: 1, minWidth: 0 } },
                            e('div', { style: { fontWeight: 600, fontSize: 13 } }, it.fullName + (it.stars ? ' ★' + it.stars : '')),
                            it.description ? e('div', { style: { fontSize: 11, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.description) : null,
                          ),
                          e('button', {
                            style: { fontSize: 12, padding: '2px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2, #ccc)', background: 'transparent' },
                            onClick: () => doInstall(it.fullName),
                            disabled: installing === it.fullName,
                          }, installing === it.fullName ? t('market.installing') : t('market.install')),
                        ),
                      ),
                ),
        ),
      )
    }

    // ---- 注册：设置 → 插件 区新增「桌面插件」tab ----
    ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register(
        {
          name: 'settings.plugins.tab',
          locale: NS,
          id: 'desktop-plugin-manager',
          order: 100,
          label: () => t('tab.label'),
          inject: () => ({}),
        },
        PluginManagerPage,
      ),
    )
  },
}
