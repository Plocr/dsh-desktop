# DSH Desktop

以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 为基底的**桌面工作台**：Electron 原生壳 + 内嵌 harness 运行时，完整复用官方 Web UI（会话、工作区、插件、设置），叠加托盘常驻、系统通知、任务栏徽标、原生目录选择、崩溃自愈与离线安装包。

设计文档：[docs/DESIGN.md](docs/DESIGN.md)

## 能力一览

- 🪟 原生窗口加载 harness Web UI（`--port 0`，无端口冲突）
- 🐋 启动/重启加载页：官网同款**粒子鲸鱼**动画（SVG 像素采样 + 弹性粒子 + 光晕层）
- 📊 **右栏仪表盘**（注入式，零改动 harness）：运行时/桥接状态、任务、会话、审批、活动流（stdout 解析）实时视图；三源数据（bridge WS 主、stdout 流次、DOM 兜底）
- ⌨️ **底栏嵌入终端**（PowerShell/cmd/pwsh）：xterm.js + 管道后端（零原生依赖，离线可用）；可选 pty 后端（`DSH_DESKTOP_TERM=pty`，需本机为 Electron ABI 构建 node-pty）
- 🧩 专用 `desktop` profile（`$DSH_HOME/profiles/desktop`），会话与 Web/CLI 共享
- 🔌 `dsh-desktop-bridge` 桥接插件：后台任务/审批事件 → 系统通知与任务栏徽标
- ⌨️ 全局快捷键唤出（默认 `Ctrl+Shift+Space`，settings.json `globalShortcut` 可改）
- 🔗 `dsh://` 深链：`dsh://`（聚焦）、`dsh://new`（新建会话）、`dsh://session/<id>`（打开会话）
- ⬆️ 自动更新（electron-updater + generic feed；托盘「检查更新…」手动触发）
- 🗂️ 托盘：显示窗口 / 打开浏览器版 / 切换工作区 / 重启 Harness / 查看日志 / 仪表盘与终端开关 / 开机自启 / 通知开关
- 🛡️ 崩溃自愈（指数退避重启）、优雅停机、单实例锁、导航锁与 sandbox
- 📦 自包含打包：便携 Node + npm 安装的 dsh 树，离线免装 Node/全局 dsh

## 开发

```sh
npm install                      # electron/esbuild/typescript/ws
npm run dev                      # build + 链接 bridge + 启动 Electron（复用全局 dsh 与 ~/.dsh）
```

dev 模式依赖全局 `@deepseek-ai/dsh`（或设置 `DSH_DESKTOP_DSH_BIN` 指向 `lib/bin.js`）；`npm run dev` 会自动把 bridge 以 junction 链接进 `~/.dsh/profiles/desktop/node_modules`。

常用脚本：

```sh
npm test                 # 事件逻辑单测（node --test）
npm run build            # esbuild 构建 + bridge 复制到 resources/bridge
npm run make:icons       # 生成应用图标（纯 JS）
npm run setup:runtime    # 构建自包含运行时 resources/dsh-runtime
npm run dist:win         # Windows NSIS 安装包（release/）
npm run dist:win:portable
```

E2E（需带调试端口启动）：

```sh
$env:DSH_DESKTOP_ELECTRON_ARGS = '--remote-debugging-port=9222'
npm run dev
node scripts/e2e-turn.mjs "一句话介绍你自己"
```

## 架构速览

```
Electron 壳 ──spawn──▶ dsh --profile desktop --patch <overlay> --port 0
    │  ▲                     │  ▲
    │  │ stdout 行解析        │  │ dsh-desktop-bridge 插件
    │  └── dsh web: http://127.0.0.1:<port>          （WS 随机端口 + token）
    └── dsh desktop: {"port":N,"token":…} ──► BridgeClient（事件/RPC）
```

详见 [docs/DESIGN.md](docs/DESIGN.md)（含 ADR、实测事实、验收记录）。

