# 代码签名与发布签名作业手册

本文覆盖 DSH Desktop 的两个签名链路：

| 平台 | 目标 | 用到的产物 | 关键实现 |
| --- | --- | --- | --- |
| Windows | 安装包 / 便携版带 Authenticode EV 签名 | NSIS `.exe`、应用 `.exe`、临时卸载器 | `scripts/windows-sign.mjs`（electron-builder `win.signtoolOptions.sign` 钩子）+ `scripts/installer.nsh` |
| macOS | `.app` 带 Developer ID 签名，`.dmg` 经 Apple 公证 + 钉票；签名分支另出应用内更新用的 `.zip`（`--zip`：公证+钉票 `.app` 后用钉票后的 `.app` 重打） | `DSH.Desktop-<版本>-<架构>.dmg`、`DSH.Desktop-<版本>-<架构>.zip` | `scripts/package-macos.mjs` |

实现适配自 DeepSeek Harness 官方桌面端（MIT License，`apps/desktop/scripts/*`），差异与理由写在脚本头注释里。**未配置签名变量时两条链路都自动跳过**，因此没有证书的人仍然可以正常构建（但产物是未签名的）。

---

## 0. 变量总表

### Windows（四个必须同时提供，缺一即报错）

| 变量 | 含义 | 从哪来 |
| --- | --- | --- |
| `DSH_DESKTOP_WINDOWS_CER_FILE` | **公开**的 X.509 叶证书文件路径（`.cer`，非 CA、含 Code Signing EKU） | CA（上游使用 GlobalSign EV）签发后随 Token 一起交付；只含公钥，可以放在 runner 临时目录，不要提交进仓库 |
| `DSH_DESKTOP_WINDOWS_SIGNTOOL` | 与 SafeNet 兼容的 `signtool.exe` 绝对路径 | SafeNet Authentication Client / eToken 驱动安装目录，或 CA 交付包中的已验证 SignTool；**不要**用未验证的其它版本 |
| `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` | SafeNet 私钥容器名（私钥始终留在 USB Token 内） | SafeNet 管理工具（eToken PKI Client）里该证书对应的容器名 |
| `DSH_DESKTOP_WINDOWS_TOKEN_PIN` | SafeNet Token Password（Token 口令） | 申请 Token 时由 CA/管理员设置；属于绝密，只在受控机器上临时注入 |

约束（脚本会校验，违反直接失败）：`PIN` 不能包含 `]`、双引号或换行（SafeNet `/kc` 语法用它们做分隔符）；容器名不能包含引号或换行。

### macOS（签名身份 2 个 + 公证凭据 1 套）

| 变量 | 含义 | 从哪来 |
| --- | --- | --- |
| `DSH_DESKTOP_MACOS_SIGNING_IDENTITY` | 证书限定名，**必须去掉 `Developer ID Application: ` 前缀**（例如 `Example Corp (ABCDEFGHIJ)`） | `security find-identity -v -p codesigning` 的输出里，把 `Developer ID Application: ` 后面的整体抄过来 |
| `DSH_DESKTOP_MACOS_TEAM_ID` | 10 位大写字母/数字的 Apple Team ID | developer.apple.com → Membership details；或证书名括号里的那串 |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | 导出的 `.p12`（路径、`file://` URL 或 base64）及其密码 | Keychain Access 导出 Developer ID Application 证书为 `.p12`；electron-builder 用它建临时钥匙串。也可改用机器钥匙串里已导入的证书 |
| `CSC_NAME` | 证书限定名（可选，等价于 `mac.identity`） | 同上；`mac.identity`/命令行覆盖优先于它 |
| `DSH_DESKTOP_APP_ID` | 可选断言：设置时要求产物 `CFBundleIdentifier` 与它一致 | 本仓库固定为 `com.dsh.desktop.workbench`（`electron-builder.yml` 的 `appId`） |

公证凭据三选一（与 electron-builder / `notarytool` 官方语义一致）：

| 策略 | 变量 | 从哪来 |
| --- | --- | --- |
| Apple ID（CI 最常用） | `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | Apple ID 需开启双重认证；在 appleid.apple.com → Sign-In and Security → App-Specific Passwords 生成专用密码；`APPLE_TEAM_ID` 与上表 Team ID 相同 |
| App Store Connect API Key | `APPLE_API_KEY`（`.p8` 文件路径）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` | App Store Connect → Users and Access → Integrations → App Store Connect API 生成 Key（`.p8` 只能下载一次），同时记下 Key ID 与 Issuer ID |
| 钥匙串 profile | `APPLE_KEYCHAIN_PROFILE`（+ 可选 `APPLE_KEYCHAIN`） | `xcrun notarytool store-credentials <profile>` 预先存好凭据 |

