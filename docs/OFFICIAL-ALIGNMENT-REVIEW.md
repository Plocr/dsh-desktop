# DSH Desktop × 官方桌面端对齐审查（2026-09-17）

审查对象：[deepseek-ai/deepseek-harness `apps/desktop`](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop)
（master，最后推送 2026-09-17）与"Everything is a Plugin"设计理念下的插件系统。

本文只记录**可复核的事实**与据此得出的差距；每条结论都给出官方来源或本仓文件位置。

---

## 1. 结论摘要

三条硬事实决定了本次改动的方向：

1. **官方插件系统是 alpha.2 才随包发布的。** `@deepseek-ai/dsh@0.1.6-alpha.2` 的依赖表里有
   `@deepseek-ai/dsh-plugin-manager`，而 `0.1.6-alpha.1` 没有；`dsh-web-app@0.1.6-alpha.2` 的
   `cordis.patch.yml` 新增了 `ui-plugin-manager`（侧边栏「插件」页）与 `tool-plugin-manager`
   （agent 工具）。本仓原先锁 alpha.1，等于**整套官方插件系统不在随包闭包里**——托盘自研管理是唯一选择，
   不是设计偏好。
2. **官方插件管理与 HMR 的开关就是"启动器有没有提供 profileContext"。**
   `dsh-base@0.1.6-alpha.2` 的 patch：

   ```yaml
   - id: plugin-manager
     name: '@deepseek-ai/dsh-plugin-manager'
     disabled: !!js "!ctx.get('profileContext')"
   - id: hmr
     name: '@deepseek-ai/dsh-hmr'
     disabled: !!js "!ctx.get('profileContext')"
   ```

   官方桌面 Host 用 `runProfile({ resolvedProfile, packageManager })` 提供这份上下文，
   `packageManager` 指向**随包 pnpm**（`{command: process.execPath, args: ['--expose-internals', pnpmEntry], …}`）。
   本仓 Host 只提供了 launch environment 与 cmdline，没有 profileContext，也没有把随包 pnpm 交出去。
3. **官方桌面 Host 已换代。** 现master 的 `apps/desktop-host/src/index.ts`（86 行）用
   `runProfile(...)` 起真实 Web Host（`--port 19387`），把**认证 URL 与注入片段**经 Node IPC 交给 Electron；
   本仓 Host 仍是 2026-09-02 那版 fd3/fd4 字节管道 + 自研 `dsh-app://` 转发的形态。

---

## 2. 差距清单

