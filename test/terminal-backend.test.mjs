import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveShellSpec, stripAnsi } from '../src/main/termShell.ts'

test('stripAnsi 剥离 CSI/OSC/字符集序列，保留可读文本', () => {
  const input = '\x1b[31mred\x1b[0m \x1b]0;Title\x07\x1b[1;2H\x1b(B\x1b[?25lOK'
  assert.equal(stripAnsi(input), 'red OK')
  assert.equal(stripAnsi('plain text\r\n'), 'plain text\r\n')
  assert.equal(stripAnsi(''), '')
})

test('resolveShellSpec：Windows 平台映射', { skip: process.platform !== 'win32' }, () => {
  const ps = resolveShellSpec('powershell')
  assert.equal(ps?.cmd, 'powershell.exe')
  assert.ok(ps?.args.includes('-NoLogo'))
  const cmd = resolveShellSpec('cmd')
  assert.equal(cmd?.cmd, 'cmd.exe')
  const auto = resolveShellSpec('auto')
  assert.equal(auto?.cmd, 'powershell.exe')
  const zsh = resolveShellSpec('zsh')
  assert.equal(zsh, null) // Windows 无 zsh
})

test('resolveShellSpec：posix 平台映射', { skip: process.platform === 'win32' }, () => {
  const bash = resolveShellSpec('bash')
  assert.equal(bash?.cmd, 'bash')
  const auto = resolveShellSpec('auto')
  assert.ok(auto?.cmd.length > 0)
})
