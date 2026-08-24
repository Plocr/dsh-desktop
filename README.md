# DSH Desktop

以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 为基底的**桌面工作台**：Electron 原生壳 + 内嵌 harness 运行时，离线、免安装 Node、免全局 dsh 即可使用。

> **自带视觉模型**：内置 `DeepSeek-V4-Flash-Vision-Exp`（`deepseek-v4-flash-vision-exp`），支持图片输入——直接把截图/图片拖进输入框，让模型看图说话、识别界面、分析图表。

---

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

---

## 功能截图

> 下列截图为干净示例环境所拍，无任何个人会话、路径或密钥信息。

### 主界面（会话工作台）

左侧工作区/会话树，右侧"探索未至之境"新会话入口。模型下拉可选择自身支持的能力——包括**视觉模型**（图片输入），输入框支持把图片直接拖入或点 `+` 添加。

| 主界面（新会话） |
|---|
| ![主界面](docs/screenshots/主界面.png) |

### 加载页面（首次启动解压运行时）

首次启动会自动解压内置运行时（约 40 秒，二次启动免解压），期间显示加载页。

| 加载页面 |
|---|
| ![加载页面](docs/screenshots/加载页面.png) |

### 托盘菜单

关闭窗口默认最小化到托盘；右键托盘图标可切换工作区、重启 Harness、查看日志、检查更新、开机自启、开关通知、查看全局快捷键。

| 托盘菜单 |
|---|
| ![托盘菜单](docs/screenshots/托盘菜单.png) |

---

## 模型与视觉能力

桌面版接入 DeepSeek 官方 API（`baseURL` 默认 `https://api.deepseek.com`，可配置），内置模型目录（`llm-deepseek` 适配器的 `DEFAULT_MODELS`）：

| 模型 ID | 名称 | 输入模态 | 说明 |
|---|---|---|---|
| `deepseek-v4-flash` | DeepSeek-V4-Flash | 文本 | 轻量、快速 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 文本 | 推理更充分 |
| `deepseek-v4-flash-vision-exp` | **DeepSeek-V4-Flash-Vision-Exp** | 文本 + 图片 | **视觉模型**，支持图片输入 |

### 使用视觉模型

1. 在输入框模型下拉切换到 `DeepSeek-V4-Flash-Vision-Exp`（或任意标注支持图片的模型）。
2. 把图片**拖入输入框**，或点 `+` 选择本地图片。
3. 发送后模型即可基于图片内容作答（识别界面、分析截图、读图表、生成图片描述等）。

> 若当前选中模型不支持图片，界面会提示"当前模型不支持图片，请切换支持图片的模型"——切换到视觉模型即可。

### 图片约束（视觉模型）

适配器对图片输入做了安全约束（超限会明确报错）：

| 约束 | 值 | 说明 |
|---|---|---|
| 单张图片大小 | ≤ 1 MB（`DEFAULT_REQUEST_IMAGE_MAX_BYTES`） | 超出提示"单张图片不能超过 {size}" |
| 图像像素预算 | ≤ 640,000 像素（`DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET`） | 超出提示"图片分辨率过大，请压缩后重试" |
| 每条消息图片数 | 有上限（各模型可配，界面提示"一条消息最多添加 {count} 张"） | — |
| 请求总体积 | ≤ 128 MB（`DEFAULT_MAX_REQUEST_FILES_BYTES`） | — |
| 支持格式 | PNG / JPG / WebP / GIF | 不支持的类型提示"仅支持 PNG、JPG、WebP、GIF" |

> 图片按"附加内容块"（attachment）经 harness 的图片预检（`inputModalities` 能力门控）后才进入请求；模型不支持图片时会在预检阶段直接拒绝，不消耗调用。

---

## 安装

