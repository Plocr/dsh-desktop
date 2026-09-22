# 杀毒软件误报（PDM）与运行时文件被隔离

**结论先说：本项目不含任何恶意代码。** 这里记录 2026-09-23 的一次真机误报、可复核的证据、
以及遇到同类情况时的处理与长期解法。

## 1. 真机现象

- 卡巴斯基「主动防御」弹出：`检测到: PDM:Trojan.Win32.Generic`，位置指向
  `…\dsh-desktop\resources\dsh\node_modules\dsh-desktop-host\lib\index.js`。
- 清除之后应用"起不来"：日志里是 Node 的 `Cannot find module
  '…\resources\dsh\node_modules\dsh-desktop-host\lib\index.js'`，连续三次失败后应用进入安全模式
  （看起来像"插件坏了"，其实是运行时文件被删）。

## 2. 为什么会被误报

`PDM:` 前缀表示这是**行为启发式**（Proactive Defense Module）判定，不是病毒库特征命中。触发面是这类组合：

1. **未签名**的可执行文件（`scripts/windows-sign.mjs` 在未配置证书时会显式跳过签名，见 `docs/SIGNING.md`）；
2. Electron 应用把一个 **Node 进程当子进程拉起**，而这个 Node 进程会：
   - 以 `--expose-internals` 启动（随包 pnpm 需要，官方桌面端同样如此）；
   - 读取/写入 profile 目录下**上万个小文件**（插件树、运行时树）；
   - 再拉起更多子进程（shell、pnpm、插件自带的原生模块）；
3. 安装包是 NSIS 自解压 + 安装后清理临时目录（`scripts/installer.nsh` 的 `customInstall`），
   这也是 dropper 的典型形状。

单看任何一条都很常见，叠在一起就很容易被行为引擎打分打高。

## 3. 可复核的证据（我们这边做了什么）

- **文件就是本仓库的源码构建产物**，没有混淆、没有额外载荷：`packages/host/src/index.ts`
  是官方 `deepseek-ai/deepseek-harness` `apps/desktop-host` 的移植（MIT），
  构建脚本 `packages/host/build.mjs` 用 esbuild 打成一层的 ESM，
  `git log -p -- packages/host` 可以看到每一行的来历。
- **哈希可对**：

  ```powershell
  # 安装目录里的文件
  Get-FileHash "$env:LOCALAPPDATA\Programs\dsh-desktop\resources\dsh\node_modules\dsh-desktop-host\lib\index.js" -Algorithm SHA256
  # 仓库里构建出来的同一个文件（npm run setup:runtime 之后）
  Get-FileHash "E:\Dsh\dsh-desktop\packages\host\lib\index.js" -Algorithm SHA256
  ```

  两者必须完全一致（0.8.5 实测：`2E6EF783991D5D854F3EA2B89D696123AB23AF50807FB2335D7C070C92869242`）。
  对不上说明文件被改写，那才需要按中毒处理。
- **运行时整棵树有逐文件 sha256 清单**：`resources/dsh/desktop-runtime.json`（由
  `npm run setup:runtime` 生成、`npm run verify:runtime` 逐文件复核），
  文件被改动或缺失都能查出来。

## 4. 遇到时的处理（按顺序）

1. **加白名单**：把安装目录（默认 `%LOCALAPPDATA%\Programs\dsh-desktop`）与用户数据目录
   （`%APPDATA%\DSH Desktop`）加入杀毒软件的排除项/受信任区域。卡巴斯基：
   「设置 → 安全威胁 → 排除项 → 添加」。
2. **恢复被隔离的文件**：从隔离区恢复，或重装 0.8.5+ 的安装包（**安装前先加白名单**，否则装完又会被删）。
3. **重启应用**：托盘「重启 Harness」。0.8.6 起壳会在启动时校验关键运行时文件，
   缺失时直接给出「哪个文件缺了 + 很可能被安全软件隔离」的说明，不再把它当成插件故障去连推安全模式。
4. **顺手报个误报**：<https://opentip.kaspersky.com/> → 提交为误报（Submit file / I think this file
   is a false positive），上传 `…\resources\dsh\node_modules\dsh-desktop-host\lib\index.js`
   或整个安装包，备注「Electron app whose bundled Node runtime loads a plugin tree; unsigned build」。

## 5. 长期解法（按性价比排序）

1. **签名发布**：EV 证书 + `scripts/windows-sign.mjs`（见 `docs/SIGNING.md`）。
   签名后启发式判定会显著减少——这是唯一"根治"的做法，也是官方桌面端走的路线。
2. **持续提交误报**：同一份文件被多个用户报几次后，厂商一般会把哈希加入白名单。
3. **别把运行时拆得太碎**：`resources/dsh` 里上万个小文件本身就是启发式的高分项；
   本项目已经把文档/源码/Office 引擎剔掉（`scripts/runtime-file-policy.mjs`），继续压缩空间有限。

### 5.1 0.8.7 起已经做掉的"结构性减法"（不靠用户加白名单）

启发式打分看的是**形状**。下面这些是把形状本身改掉的改动：

| 以前的形状（容易被判恶意） | 0.8.7 的做法 | 代价 / 前提 |
|---|---|---|
| 应用 → 随包 `node.exe`（未签名解释器，深层目录）→ 再 spawn Node 跑 pnpm | Host 与 pnpm 都由**应用自己的 Electron 二进制**以 `ELECTRON_RUN_AS_NODE=1` 运行（官方桌面端同形） | electron 必须**精确**钉在 harness 支持的版本上（`43.0.0 / 44.0.0 / 45.0.0-alpha.6`；本仓用 `44.0.0`） |
| `--expose-internals`（pnpm 启动参数，行为引擎眼里的高危 flag） | 去掉（实测 pnpm 11 的 install/add/remove 不需要） | 无（已在本机与 e2e 验证） |
| 启动时静默跑 `pnpm install`（"应用自己装软件"） | 启动只做**只读体检**；修复要用户在托盘点「修复插件环境…」并确认 | 多一次点击 |
| 随包携带非目标架构的原生二进制（真机是 `node-pty` 的 `win10-arm64/OpenConsole.exe` + `conpty.dll`） | 打包时按目标平台/架构剔除（它们永远不会被执行） | 无 |
| 内置 10.9k 文件的运行时树 + 另一份便携 Node | 便携 Node 不再进安装包（**−约 50 MB / −约 500 个文件**） | 无（Electron 自带 Node 24.18.1） |

仍然无法用代码"保证"的部分：**未签名**。任何行为引擎都可能对未签名的新二进制保持怀疑——
所以要真正不再出现误报，仍建议至少接一种签名渠道（Azure Trusted Signing 约 $10/月、SignPath Foundation
对开源项目免费、或 EV 证书）。

## 6. 快速自查（确认自己装的是官方包）

```powershell
# 1) 应用版本与运行时身份
Get-Content "$env:LOCALAPPDATA\Programs\dsh-desktop\resources\dsh\desktop-runtime.json" |
  Select-String -Pattern 'version|dshVersion|hostProtocolVersion'
# 2) 安装包哈希（对照 Release 页 latest.yml 里的 sha512）
Get-FileHash .\DSH.Desktop-0.8.6-setup.exe -Algorithm SHA512
# 3) 运行时完整性（在仓库里跑；会逐文件比对 sha256）
npm run verify:runtime
```
