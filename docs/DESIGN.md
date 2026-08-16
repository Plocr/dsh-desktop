# DSH Desktop — DeepSeek Harness 桌面工作台 设计文档

版本：0.4.1 ｜ 状态：已实现（壳精简，仅 bridge 插件） ｜ 平台：Windows 优先（macOS/Linux 配置就绪）

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
│   ├─ HarnessManager：spawn/监控/重启 `dsh --profile desktop --patch <overlay>`   │
│   ├─ 逐行解析 stdout：`dsh web:` URL 行 + `dsh desktop:` 桥接行                   │
│   ├─ BridgeClient：本地 WebSocket（127.0.0.1 随机端口 + 一次性 token）            │
│   ├─ Tray / 通知 / 徽标 / 原生对话框 / 单实例锁 / 开机自启 / 日志                  │
│   └─ Preload（contextBridge 白名单，仅壳页面）                                    │
│  BrowserWindow（sandbox + contextIsolation + 固定分区） ← 加载 harness Web UI    │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │ spawn（cwd = 工作区，DSH_HOME 显式注入）
┌───────────────────────────────▼──────────────────────────────────────────────────┐
│  Harness 子进程（独立 Node 运行时）                                               │
│   $DSH_HOME/profiles/desktop = dsh-base + dsh-web-app + bridge（overlay 注入）    │
│   ├─ 全部原生能力：会话/工具/沙箱/审批/设置/插件                                   │
│   └─ dsh-desktop-bridge（host 插件）：本地 WS 事件推送 + RPC                       │
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
| D10 | 运行时以 **tar.gz 随包分发，首启解压到 %LOCALAPPDATA%/DSH Desktop/runtime**（版本标记校验，二次启动免解压） | electron-builder 会剔除 extraResources 中的 node_modules（实测）；顺带避免 Program Files 只读问题 |
| D7 | 渲染安全基线 | contextIsolation、sandbox、导航锁、外链校验 |
| D8 | 关闭窗口默认最小化到托盘；优雅停机（SIGTERM→5s→SIGKILL）；意外退出指数退避重启（1s..30s） | 桌面工作台常驻体验 |
| D9 | bridge 插件**自包含**（vendored ws，无运行时依赖），prod 首启由壳复制进 profile node_modules | overlay `name:` 行从 profile 目录解析；离线可用 |
| D25 | **壳只保留桌面原生能力；不内置任何注入式 UI 插件** | 仪表盘/终端/主题等 UI 扩展不属桌面壳职责；需要时以 harness 插件（`dsh.client` 双面包）形式由 profile overlay 按需加载，壳与 harness 内核保持最小接触面（仅 bridge） |

## 3. 关键事实（实测确认）

1. **patch 语法**：`cordis.patch.yml` 是顶层 YAML 数组：`- id: X, config:` 覆盖整行、`disabled: true` 禁用、`- insert: [{id, name, config}]` 插入新行。
2. **解析位置**：bundle 行从 dsh 安装目录解析；**overlay/用户 `name:` 行从 profile 目录解析**（实测错误 `Cannot find package 'dsh-desktop-bridge' imported from ...\profiles\desktop\`）。→ 插件必须装入 profile 的 node_modules。
3. **Loader 安定**：`ctx.get('loader')?.await()` 返回树安定 Promise；`jobs` 服务在 apply 阶段尚不可见，**必须在安定后接线**。
4. **jobs 是 owner 相对的**：`jobs.list(caller)` 只返回该 caller 会话的任务；宿主侧跨会话计数须逐会话传 `ctx.agents.get(session.id)` 聚合。
5. `--port 0` 官方支持；`--host 0.0.0.0` 被拒绝。
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

### 4.2 dsh-desktop-bridge（packages/bridge，纯 JS ESM，host 插件）

- `WebSocketServer({host:'127.0.0.1', port:0})`；首条消息必须 `{type:'auth', token}`，否则关闭（4001）。
- 事件推送（最小字段，绝不序列化 live 对象）：
  - `jobs.changed`：`{jobs:[{id,kind,label,status,ownerSession}]}` —— `onJobsChanged` + 逐会话聚合；
  - `job.done`：`{job:{...}}` —— `onJobDone`（快照含 label/kind，通知可读）；
  - `approval.asked`：`{sessionId}` —— 从 `session/event` 过滤。
- RPC：`ping` / `runtime.info`（pid/DSH_HOME/cwd/node/workspaces）/ `workspace.register {path}`（走 `workspaceRegistry.create`，幂等）/ `session.resolve {id}`（深链用，live 优先、持久化 inspect 兜底）。
- 发现行：Loader 安定后 `console.log('dsh desktop: ' + JSON.stringify({port, token}))`。
- 全部副作用可逆：disposer + `ctx.on('dispose')`；ws 为 vendored 副本（`vendor/ws`，零依赖）。
- 防御性：所有外部读取经 `safe()` 包装，单个事件异常不拖垮 harness。

### 4.3 Electron 壳（src/main）

| 模块 | 职责 |
|---|---|
| `index.ts` | 主流程：单实例 → 设置/日志 → 确保 profile（同步 bridge）→ 运行时定位 → overlay → 窗口/托盘 → spawn harness → 桥接（通知/徽标/深链）→ 全局快捷键/自动更新 |
| `harness.ts` | spawn/监控/重启；解析 `dsh web:` / `dsh desktop:` 行；指数退避重启；优雅停机 |
| `bridge.ts` | WS 客户端（token 握手、事件、RPC、断线重连） |
| `window.ts` | BrowserWindow + loading/error 过渡页 + 导航锁 |
| `tray.ts` | 显示窗口/浏览器版/切换工作区/重启 Harness/日志/更新/自启/通知/退出 |
| `notify.ts` | 系统通知 + `app.setBadgeCount` 徽标 |
| `deepLink.ts` | dsh:// 深链解析（focus/new/session） |
| `shortcut.ts` | 全局快捷键唤出（settings 可配，空串禁用） |
| `updater.ts` | electron-updater + generic feed（启动自动检查、托盘手动） |
| `runtime.ts` | 运行时定位、profile 确保（bridge 同步）、overlay 生成 |
| `logger.ts` | 环形日志落盘（5MB 轮转） |
| `settings.ts` | 壳偏好（trayOnClose/notifications/autoStart/isolatedHome/recentWorkspaces/globalShortcut/autoUpdate） |
| `ipc.ts` / `preload` | 壳页面白名单（pickWorkspace/revealInFolder/openExternal/restartHarness/openLogs/getInfo） |

### 4.4 加载页：粒子鲸鱼动画（shell-pages/loading.html）

启动/重启/崩溃恢复时的过渡页（白底 + 粒子鲸鱼，自研实现）。**随壳分发**（harness 未启动时展示，无法是插件）。

### 4.5 构建与分发

- `scripts/build.mjs`：main/preload（esbuild CJS）+ bridge 包复制到 `resources/plugins/bridge`（随 asar 分发）。
- `scripts/dev-link.mjs`：bridge junction 链接进 profile node_modules（dev 始终加载仓库源码）。
- `scripts/setup-runtime.mjs`：便携 Node + `npm install @deepseek-ai/dsh` + bridge → `resources/dsh-runtime.tar.gz`。

## 5. 数据流

1. **启动**：单实例锁 → 设置/日志 → 确保 profile（同步 bridge）→ 定位运行时 → overlay → 窗口（loading 页）→ `harness.start()` → 解析 URL/桥接行 → 加载 Web UI → bridge 连接（自检 ping + 深链排队处理）。
2. **事件**：任务注册/完成/审批 → bridge WS → 徽标/系统通知（点击聚焦窗口）。
3. **退出**：托盘退出 → SIGTERM → 5s → SIGKILL → `app.exit(0)`；窗口关闭默认 hide（托盘常驻）。
4. **崩溃**：harness 退出非 0 → 指数退避重启 → 窗口"正在重启" → 就绪后自动重载。

## 6. 安全边界

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；`will-navigate`/`setWindowOpenHandler` 只放行 `http://127.0.0.1:*` 与壳页面；外链经 `shell.openExternal` 校验。
- 桥接：仅 127.0.0.1；每次启动新 token（overlay 注入，插件 config 校验）；WS 首包必须鉴权。
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

