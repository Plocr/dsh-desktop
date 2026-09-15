# DSH Desktop — DeepSeek Harness 桌面工作台 设计文档

版本：0.7.20 ｜ 状态：已实现（官方 Host 架构：壳只保留桌面原生能力，仅 bridge 插件） ｜ 平台：Windows 优先（macOS 配置就绪）

## 1. 背景与目标

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）是 DeepSeek AI 的开源 agent harness，采用 **一切皆插件** 架构（Cordis 驱动）。官方提供 `dsh web`（浏览器 GUI，默认 `http://127.0.0.1:3080`）与 `dsh --profile headless` 两种表面。

本项目的目标：在 harness 之上构建一个 **桌面工作台**（Windows 优先）：

- 原生桌面壳（窗口、托盘、系统通知、任务栏徽标、开机自启、原生目录对话框）；
- 内嵌 harness 运行时，**离线、免安装 Node、免全局 dsh** 即可运行；
- 完整复用官方 Web UI（会话、工作区、插件、设置），**零改动**；
- 后台常驻、崩溃自愈、会话与设置跨重启持久；
- **壳只保留桌面原生能力**；与 harness 之间仅通过 bridge 插件通信（通知/徽标/深链/工作区注册）。

## 2. 总体架构

```
┌────────────────────────── dsh-desktop（Electron 应用） ──────────────────────────┐
│  Main 进程（TypeScript → CJS）                                                   │
│   ├─ HostManager：spawn/监控/重启 Host（packages/host，官方 apps/desktop-host 移植）│
│   ├─ fd3/fd4 字节管道（协议 v3，13 字节帧头）+ fd5 Node IPC（ready/fatal）          │
│   ├─ 逐行读 Host stdout：`dsh desktop:` 桥接发现行（token 脱敏后落盘）             │
│   ├─ BridgeClient：本地 WebSocket（127.0.0.1 随机端口 + 每次启动随机 token）        │
│   ├─ Tray / 通知 / 徽标 / 原生对话框 / 单实例锁 / 开机自启 / 日志 / 桥接状态        │
│   └─ Preload（contextBridge 白名单，按来源分级）                                   │
│  BrowserWindow（sandbox + contextIsolation + 固定分区）                           │
│   ├─ dsh-app://shell/*  壳页面（loading/error）：完整壳能力                        │
│   └─ dsh-app://app/*    官方 Web UI：只有 { protocolVersion, installUpdate }       │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │ spawn（stdio: pipe×4 + ipc；cwd = profile 目录）
┌───────────────────────────────▼──────────────────────────────────────────────────┐
│  Host 进程（随包 Node 运行时，进程内引导 dsh）                                     │
│   $DSH_HOME/profiles/dsh-workbench：dsh-base + dsh-web-app + 用户 bundle + bridge  │
│   ├─ /api 共享 fetch、静态 Web 资源、/.dsh/remote-stream（NDJSON）经管道返回        │
│   └─ dsh-desktop-bridge（host 插件）：本地 WS 事件推送 + RPC + 诊断                │
└───────────────────────────────────────────────────────────────────────────────────┘
```

> 本机**不存在 harness 的监听端口**（D27）：渲染层的每个请求都由主进程经管道喂给 Host，
> 页面靠 Host 注入的 `__DSH_TRANSPORT__` 接管；bridge 的 WS 是唯一例外（回环 + token，D4）。