| # | 差距 | 官方依据 | 本仓原状 | 影响 |
|---|---|---|---|---|
| P0-1 | 官方插件系统缺席 | `dsh@0.1.6-alpha.2` 依赖 `dsh-plugin-manager`；`dsh-web-app` 声明 `ui-plugin-manager` / `tool-plugin-manager` 行 | 运行时锁 `0.1.6-alpha.1`，闭包里没有这些包 | Web「插件」页与 `plugin_manager` 工具不存在；只能靠壳自研管理 |
| P0-2 | 缺启动器信息 | 官方 `ProfileContext.packageManager`（"Packaged applications supply their bundled runtime instead of a PATH executable"）；`dsh-base` 用 `!ctx.get('profileContext')` 关闭插件管理器/HMR | Host 未 provide `profileContext`，未传随包 pnpm | 即使升到 alpha.2，插件管理器与 HMR 也会被静默关闭；Web 端只能退回 PATH 里的 pnpm（离线机器直接失败） |
| P0-3 | 插件管理两套实现 | 官方桌面文档：「插件管理使用 Web 应用经过认证的 HTTP API；Electron 不提供插件管理 IPC 或独立管理页面」 | 壳自研托盘对话框 + 自己的 pnpm 事务，与官方插件页并列 | 两套写同一份 `package.json`，语义/状态容易分叉 |
| P1-1 | 失败语义落后 | 官方失败表：安装失败/取消 → **还原 `package.json` 与 `pnpm-lock.yaml` 快照**；卸载失败才保留部分改动。另有 `pendingBuilds` + 「允许这些脚本并重试」、`inspect(spec)` 预检、`plugin-manager/install-log` 流、`.plugin-manager/logs` 诊断目录 | 文档与实现都是旧语义「失败保留部分改动、不自动回滚」；无待批准脚本流程；诊断只在内存里截尾 | 失败后 profile 可能停在半装状态；pnpm 11 拦脚本时用户拿不到可执行的下一步 |
| P1-2 | 启动期重写 bundles | 组合包启停 = 有序 `dsh.profile.bundles` 的增删（关闭保留依赖）；安装默认启用由包操作后的 reconcile 完成 | 每次启动都按 `dependencies` 把组合包补回 bundles（`reconcileProfileBundles`），另有 `settings.disabledPlugins` 强制挂载循环 | 用户在官方插件页停用的组合包会在下次启动被悄悄打开 |
| P1-3 | 传输架构换代 | 官方 Host `runProfile` + `--port 19387` + 认证 URL/注入经 IPC；「Electron 将应用 HTTP 请求转发给已认证的 Web Host」 | fd3/fd4 字节管道 + 自研静态资源/NDJSON 传输 | 本仓 README 的"完全对齐官方"表述已不成立；官方后续对 Web 面的行为（认证、注入、目录选择）不会自动跟上 |
| P2-1 | 官方原语未复用 | `dsh-app-boot` 导出 `sanitizeProfile` / `readProfilePlugins` / `reconcileProfilePlugins` / `writeProfileBundles` / `OPTIONAL_BUNDLES` / `readProfilePatches` | 壳手写 JSON/YAML 编辑、自研安全模式隔离与 patch 清理 | 边界情况（模板条目顺序、重复项、可选组合包）需要各自重实现 |

### 关于 profile 名（有意差异，建议保留）

官方把 `profiles/desktop` 视为自家 Electron 应用的保留名，`@deepseek-ai/dsh` CLI 会硬拒绝
`--profile desktop`。本仓用 `dsh-workbench` 是**必需的差异**，不是缺陷；`desktopProfile.ts` 已写明理由，
并把历史目录做了一次性迁移。本次改动保持该差异。

---

## 3. 本次落地的改动

| 差距 | 改动 | 位置 |
|---|---|---|
| P0-1 | 绑定运行时升到 `0.1.6-alpha.2`（与官方 Desktop 同版），随包闭包从此带 `dsh-plugin-manager` / `dsh-hmr` / `client-ui-plugin-manager` | `package.json`（`dshRuntime.dsh`）、`packages/host/package.json` |
| P0-2 | Host 构造官方 `ProfileContext` 并在 boot 时 `provide('profileContext', …)`；`packageManager` = 随包 Node + 随包 pnpm 入口（`--expose-internals`，`PATH` 前缀指向随包 Node）；壳把 `runtime.pnpmEntry` 经 `--pnpm` 传给 Host | `packages/host/src/index.ts`、`src/main/hostProcess.ts`、`src/main/host.ts`、`src/main/index.ts` |
| P0-2（就绪信号） | 补 `appReady` 服务（与官方 `dsh/profile-boot` 的 `createAppReady` 同语义，树安定后 `commit`）：`dsh-hmr` 在 `profileContext` 在场时会硬依赖它，缺了会以 `Profile HMR requires application readiness` 直接让组合树启动失败——这是"只加 profileContext"跑不起来的原因 | `packages/host/src/index.ts` |
| P0-2（层序一致性） | 启动层序改由官方 `readProfilePatches(binName, profileContext)` 计算，自有覆盖（`desktop.cordis.patch.yml` + agent 预设根）改放进 `profileContext.overlays`——插件管理器/HMR 重算 patch 时与本进程启动层序逐层一致。**⚠ 已被第三轮取代**（见 §7.1：Host 现在 `patchFiles: []`，本壳不再有任何私有 patch 层，该文件已删除） | `packages/host/src/index.ts` |
| P0-3 | 托盘「桌面插件」只留「在插件页管理（官方）…」+ 安全模式；**自研插件管理整体删除**（见 §6） | `src/main/tray.ts`、`src/main/index.ts` |
| P1-1 | 安装/升级失败回滚 `package.json` + `pnpm-lock.yaml` 快照、待批准脚本「允许并重试」、`.plugin-manager/logs` 诊断——这些语义现在**全部由官方插件管理器提供**（壳侧实现已随 §6 删除） | 官方 `dsh-plugin-manager`（Host 进程内） |
| P1-2 | 启动期只做失效条目清理（`pruneStaleProfileBundles`），绝不重新启用用户停用的组合包；移除启动期按 `settings.disabledPlugins` 强制挂载的循环 | `src/main/pluginfs.ts`、`src/main/index.ts` |

