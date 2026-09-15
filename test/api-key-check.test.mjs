import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDeepSeekKeyFromCredentials } from '../src/main/apiKeyCheck.ts'

function yamlFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ak-'))
  const f = join(dir, '.credentials.yaml')
  writeFileSync(f, content)
  return f
}

test('readDeepSeekKeyFromCredentials：标准格式、引号、尾随空白、缺失', () => {
  const f1 = yamlFile('version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-abc123\n  OPENCODE_GO_API_KEY: sk-xyz\n')
  assert.equal(readDeepSeekKeyFromCredentials(f1), 'sk-abc123')

  const f2 = yamlFile('DEEPSEEK_API_KEY: "sk-qqq456"\n')
  assert.equal(readDeepSeekKeyFromCredentials(f2), 'sk-qqq456')

  const f3 = yamlFile('DEEPSEEK_API_KEY: sk-trail   \n')
  assert.equal(readDeepSeekKeyFromCredentials(f3), 'sk-trail')

  const f4 = yamlFile('DEEPSEEK_API_KEY:\n  other: 1\n')
  assert.equal(readDeepSeekKeyFromCredentials(f4), null)
})

test('readDeepSeekKeyFromCredentials：文件缺失返回 null；无该 ref 返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ak-'))
  try {
    assert.equal(readDeepSeekKeyFromCredentials(join(dir, 'missing.yaml')), null)
    const f = yamlFile('refs:\n  OTHER_KEY: sk-x\n')
    assert.equal(readDeepSeekKeyFromCredentials(f), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('interpretBalanceReply：成功 → 有效并带余额；失败分类不误报', async () => {
  const { interpretBalanceReply } = await import('../src/main/apiKeyCheck.ts')

  const ok = interpretBalanceReply(
    { isAvailable: true, infos: [{ currency: 'CNY', totalBalance: '12.34' }] },
    null,
  )
  assert.equal(ok.verdict, 'ok')
  assert.equal(ok.ok, true)
  assert.match(ok.detail, /12\.34/)

  const okNoInfo = interpretBalanceReply({ infos: [] }, null)
  assert.equal(okNoInfo.verdict, 'ok')
  assert.equal(okNoInfo.detail, 'API Key 有效')

  // 未配置 key：harness 侧明确说没配 → invalid（要提示用户去配）
  const missing = interpretBalanceReply(undefined, 'DEEPSEEK_API_KEY 未配置（请在 harness 设置中填写 API key）')
  assert.equal(missing.verdict, 'invalid')
  assert.match(missing.detail, /未找到 DEEPSEEK_API_KEY/)

  // 官方拒绝
  assert.equal(interpretBalanceReply(undefined, '余额查询失败: HTTP 401').verdict, 'invalid')
  assert.equal(interpretBalanceReply(undefined, 'Unauthorized').verdict, 'invalid')

  // 网络/超时类 → unknown：绝不能当成"无效"去报警（这正是本轮修掉的误报）
  assert.equal(interpretBalanceReply(undefined, 'bridge call timeout: billing.balance').verdict, 'unknown')
  assert.equal(interpretBalanceReply(undefined, 'fetch failed').verdict, 'unknown')
  assert.equal(interpretBalanceReply(undefined, '余额查询异常: 连接被重置').verdict, 'unknown')
})
