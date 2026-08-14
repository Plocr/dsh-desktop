/**
 * dsh-desktop-bridge — DeepSeek Harness 桌面桥接插件（host 侧）。
 *
 * 职责：
 *  1. 在 127.0.0.1:0（OS 分配随机端口）上起一个带 token 鉴权的本地 WebSocket 服务；
 *  2. 订阅 harness 的 jobs / 会话事件，把最小化字段推送（broadcast）给桌面壳；
 *  3. 提供 shell -> harness 的 RPC 方法（工作区注册、运行时信息等）；
 *  4. 在 Loader 树安定后向 stdout 打印一行 `dsh desktop: {"port":..,"token":..}`，
 *     供桌面壳解析并连接（时序照抄 web-app 的 loader.await() 模式）。
 *
 * 该插件是"壳外置"的：挂载方式由桌面壳通过 `--patch` overlay 注入
 * （`- insert: {id: dsh-desktop-bridge, name: dsh-desktop-bridge, config: {token}}`），
 * 因此不会改动 profile 的用户补丁层。
 *
 * 设计约束：只读取最小字段、绝不序列化 harness 内部 live 对象；所有订阅
 * 均为可逆副作用（ctx.on / disposer），插件卸载即撤销。
 * ws 为内联 vendored 副本（vendor/ws，无运行时依赖），插件完全自包含。
 */
import { WebSocketServer } from '../vendor/ws/wrapper.mjs'

export const name = 'dsh-desktop-bridge'

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