### 失败语义对照（改动后）

| 操作 | 失败后 | 依据 |
|---|---|---|
| 安装 / 升级 | `package.json` 与 `pnpm-lock.yaml` 还原到事务前；pnpm 已下载的文件与 `pnpm-workspace.yaml` 的待批准记录保留；宿主按原状态重启 | 官方失败表第 1 行 |
| 卸载 | 停在失败步骤，保留已完成的改动，报错并允许重试 | 官方失败表第 3 行 |
| 依赖脚本被 pnpm 拦下 | 记录在 `allowBuilds`，用户批准后重试；批准只写当前处于待决定状态的精确包名 | 官方 `approveBuilds` / `pendingBuilds` |

---

## 4. 未落地：建议的后续工作

1. ~~**传输迁移到官方形态（P1-3）**~~ → **已落地，见 §7**：把 Host 从"自研字节管道 + 自研静态资源"换成
   `runProfile` + 认证 Web Host（默认 19387），Electron 侧改为"转发请求 + 注入官方 `injections`"。
   收益：Web 面行为自动跟随官方（认证、注入、目录选择、`webserver.config.port` patch）；
   代价：壳里 `appProtocol.ts` / `hostProtocol.ts` / `lanServer.ts` 三条路径需重写，且要重新验证
   「无监听端口」这一自证安全边界——目前本壳把它写进了 README 与设计文档，属于产品级取舍，应单独一轮决策。
2. **复用官方 profile 原语（P2-1）**：用 `sanitizeProfile` 替换手写的安全模式隔离，
   用 `readProfilePlugins` / `reconcileProfilePlugins` 替换手写的 bundles 对账，
   把 `OPTIONAL_BUNDLES`（随包、默认关、可开、不可卸）接进插件页语义。
   注意：这些原语在 Host 侧（dsh 运行时树）可用，壳侧需要用 `createRequire` 指向运行时树。
3. **`plugin_manager` 工具（P0-1 的延伸）**：它在 `dsh-base` 里默认 `disabled: true`，由 agent 预设
   （Creator）开启。若希望默认可用，应通过 profile patch 显式打开，而不是另做一套壳工具。
4. ~~**模块解析 generation（P2）**~~ → **已随 §7 一并落地**：Host 现在直接用官方 `runProfile`，
   解析走官方 `PluginPackages`（link/runtime 两种模式），`healProfilesModuleFallback` 的
   190 ms 启动开销与相关自研代码一并删除。
5. **文档口径**：`README.md` 里"完全对齐官方"的表述需要区分"已对齐"与"有意差异"两栏；
   本文件即后续对齐清单的来源。

---

## 5. 验收方式

```sh
npm run check                # typecheck + 单测（含新增的 bundles / 待批准脚本用例）
npm run setup:runtime        # 按 package.json 的 dshRuntime 重建随包运行时（alpha.2 闭包）
npm run dev                  # 启动后确认：Host ready、侧边栏「插件」页可用、安装走随包 pnpm
```

