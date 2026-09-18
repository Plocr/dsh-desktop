/**
 * dsh-desktop-bridge — DeepSeek Harness 桌面桥接插件（host 侧）。
 *
 * 职责：
 *  1. 在 127.0.0.1:0（OS 分配随机端口）上起一个带 token 鉴权的本地 WebSocket 服务；
 *  2. 订阅 harness 的 jobs / 会话事件，把最小化字段推送（broadcast）给桌面壳；
 *  3. 提供 shell -> harness 的 RPC 方法（工作区注册、会话解析、仪表盘快照等）；
 *  4. 在 WS 服务**开始监听**且 Loader 树安定后，向 stdout 打印一行
 *     `dsh desktop: {"port":..,"token":..}`，供桌面壳解析并连接
 *     （安定时序照抄 web-app 的 loader.await() 模式）。
 *
 * 挂载方式：本包是标准 **bundle 包**（package.json 的 dsh.bundle.patch → bundle.patch.yml
 * 的 insert 行），由 profile 的 `dsh.profile.bundles` 决定加载。bundle 模型没有 config
 * 注入点，因此 token 由插件在启动时自行随机生成，只出现在 stdout 发现行里
 * （壳解析后用于 WS 握手）；token 不写 profile、不落盘、不进日志。
 *
 * 设计约束：只读取最小字段、绝不序列化 harness 内部 live 对象；所有订阅
 * 均为可逆副作用（ctx.on / disposer），插件卸载即撤销。
 * ws 为内联 vendored 副本（vendor/ws，无运行时依赖），插件完全自包含。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from '../vendor/ws/wrapper.mjs'

export const name = 'dsh-desktop-bridge'

/**
 * 壳↔插件握手协议版本：新增/改变推送字段或 RPC 语义时 +1。
 * 壳侧同名常量在 `src/main/bridgeEvents.ts`（跨进程契约，有测试锁两边的值一致）。
 * 版本不一致时壳会报错并在托盘标注——profile 层允许用户替换 bundle，
 * 那是不一致唯一可能的来源，必须可诊断而不是"通知时有时无"。
 */
export const BRIDGE_PROTOCOL_VERSION = 1

/** 防御性读取：任何字段缺失/抛错都不会让桥接崩溃。 */
function safe(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** 把一条推送编码为单行 JSON（最小负载，无 live 对象）。 */
function encode(type, payload) {
  return JSON.stringify({ type, payload })
}

/* ── 宿主 API 兼容层（纯函数/仅依赖传入的 persistence，可单测） ─────────── */
/**
 * 读取会话事件（兼容两代宿主 API）：
 *  - 新版（dsh ≥ 0.1.2-rc.1 起）：`Session.snapshotEvents()`（`Session.events` 已移除）
 *  - 旧版：`Session.events`
 * 读不到返回 null（调用方按「无事件」降级，绝不让宿主 API 差异把插件打挂）。
 */
export function sessionEventsOf(session) {
  return safe(() => {
    if (typeof session.snapshotEvents === 'function') {
      const ev = session.snapshotEvents()
      return Array.isArray(ev) ? ev : null
    }
    return Array.isArray(session.events) ? session.events : null
  }, null)
}

/** 会话标题：取最近一条 session/title 事件。 */
export function titleOfEvents(events) {
  if (!Array.isArray(events)) return null
  const found = [...events].reverse().find((e) => e && e.type === 'session/title')
  return found && typeof found.data?.title === 'string' ? found.data.title : null
}

/**
 * 归一化 harness 的 `session/event` 回调参数为审批事件（纯函数，可单测）。
 *
 * 宿主签名是 `(session, event)`：`Session.append()` 投递的 callbackArgs 就是
 * `[this, event]`（见 @deepseek-ai/dsh-session 的 append / 官方监听器
 * `ctx.on('session/event', (session, event) => …)`）。为兼容只投递单个事件对象的
 * 宿主，这里按「谁带字符串 type 谁就是事件」判序，绝不把 Session 误当事件。
 *
 * @returns `{ kind: 'asked'|'decided', sessionId, requestId, toolName }`；非审批事件返回 null。
 */
export function approvalEventOf(first, second) {
  const isEvent = (v) => typeof v?.type === 'string'
  // 正常形状是 (session, event)；若只有一个参数带 type，那它就是事件（异形宿主）
  const eventFirst = !isEvent(second) && isEvent(first)
  const session = eventFirst ? undefined : first
  const event = eventFirst ? first : second
  if (!isEvent(event)) return null
  if (event.type !== 'approval/asked' && event.type !== 'approval/decided') return null
  const data = safe(() => event.data, undefined)
  return {
    kind: event.type === 'approval/asked' ? 'asked' : 'decided',
    sessionId: safe(() => (typeof session?.id === 'string' ? session.id : null), null),
    requestId: safe(() => (typeof data?.id === 'string' ? data.id : null), null),
    toolName: safe(() => (typeof data?.toolName === 'string' ? data.toolName : null), null),
  }
}

/**
 * 按 id 去重（保留首个）。逐会话聚合任务时必须去重：`jobs.list(caller)` 的可见集是
 * 「无主任务 ∪ 该 caller 的任务」，无主任务会被投给**每一个** caller，
 * 直接拼接会得到 N 份副本（徽标计数跟着翻倍）。
 */
export function uniqueJobs(jobs) {
  const byId = new Map()
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const id = safe(() => (typeof job?.id === 'string' ? job.id : null), null)
    if (id === null || byId.has(id)) continue
    byId.set(id, job)
  }
  return [...byId.values()]
}