`APPLE_API_KEY` 在 electron-builder 与本仓库脚本里都表示 **`.p8` 文件的绝对路径**（不是内容）。

---

## 1. Windows EV 签名

### 1.1 工作原理

electron-builder 的 `win.signtoolOptions.sign` 钩子指向 `scripts/windows-sign.mjs`。钩子对**每个**待签名产物（应用主 exe、NSIS 安装包、便携版 exe，以及 electron-builder 为生成卸载器而临时执行的那个 exe）执行一次：

```
<DSH_DESKTOP_WINDOWS_SIGNTOOL> sign /v /fd sha256 \
  /f <DSH_DESKTOP_WINDOWS_CER_FILE> \
  /kc "[{{<PIN>}}]=<DSH_DESKTOP_WINDOWS_KEY_CONTAINER>]" \
  /csp "eToken Base Cryptographic Provider" \
  [/as] \
  /tr http://timestamp.digicert.com /td sha256 <产物>
```

要点：

- 只用配置的 SignTool，**不回退**到 electron-builder 自带的 signtool，**不重试**：SignTool 非 0 退出即整个构建失败，不会产出「未签名的发布产物」。
- 时间戳走 DigiCert 的 RFC 3161（`/tr` + `/td sha256`），SHA-256 文件摘要；`/as` 仅用于追加签名轮次（本仓库 `signingHashAlgorithms: ['sha256']`，通常只有一轮）。
- 签名前会修掉 electron-builder 生成的 exe 里指向文件末尾之外的证书表项（否则 SignTool 会报错）。
- PIN 必须出现在 SignTool 命令行（SafeNet `/kc` 的要求，无法避免）；除此之外诊断输出会把 PIN 替换成 `<redacted>`，子进程环境不带任何继承来的 `*KEY/*SECRET/*TOKEN/*PASSWORD*` 变量，签名字段在拉起 SignTool 前即被清空。
- 单次 SignTool 调用有 5 分钟超时（Token 未插入/被锁时不会无限挂住）。
- 变量齐全性：**四个全有 = 签名；一个都没有 = 跳过（未签名）；只配一部分 = 直接报错**。

### 1.2 本机构建（PowerShell）

```powershell
# 1) 插入 USB Token，用 SafeNet 工具解锁
$env:DSH_DESKTOP_WINDOWS_CER_FILE = 'C:\path\to\server.cer'
$env:DSH_DESKTOP_WINDOWS_SIGNTOOL   = 'C:\path\to\the\validated\signtool.exe'
$env:DSH_DESKTOP_WINDOWS_KEY_CONTAINER = '<SafeNet 私钥容器名>'
$env:DSH_DESKTOP_WINDOWS_TOKEN_PIN  = '<SafeNet Token Password>'

# 2) 构建（与今天相同的一条命令）
npm run dist:win          # 便携版：npm run dist:win:portable
```

产物：`release/DSH.Desktop-<版本>-setup.exe`（以及 `.exe.blockmap`、`latest.yml`）。

### 1.3 构建后校验

```powershell
$v = (Get-Content package.json -Raw | ConvertFrom-Json).version
Get-AuthenticodeSignature "release/DSH.Desktop-$v-setup.exe" | Format-List Status, SignerCertificate, TimeStamperCertificate
# 期望 Status = Valid；签名者 CN 与 EV 证书一致；TimeStamperCertificate 非空（有时间戳才能长期有效）
```

CI 里的 `Verify Authenticode signature` 步骤做的就是这件事，并且 `Status -ne 'Valid'` 会让 job 失败。

### 1.4 未签名 Windows 构建（无证书）

任选一种：

```bash
# 什么签名变量都不设：钩子检测到四个变量缺失，打印跳过提示后走未签名流程
npm run dist:win

# 显式声明（同时禁止“只配一半”的误判；与完整签名变量同时出现会报错）
DSH_DESKTOP_UNSIGNED=1 npm run dist:win
```

### 1.5 Windows 失败模式