手工验收要点：

1. 侧边栏「插件」页能列出内置组合包与已装插件（说明 `profileContext` 已生效）。
2. 在插件页停用一个组合包 → 重启应用 → 它**保持停用**（说明启动期不再重写 bundles）。
3. 安装一个带依赖脚本的插件 → 出现「允许这些脚本并重试」→ 批准后安装成功，
   `<profile>/.plugin-manager/logs/` 下有对应 `pnpm.log`。

自动验收：`npm run e2e:bridge` 新增一项断言——经**壳的字节管道** POST
`/api/pluginManager/listBundles`，必须拿到 `server-response` 且 `result.ok === true`。
它同时证明三件事：Host 提供了启动器信息、官方插件管理器行真的激活了、
Remote 面在无监听端口的传输形态下依然可达（端点不存在时该请求会是 `404 not found`）。

---

## 6. 第二轮：剔除自研插件管理、瘦身与提速

### 6.1 剔除自研插件管理（官方已有，就不留第二套）

| 删除项 | 原先作用 | 现在由谁负责 |
|---|---|---|
| `src/main/pluginTransactions.ts`（含 `ownedDirectory.ts`） | 壳自己跑 pnpm 事务：`add/update/remove/install`、profile 锁、`desktop-packages-pending` 标记与恢复 | Host 进程里的官方 `dsh-plugin-manager`（用启动器提供的随包 pnpm） |
| 托盘「安装插件…/卸载插件/逐个启停勾选」 | 壳自建安装对话框、卸载确认、bundle 挂载开关 | Web 侧边栏「插件」页（官方唯一入口；托盘只留一个「在插件页管理（官方）…」） |
| `pluginfs.ts` 中的用户插件安装/校验/发现、patch 残留清理、`allowBuilds` 手写编辑、待批准脚本解析等 | 配合上面的自研管理器 | 不需要（官方管理器 + 其 `.plugin-manager/logs` 诊断） |
| `settings.disabledPlugins` | 壳记录的停用名单 | `dsh.profile.bundles` 本身（唯一事实来源） |

保留的是**原生恢复**：`pluginfs.ts` 现在只做 profile 组合对账（清理失效条目）、安全模式隔离/恢复、
以及给 settings/safeMode/theme 复用的去 BOM 读取——与官方「Electron 只提供原生恢复」一致。

安全模式的隔离动作也对齐了官方 `sanitizeProfile`：除了把 `dsh.profile.bundles` 收窄到
官方基线 + bridge（依赖保留），还会把用户 patch 层 `cordis.patch.yml` 移出到
`cordis.patch.yml.safemode.bak`，让下次启动从空 patch 开始——坏 patch 与坏插件一样会让
组合树起不来，官方恢复同样先备份 patch 再启动。差别只在「退出安全模式」时本壳会把这两个
还原点一起还原（官方没有显式退出动作，备份文件留在原处）。

### 6.2 安装体积（实测）

| 项目 | 改动前 | 改动后 |
|---|---|---|
| `resources/dsh` | 456.9 MB / 13288 文件 | **123.9 MB / 10371 文件** |
| `resources/runtime`（打包后） | 116.5 MB / 2258 文件 | **106.5 MB / 518 文件** |
| unpacked 载荷合计 | ≈ 573 MB | **≈ 230 MB** |
| 安装包（`DSH.Desktop-0.8.0-setup.exe`） | 157.1 MB（0.8.0 上一版，尚无官方插件系统） | **153.6 MB（同时装上了官方插件系统）** |

两点来源：