### 关键决策（ADR）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **Electron**（≥43）而非 Tauri | 壳与 harness 同属 JS/Node 生态；harness 无论如何都是 Node 子进程，Tauri 省不掉 Node 运行时；Windows 优先下 Electron 的 tray/notification/badge 成熟 |
| D2 | harness 以**子进程**运行，不做进程内嵌入 | `@deepseek-ai/dsh` 无稳定编程 API（打包产物）；子进程方案与"一切皆插件"一致，崩溃自愈/日志/参数注入干净 |
| D3 | 专用 `desktop` profile（`$DSH_HOME/profiles/desktop`），**默认复用系统 ~/.dsh** | 会话与 CLI/Web 共享；设置项可切换独立 home |
| D4 | 桥接传输 = **本地 WebSocket + 一次性 token**，经 `dsh desktop:` stdout 行发现 | 无固定端口冲突；stdout 行是既有稳定发现机制；token 防本机劫持 |
| D5 | ~~`--port 0` + 解析打印的 URL~~ → **历史**（D27 后 harness 不监听端口；只有 bridge 的 WS 用 `port 0`，见 D4） | 官方支持 `port 0`，杜绝端口冲突 |
| D26 | **渲染层不直连 harness 端口**：窗口加载特权方案 `dsh-app://app/`，HTTP 全量由主进程代理到回环端口；Remote 流（原 WebSocket mux）由主进程持有 WS 并以 NDJSON 转发，页面靠注入的 `__DSH_TRANSPORT__` 接管 | 对齐官方桌面壳「开不了/不开监听端口」的设计：端口、token 与会话 cookie 不进渲染层，页面里任何内容（第三方插件 client、模型输出渲染）都够不到 harness 的 HTTP 面；官方那套 framed-pipe 传输是私有包（`@deepseek-ai/dsh-desktop-host` 未发布），本壳用「同源特权方案 + 主进程代理」拿到同等隔离 |
| D27 | **完全采用官方桌面端架构**：Host 子进程（`packages/host`，官方 apps/desktop-host 的移植）在随包 Node 里引导 dsh；壳与 Host 之间只有 fd3/fd4 **字节管道**（协议 v3，13 字节帧头，64 KiB 数据帧，desiredSize 背压）；渲染层只经 `dsh-app://` 特权方案访问 —— **本机不存在 harness 的监听端口** | 官方 README 的核心决策（端口归属/认证/CORS/暴露风险），并且是唯一能让 Web UI 在自定义方案下正常工作的形状（远端流从 WS mux 改走 NDJSON，Host 注入 `__DSH_TRANSPORT__`） |
| D28 | **运行时随包两棵树**：`resources/runtime`（便携 Node + pnpm）+ `resources/dsh`（dsh 闭包 + 第一方包 + `desktop-runtime.json`），`extraResources` 分发、不再解压 | 官方 prepare-runtime / prepare-dsh 的形状；`desktop-runtime.json`（每文件 sha256 + sharedPackages + release 身份）在启动时校验，`resources/dsh/node_modules` 需要单独一条 extraResources 映射（electron-builder 会剔除源目录根的 node_modules，官方同款处理） |
| D29 | **版本绑定 = 一个签名更新单元**：壳版本 + dsh 版本 + Node + pnpm + 协议版本写进 `desktop-runtime.json`；壳启动校验 `release.version === app.getVersion()` 且 dsh 共享包版本一致 | 官方 release.ts / verifyDesktopRuntime 的语义。**删除**：应用内 harness 整树刷新、npm registry 版本检测、启动兼容探测、tar.gz 解压与 marker、不兼容版本清单（历史上为「解耦更新」付出的全部复杂度） |
| D30 | **插件全部走随包 pnpm + profile 组合**：`dsh.profile.bundles` 决定加载什么；第一方包以 junction 共享包链接；第三方插件 `pnpm add --save-exact --ignore-scripts`，依赖脚本只认官方 `allowBuilds` 白名单；事务持有 `<profile>/lock` + `desktop-packages-pending`，失败保留部分改动、不回滚 | 官方 project-manager 语义。bridge 因此改为**标准 bundle 包**（`dsh.bundle.patch`），token 由插件自持并只经 stdout 发现行交给壳（bundle 模型下没有 config 注入点） |
| D31 | **签名按官方流程**：Windows EV/SafeNet 令牌签名（`scripts/windows-sign.mjs`，环境不备则显式跳过、配一半则硬报错）；macOS Developer ID + notarytool + stapling（`scripts/package-macos.mjs`，`resources/dsh`、`resources/runtime` 排除签名） | 官方 build pipeline 的等价物；细节与所需环境变量见 docs/SIGNING.md |
| D32 | **桥接握手带协议版本**：`auth` 带 `protocolVersion`，插件在 `authed` 里回自己那版 + 最新诊断；两端不一致时壳记 error、通知一次并在托盘标注，但**不掐断** | profile 层允许用户替换 bundle，跨版本不一致必须可诊断；增量字段是加法式的，降级比拒绝更符合"桌面至少能用" |
| D33 | **诊断通道 `bridge.diag`**：插件把 `ws.listening`/`jobs.present|absent`/`auth.rejected`/`loader.rejected`/`protocol.mismatch` 既打 stdout 也推给已鉴权连接，最新一条随 `authed` 给壳；壳落日志并显示「桥接：已连接 · jobs present」 | 桥接失效的表现是"通知不响"，此前只能翻与 harness 混流的 stdout；诊断通道让"连上了吗 / jobs 在不在"变成一眼可见的托盘状态 |
| D34 | **桌面状态增量推送**：`sessions.changed`（会话新建/结束/标题变更；去抖 250ms + 单飞合并）与 `approval.decided`（审批出环）；壳维护会话目录与待审批环，托盘给「最近会话」「待审批 N 条」（点击经深链直达） | 连接时的一次快照解决不了"跑着跑着改了标题/新建了会话"；系统通知会漏看，托盘需要一个常驻的待处理入口 |
| D35 | **API Key 自检走桥接**（`billing.balance`），桥接不可用时回退本地 `.credentials.yaml`；结论三态 `ok/invalid/unknown`，只有 401/403 与"未配置"才报警 | harness 的 credentials 服务会读环境变量与 dotenv 回退，壳自己解析文件会在"用环境变量启动"时误报未配置；网络类失败更不该被当成 key 失效 |
| D6 | 打包分发**自包含运行时**（便携 Node + pnpm + dsh 闭包 + 第一方包，见 D28），dev 与打包走同一条加载链路 | 离线可用；`ELECTRON_RUN_AS_NODE` 因原生模块 ABI 风险弃用 |
| D10 | ~~运行时 tar.gz 首启解压~~ → **已删除**（D28：两棵树由 `extraResources` 直接分发，不再解压） | 解压/版本标记/校正那一整套复杂度都省了 |
| D7 | 渲染安全基线 | contextIsolation、sandbox、导航锁、外链校验 |
| D8 | 关闭窗口默认最小化到托盘；优雅停机（SIGTERM→5s→SIGKILL）；意外退出指数退避重启（1s..30s） | 桌面工作台常驻体验 |
| D9 | bridge 插件**自包含**（vendored ws，无运行时依赖），以共享包 junction 链接进 profile（D30；不再复制进 profile） | bundle 行从 dsh 安装目录解析；离线可用 |
| D25 | **壳只保留桌面原生能力；不内置任何注入式 UI 插件**（随包共享包只有 `dsh-desktop-bridge`）。`ui-dashboard` 自 0.7.18 起**不再随包分发**（仓库里的 `packages/ui-dashboard` 只是同步副本，供插件自装）；是否加载交回用户在 profile 层决定 | 仪表盘/终端/主题等 UI 扩展不属桌面壳职责；需要时以 harness 插件（`dsh.client` 双面包）形式按需加载（`dsh plugin --profile dsh-workbench add <spec>`），壳与 harness 内核保持最小接触面（仅 bridge） |