| 症状 | 原因 / 处理 |
| --- | --- |
| `DSH_DESKTOP_WINDOWS_KEY_CONTAINER must contain the SafeNet private-key container name` | 容器名空/只有空白；用 SafeNet 工具确认容器名 |
| `... must contain a non-CA Code Signing certificate` | `CER_FILE` 指向了私钥容器导出的 CA 证书或错误文件；必须是含 Code Signing EKU 的叶证书 |
| `is missing or is not an executable file` | SignTool 路径不存在/不是 `.exe` |
| `incomplete signing environment; missing ...` | 四个变量只配了一部分——脚本刻意报错，避免产出「看着像签名」的包 |
| `Windows release signing failed for <file> (exit N): ...` | SignTool 自身失败：Token 未插、PIN 错、Token 被企业策略锁、证书过期、时间戳服务不可达（离线环境尤其常见）。诊断已脱敏 |
| 超时（5 分钟）后失败 | Token 端等待人工确认；先解锁 Token，必要时检查 SafeNet 驱动 |
| 只配了签名变量但产物没签名 | 检查是否同时设了 `DSH_DESKTOP_UNSIGNED=1`（两者同时存在会报错，不会静默跳过） |
| 企业杀软/代码完整性拦截构建 | 临时卸载器已提前签名（`installWindowsNsisBootstrapSigner` 补丁），若仍被拦截请确认 SignTool 与证书链在本机可用 |

---

## 2. macOS 签名 + 公证

### 2.1 工作原理

1. `electron-builder --mac dmg`（CI 的签名分支是 `--mac dmg zip`）用 Developer ID Application 证书签 `.app`（`CSC_LINK` 导入的临时钥匙串 + 显式 `identity`），并生成 dmg（+ zip）；
2. `scripts/package-macos.mjs`：
   - 深度严格校验 `.app` 签名（`codesign --verify --deep --strict` + `--display --verbose=4` 必须出现 `Authority=Developer ID Application: <限定名>` 与 `TeamIdentifier=<Team ID>`），必要时断言 `CFBundleIdentifier == DSH_DESKTOP_APP_ID`；
   - **传了 `--zip` 时先处理应用内更新的 zip**：给 `.app` 打临时 zip 提交公证 → `stapler staple` 钉票 `.app` → 用**钉票后**的 `.app` 重打发布 zip → 删掉随之作废的 `<zip>.blockmap`（这一步必须在 dmg 之前，因为它会改 `.app`）；
   - `xcrun notarytool submit <dmg> --wait --output-format json` 提交公证，`Invalid` 时自动拉取官方日志（`notarytool log`）再失败；
   - `xcrun stapler staple` 钉票 + `stapler validate` 校验；
   - `spctl --assess --type install --verbose=4` 模拟 Gatekeeper 评估；
   - 删除装订后必然过期的 `<dmg>.blockmap`（字节已变），并提示 CI 上传步骤跳过它。

   为什么必须「钉票后重打 zip」：electron-updater 在 macOS 上**只认 zip**（dmg 被 `MacUpdater` 显式排除），而 electron-builder 产出的 zip 是在钉票之前打的——里面的 `.app` 没有票据。上游的做法也一样（zip 与 dmg 两条流各自公证+钉票）。未签名时不产出 zip：未签名的 zip 会被 Squirrel.Mac 拒绝，装不了就是装不了，宁可不发（壳侧会诚实提示手动下载 dmg）。

### 2.2 证书与 Team ID 的获取

1. 用 Apple Developer 帐号（Account Holder/Admin）登录 developer.apple.com → Certificates, Identifiers & Profiles → Certificates → `+` → Software → **Developer ID Application**；
2. 需要一份 CSR（在 Mac 的「钥匙串访问」→ 证书助理 → 从证书颁发机构请求证书生成），上传后下载 `.cer` 并双击导入登录钥匙串；
3. 在「钥匙串访问」里选中该证书（含私钥）→ 导出为 `.p12`，设置导出密码：
   ```bash
   export CSC_LINK="$PWD/certs/developer-id-application.p12"
   export CSC_KEY_PASSWORD='<导出 .p12 时设置的密码>'
   # 或者用 base64（CI 常用）：
   # export CSC_LINK="$(base64 -i certs/developer-id-application.p12)"
   ```
