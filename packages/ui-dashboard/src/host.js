/**
 * ui-dashboard · Host 半边
 *
 * 提供 Package-private RPC：
 *  - `current-model`：读取当前默认模型选择（provider / model），供费用估算使用；
 *  - `balance`：查询当前 provider 的**余额/套餐用量**，按 provider 路由分发到对应
 *    官方 API（key 只在 harness 进程内解析，不离开进程）。
 *
 * 形态（kind）：
 *  - money   → 账户余额金额（DeepSeek / Moonshot 等），归一化为 infos[]
 *  - usage   → 用量百分比窗口（OpenCode Go：rolling/weekly/monthly）
 *  - credits → 预付费 credits 余额（OpenRouter 等）：总量 / 已用 / 剩余
 *
 * 支持来源经 `config.balance.providers[route] = { kind, shape, keyRef, baseUrl, path }` 扩展；
 * shape 缺省按 kind 推断（money→deepseek、usage→opencode、credits→openrouter）。
 * 未在映射中的路由返回 `unsupported`，由界面明确提示。
 *
 * 用法：将本文件内容作为 cordis_define 的 code.host 传入（纯 JS 函数体）。
 */

/** 内置 provider → 余额/用量来源。 */
const DEFAULT_BALANCE_SOURCES = {
  'deepseek-official': { kind: 'money', shape: 'deepseek', keyRef: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', path: '/user/balance' },
  'opencode-go': { kind: 'usage', shape: 'opencode', keyRef: 'OPENCODE_GO_API_KEY', baseUrl: 'https://opencode.ai/zen/go/v1', path: '/usage' },
  'openrouter': { kind: 'credits', shape: 'openrouter', keyRef: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', path: '/credits' },
  'moonshotai-cn': { kind: 'money', shape: 'moonshot', keyRef: 'MOONSHOT_API_KEY', baseUrl: 'https://api.moonshot.cn/v1', path: '/users/me/balance' }
}

/** 数值化容错：字符串/数字 → number，非法 → undefined。 */
function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v)
  return undefined
}

/** 解析 money 形态（DeepSeek 形状：balance_infos[]；Moonshot 形状：顶层 balance 字段）。 */
function parseMoney(data, shape) {
  if (shape === 'moonshot') {
    const total = num(data?.available_balance)
    if (total === undefined) return { infos: [] }
    return {
      infos: [{
        currency: 'CNY',
        totalBalance: total,
        grantedBalance: num(data?.granted_balance),
        toppedUpBalance: num(data?.cash_balance)
      }]
    }
  }
  // deepseek 形状（默认）
  return {
    isAvailable: data?.is_available !== false,
    infos: Array.isArray(data?.balance_infos)
      ? data.balance_infos.map((i) => ({
          currency: i?.currency,
          totalBalance: num(i?.total_balance),
          grantedBalance: num(i?.granted_balance),
          toppedUpBalance: num(i?.topped_up_balance)
        }))
      : []
  }
}

/** 解析 usage 形态（OpenCode Go：usage.{rolling,weekly,monthly}.{status,percent,resetsAt}）。 */
function parseUsage(data) {
  const usage = data?.usage ?? data
  const pick = (name) => {
    const w = usage?.[name]
    if (w === null || w === undefined) return undefined
    return {
      status: w?.status ?? 'ok',
      percent: typeof w?.percent === 'number' ? w.percent : num(w?.percent),
      resetsAt: typeof w?.resetsAt === 'string' ? w.resetsAt : undefined
    }
  }
  return {
    windows: {
      rolling: pick('rolling'),
      weekly: pick('weekly'),
      monthly: pick('monthly')
    }
  }
}

/** 解析 credits 形态（OpenRouter：data.total_credits / total_usage）。 */
function parseCredits(data) {
  const d = data?.data ?? data
  const total = num(d?.total_credits ?? d?.credits ?? d?.balance)
  const used = num(d?.total_usage ?? d?.usage)
  return { total, used }
}

/** 查询当前 provider 的余额/用量；无对应来源时返回 unsupported。 */
async function queryBalance(ctx, config) {
  let provider = null
  const svc = ctx.get('agentDefaultModel')
  if (svc !== undefined) {
    try {
      provider = svc.currentSelection()?.provider ?? null
    } catch {
      /* ignore */
    }
  }
  const sources = { ...DEFAULT_BALANCE_SOURCES, ...(config?.balance?.providers ?? {}) }
  const source = provider === null ? undefined : sources[provider]
  if (source === undefined) return { status: 'unsupported', provider }

  const kind = source.kind ?? 'money'
  const shape = source.shape ?? (kind === 'usage' ? 'opencode' : kind === 'credits' ? 'openrouter' : 'deepseek')
  const keyRef = source.keyRef ?? 'DEEPSEEK_API_KEY'
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.resolve !== 'function') {
    return { status: 'error', message: 'credentials service unavailable' }
  }
  let key = ''
  try {
    const hit = await credentials.resolve(keyRef)
    if (hit && typeof hit.value === 'string' && hit.value.length > 0) key = hit.value
  } catch (e) {
    return { status: 'error', message: `credentials.resolve failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!key) return { status: 'no-key', keyRef }

  const baseUrl = (source.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const path = source.path ?? (kind === 'usage' ? '/usage' : kind === 'credits' ? '/credits' : '/user/balance')
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { status: 'error', message: data?.error?.message ?? data?.message ?? `HTTP ${res.status}` }

    const body = { status: 'ok', kind, provider, fetchedAt: Date.now() }
    if (kind === 'usage') return { ...body, ...parseUsage(data) }
    if (kind === 'credits') return { ...body, ...parseCredits(data) }
    return { ...body, ...parseMoney(data, shape) }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

return {
  apply(ctx, config) {
    ctx.effect(() => harness.handle('current-model', async () => {
      const svc = ctx.get('agentDefaultModel')
      if (svc === undefined) return { provider: null, model: null }
      try {
        const sel = svc.currentSelection()
        return { provider: sel?.provider ?? null, model: sel?.model ?? null }
      } catch (e) {
        return { provider: null, model: null }
      }
    }), 'ui-dashboard: current-model rpc')

    ctx.effect(() => harness.handle('balance', async () => queryBalance(ctx, config)), 'ui-dashboard: balance rpc')
  }
}
