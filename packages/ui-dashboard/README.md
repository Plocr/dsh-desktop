# ui-dashboard

DeepSeek Harness（DSH）仪表盘 UI 插件。

以可视化方式展示当前会话的**上下文占用、Token 用量与费用估算、DeepSeek 账户余额、会话统计、目标、待办、后台任务与工作区信息**，支持两种展示形态：

- **右侧栏**：占据 shell 内置的 `details` 槽位（右侧第三栏，同官方 `ui-sidebar` 占据 `sidebar` 的方式），通过会话头部工具区的「仪表盘」按钮打开；
- **会话标签页**：注册进 `conversation.view` 槽位（加法席位），与内置「对话」「轨迹」标签并列，点击「仪表盘」标签整页查看。

## 功能

| 卡片 | 内容 | 数据来源 |
| --- | --- | --- |
| 上下文 | 左：粗圆环（14px 描边，按系统提示/工具/消息三色分段，百分比内嵌环心）；右：组成列表 + 比例条 | `contextPressure` / `contextBreakdown` 投影 |
| 用量 · 费用 · 统计（融合版块） | KPI 汇总格（轮次/步骤/总 Token/费用 ¥）→ 金额占比单条图 → 行内 `token · 金额` → 合计 → 统计徽章（模型/工具耗时、平均首字延迟、生成速度） | `tokenUsage` / `sessionStats` 投影 + Host 模型选择 |
| 余额/用量 | 跟随当前 provider：DeepSeek 官方显示金额（币种总额 + 充值/赠送）；OpenCode Go 显示套餐用量（rolling/weekly/monthly 已用百分比 + 重置时间）；带手动刷新按钮 | Host RPC `balance`（按 provider 路由分发到官方 API：[DeepSeek](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/) / [OpenCode Go](https://opencode.ai/zen/go/v1/usage)） |
| 目标 | 目标文（两行截断）+ 阶段 + 轮次进度条 | `goal` 投影 |
| 待办 | 完成进度条 + 状态圆点列表 + 汇总 | `todos` 投影 |
| 后台任务 | 状态计数徽章 + 任务列表 | `useSessions().jobsBySession` |
| 工作区 | 标题 + 路径 | `useWorkspaces` 反查 |

费用估算：按 DeepSeek 官方人民币公开价（deepseek-chat：未缓存输入 ¥2 / 缓存命中 ¥0.5 / 输出 ¥8 每百万 tokens；deepseek-reasoner：¥4 / ¥1 / ¥16），
基于 `tokenUsage` 投影分桶计算；当前模型由 Host 半边通过 RPC `current-model` 读取默认模型选择。仅为估算，可能与实际账单不符。

### 余额/用量：跟随 provider，按各服务商官方 API 计算

卡片**跟随当前默认模型的 provider 路由**（`agentDefaultModel.currentSelection()`），
按 provider 分发到对应官方 API。三种形态：

- `money`（金额）：币种总额 + 充值/赠送明细 —— DeepSeek、Moonshot(Kimi)
- `usage`（用量百分比窗口）：rolling(5h)/weekly/monthly + 重置时间 —— OpenCode Go
- `credits`（预付费余额）：总量 / 已用 / 剩余 —— OpenRouter

**内置映射**（用该 provider 自己的 API key 即可直查）：

| provider 路由 | 形态 | 数据来源 |
| --- | --- | --- |
| `deepseek-official` | money | `GET https://api.deepseek.com/user/balance`（[官方文档](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)） |
| `opencode-go` | usage | `GET https://opencode.ai/zen/go/v1/usage` |
| `openrouter` | credits | `GET https://openrouter.ai/api/v1/credits`（[文档](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)） |
| `moonshotai-cn` | money | `GET https://api.moonshot.cn/v1/users/me/balance`（[Kimi 余额文档](https://www.kimi.com/zh-cn/help/kimi-api/api-balance-and-usage)） |

**有端点但需实测/自行配置**（未内置）：

- `kimi-coding`：标准余额端点与 `moonshotai-cn` 相同（`api.moonshot.cn/v1/users/me/balance`，用 `KIMI_API_KEY`）；Coding 套餐剩余量无公开 API；
- `xiaomi`：社区端点 `GET https://api.mimogateway.com/v1/users/me/balance`（官方未显式文档化，需实测后按 `balance.providers` 配置）；
- `fireworks`：官方 `GET /v1/accounts/{account_id}/billing/summary`（[文档](https://docs.fireworks.ai/api-reference/get-billing-summary)）**端点含 account_id**，需先拿到账户 id 再配置。

**未内置/不支持的 provider**（完整调研见 `docs/providers.md`）：

- **有官方端点但需额外凭据（企业/云计费）**：`openai`（org admin key）、`anthropic`（Admin key）、
  `github-copilot`（仅企业管理员）、`vercel-ai-gateway`/`cloudflare-ai-gateway`/`cloudflare-workers-ai`（需平台 token，无"余额"概念）、
  `amazon-bedrock`（AWS Cost Explorer，需 IAM）、`qwen-token-plan`（阿里云 BSS 云账户余额，非套餐）、
  `mistral`（org 级 `/v1/admin/*`，官方 SDK 未发布）、`xai`（`management-api.x.ai` prepaid/balance，需 Management Key）——
  可在 `balance.providers` 里自行配置；
- **无公开余额/用量 API（仅控制台）**：`google`、`google-vertex`、`azure-openai-responses`、`together`、`groq`、
  `cerebras`、`nvidia`、`huggingface`（whoami 无 credits）、`opencode`、`ant-ling`、`qwen-token-plan-cn`、
  `xiaomi-token-plan-ams`、`minimax`、`minimax-cn`、`moonshotai`（国际站域名待实测）。

- 未在映射中的路由 → 卡片明确提示"provider 无可用余额/用量来源"；
- 未配置对应 key → 提示"未配置 {keyRef}"。
- API key 只在 harness 进程内解析（credentials 服务），不会下发到浏览器。

**自定义来源**：可在插件配置中声明 `balance.providers`（持久安装版在 profile 的
`cordis.patch.yml` 条目里加 `config`）：

```yaml
- insert:
    - id: ui-dashboard
      name: ui-dashboard
      config:
        balance:
          providers:
            my-route:                    # provider 路由名
              kind: credits              # money | usage | credits
              shape: openrouter          # deepseek | moonshot | opencode | openrouter（缺省按 kind 推断）
              keyRef: MY_API_KEY         # credentials 中的 key 引用
              baseUrl: https://api.example.com
              path: /credits             # 默认：money → /user/balance，usage → /usage，credits → /credits
```

- `kind: money` 期望返回 `balance_infos[]`（DeepSeek 同构）或 Moonshot 式顶层 `available_balance` 等字段（shape: moonshot）；
- `kind: usage` 期望返回 `usage.{rolling,weekly,monthly}.{status,percent,resetsAt}`（OpenCode Go 同构）；
- `kind: credits` 期望返回 `total_credits`/`total_usage`（OpenRouter 同构，兼容 `credits`/`balance`/`usage` 等字段名）。

## 安装（给其他人）

三种方式任选。**方式一最省事且热生效（无需重启）**；方式二是 DSH 官方插件管理路径；方式三是内存态动态插件。

### 方式一：一键安装脚本（推荐）

```bash
git clone https://github.com/Plocr/ui-dashboard.git
cd ui-dashboard
node scripts/install.mjs                  # 默认安装到 desktop profile
node scripts/install.mjs --profile=web    # 指定 profile
```

脚本会把 `package.json` + `lib/`（已构建的持久插件双半）复制到
`$DSH_HOME/profiles/<profile>/node_modules/ui-dashboard/`，并在该 profile 的
`cordis.patch.yml` 中幂等插入插件条目（`cordis.patch.yml` 被 DSH 热监听，通常立即生效）。
然后刷新 DSH 页面（未热生效就重启 app），打开任意会话即可看到入口。

### 方式二：DSH 官方插件管理（`dsh plugin`）

仓库同时是合规的 DSH **bundle**（`package.json` 声明 `dsh.bundle.patch`），可用官方命令安装：

```bash
# 需要 pnpm（dsh plugin 会在 profile 目录转发给 pnpm）
dsh plugin --profile desktop add git+https://github.com/Plocr/ui-dashboard.git
```

`lib/` 已随仓库提交、安装无需构建（无需 allowBuilds）。完成后**重启 app**（bundle 层在启动时解析），
插件会作为 profile 层自动加载。卸载：`dsh plugin --profile desktop remove ui-dashboard`。

### 方式三：动态插件（内存态，重启即失）

在 DSH 会话中用 Cordis 动态插件机制加载：

1. 用 `cordis_define` 定义插件（`idPrefix` 建议 `udash`）：`src/client.js` 内容作为 `code.client`、`src/host.js` 内容作为 `code.host`；
2. `cordis_run` 激活（首次需在界面批准）；
3. 打开任意会话 → 会话头部「仪表盘」按钮 / 会话标签「仪表盘」。

动态包只存在于共享 DSH 进程内存，`cordis_stop`/`cordis_undefine` 或重启后消失；要保留请用方式一或二。

## 使用

打开任意会话 → 点会话头部工具区「仪表盘」按钮（右侧栏展开仪表盘），或点会话标签栏的「仪表盘」标签（整页查看）。
右上角 × 关闭右侧栏。

## 架构

- **`src/client.js`**：Client 半边源码（动态插件函数体，无 JSX/TS）。注册：
  - `details` 槽位（single / session 作用域）→ 右侧栏仪表盘主体 `DashboardPanel`
  - `conversation.view` 槽位（list，加法席位，id: `dashboard`，order: 20）→ 会话标签页「仪表盘」
  - `conversation.session.header.utilities` 槽位（list，加法席位，id: `dashboard`）→ 「仪表盘」入口按钮
  - 包级样式经 `styles.insert()` 注入（`udash-` 前缀类名，随插件卸载自动清理）
  - 中英文文案经 `ctx.locale.register('dashboard', { zh, en })`
- **`src/host.js`**：Host 半边源码（动态形式，`harness.handle('current-model')`）。
- **`lib/`**：持久插件构建产物（随仓库提交）。`lib/client.js` 由 `build-client.js` 从 `src/client.js` 生成
  （`__ModuleLoader__` 包装、`require('react')`、`styles`/`host` 替身、`details` 注册补 `priority: -100` 遮蔽内置面板）；
  `lib/index.js` 是持久 Host 半边（`ctx.connection.rpc.handle('/rpc')` 提供 `current-model`）。
- **`scripts/install.mjs`**：一键安装脚本（方式一）。
- **`bundle.patch.yml`**：bundle 层 patch（方式二）。

改动 `src/client.js` 后运行 `node build-client.js` 重新生成 `lib/client.js`。

## 卸载

- 方式一安装：删除 `<profile>/cordis.patch.yml` 里的 `- insert: … ui-dashboard …` 块，并删除 `<profile>/node_modules/ui-dashboard/`；
- 方式二安装：`dsh plugin --profile <profile> remove ui-dashboard`。

## 兼容性

- 依赖 DSH 官方 Client 槽位与投影接口（`details`、`conversation.view`、`conversation.session.header.utilities`、`contextPressure`、`contextBreakdown`、`tokenUsage`、`sessionStats`、`goal`、`todos`、`jobsBySession`），随 DSH 版本演进可能需要适配。
- 占据 `details` 槽位会替换内置的「工具调用详情」面板（官方标注 replaceRisk: shadows-shipped-ui），当前版本未内嵌 `conversation.details.tool` 子席位。

## License

MIT