4. Team ID 在 developer.apple.com → Membership details 里；也可在证书名括号内看到：
   ```bash
   security find-identity -v -p codesigning
   # 1) ABCD... "Developer ID Application: Example Corp (ABCDEFGHIJ)"
   export DSH_DESKTOP_MACOS_SIGNING_IDENTITY='Example Corp (ABCDEFGHIJ)'
   export DSH_DESKTOP_MACOS_TEAM_ID='ABCDEFGHIJ'
   ```

> 脚本拒绝带 `Developer ID Application: ` 前缀的限定名（与上游一致）：前缀由 `codesign` 自己加，重复前缀会导致身份比对失败。

### 2.3 公证凭据

```bash
# 策略 A：Apple ID + 专用密码（CI 常用）
export APPLE_ID='developer@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='abcd-efgh-ijkl-mnop'
export APPLE_TEAM_ID="$DSH_DESKTOP_MACOS_TEAM_ID"

# 策略 B：App Store Connect API Key
export APPLE_API_KEY='/abs/path/AuthKey_XXXXXXXXXX.p8'
export APPLE_API_KEY_ID='XXXXXXXXXX'
export APPLE_API_ISSUER='00000000-0000-0000-0000-000000000000'

# 策略 C：钥匙串 profile（先存一次）
xcrun notarytool store-credentials DSH-NOTARY \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
export APPLE_KEYCHAIN_PROFILE='DSH-NOTARY'
```

### 2.4 构建 + 公证（macOS 本机）

```bash
export DSH_DESKTOP_MACOS_SIGNING_IDENTITY='Example Corp (ABCDEFGHIJ)'
export DSH_DESKTOP_MACOS_TEAM_ID='ABCDEFGHIJ'
export CSC_LINK="$PWD/certs/developer-id-application.p12"
export CSC_KEY_PASSWORD='...'
export APPLE_ID='developer@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='...'
export APPLE_TEAM_ID="$DSH_DESKTOP_MACOS_TEAM_ID"

# 1) 构建 dmg（内部会用上述证书签名 .app；identity 也可用 --config.mac.identity= 覆盖）
npm run dist:mac

# 2) 对每个架构分别做公证 + 钉票 + 验证
node scripts/package-macos.mjs --release-dir release --arch arm64
node scripts/package-macos.mjs --release-dir release --arch x64
```

常用开关：

```bash
node scripts/package-macos.mjs --dmg release/DSH.Desktop-0.7.18-arm64.dmg   # 指定 dmg
node scripts/package-macos.mjs --app "release/mac-arm64/DSH Desktop.app"    # 只核对 .app 签名
node scripts/package-macos.mjs --skip-notarize                              # 只核对签名，不提交公证
node scripts/package-macos.mjs --skip-spctl                                 # CI 镜像 spctl 不可用时
node scripts/package-macos.mjs --require-signing                            # 缺签名变量直接失败（CI 用）
```

