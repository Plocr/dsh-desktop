/**
 * dsh-desktop-better-setting · Client 半边
 *
 * 设置中心两部分：
 * 1. 「插件」区 4 个独立 tab（order 20-23，排在官方「插件配置」(0) /
 *    「插件列表」(15) 之后）：官方插件 / Desktop 插件 / 用户插件 / 插件市场。
 * 2. 通用设置 → 外观 下方的「个性化」二级菜单（order 11）：
 *    皮肤预设（互斥）/ 主题强调色 / 壁纸（图片·视频·HTML）/ 毛玻璃模糊 / 液态玻璃。
 *    应用逻辑常驻（shell.overlay 全局应用器渲染 null），改动即时生效并持久化
 *    到壳 settings.json 的 personalization 字段（经宿主 /pm-rpc）。
 *
 * UI 设计对齐官方外观行：可折叠卡片（点击头部展开 + chevron 旋转动效）、
 * 主题 token 全程适配。数据经 connection RPC /pm-rpc 从 host 半边获取。
 * 纯 JS 无 JSX；持久安装版由 build-client.js 转换（React/styles/host 替身）。
 */
return {
  inject: ['slots', 'layout', 'locale', 'connection'],
  apply(ctx) {
    const NS = 'betterSetting'
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
      'personalization.title': '个性化',
      'personalization.hint': '外观下的二级设置：主题配色、壁纸、模糊、皮肤与液态玻璃',
      'personalization.open': '展开',
      'personalization.close': '收起',
      'personalization.accent': '主题配色',
      'personalization.accent.hint': '强调色用于按钮、链接与选中态',
      'personalization.accent.custom': '自定义',
      'personalization.accent.reset': '默认',
      'personalization.wallpaper': '壁纸',
      'personalization.wallpaper.hint': '支持图片 / 视频 / HTML，保存后将作为应用背景（仅本机）',
      'personalization.wallpaper.upload': '上传壁纸',
      'personalization.wallpaper.apply': '应用',
      'personalization.wallpaper.remove': '删除',
      'personalization.wallpaper.none': '无壁纸',
      'personalization.wallpaper.active': '使用中',
      'personalization.wallpaper.invalid': '不支持的壁纸类型',
      'personalization.blur': '模糊',
      'personalization.blur.hint': '面板背后的毛玻璃模糊强度（0-40px）',
      'personalization.skin': '皮肤',
      'personalization.skin.hint': '整体色调预设，互斥选择',
      'personalization.glass': '液态玻璃',
      'personalization.glass.hint': '更通透的面板 + 背景模糊 + 高光质感',
      'personalization.saved': '已保存',
      'personalization.failed': '保存失败：{message}',
      'personalization.age': '{size} KB',
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
      'personalization.title': 'Personalization',
      'personalization.hint': 'Second-level settings under Appearance: accent, wallpaper, blur, skins and liquid glass',
      'personalization.open': 'Expand',
      'personalization.close': 'Collapse',
      'personalization.accent': 'Accent color',
      'personalization.accent.hint': 'Used by buttons, links and selected states',
      'personalization.accent.custom': 'Custom',
      'personalization.accent.reset': 'Default',
      'personalization.wallpaper': 'Wallpaper',
      'personalization.wallpaper.hint': 'Image / video / HTML supported; becomes the app background (local only)',
      'personalization.wallpaper.upload': 'Upload wallpaper',
      'personalization.wallpaper.apply': 'Apply',
      'personalization.wallpaper.remove': 'Remove',
      'personalization.wallpaper.none': 'No wallpaper',
      'personalization.wallpaper.active': 'Active',
      'personalization.wallpaper.invalid': 'Unsupported wallpaper type',
      'personalization.blur': 'Blur',
      'personalization.blur.hint': 'Frosted-glass blur strength behind panels (0-40px)',
      'personalization.skin': 'Skin',
      'personalization.skin.hint': 'Overall tone presets, mutually exclusive',
      'personalization.glass': 'Liquid glass',
      'personalization.glass.hint': 'More translucent panels + background blur + specular sheen',
      'personalization.saved': 'Saved',
      'personalization.failed': 'Save failed: {message}',
      'personalization.age': '{size} KB',
    }

    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'better-setting: dictionaries')

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
    const { useEffect, useState, useRef, useCallback } = React

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
`), 'better-setting: styles')

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

    /** 官方插件页（按分类分组，默认折叠，点击展开）。 */
    function OfficialPage({ data, error, onRefresh }) {
      const cats = data ? data.officialCategories : null
      const total = cats ? cats.reduce((n, c) => n + c.plugins.length, 0) : 0
      const [openCats, setOpenCats] = useState(() => new Set())
      const toggleCat = (id) => {
        setOpenCats((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
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
          ? cats.map((cat) => {
              const open = openCats.has(cat.id)
              return e('div', { key: cat.id, className: 'pm-card' + (open ? ' pm-cardOpen' : ''), style: { display: 'flex', flexDirection: 'column', gap: 0 } },
                e('button', {
                  type: 'button',
                  className: 'pm-header',
                  'aria-expanded': open,
                  'aria-label': `${open ? t('collapse') : t('expand')}: ${cat.label}`,
                  onClick: () => toggleCat(cat.id),
                },
                  e('span', { className: 'pm-headText2' },
                    e('span', { className: 'pm-name', style: { fontSize: 14 } },
                      cat.label,
                      e('span', { className: 'pm-catCount' }, String(cat.plugins.length)),
                    ),
                    e('span', { className: 'pm-desc' }, cat.plugins[0]?.moduleName ? cat.plugins.map((p) => p.moduleName ?? p.entryId).slice(0, 3).join('、') + (cat.plugins.length > 3 ? ' …' : '') : ''),
                  ),
                  e('span', { className: 'pm-chevron' + (open ? ' pm-chevronOpen' : '') }, e(ChevronIcon)),
                ),
                open
                  ? e('div', { className: 'pm-body' },
                      e('div', { className: 'pm-list', style: { gap: 8 } },
                        cat.plugins.map((p) => e(OfficialCard, { key: p.entryId || p.moduleName || p.name, plugin: p })),
                      ),
                    )
                  : null,
              )
            })
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

    // ---- 个性化（外观下二级菜单）：皮肤 / 主题配色 / 壁纸 / 模糊 / 液态玻璃 ----

    /** 内置皮肤预设（互斥）。tokens 为 { light, dark } 成对值。 */
    const SKINS = [
      {
        id: 'default', name: '默认', tokens: {},
      },
      {
        id: 'midnight', name: '深海',
        tokens: {
          '--dsw-alias-bg-base': { light: '#eef2fa', dark: '#0d1220' },
          '--dsw-alias-bg-layer-1': { light: '#f4f7fd', dark: '#141a2c' },
          '--dsw-alias-bg-layer-2': { light: '#ffffff', dark: '#1b2338' },
          '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#202a44' },
          '--dsw-specific-sidebar-fill': { light: '#e8edf7', dark: '#0a0f1c' },
          '--dsw-alias-border-l1': { light: '#e3e9f5', dark: '#232c44' },
          '--dsw-alias-border-l2': { light: '#ccd6ea', dark: '#2e3a58' },
          '--dsw-alias-label-primary': { light: '#16213b', dark: '#e8edf9' },
          '--dsw-alias-label-secondary': { light: '#4a5670', dark: '#a8b3cc' },
          '--dsw-alias-brand-primary': { light: '#3b6ef6', dark: '#5b8cff' },
        },
      },
      {
        id: 'graphite', name: '石墨',
        tokens: {
          '--dsw-alias-bg-base': { light: '#f4f4f5', dark: '#111113' },
          '--dsw-alias-bg-layer-1': { light: '#fafafa', dark: '#18181b' },
          '--dsw-alias-bg-layer-2': { light: '#ffffff', dark: '#202024' },
          '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#26262b' },
          '--dsw-specific-sidebar-fill': { light: '#ececee', dark: '#0d0d0f' },
          '--dsw-alias-border-l1': { light: '#e6e6e8', dark: '#27272b' },
          '--dsw-alias-border-l2': { light: '#d4d4d8', dark: '#333338' },
          '--dsw-alias-label-primary': { light: '#18181b', dark: '#f4f4f5' },
          '--dsw-alias-label-secondary': { light: '#52525b', dark: '#a1a1aa' },
          '--dsw-alias-brand-primary': { light: '#52525b', dark: '#d4d4d8' },
        },
      },
      {
        id: 'fog', name: '晨雾',
        tokens: {
          '--dsw-alias-bg-base': { light: '#fbf9f4', dark: '#171410' },
          '--dsw-alias-bg-layer-1': { light: '#fffdf8', dark: '#1f1b15' },
          '--dsw-alias-bg-layer-2': { light: '#ffffff', dark: '#28231c' },
          '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#2e281f' },
          '--dsw-specific-sidebar-fill': { light: '#f5f1e8', dark: '#12100c' },
          '--dsw-alias-border-l1': { light: '#efe9dd', dark: '#2b251d' },
          '--dsw-alias-border-l2': { light: '#e2d8c6', dark: '#3a3226' },
          '--dsw-alias-label-primary': { light: '#2b2418', dark: '#f2ecdf' },
          '--dsw-alias-label-secondary': { light: '#6d6252', dark: '#b3a992' },
          '--dsw-alias-brand-primary': { light: '#b07a2e', dark: '#d9a85c' },
        },
      },
    ]

    /** 强调色预设。 */
    const ACCENT_PRESETS = ['#3964fe', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6']

    /** 默认个性化设置（与宿主 DEFAULT_PERSONALIZATION 保持一致）。 */
    const DEFAULT_PERSONALIZATION = { skin: 'default', accent: null, wallpaper: null, blur: 16, glass: false }

    /** 模块级共享状态：Applier 与设置行共用同一份个性化设置。 */
    const pStore = { state: null, listeners: [] }
    function setPState(patch) {
      pStore.state = { ...(pStore.state || DEFAULT_PERSONALIZATION), ...patch }
      for (const fn of pStore.listeners) {
        try { fn(pStore.state) } catch { /* ignore */ }
      }
    }
    function usePState() {
      const [s, setS] = useState(pStore.state)
      useEffect(() => {
        const fn = (st) => setS(st)
        pStore.listeners.push(fn)
        return () => { pStore.listeners = pStore.listeners.filter((f) => f !== fn) }
      }, [])
      return s
    }
    async function loadPState() {
      try {
        const v = await RPC('personalization.get')
        if (v && typeof v === 'object') setPState(v)
      } catch { /* 宿主未就绪时静默 */ }
    }
    async function savePState(patch) {
      try {
        const v = await RPC('personalization.set', { value: patch })
        if (v && typeof v === 'object') setPState(v)
        return { ok: true }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }

    /** 颜色工具：hex/rgb -> rgba 字符串。 */
    function toRgba(color, alpha) {
      const c = String(color || '').trim()
      let r = 128, g = 128, b = 128
      const mHex = /^#?([0-9a-f]{6})$/i.exec(c)
      if (mHex) {
        const n = parseInt(mHex[1], 16)
        r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255
      } else {
        const mRgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c)
        if (mRgb) {
          r = Number(mRgb[1]); g = Number(mRgb[2]); b = Number(mRgb[3])
        }
      }
      return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }

    /** 读取当前生效的 CSS 变量值（用于「无皮肤」时按当前主题取基础色）。 */
    function resolveToken(name) {
      try {
        if (typeof document === 'undefined') return null
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || null
      } catch { return null }
    }

    /**
     * 由设置计算主题 token 覆盖层（theme.overrideTokens 契约：name -> { light, dark }）。
     * - 皮肤：整体色调（默认皮肤不覆盖）；
     * - 强调色：仅覆盖 brand-primary；
     * - 壁纸/液态玻璃：把背景系 token 换成半透明（毛玻璃透出壁纸）。
     */
    function buildTokenLayers(state) {
      const s = state || DEFAULT_PERSONALIZATION
      const skin = SKINS.find((k) => k.id === s.skin) || SKINS[0]
      const tokens = {}
      for (const [name, pair] of Object.entries(skin.tokens || {})) tokens[name] = { light: pair.light, dark: pair.dark }
      if (s.accent) tokens['--dsw-alias-brand-primary'] = { light: s.accent, dark: s.accent }
      const translucent = !!s.wallpaper || !!s.glass
      if (translucent) {
        const glass = !!s.glass
        const alpha = { base: glass ? 0.30 : 0.72, layer1: glass ? 0.40 : 0.82, layer2: glass ? 0.52 : 0.90, overlay: glass ? 0.68 : 0.94, sidebar: glass ? 0.34 : 0.80 }
        const pick = (name, fallback) => {
          const pair = skin.tokens && skin.tokens[name]
          const base = pair ? pair.light : (resolveToken(name) || fallback)
          return base
        }
        const a = alpha
        tokens['--dsw-alias-bg-base'] = { light: toRgba(pick('--dsw-alias-bg-base', '#f5f6f8'), a.base), dark: toRgba(pick('--dsw-alias-bg-base', '#0b0d12'), a.base) }
        tokens['--dsw-alias-bg-layer-1'] = { light: toRgba(pick('--dsw-alias-bg-layer-1', '#ffffff'), a.layer1), dark: toRgba(pick('--dsw-alias-bg-layer-1', '#16181d'), a.layer1) }
        tokens['--dsw-alias-bg-layer-2'] = { light: toRgba(pick('--dsw-alias-bg-layer-2', '#ffffff'), a.layer2), dark: toRgba(pick('--dsw-alias-bg-layer-2', '#1d2026'), a.layer2) }
        tokens['--dsw-alias-bg-overlay'] = { light: toRgba(pick('--dsw-alias-bg-overlay', '#ffffff'), a.overlay), dark: toRgba(pick('--dsw-alias-bg-overlay', '#232630'), a.overlay) }
        tokens['--dsw-specific-sidebar-fill'] = { light: toRgba(pick('--dsw-specific-sidebar-fill', '#eef0f4'), a.sidebar), dark: toRgba(pick('--dsw-specific-sidebar-fill', '#0f1115'), a.sidebar) }
      }
      return tokens
    }

    /** 壁纸 DOM 层：图片背景 / 视频 / HTML iframe，挂在 body 最底层。 */
    function ensureWallpaperLayer() {
      if (typeof document === 'undefined') return null
      let el = document.getElementById('dsh-desktop-wallpaper-layer')
      if (!el) {
        el = document.createElement('div')
        el.id = 'dsh-desktop-wallpaper-layer'
        document.body.appendChild(el)
      }
      return el
    }
    function clearWallpaperLayer() {
      const el = ensureWallpaperLayer()
      if (!el) return
      el.style.backgroundImage = ''
      el.textContent = ''
    }
    function applyWallpaperLayer(wpData) {
      const el = ensureWallpaperLayer()
      if (!el || !wpData) { clearWallpaperLayer(); return }
      el.textContent = ''
      el.style.backgroundImage = ''
      const mime = String(wpData.mime || '').toLowerCase()
      if (mime.startsWith('image/')) {
        el.style.backgroundImage = `url("${wpData.dataUrl}")`
      } else if (mime.startsWith('video/')) {
        const v = document.createElement('video')
        v.src = wpData.dataUrl
        v.autoplay = true
        v.muted = true
        v.loop = true
        v.playsInline = true
        v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'
        el.appendChild(v)
        const play = () => v.play().catch(() => {})
        v.addEventListener('loadeddata', play)
        if (v.readyState >= 1) play()
      } else if (mime === 'text/html') {
        const f = document.createElement('iframe')
        f.sandbox = 'allow-scripts'
        f.src = wpData.dataUrl
        f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0'
        el.appendChild(f)
      }
    }

    /** 个性化主 CSS（随状态刷新）。 */
    function personalizationCss() {
      return `
