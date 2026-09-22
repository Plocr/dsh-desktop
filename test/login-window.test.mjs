import { test } from 'node:test'
import assert from 'node:assert/strict'
// 策略是纯函数（不 import electron），因此可以在普通 node 测试里直接跑
import { loginNavigationAllowed, loginUsesExternalBrowser } from '../src/main/loginPolicy.ts'

/**
 * 内置登录窗口的导航白名单（0.8.8）。
 *
 * 背景（真机 2026-09-23）：登录失败的原因是 Host 进程连不上 `platform.deepseek.com`——
 * 卡巴斯基的"加密连接扫描"用自家根证书重建 TLS 链，Chromium 信它、Node 的自带 CA 列表不认
 * （`SELF_SIGNED_CERT_IN_CHAIN`）。修法是让 Host/pnpm 用操作系统证书库（`--use-system-ca`）
 * 并把登录页开在**应用内窗口**里；这个窗口不是通用浏览器，导航必须白名单化。
 */

test('loginNavigationAllowed：允许平台授权域与本机回环回调', () => {
  const platform = 'https://platform.deepseek.com'
  assert.equal(loginNavigationAllowed(`${platform}/dsh/authorize?state=abc`, platform), true)
  assert.equal(loginNavigationAllowed(`${platform}/dsh/authorized?login_source=desktop`, platform), true)
  // Host 的 OAuth 回调（授权完成后平台把 code 打回本机）
  assert.equal(loginNavigationAllowed('http://127.0.0.1:19387/oauth/callback?code=x&state=y', platform), true)
  assert.equal(loginNavigationAllowed('http://localhost:51842/oauth/callback?code=x&state=y', platform), true)
})

test('loginNavigationAllowed：其它地址一律交给系统浏览器', () => {
  const platform = 'https://platform.deepseek.com'
  assert.equal(loginNavigationAllowed('https://evil.example.com/dsh/authorize', platform), false)
  assert.equal(loginNavigationAllowed('https://platform.deepseek.com.evil.com/x', platform), false)
  assert.equal(loginNavigationAllowed('http://platform.deepseek.com/x', platform), false, 'http 降级不算同一源')
  assert.equal(loginNavigationAllowed('file:///C:/Windows/System32/calc.exe', platform), false)
  assert.equal(loginNavigationAllowed('javascript:alert(1)', platform), false)
  assert.equal(loginNavigationAllowed('not a url', platform), false)
  // 带凭据的 URL 不接（防钓鱼地址伪装）
  assert.equal(loginNavigationAllowed('https://user:pass@platform.deepseek.com/dsh/authorize', platform), false)
})

test('loginUsesExternalBrowser：只有显式设了开关才走系统浏览器', () => {
  assert.equal(loginUsesExternalBrowser({}), false)
  assert.equal(loginUsesExternalBrowser({ DSH_DESKTOP_LOGIN_BROWSER: '0' }), false)
  assert.equal(loginUsesExternalBrowser({ DSH_DESKTOP_LOGIN_BROWSER: '1' }), true)
  assert.equal(loginUsesExternalBrowser({ DSH_DESKTOP_LOGIN_BROWSER: 'true' }), true)
})
