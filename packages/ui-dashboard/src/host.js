/**
 * ui-dashboard · Host 半边（动态版）
 *
 * 提供 Package-private RPC：
 *  - `current-model`：读取当前默认模型选择（provider / model），供费用估算使用；
 *  - `balance`：查询当前 provider 的**余额/套餐用量**，按 provider 路由分发到对应官方 API；
 *  - `dir`：列出目录内容（fs 服务，含文件与目录），供右栏「文件树」页懒加载；
 *  - `tokenize`：用官方 DeepSeek tokenizer 离线批量计算文本 token 数（本机 Python）；
 *  - `offline-messages`：读取会话日志全部 user/assistant 消息文本，经官方 tokenizer
 *    离线统计输入/输出 token（不含缓存，与账单口径不同，仅供参考）。
 *
 * 用法：将本文件内容作为 cordis_define 的 code.host 传入（纯 JS 函数体）。
 */

/**
 * 官方 tokenizer 目录与脚本（可用插件配置 config.tokenizer.dir / config.tokenizer.script 覆盖）。
 * 注：动态版（本文件）跑在仓库开发环境，默认值为开发机路径；
 * 持久安装版（lib/index.js）的脚本默认值解析为包内 scripts/ 相对路径（install.mjs 会复制过去）。
 */
const TOKENIZER_DIR = config?.tokenizer?.dir ?? 'E:\\Dsh\\deepseek_v3_tokenizer\\deepseek_v3_tokenizer'
const TOKENIZER_SCRIPT = config?.tokenizer?.script ?? 'E:\\Dsh\\ui-dashboard-repo\\scripts\\deepseek_tokenize.py'

