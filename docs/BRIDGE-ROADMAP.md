# dsh-desktop-bridge：审查结论与迭代计划

版本：1.3 ｜ 日期：2026-09-23（新增 `account.changed` 推送与 `authed.account` 快照字段）｜ 对应代码：`packages/bridge@0.5.0`、壳 `0.8.5`

本文覆盖三件事：**（1）桥接插件的现状契约**（谁在用、谁没人用）、**（2）本轮审查发现的缺陷与修复**（含证据与验证方式）、**（3）下一阶段的迭代计划**（每条含理由、验收标准与代价）。设计层面的既定边界见 `DESIGN.md`（D25/D30）。

---

## 1. 现状契约

bridge 是**壳 ↔ harness 的唯一通道**：插件跑在 Host 进程内的 dsh 组合树里，在 `127.0.0.1:0` 起一个 token 鉴权的 WebSocket，并把 `dsh desktop: {"port","token"}` 打到 stdout 供壳发现。

| 方向 | 名称 | 谁在用 | 备注 |
| --- | --- | --- | --- |
| 推送 | `jobs.changed` | 壳：任务栏徽标 | 壳据此重算运行中任务数（跨会话聚合按 id 去重）；0.8.2 起托盘不再显示任务数 |
| 推送 | `job.done` | 壳：系统通知 | 关闭通知时静默 |
| 推送 | `approval.asked` | 壳：系统通知（**点击直达会话**）+ 待审批环 | 带 `sessionId/requestId/toolName`；0.8.2 起托盘不再列「待审批」（通知仍直达会话） |
| 推送 | `approval.decided` | 壳：待审批环出环 | 环用于快照对齐与去重 |
| 推送 | `sessions.changed` | 壳：深链标题缓存（`dsh://session/<id>`） | 去抖 250ms + 单飞合并；与快照同形状（全量目录，**上限 200 条**：live 全留 + 最近持久化，带 `truncated`）；0.8.2 起托盘不再列「最近会话」 |
| 推送 | `account.changed` | 壳：账号登录的原生动作（`waiting-browser` → 系统浏览器打开授权页一次；`failed`/`expired` → 唤回窗口） | 只带 `{status, attempt:{id,phase,authorizeUrl,errorCode,expiresAt}}`；**凭据/token/资料一律不过桥**（0.5.0） |
| 推送 | `bridge.diag` | 壳：日志 + 托盘「桥接：…」状态行 | 插件诊断（D33） |
| RPC | `ping` | 壳：连接自检 | |
| RPC | `workspace.register` | 壳页面 `dsh:pick-workspace`（原生选目录后注册） | 不重启 Host 即可注册；托盘不再有这个入口 |
| RPC | `session.resolve` | 壳：`dsh://session/<id>` 深链（目录 miss 时） | live 优先，持久化兜底 |
| RPC | `dashboard.snapshot` | 壳：连接/重连后整份对齐（徽标 + 会话目录 + 待审批） | |
| RPC | `billing.balance` | 壳：API key 自检（D35） | 桥接不可用时壳回退本地文件 |
| RPC | `runtime.info` / `sessions.list` | **诊断面**（live e2e 断言 + 排障） | 无产品消费者，保留并在此标注归属 |

握手面还有一个字段：`authed` 回执除 `protocolVersion` / `diag` 外带 `account`（最新账号状态或 `null`），
用于重连补齐——断线期间可能已经进入「等待浏览器」或已经失败，只靠增量会漏掉那一跳（0.5.0）。

握手：`auth {token, protocolVersion}` → `authed {pid, protocolVersion, diag}`；两端版本不一致时壳报警并在托盘标注（D32）。

「无人消费」不等于该删——它们是诊断/未来扩展面；但**必须有明确归属**，否则每次改协议都要在一堆没有调用方的分支上做假设（见 P2-1）。

---

## 2. 本轮修复

### 2.1 缺陷（已修，均有回归测试）

**B1｜审批通知完全失效（P0，功能性）**
`ctx.on('session/event', (event) => …)` 把**第一个参数当成事件**，但宿主投递的是 `(session, event)`：`Session.append()` 的 `callbackArgs = [this, event]`（`dsh-session/lib/index.js:1193-1202`），官方监听器一律写 `(session, event)`（`dsh-agent-presets/lib/index.js:1325`）。Session 上没有 `type` 字段，因此 `approval/asked` 永远匹配不上——审批通知、审批环快照全部是死代码。
**修法**：`approvalEventOf(first, second)` 归一化两种投递形状（谁带字符串 `type` 谁就是事件），从 `session.id` 取会话，并从事件 data 里带上 `requestId`/`toolName`（`SessionEventMap['approval/asked'] = { id, toolName, callId?, reason? }`）。通知文案随之升级为「会话 s-1（bash） 请求审批一个操作」。