- `jobs.list` 逐会话聚合在会话数多时 O(n)；后续可改为监听 `session/jobs` 帧或注册表扩展。
- `dsh://session/<id>` 依赖侧边栏渲染该会话（当前工作区可见的会话）；未分组/其他工作区的会话只聚焦窗口。
- 通知/徽标仅在任务事件到达时更新；harness 不在前台时任务列表为启动时快照（服务端持久化，重启后恢复）。
- **macOS**：dmg 打包（arm64/x64）、`dsh://` 深链（Info.plist protocols + open-url 事件 + 冷启动队列）、运行时路径走 `~/Library/Application Support` 已配置；**未实机验证**（打包须在 macOS 上执行 `npm run dist:mac`，且运行时 tar.gz 需在 mac 上重建）。
- **Linux**：代码兼容（运行时路径走 `$XDG_DATA_HOME`），未提供打包配置。
- harness 版本锁定 0.1.0-rc.6；升级需重跑 setup-runtime.mjs 并同步 bridge 版本。
- **两层更新机制**：
  - 第 1 层·桌面端（`src/main/updater.ts`）：electron-updater + GitHub provider，更新源 = 本仓库 `Plocr/dsh-desktop` 的 GitHub Releases（`publish` 已配 `provider: github`）。有新版即下载对应平台安装包并替换。
  - 第 2 层·官方 harness（`src/main/harnessCheck.ts`）：查 npm registry 的 `@deepseek-ai/dsh` latest dist-tag，对比随包 `runtime.version` 里的 `dsh=` 版本；**只提示有新版，不自动替换**（官方发版机制未定，避免破坏运行时）。官方无 Release、靠 npx/源码分发，故以 npm 为准。
  - 两层独立，互不冲突：桌面端不更新也能感知官方 harness 有新版本。
- **macOS 多架构自动更新**：arm64 与 x64 运行时 tar.gz 各自平台生成，CI 分两个 job 各产一个 dmg（含各自 `.blockmap`）。electron-updater 的 GitHub provider 读取单一 `latest-mac.yml`，按其 `files[]` 中 url 是否含 `process.arch` 挑选 dmg——因此由独立的 `merge-mac-manifest` job（`scripts/merge-mac-manifest.mjs`）把两份 dmg 的 url/sha512/size 合并为一份 `latest-mac.yml` 上传，两个架构的用户都能应用内更新。
- 更新安装依赖 NSIS 安装器（`quitAndInstall` 静默执行）；`oneClick: false` 下更新流程已验证到"就绪"事件，安装动作留待真实发布后人工确认。
- 如需仪表盘/终端/主题等扩展，以 harness 插件（`dsh.client` 双面包，`/plugins/<id>/client.js` 协议）按需开发，经 profile overlay 加载——壳不内置。
