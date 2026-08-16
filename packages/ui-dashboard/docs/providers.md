# provider 余额/用量 API 调研

> 为 ui-dashboard 的「余额/用量」卡片收集的各平台官方 API 信息。
> 调研时间：2026-08-16。仅收录官方公开文档确认的端点；未确认的一律标「不支持/无公开 API」。
> provider 路由名与 pi-ai catalog（`@earendil-works/pi-ai/dist/providers`）一致；`baseUrl`/`env` 取自 pi-ai 定义。

## 已实现（内置映射）

| provider | 平台 | 形态 | 端点 | key | 状态 |
| --- | --- | --- | --- | --- | --- |
| deepseek | DeepSeek 开放平台 | money | `GET https://api.deepseek.com/user/balance` | `DEEPSEEK_API_KEY` | ✅ 已实现 |
| opencode-go | OpenCode Zen Go | usage | `GET https://opencode.ai/zen/go/v1/usage` | `OPENCODE_GO_API_KEY` | ✅ 已实现 |

## 调研结论（按 provider 路由）

| provider | 平台 | baseUrl（pi-ai） | key（pi-ai env） | 官方余额/用量端点 | 结论 |
| --- | --- | --- | --- | --- | --- |
| openai | OpenAI | https://api.openai.com/v1 | OPENAI_API_KEY | `GET /v1/organization/usage`（用量/花费，需 org admin key，见 [Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage)）；无公开 credits/balance 端点 | ⚠️ 部分 |
| anthropic | Anthropic | https://api.anthropic.com | ANTHROPIC_API_KEY | 成本：`GET /v1/organizations/cost_report`；用量：`GET /v1/organizations/usage_report/messages`（[Usage & Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)，需 Admin key `sk-ant-admin01-…`）；无余额端点 | ⚠️ 部分（普通 key ❌） |
| google | Google Gemini | https://generativelanguage.googleapis.com/v1beta | GEMINI_API_KEY | 无公开余额/用量 API | ❌ |
| google-vertex | Google Cloud Vertex | （ADC/服务账号） | GOOGLE_CLOUD 凭据 | Cloud Billing `projects.getBillingInfo` 仅返回 billingEnabled，无余额；用量需 BigQuery 计费导出 | ❌ |
| amazon-bedrock | AWS Bedrock | （AWS 凭据链） | AWS 凭据 | AWS Cost Explorer `GetCostAndUsage` / Budgets `DescribeBudgets`（[文档](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html)，需 IAM，延迟 ≤24h，无实时余额） | ⚠️ 部分（复杂） |
| azure-openai-responses | Azure OpenAI | （Azure 端点） | AZURE_OPENAI_API_KEY | 无公开配额/余额读取 API；仅 Cost Management Query（[文档](https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage)，需订阅权限） | ❌ |
| mistral | Mistral | https://api.mistral.ai | MISTRAL_API_KEY | 组织级路由 `/v1/admin/usage`、`/v1/admin/spend-limit`（需 org 级 key，官方 SDK 未发布，未确认）；⚠️ 第三方教程宣称的 `dashboard.get_account_usage()`（remaining_quota 等）**已证伪**，勿用 | ⚠️ 部分（org admin，未确认） |
| xai | xAI | https://api.x.ai/v1 | XAI_API_KEY | 官方预付费余额：`GET https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance`（[Management API](https://docs.x.ai/developers/management-api-guide)，需 **Management Key**，余额为美分） | ⚠️ 部分（需 management key + team_id） |
| openrouter | OpenRouter | https://openrouter.ai/api/v1 | OPENROUTER_API_KEY | `GET /api/v1/credits`（total_credits/total_usage，见 [Get remaining credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)） | ✅ 支持 |
| together | Together AI | https://api.together.ai/v1 | TOGETHER_API_KEY | 无公开 REST 端点（仅 dashboard） | ❌ |
| groq | Groq | https://api.groq.com/openai/v1 | GROQ_API_KEY | 无公开 billing/usage 端点 | ❌ |
| cerebras | Cerebras | https://api.cerebras.ai/v1 | CEREBRAS_API_KEY | 无公开 billing/usage 端点 | ❌ |
| fireworks | Fireworks AI | https://api.fireworks.ai/inference | FIREWORKS_API_KEY | `GET /v1/accounts/{account_id}/billing/summary`（[Get billing summary](https://docs.fireworks.ai/api-reference/get-billing-summary)，**端点含 account_id**，非仅 key 直查） | ⚠️ 部分（需 account_id） |
| nvidia | NVIDIA NIM | https://integrate.api.nvidia.com/v1 | NVIDIA_API_KEY | 无公开 credits/balance 端点（[官方论坛确认无法查 credits](https://forums.developer.nvidia.com/t/cannot-find-the-amount-of-credits-left-on-nim-api/337051)） | ❌ |
| huggingface | Hugging Face | https://router.huggingface.co/v1 | HF_TOKEN | `GET https://huggingface.co/api/whoami-v2` 仅返回身份，无 credits 余额（[whoami 讨论](https://discuss.huggingface.co/t/how-do-you-use-the-whoami-endpoint/15830)、[定价与计费](https://huggingface.co/docs/inference-providers/main/en/pricing)） | ⚠️ 部分（无余额） |
| github-copilot | GitHub Copilot | https://api.individual.githubcopilot.com | COPILOT_GITHUB_TOKEN | 用量端点仅企业/组织管理员：`GET /orgs/{org}/copilot/usage`、`/enterprises/{e}/copilot/usage`；个人订阅无余额 API | ⚠️ 部分（个人 ❌） |
| vercel-ai-gateway | Vercel AI Gateway | https://ai-gateway.vercel.sh | AI_GATEWAY_API_KEY | `POST https://api.vercel.com/v1/ai-gateway/usages`（用量/花费，需 Vercel 访问令牌；无"余额"概念） | ⚠️ 部分 |
| cloudflare-ai-gateway | Cloudflare AI Gateway | （Cloudflare 端点） | CF API Token | `GET /accounts/{id}/ai-gateway/billing/usage-history`（需 Bill 权限；用量/花费，无余额） | ⚠️ 部分 |
| cloudflare-workers-ai | Cloudflare Workers AI | （Cloudflare 端点） | CF API Token | 无专用端点；Billable Usage API（GraphQL 计费查询） | ⚠️ 部分 |
| opencode | OpenCode Zen | （opencode 端点） | OPENCODE_API_KEY | 无官方公开余额/用量 API（区别于 opencode-go 的 /zen/go/v1/usage） | ❌ |
| kimi-coding | Kimi For Coding | https://api.kimi.com/coding | KIMI_API_KEY | 标准 API 余额（官方文档确认）：`GET https://api.moonshot.cn/v1/users/me/balance`（available_balance、voucher_balance_list，见 [Kimi 余额消耗查询](https://www.kimi.com/zh-cn/help/kimi-api/api-balance-and-usage)）；Coding 套餐剩余量无公开 API | ⚠️ 部分 |
| ant-ling | Ant Ling | https://api.ant-ling.com/v1 | ANT_LING_API_KEY | 无公开余额/套餐用量 API（仅控制台；注意区分蚂蚁链 BaaS 的 GetBalance） | ❌ |
| moonshotai | Moonshot AI | https://api.moonshot.ai/v1 | MOONSHOT_API_KEY | `GET /v1/users/me/balance`（available/cash/reserved/granted_balance、vouchers）；文档落点已转向 kimi.com/api.moonshot.cn，国际站域名需实测 | ⚠️ 部分 |
| moonshotai-cn | Moonshot AI CN | https://api.moonshot.cn/v1 | MOONSHOT_API_KEY | `GET /v1/users/me/balance`（同上） | ✅ 支持 |
| minimax | MiniMax | https://api.minimax.io/anthropic | MINIMAX_API_KEY | 无公开程序化查询接口（仅控制台） | ❌ |
| minimax-cn | MiniMax CN | https://api.minimaxi.com/anthropic | MINIMAX_CN_API_KEY | 无公开程序化查询接口（仅控制台） | ❌ |
| qwen-token-plan | Qwen Token Plan | https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1 | QWEN_TOKEN_PLAN_API_KEY | 套餐剩余仅百炼控制台；阿里云 BSS `QueryAccountBalance`（[文档](https://www.alibabacloud.com/help/en/user-center/developer-reference/api-bssopenapi-2017-12-14-queryaccountbalance)）只能查云账户现金/代金券余额（需 AccessKey 签名，非套餐剩余） | ⚠️ 部分（云账户余额）/ 套餐 ❌ |
| qwen-token-plan-cn | Qwen Token Plan CN | https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 | QWEN_TOKEN_PLAN_CN_API_KEY | 套餐剩余仅控制台，无 cn 专属端点 | ❌ |
| xiaomi | Xiaomi MiMo | https://api.xiaomimimo.com/v1 | XIAOMI_API_KEY | 社区可用端点（需实测）：`GET https://api.mimogateway.com/v1/users/me/balance`（官方未显式文档化，见 [mimo.mi.com 文档](https://mimo.mi.com/docs/zh-CN/)） | ⚠️ 部分（需实测） |
| xiaomi-token-plan-ams | Xiaomi Token Plan AMS | https://token-plan-ams.xiaomimimo.com/v1 | XIAOMI_TOKEN_PLAN_AMS_API_KEY | 套餐剩余仅控制台，无公开端点 | ❌ |

## 官方文档链接

- DeepSeek 查询余额：https://api-docs.deepseek.com/zh-cn/api/get-user-balance/
- Anthropic Usage & Cost API：https://platform.claude.com/docs/en/manage-claude/usage-cost-api
- OpenRouter Get remaining credits：https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits
- Fireworks Get billing summary：https://docs.fireworks.ai/api-reference/get-billing-summary
