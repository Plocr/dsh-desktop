import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateCost, formatUsd, formatCny, resolvePricing, modelLabel, PRICING } from '../src/panel/pricing.ts'
import { parseHarnessStats, parseTokens, parseDuration, parseContextUsage, parseContextWindow, estimateUsedTokens, CONTEXT_WINDOW_DEFAULT } from '../src/panel/stats.ts'

test('parseTokens：K/M/B 与裸数字', () => {
  assert.equal(parseTokens('450K'), 450_000)
  assert.equal(parseTokens('1.2K'), 1200)
  assert.equal(parseTokens('81.5M'), 81_500_000)
  assert.equal(parseTokens('123456'), 123456)
  assert.equal(parseTokens('abc'), null)
  assert.equal(parseTokens(''), null)
})

test('parseDuration：s/m/h', () => {
  assert.equal(parseDuration('16.2s'), 16_200)
  assert.equal(parseDuration('2.5m'), 150_000)
  assert.equal(parseDuration('37m27s'), null) // 复合格式不支持（stats 行为单单位）
  assert.equal(parseDuration('1h'), 3_600_000)
})

test('parseHarnessStats：完整行', () => {
  const s = parseHarnessStats(
    '3 轮 · 6 步| LLM 16.2s · 工具调用 9.7s| 首 token 平均 1.2s · 140 tok/s| 缓存命中 82%| 输入 450K tok · 输出 1.2K tok',
  )
  assert.equal(s.turns, 3)
  assert.equal(s.steps, 6)
  assert.equal(s.llmMs, 16_200)
  assert.equal(s.toolMs, 9_700)
  assert.equal(s.ttftAvgMs, 1200)
  assert.equal(s.tokPerSec, 140)
  assert.equal(s.cacheHitPct, 82)
  assert.equal(s.inputTokens, 450_000)
  assert.equal(s.outputTokens, 1200)
})

test('parseHarnessStats：容错（缺字段/空）', () => {
  const s = parseHarnessStats('')
  assert.equal(s.turns, null)
  assert.equal(s.cacheHitPct, null)
  const partial = parseHarnessStats('5 轮 · 302 步| 缓存命中 100%')
  assert.equal(partial.turns, 5)
  assert.equal(partial.steps, 302)
  assert.equal(partial.cacheHitPct, 100)
  assert.equal(partial.inputTokens, null)
})

test('parseContextWindow：~80.6K / 1M', () => {
  const w = parseContextWindow('~80.6K / 1M')
  assert.equal(w.used, 80_600)
  assert.equal(w.window, 1_000_000)
  assert.deepEqual(parseContextWindow(''), { used: null, window: null })
})

test('parseContextUsage：按钮 aria + 明细', () => {
  const u = parseContextUsage(
    '上下文已用 8%',
    '上下文已用 8% ~80.6K / 1M 系统提示词 ~1.5K 工具 ~6.7K 对话消息 ~85K',
  )
  assert.equal(u.percent, 8)
  assert.equal(u.usedTokens, 80_600)
  assert.equal(u.windowTokens, 1_000_000)
  assert.equal(u.breakdown.system, 1500)
  assert.equal(u.breakdown.tools, 6700)
  assert.equal(u.breakdown.messages, 85_000)
})

test('estimateUsedTokens：明细缺失时按百分比估算（≈）', () => {
  assert.equal(estimateUsedTokens(8), 80_000)
  assert.equal(estimateUsedTokens(78), 780_000)
  assert.equal(estimateUsedTokens(100), CONTEXT_WINDOW_DEFAULT)
  assert.equal(estimateUsedTokens(120), CONTEXT_WINDOW_DEFAULT) // clamp
  assert.equal(estimateUsedTokens(-5), 0) // clamp
  assert.equal(estimateUsedTokens(8, 2_000_000), 160_000) // 自定义窗口
})

test('estimateCost：缓存命中率影响费用', () => {
  // 450K 输入（82% 命中）+ 1.2K 输出，flash
  const cost = estimateCost('deepseek-v4-flash', 'current', 450_000, 1200, 0.82)
  const expectHit = 450_000 * 0.82 * 0.0028 / 1e6
  const expectMiss = 450_000 * 0.18 * 0.14 / 1e6
  const expectOut = 1200 * 0.28 / 1e6
  assert.ok(Math.abs(cost - (expectHit + expectMiss + expectOut)) < 1e-9)
  // 全缓存命中 < 全未命中
  assert.ok(estimateCost('deepseek-v4-flash', 'current', 1e6, 0, 1) < estimateCost('deepseek-v4-flash', 'current', 1e6, 0, 0))
})

test('resolvePricing：模型匹配与未知回退', () => {
  assert.equal(resolvePricing('DeepSeek-V4-Flash').inputCacheMiss, PRICING['deepseek-v4-flash'].current.inputCacheMiss)
  const peak = PRICING['deepseek-v4-pro'].peakOffpeak
  assert.equal(resolvePricing('deepseek-v4-pro', 'peak').output, peak ? peak.peak.output : -1)
  assert.equal(resolvePricing('unknown-model').inputCacheMiss, PRICING['deepseek-v4-flash'].current.inputCacheMiss)
})

test('modelLabel：模式后缀规范化', () => {
  assert.equal(modelLabel('DeepSeek-V4-FlashMax'), 'DeepSeek-V4-Flash')
  assert.equal(modelLabel('deepseek-v4-pro thinking'), 'DeepSeek-V4-Pro')
  assert.equal(modelLabel('unknown-model'), 'unknown-model')
  // 带后缀的模型名定价仍匹配正确
  assert.equal(resolvePricing('DeepSeek-V4-FlashMax').inputCacheMiss, PRICING['deepseek-v4-flash'].current.inputCacheMiss)
})

test('formatUsd / formatCny', () => {
  assert.equal(formatUsd(0.0127), '$0.0127')
  assert.equal(formatUsd(1.234), '$1.23')
  assert.equal(formatCny(0.0127), '¥0.091')
  assert.equal(formatCny(50), '¥360')
})