1. **Office→PDF 原生引擎默认不随包**：`@deepseek-ai/libreoffice-kit-<platform>-<arch>` 是一整份
   LibreOffice（win32-x64 = 325 MB / 2050 文件，占整树 71%），只服务「应用内把 docx/xlsx/pptx
   转 PDF 预览」。它是 dsh 0.1.6-alpha.2 新带进来的依赖——不处理的话这一版安装包会比上一版大 80 MB。
   需要预览的构建设 `DSH_DESKTOP_OFFICE_RUNTIME=1` 即可把它带回来（引擎解析是惰性的，
   剔除后组合树照常启动，只有第一次转换会以 `unavailable` 明确失败）。
2. **包文档 + 便携 Node 自带的 npm**：剔除 869 个 `.md`（保留 LICENSE/NOTICE），
   并在**打包时**过滤掉 `resources/runtime/node/node_modules/npm`（1739 文件 / 10 MB，
   只有构建期 `setup:runtime` 用它，运行期一律走随包 pnpm——pnpm/dist 自带 node-gyp）。

### 6.3 启动路径（实测）

Host 引导分解（随包 Node + 真实 profile，3 次取稳定值）：

| 阶段 | 耗时 |
|---|---|
| `loadProfileDirectory` | 8–18 ms |
| `healProfilesModuleFallback`（每次启动） | 345 ms 冷 / **190 ms 热** |
| `readProfilePatches`（31 条 patch） | 4–6 ms |
| `boot`（165 行组合树装配） | **≈ 1810 ms** |
| 合计 | **≈ 2.0–2.3 s** |

结论与动作：

- 启动开销**几乎全在 harness 组合树装配**（165 个插件行，与官方桌面端同形），不是我们的壳；
  `NODE_COMPILE_CACHE`、减小载荷都没有可测收益（已实测排除）。
- 因此只清掉真正属于壳的两处浪费：**旧会话修复改成一次性**（原每次启动全量扫读会话日志，
  重用户机器上最拖启动；现在按随包 dsh 版本记标记，只跑一次，并留了托盘「重新修复旧会话日志」），
  以及**局域网 IP 解析移出关键路径**（原来在窗口创建前 `await`，最坏 1.5 s UDP 超时；
  现在只在开启局域网共享时、Host ready 之后按需解析）。

---

## 7. 第三轮：传输层换成官方形态

### 7.1 改了什么

| 位置 | 旧 | 新 |
|---|---|---|
| Host（`packages/host`） | 自研 fd3/fd4 字节管道 + 自研帧协议（协议 v3）+ 自研静态资源/Remote 流处理 | 官方 `runProfile`：真实 Web Host（loopback，默认 19387）+ 官方认证 URL 与 index 注入；**不再有管道**（`wire.ts` 已删除） |
| 桌面补丁 | 自研 `desktop.cordis.patch.yml`（停用 webserver/web-startup 等） | **不再打任何补丁**（`patchFiles: []`，与官方 desktop-host 一致）；`--no-open` 保证不自动开浏览器 |
| 壳侧转发 | `host.fetch()` 走管道（`hostProtocol.ts` 帧编解码，已删除） | 官方三件套：`serveWebDocument`（本地 dist + `__DSH_BOOT_READY__`）/ `authenticateWebHost`（URL→cookie）/ `forwardWebRequest`（带 cookie 转发，来源校验） |
| 渲染层启动 | 自研 `__DSH_TRANSPORT__`（NDJSON `/.dsh/remote-stream`） | 官方契约：preload 暴露 `dshDesktopBoot.ready()/failed()`，主进程返回 `{injections, streamBaseUrl}`，客户端自己应用注入 |
| WebSocket | 不需要（远端流被改成 NDJSON） | 官方 mux：主进程按官方方式给 `ws://127.0.0.1/*` 补 Origin/cookie；局域网门面新增 **WS 升级代理**（同样过设备授权 + token 门禁） |

### 7.2 顺带修掉的三个真 bug（都是本轮审查发现的）

