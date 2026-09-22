/**
 * DeepSeek API Key 自检（只读、异步、容错）：
 * 读取 $DSH_HOME/.credentials.yaml 中 DEEPSEEK_API_KEY，
 * 调用官方 /user/balance 做一次只读鉴权，判断 key 是否有效。
 *
 * 背景：用户常遇到「key 明明换过却仍报 API key is invalid」——实际是
 * DSH 存储的 key 已失效（官方轮换/重建后未同步，或更新未落盘）。
 * 本模块在壳启动后自检并在托盘/通知中提示 key 状态，避免误判为配置错误。
 *
 * 安全：只在本机发请求，不回显 key（仅日志带尾号）；失败不阻塞主流程。
 */
import { readFileSync } from 'node:fs'

export interface ApiKeyCheckResult {
  /** key 是否被官方接受 */
  ok: boolean
  /**
   * 判定结论：ok=有效；invalid=官方明确拒绝（401/403）；
   * unknown=没能判定（网络/服务异常）——**绝不能**拿 unknown 当"无效"去报警。
   */
  verdict: 'ok' | 'invalid' | 'unknown'
  /** 供日志展示的掩码尾号（如 sk-x3b6…5S5L） */
  masked: string | null
  /** HTTP 状态码（网络错误时为 null） */
  status: number | null
  /** 人类可读说明 */
  detail: string
}

const BASE = 'https://api.deepseek.com'
const TIMEOUT_MS = 10_000

/** 从 .credentials.yaml 提取 DEEPSEEK_API_KEY（简单 YAML 行解析，与官方格式一致）。 */
export function readDeepSeekKeyFromCredentials(credentialsYaml: string): string | null {
  let raw: string
  try {
    raw = readFileSync(credentialsYaml, 'utf8')
  } catch {
    return null
  }
  const m = raw.match(/^[ \t]*DEEPSEEK_API_KEY:[ \t]*"?(.+?)"?[ \t]*$/m)
  return m ? m[1].trim() : null
}

function mask(key: string): string {
  return key.length <= 10 ? '…' + key.slice(-4) : key.slice(0, 7) + '…' + key.slice(-4)
}

/**
 * 校验 key：向官方 /user/balance 发起只读鉴权请求。
 * @param apiKey 可选；缺省从 credentialsYaml 读取。
 */
export async function checkDeepSeekKey(
  credentialsYaml: string,
  apiKey?: string,
  /**
   * 执行请求的实现（缺省 Node 的全局 fetch）。
   *
   * 壳在 Electron 主进程里会传入 **`net.fetch`**（Chromium 网络栈）：它用操作系统证书库，
   * 因此能穿过安全软件的 TLS 扫描；而 Node 的 fetch 只认自带 CA 列表，
   * 真机上会以 `SELF_SIGNED_CERT_IN_CHAIN` 失败（见 hostProcess.ts 的同款说明）。
   */
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): Promise<ApiKeyCheckResult> {
  const key = apiKey ?? readDeepSeekKeyFromCredentials(credentialsYaml)
  if (!key) {
    return {
      ok: false,
      verdict: 'invalid',
      masked: null,
      status: null,
      detail: '未找到 DEEPSEEK_API_KEY（.credentials.yaml 缺失或未配置）',
    }
  }
  const masked = mask(key)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetchImpl(`${BASE}/user/balance`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    })
    if (r.status === 200) {
      return { ok: true, verdict: 'ok', masked, status: 200, detail: `API Key 有效（${masked}）` }
    }
    if (r.status === 401 || r.status === 403) {
      return {
        ok: false,
        verdict: 'invalid',
        masked,
        status: r.status,
        detail: `API Key 无效（${masked}），请到「设置 → 模型」更新`,
      }
    }
    return { ok: false, verdict: 'unknown', masked, status: r.status, detail: `官方返回 HTTP ${r.status}（${masked}）` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      verdict: 'unknown',
      masked,
      status: null,
      detail: `自检请求失败：${err instanceof Error && err.name === 'AbortError' ? '超时' : msg}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
/**
 * 把桥接 `billing.balance` 的回复/错误映射成自检结论（纯函数，可单测）。
 *
 * 为什么优先走桥接：harness 的 credentials 服务会依次看**环境变量**、credentials 文件、
 * dotenv 回退；壳自己解析 `.credentials.yaml` 会在"用户按官方文档用环境变量启动"时
 * 误报「未找到 key」。
 *
 * @param reply - 成功时的 result（`{ infos: [{currency,totalBalance,…}] }`）。
 * @param error - 失败时的错误文案（RPC 的 error 字段）。
 */
export function interpretBalanceReply(reply: unknown, error: string | null): ApiKeyCheckResult {
  if (error === null) {
    const infos = (reply as { infos?: unknown } | undefined)?.infos
    const first = Array.isArray(infos) ? (infos[0] as { currency?: unknown; totalBalance?: unknown } | undefined) : undefined
    const amount =
      first && (typeof first.totalBalance === 'string' || typeof first.totalBalance === 'number')
        ? `${String(first.currency ?? '')} ${String(first.totalBalance)}`.trim()
        : null
    return {
      ok: true,
      verdict: 'ok',
      masked: null,
      status: null,
      detail: amount ? `API Key 有效（余额 ${amount}）` : 'API Key 有效',
    }
  }
  if (/未配置|no.?key|missing/i.test(error)) {
    return { ok: false, verdict: 'invalid', masked: null, status: null, detail: `未找到 DEEPSEEK_API_KEY（${error}）` }
  }
  if (/401|403|无效|invalid|unauthor/i.test(error)) {
    return { ok: false, verdict: 'invalid', masked: null, status: 401, detail: `API Key 无效，请到「设置 → 模型」更新（${error}）` }
  }
  return { ok: false, verdict: 'unknown', masked: null, status: null, detail: `无法判定（${error}）` }
}

/**
 * 只有**权威来源**（桥接 = harness 的凭据服务，能看见环境变量与 dotenv）的否定结论才值得打扰用户。
 * 文件回退只说明"这个文件里没有"：把它当判决会在"用环境变量启动"时误报（本地文件 ≠ 全部来源）。
 */
export function apiKeyNeedsAttention(res: ApiKeyCheckResult, via: 'bridge' | 'file'): boolean {
  return via === 'bridge' && res.verdict === 'invalid'
}

/** 文件回退的文案补一句来源，避免用户以为 key 真的没了。 */
export function fileFallbackDetail(res: ApiKeyCheckResult): string {
  return res.verdict === 'invalid' ? `${res.detail}（本地文件；桥接连接后以 harness 凭据为准）` : res.detail
}