/** 常量时间比较 token（本地进程也可能尝试侧信道；长度不同直接判否）。 */
export function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || expected === '') return false
  const a = Buffer.from(candidate, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 已存会话头（兼容两代形状）：
 *  - 新版（dsh ≥ 0.1.3）：`[{ header: { id, createdAt, ... }, revision, sizeBytes }]`
 *  - 旧版：`[{ id, createdAt, ... }]`
 */
export function storedSessionHeads(headers) {
  const out = []
  if (!Array.isArray(headers)) return out
  for (const h of headers) {
    const id = safe(() => h.id ?? h.header?.id ?? null, null)
    if (typeof id !== 'string' || id === '') continue
    out.push({ id, createdAt: safe(() => h.createdAt ?? h.header?.createdAt ?? null, null) })
  }
  return out
}

/**
 * 读取一个已存会话的事件视图（兼容两代宿主 API）：
 *  - 新版（dsh ≥ 0.1.3）：`open(id,'read')` → `handle.read(0)` → `handle.close()`
 *  - 旧版：`inspect(id)` → `{ events, meta }`
 * 读不到返回 null。
 */
export async function inspectStoredSession(persistence, id) {
  if (typeof persistence.inspect === 'function') {
    const view = await persistence.inspect(id)
    return {
      events: safe(() => (Array.isArray(view?.events) ? view.events : null), null),
      createdAt: safe(() => view?.meta?.createdAt ?? null, null),
    }
  }
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(id, 'read')
    try {
      const res = typeof handle.read === 'function' ? await handle.read(0) : null
      return {
        events: safe(() => (Array.isArray(res?.events) ? res.events : null), null),
        createdAt: safe(() => handle.header?.createdAt ?? null, null),
      }
    } finally {
      try {
        if (typeof handle.close === 'function') await handle.close()
      } catch {
        /* 释放失败不影响结果 */
      }
    }
  }
  return null
}


/** 随机 token（32 位 hex）：bundle 模型下由插件自持，仅经 stdout 发现行交给壳。 */
function randomToken() {
  return randomBytes(16).toString('hex')
}