/** 内置 provider → 余额/用量来源。 */
const DEFAULT_BALANCE_SOURCES = {
  'deepseek-official': { kind: 'money', shape: 'deepseek', keyRef: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', path: '/user/balance' },
  'opencode-go': { kind: 'usage', shape: 'opencode', keyRef: 'OPENCODE_GO_API_KEY', baseUrl: 'https://opencode.ai/zen/go/v1', path: '/usage' },
  'openrouter': { kind: 'credits', shape: 'openrouter', keyRef: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', path: '/credits' },
  'moonshotai-cn': { kind: 'money', shape: 'moonshot', keyRef: 'MOONSHOT_API_KEY', baseUrl: 'https://api.moonshot.cn/v1', path: '/users/me/balance' }
}

/** 文本 → token 数的 LRU 缓存（避免重复调用 Python）。 */
const tokenCache = new Map()
const TOKEN_CACHE_CAP = 2000
function cacheSet(text, count) {
  tokenCache.set(text, count)
  if (tokenCache.size > TOKEN_CACHE_CAP) {
    const first = tokenCache.keys().next().value
    if (first !== void 0) tokenCache.delete(first)
  }
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

/** 用官方 tokenizer 批量计算文本 token 数（缓存命中直接返回）。 */
async function tokenizeTexts(ctx, texts) {
  const sub = ctx.get('subprocess')
  if (sub === undefined || typeof sub.spawn !== 'function') throw new Error('subprocess service unavailable')
  const missing = []
  const counts = new Array(texts.length)
  texts.forEach((text, i) => {
    if (text === '') { counts[i] = 0; return }
    const hit = tokenCache.get(text)
    if (hit !== undefined) { counts[i] = hit; return }
    missing.push(text)
  })
  if (missing.length === 0) return counts
  const handle = sub.spawn({
    argv: ['python', TOKENIZER_SCRIPT, TOKENIZER_DIR],
    cwd: TOKENIZER_DIR,
    stdio: {
      stdin: { data: JSON.stringify({ texts: missing }) },
      stdout: { maxBytes: 8 * 1024 * 1024 },
      stderr: { maxBytes: 64 * 1024 }
    },
    graceMs: 45_000
  })
  const outcome = await handle.done
  const out = handle.collected.stdout?.readFrom(0).text ?? ''
  if (outcome.exitCode !== 0) {
    const err = handle.collected.stderr?.readFrom(0).text ?? ''
    throw new Error(`tokenizer exited ${outcome.exitCode}: ${err.slice(0, 400)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch (e) {
    throw new Error(`tokenizer bad stdout: ${String(out).slice(0, 200)}`)
  }
  if (!Array.isArray(parsed) || parsed.length !== missing.length) throw new Error('tokenizer returned unexpected shape')
  missing.forEach((m, i) => cacheSet(m, parsed[i]))
  let j = 0
  texts.forEach((text, i) => {
    if (counts[i] === void 0) { counts[i] = parsed[j]; j++ }
  })
  return counts
}

/** 提取一个消息 content block 的文本（text 块、tool_result 内容）。 */
function contentText(block) {
  if (block === null || typeof block !== 'object') return ''
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'tool_result') {
    const c = block.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(contentText).join('\n')
    return ''
  }
  return ''
}

/**
 * 读取一个已存会话的全部事件（兼容两代宿主 API）：
 *  - 旧版（dsh ≤ 0.1.2）：`sessionPersistence.readFrom(id, 0)` → `{ events }`
 *  - 新版（dsh ≥ 0.1.3）：`open(id,'read')` → `handle.read(0)` → `handle.close()`
 */
async function readStoredEvents(persistence, sessionId) {
  if (typeof persistence.readFrom === 'function') {
    const r = await persistence.readFrom(sessionId, 0)
    return Array.isArray(r && r.events) ? r.events : []
  }
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const r = typeof handle.read === 'function' ? await handle.read(0) : null
      return Array.isArray(r && r.events) ? r.events : []
    } finally {
      try {
        if (typeof handle.close === 'function') await handle.close()
      } catch {
        /* 释放失败不影响结果 */
      }
    }
  }
  throw new Error('sessionPersistence: unsupported read API（需要 readFrom 或 open）')
}

/** 离线统计：读会话日志的 user/assistant 消息文本，用官方 tokenizer 计算 token。 */
async function offlineMessageStats(ctx, sessionId) {
  const sp = ctx.get('sessionPersistence')
  if (sp === undefined || typeof sp !== 'object') throw new Error('sessionPersistence service unavailable')
  const events = await readStoredEvents(sp, sessionId)
  const userTexts = []
  const assistantTexts = []
  if (Array.isArray(events)) {
    events.forEach((ev) => {
      if (ev === null || typeof ev !== 'object' || typeof ev.type !== 'string') return
      const data = ev.data
      if (ev.type === 'user/message' && data !== null && typeof data === 'object' && Array.isArray(data.content)) {
        const text = data.content.map(contentText).join('\n')
        if (text !== '') userTexts.push(text)
      } else if (ev.type === 'assistant/message' && data !== null && typeof data === 'object' && data.message !== null && typeof data.message === 'object' && Array.isArray(data.message.content)) {
        const text = data.message.content.map(contentText).join('\n')
        if (text !== '') assistantTexts.push(text)
      }
    })
  }
  // 防御：超长会话只取末尾一部分
  const cap = 400
  const truncated = userTexts.length + assistantTexts.length > cap
  const users = userTexts.slice(-cap)
  const assistants = assistantTexts.slice(-cap)
  const [userCounts, assistantCounts] = await Promise.all([
    tokenizeTexts(ctx, users),
    tokenizeTexts(ctx, assistants)
  ])
  const sum = (arr) => arr.reduce((x, y) => x + y, 0)
  const userTokens = sum(userCounts)
  const assistantTokens = sum(assistantCounts)
  return {
    status: 'ok',
    sessionId,
    messages: users.length + assistants.length,
    truncated,
    userTokens,
    assistantTokens,
    total: userTokens + assistantTokens
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

    ctx.effect(() => harness.handle('dir', async (args) => {
      const path = args !== null && typeof args === 'object' && typeof args.path === 'string' ? args.path : ''
      if (path === '') return { status: 'error', message: 'path required' }
      const fs = ctx.get('fs')
      if (fs === undefined || typeof fs.listDir !== 'function') return { status: 'error', message: 'fs service unavailable' }
      try {
        const target = await fs.resolve(path)
        const entries = await fs.listDir(target)
        return {
          status: 'ok',
          path,
          entries: entries.map((e) => ({
            name: e.name,
            type: e.type === 'directory' ? 'directory' : 'file',
            size: e.size,
            path: fs.processPath(e.target)
          }))
        }
      } catch (e) {
        return { status: 'error', message: e instanceof Error ? e.message : String(e) }
      }
    }), 'ui-dashboard: dir rpc')

    ctx.effect(() => harness.handle('tokenize', async (args) => {
      const texts = args !== null && typeof args === 'object' && Array.isArray(args.texts) ? args.texts : []
      // 上限防御：直接 RPC 无 offline 路径的 400 条截断，超大批量会撑爆 subprocess stdout 缓冲
      if (texts.length > 500) return { status: 'error', message: `too many texts (${texts.length} > 500)` }
      try {
        return { status: 'ok', counts: await tokenizeTexts(ctx, texts) }
      } catch (e) {
        return { status: 'error', message: e instanceof Error ? e.message : String(e) }
      }
    }), 'ui-dashboard: tokenize rpc')

    ctx.effect(() => harness.handle('offline-messages', async (args) => {
      const sessionId = args !== null && typeof args === 'object' && typeof args.sessionId === 'string' ? args.sessionId : ''
      if (sessionId === '') return { status: 'error', message: 'sessionId required' }
      try {
        return await offlineMessageStats(ctx, sessionId)
      } catch (e) {
        return { status: 'error', message: e instanceof Error ? e.message : String(e) }
      }
    }), 'ui-dashboard: offline-messages rpc')
  }
}