**B2｜发现行可能永不打印（P0，静默失效）**
`wss.address()` 在 `'listening'` 之前返回 `null`，而 `listen()` 是异步的（`vendor/ws/lib/websocket-server.js:112`）。旧代码在「宿主没有 loader 服务」时于 `apply()` 里同步 `print()`——那一刻必然拿不到端口；在 loader 秒安定或宿主 API 变化时同样会静默跳过，壳于是永远连不上，且**没有任何日志**。
**修法**：显式 `await` 监听就绪（`listening` Promise，绑定失败则明确放弃并打日志），再按 loader 安定与否宣告；`announce()` 幂等，保证恰好一行发现行。loader 安定失败也照样宣告（桥接通道与加载树无关，降级可用优先），并留下可诊断日志。

**B3｜无主任务被重复计数（P1，数据错误）**
`jobs.list(caller)` 的可见集是「无主任务 ∪ 该 caller 的任务」（`dsh-jobs-local/lib/index.js:179-181`），无主任务会被投给**每一个** caller。逐会话拼接后，一个无主任务出现 N 次 → 徽标计数翻倍、任务列表出现重复项。
**修法**：`uniqueJobs()` 按 id 去重（保留首个），并补一次无 caller 的 `list()`，让「没有 live 会话」时无主任务也不丢。

**B4｜服务缺失时快照 RPC 抛错（P2，健壮性）**
`safe(() => jobs?.list(agent), [])` 在 `jobs` 缺失时返回的是 `undefined`（可选链不抛错，`safe` 的兜底值不会生效），随后 `out.push(...undefined)` 抛错 → `dashboard.snapshot`/`jobs.changed` 直接失败。原代码即有该问题，被新测试当场抓出。
**修法**：聚合只接受数组，缺服务按「没有任务」降级。

### 2.2 安全硬化（已修）

| # | 问题 | 修法 |
| --- | --- | --- |
| H1 | 壳接受**空 token** 目标：历史 overlay 模型没有 config 注入点时插件会宣告空 token，token 比对退化成「等于空串」，本机任何进程都能连上 | 壳侧 `parseBridgeDiscovery` 要求 token 长度 ≥ 16（`bridgeEvents.ts`），fail-closed；插件侧自生成 128-bit 随机 token |
| H2 | token 用 `===` 比较（可被本机进程做时序侧信道） | `tokenMatches()` 用 `timingSafeEqual`（长度不等先判否），长度公开不构成额外泄漏 |
| H3 | 未鉴权连接无上限：随机端口对本机任何进程可见，可白占连接/内存 | `authTimeoutMs`（默认 10s，超时关 4002）+ `maxPayload` 1 MiB |
| H4 | 发现行（含 token）被壳逐行落盘到 `userData/logs` | `redactBridgeLine()`：日志只留端口，token 一律 `<redacted>`（`parseBridgeLine` 仍读原始行） |
| H5 | 卸载时 `terminate()` 丢掉「空任务集」帧；壳侧重连后徽标停留在旧 harness 进程的计数 | 插件：先广播再 `close(1001, …)`，200ms 兜底强杀（unref 定时器不吊住进程）；壳：断开即清零徽标，重连后拉一次 `dashboard.snapshot` 对齐 |

### 2.3 顺带修掉的「哑桥接」缺口与文档债

- **`readDesktopRuntime` 增加 bridge 硬前提**（`src/main/runtimeTree.ts`）：原先只要求 `@deepseek-ai/dsh` 版本一致与 `dsh-desktop-host` 存在。若构建时漏装 bridge，descriptor 与文件树会「一致地缺少」它，完整性校验照样通过 —— 桌面能力整体失灵却没人报错。
- **过时注释**（overlay 模型 → bundle 模型）：`resources/profile-template/dsh-workbench/cordis.patch.yml`、`src/main/safeMode.ts`、插件头部说明。

### 2.4 验证方式

