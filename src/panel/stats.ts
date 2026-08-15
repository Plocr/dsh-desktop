/**
 * harness 会话统计 DOM 解析（纯函数，可单测）。
 * 数据源：会话 footer 的 stats 行（FJxK0a_root，实测格式）：
 *   "3 轮 · 6 步| LLM 16.2s · 工具调用 9.7s| 首 token 平均 1.2s · 140 tok/s| 缓存命中 82%| 输入 450K tok · 输出 1.2K tok"
 * 与上下文区：
 *   "上下文已用 8%"（button aria-label）
 *   "~80.6K / 1M"（当前 / 窗口上限）
 */

export interface HarnessStats {
  turns: number | null
  steps: number | null
  llmMs: number | null
  toolMs: number | null
  ttftAvgMs: number | null
  tokPerSec: number | null
  cacheHitPct: number | null
  inputTokens: number | null
  outputTokens: number | null
  raw: string
}

/** "450K" / "1.2K" / "81.5M" / "123456" → 数字。 */
export function parseTokens(text: string): number | null {
  const m = /^([\d.]+)\s*([KMB])?$/i.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit = (m[2] ?? '').toUpperCase()
  if (unit === 'K') return Math.round(n * 1e3)
  if (unit === 'M') return Math.round(n * 1e6)
  if (unit === 'B') return Math.round(n * 1e9)
  return Math.round(n)
}

/** "16.2s" / "37m27s" / "2.5m" → 毫秒。 */
export function parseDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([hms])$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]
  if (unit === 'h') return Math.round(n * 3_600_000)
  if (unit === 'm') return Math.round(n * 60_000)
  return Math.round(n * 1000)
}

/** 解析 stats 行文本。解析失败字段为 null（容错：harness 升级改文案）。 */
export function parseHarnessStats(text: string): HarnessStats {
  const s = text.replace(/\s+/g, ' ')
  const out: HarnessStats = {
    turns: null,
    steps: null,
    llmMs: null,
    toolMs: null,
    ttftAvgMs: null,
    tokPerSec: null,
    cacheHitPct: null,
    inputTokens: null,
    outputTokens: null,
    raw: text,
  }
  const turnStep = /(\d+)\s*轮\s*·\s*(\d+)\s*步/.exec(s)
  if (turnStep) {
    out.turns = Number(turnStep[1])
    out.steps = Number(turnStep[2])
  }
  const llm = /LLM\s+([\d.]+[hms])\s*·\s*工具调用\s+([\d.]+[hms])/.exec(s)
  if (llm) {
    out.llmMs = parseDuration(llm[1])
    out.toolMs = parseDuration(llm[2])
  }
  const ttft = /首\s*token\s*平均\s+([\d.]+[hms])\s*·\s*([\d.]+)\s*tok\/s/.exec(s)
  if (ttft) {
    out.ttftAvgMs = parseDuration(ttft[1])
    out.tokPerSec = Number(ttft[2]) || null
  }
  const cache = /缓存命中\s+(\d+(?:\.\d+)?)%/.exec(s)
  if (cache) out.cacheHitPct = Number(cache[1])
  const io = /输入\s+([\d.]+\s*[KMB]?)\s*tok\s*·\s*输出\s+([\d.]+\s*[KMB]?)\s*tok/i.exec(s)
  if (io) {
    out.inputTokens = parseTokens(io[1])
    out.outputTokens = parseTokens(io[2])
  }
  return out
}

export interface ContextUsage {
  /** 0..100 */
  percent: number | null
  /** 当前已用（tokens） */
  usedTokens: number | null
  /** 上下文窗口（tokens），如 1M */
  windowTokens: number | null
  /** 构成：系统提示词/工具/对话消息（tokens），可能缺失 */
  breakdown: { system?: number | null; tools?: number | null; messages?: number | null }
  raw: string
}

/** 从"~80.6K / 1M"解析。 */
export function parseContextWindow(text: string): { used: number | null; window: number | null } {
  const m = /~?\s*([\d.]+\s*[KMB]?)\s*\/\s*([\d.]+\s*[KMB]?)/i.exec(text.trim())
  if (!m) return { used: null, window: null }
  return { used: parseTokens(m[1]), window: parseTokens(m[2]) }
}

/** 聚合上下文按钮 aria-label + 明细文本。 */
export function parseContextUsage(ariaLabel: string, detailText: string): ContextUsage {
  const out: ContextUsage = { percent: null, usedTokens: null, windowTokens: null, breakdown: {}, raw: detailText }
  const pct = /上下文已用\s+(\d+(?:\.\d+)?)%/.exec(ariaLabel)
  if (pct) out.percent = Number(pct[1])
  const w = parseContextWindow(detailText)
  out.usedTokens = w.used
  out.windowTokens = w.window
  const sys = /系统提示词\s*~?\s*([\d.]+\s*[KMB]?)/.exec(detailText)
  if (sys) out.breakdown.system = parseTokens(sys[1])
  const tools = /工具\s*~?\s*([\d.]+\s*[KMB]?)/.exec(detailText)
  if (tools) out.breakdown.tools = parseTokens(tools[1])
  const msg = /对话消息\s*~?\s*([\d.]+\s*[KMB]?)/.exec(detailText)
  if (msg) out.breakdown.messages = parseTokens(msg[1])
  return out
}

/** deepseek-v4 系列上下文窗口（tokens；官方定价/模型文档同源，harness 未展开明细时用）。 */
export const CONTEXT_WINDOW_DEFAULT = 1_000_000

/** 明细缺失时按百分比估算已用 tokens（百分比为整数，结果近似）。 */
export function estimateUsedTokens(percent: number, windowTokens = CONTEXT_WINDOW_DEFAULT): number {
  const pct = Math.min(100, Math.max(0, percent))
  return Math.round((pct / 100) * windowTokens)
}
