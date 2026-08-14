# DSH Desktop — DeepSeek Harness 桌面工作台 设计文档

版本：0.1.0 ｜ 状态：已实现（M0–M3） ｜ 平台：Windows 优先（macOS/Linux 配置就绪）

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
| `tray.ts` | 显示窗口/浏览器版/切换工作区/重启 Harness/查看日志/开机自启/通知开关/退出 |
| `notify.ts` | 系统通知 + `app.setBadgeCount` 徽标 |
| `ipc.ts` | 壳页面白名单（pickWorkspace/revealInFolder/openExternal/restartHarness/openLogs/getInfo） |
| `settings.ts` | `userData/settings.json`：trayOnClose/notifications/autoStart/isolatedHome/recentWorkspaces |
| `bridgeEvents.ts` | 事件→动作纯逻辑（可单测） |
| `runtime.ts` | 运行时定位、profile 确保、overlay 生成、bridge 同步 |
| `logger.ts` | 环形日志落盘（5MB 轮转） |

### 4.4 数据流

1. **启动**：单实例锁 → 设置/日志 → token+overlay → 确保 profile/bridge → 定位运行时 → 建窗口（loading 页）→ `harness.start()` → 解析 `dsh web:`/`dsh desktop:` → `loadURL` → bridge 连接（自检 ping）→ 工作区注册（若刚切换）。
2. **使用**：窗口内即官方 Web UI，零改动。
3. **事件**：任务注册/完成/审批 → bridge WS → 徽标/系统通知 → 点击聚焦窗口。
4. **退出**：托盘退出 → SIGTERM → 等 5s → SIGKILL → `app.exit(0)`；窗口关闭默认 hide（托盘常驻）。
5. **崩溃**：harness 退出非 0 → 清 ready → 1s/2s/4s…（上限 30s）重启 → 窗口显示"正在重启" → 就绪后自动重载。

## 5. 项目结构

```
dsh-desktop/
├─ package.json / tsconfig.json / electron-builder.yml
├─ scripts/
│  ├─ dev.mjs            # build + dev-link + electron .
│  ├─ build.mjs          # esbuild main/preload + bridge → resources/bridge
│  ├─ dev-link.mjs       # junction: profile node_modules ← packages/bridge（仅 dev）
│  ├─ make-icons.mjs     # 纯 JS PNG/ICO 图标生成（品牌蓝 + "H"）
│  ├─ setup-runtime.mjs  # 便携 Node + npm install dsh → resources/dsh-runtime
│  ├─ cdp.mjs            # CDP 调试辅助（探查页面）
│  └─ e2e-turn.mjs       # CDP E2E：驱动真实 agent 轮次
├─ src/main/             # 壳主进程
├─ src/preload/          # contextBridge 白名单
├─ packages/bridge/      # dsh-desktop-bridge 插件（lib + vendor/ws）
├─ resources/
│  ├─ profile-template/desktop/
│  ├─ shell-pages/       # loading/error 过渡页
│  ├─ bridge/            # build 产物（随 asar 分发）
│  ├─ icons/             # 生成产物
│  └─ dsh-runtime/       # setup-runtime 产物（自包含运行时）
├─ test/bridge-events.test.mjs   # 事件逻辑单测（node --test）
├─ docs/DESIGN.md        # 本文档
└─ README.md
```

## 6. 安全边界

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；`will-navigate`/`setWindowOpenHandler` 只放行 `http://127.0.0.1:*` 与壳页面；外链经 `shell.openExternal` 校验。
- 桥接：仅 127.0.0.1；每次启动新 token（overlay 注入，插件 config 校验）；WS 首包必须鉴权。
- 壳不读取、不落盘会话内容；仅记录 harness stdout/stderr 与自身事件。
- bridge 插件零外部依赖（vendored ws），随包分发，无供应链新增面。

## 7. 测试与验收

自动化（`npm test`，node:test）：runningJobCount、通知开关、徽标更新、approval、畸形 payload。
E2E（`scripts/e2e-turn.mjs`，需 `DSH_DESKTOP_ELECTRON_ARGS=--remote-debugging-port=9222`）：

| 项 | 结果 |
|---|---|
| 窗口加载官方 UI（标题 DeepSeek Harness，共享会话列表可见） | ✅ |
| 真实 agent 轮次（输入→提交→模型回复+轮次统计） | ✅ 首 token 2.7s、107 tok/s |
| 后台任务（run_in_background → pwsh-1 → 完成） | ✅ |
| 桥接事件链（jobs.changed running→completed / job.done 达壳） | ✅ |
| 崩溃自愈（强杀 harness → 1s 内重启 → 新端口 → 重连） | ✅ |
| 桥接 RPC 自检（ping） | ✅ |

手动清单（需人眼）：系统通知弹窗、任务栏徽标数字、托盘菜单交互、开机自启、窗口关闭最小化、切换工作区原生对话框、安装包离线运行。

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

## 9. 已知限制与后续

- `jobs.list` 逐会话聚合在会话数多时 O(n)；后续可改为监听 `session/jobs` 帧或注册表扩展。
- `dsh://session/<id>` 依赖侧边栏渲染该会话（当前工作区可见的会话）；未分组/其他工作区的会话只聚焦窗口。
- 通知/徽标仅在任务事件到达时更新；harness 不在前台时任务列表为启动时快照（服务端持久化，重启后恢复）。
- macOS/Linux 未实机验证（配置就绪）。
- harness 版本锁定 0.1.0-rc.6；升级需重跑 setup-runtime.mjs 并同步 bridge 版本。
- 自动更新源默认占位 URL（`.invalid` 保留域名）；正式部署需覆盖（构建时 `--config.publish.url=` 或运行时 `DSH_DESKTOP_UPDATE_URL`）并上传 `latest.yml` + 安装包。
- 更新安装依赖 NSIS 安装器（`quitAndInstall` 静默执行）；`oneClick: false` 下更新流程已验证到"就绪"事件，安装动作留待真实发布后人工确认。