1. **overlays 传成了「层」而不是「行」**：官方 `readProfilePatches` 的 `context.overlays` 是**扁平的补丁行**，
   而第二轮我传的是 `loadOverlayPatches()` 返回的**层数组**。`composeEntries` 会 flatten、看起来正常，
   但 Loader 的 `applyEntryPatches` 不 flatten——于是整个桌面补丁被当成「没有 id 的 patch」静默丢弃：
   **webserver/web-startup 全部启用** → Host 去抢 3080 端口、自动拉起浏览器；本机已有 DSH Web 实例时
   直接 `EADDRINUSE` 启动失败 → 反复重启 → 这就是「偶尔闪屏」的根因。现在整块补丁不复存在（§7.1）。
2. **启动时自动打开浏览器（用户报告的第 2 条）**：同一根因；现在 Host 以官方 `--no-open --port 19387` 启动，
   e2e 断言 stdout 不得出现 "opening the default browser"。
3. **日志里带一次性 token**：Web Host 的启动行 `dsh web: http://127.0.0.1:19387/?token=…` 会被壳逐行落盘；
   现在脱敏规则同时覆盖 bridge 发现行与任何 `token=` 参数。

另外补了两个健壮性护栏：
- **端口冲突兜底**：19387 被占时自动改用随机端口重试一次（官方只报错）；工作台按 URL 里的端口连接，无需固定端口。
- **闪屏护栏**：`showLoading` 幂等（同状态不重复 loadURL）、`loadApp(generation)` 只在 Host 换代时重载页面。

### 7.3 验证

`npm run e2e:bridge` 已重写为官方传输契约，23 项断言全绿：
`ready` 带 url + 8 条 injections、**未自动打开浏览器**、`serveWebDocument` 的入口文档含
`__DSH_BOOT_READY__`、`authenticateWebHost` 拿到 cookie、`forwardWebRequest` 打通
`/api/pluginManager/listBundles` 且拒绝外来 Origin、bridge 全 RPC（含坏 token 4001）、
局域网 HTTP 与 **WS 升级 101**（门禁后代理）。

---

## 8. 第四轮：托盘重设计（手机连接二维码）+ 全项目 bug 审查（2026-09-18）

### 8.1 要求 → 落地

| 要求 | 落地 | 证据 |
|---|---|---|
| 托盘：手机连接改成**扫描二维码自动跳转浏览器链接** | 一级菜单 `手机连接（扫描二维码）…` → 按需拉起对外门面（`0.0.0.0:46123`，占用回退随机）→ `dsh-app://shell/phone.html` 把地址画成二维码；扫码即打开浏览器版（首次访问仍在本机授权）。开启后菜单多出「断开手机连接」 | `src/main/qr.ts`、`resources/shell-pages/phone.html`、`src/main/phoneWindow.ts`、`test/phone-connect.test.mjs` |
| 去除桌面插件管理，仅保留「进入安全模式」 | 删除「桌面插件」子菜单（连「在插件页管理（官方）…」一起删）；`进入安全模式（停用全部插件）` 升为一级项，安全模式下换成 `退出安全模式（恢复全部插件）` | `src/main/trayMenu.ts`、`test/tray-menu.test.mjs` |
| 去除「切换工作区」 | 托盘入口删除（`dsh:pick-workspace` 仍给壳页面用，Web UI 内添加/切换工作区不变） | 同上 |
| 精简托盘设置中的二级菜单 | `设置 ▸` 从 14 行减到 6–7 行：自动更新（含双版本号）/ 检查更新… / 开机自启 / 系统通知 / 打开日志目录 / 清理日志 / 卸载（Windows）；**不再有二级嵌套**（全局快捷键行、重新修复旧会话日志、局域网开关与地址行全部移除） | 单测断言设置子菜单标签集合与"无 `submenu`" |

顺带清掉的历史包袱：`最近会话 / 待审批 / API Key 状态行 / 任务数`（0.8.1 已从托盘删除，
本轮把残留的死状态与未使用导入一并清掉）。