| 层 | 命令 | 覆盖 |
| --- | --- | --- |
| 插件契约（hermetic） | `node --test test/bridge-plugin.test.mjs` | 起真插件 + 真 vendored ws 客户端：发现行（含"只打一行"/无 loader/安定失败三条路径）、鉴权（错 token 4001 / 超时 4002）、全部 RPC、审批推送形状、任务去重、dispose 语义、服务全缺降级 |
| 壳侧纯逻辑 | `node --test test/bridge-events.test.mjs` | 发现行前缀契约、非法/空 token 拒绝、日志脱敏、快照→徽标、通知文案 |
| 运行时前提 | `node --test test/runtime-descriptor.test.mjs` | 三件共享包硬前提（dsh 版本 / host / bridge） |
| 端到端（真实 harness） | `npm run e2e:bridge` | 真 Host + 当前 pin 的 dsh（0.1.7-alpha.1）：发现行出现、鉴权、**协议版本一致 + diag（jobs.present）**、`workspace.register` 真建工作区、错/空 token 均被 4001 拒绝、未知方法报错、管道 fetch 与 LAN 门禁；CI 已接入（`e2e` job） |

全量：`npm run check`（typecheck + 90 项测试）。本轮修复均在真实 dsh 上跑过 `e2e:bridge`（含 `resources/dsh` 手工同步 0.4.0；**正式发行前需重跑 `npm run setup:runtime` 让 tgz 与 descriptor 一起重建**）。

---

### 2.5 停机句柄（P0，性能/退出，0.4.1）

**现象**：用户点「退出」要等 5–8 秒（有时以为没反应会再点一次）；`restart()` 会在 7s 超时后强制重建，
旧进程还可能继续占着资源，让下一次启动更顿挫（用户日志里就有 `host restart: exit 事件超时，强制重建`）。

**根因**：官方 `createProcessShutdown`（`@deepseek-ai/dsh` 的 profile-boot）在 dispose 完成后走的是
`process.exitCode = code` + **等事件循环自然 drain**，并不强制 `process.exit()`（强制退出只留给 5s 超时兜底）。
桥接用 `new WebSocketServer({ host, port: 0 })` 起的监听 socket 是 **ref 句柄** → drain 永不完成。
实测：Host 收到 shutdown 后 **60 秒仍在、端口仍在监听**（插件 dispose 都没走到）；不加载桥接的对照只用了 2.1s。

**修法**：桥接自持 HTTP server（`noServer` 模式），listen 后 `unref()`；每个已接受连接也 `unref()`；
dispose 里仍显式 `close()`/`unref()`。语义是"桥接照常服务，但不定义 Host 的生存期"。

**验证**：停机探针（真实 Host + 桥接）三种客户端状态——无客户端 2095ms / 客户端连着 2097ms /
先断客户端 1836ms，全部 exit code 0（修复前：永不退出）；壳实机点退出 **105ms** 完成。详见对齐审查 §9。

## 3. 迭代计划

> **状态（0.7.20）**：第 0～3 批**已全部落地**——P0-1（e2e 进 CI）、P0-2（协议版本握手）、P1-1（`sessions.changed` / `approval.decided` + 托盘最近会话与待审批）、P1-2（审批通知点击直达）、P1-3（API key 自检走桥接）、P2-1（RPC 归属收敛）、P2-2（`bridge.diag` + 托盘桥接状态）均已实现并有测试/CI 覆盖；下面保留原始条目与理由，作为"为什么这么做"的记录。P3 两项仍是待办（需要需求验证/单独设计）。


优先级按「用户可感知 + 修复成本 + 是否阻塞其他工作」排序。每条给出**理由**（为什么值得做）与**验收**（怎么算做完）。

### P0-1 让 live e2e 进 CI ✅ 已完成（理由：目前唯一的跨进程真实验证完全靠人手跑）
`scripts/e2e-bridge.mjs` 已能覆盖壳/插件/Host/管道/LAN 五层契约，但**没有任何 CI 触发它**（只在升级 dsh 版本时人工跑）。B2 这类「插件在真实树里静默失灵」的缺陷，只有它能挡住。
- 做法：release workflow 增加一个 `e2e` job（Windows，跑 `setup:runtime` → `npm run e2e:bridge`），或至少让 `dev`/夜间档跑。收尾的 Windows 目录占用竞态已在脚本里做了重试（`cleanup()`），否则进了 CI 会偶发假红。
- 验收：PR 上能看到 e2e 结果；故意让插件 `apply()` 抛错时该 job 变红。
- 代价：CI 时长 +~3 分钟（含 runtime 缓存则更短）。