#dsh-desktop-wallpaper-layer{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;background-size:cover;background-position:center;background-repeat:no-repeat}
html[data-dsh-wallpaper="on"] #root,html[data-dsh-glass="on"] #root{backdrop-filter:blur(var(--dsh-glass-blur,16px));-webkit-backdrop-filter:blur(var(--dsh-glass-blur,16px))}
html[data-dsh-wallpaper="on"] body,html[data-dsh-glass="on"] body{background:transparent}
html[data-dsh-glass="on"] #root::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;background:linear-gradient(135deg,rgba(255,255,255,.10),rgba(255,255,255,0) 45%);mix-blend-mode:overlay}
`
    }

    /**
     * 全局应用器：常驻（注册在 shell.overlay，渲染 null），
     * 负责把个性化设置落地：theme token 覆盖 + 壁纸层 + html 属性/CSS。
     */
    function PersonalizationApplier() {
      const state = usePState()
      const activeName = state && state.wallpaper ? state.wallpaper : null
      const [wpData, setWpData] = useState(null)

      // 首次挂载读取持久化设置
      useEffect(() => { loadPState() }, [])

      // 读取当前壁纸内容（data URL）
      useEffect(() => {
        if (!activeName) { setWpData(null); return }
        let cancelled = false
        RPC('personalization.getWallpaperData', { name: activeName })
          .then((r) => { if (!cancelled) setWpData(r) })
          .catch(() => { if (!cancelled) setWpData(null) })
        return () => { cancelled = true }
      }, [activeName])

      // 落地：token 覆盖 + 壁纸层 + 属性/CSS（改动即时生效，卸载时还原）
      useEffect(() => {
        if (!state) return
        const tokens = buildTokenLayers(state)
        const themeSvc = ctx.get('theme')
        const disposers = []
        if (themeSvc && typeof themeSvc.overrideTokens === 'function') {
          try {
            disposers.push(themeSvc.overrideTokens('dsh-desktop-personalization', tokens))
          } catch { /* 覆盖层校验失败时忽略 */ }
        }
        // 壁纸层
        if (activeName && wpData) applyWallpaperLayer(wpData)
        else clearWallpaperLayer()
        // html 属性 + CSS 变量
        const root = typeof document !== 'undefined' ? document.documentElement : null
        if (root) {
          root.setAttribute('data-dsh-wallpaper', activeName ? 'on' : 'off')
          root.setAttribute('data-dsh-glass', state.glass ? 'on' : 'off')
          root.setAttribute('data-dsh-skin', state.skin || 'default')
          const alignedBlur = Math.max(0, Math.min(40, Number(state.blur) || 0))
          root.style.setProperty('--dsh-glass-blur', alignedBlur + 'px')
        }
        let styleEl = typeof document !== 'undefined' ? document.getElementById('dsh-desktop-personalization-style') : null
        if (styleEl) styleEl.textContent = personalizationCss()
        else if (typeof document !== 'undefined') {
          styleEl = document.createElement('style')
          styleEl.id = 'dsh-desktop-personalization-style'
          styleEl.dataset.plugin = 'dsh-desktop-better-setting'
          styleEl.textContent = personalizationCss()
          document.head.appendChild(styleEl)
        }
        return () => {
          for (const d of disposers) { try { d() } catch { /* ignore */ } }
        }
      }, [state, activeName, wpData])

      return null
    }

    /** 通用设置 → 外观 下方的「个性化」二级菜单行。 */
    function PersonalizationRow() {
      const state = usePState()
      const [open, setOpen] = useState(false)
      const [wallpapers, setWallpapers] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const fileRef = useRef(null)

      const refreshWallpapers = useCallback(() => {
        RPC('personalization.listWallpapers')
          .then((r) => setWallpapers(r.items || []))
          .catch(() => setWallpapers([]))
      }, [])

      useEffect(() => {
        if (!open) return
        loadPState()
        refreshWallpapers()
      }, [open, refreshWallpapers])

      const update = async (patch) => {
        setNotice(null)
        const r = await savePState(patch)
        if (!r.ok) setNotice(t('personalization.failed', { message: r.message || '?' }))
        else setNotice(t('personalization.saved'))
      }

      const onUpload = () => {
        const input = fileRef.current
        if (!input) return
        input.value = ''
        input.click()
      }
      const onFile = (ev) => {
        const file = ev.target.files && ev.target.files[0]
        if (!file) return
        const okMime = /^image\//i.test(file.type) || /^video\//i.test(file.type) || /^text\/html$/i.test(file.type)
        if (!okMime) { setNotice(t('personalization.wallpaper.invalid')); return }
        setBusy(true)
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = String(reader.result || '')
          RPC('personalization.saveWallpaper', { name: file.name, dataUrl })
            .then(async (r) => {
              refreshWallpapers()
              await update({ wallpaper: r.file ? r.file.split(/(\\|\/)/).pop() : file.name })
              setBusy(false)
            })
            .catch((err) => {
              setNotice(t('personalization.failed', { message: err.message }))
              setBusy(false)
            })
        }
        reader.onerror = () => { setBusy(false); setNotice(t('personalization.wallpaper.invalid')) }
        reader.readAsDataURL(file)
      }
      const onApplyWallpaper = (name) => { update({ wallpaper: name }) }
      const onRemoveWallpaper = (name) => {
        RPC('personalization.removeWallpaper', { name })
          .then(async () => {
            refreshWallpapers()
            if (state && state.wallpaper === name) await update({ wallpaper: null })
          })
          .catch((err) => setNotice(t('personalization.failed', { message: err.message })))
      }

      const skin = SKINS.find((k) => k.id === (state ? state.skin : 'default')) || SKINS[0]
      const activeWallpaper = state ? state.wallpaper : null
      const wallpaperItems = Array.isArray(wallpapers) ? wallpapers : []

      return e('div', { className: 'pm-card' },
        e('button', {
          type: 'button',
          className: 'pm-header',
          'aria-expanded': open,
          'aria-label': `${open ? t('collapse') : t('expand')}: ${t('personalization.title')}`,
          onClick: () => setOpen(!open),
        },
          e('span', { className: 'pm-headText2' },
            e('span', { className: 'pm-name' }, '🎨 ' + t('personalization.title')),
            e('span', { className: 'pm-desc' }, t('personalization.hint')),
          ),
          e('span', { className: 'pm-chevron' + (open ? ' pm-chevronOpen' : '') }, e(ChevronIcon)),
        ),
        open
          ? e('div', { className: 'pm-body', style: { gap: 18 } },
              notice ? e('div', { className: 'pm-restart' }, notice) : null,

              // 皮肤（互斥）
              e('div', null,
                e('div', { className: 'pm-catLabel' }, t('personalization.skin')),
                e('div', { className: 'pm-hint', style: { marginBottom: 8 } }, t('personalization.skin.hint')),
                e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  SKINS.map((k) => e('button', {
                    key: k.id,
                    type: 'button',
                    className: 'pm-btn ' + (state && state.skin === k.id ? 'pm-btn-on' : 'pm-btn-outline'),
                    'aria-pressed': !!(state && state.skin === k.id),
                    onClick: () => update({ skin: k.id }),
                  }, k.name)),
                ),
              ),

              // 主题配色（强调色）
              e('div', null,
                e('div', { className: 'pm-catLabel' }, t('personalization.accent')),
                e('div', { className: 'pm-hint', style: { marginBottom: 8 } }, t('personalization.accent.hint')),
                e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                  ACCENT_PRESETS.map((c) => e('button', {
                    key: c,
                    type: 'button',
                    className: 'pm-btn pm-btn-outline',
                    style: { width: 30, height: 30, padding: 0, borderRadius: 8, background: c, borderColor: state && state.accent === c ? 'var(--dsw-alias-label-primary)' : 'transparent' },
                    'aria-label': c,
                    'aria-pressed': !!(state && state.accent === c),
                    onClick: () => update({ accent: c }),
                  })),
                  e('input', {
                    type: 'color',
                    value: (state && state.accent) || '#3964fe',
                    style: { width: 30, height: 30, padding: 0, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'transparent', cursor: 'pointer' },
                    title: t('personalization.accent.custom'),
                    'aria-label': t('personalization.accent.custom'),
                    onChange: (ev) => update({ accent: ev.target.value }),
                  }),
                  e('button', {
                    type: 'button',
                    className: 'pm-btn pm-btn-outline',
                    onClick: () => update({ accent: null }),
                  }, t('personalization.accent.reset')),
                ),
              ),

              // 壁纸
              e('div', null,
                e('div', { className: 'pm-catLabel' }, t('personalization.wallpaper')),
                e('div', { className: 'pm-hint', style: { marginBottom: 8 } }, t('personalization.wallpaper.hint')),
                e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  e('button', { type: 'button', className: 'pm-btn pm-btn-outline', onClick: onUpload, disabled: busy }, busy ? '…' : t('personalization.wallpaper.upload')),
                  e('button', {
                    type: 'button',
                    className: 'pm-btn ' + (activeWallpaper ? 'pm-btn-on' : 'pm-btn-off'),
                    onClick: () => update({ wallpaper: null }),
                    disabled: !activeWallpaper,
                  }, t('personalization.wallpaper.none')),
                  e('input', { ref: fileRef, type: 'file', accept: 'image/*,video/mp4,video/webm,video/quicktime,text/html,.html,.htm', style: { display: 'none' }, onChange: onFile, 'aria-hidden': true, tabIndex: -1 }),
                ),
                wallpaperItems.length > 0
                  ? e('div', { className: 'pm-list', style: { gap: 6, marginTop: 8 } },
                      wallpaperItems.map((w) => e('div', {
                        key: w.name,
                        className: 'pm-card',
                        style: { padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
                      },
                        e('span', { style: { flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } }, w.name),
                        w.size != null ? e('span', { className: 'pm-stars' }, t('personalization.age', { size: Math.max(1, Math.round(w.size / 1024)) })) : null,
                        activeWallpaper === w.name ? e('span', { className: 'pm-installed' }, t('personalization.wallpaper.active')) : null,
                        e('button', { type: 'button', className: 'pm-btn pm-btn-outline', onClick: () => onApplyWallpaper(w.name) }, t('personalization.wallpaper.apply')),
                        e('button', { type: 'button', className: 'pm-btn pm-btn-danger', onClick: () => onRemoveWallpaper(w.name) }, t('personalization.wallpaper.remove')),
                      )),
                    )
                  : e('div', { className: 'pm-empty', style: { padding: '8px 0' } }, t('personalization.wallpaper.none')),
              ),

              // 模糊
              e('div', null,
                e('div', { className: 'pm-catLabel' }, t('personalization.blur') + ' · ' + ((state ? state.blur : 16) || 0) + 'px'),
                e('div', { className: 'pm-hint', style: { marginBottom: 8 } }, t('personalization.blur.hint')),
                e('input', {
                  type: 'range',
                  min: 0,
                  max: 40,
                  step: 1,
                  value: (state ? state.blur : 16) || 0,
                  style: { width: '100%', accentColor: 'var(--dsw-alias-brand-primary,#3964fe)' },
                  onChange: (ev) => update({ blur: Number(ev.target.value) }),
                  'aria-label': t('personalization.blur'),
                }),
              ),

              // 液态玻璃
              e('div', null,
                e('div', { className: 'pm-catLabel' }, t('personalization.glass')),
                e('div', { className: 'pm-hint', style: { marginBottom: 8 } }, t('personalization.glass.hint')),
                e('button', {
                  type: 'button',
                  className: 'pm-btn ' + (state && state.glass ? 'pm-btn-on' : 'pm-btn-off'),
                  'aria-pressed': !!(state && state.glass),
                  onClick: () => update({ glass: !(state && state.glass) }),
                  style: { minWidth: 120 },
                }, state && state.glass ? t('enabled') : t('disabled')),
              ),
            )
          : null,
      )
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

    // ---- 个性化：通用设置 → 外观 下方二级菜单（order 11）+ 全局应用器 ----
    ctx.slots.inject('settings.general.item', () =>
      ctx.slots.register({
        name: 'settings.general.item',
        id: 'personalization',
        order: 11,
        locale: NS,
        label: () => t('personalization.title'),
        inject: () => ({}),
      }, PersonalizationRow),
    )
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({
        name: 'shell.overlay',
        id: 'personalization-applier',
        order: 90,
        label: () => t('personalization.title'),
        inject: () => ({}),
      }, PersonalizationApplier),
    )
  },
}
