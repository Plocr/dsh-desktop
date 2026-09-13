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