## 3. 关键事实（实测确认）

1. **patch 语法**：`cordis.patch.yml` 是顶层 YAML 数组：`- id: X, config:` 覆盖整行、`disabled: true` 禁用、`- insert: [{id, name, config}]` 插入新行。
2. **解析位置**：bundle 行从 dsh 安装目录解析，用户 `cordis.patch.yml` 的 `name:` 行从 **profile 目录**解析（实测错误 `Cannot find package 'dsh-desktop-bridge' imported from ...\profiles\desktop\`）→ 插件必须能在 profile 的 node_modules 里解析到（第一方包用 junction，第三方走 pnpm 安装）。
3. **Loader 安定**：`ctx.get('loader')?.await()` 返回树安定 Promise；`jobs` 服务在 apply 阶段尚不可见，**必须在安定后接线**。
4. **jobs 是 owner 相对的**：`jobs.list(caller)` 返回「无主任务 ∪ 该 caller 的任务」——跨会话聚合必须**按 id 去重**（否则无主任务在每个会话里各出现一次），caller 用 `ctx.agents.get(session.id)`（agent/session 共享 id）。
5. `--port 0` 官方支持；`--host 0.0.0.0` 被拒绝。**监听**的 `address()` 在 `'listening'` 之前返回 null，端口必须等事件、不能构造后立刻读。
6. 会话/设置/工作区注册表持久化在 `$DSH_HOME`（sessions/storages），桌面版与 Web/CLI 天然共享。
7. **会话生命周期事件**：`session/created` / `session/disposed` 投递 `(session)`；`session/event` 投递 `(session, event)`；`sessionPersistence.list()` → `[{header:{id,createdAt},…}]`、`open(id,'read')` → `handle.read(0)` → `{eventState,events}`。
8. **审批事件**：`approval/asked` data 为 `{id,toolName,callId?,reason?}`；`approval/decided` 为 `{id,outcome}`。

## 4. 模块设计

### 4.1 桌面 profile（resources/profile-template/dsh-workbench）

```
package.json      dsh.profile.bundles: [dsh-base, dsh-web-app, <用户 bundle…>, dsh-desktop-bridge]
cordis.yml        []（空条目根）
cordis.patch.yml  []（用户补丁层，壳不写它）
```

- 首次运行由壳复制到 `$DSH_HOME/profiles/dsh-workbench`（`runtime.ts` 的 `ensureProfile*`）。
- **加载什么由 `dsh.profile.bundles` 决定**（D30）：官方基线在前、用户 bundle 居中、bridge 永远最后；
  `ensureProfileBundles` 只做"缺失即补齐"，已满足时不写盘。
- 第一方包（`@deepseek-ai/dsh`、`dsh-desktop-host`、`dsh-desktop-bridge`）以 **junction 共享包** 链接进
  profile 的 `node_modules`（`profilePackages.linkDesktopHostPackages`）；第三方插件走随包 pnpm
  事务安装（`pluginTransactions.ts`）。
- 安全模式把 bundles 收窄到「官方基线 + bridge」（`isolateProfileForSafeMode`，带备份可恢复）。
- bridge 不再需要 config 注入（token 由插件自持并只经 stdout 发现行交给壳）：历史 `--patch`
  overlay、`userData/overlay-*.yml`、`userData/plugins/` 那一套随架构迁移一并删除。

### 4.2 dsh-desktop-bridge（packages/bridge，纯 JS ESM，bundle 层 host 插件）

- `WebSocketServer({host:'127.0.0.1', port:0, maxPayload:1MiB})`；首条消息必须 `{type:'auth', token, protocolVersion}`；
  鉴权失败关 4001、10s 未鉴权关 4002（`authTimeoutMs` 可注入，测试用）；token 用 `timingSafeEqual` 比较。
- **发现行**：WS 开始监听 **且** loader 安定后打印一行 `dsh desktop: {"port","token"}`（幂等；绑定失败只打诊断）。
  插件自己生成随机 token（bundle 模型没有 config 注入点），token 不落 profile、不进日志。
- `authed` 回执：`{pid, protocolVersion, diag}`（诊断最新一条；壳据此判断同代 + 显示桥接状态）。
- 事件推送（最小字段，绝不序列化 live 对象）：
  - `jobs.changed`：`{jobs:[{id,kind,label,status,owner}]}` —— `onJobsChanged` + 逐会话聚合（无主任务按 id 去重）；
  - `job.done`：`{job:{…}}` —— `onJobDone`（快照含 label/kind，通知可读）；
  - `approval.asked` / `approval.decided`：`{kind,sessionId,requestId,toolName}` —— 从 `session/event` 过滤
    （**监听签名是 `(session, event)`**）；asked 入环、decided 出环（TTL 10 分钟，最多 20 条）；
  - `sessions.changed`：`{sessions:[{id,title,live,createdAt}]}` —— 会话新建/结束/标题变更的合并目录
    （去抖 250ms + 单飞；无客户端时不计算）；
  - `bridge.diag`：`{level,code,detail}` —— 见 D33。
- RPC（消费者见 `docs/BRIDGE-ROADMAP.md` 契约表）：
  - 正式面：`ping` / `workspace.register {path}`（`workspaceRegistry.create`）/ `session.resolve {id}`（live 优先、持久化兜底）/ `dashboard.snapshot`（运行时 + 会话 + 任务 + 待审批）；
  - 诊断面：`runtime.info` / `sessions.list` / `billing.balance`（后者也是壳 API key 自检的桥接实现，D35）。
- 防御性：所有外部读取经 `safe()` 包装、服务缺失按"没有"降级（jobs/sessions/agents 全缺也不抛），
  单个事件异常不拖垮 harness；全部副作用可逆（disposer + `ctx.on('dispose')`），卸载先广播空任务集再优雅关连接。
- `vendor/ws` 为内联副本，零运行时依赖（离线随包的前提）。

### 4.3 Electron 壳（src/main）

| 模块 | 职责 |
|---|---|
| `index.ts` | 主流程：单实例 → 设置/日志 → 确保 profile → 运行时校验 → 窗口/托盘 → `host.start()` → bridge 连接与事件分发 → 全局快捷键/自动更新/插件管理/深链 |
| `host.ts` / `hostProcess.ts` / `hostProtocol.ts` | Host 子进程管理（spawn/重启/退避）、fd3/fd4 帧编解码（协议 v3，13 字节帧头，64 KiB 数据帧）、stdout 按行回调（发现行嗅探） |
| `bridge.ts` | WS 客户端：token + 协议版本握手、事件、RPC、断线 1s 退避重连、世代守卫（旧 socket 不误杀新连接） |
| `bridgeEvents.ts` | 纯逻辑：发现行解析/脱敏、事件→通知/徽标、会话目录与待审批环、诊断解析（可单测） |
| `appProtocol.ts` | `dsh-app://` 特权方案：`shell` 壳页面 + `app` 工作台；工作台请求经主进程转发到 Host 管道 fetch，入口注入 `__DSH_TRANSPORT__` |
| `window.ts` | BrowserWindow + loading/error 过渡页 + 导航锁（只放行 `dsh-app://shell` / `dsh-app://app`） |
| `tray.ts` | Harness/桥接状态行、最近会话、待审批、切换工作区、重启 Harness、API Key 状态、桌面插件、设置（更新/自启/通知/局域网）/日志/卸载/退出 |
| `runtime.ts` / `runtimeTree.ts` / `profilePackages.ts` | 运行时定位与描述符校验（dsh/host/**bridge** 三件共享包是硬前提）、profile 确保、bundle 组合、共享包 junction |
| `pluginTransactions.ts` / `pluginfs.ts` | 第三方插件的 pnpm 事务安装/卸载、cordis.patch.yml 残留清理、保留名保护 |
| `maintenance.ts` | 清理日志；卸载（Windows NSIS 卸载器，保留用户数据） |
| `notify.ts` | 系统通知（可带点击动作）+ `app.setBadgeCount` 徽标 |
| `deepLink.ts` | dsh:// 深链解析（focus/new/session）；会话标题优先取本地会话目录，miss 再走 RPC |
| `apiKeyCheck.ts` | API Key 自检：桥接 `billing.balance` 优先、本地文件回退、三态结论（D35） |
| `updater.ts` | electron-updater + GitHub provider（框架更新 = 唯一更新链路，D29） |
| `settings.ts` / `safeMode.ts` / `sessionRepair.ts` | 壳偏好、安全模式计数与隔离、会话日志修复 |
| `logger.ts` | 环形日志落盘（5MB 轮转） |
| `ipc.ts` / `preload` | 按来源分级的 IPC 白名单：`dsh-app://shell` 拿壳能力，`dsh-app://app` 只有 `{ protocolVersion, installUpdate }`（两处各校验一次） |

### 4.4 插件机制（桌面壳 ↔ profile 组合）

- **第一方包**：`packages/bridge`（桥接，必需）与 `packages/host`（Host 入口）随运行时树分发，
  以 junction 链接进 profile；bridge 在 `dsh.profile.bundles` 里且**永不可卸**（`isReservedPluginName`）。
- **第三方插件**：官方模型——`dsh plugin --profile dsh-workbench add <spec>`（或托盘「安装插件…」）走
  随包 pnpm 事务（`pluginTransactions.ts`：profile 锁 + pending 记录 + `--ignore-scripts` + 官方 allowBuilds 白名单）。
- **启停**：托盘「桌面插件」可勾选（bundle 取消挂载 = 移出 `dsh.profile.bundles`，代码保留可恢复）或卸载；
  改动前先停 Host（避免热监听回滚 manifest），成功后重启生效。
- **安全模式**：连续启动失败达阈值 → bundles 收窄到官方基线 + bridge（带备份），应用保底可打开。
- 历史形态（`resources/plugins/` 内置复制、`--patch` overlay、`userData/plugins/`）已随 D28/D30 架构迁移删除。

### 4.5 加载页：粒子鲸鱼动画（shell-pages/loading.html）

启动/重启/崩溃恢复时的过渡页（白底 + 粒子鲸鱼，自研实现）。**随壳分发**（harness 未启动时展示，无法是插件）。

### 4.6 构建与分发

- `scripts/build.mjs`：main/preload（esbuild → CJS）→ `dist/`。
- `scripts/setup-runtime.mjs`：便携 Node + pnpm → `resources/runtime`；`npm install @deepseek-ai/dsh@<version>` +
  第一方包 tgz（`pack` 出 bridge/host）→ `resources/dsh`，写 `desktop-runtime.json`（逐文件 sha256 + 发行身份）；
  增量判据是**源码哈希**（bridge/host/shell 版本变了才重建）。
- `electron-builder.yml`：两棵树走 `extraResources` 分发（`resources/dsh/node_modules` 单独一条映射）。
- CI（`.github/workflows/build-release.yml`）：`check`（typecheck + 单测）+ **`e2e`**（Windows：setup-runtime → `npm run e2e:bridge`，
  真实 dsh + Host 管道 + 桥接契约）在 master/PR 跑；打 `v*` tag 或手动触发时三平台构建并上传 Release
  （运行时树有缓存，键含 setup-runtime 与第一方包 package.json 的哈希）。

## 5. 数据流

1. **启动**：单实例锁 → 设置/日志 → 确保 profile（bundles 补 bridge + 共享包 junction）→ 定位运行时 →
   窗口（loading 页）→ `host.start()`（fd 管道 + IPC）→ Host ready → 加载 `dsh-app://app/` →
   读 stdout 发现行 → bridge 连接（握手协议版本 + 诊断）→ `ping` 自检 + `dashboard.snapshot` 整份对齐
   （徽标 / 会话目录 / 待审批）→ 处理排队的深链。
2. **事件**：任务注册/完成、审批、会话目录变化 → bridge WS → 徽标/系统通知（点击直达会话）/托盘状态更新。
3. **退出**：托盘退出 → Host 优雅停机（SIGTERM → 5s → SIGKILL）→ `app.exit(0)`；窗口关闭默认 hide（托盘常驻）。
4. **崩溃**：Host 非 0 退出 → 指数退避重启（1s..30s）→ 窗口"正在重启" → 就绪后自动重载；连续失败进安全模式。

## 6. 安全边界

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；`will-navigate`/`setWindowOpenHandler` 只放行 `http://127.0.0.1:*` 与壳页面；外链经 `shell.openExternal` 校验。
- 桥接：仅 127.0.0.1；每次启动新 token（插件自生成，只出现在 stdout 发现行，壳不落盘、日志脱敏）；WS 首包必须鉴权（常量时间比较 + 10s 未鉴权断开 + 1MiB 帧上限）。
- 壳不读取、不落盘会话内容；仅记录 harness stdout/stderr 与自身事件。
- bridge 插件零外部依赖（vendored ws），随包分发，无供应链新增面。

## 7. 测试与验收

自动化（`npm test`，node:test）：`bridge-events`（runningJobCount、通知开关、徽标更新、approval、畸形 payload）、`deep-link`（语法/编码/argv 提取）。

E2E（`scripts/e2e-turn.mjs`，需 `DSH_DESKTOP_ELECTRON_ARGS=--remote-debugging-port=9222`）：

| 项 | 结果 |
|---|---|
| 窗口加载官方 UI（标题 DeepSeek Harness，共享会话列表可见） | ✅ |
| 真实 agent 轮次（输入→提交→模型回复+轮次统计） | ✅ |
| 后台任务（run_in_background → pwsh-1 → 完成） | ✅ |
| 桥接事件链（jobs.changed running→completed / job.done 达壳） | ✅ |
| 崩溃自愈（强杀 harness → 1s 内重启 → 新端口 → 重连） | ✅ |
| 桥接 RPC 自检（ping / runtime.info / workspace.register） | ✅ |

手动清单（需人眼）：系统通知弹窗、任务栏徽标数字、托盘菜单交互、开机自启、窗口关闭最小化、切换工作区原生对话框、安装包离线运行。

## 8. 已知限制与后续

- `jobs.list` 逐会话聚合在会话数多时 O(n)（已按 id 去重；量大时可改为只订阅无主任务 + 增量维护）。
- `dsh://session/<id>` 依赖侧边栏渲染该会话（当前工作区可见的会话）；未分组/其他工作区的会话只聚焦窗口。
- 通知/徽标由事件驱动；连接/重连后由 `dashboard.snapshot` 整份对齐（徽标 / 会话目录 / 待审批），因此跨 Host 重启不会留下旧计数。
- **macOS**：dmg 打包（arm64/x64）、`dsh://` 深链（Info.plist protocols + open-url 事件 + 冷启动队列）、运行时路径走 `~/Library/Application Support` 已配置；**未实机验证**（打包须在 macOS 上执行 `npm run dist:mac`，且运行时 tar.gz 需在 mac 上重建）。
- **Linux**：代码兼容（运行时路径走 `$XDG_DATA_HOME`），未提供打包配置。
- harness 版本随壳绑定（当前 0.1.5-rc.2）；升级走框架发版，打包时由 setup-runtime.mjs 安装（`DSH_RUNTIME_DSH_VERSION` 可覆盖）。
- **更新机制（单链路）**：`src/main/updater.ts`（electron-updater + GitHub provider）负责框架更新，一次更新同时带走随包 dsh 运行时（D29）。历史的两层模型（含应用内 harness 整树刷新与 npm 版本检测）已删除。
- **macOS 多架构自动更新**：arm64 与 x64 运行时 tar.gz 各自平台生成，CI 分两个 job 各产一个 dmg（含各自 `.blockmap`）。electron-updater 的 GitHub provider 读取单一 `latest-mac.yml`，按其 `files[]` 中 url 是否含 `process.arch` 挑选 dmg——因此由独立的 `merge-mac-manifest` job（`scripts/merge-mac-manifest.mjs`）把两份 dmg 的 url/sha512/size 合并为一份 `latest-mac.yml` 上传，两个架构的用户都能应用内更新。
- 更新安装依赖 NSIS 安装器（`quitAndInstall` 静默执行）；`oneClick: false` 下更新流程已验证到"就绪"事件，安装动作留待真实发布后人工确认。
- 如需仪表盘/终端/主题等扩展，以 harness 插件（`dsh.client` 双面包，`/plugins/<id>/client.js` 协议）按需开发，经 `dsh plugin --profile dsh-workbench add <spec>` 装进 profile bundles——壳不内置（D25）。