### 8.2 本轮审查发现并修掉的 bug

| 位置 | 问题 | 修法 |
|---|---|---|
| `hostProcess.ts` | Host 的 stderr **无上限累加**（`this.stderr += chunk`）：长期运行的 Host 打日志就是持续内存增长，与文档/官方「保留最后 64 Ki 字符」不符 | 加 `STDERR_TAIL_LIMIT = 64 Ki` 截尾；顺手合并重复注册的 `data` 监听 |
| `notify.ts` | `Notification` 句柄未持有引用，主进程 GC 后部分平台会取消/丢失通知与点击回调（偶发"通知不出现"） | 保留引用集合，`close`/`failed` 或 10 分钟兜底后释放 |
| `index.ts` | `apiKeyStatus` 在托盘状态行删除后变成**只写不读**的死状态；`latestApproval/recentSessions/sessionLabel` 变成未使用导入 | 删除死状态；文件回退结论直接进日志与通知文案；清理未使用导入 |
| `index.ts` | `manageLanServer()` 失败（端口耗尽/权限）会冒泡成未处理 rejection，且托盘不刷新、`手机连接` 页只显示"没有网卡地址" | 内部 try/catch → 记日志 + `lanError`；`手机连接` 页据此显示真实原因（"对外服务启动失败：…"） |
| `index.ts`（文案） | 安全模式通知仍写「托盘「桌面插件 → 退出安全模式」」——托盘里那个路径已不存在 | 改成「在托盘菜单点「退出安全模式」即可恢复」 |
| `README.md` / `docs/DESIGN.md` | 与实现漂移：托盘仍在描述最近会话/待审批/桌面插件/局域网开关；托盘截图是 0.8.1 旧菜单 | 文档按新结构重写；截图处显式标注待补（不拿旧图冒充） |

### 8.3 验证

- `npm run check`：typecheck + **107** 项单测全绿。新增：
  - `test/qr.test.mjs`：二维码编码器用**独立解码器**（jsqr，仅 devDependency）回读——8 种掩码、
    版本边界、非 ASCII、超容量抛错；
  - `test/tray-menu.test.mjs`：托盘模板结构（手机连接入口、被删项不得复现、设置子菜单精简、安全模式互换）；
  - `test/tray-status.test.mjs`：状态行语义（连接/任务可用/协议不匹配/诊断码）；
  - `test/phone-connect.test.mjs`：门面发地址 → 二维码回读出同一地址 → token 换 cookie → 带 cookie
    打开工作台 → 裸访问 401 → 断开即失效。
- Electron 模板实机校验：用 `Menu.buildFromTemplate` 跑 4 种状态（默认/手机连接开启/安全模式/桥接断开），
  菜单项与顺序符合预期、无异常。
- `npm run e2e:bridge`：官方传输契约（Host ready / 注入 / cookie 转发 / 局域网 HTTP + WS 升级）继续全绿。

> 关于二维码为什么自研而不用依赖：托盘二维码是**离线**能力（打包机与用户机都不该为它拉包），
> 而编码器只需字节模式 + 纠错 M + 版本 1–10（本机地址 ≈60–70 字节，落在版本 5–6），
> 实现规模可控且用第三方解码器回读校验；用现成库会把一份运行时依赖塞进 150 MB 的签名更新单元里。

---

## 9. 第五轮：性能审查（启动/退出/托盘响应，2026-09-19）

用户报："打开和退出都不流畅、有时要退出两次、托盘左键点图标没反应"。全部按实测定位，机器上真跑出的数字如下。

### 9.1 实测数据（本机，随包运行时）

**启动（壳侧只占 0.25s，其余是官方组合树 boot）**

