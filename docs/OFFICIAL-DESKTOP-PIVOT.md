# 路线调整：从"自研桌面壳"转向"打包官方桌面端"（B 方案）

**结论（2026-09-25 实测）：B 方案成立。** 官方 `apps/desktop` 是公开 MIT 源码里的完整桌面端，
在 Windows 上能构建、能出未签名产物、**工作台能正常打开**——包括我们自研壳缺的那条原生桥
（`window.dshDesktop`）。本文记录 spike 的证据、复现步骤与切换到 B 需要补的东西。

## 1. 为什么换（一句话）

我们的壳是"照着官方私有桌面壳重写一遍"，而上游 rc 线正在快速改这套私有契约：
0.1.7-rc.1 起客户端强制要求 `window.dshDesktop.keyboard`（native 快捷键桥），我们没有 →
工作台 24 个模块 pending（见 DESIGN D51）。B 方案不再重写，而是**构建官方那套**，
契约天然对齐；我们只维护打包/分发/品牌/更新。

## 2. Spike 证据

对象：`github.com/deepseek-ai/deepseek-harness` @ `477b4f4`（`rel/dsh-0.1.7-rc.2`，MIT，234k stars），
桌面端包 `@deepseek-ai/dsh-desktop@0.1.7-rc.2`，Electron `44.0.0`（与我们壳同一版本）。

构建链（本机实测，Windows 11 / Node 24.15 / pnpm 11.7.0）：

```powershell
git clone --depth 1 --branch master git@github.com:deepseek-ai/deepseek-harness.git
pnpm install --frozen-lockfile                        # 直连 npm 会超时，用 --registry=https://registry.npmmirror.com
pnpm build                                            # native-system + host/client lib + web 前端（≈4 分钟）
pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64:unsigned -- --dir
```

产物：`apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/DeepSeek Harness.exe`
（约 1.0 GB 解包体积），实跑结果：

```
page dsh-app://app/
bootCard=false | platform=win32 | dshDesktop=object | console 0 错误
body: "Dsh 标准模式 对话 轨迹 发消息或创建任务, / 调用指令, @ 文件或对话 完全权限 …"
```

即：**官方壳自带 `window.dshDesktop` 原生桥**，rc.2 的客户端模块全部激活——这正是我们自研壳
做不到、也是 v0.8.11 打不开工作台的根因。

本机网络绕行（中国大陆直连 GitHub/nodejs.org 会被重置，CI 上不需要）：

| 步骤 | 直连的坑 | 绕行 |
|---|---|---|
| clone 仓库 | `https://` 被重置 | 用 SSH（`git@github.com:…`） |
| `pnpm install` | 几个大 tarball 超时 | `--registry=https://registry.npmmirror.com` |
| 下载 Electron | `fetch failed / ECONNRESET` | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| primary-runtime 归档（CPython/Node/wheel） | GitHub / nodejs.org / pythonhosted 直连不稳 | 预置到 `.desktop-build/downloads/<sha256>`：CPython 用 `gh release download`，Node 用 npmmirror，wheel 用 pythonhosted（脚本：仓库外的 `.spike-seed-runtime.mjs`） |

已知未过项：`smoke-packaged-runtime` 里 **Office→PDF（LibreOffice）转换**失败
（`loadComponentFromURL returned an empty reference`），其余 node/koffi/sharp/pty/pnpm/grep/glob 全过、
Host 能起。属于待查项（本机环境或未签名产物路径问题），不影响"能不能开工作台"这个结论。

## 3. 切到 B 需要补的东西

1. **CI 出包**：GitHub `windows-latest` 自带 VS C++ 工具链 → 可以走完整 `package:win:x64:unsigned`
   （含 NSIS 安装器），本机缺该工具链只能用 `--dir`：
   `pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64:unsigned`（不加 `-- --dir`）。