### P0-2 协议版本握手 ✅ 已完成（理由：壳与插件目前"隐式同版本"，但 profile 层允许用户替换 bundle）
壳与 dsh 被绑成一个签名更新单元，bridge 也随之同版本发布；但 `dsh.profile.bundles` 允许用户自装同名/自建插件，桌面壳也可能被指向旧运行时树。此时双方对 RPC/推送形状的理解可能不同，表现为「通知时有时无」这类难查的现象。
- 做法：`auth` 帧带 `protocolVersion`（整数，当前 1），插件在 `authed` 里回自己的版本；壳不匹配时记一条 error 日志并在托盘提示"桥接协议不匹配，请重装/更新应用"。
- 验收：插件返回未知版本时壳有明确日志与提示（新增一条 hermetic 测试）。
- 代价：两端各 ~10 行；纯增量，不破坏现有握手。

### P1-1 会话/审批的增量推送 ✅ 已完成（理由：桌面外壳的"常驻感"目前只覆盖后台任务）
现在壳只在连接时拿一次快照。会话新建/结束/改名、审批被处理后，壳侧（托盘最近会话、深链标题缓存、审批环）都不会更新，用户看到的是「要重启才刷新」。
- 做法：插件新增 `sessions.changed`（会话创建/结束/标题变更，最小字段 id/title/live）与 `approval.decided`（从事件流移除审批环条目），壳据此刷新托盘与本地缓存。
- 验收：新建会话/改标题后不重启即反映到壳侧状态；`approval.decided` 后快照 `approvals` 不再包含该条（hermetic 测试）。
- 代价：插件侧 ~40 行 + 壳侧托盘刷新逻辑；事件频率需节流（标题变更只在值变化时发）。

### P1-2 审批通知可点击跳转 ✅ 已完成（理由：通知的下一步动作是"去处理它"）
当前 `approval.asked` 通知点击只聚焦窗口，用户还要自己找会话。壳已有 `session.resolve` + 深链点击能力，缺的是把 sessionId 从通知带到跳转。
- 做法：通知回调带上 `sessionId`，复用 `handleDeepLink({kind:'session'})`（含标题解析与侧栏点击）。
- 验收：点通知后落到对应会话行（若无 live 会话则只聚焦窗口，不报错）。
- 代价：小（壳侧接线 + 一条纯函数测试）。

### P1-3 壳的 API key 自检改走 `billing.balance` ✅ 已完成（理由：删除一条会产生误报的重复路径）
`src/main/apiKeyCheck.ts` 自己解析 `.credentials.yaml`；而 harness 的 credentials 服务还会读**环境变量**与 dotenv 回退（`dsh-credentials-local` 的 `inherited`/`dotenvFallback`）。用户按官方文档 `DEEPSEEK_API_KEY=… dsh` 启动时，壳会误报「未找到 DEEPSEEK_API_KEY」，并推送一条错误通知。
- 做法：壳优先用 `billing.balance`（成功即 key 有效，余额顺带回填托盘），仅在桥接不可用时回退文件解析。
- 验收：仅设置环境变量（无 credentials 文件）时托盘显示 key 有效；`billing.balance` 失败时回退行为不变。
- 代价：中小；注意余额接口失败（网络/额度接口变更）不能等同「key 无效」，需要区分 HTTP 401 与其他错误。

### P2-1 RPC 面收敛与归属 ✅ 已完成（理由：无人消费的分支正在积累）
`runtime.info`/`sessions.list`/`billing.balance` 目前只有 e2e 在用。要么给它们明确身份（"诊断面"，写进本文档表格），要么删除。`dashboard.snapshot` 已被壳重新使用（本轮），保留。
- 做法：在本文档的契约表标注「消费者」列（已完成），并在插件里为诊断面加注释；`billing.balance` 若 P1-3 落地则成为壳的正式依赖。
- 验收：不存在"没有消费者也没有标注"的 RPC。
- 代价：小（文档 + 注释）。

### P2-2 结构化诊断通道 ✅ 已完成（理由：桥接故障目前只能靠翻 stdout 混流日志）
插件把 `[bridge] jobs service: absent`、鉴权失败、快照降级等写进 Host stdout，与 harness 输出混在同一份落盘日志里。用户报「不弹通知」时，第一句要问的就是「桥接连上了吗、jobs 服务在不在」。
- 做法：新增 `bridge.diag` 推送（`{level, code, detail}`：`ws.listening`/`jobs.absent`/`auth.rejected`/`snapshot.degraded`…），壳落一条独立日志并在托盘诊断区展示最后一条；stdout 只留发现行。
- 验收：托盘能一眼看到「桥接：已连接（jobs: present）」；日志文件里不再有 `[bridge]` 前缀的散行。
- 代价：中；需要给壳加一个诊断展示位（可先只落日志，不做 UI）。