| 阶段 | 耗时 | 累计 |
|---|---|---|
| 窗口对象创建 | 99ms | 99ms |
| 运行时解析（descriptor 校验） | 19ms | 118ms |
| profile 就绪（junction + bundles） | 20ms | 138ms |
| 旧会话修复检查 / 组合对齐 | 11ms | 149ms |
| spawn Host | 25ms | 174ms |
| **加载页首帧**（用户看到画面） | 79ms | **253ms** |
| **Host ready**（官方 165 行组合树 boot） | 2421ms | 2595ms |
| **工作台页面加载完成**（可交互） | 477ms | **3073ms** |

结论：壳侧没有可优化项（<0.3s），~3s 里 2.4s 是官方组合树引导；加载页 0.25s 就出现，用户不会面对白屏。

**退出（修复前 vs 修复后）**

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 用户点「退出」到进程消失 | 5–8s（等 Host 停机超时 → SIGKILL） | **105ms**（Host 97ms 干净退出 code=0；外部观测进程 1.2s 内消失） |
| 用户可见反馈 | 无（托盘图标一直挂着） | **4ms**（托盘与窗口立即撤掉） |
| Host 停机（探针：无客户端 / 客户端连着 / 先断客户端） | **永不退出**（60s 仍未退出） | 2095ms / 2097ms / 1836ms（全部 code=0） |

### 9.2 根因：桥接插件的监听句柄把 harness 进程钉住了

官方 `createProcessShutdown`（`@deepseek-ai/dsh` 的 profile-boot）在 dispose 完成后走的是
**`process.exitCode = code` + 等事件循环自然 drain**，并不强制 `process.exit()`（强制退出只留给 5s 超时兜底）。
我们的桥接插件用 `new WebSocketServer({ host, port: 0 })` 起了监听 socket——那是 **ref 句柄**，
于是 drain 永远不完成：实测 **shutdown 后 60 秒进程仍在、端口仍在监听**（`DISPOSE-RAN` 也没打出来，
说明这条路径连 dispose 都没走到）。壳等不到退出，只能在 5s/8s 兜底时 SIGKILL，用户体感就是
"退出要等很久 / 点了没反应 → 再点一次"；`restart()` 同样要等 7s 超时，期间旧进程还占着资源，
下一次启动因此更顿挫（用户日志里就有 `host restart: exit 事件超时，强制重建`）。

**修法**：桥接自己持有 HTTP 监听句柄（`noServer` 模式）并在 listen 后 **`unref()`**，
每个已接受连接也 `unref()`；dispose 里仍然显式 `close()`。语义是"桥接照常服务，但不定义 Host 的生存期"。
（`packages/bridge` 0.4.0 → 0.4.1）

### 9.3 顺带修掉的体验问题

| 现象 | 原因 | 修法 |
|---|---|---|
| 左键点托盘图标没反应 | 从没注册过 `tray.on('click')`——Electron 默认只有右键菜单 | `click`/`double-click` → 显示工作台；右键仍是菜单 |
| 有时「退出」要点两次 | 壳在有会话/任务事件时会 `refreshTray()` 重建菜单，而 **Windows 上菜单开着时被替换会让点击丢失** | 加菜单指纹（`trayMenuSignature`）：内容没变就不 `setContextMenu`；0.8.2 起托盘已不含会话/任务数，这类事件现在完全不触发重建 |
| 退出可能留下孤儿 Host | 第二次 `before-quit` 没有被拦，Electron 会在 Host 停完前收掉进程 | 退出流程里始终 `preventDefault()`，唯一出口是 Host 停完 / 6s 兜底的显式 `app.exit(0)`；兜底先 `killNow()` |

### 9.4 验证

- 停机探针（真实 Host + bridge 插件，三种客户端状态）：全部 ~2s 干净退出（修复前 60s+ 不退出）
- 实机启动/退出计时（`[perf]` 常驻日志）：启动 3.07s、退出 105ms（见 9.1）
- `npm run check`（typecheck + **112** 单测）、`npm run e2e:bridge`（23 项）、`npm run verify:runtime`（bridge 0.4.1）全绿