2. **自有发行配置**（`apps/desktop/.env.windows`，官方要求必须是裸 HTTPS origin）：
   `DSH_DESKTOP_APP_ID`（建议自有，如 `com.dsh.desktop`）、
   `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN` / `_CONFIG`（策略服务，需要我们自己托管一份 JSON）、
   `DOWNLOAD_TEST_ORIGIN`（更新包下载源，指向我们的 Releases 或对象存储）、
   `DOWNLOAD_TEST_RELEASE_ID`（每批发布随机 32 hex）。
3. **更新通道**：官方 updater 走它自己的 COS + 策略服务语义；我们要么自建等价端点，
   要么关掉自动更新只做手动下载（先做后者更快落地）。
4. **品牌**：官方 BRAND_GUIDELINES 明确要求**不要在项目名里直接用 "DeepSeek Harness"**，
   推荐用缩写 "DSH" 并如实描述"基于 DeepSeek Harness"。所以产物要改
   `productName` / `appId` / 图标 / About 面板（我们现在叫 "DSH Desktop"，方向一致）。
5. **老用户迁移**：appId 变了就不是同一条更新链——需要在 dsh-desktop 现有 Release/应用内提示
   "请下载新的 DSH Desktop（基于官方桌面端）"，并保留一段时间旧包可下载。
6. **去留自研特性**：手机连接/LAN 门面、安全模式、插件环境体检、运行时不变量与杀软兜底（D46/D50）
   这些官方没有；要么以补丁/插件形式带回，要么明确砍掉。
7. **审计上游构建**：官方 packaging 脚本会下载 Electron/Python/Node 与上传 COS，CI 里要把
   上传部分关掉（`--publish never` 已是 `--dir` 的行为），只产出我们自己的 Release 资产。

## 4. 与现有自研壳的关系

- 现有 `dsh-desktop`（本仓库）**保留在稳定通道**：随包 harness 钉在 `0.1.7-alpha.2`（v0.8.12），
  自动巡检暂停（DESIGN D51）。它的价值是"现在就能用"，以及手机连接等官方没有的能力。
- B 方案落地后，本仓库的角色二选一：① 停止发版，只留 Release 页做迁移入口；
  ② 只保留 bridge/插件部分，作为新仓库的插件继续维护。**不再重写桌面壳**。

## 5. 风险

- 上游 rc 线还在变，`window.dshDesktop` 这类契约后续仍可能调整——但 B 是"对齐"而非"重写"，
  成本从"复刻一遍"降到"跟着升一个仓库版本 + 重新出包"。
- 官方未提供桌面安装包、也未承诺支持我们的再分发形态；品牌指南要求改名（见上）。
- 解包 1 GB / 安装包预计 300 MB 级（含内置运行时与 LibreOffice 引擎），比自研壳（约 150 MB）大一倍。

## 6. 后续（2026-09-25 当天）：B 也不用做了，官方已经出包

在准备 B 的 CI 时发现官方**正式下载通道**已经在发桌面安装包（不在 GitHub Releases 里，走自己的 CDN）：

```
https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml
  version: 0.1.7-rc.2
  https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.1.7-rc.2-win-x64.exe
  sha512: AY7f45dYO7BFrfgaLmzXNWP0pavlxkSbsehPo/WF6PXcFdDK3fF1oHUPs/4f2bzROgQvm6wSgawZ/g7UzbPRmw==
  size: 288245480
```

因此 A / B 都不再需要：用户直接用官方包（自动更新走官方通道）。本仓库随之冻结在 v0.8.12。

B 阶段已经做过、可留作备查的东西：

- fork：`Plocr/deepseek-harness`（上游 workflow 全部禁用，只留一条 `dsh-desktop-unsigned.yml`；
  实测能出 `deepseek-harness-0.1.7-rc.2-win-x64-unsigned.exe`，仅官方 smoke 的 Office→PDF 一步会在本机与 CI 失败）。
  不再需要时可整仓删除。
- 本地工作副本：`E:\Dsh\deepseek-harness`（约 4.3 GB，含 node_modules 与打包产物），可直接删除。
