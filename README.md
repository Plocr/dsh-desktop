# DSH Desktop

以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 为基底的**桌面工作台**：Electron 原生壳 + 内嵌 harness 运行时。

设计文档：[docs/DESIGN.md](docs/DESIGN.md)

## 架构（0.4.1）

**壳只保留桌面原生能力**（窗口、托盘、启动 harness、加载 Web UI、深链、全局快捷键、自动更新、系统通知/任务栏徽标），加载官方 Web UI（会话、工作区、插件、设置）。壳与 harness 之间仅通过一个桥接插件通信——不再注入任何 UI、不持有任何面板代码。

```
Electron 壳 ──spawn──▶ dsh --profile desktop --patch <overlay> --port 0
    │  ▲                     │  ▲
    │  │ stdout 行解析        │  │ dsh-desktop-bridge 插件（通知/徽标/深链/工作区注册）
    │  └── dsh web: http://127.0.0.1:<port>
    └── bridge WS ───────────┘
```

| 插件 | 职责 |
|---|---|
| `dsh-desktop-bridge` | 本地 WS（token）+ 事件推送（jobs/approval → 通知/徽标）+ RPC（session.resolve/workspace.register/runtime.info/ping） |

## 能力一览

- 🪟 原生窗口加载 harness Web UI（`--port 0`，无端口冲突）
- 🐋 启动/重启加载页：粒子鲸鱼动画
- 🧩 专用 `desktop` profile（`$DSH_HOME/profiles/desktop`），会话与 Web/CLI 共享
- 🔌 `dsh-desktop-bridge` 桥接插件：后台任务/审批事件 → 系统通知与任务栏徽标
- ⌨️ 全局快捷键唤出（默认 `Ctrl+Shift+Space`，settings.json `globalShortcut` 可改）
- 🔗 `dsh://` 深链：`dsh://`（聚焦）、`dsh://new`（新建会话）、`dsh://session/<id>`（打开会话）
- ⬆️ 自动更新（electron-updater + generic feed；托盘「检查更新…」手动触发）
- 🗂️ 托盘：显示窗口 / 打开浏览器版 / 切换工作区 / 重启 Harness / 查看日志 / 开机自启 / 通知开关
- 🛡️ 崩溃自愈（指数退避重启）、优雅停机、单实例锁、导航锁与 sandbox
- 📦 自包含打包：便携 Node + npm 安装的 dsh 树，离线免装 Node/全局 dsh

## 开发

```sh
npm install                      # electron/esbuild/typescript/ws
npm run dev                      # build + dev-link（bridge 链接）+ 启动 Electron
```

dev 模式依赖全局 `@deepseek-ai/dsh`（或设置 `DSH_DESKTOP_DSH_BIN` 指向 `lib/bin.js`）；`npm run dev` 会把 bridge 以 junction 链接进 `~/.dsh/profiles/desktop/node_modules`。

常用脚本：

```sh
npm test                 # 事件逻辑单测（node --test）
npm run build            # esbuild 构建 + bridge → resources/plugins
npm run make:icons       # 生成应用图标（纯 JS）
npm run setup:runtime    # 构建自包含运行时 resources/dsh-runtime
npm run dist:win         # Windows NSIS 安装包（release/）
npm run dist:win:portable
```

## 打包

1. `npm run build && npm run make:icons`
2. `npm run setup:runtime`（下载便携 Node、`npm install @deepseek-ai/dsh@0.1.0-rc.6`、安装 bridge、打包 `resources/dsh-runtime.tar.gz`）
3. `npm run dist:win`（electron-builder NSIS；`electronDist` 复用本地 Electron 二进制）

安装后首次运行：自动创建 `~/.dsh/profiles/desktop` 并同步 bridge；运行时 tar.gz 解压到 `%LOCALAPPDATA%/DSH Desktop/runtime`（约 40s，二次启动免解压）；窗口内选择工作区即可开始会话。

## 版本锁定

harness 运行时锁定 `0.1.0-rc.6`（`DSH_RUNTIME_DSH_VERSION` 可改）；升级后请重跑 `setup-runtime.mjs` 并同步 bridge 版本。

## License

MIT