### 2.5 构建后人工校验

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/DSH Desktop.app"
codesign --display --verbose=4 "release/mac-arm64/DSH Desktop.app" | grep -E 'Authority|TeamIdentifier|flags'
xcrun stapler validate release/DSH.Desktop-<版本>-arm64.dmg
spctl --assess --type install --verbose=4 release/DSH.Desktop-<版本>-arm64.dmg
```

### 2.6 未签名 macOS 构建

不设置任何 macOS 签名/公证变量即可：`npm run dist:mac` 正常出 dmg（`electron-builder.yml` 里没有开 `mac.forceCodeSigning`，所以不会因为缺少证书失败）；`scripts/package-macos.mjs` 在这种情况下会打印“跳过公证/钉票”的提示后直接退出。也可显式 `DSH_DESKTOP_UNSIGNED=1`。

未签名 dmg 在用户机器上会被 Gatekeeper 拦截（“无法验证开发者/已损坏”）。仅用于内部测试；要发给外部用户必须走上面的签名 + 公证流程。

### 2.7 macOS 失败模式

| 症状 | 原因 / 处理 |
| --- | --- |
| `DSH_DESKTOP_MACOS_SIGNING_IDENTITY (or CSC_NAME) must contain ...` | 变量未设置/为空白 |
| `must omit the "Developer ID Application:" prefix` | 限定名带了前缀，去掉它 |
| `must contain 10 uppercase letters or digits` | Team ID 抄错/小写/长度不对 |
| `signature does not match the release identity; missing Authority=..., TeamIdentifier=...` | 产物是用**另一张**证书签的：检查 `CSC_LINK`/`CSC_KEY_PASSWORD`、`--config.mac.identity`、以及签名身份是否与 Team ID 匹配 |
| `packaged bundle identifier ... does not match DSH_DESKTOP_APP_ID` | `DSH_DESKTOP_APP_ID` 与 `electron-builder.yml` 的 `appId` 不一致 |
| electron-builder 只打印 `skipped macOS application code signing` 就继续 | 指定身份在钥匙串里找不到（临时钥匙串导入失败、`.p12` 密码错、证书过期）。CI 用 `--config.mac.forceCodeSigning=true` 让它直接失败；本机应看这条警告并检查身份 |
| `notarytool submit exited with 1: ...` / `Invalid` | 常见原因：证书不是 Developer ID、App 未启用 hardened runtime、签名后又被修改、缺少 `--wait` 超时或网络被墙（公司代理见上游文档）、Apple ID 未开双重认证或不属于该团队、API Key 角色不足。脚本会自动打印 Apple 日志（逐条 issue） |
| `stapler validate exited with 65: ... does not have a ticket` | 公证未通过或提交的不是同一个 dmg（例如公证后又重新打包） |
| `spctl exited with 3: rejected` | 未公证/未钉票，或 Gatekeeper 缓存。可 `spctl --assess` 重跑；CI 上用 `--skip-spctl` 跳过（参考环境限制） |
| 公证耗时很长 | 首次公证通常 2–15 分钟；CI 里该步骤加了 `timeout-minutes: 90` |
| 公证后 dmg 的 `.blockmap` 消失 | 预期行为：钉票改变了 dmg 字节，旧 blockmap 必然失效（`merge-mac-manifest.mjs` 会按**实际文件**重算 dmg 与 zip 的 sha512） |
| `--zip` 报 `requires a signed, notarized build` | 未配置签名变量时不产出 zip：未签名 zip 会被 Squirrel.Mac 拒绝，发了也装不上 |
| `--zip` 报 `needs the zip artifact` | 打包命令少了 zip 目标，应用 `npx electron-builder --mac dmg zip ...`（见 `electron-builder.yml` 里 mac 只声明 dmg 的原因） |
| 用户报「更新弹了通知但没动静」（macOS） | 该版本清单里没有 zip（未签名分支），壳会改为诚实提示手动下载；若用户手动检查，应看到「此版本未提供 macOS 自动更新包（zip）」而不是一句「检查更新失败」 |

---

## 3. CI（GitHub Actions）

`.github/workflows/build-release.yml` 的 job 名与产物上传逻辑保持不变，只是新增了「检测 secrets → 签名/未签名二选一」的分支：

- `build-windows`：四个 `DSH_WIN_*` secret 齐全时注入签名变量（并在打包后用 `Get-AuthenticodeSignature` 硬校验），否则不注入任何变量、构建未签名安装包。默认跑 `windows-latest`；要真签名需把仓库变量 `DSH_WINDOWS_RUNNER` 指向插着 SafeNet Token 的 self-hosted Windows runner（托管 runner 没有 USB Token）。
- `build-macos-arm64` / `build-macos-x64`：`MAC_*` + `APPLE_*` secret 齐全时用 `CSC_LINK` 导入证书、`--config.mac.identity` 指定身份、`--config.mac.forceCodeSigning=true` 强制签名，打包命令是 `--mac dmg zip`，再跑 `scripts/package-macos.mjs --require-signing --zip` 做「公证+钉票 .app → 重打 zip → 公证+钉票 dmg → 验证」；否则完全按原样出未签名 dmg（**不产 zip**）。两者都保持 `continue-on-error: true`。上传步骤会带上 zip，并在发现残留的 `<zip>.blockmap` 时直接失败——钉票后重打的 zip 没有有效块图，传上去会让差分下载拿到错基准、最后以 sha512 校验失败收场。
- `merge-mac-manifest`：下载「dmg 必须、blockmap 可选、zip 可选」，合并时按**实际文件**重算 sha512/size（打包期那份早于公证/钉票，已作废）。

需要的 secrets（名称）：

```
DSH_WIN_CER_BASE64, DSH_WIN_SIGNTOOL, DSH_WIN_KEY_CONTAINER, DSH_WIN_TOKEN_PIN
MAC_CSC_LINK, MAC_CSC_KEY_PASSWORD, MAC_SIGNING_IDENTITY, MAC_TEAM_ID
APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
```

可选仓库变量：`DSH_WINDOWS_RUNNER`（self-hosted Windows runner 标签）。

**秘密管理红线**：`DSH_DESKTOP_WINDOWS_TOKEN_PIN` 与 `.p12` 只能作为临时 secret 注入受控机器，绝不提交进仓库、不写 `.env`、不持久化为系统/用户环境变量；签名日志已被脚本脱敏。

---

## 4. 本仓库 `electron-builder.yml` 需要的挂钩（由维护者应用）

以下键指向本仓库的脚本，缺失时签名链路不生效（`scripts/*.mjs` 本身不会被执行）：

```yaml
win:
  signtoolOptions:
    sign: ./scripts/windows-sign.mjs
    signingHashAlgorithms: [sha256]

nsis:
  include: scripts/installer.nsh

mac:
  hardenedRuntime: true   # electron-builder 26.x 非 MAS 默认即为 true，显式写出便于审阅
  notarize: false         # App 的公证交给 scripts/package-macos.mjs，避免重复提交
```

有意**不**采用的项（与上游差异）：`mac.forceCodeSigning: true`（上游在 JS 配置里按环境分支，本仓库 YAML 是静态的，会让无证书构建失败；CI 只在签名分支用命令行 `--config.mac.forceCodeSigning=true`）、`mac.target` 里静态写 `zip`（改成签名分支在命令行上加 `--mac dmg zip`——未签名的 zip 会被 Squirrel.Mac 拒绝，从配置层就不产出可避免误发「装不上」的更新包）、`dmg.writeUpdateInfo: false`（上游的 dmg 不是更新载荷，本仓库的 electron-updater 依赖 `latest-mac.yml`）、`mac.signIgnore`（上游用于跳过预先签好的运行时目录；本仓库运行时是 `resources/dsh` + `resources/runtime` 两棵树（签名时整体排除））。

> 另一种挂法：electron-builder 26.x 允许把钩子写成模块路径字符串，例如
> `afterSign: ./scripts/package-macos.mjs`、`artifactBuildCompleted: ./scripts/package-macos.mjs`
> （本仓库脚本导出了同名函数，26.15.3 的 `resolveFunction` 能解析到）。
> CI 仍选择显式命令行，因为 `--require-signing` 能在缺少签名变量时**直接失败**，
> 而静态钩子只能「跳过 + 警告」；两者不要同时使用，否则会重复提交公证。

> 关于更新签名校验：`win.signtoolOptions.publisherName`（或 `win.publisherName`）一旦填写，
> electron-updater 会在安装前强制校验下载到的安装包签名。EV 证书 CN 固定、且所有发布都会签名时才建议开启；
> 只要还有未签名的发布渠道，就不要填它（本仓库当前默认不填，保持与今天一致的更新行为）。

---

## 5. 未在本机验证的部分（残留风险）

- 本仓库维护环境是 Windows：macOS 的 `codesign`/`notarytool`/`stapler`/`spctl` 链路与 Windows 的 SafeNet Token 链路都需要对应硬件与证书，本机只做了参数、模式判定与错误分支的离线验证，实际签名/公证未跑通。
- `signtool` 命令行参数照搬上游 `windows-sign.cmd`（`/kc "[{{PIN}}]=容器"`、`/csp "eToken Base Cryptographic Provider"`、DigiCert RFC 3161）；不同 SafeNet 版本对 CSP 名称的要求可能不同，首次使用请先用一个测试文件跑一次 `signtool sign ... /debug` 验证。
- `spctl --assess` 在部分 CI/虚拟机镜像上不可用（需要 Gatekeeper 服务），CI 已提供 `--skip-spctl`；真实公证结果仍由 `notarytool` + `stapler validate` 决定。
- electron-builder 的 `win.signtoolOptions.sign` 钩子契约按本仓库锁定的 `electron-builder@26.15.3` 实现（回调参数 `{ path, hash, isNest, ... }`）。升级到未来大版本时需复核 `app-builder-lib` 的 `CustomWindowsSignTaskConfiguration`。
- NSIS 定制只清 `$PLUGINSDIR\7z-out` 并保留错误标志（照搬上游）；应用运行时解压到 `%LOCALAPPDATA%\DSH Desktop\runtime`，不经过 NSIS，因此没有额外注册表/目录清理逻辑。