export function apply(ctx, config = {}) {
  const token = typeof config.token === 'string' ? config.token : ''
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const clients = new Set()

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

  /* ── 快照数据源（dashboard.snapshot / 事件共用） ───────────────────── */

  // 审批请求环：最近 20 条 approval.asked（含时间戳），供仪表盘快照。
  const approvals = []
  function pushApproval(sessionId) {
    approvals.push({ sessionId, askedAt: Date.now() })
    if (approvals.length > 20) approvals.shift()
  }

  /** 跨会话聚合全部后台任务（owner 相对，须逐会话以 live Agent 为 caller）。 */
  function listAllJobs() {
    const sessions = safe(() => ctx.get('sessions')?.list() ?? [], [])
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    const out = []
    for (const session of sessions) {
      const agent = safe(() => agents?.get(session.id), undefined)
      const list = safe(() => jobs?.list(agent), [])
      out.push(...list)
    }
    return out
  }

  /** 会话目录：live 会话带标题；持久化会话只带 id/createdAt。 */
  async function listSessions() {
    const sessions = ctx.get('sessions')
    const out = []
    if (sessions) {
      for (const session of safe(() => sessions.list(), [])) {
        const title = safe(() => {
          const events = session.events
          const found = Array.isArray(events)
            ? [...events].reverse().find((e) => e && e.type === 'session/title')
            : undefined
          return found && typeof found.data?.title === 'string' ? found.data.title : null
        }, null)
        out.push({ id: safe(() => session.id, null), title, live: true, createdAt: safe(() => session.header?.createdAt, null) })
      }
    }
    const persistence = ctx.get('sessionPersistence')
    if (persistence && typeof persistence.list === 'function') {
      const liveIds = new Set(out.map((s) => s.id))
      try {
        const headers = await persistence.list()
        for (const h of safe(() => headers, [])) {
          if (!liveIds.has(safe(() => h.id, null))) {
            out.push({ id: safe(() => h.id, null), title: null, live: false, createdAt: safe(() => h.createdAt, null) })
          }
        }
      } catch (err) {
        console.log(`[bridge] sessions.list persisted failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return out
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

  /* ── RPC：shell -> harness ─────────────────────────────────────────── */

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
          reply({ sessions: await listSessions() })
          break
        }

        case 'dashboard.snapshot': {
          // 仪表盘全量快照：运行时 + 会话 + 跨会话任务聚合 + 最近审批。
          // 壳在 bridge 连接后调用一次，之后靠事件增量更新。
          reply({
            runtime: runtimeInfo(),
            sessions: await listSessions(),
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
          // 深链用：按会话 id 解析标题（live 优先，持久化 inspect 兜底）。
          const id = typeof msg.params?.id === 'string' ? msg.params.id : ''
          if (!id) return fail('missing params.id')
          const titleOf = (events) => {
            const found = Array.isArray(events)
              ? [...events].reverse().find((e) => e && e.type === 'session/title')
              : undefined
            return found && typeof found.data?.title === 'string' ? found.data.title : null
          }
          const sessions = ctx.get('sessions')
          const live = sessions ? safe(() => sessions.get(id), undefined) : undefined
          if (live) {
            reply({ id, live: true, title: titleOf(safe(() => live.events, null)), createdAt: safe(() => live.header?.createdAt, null) })
            break
          }
          const persistence = ctx.get('sessionPersistence')
          if (persistence && typeof persistence.inspect === 'function') {
            try {
              const view = await persistence.inspect(id)
              reply({ id, live: false, title: titleOf(view?.events), createdAt: safe(() => view?.meta?.createdAt, null) })
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

  wss.on('connection', (ws) => {
    let authed = false
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!authed) {
        if (msg && msg.type === 'auth' && typeof msg.token === 'string' && msg.token === token) {
          authed = true
          clients.add(ws)
          try {
            ws.send(encode('authed', { pid: process.pid }))
          } catch {
            /* ignore */
          }
        } else {
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
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })
  wss.on('error', () => {
    /* 端口冲突等；print 环节会因无端口而不宣告 ready */
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
    console.log(`[bridge] jobs service: ${jobs === undefined ? 'absent (after settle)' : 'present'}`)
    if (!jobs) return
    const pushChanged = () => {
      const list = listAllJobs().map(minimalJob)
      console.log(`[bridge] jobs.changed fired, ${list.length} jobs: ${JSON.stringify(list)}`)
      broadcast('jobs.changed', { jobs: list })
    }
    let onChanged
    try {
      onChanged = jobs.onJobsChanged(pushChanged)
      console.log('[bridge] onJobsChanged registered OK')
    } catch (err) {
      console.log(`[bridge] onJobsChanged registration failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    let onDone
    try {
      onDone = jobs.onJobDone((record) => {
        console.log(`[bridge] job.done fired: ${JSON.stringify(minimalJob(record))}`)
        broadcast('job.done', { job: minimalJob(record) })
      })
      console.log('[bridge] onJobDone registered OK')
    } catch (err) {
      console.log(`[bridge] onJobDone registration failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (typeof onChanged === 'function') ctx.on('dispose', onChanged)
    if (typeof onDone === 'function') ctx.on('dispose', onDone)
    ctx.on('dispose', () => {
      // 结算清空时让壳复位徽标
      broadcast('jobs.changed', { jobs: [] })
    })
  }

  // 会话事件：只挑需要通知的（审批请求）。最小字段，防御读取。
  ctx.on('session/event', (event) => {
    const type = safe(() => event?.type, null)
    if (type === 'approval/asked') {
      const sessionId = safe(() => event?.sessionId ?? event?.session?.id, null)
      pushApproval(sessionId)
      broadcast('approval.asked', { sessionId })
    }
  })

  /* ── 发现行：Loader 安定后打印，供壳解析 ───────────────────────────── */

  const print = () => {
    const port = safe(() => wss.address()?.port, 0)
    if (port) {
      // stdout 单行 JSON；壳按行解析。token 每次启动由壳生成并注入 config。
      console.log(`dsh desktop: ${JSON.stringify({ port, token })}`)
    }
  }
  const settled = safe(() => ctx.get('loader')?.await(), undefined)
  if (settled === undefined) {
    wireJobs()
    print()
  } else {
    settled.then(
      () => {
        if (safe(() => wss.address()?.port, 0)) {
          wireJobs()
          print()
        }
      },
      () => {},
    )
  }

  /* ── 卸载：关闭所有连接与服务器 ─────────────────────────────────────── */

  ctx.on('dispose', () => {
    for (const ws of clients) {
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
    }
    clients.clear()
    try {
      wss.close()
    } catch {
      /* ignore */
    }
  })
}
