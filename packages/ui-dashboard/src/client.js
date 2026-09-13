/**
 * ui-dashboard · Client 半边
 *
 * 右侧仪表盘（占据 shell 内置 `details` 槽位，同 ui-sidebar 占据 `sidebar` 的方式）：
 *  - 上下文卡片：左粗圆环（按系统提示/工具/消息三色分段、百分比内嵌环心）+ 右组成列表
 *  - 用量 · 费用 · 统计融合版块：KPI 汇总格 + 金额占比单条图 + 行内 token·金额 + 统计徽章
 *  - 目标 / 待办 / 后台任务 / 工作区 卡片
 *  - 会话头部「仪表盘」入口按钮（conversation.session.header.utilities 加法席位）
 *  - 会话标签页「仪表盘」（conversation.view 加法席位，与内置「对话」/「轨迹」并列）
 *
 * 数据全部来自官方会话投影与标准 props：
 *  contextPressure / contextBreakdown / tokenUsage / sessionStats / goal / todos
 *  useSessions.jobsBySession / useWorkspaces / useSession / layout
 *
 * 用法：将本文件内容作为 cordis_define 的 code.client 传入（纯 JS 函数体，无 JSX/TS）。
 */
return {
  inject: ['slots', 'layout', 'locale'],
  apply(ctx) {
    const NS = 'dashboard'
    const t = ctx.locale.bind(NS)

    // ---- 文案（zh 为键集基准，en 与之对齐） ----
    const zh = {
      'title': '仪表盘',
      'close': '关闭仪表盘',
      'open': '仪表盘',
      'openAria': '打开仪表盘',
      'view.dashboard': '仪表盘',
      'status.running': '运行中',
      'status.idle': '就绪',
      'context.title': '上下文',
      'context.empty': '等待模型上报用量后显示',
      'context.system': '系统提示',
      'context.tools': '工具',
      'context.messages': '消息',
      'metrics.title': '用量 · 费用 · 统计',
      'metrics.tokens': '总 Token',
      'metrics.cost': '费用',
      'usage.input': '输入',
      'usage.output': '输出',
      'usage.cacheRead': '缓存读取',
      'usage.cacheWrite': '缓存写入',
      'usage.cacheHit': '缓存命中',
      'cost.model': '模型',
      'cost.inputMiss': '输入（未命中缓存）',
      'cost.inputHit': '输入（命中缓存）',
      'cost.output': '输出',
      'cost.total': '合计（估算）',
      'cost.note': '按官方定价页价格估算（高峰时段；空闲时段约为一半）',
      'cost.unknown': '未知',
      'offline.title': '官方 tokenizer 离线统计',
      'offline.loading': '离线计算中…',
      'offline.error': '离线不可用（需本机 Python + 官方 tokenizer）',
      'offline.meta': '{messages} 条消息 · 输入 {user} · 输出 {assistant}',
      'offline.note': '本会话消息文本经官方 deepseek_tokenizer 计算；不含缓存，与账单口径不同',
      'tab.dashboard': '仪表盘',
      'tab.files': '文件树',
      'files.title': '文件树',
      'files.loading': '加载中…',
      'files.empty': '空目录',
      'files.error': '加载失败',
      'files.noWorkspace': '未关联工作区',
      'files.hidden': '显示隐藏',
      'files.root': '工作区根目录',
      'balance.title': '余额',
      'balance.loading': '查询中…',
      'balance.noKey': '未配置 {keyRef}（请到设置中填写）',
      'balance.unsupported': '当前模型 provider「{provider}」非 DeepSeek 官方，余额不可用',
      'balance.unsupportedHint': '订阅制或第三方平台没有统一余额接口；可在插件配置 balance.providers 自定义余额来源',
      'balance.error': '余额查询失败',
      'balance.refresh': '刷新余额',
      'balance.unavailable': '账户不可用',
      'balance.granted': '赠送',
      'balance.toppedUp': '充值',
      'balance.note': '来自 DeepSeek 账户余额 API',
      'usage.title': '套餐用量',
      'usage.rolling': '5 小时滚动',
      'usage.weekly': '本周',
      'usage.monthly': '本月',
      'usage.used': '已用 {percent}%',
      'usage.resetsAt': '{time} 重置',
      'usage.unknown': '不可用',
      'usage.note': '来自 OpenCode Go 官方用量 API',
      'credits.title': 'Credits 余额',
      'credits.total': '总量',
      'credits.used': '已用',
      'credits.remaining': '剩余',
      'credits.note': '来自官方预付费 credits API',
      'stats.turns': '轮次',
      'stats.steps': '步骤',
      'stats.llm': '模型耗时',
      'stats.tool': '工具耗时',
      'stats.ttft': '平均首字延迟',
      'stats.tps': '生成速度',
      'goal.title': '目标',
      'goal.phaseLabel': '阶段',
      'goal.roundsLabel': '已轮次',
      'goal.rounds': '{count} / {max} 轮',
      'goal.phase.active': '进行中',
      'goal.phase.paused': '已暂停',
      'goal.phase.blocked': '受阻',
      'goal.phase.complete': '已完成',
      'todo.title': '待办',
      'todo.done': '{done}/{total} 已完成',
      'jobs.title': '后台任务',
      'jobs.running': '运行中',
      'jobs.stopping': '停止中',
      'jobs.completed': '已完成',
      'jobs.killed': '已终止',
      'jobs.failed': '失败',
      'ws.title': '工作区',
      'ws.none': '未关联工作区',
      'ws.path': '路径',
      'note': '数据来自会话投影与估算，仅供参考'
    }
    const en = {
      'title': 'Dashboard',
      'close': 'Close dashboard',
      'open': 'Dashboard',
      'openAria': 'Open dashboard',
      'view.dashboard': 'Dashboard',
      'status.running': 'Running',
      'status.idle': 'Idle',
      'context.title': 'Context',
      'context.empty': 'Waiting for the model to report usage',
      'context.system': 'System',
      'context.tools': 'Tools',
      'context.messages': 'Messages',
      'metrics.title': 'Usage · Cost · Stats',
      'metrics.tokens': 'Total tokens',
      'metrics.cost': 'Cost',
      'usage.input': 'Input',
      'usage.output': 'Output',
      'usage.cacheRead': 'Cache read',
      'usage.cacheWrite': 'Cache write',
      'usage.cacheHit': 'Cache hit',
      'cost.model': 'Model',
      'cost.inputMiss': 'Input (cache miss)',
      'cost.inputHit': 'Input (cache hit)',
      'cost.output': 'Output',
      'cost.total': 'Total (estimate)',
      'cost.note': 'est. at official pricing (peak hours; off-peak is about half)',
      'cost.unknown': 'Unknown',
      'offline.title': 'Official tokenizer (offline)',
      'offline.loading': 'Tokenizing offline…',
      'offline.error': 'Offline unavailable (local Python + official tokenizer required)',
      'offline.meta': '{messages} messages · input {user} · output {assistant}',
      'offline.note': 'Session message texts counted by the official deepseek_tokenizer; cache-free, not the billing scope',
      'tab.dashboard': 'Dashboard',
      'tab.files': 'Files',
      'files.title': 'File tree',
      'files.loading': 'Loading…',
      'files.empty': 'Empty directory',
      'files.error': 'Failed to load',
      'files.noWorkspace': 'Not linked to a workspace',
      'files.hidden': 'Show hidden',
      'files.root': 'Workspace root',
      'balance.title': 'Balance',
      'balance.loading': 'Loading…',
      'balance.noKey': 'Balance key "{keyRef}" not configured (set it in Settings)',
      'balance.unsupported': 'Model provider "{provider}" is not DeepSeek official — balance unavailable',
      'balance.unsupportedHint': 'Subscription or third-party providers expose no unified balance API; configure balance.providers in the plugin config to customize',
      'balance.error': 'Balance query failed',
      'balance.refresh': 'Refresh balance',
      'balance.unavailable': 'Account unavailable',
      'balance.granted': 'Granted',
      'balance.toppedUp': 'Topped up',
      'balance.note': 'From the DeepSeek account balance API',
      'usage.title': 'Usage',
      'usage.rolling': 'Rolling 5h',
      'usage.weekly': 'This week',
      'usage.monthly': 'This month',
      'usage.used': '{percent}% used',
      'usage.resetsAt': 'resets {time}',
      'usage.unknown': 'N/A',
      'usage.note': 'From the OpenCode Go official usage API',
      'credits.title': 'Credits',
      'credits.total': 'Total',
      'credits.used': 'Used',
      'credits.remaining': 'Remaining',
      'credits.note': 'From the official prepaid credits API',
      'stats.turns': 'Turns',
      'stats.steps': 'Steps',
      'stats.llm': 'Model time',
      'stats.tool': 'Tool time',
      'stats.ttft': 'Avg TTFT',
      'stats.tps': 'Decode speed',
      'goal.title': 'Goal',
      'goal.phaseLabel': 'Phase',
      'goal.roundsLabel': 'Rounds',
      'goal.rounds': '{count} / {max} rounds',
      'goal.phase.active': 'Active',
      'goal.phase.paused': 'Paused',
      'goal.phase.blocked': 'Blocked',
      'goal.phase.complete': 'Complete',
      'todo.title': 'Todos',
      'todo.done': '{done}/{total} done',
      'jobs.title': 'Background jobs',
      'jobs.running': 'Running',
      'jobs.stopping': 'Stopping',
      'jobs.completed': 'Completed',
      'jobs.killed': 'Killed',
      'jobs.failed': 'Failed',
      'ws.title': 'Workspace',
      'ws.none': 'Not linked to a workspace',
      'ws.path': 'Path',
      'note': 'Data from session projections and estimates'
    }
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-dashboard: dictionaries')

    // ---- 展示格式化 ----
    const fmtTokens = (n) => {
      const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
      if (n < 1000) return String(n)
      if (n < 1000000) return `${scaled(n / 1000)}K`
      return `${scaled(n / 1000000)}M`
    }
    const fmtDuration = (ms) => {
      const s = ms / 1000
      if (s < 60) return `${Math.round(s * 10) / 10}s`
      const whole = Math.round(s)
      return `${Math.floor(whole / 60)}m${whole % 60}s`
    }
    const fmtTps = (tps) => `${Math.round(tps * 10) / 10} tok/s`
    const fmtMoney = (cny) => (cny >= 1 ? `¥${cny.toFixed(2)}` : `¥${cny.toFixed(4)}`)

    // 官方定价（人民币 / 1M tokens；高峰时段；空闲时段约为一半）
    // https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
    const PRICES = {
      'deepseek-v4-flash': { miss: 3, hit: 0.1, output: 9 },
      'deepseek-v4-pro': { miss: 9, hit: 0.3, output: 27 },
      'deepseek-v4-flash-vision': { miss: 3, hit: 0.1, output: 9 }
    }
    const DEFAULT_PRICE = PRICES['deepseek-v4-flash']
    const priceFor = (model) => {
      const m = model ?? ''
      if (m.includes('v4-pro')) return PRICES['deepseek-v4-pro']
      if (m.includes('v4-flash')) return PRICES['deepseek-v4-flash']
      return DEFAULT_PRICE
    }

    // 环图几何：120 viewBox，r=46，stroke 14（粗壮圆环）
    const R = 46
    const CIRC = 2 * Math.PI * R

    // ---- 线性图标（16 viewBox，stroke 风格） ----
    const ICONS = {
      'gauge': ['M8 2a6 6 0 1 1-6 6', 'M8 8l2.4-2.4'],
      'coin': ['M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2', 'M8 5.2v5.6', 'M6.6 6.3h1.9a1.35 1.35 0 0 1 0 2.7H6.9'],
      'bars': ['M3 13v-4M8 13V5M13 13V7'],
      'pulse': ['M2 8h3l2-4 3 8 2-4h2'],
      'target': ['M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11', 'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4'],
      'check': ['M2.5 4h6M2.5 8h6M2.5 12h3.5', 'M9.5 12l2 2 3.5-4'],
      'term': ['M2.5 4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z', 'M5.5 6l2 2-2 2', 'M9.5 10.5h3'],
      'folder': ['M2 4.5a1 1 0 0 1 1-1h3l1.5 2H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z'],
      'file': ['M3 2.5a1 1 0 0 1 1-1h5l4 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M9 1.5V6h4'],
      'refresh': ['M13.5 8a5.5 5.5 0 1 1-1.6-3.9', 'M11.9 1.5V5h3.5']
    }
    const svgIcon = (name, cls, size) => React.createElement(
      'svg', { viewBox: '0 0 16 16', width: size ?? 14, height: size ?? 14, 'aria-hidden': true, className: cls },
      ICONS[name].map((d, i) => React.createElement('path', {
        d, key: i, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round'
      }))
    )
    const cardHead = (iconName, text) => React.createElement('div', { className: 'udash-cardHead' }, [
      svgIcon(iconName, 'udash-cardIcon'),
      React.createElement('span', { className: 'udash-cardTitle' }, text)
    ])
    const swatch = (cls) => React.createElement('span', { className: `udash-swatch ${cls}`, 'aria-hidden': true })
    const row = (key, label, value, colorCls, extra) => React.createElement(
      'div', { className: `udash-row${extra === void 0 ? '' : ' ' + extra}`, key },
      [React.createElement('span', { className: 'udash-rowLabel' }, [colorCls === void 0 ? null : swatch(colorCls), label]),
       React.createElement('span', { className: 'udash-rowValue' }, value)]
    )
    const kpi = (key, label, value, hot) => React.createElement('div', { className: 'udash-kpi', key }, [
      React.createElement('div', { className: 'udash-kpiLabel' }, label),
      React.createElement('div', { className: 'udash-kpiValue', 'data-hot': hot || void 0 }, value)
    ])
    const chip = (key, text) => React.createElement('span', { className: 'udash-chip2', key }, text)
    // 堆叠条形图（parts: {key, cls, width}，宽度为百分比）
    const mbar = (prefix, parts) => {
      const shown = parts.filter((p) => p.width > 0)
      if (shown.length === 0) return null
      return React.createElement('div', { className: 'udash-bar udash-barLg' },
        shown.map((p) => React.createElement('div', {
          className: `udash-segment ${p.cls}`.trim(), key: `${prefix}-${p.key}`,
          style: { width: `${p.width}%` }
        })))
    }
    // 细进度条（hot=Reasonix accent 强调）
    const progress = (pct, key, hot) => React.createElement('div', { className: 'udash-progress', key }, [
      React.createElement('div', { className: 'udash-progressFill', 'data-hot': hot || void 0, style: { width: `${pct}%` } })
    ])

    // 数值化容错：投影字段可能局部缺失，NaN 会渲染成 "NaNM" 并让占比条错乱
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

    // 上下文卡片：左圆环（按系统/工具/消息三色分段）+ 右组成列表
    function ContextCard({ pressure, breakdown, t }) {
      const usedTokens = pressure === void 0 ? void 0 : (pressure.projectedTokens ?? pressure.pressureTokens)
      const windowTokens = pressure === void 0 ? void 0 : pressure.contextWindow
      const occupancy = (typeof usedTokens === 'number' && Number.isFinite(usedTokens) && typeof windowTokens === 'number' && windowTokens > 0)
        ? { percent: Math.min(100, Math.round((usedTokens / windowTokens) * 100)), usedTokens, windowTokens }
        : null
      const breakdownValid = breakdown !== void 0 && breakdown !== null
        && typeof breakdown === 'object'
        && Number.isFinite(breakdown.systemTokens)
        && Number.isFinite(breakdown.toolsTokens)
        && Number.isFinite(breakdown.messageTokens)
      const total = breakdownValid ? breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens : 0
      const base = occupancy === null ? 0 : occupancy.percent
      // 圆环分段：按组成比例切分已用部分（无组成数据时整段蓝色）
      const arcs = []
      if (breakdownValid && total > 0) {
        const defs = [
          { key: 'system', cls: 'udash-ringSystem', len: base * breakdown.systemTokens / total },
          { key: 'tools', cls: 'udash-ringTools', len: base * breakdown.toolsTokens / total },
          { key: 'messages', cls: 'udash-ringMessages', len: base * breakdown.messageTokens / total }
        ]
        let acc = 0
        defs.forEach((d) => {
          if (d.len <= 0) return
          arcs.push(React.createElement('circle', {
            className: `udash-ringFill ${d.cls}`.trim(), cx: 60, cy: 60, r: R, key: d.key,
            strokeDasharray: `${d.len / 100 * CIRC} ${CIRC}`,
            strokeDashoffset: -(acc / 100 * CIRC),
            transform: 'rotate(-90 60 60)'
          }))
          acc += d.len
        })
      } else if (base > 0) {
        arcs.push(React.createElement('circle', {
          className: 'udash-ringFill', cx: 60, cy: 60, r: R, key: 'total',
          strokeDasharray: `${base / 100 * CIRC} ${CIRC}`,
          transform: 'rotate(-90 60 60)'
        }))
      }
      const segments = (!breakdownValid || total === 0)
        ? (occupancy === null ? [] : [{ key: 'total', cls: '', width: base }])
        : [
            { key: 'system', cls: 'udash-colorSystem', width: base * breakdown.systemTokens / total },
            { key: 'tools', cls: 'udash-colorTools', width: base * breakdown.toolsTokens / total },
            { key: 'messages', cls: 'udash-colorMessages', width: base * breakdown.messageTokens / total }
          ].filter((s) => s.width > 0)
      const children = [cardHead('gauge', t('context.title'))]
      if (occupancy === null) {
        children.push(React.createElement('div', { className: 'udash-empty', key: 'empty' }, t('context.empty')))
      } else {
        children.push(React.createElement('div', { className: 'udash-contextRow', key: 'row' }, [
          React.createElement('div', { className: 'udash-contextLeft', key: 'left' }, [
            React.createElement('div', { className: 'udash-ringWrap' }, [
              React.createElement('svg', { viewBox: '0 0 120 120', width: 110, height: 110, 'aria-hidden': true }, [
                React.createElement('circle', { className: 'udash-ringTrack', cx: 60, cy: 60, r: R }),
                arcs
              ]),
              React.createElement('div', { className: 'udash-ringLabel' }, `${occupancy.percent}%`)
            ]),
            React.createElement('div', { className: 'udash-figures' },
              `~${fmtTokens(occupancy.usedTokens)} / ${fmtTokens(occupancy.windowTokens)}`)
          ]),
          React.createElement('div', { className: 'udash-contextRight', key: 'right' },
            !breakdownValid
              ? React.createElement('div', { className: 'udash-empty' }, t('context.empty'))
              : [
                  React.createElement('div', { className: 'udash-rows', key: 'legend' }, [
                    row('system', t('context.system'), `~${fmtTokens(breakdown.systemTokens)}`, 'udash-colorSystem'),
                    row('tools', t('context.tools'), `~${fmtTokens(breakdown.toolsTokens)}`, 'udash-colorTools'),
                    row('messages', t('context.messages'), `~${fmtTokens(breakdown.messageTokens)}`, 'udash-colorMessages')
                  ]),
                  React.createElement('div', { className: 'udash-bar', key: 'bar' },
                    segments.map((s) => React.createElement('div', {
                      className: `udash-segment ${s.cls}`.trim(), key: s.key,
                      style: { width: `${s.width}%` }
                    })))
                ])
        ]))
      }
      return React.createElement('section', { className: 'udash-card' }, children)
    }

    // 融合版块：用量 / 费用 / 统计 一张卡片（KPI 汇总 + 三段金额占比条 + 行内 token·金额 + 统计徽章）
    function MetricsCard({ usage, model, stats, sessionId, t }) {
      const billed = usage === void 0 ? 0 : num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
      const hasUsage = usage !== void 0 && usage !== null && (billed > 0 || num(usage.outputTokens) > 0)
      const hasStats = stats !== void 0 && stats !== null && num(stats.steps) > 0
      if (!hasUsage && !hasStats) return null
      const p = priceFor(model)
      // 三段口径：未命中（含缓存写入，按未命中价计费）/ 命中缓存 / 输出
      const missTokens = hasUsage ? num(usage.uncachedInputTokens) + num(usage.cacheWriteTokens) : 0
      const hitTokens = hasUsage ? num(usage.cacheReadTokens) : 0
      const outTokens = hasUsage ? num(usage.outputTokens) : 0
      const costMiss = missTokens / 1e6 * p.miss
      const costHit = hitTokens / 1e6 * p.hit
      const costOutput = outTokens / 1e6 * p.output
      const costTotal = costMiss + costHit + costOutput
      const kids = [cardHead('bars', t('metrics.title'))]
      // KPI 汇总行
      const kpis = []
      if (hasStats) {
        kpis.push(kpi('turns', t('stats.turns'), String(num(stats.turns))))
        kpis.push(kpi('steps', t('stats.steps'), String(num(stats.steps))))
      }
      if (hasUsage) {
        kpis.push(kpi('tokens', t('metrics.tokens'), fmtTokens(billed + outTokens), true))
        kpis.push(kpi('cost', t('metrics.cost'), fmtMoney(costTotal), true))
      }
      kids.push(React.createElement('div', { className: 'udash-kpis', key: 'kpis' }, kpis))
      // 三段金额占比条 + 行内 token·金额
      if (hasUsage) {
        const hitPct = billed === 0 ? null : Math.round((hitTokens / billed) * 100)
        const segTotal = costTotal > 0 ? costTotal : 1
        kids.push(mbar('cost', [
          { key: 'miss', cls: 'udash-colorMessages', width: costMiss / segTotal * 100 },
          { key: 'hit', cls: 'udash-colorSystem', width: costHit / segTotal * 100 },
          { key: 'output', cls: 'udash-colorTools', width: costOutput / segTotal * 100 }
        ]))
        const rows = [
          row('miss', t('cost.inputMiss'), `${fmtTokens(missTokens)} · ${fmtMoney(costMiss)}`, 'udash-colorMessages'),
          row('hit', t('cost.inputHit'), `${fmtTokens(hitTokens)} · ${fmtMoney(costHit)}`, 'udash-colorSystem'),
          row('output', t('cost.output'), `${fmtTokens(outTokens)} · ${fmtMoney(costOutput)}`, 'udash-colorTools')
        ]
        kids.push(React.createElement('div', { className: 'udash-rows', key: 'rows' }, rows))
        kids.push(React.createElement('div', { className: 'udash-rows', key: 'total' }, row('total', t('cost.total'), fmtMoney(costTotal), void 0, 'udash-rowStrong')))
        kids.push(React.createElement('div', { className: 'udash-chips', key: 'chips' }, [
          hitPct === null ? null : chip('hit', `${t('usage.cacheHit')} ${hitPct}%`),
          chip('model', `${t('cost.model')}：${model ?? t('cost.unknown')}`)
        ]))
        kids.push(React.createElement('div', { className: 'udash-modelLine', key: 'note' }, t('cost.note')))
        // 官方 tokenizer 离线统计
        kids.push(React.createElement(OfflineTokens, { sessionId, t, key: 'offline' }))
      }
      // 统计徽章（耗时 / 速度，与上方 KPI 互补）
      if (hasStats) {
        const chips = []
        if (num(stats.llmMs) > 0) chips.push(chip('llm', `${t('stats.llm')} ${fmtDuration(num(stats.llmMs))}`))
        if (num(stats.toolMs) > 0) chips.push(chip('tool', `${t('stats.tool')} ${fmtDuration(num(stats.toolMs))}`))
        if (num(stats.ttftSteps) > 0) chips.push(chip('ttft', `${t('stats.ttft')} ${fmtDuration(num(stats.ttftMs) / num(stats.ttftSteps))}`))
        if (num(stats.decodeMs) > 0) chips.push(chip('tps', `${t('stats.tps')} ${fmtTps(num(stats.decodeTokens) / (num(stats.decodeMs) / 1000))}`))
        kids.push(React.createElement('div', { className: 'udash-chips', key: 'chips' }, chips))
      }
      return React.createElement('section', { className: 'udash-card' }, kids)
    }

    // 官方 tokenizer 离线统计（Host 读会话日志 → 官方 tokenizer 计算消息文本 token）
    function OfflineTokens({ sessionId, t }) {
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      React.useEffect(() => {
        if (sessionId === void 0 || sessionId === null) return
        let alive = true
        host.call('offline-messages', { sessionId }).then((r) => {
          if (!alive) return
          if (r === null || typeof r !== 'object' || r.status !== 'ok') throw new Error(r !== null && r.message ? String(r.message) : 'bad offline response')
          setState({ status: 'ok', data: r, error: null })
        }).catch((e) => {
          if (alive) setState({ status: 'error', data: null, error: e instanceof Error ? e.message : String(e) })
        })
        return () => { alive = false }
      }, [sessionId])
      const meta = state.status === 'ok' && state.data !== null
        ? t('offline.meta', {
            messages: String(state.data.messages ?? 0),
            user: fmtTokens(state.data.userTokens ?? 0),
            assistant: fmtTokens(state.data.assistantTokens ?? 0)
          })
        : state.status === 'loading' ? t('offline.loading') : t('offline.error')
      return React.createElement('div', { className: 'udash-rows' }, [
        row('offline', t('offline.title'), meta),
        React.createElement('div', { className: 'udash-empty' }, t('offline.note'))
      ])
    }

    // 余额卡片：DeepSeek 账户余额（Host 经 /rpc balance 查询，API key 不离开 harness 进程）
    const BALANCE_SYMBOL = { 'CNY': '¥', 'USD': '$', 'EUR': '€' }
    function BalanceCard({ t }) {
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      // 卸载守卫：卡片移除后迟到的响应不得再 setState
      const aliveRef = React.useRef(true)
      React.useEffect(() => () => { aliveRef.current = false }, [])
      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading' }))
        host.call('balance', {}).then((r) => {
          if (!aliveRef.current) return
          if (r === null || typeof r !== 'object' || typeof r.status !== 'string') throw new Error('bad balance response')
          setState({ status: r.status, data: r, error: null })
        }).catch((e) => {
          if (!aliveRef.current) return
          setState({ status: 'error', data: null, error: e instanceof Error ? e.message : String(e) })
        })
      }, [])
      React.useEffect(() => { load() }, [load])
      const money = (currency, value) => {
        if (value === void 0 || value === null || value === '') return '—'
        const sym = BALANCE_SYMBOL[currency] ?? (currency === void 0 ? '' : `${currency} `)
        return sym + String(value)
      }
      const kind = state.data !== null && (state.data.kind === 'usage' || state.data.kind === 'credits') ? state.data.kind : 'money'
      const kindTitle = kind === 'usage' ? t('usage.title') : kind === 'credits' ? t('credits.title') : t('balance.title')
      const kids = [
        React.createElement('div', { className: 'udash-cardHeadRow', key: 'head' }, [
          cardHead('coin', kindTitle),
          React.createElement('button', {
            type: 'button', className: 'udash-refresh', key: 'refresh',
            'aria-label': t('balance.refresh'), title: t('balance.refresh'), onClick: load
          }, svgIcon('refresh', void 0, 13))
        ])
      ]
      if (state.status === 'loading') {
        kids.push(React.createElement('div', { className: 'udash-empty', key: 'body' }, t('balance.loading')))
      } else if (state.status === 'no-key') {
        kids.push(React.createElement('div', { className: 'udash-empty', key: 'body' }, t('balance.noKey', { keyRef: state.data !== null && state.data.keyRef ? state.data.keyRef : 'DEEPSEEK_API_KEY' })))
      } else if (state.status === 'unsupported') {
        kids.push(React.createElement('div', { className: 'udash-empty', key: 'body' }, [
          t('balance.unsupported', { provider: state.data !== null && state.data.provider ? state.data.provider : '?' }),
          React.createElement('div', { className: 'udash-balanceErr', key: 'hint' }, t('balance.unsupportedHint'))
        ]))
      } else if (state.status === 'error') {
        kids.push(React.createElement('div', { className: 'udash-empty', key: 'body' }, [
          t('balance.error'),
          state.error !== null && state.error !== '' ? React.createElement('div', { className: 'udash-balanceErr', key: 'msg' }, String(state.error)) : null
        ]))
      } else if (kind === 'usage') {
        // OpenCode Go 套餐用量：rolling / weekly / monthly 三个窗口
        const windows = state.data !== null && state.data.windows !== null && typeof state.data.windows === 'object' ? state.data.windows : {}
        const fmtReset = (iso) => {
          if (typeof iso !== 'string') return String(iso ?? '')
          const d = new Date(iso)
          if (isNaN(d.getTime())) return iso
          return d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        }
        kids.push(React.createElement('div', { className: 'udash-rows', key: 'rows' },
          ['rolling', 'weekly', 'monthly'].map((name) => {
            const w = windows[name]
            if (w === void 0 || w === null || w.status !== 'ok' || typeof w.percent !== 'number') {
              return row(name, t('usage.' + name), t('usage.unknown'), void 0)
            }
            return React.createElement('div', { className: 'udash-usageRow', key: name }, [
              row(name, t('usage.' + name), t('usage.used', { percent: String(Math.round(w.percent)) }), void 0),
              progress(Math.min(100, Math.max(0, w.percent)), 'bar'),
              w.resetsAt !== void 0 && w.resetsAt !== null ? React.createElement('div', { className: 'udash-empty', key: 'reset' }, t('usage.resetsAt', { time: fmtReset(w.resetsAt) })) : null
            ])
          })))
        kids.push(React.createElement('div', { className: 'udash-empty', key: 'note' }, t('usage.note')))
      } else if (kind === 'credits') {
        // 预付费 credits（OpenRouter 等）：总量 / 已用 / 剩余
        const d = state.data !== null && typeof state.data === 'object' ? state.data : {}
        const total = typeof d.total === 'number' ? d.total : void 0
        const used = typeof d.used === 'number' ? d.used : void 0
        if (total === void 0 && used === void 0) {
          kids.push(React.createElement('div', { className: 'udash-empty', key: 'body' }, '—'))
        } else {
          const remaining = total !== void 0 && used !== void 0 ? Math.max(0, total - used) : void 0
          const pct = total !== void 0 && total > 0 && used !== void 0 ? Math.min(100, Math.max(0, used / total * 100)) : void 0
          kids.push(React.createElement('div', { className: 'udash-usageRow', key: 'row' }, [
            total !== void 0 ? row('total', t('credits.total'), String(total), void 0, 'udash-rowStrong') : null,
            used !== void 0 ? row('used', t('credits.used'), String(used), void 0) : null,
            remaining !== void 0 ? row('remaining', t('credits.remaining'), String(remaining), void 0) : null,
            pct !== void 0 ? progress(pct, 'bar') : null
          ]))
        }
        kids.push(React.createElement('div', { className: 'udash-empty', key: 'note' }, t('credits.note')))
      } else {
        const infos = state.data !== null && Array.isArray(state.data.infos) ? state.data.infos : []
        if (infos.length === 0) {
          kids.push(React.createElement('div', { className: 'udash-empty', key: 'body' }, '—'))
        } else {
          kids.push(React.createElement('div', { className: 'udash-rows', key: 'rows' },
            infos.map((i, idx) => {
              const chips = []
              if (i.toppedUpBalance !== void 0 && i.toppedUpBalance !== null && i.toppedUpBalance !== '') chips.push(chip('top', `${t('balance.toppedUp')} ${money(i.currency, i.toppedUpBalance)}`))
              if (i.grantedBalance !== void 0 && i.grantedBalance !== null && i.grantedBalance !== '') chips.push(chip('grant', `${t('balance.granted')} ${money(i.currency, i.grantedBalance)}`))
              // 同币种多条目时 currency 会重复 → 用下标保证 key 唯一
              const rowKey = `${i.currency ?? 'x'}-${idx}`
              return React.createElement('div', { className: 'udash-balanceRow', key: rowKey }, [
                row(rowKey, i.currency ?? '—', money(i.currency, i.totalBalance), void 0, 'udash-rowStrong'),
                chips.length > 0 ? React.createElement('div', { className: 'udash-chips', key: 'chips' }, chips) : null
              ])
            })))
          if (state.data !== null && state.data.isAvailable === false) {
            kids.push(React.createElement('span', { className: 'udash-chip2', key: 'avail' }, t('balance.unavailable')))
          }
        }
        kids.push(React.createElement('div', { className: 'udash-empty', key: 'note' }, t('balance.note')))
      }
      return React.createElement('section', { className: 'udash-card' }, kids)
    }

    // 目标卡片：目标 + 轮次进度条
    const GOAL_PHASES = ['active', 'paused', 'blocked', 'complete']
    function GoalCard({ goal, t }) {
      if (goal === null || goal === void 0) return null
      const g = goal.goal
      // 投影可能只给了外层（goal.goal 缺失）：不要继续取字段，否则整棵面板崩掉
      if (g === null || g === void 0 || typeof g !== 'object') return null
      const max = num(g.maxGoalRounds) > 0 ? num(g.maxGoalRounds) : 0
      const started = num(goal.roundsStarted)
      const pct = max > 0 ? Math.min(100, Math.round(started / max * 100)) : 0
      const phase = GOAL_PHASES.indexOf(g.phase) >= 0 ? g.phase : 'active'
      return React.createElement('section', { className: 'udash-card' }, [
        cardHead('target', t('goal.title')),
        React.createElement('div', { className: 'udash-item', key: 'obj' }, [
          React.createElement('span', { className: 'udash-itemDot udash-dot-muted', 'aria-hidden': true }),
          React.createElement('span', { className: 'udash-goalObjective' }, g.objective)
        ]),
        max > 0 ? progress(pct, 'progress') : null,
        React.createElement('div', { className: 'udash-rows', key: 'meta' }, [
          row('phase', t('goal.phaseLabel'), t('goal.phase.' + phase)),
          row('rounds', t('goal.roundsLabel'), t('goal.rounds', { count: started, max }))
        ])
      ])
    }

    // 待办卡片：完成进度条 + 列表
    const TODO_DOT = { 'pending': 'udash-dot-pending', 'in_progress': 'udash-dot-running', 'completed': 'udash-dot-complete' }
    function TodosCard({ todos, t }) {
      if (todos === null || todos === void 0 || todos.length === 0) return null
      const done = todos.filter((x) => x.status === 'completed').length
      const pct = Math.round(done / todos.length * 100)
      return React.createElement('section', { className: 'udash-card' }, [
        cardHead('check', t('todo.title')),
        progress(pct, 'progress', true),
        React.createElement('div', { className: 'udash-rows', key: 'items' },
          todos.slice(0, 5).map((x, i) => React.createElement('div', { className: 'udash-item', key: i }, [
            React.createElement('span', { className: `udash-itemDot ${TODO_DOT[x.status] ?? 'udash-dot-muted'}`, 'aria-hidden': true }),
            React.createElement('span', { className: 'udash-itemLabel' }, x.content)
          ]))),
        React.createElement('div', { className: 'udash-empty', key: 'summary' }, t('todo.done', { done, total: todos.length }))
      ])
    }

    // 后台任务卡片：状态徽章 + 列表
    const JOB_DOT = { 'running': 'udash-dot-running', 'stopping': 'udash-dot-muted', 'completed': 'udash-dot-complete', 'killed': 'udash-dot-muted', 'failed': 'udash-dot-muted' }
    function JobsCard({ jobs, t }) {
      if (jobs === void 0 || jobs.length === 0) return null
      const counts = {}
      jobs.forEach((j) => { counts[j.status] = (counts[j.status] ?? 0) + 1 })
      const chips = Object.keys(counts).map((s) => React.createElement('span', { className: 'udash-chip2', key: s }, [
        React.createElement('span', { className: `udash-itemDot ${JOB_DOT[s] ?? 'udash-dot-muted'}`, 'aria-hidden': true }),
        `${t('jobs.' + s)} ${counts[s]}`
      ]))
      return React.createElement('section', { className: 'udash-card' }, [
        cardHead('term', t('jobs.title')),
        chips.length > 0 ? React.createElement('div', { className: 'udash-chips', key: 'chips' }, chips) : null,
        React.createElement('div', { className: 'udash-rows', key: 'items' },
          jobs.slice(0, 5).map((j, i) => React.createElement('div', { className: 'udash-item', key: i }, [
            React.createElement('span', { className: `udash-itemDot ${JOB_DOT[j.status] ?? 'udash-dot-muted'}`, 'aria-hidden': true }),
            React.createElement('span', { className: 'udash-itemLabel', title: j.label }, j.label),
            React.createElement('span', { className: 'udash-itemStatus' }, t('jobs.' + j.status))
          ])))
      ])
    }

    // 工作区卡片
    function WorkspaceCard({ workspace, t }) {
      return React.createElement('section', { className: 'udash-card' }, [
        cardHead('folder', t('ws.title')),
        workspace === null
          ? React.createElement('div', { className: 'udash-empty', key: 'empty' }, t('ws.none'))
          : React.createElement('div', { className: 'udash-rows', key: 'rows' }, [
              row('title', workspace.title, workspace.title),
              row('path', t('ws.path'), workspace.path, void 0, 'udash-pathRow')
            ])
      ])
    }

    // 当前模型（Host 读取默认模型选择，一次拉取）
    function useCurrentModel() {
      const [model, setModel] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        host.call('current-model', {}).then((r) => {
          if (alive && r !== null && typeof r === 'object' && typeof r.model === 'string' && r.model !== '') setModel(r.model)
        }).catch(() => {})
        return () => { alive = false }
      }, [])
      return model
    }

    // 右栏主体：仪表盘（双页：仪表盘 / 文件树）
    function DashboardPanel({ useSessions, useSession, useWorkspaces, sessionId, useProjection, t, closeDetails, tab }) {
      const rootCls = tab === true ? 'udash-root udash-rootTab' : 'udash-root'
      const [page, setPage] = React.useState('dashboard')
      const summary = useSessions((list) => (sessionId === void 0 ? null : (list.byId[sessionId] ?? null)))
      const jobs = useSessions((list) => (sessionId === void 0 ? [] : (list.jobsBySession[sessionId] ?? [])))
      const running = useSession((s) => s.running) === true
      const pressure = useProjection('contextPressure')
      const breakdown = useProjection('contextBreakdown')
      const usage = useProjection('tokenUsage')
      const stats = useProjection('sessionStats')
      const goal = useProjection('goal')
      const todos = useProjection('todos')
      const workspace = useWorkspaces((list) => (sessionId === void 0 ? null : (list.items.find((w) => w.sessionIds.indexOf(sessionId) >= 0) ?? null)))
      const model = useCurrentModel()
      const title = summary === null || summary.displayTitle === '' ? t('title') : summary.displayTitle
      const pageBody = page === 'files'
        ? React.createElement(FileTreePage, { workspace, t, key: 'files' })
        : [
            React.createElement(ContextCard, { pressure, breakdown, t, key: 'context' }),
            React.createElement(MetricsCard, { usage, model, stats, sessionId, t, key: 'metrics' }),
            React.createElement(BalanceCard, { t, key: 'balance' }),
            React.createElement(GoalCard, { goal, t, key: 'goal' }),
            React.createElement(TodosCard, { todos, t, key: 'todos' }),
            React.createElement(JobsCard, { jobs, t, key: 'jobs' }),
            React.createElement(WorkspaceCard, { workspace, t, key: 'ws' }),
            React.createElement('div', { className: 'udash-note', key: 'note' }, t('note'))
          ]
      return React.createElement('div', { className: rootCls, 'data-active': running || void 0 }, [
        React.createElement('header', { className: 'udash-header', key: 'header' }, [
          svgIcon('gauge', 'udash-headerIcon', 16),
          React.createElement('div', { className: 'udash-title', title: title, key: 'title' }, title),
          React.createElement('span', { className: 'udash-chip', 'data-running': running || void 0, key: 'chip' },
            running ? t('status.running') : t('status.idle')),
          React.createElement('button', {
            type: 'button', className: 'udash-close', key: 'close',
            'aria-label': t('close'), title: t('close'),
            onClick: () => closeDetails()
          }, React.createElement('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
            React.createElement('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })))
        ]),
        React.createElement('div', { className: 'udash-tabs', key: 'tabs' }, [
          React.createElement('button', {
            type: 'button', className: `udash-tab${page === 'dashboard' ? ' udash-tabActive' : ''}`, key: 'tabDash',
            onClick: () => setPage('dashboard')
          }, t('tab.dashboard')),
          React.createElement('button', {
            type: 'button', className: `udash-tab${page === 'files' ? ' udash-tabActive' : ''}`, key: 'tabFiles',
            onClick: () => setPage('files')
          }, t('tab.files'))
        ]),
        pageBody
      ])
    }

    // 文件树页：懒加载当前工作区目录树（Host 经 fs 服务列出文件与目录）
    const fmtBytes = (n) => {
      if (n === void 0 || n === null) return ''
      if (n < 1024) return `${n} B`
      if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
      if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
      return `${(n / 1073741824).toFixed(2)} GB`
    }
    function FileTreePage({ workspace, t }) {
      const rootPath = workspace === null ? null : workspace.path
      const [children, setChildren] = React.useState({})
      const [expanded, setExpanded] = React.useState({})
      const [showHidden, setShowHidden] = React.useState(false)
      const load = React.useCallback((path) => {
        if (path === void 0 || path === null) return
        setChildren((c) => {
          if (c[path] !== void 0) return c
          return Object.assign({}, c, { [path]: { status: 'loading', entries: [], message: null } })
        })
        host.call('dir', { path }).then((r) => {
          if (r === null || typeof r !== 'object' || r.status !== 'ok') throw new Error(r !== null && r.message ? String(r.message) : 'bad dir response')
          setChildren((c) => ({ ...c, [path]: { status: 'ok', entries: Array.isArray(r.entries) ? r.entries : [], message: null } }))
        }).catch((e) => {
          setChildren((c) => ({ ...c, [path]: { status: 'error', entries: [], message: e instanceof Error ? e.message : String(e) } }))
        })
      }, [])
      React.useEffect(() => {
        if (rootPath === null) return
        setChildren({})
        setExpanded({})
        load(rootPath)
        setExpanded({ [rootPath]: true })
      }, [rootPath, load])
      const toggle = (path) => {
        const next = expanded[path] === true ? false : true
        setExpanded((e) => ({ ...e, [path]: next }))
        if (next) load(path)
      }
      const sortList = (list) => {
        const dirs = list.filter((e) => e.type === 'directory').sort((a, b) => a.name.localeCompare(b.name))
        const files = list.filter((e) => e.type !== 'directory').sort((a, b) => a.name.localeCompare(b.name))
        return dirs.concat(files)
      }
      const renderChildren = (path, depth) => {
        const st = children[path]
        if (st === void 0) return []
        if (st.status === 'loading') {
          return [React.createElement('div', { className: 'udash-treeRow', style: { paddingLeft: depth * 16 + 8 }, key: path + ':loading' }, [
            React.createElement('span', { className: 'udash-treeGutter', 'aria-hidden': true }),
            React.createElement('span', { className: 'udash-empty' }, t('files.loading'))
          ])]
        }
        if (st.status === 'error') {
          return [React.createElement('div', { className: 'udash-treeRow', style: { paddingLeft: depth * 16 + 8 }, key: path + ':error' }, [
            React.createElement('span', { className: 'udash-treeGutter', 'aria-hidden': true }),
            React.createElement('span', { className: 'udash-empty' }, `${t('files.error')}${st.message !== null ? `：${st.message}` : ''}`)
          ])]
        }
        const list = sortList(st.entries.filter((e) => showHidden || !e.name.startsWith('.')))
        if (list.length === 0) {
          return [React.createElement('div', { className: 'udash-treeRow', style: { paddingLeft: depth * 16 + 8 }, key: path + ':empty' }, [
            React.createElement('span', { className: 'udash-treeGutter', 'aria-hidden': true }),
            React.createElement('span', { className: 'udash-empty' }, t('files.empty'))
          ])]
        }
        const rows = []
        list.forEach((e) => {
          if (e.type === 'directory') {
            const open = expanded[e.path] === true
            rows.push(React.createElement('div', {
              className: 'udash-treeRow udash-treeDir', key: e.path,
              style: { paddingLeft: depth * 16 + 8 }, onClick: () => toggle(e.path)
            }, [
              React.createElement('span', { className: 'udash-treeGutter', 'aria-hidden': true }, open ? '▾' : '▸'),
              svgIcon('folder', 'udash-treeIcon'),
              React.createElement('span', { className: 'udash-treeName', title: e.path }, e.name)
            ]))
            if (open) rows.push(...renderChildren(e.path, depth + 1))
          } else {
            rows.push(React.createElement('div', {
              className: 'udash-treeRow', key: e.path, style: { paddingLeft: depth * 16 + 8 }
            }, [
              React.createElement('span', { className: 'udash-treeGutter', 'aria-hidden': true }),
              svgIcon('file', 'udash-treeIcon'),
              React.createElement('span', { className: 'udash-treeName', title: e.path }, e.name),
              e.size !== void 0 && e.size !== null ? React.createElement('span', { className: 'udash-treeSize' }, fmtBytes(e.size)) : null
            ]))
          }
        })
        return rows
      }
      if (workspace === null) {
        return React.createElement('section', { className: 'udash-card' }, [
          cardHead('folder', t('files.title')),
          React.createElement('div', { className: 'udash-empty' }, t('files.noWorkspace'))
        ])
      }
      return React.createElement('section', { className: 'udash-card' }, [
        React.createElement('div', { className: 'udash-cardHeadRow' }, [
          cardHead('folder', t('files.title')),
          React.createElement('button', {
            type: 'button', className: 'udash-refresh', 'aria-label': t('files.hidden'), title: t('files.hidden'),
            onClick: () => setShowHidden(!showHidden)
          }, React.createElement('span', { className: 'udash-hiddenToggle', 'data-on': showHidden || void 0 }, '·'))
        ]),
        React.createElement('div', { className: 'udash-pathRow' }, `${workspace.title} · ${workspace.path}`),
        React.createElement('div', { className: 'udash-tree', key: 'tree' }, renderChildren(rootPath, 0))
      ])
    }

    // 会话头部入口按钮（打开右栏仪表盘）
    function DashboardToggle({ t, openDashboard }) {
      return React.createElement('button', {
        type: 'button', className: 'udash-toggle',
        'aria-label': t('openAria'), title: t('openAria'),
        onClick: () => openDashboard()
      }, [
        svgIcon('gauge', void 0, 13),
        React.createElement('span', { key: 'label' }, t('open'))
      ])
    }

    // ---- 注册：右栏仪表盘（占据 details，同 ui-sidebar 占据 sidebar 的方式） ----
    ctx.slots.inject('details', () => ctx.slots.register(
      { name: 'details', locale: NS, inject: () => ({ closeDetails: () => ctx.layout.closeDetails() }) },
      DashboardPanel
    ))

    // 注：不再注册 conversation.view 会话标签页——仪表盘只出现在右侧栏
    // （用户要求：对话/轨迹标签保持官方原样）

    // ---- 注册：会话头部入口（加法席位，不遮蔽任何现有 UI） ----
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'dashboard',
        order: 10,
        locale: NS,
        inject: () => ({ openDashboard: () => ctx.layout.openDetails() })
      },
      DashboardToggle
    ))

    // ---- 包级样式（随 Client run 自动清理） ----
    ctx.effect(() => styles.insert(`
.udash-root{box-sizing:border-box;height:100%;display:flex;flex-direction:column;gap:12px;padding:12px;overflow:auto;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.udash-rootTab{width:100%;max-width:960px;margin:0 auto;padding:24px 20px}
.udash-rootTab .udash-card{box-shadow:0 1px 3px rgba(0,0,0,.06)}
.udash-header{flex:none;display:flex;align-items:center;gap:8px}
.udash-headerIcon{flex:none;color:var(--dsw-alias-label-tertiary)}
.udash-title{flex:1;min-width:0;font-size:15px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.udash-chip{flex:none;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;font-size:11px;line-height:20px}
.udash-chip[data-running]{color:var(--dsw-alias-label-primary)}
.udash-close{flex:none;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;border-radius:50%;padding:0}
.udash-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.udash-card{flex:none;display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px}
.udash-cardHead{display:flex;align-items:center;gap:6px}
.udash-cardHeadRow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.udash-refresh{flex:none;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:none;border:none;border-radius:50%;padding:0}
.udash-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.udash-balanceRow{display:flex;flex-direction:column;gap:4px}
.udash-usageRow{display:flex;flex-direction:column;gap:4px}
.udash-balanceErr{color:var(--dsw-alias-label-tertiary);font-size:12px;word-break:break-all}
.udash-cardIcon{flex:none;color:var(--dsw-alias-label-tertiary)}
.udash-cardTitle{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500}
.udash-kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.udash-kpi{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;min-width:0}
.udash-kpiLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.udash-kpiValue{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;line-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.udash-contextRow{display:flex;align-items:center;gap:18px}
.udash-contextLeft{flex:none;display:flex;flex-direction:column;align-items:center;gap:4px}
.udash-ringWrap{position:relative;width:110px;height:110px}
.udash-ringTrack{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:14}
.udash-ringFill{fill:none;stroke:var(--dsw-static-blue-450);stroke-width:14;transition:stroke-dasharray .2s var(--ds-ease-in-out)}
.udash-ringSystem{stroke:var(--dsw-static-neutral-bluish-400)}
.udash-ringTools{stroke:#a78bfa}
.udash-ringMessages{stroke:var(--dsw-static-blue-450)}
.udash-ringLabel{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.udash-figures{text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.udash-contextRight{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.udash-bar{display:flex;gap:1px;height:6px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover)}
.udash-barLg{height:10px}
.udash-segment{height:100%;min-width:2px;border-radius:1px;background:var(--dsw-alias-label-tertiary)}
.udash-colorSystem{background:var(--dsw-static-neutral-bluish-400)}
.udash-colorTools{background:#a78bfa}
.udash-colorMessages{background:var(--dsw-static-blue-450)}
.udash-progress{height:6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.udash-progressFill{height:100%;border-radius:999px;background:var(--dsw-static-blue-450);transition:width .2s var(--ds-ease-in-out)}
.udash-rows{display:flex;flex-direction:column;gap:2px}
.udash-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:2px 0}
.udash-rowLabel{color:var(--dsw-alias-label-secondary);min-width:0}
.udash-rowValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.udash-rowStrong .udash-rowValue{font-weight:600}
.udash-pathRow .udash-rowValue{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}
.udash-swatch{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:baseline}
.udash-empty{color:var(--dsw-alias-label-tertiary);font-size:12px}
.udash-note{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.udash-modelLine{color:var(--dsw-alias-label-tertiary);font-size:12px}
/* ── Reasonix 侧边栏风格层（规格见 docs/sidebar-reasonix-spec.md）──
   基调：栏底暗一档内凹、accent 橙强调关键数字/进度/激活条、
   hover 淡染、弱文字三级灰阶、密度收紧 */
.udash-root{--uxs-accent:#d97757;--uxs-hover:#181c24;--uxs-fg-dim:#c0c4cc;--uxs-fg-faint:#858b96;--uxs-border-soft:#252a34;gap:10px;padding:10px;position:relative}
.udash-rootTab{--uxs-border-soft:#343945}
/* 激活会话：栏左侧 accent 竖条（对应 --sidebar-active 语义） */
.udash-root[data-active='true']::before{content:'';position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:999px;background:var(--uxs-accent)}
.udash-card{position:relative;gap:8px;padding:10px;border-radius:10px;border-color:var(--uxs-border-soft);transition:background .12s ease}
.udash-card:hover{background:var(--uxs-hover)}
.udash-cardHead{gap:8px}
.udash-title{font-size:14px;letter-spacing:.01em}
.udash-kpiValue[data-hot]{color:var(--uxs-accent);font-weight:600}
.udash-progressFill[data-hot]{background:var(--uxs-accent)}
.udash-meta{flex:none;color:var(--uxs-fg-faint);font-size:11px;line-height:16px}
.udash-groupTitle{color:var(--uxs-fg-faint);font-size:11px;letter-spacing:.05em;text-transform:uppercase;margin:2px 0 -2px}
.udash-goalObjective{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-width:0}
.udash-item{display:flex;align-items:center;gap:8px;min-width:0;padding:1px 0}
.udash-itemDot{flex:none;width:8px;height:8px;border-radius:50%}
.udash-itemLabel{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.udash-itemStatus{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.udash-dot-running{background:var(--dsw-static-blue-450)}
.udash-dot-complete{background:var(--dsw-static-neutral-bluish-400)}
.udash-dot-pending{background:var(--dsw-alias-border-l3)}
.udash-dot-muted{background:var(--dsw-alias-label-tertiary)}
.udash-chips{display:flex;flex-wrap:wrap;gap:6px}
.udash-chip2{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.udash-toggle{border:1px solid var(--dsw-alias-border-l2);height:32px;color:var(--dsw-alias-label-primary);cursor:pointer;background:none;border-radius:18px;display:inline-flex;align-items:center;gap:4px;padding:6px 12px;font-size:13px;line-height:20px}
.udash-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.udash-toggle span,.udash-toggle svg{flex:none}
.udash-toggle span{white-space:nowrap}
.udash-tabs{flex:none;display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:8px}
.udash-tab{flex:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:none;border:none;border-radius:8px;padding:4px 10px;font-size:12px;line-height:18px}
.udash-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.udash-tabActive{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);font-weight:500}
.udash-tree{display:flex;flex-direction:column;gap:0;font-size:12px;line-height:20px}
.udash-treeRow{display:flex;align-items:center;gap:6px;min-width:0;padding:1px 4px;border-radius:6px;cursor:default}
.udash-treeDir{cursor:pointer}
.udash-treeDir:hover{background:var(--dsw-alias-interactive-bg-hover)}
.udash-treeGutter{flex:none;width:12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:10px}
.udash-treeIcon{flex:none;color:var(--dsw-alias-label-tertiary)}
.udash-treeName{flex:1;min-width:0;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.udash-treeSize{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;margin-left:8px}
.udash-hiddenToggle{display:inline-block;width:14px;height:14px;line-height:12px;text-align:center;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.udash-hiddenToggle[data-on]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
`), 'ui-dashboard: styles')
  }
}
