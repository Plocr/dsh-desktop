/**
 * DeepSeek 计费估算（纯函数，可单测）。
 * 定价来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * （fetched 2026-08-13：deepseek-v4-flash/pro，1M 上下文；
 *  2026-08-16 起改峰谷计价，见 PEAK_OFFPEAK 常量）。
 * 计费规则：https://api-docs.deepseek.com/zh-cn/quick_start/token_usage
 * 总费用 = 输入×缓存命中率×命中单价 + 输入×(1-命中率)×未命中单价 + 输出×输出单价。
 */

export interface ModelPricing {
  /** 每百万 tokens 美元 */
  inputCacheHit: number
  inputCacheMiss: number
  output: number
}

export const PRICING: Record<string, { current: ModelPricing; peakOffpeak?: { peak: ModelPricing; offpeak: ModelPricing } }> = {
  'deepseek-v4-flash': {
    current: { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
    peakOffpeak: {
      peak: { inputCacheHit: 0.014, inputCacheMiss: 0.44, output: 1.32 },
      offpeak: { inputCacheHit: 0.007, inputCacheMiss: 0.22, output: 0.66 },
    },
  },
  'deepseek-v4-pro': {
    current: { inputCacheHit: 0.003625, inputCacheMiss: 0.435, output: 0.87 },
    peakOffpeak: {
      peak: { inputCacheHit: 0.044, inputCacheMiss: 1.32, output: 3.96 },
      offpeak: { inputCacheHit: 0.022, inputCacheMiss: 0.66, output: 1.98 },
    },
  },
}

/** 人民币近似汇率（仅展示参考，可被覆盖）。 */
export const USD_TO_CNY = 7.2

export type PricingMode = 'current' | 'peak' | 'offpeak'

/** 从模型名取定价；未知模型回退 flash。 */
export function resolvePricing(model: string, mode: PricingMode = 'current'): ModelPricing {
  const key = Object.keys(PRICING).find((k) => model.toLowerCase().includes(k))
  const entry = PRICING[key ?? 'deepseek-v4-flash']
  if (mode === 'peak' && entry.peakOffpeak) return entry.peakOffpeak.peak
  if (mode === 'offpeak' && entry.peakOffpeak) return entry.peakOffpeak.offpeak
  return entry.current
}

/** 规范化显示名：DOM 里模型名可能带模式后缀（"DeepSeek-V4-FlashMax"）→ 型号名。 */
export function modelLabel(model: string): string {
  for (const k of Object.keys(PRICING)) {
    if (model.toLowerCase().includes(k)) {
      if (k === 'deepseek-v4-flash') return 'DeepSeek-V4-Flash'
      if (k === 'deepseek-v4-pro') return 'DeepSeek-V4-Pro'
      return k
    }
  }
  return model
}

/** 估算会话费用（USD）。tokens 为累计；cacheHitRate 0..1。 */
export function estimateCost(
  model: string,
  mode: PricingMode,
  inputTokens: number,
  outputTokens: number,
  cacheHitRate: number,
): number {
  const p = resolvePricing(model, mode)
  const hit = Math.min(1, Math.max(0, cacheHitRate))
  const inputHit = inputTokens * hit
  const inputMiss = inputTokens * (1 - hit)
  return (inputHit * p.inputCacheHit + inputMiss * p.inputCacheMiss + outputTokens * p.output) / 1_000_000
}

/** 格式化金额：小额保留更多精度。 */
export function formatUsd(usd: number): string {
  if (usd < 0.1) return `$${usd.toFixed(4)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString()}`
}

export function formatCny(usd: number, rate = USD_TO_CNY): string {
  const cny = usd * rate
  if (cny < 0.1) return `¥${cny.toFixed(3)}`
  if (cny < 100) return `¥${cny.toFixed(2)}`
  return `¥${Math.round(cny).toLocaleString()}`
}
