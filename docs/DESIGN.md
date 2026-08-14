# DSH Desktop — DeepSeek Harness 桌面工作台 设计文档

版本：0.3.0 ｜ 状态：已实现（M0–M5） ｜ 平台：Windows 优先（macOS/Linux 配置就绪）

## 1. 背景与目标

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）是 DeepSeek AI 的开源 agent harness，采用 **一切皆插件** 架构（Cordis 驱动）。官方提供 `dsh web`（浏览器 GUI，默认 `http://127.0.0.1:3080`）与 `dsh --profile headless` 两种表面。

本项目的目标：在 harness 之上构建一个 **桌面工作台**（Windows 优先）：

- 原生桌面壳（窗口、托盘、系统通知、任务栏徽标、开机自启、原生目录对话框）；
- 内嵌 harness 运行时，**离线、免安装 Node、免全局 dsh** 即可运行；
- 完整复用官方 Web UI（会话、工作区、插件、设置），**零改动**；
- 后台常驻、崩溃自愈、会话与设置跨重启持久；
- 不侵入 harness 内核：壳与 harness 通过一个极小的桥接插件通信。

参考：[官方产品页](https://www.deepseek.com/harness/)、[官方文档站](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)、[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)。

## 2. 总体架构

```
┌────────────────────────── dsh-desktop（Electron 应用） ──────────────────────────┐
│  Main 进程（TypeScript → CJS）                                                   │
│   ├─ HarnessManager：spawn/监控/重启 `dsh --profile desktop --patch <overlay>`   │
│   ├─ 逐行解析 stdout：`dsh web:` URL 行 + `dsh desktop:` 桥接行                   │
│   ├─ BridgeClient：本地 WebSocket（127.0.0.1 随机端口 + 一次性 token）            │
│   ├─ Tray / 通知 / 徽标 / 原生对话框 / 单实例锁 / 开机自启 / 日志                  │
│   └─ Preload（contextBridge 白名单，仅供壳页面）                                  │
│  BrowserWindow（sandbox + contextIsolation + 固定分区） ← 加载 harness Web UI    │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │ spawn（cwd = 工作区，DSH_HOME 显式注入）
┌───────────────────────────────▼──────────────────────────────────────────────────┐
│  Harness 子进程（独立 Node 运行时）                                               │
│   $DSH_HOME/profiles/desktop = dsh-base + dsh-web-app（bundle）+ bridge（overlay）│
│   ├─ 全部原生能力：会话/工具/沙箱/审批/设置/插件                                   │
│   └─ dsh-desktop-bridge（host 插件，本仓库开发）                                   │
│        · 127.0.0.1 随机端口 WebSocket，token 鉴权                                 │
│        · jobs.changed / job.done / approval.asked 事件推送                        │
│        · workspace.register / runtime.info / ping RPC                             │
│        · Loader 安定后打印 `dsh desktop: {"port":N,"token":"…"}`                  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 关键决策（ADR）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **Electron**（≥43）而非 Tauri | 壳与 harness 同属 JS/Node 生态；harness 无论如何都是 Node 子进程，Tauri 省不掉 Node 运行时；Windows 优先下 Electron 的 tray/notification/badge 成熟 |
| D2 | harness 以**子进程**运行，不做进程内嵌入 | `@deepseek-ai/dsh` 无稳定编程 API（打包产物）；子进程方案与"一切皆插件"一致，崩溃自愈/日志/参数注入干净 |
| D3 | 专用 `desktop` profile（`$DSH_HOME/profiles/desktop`），**默认复用系统 ~/.dsh** | 会话与 CLI/Web 共享；设置项可切换独立 home |
| D4 | 桥接传输 = **本地 WebSocket + 一次性 token**，经 `dsh desktop:` stdout 行发现 | 无固定端口冲突；stdout 行是既有稳定发现机制；token 防本机劫持 |
| D5 | `--port 0`（OS 分配端口）+ 解析打印的 URL | 官方支持 `port 0`，杜绝端口冲突 |
| D6 | 打包分发**自包含运行时**（便携 Node + npm 安装的 dsh 树 + bridge），dev 模式复用全局 dsh | 离线可用；`ELECTRON_RUN_AS_NODE` 因原生模块 ABI 风险弃用 |
| D10 | 运行时以 **tar.gz 随包分发，首启解压到 %LOCALAPPDATA%/DSH Desktop/runtime**（版本标记校验，二次启动免解压） | electron-builder 会剔除 extraResources 中的 node_modules（实测）；顺带避免 Program Files 只读问题；bsdtar 解压 3.5 万文件约 40s |
| D7 | 渲染安全基线 | contextIsolation、sandbox、导航锁、外链校验 |
| D8 | 关闭窗口默认最小化到托盘；优雅停机（SIGTERM→5s→SIGKILL）；意外退出指数退避重启（1s..30s） | 桌面工作台常驻体验 |
| D9 | bridge 插件**自包含**（vendored ws，无运行时依赖），prod 首启由壳复制进 profile node_modules | overlay `name:` 行从 profile 目录解析（实测错误信息确认）；离线可用 |
| D10 | 运行时以 **tar.gz 随包分发，首启解压到 %LOCALAPPDATA%/DSH Desktop/runtime**（版本标记校验，二次启动免解压） | electron-builder 会剔除 extraResources 中的 node_modules（实测）；顺带避免 Program Files 只读问题；bsdtar 解压 3.5 万文件约 40s |
| D11 | **右栏/底栏面板 = 注入式**：主进程直接读 `resources/panel-dist`（dev=磁盘，打包=asar，fs 透明），harness 文档 dom-ready 时 `insertCSS` + `executeJavaScript` 注入，脚本自带防重入 | 与主题兜底 CSS 同一机制，零网络栈依赖；曾尝试 `dsh-shell://` 特权协议（registerSchemesAsPrivileged + protocol.handle），主进程自检 200，但渲染层网络服务实测 `net::ERR_UNKNOWN_URL_SCHEME`（dev），弃用 |
| D12 | 面板数据三源分层：**bridge WS（主）→ harness stdout 解析（次）→ DOM 爬取（兜底）** | 实时 JSON 走既有桥接（新增 `dashboard.snapshot` RPC 拉全量 + 事件增量）；stdout 环形缓冲提供活动流/启动时序（零额外机制）；桥接离线时 DOM 探测保证面板不空转 |
| D13 | 终端**双后端**：PipeBackend（默认，零原生依赖）/ PtyBackend（可选，`DSH_DESKTOP_TERM=pty` 且需本机为 Electron ABI 构建 node-pty） | 实测 `@homebridge/node-pty-prebuilt-multiarch` v0.14.1 仅发布 Node ABI 资产、无 electron 资产；electron-builder 显式 `npmRebuild: false`；裸装必触发源码编译（VS Build Tools），多数机器不可用 |
| D14 | **dev 与已安装版隔离 userData**（dev 用 `%APPDATA%/dsh-desktop-dev`） | app 名解析为 `productName`（DSH Desktop），dev 与已安装版同锁同目录 → 已安装版运行中 dev 直接退出（实测）；隔离后两者可并行 |
| D15 | **面板/rail/终端为覆盖层（overlay）**，不修改 #root 布局；`#root` padding 让位会触发 harness 响应式断点（实测 frame 变窄 → 左侧侧边栏自动折叠为 rail） | 面板打开不再挤压左侧；左栏宽度经 DOM 轮询写入 `--dshd-left-w`，终端 `left/right` 偏移避开左右侧边栏 |
| D16 | **上下文环/会话指标 = 常驻 DOM 轮询**（2s，与 bridge 状态无关） | 该数据仅存在于 harness UI（上下文按钮 aria-label + stats 行）；计费按官方定价表内置常量（pricing.ts，可随调价更新） |

## 3. 关键事实（实测确认）

1. **patch 语法**：`cordis.patch.yml` 是顶层 YAML 数组：`- id: X, config:` 覆盖整行、`disabled: true` 禁用、`- insert: [{id, name, config}]` 插入新行（[dsh-web-app 的 patch](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/cordis.patch.yml)）。
2. **解析位置**：bundle 行从 dsh 安装目录解析；**overlay/用户 `name:` 行从 profile 目录解析**（实测错误 `Cannot find package 'dsh-desktop-bridge' imported from ...\profiles\desktop\`）。→ bridge 必须装入 profile 的 node_modules。
3. **Loader 安定**：`ctx.get('loader')?.await()` 返回树安定 Promise（web-app glue 同款时序）；`jobs` 服务在 apply 阶段尚不可见，**必须在安定后接线**（实测修正）。
4. **jobs 是 owner 相对的**：`jobs.list(caller)` 只返回该 caller 会话的任务；宿主侧跨会话计数须逐会话传 `ctx.agents.get(session.id)` 聚合（与 host-apiproxy 的 `session/jobs` 帧同法）。
5. `--port 0` 官方支持（"pass 0 to let the OS pick a free one"）；`--host 0.0.0.0` 被拒绝。
6. 会话/设置/工作区注册表持久化在 `$DSH_HOME`（sessions/storages），桌面版与 Web/CLI 天然共享。

## 4. 模块设计

### 4.1 桌面 profile（resources/profile-template/desktop）

```
package.json      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
cordis.yml        []（空条目根）
cordis.patch.yml  []（用户补丁层，壳不写它）
```

首次运行由壳复制到 `$DSH_HOME/profiles/desktop`；bridge 包按版本同步到 `profiles/desktop/node_modules/dsh-desktop-bridge`。每次启动壳生成 `userData/overlay-desktop.yml`：

```yaml
- insert:
    - id: dsh-desktop-bridge
      name: dsh-desktop-bridge
      config:
        token: <32位hex，每次启动新生成>
```

### 4.2 dsh-desktop-bridge（packages/bridge，纯 JS ESM）

- `WebSocketServer({host:'127.0.0.1', port:0})`；首条消息必须 `{type:'auth', token}`，否则关闭（4001）。
- 事件推送（最小字段，绝不序列化 live 对象）：
  - `jobs.changed`：`{jobs:[{id,kind,label,status,ownerSession}]}` —— `onJobsChanged` + 逐会话聚合；
  - `job.done`：`{job:{...}}` —— `onJobDone`（快照含 label/kind，通知可读）；
  - `approval.asked`：`{sessionId}` —— 从 `session/event` 过滤。
- RPC：`ping` / `runtime.info`（pid/DSH_HOME/cwd/node/workspaces）/ `workspace.register {path}`（走 `workspaceRegistry.create`，幂等）。
- 发现行：Loader 安定后 `console.log('dsh desktop: ' + JSON.stringify({port, token}))`。
- 全部副作用可逆：disposer + `ctx.on('dispose')`；ws 为 vendored 副本（`vendor/ws`，零依赖）。
- 防御性：所有外部读取经 `safe()` 包装，单个事件异常不拖垮 harness。

### 4.3 Electron 壳（src/main）

| 模块 | 职责 |
|---|---|
| `harness.ts` | spawn（dev: 全局 dsh；prod: `resources/dsh-runtime`）、行解析、就绪判定（URL+桥接行齐备）、指数退避重启、优雅停机、cwd 切换 |
| `bridge.ts` | WS 客户端、token 握手、断线重连（1s）、RPC（call with timeout）、事件分发 |
| `window.ts` | BrowserWindow（1280×820、`persist:dsh-ui` 分区、sandbox）、导航锁、loading/error 过渡页、外链拦截 |

### 4.5 加载页：粒子鲸鱼动画（shell-pages/loading.html）

启动/重启/崩溃恢复时的过渡页，以 [DeepSeek 官网](https://www.deepseek.com/harness/) 背景的**粒子鲸鱼**为视觉母题（自研实现，非复制官网代码）。**白色主题**（实测工作台 body 背景 `#ffffff`，加载页与其完全一致，避免切换色差）：

- 鲸鱼剪影：官网品牌素材 `hero-whale.svg`（24×18 viewBox）的 path 存于 `whale-path.txt`，经 `scripts/inject-whale.mjs` 注入模板 `loading.template.html` 生成 `loading.html`（`__WHALE_PATH__` 占位符）。该 path 为**负空间设计**（头部实心、身体中部镂空、眼睛/鳍），ASCII 渲染与图标目检一致。
- 渲染：SVG → data URI → 离屏 canvas（480×360，**透明底采样**）→ `getImageData` 像素采样（alpha>128，步长 4）→ 归一化目标点；900 个**方块粒子**（`fillRect`，大而淡的方形光晕 + 小而实的核心）从下方升起、淡入聚合。
- 配色：粒子 72% 近黑 `#0f1115`（工作台正文色）+ 深品牌蓝 + 少量亮蓝点缀；白底拖尾（rgba 255 0.55）形成运动轨迹；blur(16px) 光晕层。
- 防跳动：粒子颜色**创建时固定**（不再每帧随机）；高频闪烁改为极缓全局脉动（sin 4s ±10%）；**接近目标锁定**（距离 <0.5px 吸附、速度清零），只保留平滑的呼吸缩放（3.2s）与相位游动（2.1s）。
- 布局：鲸鱼在画布正中（`cy = H/2`），wrap 上限 380px，与文字整体垂直居中，顶部不再被遮。
- 转场：加载页自带淡入（0.5s）；壳 `loadApp` 在 file:// 页面时先调用 `window.__fadeOut()`（0.35s 淡出）再 `loadURL`——加载页 → 工作台**渐变过渡**而非突变。
- 工程细节：DPR 上限 2；`visibilitychange` 隐藏时暂停 rAF、恢复时无条件重新调度（schedule/step 单链）；`?state=` 状态文字；采样失败退化纯文字；CSP 收紧零网络依赖。
- 实测修复：① 采样前误填不透明黑底导致目标点铺满全矩形 → 透明底采样，形状恢复鲸鱼剪影；② 初始 hidden 时 rAF 被暂停后永不恢复 → schedule/step 重构；③ 每帧随机选色 + 高频闪烁导致"跳动" → 颜色固定 + 缓脉动 + 目标锁定。
- 验证（CDP 实测）：背景纯白 `255,255,255`；深色粒子包围盒呈鲸鱼形状；动画满帧（1.2s 174 帧）；`__fadeOut` 生效；真实重启流程窗口切至 `loading.html?state=…` 并自动恢复。
| `tray.ts` | 显示窗口/浏览器版/切换工作区/重启 Harness/查看日志/开机自启/通知开关/仪表盘与终端开关/退出 |
| `notify.ts` | 系统通知 + `app.setBadgeCount` 徽标 |
| `ipc.ts` | 壳页面白名单（pickWorkspace/revealInFolder/openExternal/restartHarness/openLogs/getInfo）+ 面板通道（dash:action/term:*，全部校验 mainFrame） |
| `settings.ts` | `userData/settings.json`：trayOnClose/notifications/autoStart/isolatedHome/recentWorkspaces/globalShortcut/autoUpdate/**sidebar/terminal/panelShortcuts** |
| `chrome.ts` | 面板注入：读 panel-dist 资产（缓存），dom-ready 时 insertCSS+executeJavaScript；终端 lazy 资产注入（bootTerm） |
| `dashboard.ts` | 仪表盘状态聚合（纯逻辑可单测）：事件增量、日志环（300）、快照 toSnapshot() |
| `terminal.ts` | 终端管理：PipeBackend/PtyBackend 双后端、Ctrl+C 复位、壳切换、exit 事件 |
| `termShell.ts` | 壳解析与 ANSI 剥离（纯函数，可单测） |
| `bridgeEvents.ts` | 事件→动作纯逻辑（可单测） |
| `runtime.ts` | 运行时定位、profile 确保、overlay 生成、bridge 同步 |
| `logger.ts` | 环形日志落盘（5MB 轮转） |

### 4.6 右栏仪表盘（注入式，src/panel/panel.ts + panel.css）

- **注入**：主进程在 harness 文档（`http://127.0.0.1:*`）每次 dom-ready 时注入（D11）；面板引导等待布局 frame 与 body 令牌就绪（轮询 30s），就绪后 `hello` 触发主进程补发状态/布局/日志基线。
- **结构**：头部（鲸鱼 logo + 桥接状态点 + 折叠）；运行时卡（harness/bridge/PID/Node/uptime/DSH_HOME/工作区/已注册工作区）；**上下文卡**（圆环进度条 + 已用/窗口 tokens + 系统/工具/对话构成，数据来自 harness 上下文按钮 DOM，deepseek 蓝，点击转发打开详情）；**会话指标卡**（缓存命中/运行时间/轮·步/首 token/速率/输入·输出 tokens + **费用估算**：deepseek 定价表 `pricing.ts`，官方价格 fetched 2026-08-13，含峰谷价常量，缓存命中率计入）；任务卡（运行数徽标 + 列表，状态 pill 色映射）；会话卡（实时/持久计数，行点击走 `dsh://session/<id>` 深链）；审批卡（最近 20 条，新到闪烁）；活动流（stdout/stderr 行级日志，自动滚动可暂停/清空）；页脚（徽标数/数据源/状态）。
- **布局（overlay）**：面板与 rail 为固定覆盖层，**不改 #root 布局**（实测 padding 让位会触发 harness 响应式断点导致左侧侧边栏自动折叠，D15）；左侧 harness 侧边栏宽度由 DOM 轮询写入 `--dshd-left-w`（展开 280 / 折叠 56）。
- **折叠 rail（对仗左侧）**：56px 全高窄栏（与 harness 左 rail 同宽同底色），顶部 36px 面板图标按钮（对仗左侧 logoRow），**终端开关按钮沉底**（对仗左侧设置区），图标颜色同令牌。
- **数据**：`dsh:dash:state`（200ms 节流快照）/ `dsh:dash:log`（300ms 批，`sync` 批为 hello 时全量基线）/ `dsh:dash:layout`（开合与尺寸）；上下文/会话指标为**常驻 DOM 轮询**（2s，与 bridge 状态无关）。
- **DOM 兜底（C 源）**：桥接离线时 2s 轮询 `[role=treeitem]`（会话数）、`[data-state=running|starting]`（任务近似），标注「桥接离线 · DOM 快照」；选择器集中注释（harness 0.1.0-rc.6 实测，升级复查）。

### 4.7 底栏终端（src/panel/term.ts + src/main/terminal.ts）

- **面板**：xterm.js（`@xterm/xterm`，lazy 注入：首次打开时主进程注入 xterm.css + term.js，422KB 不进首屏）；tab 切换 PowerShell/cmd/pwsh；拖拽调高（120–480px，持久化）；主题色从 body 令牌实时读取（MutationObserver + matchMedia，三态换肤）；**系统终端按钮**（⧉）在独立窗口打开完整 TTY（`detached` spawn）。
- **位置（D15）**：`left: var(--dshd-left-w)`（harness 侧边栏宽，不覆盖左栏）、右缘 = 面板宽（展开）或 rail 宽（折叠），**不覆盖左右侧边栏**。
- **后端**（D13）：PipeBackend = spawn shell 接管 stdio（PowerShell 带 `-NoProfile` 加速启动），ANSI 剥离、Ctrl+C 复位（杀壳重开并提示）、spawn 即打印就绪横幅（后端模式/壳/cwd）；PtyBackend = try-require('node-pty')（需 `DSH_DESKTOP_TERM=pty` + 本机 Electron ABI 构建）。
- **生命周期**：独立于 harness 子进程（harness 崩溃重启不影响已开终端）；✕ 真正关闭会话（overlay 提示），面板收起→展开且会话已死时自动重开；「＋」以当前工作区重开；退出显示 overlay 提示。

### 4.8 共享类型（src/shared/types.ts）

preload 与面板共用的纯数据契约（DashSnapshot/DashLogBatch/DashLayout/PanelApi），不引入 electron 依赖，面板可安全打包进浏览器侧。

### 4.9 上下文环 / 会话指标与计费（src/panel/stats.ts + pricing.ts）

- **数据源**（常驻 2s DOM 轮询）：harness 上下文按钮（`button[aria-label*="上下文已用"]`，含百分比与 `~X / Y` 明细）与 stats 行（`.FJxK0a_root`，实测格式 `3 轮 · 6 步| LLM 16.2s · 工具调用 9.7s| 首 token 平均 1.2s · 140 tok/s| 缓存命中 82%| 输入 450K tok · 输出 1.2K tok`）；解析函数纯逻辑可单测，缺字段容错（harness 改文案不崩）。
- **费用估算**：`estimateCost(model, mode, input, output, cacheHitRate)`，定价表按官方文档（api-docs.deepseek.com/quick_start/pricing，fetched 2026-08-13：deepseek-v4-flash 命中 $0.0028/M、未命中 $0.14/M、输出 $0.28/M；v4-pro 相应翻倍；2026-08-16 起峰谷价常量已内置）；模型名从 composer DOM 探测（`DeepSeek-*`，含模式后缀规范化）；请求数 harness 未暴露 → 以步骤数近似并注明。

### 4.4 数据流

1. **启动**：单实例锁 → 设置/日志 → token+overlay → 确保 profile/bridge → 定位运行时 → 建窗口（loading 页，粒子鲸鱼淡入）→ `harness.start()` → 解析 `dsh web:`/`dsh desktop:` → **触发加载页淡出（0.35s）** → `loadURL` → bridge 连接（自检 ping + `dashboard.snapshot` 拉全量）→ 工作区注册（若刚切换）。
2. **面板注入**：harness 文档 dom-ready → 主题兜底 CSS + 面板 CSS/JS 注入 → 面板轮询 frame 就绪 → `hello` → 主进程补发状态/布局/日志基线 → 事件/日志增量持续推送。
3. **使用**：窗口内即官方 Web UI，零改动。
4. **事件**：任务注册/完成/审批 → bridge WS → 徽标/系统通知 + 仪表盘增量 → 点击聚焦窗口。
5. **退出**：托盘退出 → SIGTERM → 等 5s → SIGKILL → `app.exit(0)`；窗口关闭默认 hide（托盘常驻）。
6. **崩溃**：harness 退出非 0 → 清 ready → 1s/2s/4s…（上限 30s）重启 → 窗口显示"正在重启" → 就绪后自动重载 → 面板随 dom-ready 重新注入 → 快照重拉。

## 5. 项目结构

```
dsh-desktop/
├─ package.json / tsconfig.json / electron-builder.yml
├─ scripts/
│  ├─ dev.mjs            # build + dev-link + electron .
│  ├─ build.mjs          # esbuild main/preload + 面板（panel/term）+ bridge → resources/
│  ├─ dev-link.mjs       # junction: profile node_modules ← packages/bridge（仅 dev）
│  ├─ make-icons.mjs     # 纯 JS PNG/ICO 图标生成（白底 + 黑鲸，SVG path 自研光栅化）
│  ├─ setup-runtime.mjs  # 便携 Node + npm install dsh → resources/dsh-runtime
│  ├─ cdp.mjs            # CDP 调试辅助（探查页面）
│  ├─ e2e-turn.mjs       # CDP E2E：驱动真实 agent 轮次
│  └─ verify-dashboard.mjs # CDP E2E：面板/终端验证（注入、布局、数据、主题、回环）
├─ src/
│  ├─ main/              # 壳主进程（含 chrome/dashboard/terminal/termShell 新模块）
│  ├─ preload/           # contextBridge 白名单（含面板通道）
│  ├─ panel/             # 面板前端（panel.ts 仪表盘 / term.ts 终端 / panel.css / whale.ts）
│  └─ shared/types.ts    # 壳 <-> 面板共享契约（纯类型）
├─ packages/bridge/      # dsh-desktop-bridge 插件（lib + vendor/ws）
├─ resources/
│  ├─ profile-template/desktop/
│  ├─ shell-pages/       # loading/error 过渡页（loading 为粒子鲸鱼动画，见下）
│  ├─ whale-path.txt     # 鲸鱼 SVG path（DeepSeek 官网品牌素材，注入用）
│  ├─ loading.template.html # 加载页模板（__WHALE_PATH__ 占位符）
│  ├─ bridge/            # build 产物（随 asar 分发）
│  ├─ panel-dist/        # build 产物：panel.js/term.js/panel.css/xterm.css（随 asar 分发）
│  ├─ icons/             # 生成产物
│  └─ dsh-runtime/       # setup-runtime 产物（自包含运行时）
├─ test/                 # node --test（bridge-events / dashboard / terminal-backend / deep-link）
├─ docs/DESIGN.md        # 本文档
└─ README.md
```

## 6. 安全边界

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；`will-navigate`/`setWindowOpenHandler` 只放行 `http://127.0.0.1:*` 与壳页面；外链经 `shell.openExternal` 校验。
- 桥接：仅 127.0.0.1；每次启动新 token（overlay 注入，插件 config 校验）；WS 首包必须鉴权。
- 壳不读取、不落盘会话内容；仅记录 harness stdout/stderr 与自身事件。
- bridge 插件零外部依赖（vendored ws），随包分发，无供应链新增面。

## 7. 测试与验收

自动化（`npm test`，node:test）：runningJobCount、通知开关、徽标更新、approval、畸形 payload；dashboard 聚合（事件增量/日志环/快照形状/离线降级）；终端壳解析与 ANSI 剥离。
E2E（`scripts/e2e-turn.mjs` / `scripts/verify-dashboard.mjs`，需 `DSH_DESKTOP_ELECTRON_ARGS=--remote-debugging-port=9222`）：

| 项 | 结果 |
|---|---|
| 窗口加载官方 UI（标题 DeepSeek Harness，共享会话列表可见） | ✅ |
| 真实 agent 轮次（输入→提交→模型回复+轮次统计） | ✅ 首 token 2.7s、107 tok/s |
| 后台任务（run_in_background → pwsh-1 → 完成） | ✅ |
| 桥接事件链（jobs.changed running→completed / job.done 达壳） | ✅ |
| 崩溃自愈（强杀 harness → 1s 内重启 → 新端口 → 重连） | ✅ |
| 桥接 RPC 自检（ping / dashboard.snapshot） | ✅ |
| 面板注入/布局让位/状态快照/活动流基线（verify-dashboard） | ✅ |
| 主题实时换肤（翻转 body[data-ds-dark-theme] → 面板背景随令牌变化） | ✅ |
| 终端回环（打开 → PowerShell echo → xterm 输出；崩溃自愈后面板重注入） | ✅ |

手动清单（需人眼）：系统通知弹窗、任务栏徽标数字、托盘菜单交互、开机自启、窗口关闭最小化、切换工作区原生对话框、面板拖宽/折叠/审批闪烁、终端 tab 切换与拖高、安装包离线运行。

## 8. 里程碑状态

- M0 脚手架 ✅ ｜ M1 核心壳 ✅（含自愈）｜ M2 桥接与原生集成 ✅（事件链路+单测）
- M3 打包 ✅：setup-runtime（tar.gz 自包含运行时）+ electron-builder NSIS；干净首启验证通过（profile 创建、bridge 同步、运行时解压、从解压运行时 spawn、UI 加载）
- M4 全部完成 ✅：
  - **全局快捷键**：默认 `CommandOrControl+Shift+Space` 唤出窗口（settings.json 可改）；实测：最小化 → 发键 → 窗口恢复
  - **dsh:// 深链**：`dsh://`（聚焦）、`dsh://new`（新建会话）、`dsh://session/<id>`（打开会话——bridge `session.resolve` 解析标题 → 展开折叠区 → 侧边栏点击）；热启动与冷启动均实测
  - **自动更新**：electron-updater + generic feed（`electron-builder.yml` publish + `DSH_DESKTOP_UPDATE_URL` 运行时覆盖）；启动 15s 自动检查、托盘手动检查、30s 超时保护、下载完成通知点击即装；实测本地 feed 全链路（发现 9.9.9 → 差分回退全量 → 100% → 就绪事件）
- M4 过程中的修复（实测发现）：
  - 单实例锁失败改用 `app.exit(0)`（`app.quit()` 会让 main() 半途执行）
  - 协议注册用 `app.getAppPath()` 而非 `argv[1]`（dev 启动参数会占用 argv[1]）
  - `proxy-bypass-list` 加入 127.0.0.1（系统代理会劫持本地更新请求）
  - dev-link 把打包版同步的旧 bridge 副本替换为 junction
  - bridge 0.1.0 → 0.2.0（新增 `sessions.list` / `session.resolve` RPC），app 0.1.0 → 0.2.0
- M5 全部完成 ✅（bridge 0.2.0 → 0.3.0，app 0.2.0 → 0.3.0）：
  - **右栏仪表盘**（D11/D12）：注入式，三源数据（bridge 快照+事件 / stdout 活动流 / DOM 兜底），令牌级主题跟随，可折叠/拖宽，会话行复用深链，审批闪烁
  - **底栏终端**（D13）：xterm.js lazy 注入 + PipeBackend（PowerShell/cmd/pwsh），Ctrl+C 复位，独立于 harness 生命周期
  - 窗口内快捷键（Ctrl+Shift+` 终端 / Ctrl+Shift+. 仪表盘，可配置）；托盘面板开关
  - **dev 与已安装版 userData 隔离**（D14，实测已安装版运行中 dev 直接退出的根治）
- M5 过程中的修复（实测发现）：
  - 面板 DOM 必须挂 `document.body`（`--dsw-alias-*` 令牌定义在 body，挂 html 下不继承——主题跟随失效）
  - 活动流基线：面板 `hello` 时主进程补发日志全量（sync 批），避免订阅前日志丢失
  - 面板注入从自定义协议改为直接注入（D11：dev 渲染层 `ERR_UNKNOWN_URL_SCHEME`）
  - `#root` padding 让位触发 harness 响应式折叠（左侧自动缩成 rail）→ 改 overlay（D15）
  - e2e-turn 判定改 `#root` 文本（面板 DOM 挂在 body 末尾会污染 `body.innerText` 尾部窗口）
  - 终端 `onTermData` 回流订阅在重构中误删（shell 输出到主进程后无人写入 xterm）——探针定位恢复
  - 终端 ✕ 关闭后再开面板不重开会话 → `sessionDead` 标记 + layout 订阅自动重开
  - 面板 boot 晚于 dom-ready 推送 → `hello` 补发 state/layout/日志全量基线

## 9. 已知限制与后续

- `jobs.list` 逐会话聚合在会话数多时 O(n)；后续可改为监听 `session/jobs` 帧或注册表扩展。
- `dsh://session/<id>` 依赖侧边栏渲染该会话（当前工作区可见的会话）；未分组/其他工作区的会话只聚焦窗口。
- 通知/徽标仅在任务事件到达时更新；harness 不在前台时任务列表为启动时快照（服务端持久化，重启后恢复）。
- 面板 DOM 兜底为近似统计（`[data-state]` 可能被其他组件复用），仅作桥接离线时的参考；选择器按 harness 0.1.0-rc.6 校准，升级需复查。
- 上下文环/会话指标依赖 harness 上下文按钮与 stats 行的 DOM 文案；harness 改文案时解析器容错显示「—」，需按新格式校准（stats.ts 集中）。
- 费用估算按官方定价表内置常量（2026-08-13 抓取；2026-08-16 峰谷价已含）；调价后需更新 `pricing.ts`；请求数以步骤数近似（harness 未暴露请求计数）。
- 管道终端无 TTY：vim/top/ssh 等交互程序不可用；Ctrl+C 为会话复位（非信号中断）；pty 后端需本机构建（D13）；「⧉」可开独立窗口完整终端。
- 窗口内快捷键依赖键盘布局（`Ctrl+Shift+\`` / `Ctrl+Shift+.` 在部分布局下不同），可在 settings 调整。
- macOS/Linux 未实机验证（配置就绪；终端壳解析已覆盖 bash/zsh/pwsh）。
- harness 版本锁定 0.1.0-rc.6；升级需重跑 setup-runtime.mjs 并同步 bridge 版本。
- 自动更新源默认占位 URL（`.invalid` 保留域名）；正式部署需覆盖（构建时 `--config.publish.url=` 或运行时 `DSH_DESKTOP_UPDATE_URL`）并上传 `latest.yml` + 安装包。
- 更新安装依赖 NSIS 安装器（`quitAndInstall` 静默执行）；`oneClick: false` 下更新流程已验证到"就绪"事件，安装动作留待真实发布后人工确认。