### P3-1（可选）更多注意力事件（理由：桌面外壳的价值在"离开窗口时被告知"）
长回合结束、goal 完成、子代理失败等都可推送（`turn/end`、`goal/change`、`subagent/*`）。先做需求验证再落地，避免通知泛滥——默认只推 `job.done`/`approval.asked` 这两类"需要人"的事件是当前合理基线。
- 验收：新增事件均有开关与节流，且不改变现有默认行为。
- 代价：小到中（每类事件一条映射 + 通知文案）。

### P3-2（边界）远程/局域网可见性
`lanServer` 已经能把 Web UI 提供给局域网，但 bridge 只监听 127.0.0.1。若未来要做「手机看进度」，正确形状是**壳把事件转发给 LAN 门面**（沿用 `dsh-desk-access` cookie 认证），而不是让插件监听 `0.0.0.0` —— 后者会把 token 发现面暴露到网络上，且需要独立认证/配额设计。

---

## 4. 明确不做（保持边界的反模式）

1. **不把 UI 能力搬回桥接**（D25）：终端/仪表盘/主题这类扩展属于 harness 插件（`dsh.client` 双面包），桥接只做"桌面原生能力"。
2. **不让插件监听非回环地址**；跨机访问走壳的 LAN 门面。
3. **不在插件里做缓存/重试层**：可见集变化的语义就是「重新读一遍可见集」（官方明确不做增量），插件侧加缓存只会引入不一致。
4. **不引入运行时依赖**：`vendor/ws` 内联副本的约束继续成立（离线随包的首要条件）。
5. **不让 discovery 行携带敏感信息**：token 只走 stdout 一次，不写 profile、不进日志。

---

## 5. 参考：本轮涉及的宿主契约（实测确认）

| 事实 | 出处 |
| --- | --- |
| `session/event` 监听签名 `(session, event)` | `@deepseek-ai/dsh-session` append → `callbackArgs = [this, event]`；官方监听器写法见 `dsh-agent-presets` |
| `approval/asked` data = `{ id, toolName, callId?, reason? }` | `SessionEventMap`（typert 声明） |
| `jobs.list(caller)` 含无主任务；`caller` 类型按宿主代次变化：**旧代**（≤0.1.6）live Agent（`agents.get(sessionId)`，agent/session 共享 id）→ `caller?.id`；**新代**（≥0.1.7）直接是 `SessionId` 字符串（`job.owner.id === caller`） | `dsh-jobs-local` 两代 `list()`/`assertAccess()` 实现；判代见 D42（`jobsApiGeneration`） |
| **旧代**（≤0.1.6）：`onJobDone(snapshot, owner)` / `onJobsChanged(owner)`；snapshot 形状 `{id,kind,label,ownerSession?,status,detail?,startedAt,finishedAt?,reported}` | `dsh-jobs-local` 0.1.6-alpha.2 |
| **新代**（≥0.1.7）：两个监听器 API 被删除，改为 `jobs.events.subscribe(filter, listener)`（filter `{owner}` / `{owners:'all'\|'scope'}`；事件 `registered\|progress\|stopping\|removed\|settled\|output`）；视图改称 `JobView`（`owner` 取代 `ownerSession`，新增 `progress`/`output:{total,earliest,spillPaths?}`）；`JobStart`→`JobSpec`；新增 `readAt(id, from, caller?)` 与 `remove(id, caller?)` | `@deepseek-ai/dsh-jobs` 0.1.7-alpha.1 类型声明（`lib/types/types.d.ts`、`view.d.ts`）；`dsh-jobs-local` 的 `get events()` + `subscribe()` |
| `sessionPersistence.list()` → `[{header:{id,createdAt},revision,sizeBytes}]`；`open(id,'read')` → `handle.read(0)` → `{eventState,events}` + `handle.close()` | `dsh-session-persistence-jsonl` |
| `credentials.resolve(ref)` → `{value, source} | undefined`；默认 ref `DEEPSEEK_API_KEY` | `dsh-credentials-local`；`dsh-llm-deepseek` |
| `ctx.get('loader')?.await()` 是安定时序的官方用法 | `dsh-app-boot` |
| 会话 id 经 `encodeSegment` 转义（`..`/分隔符不可穿越） | `dsh-session-persistence-jsonl` → 深链传任意 id 也读不出树外文件 |
