import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDeepLink, extractDeepLinkFromArgv } from '../src/main/deepLink.ts'

test('parseDeepLink 基本语法', () => {
  assert.deepEqual(parseDeepLink('dsh://'), { kind: 'focus' })
  assert.deepEqual(parseDeepLink('dsh://focus'), { kind: 'focus' })
  assert.deepEqual(parseDeepLink('dsh://new'), { kind: 'new' })
  assert.deepEqual(parseDeepLink('dsh://NEW'), { kind: 'new' })
  assert.deepEqual(parseDeepLink('dsh://session/s-abc-123'), { kind: 'session', sessionId: 's-abc-123' })
})

test('parseDeepLink 编码与容错', () => {
  // 会话 id 可能含特殊字符（URL 编码）
  const action = parseDeepLink('dsh://session/a%2Fb%3Fc')
  assert.equal(action?.kind, 'session')
  assert.equal(action?.sessionId, 'a/b?c')
  // 未知段/畸形输入回退到 focus 或 null
  assert.deepEqual(parseDeepLink('dsh://whatever/xyz'), { kind: 'focus' })
  assert.equal(parseDeepLink('http://example.com'), null)
  assert.equal(parseDeepLink(''), null)
  assert.equal(parseDeepLink(undefined), null)
  assert.equal(parseDeepLink(123), null)
  // session 缺 id → focus
  assert.deepEqual(parseDeepLink('dsh://session/'), { kind: 'focus' })
})

test('extractDeepLinkFromArgv 从 argv 提取', () => {
  const argv = ['C:\\app\\dsh-desktop.exe', 'dsh://new', '--flag']
  assert.equal(extractDeepLinkFromArgv(argv), 'dsh://new')
  assert.equal(extractDeepLinkFromArgv(['a', 'b']), null)
  assert.equal(extractDeepLinkFromArgv([]), null)
  assert.equal(extractDeepLinkFromArgv(null), null)
  assert.equal(extractDeepLinkFromArgv(['x', 42, 'dsh://focus']), 'dsh://focus')
})
