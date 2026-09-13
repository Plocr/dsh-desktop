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
): Promise<ApiKeyCheckResult> {
  const key = apiKey ?? readDeepSeekKeyFromCredentials(credentialsYaml)
  if (!key) {
    return { ok: false, masked: null, status: null, detail: '未找到 DEEPSEEK_API_KEY（.credentials.yaml 缺失或未配置）' }
  }
  const masked = mask(key)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`${BASE}/user/balance`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    })
    if (r.status === 200) {
      return { ok: true, masked, status: 200, detail: `API Key 有效（${masked}）` }
    }
    if (r.status === 401) {
      return { ok: false, masked, status: 401, detail: `API Key 无效（${masked}），请到「设置 → 模型」更新` }
    }
    return { ok: false, masked, status: r.status, detail: `官方返回 HTTP ${r.status}（${masked}）` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      masked,
      status: null,
      detail: `自检请求失败：${err instanceof Error && err.name === 'AbortError' ? '超时' : msg}`,
    }
  } finally {
    clearTimeout(timer)
  }
}