export function apply(ctx, config = {}) {
  // token 优先取 config（历史 overlay 注入路径）；缺省则自行生成随机 token。
  // 官方 bundle 模型下插件没有 config 注入点，token 只在本地 stdout 发现行里出现，
  // 壳解析后用于 WS 握手——本机其它进程无从获知。
  const token = typeof config.token === 'string' && config.token !== '' ? config.token : randomToken()
  // maxPayload：壳只发小帧（auth/call），1 MiB 足够；避免本机进程用超大帧把 harness 进程撑爆。
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1 << 20 })
  const clients = new Set()
  /** 未鉴权连接的存活上限：随机端口对任何本机进程可见，不能让它们白占连接。 */
  const authTimeoutMs = Number.isFinite(config.authTimeoutMs) ? Number(config.authTimeoutMs) : 10_000

  /** 广播到所有已鉴权连接；单个连接失败不影响其余。 */
  function broadcast(type, payload) {
    const line = encode(type, payload)
    for (const ws of clients) {
      try {
        ws.send(line)
      } catch {
        /* 单个发送失败忽略 */
      }
    }
  }

  /**
   * 诊断事件：既打 stdout（dev/e2e 日志），也推给已鉴权连接（壳在托盘显示桥接状态）。
   * 最新一条随 `authed` 一起给壳，因此连接后立刻能看到"jobs 服务在不在"这类事实。
   */
  let lastDiag = { level: 'info', code: 'bridge.starting', detail: {} }
  function diag(level, code, detail = {}) {
    lastDiag = { level, code, detail }
    console.log(`[bridge] ${level} ${code} ${JSON.stringify(detail)}`)
    broadcast('bridge.diag', lastDiag)
  }

  /* ── 快照数据源（dashboard.snapshot / 事件共用） ───────────────────── */

  // 审批请求环：最近 20 条**待处理**审批（approval/asked 入环，approval/decided 出环），
  // 供仪表盘快照与壳的"待审批"提醒。审批是"当下该处理的事"：超过 TTL 的条目
  // （用户已处理而事件丢失、或会话早关了）不该长期留在快照里。
  const APPROVAL_TTL_MS = 10 * 60_000
  const APPROVALS_MAX = 20
  const approvals = []
  function pushApproval(entry) {
    const existing = approvals.findIndex((a) => a.requestId !== null && a.requestId === entry.requestId)
    if (existing >= 0) approvals.splice(existing, 1)
    approvals.push({ ...entry, askedAt: Date.now() })
    if (approvals.length > APPROVALS_MAX) approvals.splice(0, approvals.length - APPROVALS_MAX)
    pruneApprovals()
  }
  /** 审批已决定（或已被处理）：出环；返回是否命中。 */
  function resolveApproval(entry) {
    for (let i = approvals.length - 1; i >= 0; i -= 1) {
      const a = approvals[i]
      const sameRequest = entry.requestId !== null && a.requestId === entry.requestId
      const sameSessionWithoutId = entry.requestId === null && entry.sessionId !== null && a.sessionId === entry.sessionId
      if (sameRequest || sameSessionWithoutId) {
        approvals.splice(i, 1)
        return true
      }
    }
    return false
  }
  /** 丢弃过期审批条目（原地）。 */
  function pruneApprovals() {
    const now = Date.now()
    for (let i = approvals.length - 1; i >= 0; i -= 1) {
      if (now - approvals[i].askedAt > APPROVAL_TTL_MS) approvals.splice(i, 1)
    }
  }

  /**
   * 跨会话聚合全部后台任务（owner 相对，须逐会话以 live Agent 为 caller）。
   * `jobs.list(caller)` 的可见集含**无主任务**（owner === undefined 的任务投给每个
   * caller），因此逐会话拼接必须按 id 去重；末尾再补一次无 caller 的 list，
   * 让「一个 live 会话都没有」时无主任务也不丢。
   * 任一服务缺失（jobs/sessions/agents）都按「没有任务」降级，绝不抛错打挂 RPC。
   */
  function listAllJobs() {
    const out = []
    const append = (list) => {
      if (!Array.isArray(list)) return
      for (const job of list) out.push(job)
    }
    const sessions = safe(() => ctx.get('sessions')?.list() ?? [], [])
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    for (const session of sessions) {
      const agent = safe(() => agents?.get(session?.id), undefined)
      append(safe(() => jobs?.list(agent), undefined))
    }
    append(safe(() => jobs?.list(), undefined))
    return uniqueJobs(out)
  }

  /**
   * 会话目录：live 会话带标题；持久化会话只带 id/createdAt。
   * **上限 200 条**（live 全留 + 最近的持久化）：目录会随每次变更整份推送，
   * 上万条历史会话的 JSON 帧既浪费带宽也白占壳的内存；壳只需要"最近的 + 活着的"，
   * 更老的会话由 `session.resolve` 按 id 兜底查。
   */
  const SESSIONS_MAX = 200

  /** 截断到上限：live 优先，其余按 createdAt 新→旧。 */
  function capSessions(list) {
    if (list.length <= SESSIONS_MAX) return { sessions: list, truncated: false }
    const live = list.filter((s) => s.live)
    const rest = list.filter((s) => !s.live).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return { sessions: [...live, ...rest].slice(0, Math.max(SESSIONS_MAX, live.length)), truncated: true }
  }

  async function listSessions() {
    const sessions = ctx.get('sessions')
    const out = []
    if (sessions) {
      for (const session of safe(() => sessions.list(), [])) {
        const title = safe(() => titleOfEvents(sessionEventsOf(session)), null)
        out.push({ id: safe(() => session.id, null), title, live: true, createdAt: safe(() => session.header?.createdAt, null) })
      }
    }
    const persistence = ctx.get('sessionPersistence')
    if (persistence && typeof persistence.list === 'function') {
      const liveIds = new Set(out.map((s) => s.id))
      try {
        const headers = await persistence.list()
        for (const h of storedSessionHeads(headers)) {
          if (!liveIds.has(h.id)) {
            out.push({ id: h.id, title: null, live: false, createdAt: h.createdAt })
          }
        }
      } catch (err) {
        diag('warn', 'sessions.list.persisted.failed', { message: err instanceof Error ? err.message : String(err) })
      }
    }
    return out
  }

  /** 目录 + 截断标记（推送给壳的 payload 用；壳据此知道"这不是全量历史"）。 */
  async function listSessionsCapped() {
    const { sessions, truncated } = capSessions(await listSessions())
    return { sessions, truncated }
  }

  /** 运行时信息（runtime.info 与 dashboard.snapshot 共用）。 */
  function runtimeInfo() {
    const registry = ctx.get('workspaceRegistry')
    const workspaces = registry
      ? safe(() =>
          registry
            .list()
            .map((w) => ({ id: safe(() => w.id, undefined), title: safe(() => w.title, undefined) })),
          [],
        )
      : []
    return {
      pid: process.pid,
      dshHome: process.env.DSH_HOME ?? null,
      cwd: process.cwd(),
      node: process.version,
      uptimeMs: Math.round(process.uptime() * 1000),
      workspaces,
    }
  }

  /* ── 会话目录增量推送（sessions.changed） ───────────────────────────── */

  // 会话新建/结束/改名 → 推送一份**合并后的**目录（与 sessions.list 同形状）。
  // 事件源：`session/created` / `session/disposed`（宿主投递 (session)）与
  // `session/event` 里的 session/title。去抖 + 单飞：一次加载 profile 会一口气建
  // 好几个会话，逐条推送既浪费又会让壳抖；拿不到客户端时直接丢弃（快照会补）。
  const SESSIONS_PUSH_DEBOUNCE_MS = 250
  let sessionsTimer = null
  let sessionsDirty = false
  let sessionsBusy = false

  function markSessionsChanged() {
    sessionsDirty = true
    if (sessionsTimer !== null) return
    sessionsTimer = setTimeout(() => {
      sessionsTimer = null
      void flushSessionsChanged()
    }, SESSIONS_PUSH_DEBOUNCE_MS)
    sessionsTimer.unref?.()
  }

  async function flushSessionsChanged() {
    if (sessionsBusy) return // 正在跑：跑完循环会再看 dirty
    sessionsBusy = true
    try {
      while (sessionsDirty) {
        sessionsDirty = false
        if (clients.size === 0) continue // 没有客户端：不白算（连接时的快照会带走全量）
        broadcast('sessions.changed', await listSessionsCapped())
      }
    } catch (err) {
      diag('warn', 'sessions.push.failed', { message: err instanceof Error ? err.message : String(err) })
    } finally {
      sessionsBusy = false
    }
  }

  /* ── RPC：shell -> harness ─────────────────────────────────────────── */

  /**
   * RPC 面（消费者见 docs/BRIDGE-ROADMAP.md 的契约表；新增方法必须在这里注明归属）：
   *  - `ping` / `workspace.register` / `session.resolve` / `dashboard.snapshot`：壳在用的正式面；
   *  - `runtime.info` / `sessions.list` / `billing.balance`：**诊断/兼容面**
   *    （live e2e 断言用；billing.balance 是壳 API key 自检的桥接实现，桥接不可用时壳回退本地文件读取）。
   */
  async function handleCall(ws, msg) {
    const id = msg.id
    const reply = (result) => {
      try {
        ws.send(JSON.stringify({ type: 'result', id, result }))
      } catch {
        /* ignore */
      }
    }
    const fail = (error) => {
      try {
        ws.send(JSON.stringify({ type: 'result', id, error: String(error) }))
      } catch {
        /* ignore */
      }
    }
    try {
      switch (msg.method) {
        case 'ping':
          reply({ pong: true, pid: process.pid })
          break

        case 'runtime.info':
          reply(runtimeInfo())
          break

        case 'workspace.register': {
          const path = typeof msg.params?.path === 'string' ? msg.params.path : ''
          if (!path) return fail('missing params.path')
          const registry = ctx.get('workspaceRegistry')
          if (!registry) return fail('workspaceRegistry service unavailable')
          const created = await registry.create(path)
          reply({ id: safe(() => created.id, null), ok: true })
          break
        }

        case 'sessions.list': {
          // 会话目录：live 会话带标题；持久化会话只带 id/createdAt（轻量 list，不逐个 inspect）。
          reply(await listSessionsCapped())
          break
        }

        case 'dashboard.snapshot': {
          // 仪表盘全量快照：运行时 + 会话 + 跨会话任务聚合 + 最近审批。
          // 壳在 bridge 连接/重连后调用一次，之后靠事件增量更新（重连时增量已丢失）。
          pruneApprovals()
          reply({
            runtime: runtimeInfo(),
            ...(await listSessionsCapped()),
            jobs: listAllJobs().map(minimalJob),
            approvals: [...approvals],
          })
          break
        }

        case 'billing.balance': {
          // DeepSeek 账户余额（https://api.deepseek.com/user/balance）。
          // 只在 harness 进程内使用 API key（credentials 服务解析），key 不离开 harness。
          const credentials = ctx.get('credentials')
          if (!credentials || typeof credentials.resolve !== 'function') {
            return fail('credentials service unavailable')
          }
          let key = ''
          try {
            // credentialRef 为品牌化字符串（正则校验后原样返回），直接传环境变量名
            const hit = await credentials.resolve('DEEPSEEK_API_KEY')
            if (hit && typeof hit.value === 'string' && hit.value.length > 0) key = hit.value
          } catch (err) {
            return fail(`credentials.resolve failed: ${err instanceof Error ? err.message : String(err)}`)
          }
          if (!key) return fail('DEEPSEEK_API_KEY 未配置（请在 harness 设置中填写 API key）')
          try {
            const res = await fetch('https://api.deepseek.com/user/balance', {
              method: 'GET',
              headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
              signal: AbortSignal.timeout(10_000),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
              const msg = data?.error?.message ?? `HTTP ${res.status}`
              return fail(`余额查询失败: ${msg}`)
            }
            reply({
              isAvailable: data?.is_available !== false,
              infos: Array.isArray(data?.balance_infos)
                ? data.balance_infos.map((i) => ({
                    currency: safe(() => i?.currency, undefined),
                    totalBalance: safe(() => i?.total_balance, undefined),
                    grantedBalance: safe(() => i?.granted_balance, undefined),
                    toppedUpBalance: safe(() => i?.topped_up_balance, undefined),
                  }))
                : [],
              fetchedAt: Date.now(),
            })
          } catch (err) {
            return fail(`余额查询异常: ${err instanceof Error ? err.message : String(err)}`)
          }
          break
        }

        case 'session.resolve': {
          // 深链用：按会话 id 解析标题（live 优先，持久化读取兜底）。
          const id = typeof msg.params?.id === 'string' ? msg.params.id : ''
          if (!id) return fail('missing params.id')
          const sessions = ctx.get('sessions')
          const live = sessions ? safe(() => sessions.get(id), undefined) : undefined
          if (live) {
            reply({
              id,
              live: true,
              title: titleOfEvents(sessionEventsOf(live)),
              createdAt: safe(() => live.header?.createdAt, null),
            })
            break
          }
          const persistence = ctx.get('sessionPersistence')
          if (persistence) {
            try {
              const view = await inspectStoredSession(persistence, id)
              reply({ id, live: false, title: titleOfEvents(view?.events), createdAt: view?.createdAt ?? null })
            } catch (err) {
              reply({ id, live: false, title: null, error: err instanceof Error ? err.message : String(err) })
            }
            break
          }
          reply({ id, live: false, title: null })
          break
        }

        default:
          fail(`unknown method: ${msg.method}`)
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  }

  /* ── 连接与鉴权 ─────────────────────────────────────────────────────── */

  /** 被拒握手计数（诊断用：本机有进程在探测这个端口）。 */
  let authRejected = 0

  wss.on('connection', (ws) => {
    let authed = false
    // 未鉴权连接不得长期占用：随机端口对本机任何进程可见，但 token 只出现在 stdout 里。
    const authTimer = setTimeout(() => {
      if (authed) return
      try {
        ws.close(4002, 'auth timeout')
      } catch {
        /* ignore */
      }
    }, authTimeoutMs)
    authTimer.unref?.()
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!authed) {
        if (msg && msg.type === 'auth' && tokenMatches(msg.token, token)) {
          authed = true
          clearTimeout(authTimer)
          clients.add(ws)
          // 壳带自己的协议版本；插件回自己的一版 + 最新诊断，壳据此判断是否同代
          const peerVersion = safe(() => (Number.isInteger(msg.protocolVersion) ? msg.protocolVersion : null), null)
          if (peerVersion !== BRIDGE_PROTOCOL_VERSION) {
            diag('warn', 'protocol.mismatch', { shell: peerVersion, bridge: BRIDGE_PROTOCOL_VERSION })
          }
          try {
            ws.send(
              encode('authed', { pid: process.pid, protocolVersion: BRIDGE_PROTOCOL_VERSION, diag: lastDiag }),
            )
          } catch {
            /* ignore */
          }
        } else {
          authRejected += 1
          diag('warn', 'auth.rejected', { count: authRejected, hint: '非本壳进程持有并尝试了该端口' })
          try {
            ws.close(4001, 'bad auth')
          } catch {
            /* ignore */
          }
        }
        return
      }
      if (msg && msg.type === 'call' && msg.id !== undefined) {
        handleCall(ws, msg).catch(() => {})
      }
    })
    ws.on('close', () => {
      clearTimeout(authTimer)
      clients.delete(ws)
    })
    ws.on('error', () => {
      clearTimeout(authTimer)
      clients.delete(ws)
    })
  })
  wss.on('error', (err) => {
    // 端口冲突/绑定失败等：不宣告发现行（壳保持断连），但要把原因留在 stdout 里
    diag('error', 'ws.server.error', { message: err instanceof Error ? err.message : String(err) })
  })

  /** 任务最小字段（绝不序列化 live 对象）。 */
  function minimalJob(s) {
    return {
      id: safe(() => s.id, undefined),
      kind: safe(() => s.kind, undefined),
      label: safe(() => s.label, undefined),
      status: safe(() => s.status, undefined),
      owner: safe(() => s.ownerSession ?? s.owner ?? s.sessionId, undefined),
    }
  }

  /* ── harness 事件 -> 推送 ───────────────────────────────────────────── */

  // 后台任务：可见集变化（注册/stopping/结算/移除）与单个任务完成。
  // 注意：必须在 Loader 安定后接线——apply 阶段 `jobs` 服务可能尚未就绪。
  const wireJobs = () => {
    const jobs = ctx.get('jobs')
    if (!jobs) {
      diag('warn', 'jobs.absent', { hint: 'jobs 服务在安定后仍不可见：后台任务徽标/通知不可用' })
      return
    }
    diag('info', 'jobs.present', {})
    const pushChanged = () => {
      const list = listAllJobs().map(minimalJob)
      broadcast('jobs.changed', { jobs: list })
    }
    let onChanged
    try {
      onChanged = jobs.onJobsChanged(pushChanged)
    } catch (err) {
      diag('warn', 'jobs.watch.failed', { api: 'onJobsChanged', message: err instanceof Error ? err.message : String(err) })
    }
    let onDone
    try {
      onDone = jobs.onJobDone((record) => {
        broadcast('job.done', { job: minimalJob(record) })
      })
    } catch (err) {
      diag('warn', 'jobs.watch.failed', { api: 'onJobDone', message: err instanceof Error ? err.message : String(err) })
    }
    if (typeof onChanged === 'function') ctx.on('dispose', onChanged)
    if (typeof onDone === 'function') ctx.on('dispose', onDone)
  }

  // 会话事件：审批请求/决定（通知 + 待审批环）与会话标题（目录推送）。
  // 签名必须是 (session, event)：宿主投递的是 `[Session, event]`（见 approvalEventOf）。
  ctx.on('session/event', (session, event) => {
    const approval = approvalEventOf(session, event)
    if (approval !== null) {
      if (approval.kind === 'asked') {
        pushApproval(approval)
        broadcast('approval.asked', approval)
      } else {
        // 已决定：出环并把本条广播给壳（壳据此清掉"待审批"提醒）
        resolveApproval(approval)
        broadcast('approval.decided', approval)
      }
      return
    }
    if (safe(() => event?.type, null) === 'session/title') markSessionsChanged()
  })

  // 会话生命周期：新建/结束都要让壳的会话目录跟上（深链标题缓存；0.8.2 起托盘不再列最近会话）
  ctx.on('session/created', () => markSessionsChanged())
  ctx.on('session/disposed', () => markSessionsChanged())

  /* ── 发现行：WS 开始监听 + Loader 安定后打印，供壳解析 ───────────────── */

  const print = () => {
    const port = safe(() => wss.address()?.port, 0)
    if (port) {
      // stdout 单行 JSON；壳按行解析（token 见 apply 顶部说明）。
      console.log(`dsh desktop: ${JSON.stringify({ port, token })}`)
    }
  }

  // `address()` 在 'listening' 之前返回 null，且 listen 是异步的：不能靠
  // 「构造完就读一次」判断端口（那样在 loader 缺失/秒安定时会静默丢掉发现行，
  // 壳永远连不上）。这里显式等 listening，失败则明确放弃宣告。
  const listening = new Promise((resolve) => {
    let settledOnce = false
    const done = (ok) => {
      if (settledOnce) return
      settledOnce = true
      resolve(ok)
    }
    if (safe(() => wss.address()?.port, 0)) return done(true)
    wss.once('listening', () => done(true))
    wss.once('error', () => done(false))
  })

  /**
   * 宣告发现行：等 WS 监听就绪即打印；`jobs` 接线等 Loader 安定（apply 阶段服务未必在）。
   * `disposed` 守卫避免"卸载后才安定"（dev 的 HMR 重载即此形状）往 stdout 打一行
   * 指向已关闭端口的发现行——壳会照它连一个死端口。
   */
  let announced = false
  let disposed = false
  const announce = async () => {
    if (announced || disposed) return
    if (!(await listening)) return
    announced = true
    wireJobs()
    print()
  }

  const settled = safe(() => ctx.get('loader')?.await(), undefined)
  if (settled && typeof settled.then === 'function') {
    // 安定失败（树加载出错）也要宣告：桥接通道本身与树无关，壳至少还能走 RPC/
    // 收到事件，比「桌面看起来死了」强；降级事实由下面这行日志交代。
    settled.then(
      () => void announce(),
      (err) => {
        diag('warn', 'loader.rejected', { message: err instanceof Error ? err.message : String(err) })
        void announce()
      },
    )
  } else {
    // 宿主没有 loader 服务：没有"安定"可等，立刻宣告（仍要等监听就绪）
    void announce()
  }

  /* ── 卸载：关闭所有连接与服务器 ─────────────────────────────────────── */

  ctx.on('dispose', () => {
    disposed = true
    // 先广播空任务集（壳据此复位徽标），再优雅关闭：terminate 会丢掉还没冲出去的帧。
    broadcast('jobs.changed', { jobs: [] })
    for (const ws of clients) {
      try {
        ws.close(1001, 'harness shutting down')
      } catch {
        /* ignore */
      }
    }
    // 对端不回应 close 帧时兜底强杀；timer 不持有事件循环（进程该退就退）。
    const hardStop = setTimeout(() => {
      for (const ws of clients) {
        try {
          ws.terminate()
        } catch {
          /* ignore */
        }
      }
      clients.clear()
    }, 200)
    hardStop.unref?.()
    try {
      wss.close()
    } catch {
      /* ignore */
    }
  })
}