1. 从 [Releases](https://github.com/Plocr/dsh-desktop/releases) 下载最新安装包（Windows：`DSH.Desktop-x.x.x-setup.exe`）
2. 双击运行，按向导完成安装（可选择安装目录）
3. 首次启动会自动解压内置运行时（约 40 秒，二次启动免解压），并创建桌面 profile

> 安装包自包含：内置便携 Node 与 dsh 运行时，**无需**预先安装 Node.js 或全局 dsh。

---

## 使用

- **开始会话**：启动后在窗口内选择工作区，即可开始对话
- **视觉模型**：模型下拉切换到 `DeepSeek-V4-Flash-Vision-Exp`，拖入图片即可看图对话（见上方"模型与视觉能力"）
- **全局唤出**：任意界面按 `Ctrl+Shift+Space` 呼出/隐藏窗口
- **深链**：浏览器或其他应用点击 `dsh://` 链接可唤起并打开对应会话
- **托盘**：关闭窗口默认最小化到托盘；右键托盘图标可切换工作区、重启 Harness、查看日志、检查更新、开机自启、开关通知
- **会话共享**：桌面版默认使用**独立数据目录**（`%LOCALAPPDATA%/DSH Desktop/dsh-home`），并与 Web/CLI 并存互不冲突；首次启动会自动把旧的 `~/.dsh` 迁移过去，原数据保留。
- **局域网访问**（托盘 → 设置 → 局域网访问）：不改 harness 监听（本机 `127.0.0.1` 始终可用），由壳起一个**局域网反向代理**（绑 `0.0.0.0:<随机端口>`，转发到本机 harness）并显示「局域网地址」。手机/其它设备首次访问该地址时，**电脑会弹授权框**（按设备 IP 记一次，本次运行有效）：允许才放行，拒绝返回 403。⚠️ 允许后该设备可在浏览器中操作本工作台（可读文件/执行命令），建议仅在可信网络使用，用毕关闭。

---

## 隐私说明

- **数据本地化**：会话、工作区、设置均保存在本机（默认 `%LOCALAPPDATA%/DSH Desktop/dsh-home` 下的独立数据目录），不与 Web/CLI 冲突，也不会自动上传。
- **API 凭据**：DeepSeek API Key 通过配置的凭据存储（或在环境变量 `DEEPSEEK_API_KEY`）提供给 harness，仅在发起模型请求时使用；桌面壳本身不保存密钥明文到会话。
- **网络边界**：默认仅回环监听（`127.0.0.1`）；局域网访问需显式开启（托盘 → 设置 → 局域网访问），且首次访问需本机授权。关闭后立即停止对外代理。
- **更新元数据**：更新检查只访问 npm registry / GitHub Releases 拉取版本与安装包，不包含你的会话内容。
- **截图示例**：本仓库 `docs/screenshots` 的界面截图为干净示例环境拍摄，经确认不含个人会话正文、本地路径或密钥。

---

## 更新机制

两条独立链路，互不干扰。（术语：**框架** = DSH Desktop 本体；**官方 Harness** = DeepSeek Harness @deepseek-ai/dsh）

1. **框架（DSH Desktop 自身）** —— `src/main/updater.ts`
   - 源：GitHub Releases（[Plocr/dsh-desktop](https://github.com/Plocr/dsh-desktop/releases)）
   - **本地下载，不跳浏览器**：electron-updater `autoDownload`；下载全程右上角卡片实时进度 + 任务栏进度条
   - **下载完成 → 点「安装更新并重启」按钮（或系统通知）→ 确认后退出并安装**，安装完自动重启。
     若下载完没点安装就退出，下次启动仍会重新提示（跨重启保留，不会丢）
   - 通知内附两个下载地址：GitHub 官方地址 + **免费加速代理地址**（默认 `ghfast.top`，可用环境变量 `DSH_DESKTOP_GH_PROXY` 覆盖）

2. **官方 Harness（DeepSeek Harness 本体）** —— `src/main/harnessCheck.ts` + `harnessUpdate.ts`
   - 源：npm registry（官方失败回退 **npmmirror 镜像**）
   - **检测不再依赖 `latest` dist-tag**（官方可能忘打 tag：rc.8 已发而 latest 指 rc.7）——枚举全部已发布版本取最大 semver
   - **整树刷新而非单包替换**：发现新版后在 `%LOCALAPPDATA%/DSH Desktop/runtime` 暂存目录用内置便携 Node 的 npm 安装 `@deepseek-ai/dsh@<新版>`（整棵 `@deepseek-ai/*` 依赖树解析到同一 rc 线，**含视觉模型等兄弟包能力**）→ 校验 → 原子替换 `node_modules`（含回滚）→ 写用户自更新标记（携带**整树指纹**）→ 重启 harness 生效
   - **混血树自愈**：检测与解压决策均基于整树一致性（`@deepseek-ai/*` 锁步包是否同版本线）。本地树不一致（如旧版单包更新残留：dsh 已升、兄弟包仍旧）时——
     - 在线：更新流程判定「需要修复」，自动整树重建到最新版；
     - 离线：启动期解压决策回退到安装包内置的一致运行时
   - 用户自更新后**一致且较新**的运行时不会被安装包重复覆盖，除非安装包内嵌的 dsh 版本更新

**入口只有两个（托盘 → 设置）：**
- `自动更新（框架 v… · 官方 Harness v…）`（开关，默认开）：冷启动自动检查一次（框架 15s 下载 + 官方 Harness 30s 本地替换）；关闭则仅手动
- `检查并更新…`（动作）：同时查框架 + 官方 Harness，有新版自动本地下载/替换；**外壳下载完成后需点「安装更新」按钮确认安装**

> Why npm not GitHub tags：deepseek-harness 通过 npm 分发（GitHub 只有源码 tags，无构建产物），所以「官方 Harness 最新」为 npm 已发布版本的最大 semver。

---

## 开发 / 构建

前置：Node ≥ 22。以下命令均在仓库根目录执行。

```bash
npm install            # 安装开发依赖（shell 侧；运行时依赖由 setup:runtime 单独安装）
npm run dev            # 开发模式（隔离 userData，与已安装版并行）
npm run check          # typecheck + 单测（npm run typecheck && npm test）
npm test               # 单元测试
```

**构建安装包**（运行时自包含，首次构建会下载便携 Node 并安装 450+ 依赖，耗时较长）：

```bash
npm run dist:win          # Windows NSIS 安装包（主平台，实测）
npm run dist:win:portable # Windows 便携版
npm run dist:mac          # macOS dmg（需在 macOS 上执行，arm64/x64）
```

- `scripts/build.mjs`：esbuild 打包 main/preload + 复制桌面插件
- `scripts/make-icons.mjs`：生成应用图标（png / ico / icns）
- `scripts/setup-runtime.mjs`：构建自包含运行时（下载便携 Node + `npm install @deepseek-ai/dsh` + bridge，输出 `resources/dsh-runtime.tar.gz` 与 `resources/runtime.version`）
  - 可用环境变量：`DSH_RUNTIME_DSH_VERSION`（默认 `0.1.1-rc.2`）、`DSH_RUNTIME_NODE_VERSION`（默认 `v24.15.0`）、`DSH_RUNTIME_NODE_ARCH`（目标便携 Node 架构，交叉构建时显式指定）
- `scripts/merge-mac-manifest.mjs`：合并 macOS arm64/x64 两个 `latest-mac.yml` 为一份（多架构自动更新）

CI（`.github/workflows/build-release.yml`）：master/PR 跑 `check`（typecheck + 单测）；打 `v*` tag 或手动触发时跑三平台安装包构建并上传到对应 Release。mac 的 arm64 构建在 x64 runner 上交叉进行，便携 Node 目标架构经 `DSH_RUNTIME_NODE_ARCH` 显式指定。

---

## 平台支持

- **Windows**（主平台，实测）：NSIS 安装包、托盘、系统通知、任务栏徽标、开机自启、`dsh://` 深链
- **macOS**（配置就绪）：dmg（arm64/x64）、`dsh://` 深链、运行时路径走 `~/Library/Application Support`
- **Linux**：代码兼容，未提供安装包

---

## License

MIT