## 深链与快捷键

- 全局唤出：`Ctrl+Shift+Space`（默认；`userData/settings.json` 的 `globalShortcut` 可改，空串禁用）
- 窗口内快捷键（仅 harness 页生效，`panelShortcuts` 可改，非全局）：
  - `Ctrl+Shift+\`` — 显示/隐藏底栏终端
  - `Ctrl+Shift+.` — 显示/隐藏右栏仪表盘
- 深链：
  - `dsh://` / `dsh://focus` — 聚焦窗口
  - `dsh://new` — 聚焦并进入新会话
  - `dsh://session/<id>` — 聚焦并尽力打开该会话（依赖侧边栏渲染；未分组会话仅聚焦）
- 注册表项在应用启动时自动注册（Windows），`dsh://` 链接可从任意应用点击唤起

## 仪表盘与终端

- **右栏仪表盘**：注入到 harness Web UI（不改动其源码），复用 harness 的 `--dsw-alias-*` 设计令牌（浅色/深色/跟随系统三态自动跟随）。数据三源：
  - bridge（主）：`dashboard.snapshot` RPC 全量 + `jobs.changed / job.done / approval.asked` 事件增量；
  - harness stdout（次）：启动/运行日志流 → 「活动流」面板（环形缓冲 300 行）；
  - DOM 探测（兜底）：桥接离线时统计侧边栏会话数/任务状态并标注「桥接离线」。
- **底栏终端**：xterm.js + 管道后端（PowerShell/cmd/pwsh 可选 tab）。管道模式无 TTY（vim/top 等交互程序不可用，Ctrl+C 为会话复位）；如需完整 TTY，设置环境变量 `DSH_DESKTOP_TERM=pty` 并在本机为 Electron ABI 构建 `node-pty`（预编译包仅覆盖 Node ABI，`npmRebuild: false` 不会自动重编）。
- 面板资产随包分发（`resources/panel-dist`），主进程直接注入（`insertCSS` + `executeJavaScript`），不引入自定义协议。
- dev 模式使用独立 userData（`%APPDATA%/dsh-desktop-dev`），与已安装版可并行运行（单实例锁隔离）。

## 自动更新

- 更新源：打包时 `electron-builder.yml` 的 `publish`（generic url）写入 `app-update.yml`；运行时可用环境变量 `DSH_DESKTOP_UPDATE_URL` 覆盖
- 行为：启动 15s 后自动检查（`autoUpdate` 设置可关）；发现更新后台下载；完成通知点击即退出安装；托盘「检查更新…」手动触发（30s 超时保护）
- 发布流程：`npx electron-builder --win nsis --publish never` 产物 + `release/latest.yml` 一起上传到更新源；正式部署时用 `--config.publish.url=https://你的服务器/` 覆盖占位地址（`updates.dsh-desktop.invalid`）

## 打包

1. `npm run build && npm run make:icons`
2. `npm run setup:runtime`（下载便携 Node、`npm install @deepseek-ai/dsh@0.1.0-rc.6`、安装 bridge、打包 `resources/dsh-runtime.tar.gz`）
3. `npm run dist:win`（electron-builder NSIS；`electronDist` 复用本地 Electron 二进制）

安装后首次运行：自动创建 `~/.dsh/profiles/desktop` 并同步 bridge；运行时 tar.gz 解压到 `%LOCALAPPDATA%/DSH Desktop/runtime`（约 40s，二次启动免解压）；窗口内选择工作区即可开始会话。electron-builder 会剔除 extraResources 中的 node_modules，故运行时必须以归档形式随包分发（见 DESIGN.md D10）。

## 版本锁定

harness 运行时锁定 `0.1.0-rc.6`（`DSH_RUNTIME_DSH_VERSION` 可改）；升级后请重跑 `setup-runtime.mjs` 并同步 bridge 版本。

## License

MIT
