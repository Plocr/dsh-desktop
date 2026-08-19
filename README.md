# DSH Desktop

以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 为基底的**桌面工作台**：Electron 原生壳 + 内嵌 harness 运行时，离线、免安装 Node、免全局 dsh 即可使用。

## 设计架构

**壳只保留桌面原生能力**（窗口、托盘、启动 harness、加载 Web UI、深链、全局快捷键、自动更新、系统通知/任务栏徽标），加载官方 Web UI（会话、工作区、插件、设置）。壳与 harness 之间仅通过一个桥接插件通信——不注入任何 UI、不持有任何面板代码。

```
Electron 壳 ──spawn──▶ dsh --profile desktop --patch <overlay> --port 0
    │  ▲                     │  ▲
    │  │ stdout 行解析        │  │ dsh-desktop-bridge 插件（通知/徽标/深链/工作区注册）
    │  └── dsh web: http://127.0.0.1:<port>
    └── bridge WS ───────────┘
```

- 🪟 原生窗口加载官方 Web UI（`--port 0`，无端口冲突）
- 🧩 专用 `desktop` profile（`$DSH_HOME/profiles/desktop`），会话与 Web/CLI 共享
- 🔌 `dsh-desktop-bridge` 桥接插件：后台任务/审批事件 → 系统通知与任务栏徽标
- ⌨️ 全局快捷键唤出（默认 `Ctrl+Shift+Space`）
- 🔗 `dsh://` 深链：`dsh://`（聚焦）、`dsh://new`（新建会话）、`dsh://session/<id>`（打开会话）
- ⬆️ 自动更新、🗂️ 托盘常驻、🛡️ 崩溃自愈、📦 自包含打包

## 功能截图

| 加载页面 | 主界面 |
|---|---|
| ![加载页面](docs/screenshots/加载页面.png) | ![主界面](docs/screenshots/主界面.png) |

| 托盘菜单 |
|---|
| ![托盘菜单](docs/screenshots/后台管理.png) |

## 安装

1. 从 [Releases](https://github.com/Plocr/dsh-desktop/releases) 下载最新安装包（Windows：`DSH.Desktop-x.x.x-setup.exe`）
2. 双击运行，按向导完成安装（可选择安装目录）
3. 首次启动会自动解压内置运行时（约 40 秒，二次启动免解压），并创建桌面 profile

> 安装包自包含：内置便携 Node 与 dsh 运行时，**无需**预先安装 Node.js 或全局 dsh。

## 使用

- **开始会话**：启动后在窗口内选择工作区，即可开始对话
- **全局唤出**：任意界面按 `Ctrl+Shift+Space` 呼出/隐藏窗口
- **深链**：浏览器或其他应用点击 `dsh://` 链接可唤起并打开对应会话
- **托盘**：关闭窗口默认最小化到托盘；右键托盘图标可切换工作区、重启 Harness、查看日志、检查更新、开机自启、开关通知
- **会话共享**：桌面版默认使用**独立数据目录**（`%LOCALAPPDATA%/DSH Desktop/dsh-home`），并与 Web/CLI 并存互不冲突；首次启动会自动把旧的 `~/.dsh` 迁移过去，原数据保留。

## 更新机制

两条独立链路，互不干扰。（术语：**框架** = DSH Desktop 本体；**官方 Harness** = DeepSeek Harness @deepseek-ai/dsh）

1. **框架（DSH Desktop 自身）** —— `src/main/updater.ts`
   - 源：GitHub Releases（[Plocr/dsh-desktop](https://github.com/Plocr/dsh-desktop/releases)）
   - **本地下载不跳浏览器**：electron-updater `autoDownload`，下载进度走任务栏进度条，退出时自动安装
   - 通知内附两个下载地址：GitHub 官方地址 + **免费加速代理地址**（默认 `ghfast.top`，可用环境变量 `DSH_DESKTOP_GH_PROXY` 覆盖）

2. **官方 Harness（DeepSeek Harness 本体）** —— `src/main/harnessCheck.ts` + `harnessUpdate.ts`
   - 源：npm registry（官方失败回退 **npmmirror 镜像**；包很小，仅几十 KB）
   - **检测不再依赖 `latest` dist-tag**（官方可能忘打 tag：rc.8 已发而 latest 指 rc.7）——枚举全部已发布版本取最大 semver
   - 发现新版 → 右上角小卡片（**进度条 + 下载地址**，可关闭、不挡操作）→ 下载 tgz → 原子替换 `%LOCALAPPDATA%/DSH Desktop/runtime` 里的 dsh 包（含回滚）→ 写用户自更新标记 → 重启 harness 生效
   - 用户自更新后的运行时不会被安装包重复覆盖，除非安装包内嵌的 dsh 版本更新

**入口只有两个（托盘 → 设置）：**
- `自动更新（框架 v… · 官方 Harness v…）`（开关，默认开）：冷启动自动检查一次（框架 15s 下载 + 官方 Harness 30s 本地替换）；关闭则仅手动
- `检查并更新…`（动作）：同时查框架 + 官方 Harness，有新版自动本地下载/替换（不跳浏览器）

> Why npm not GitHub tags：deepseek-harness 通过 npm 分发（GitHub 只有源码 tags，无构建产物），所以「官方 Harness 最新」为 npm 已发布版本的最大 semver。


## 平台支持

- **Windows**（主平台，实测）：NSIS 安装包、托盘、系统通知、任务栏徽标、开机自启、`dsh://` 深链
- **macOS**（配置就绪）：dmg（arm64/x64）、`dsh://` 深链、运行时路径走 `~/Library/Application Support`
- **Linux**：代码兼容，未提供安装包

## License

MIT
