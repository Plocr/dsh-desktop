/**
 * 登录窗口的**纯策略**（不依赖 electron，故可单测）：导航白名单 + 打开方式选择。
 *
 * 真机背景（2026-09-23）：登录失败的真正原因是 Host 进程连不上 `platform.deepseek.com`——
 * 卡巴斯基的"加密连接扫描"用自家根证书重建 TLS 链，Chromium/浏览器信它、Node 自带 CA 列表不认
 * （`SELF_SIGNED_CERT_IN_CHAIN`）。修法两件：Host/pnpm 加 `--use-system-ca` 用操作系统证书库；
 * 登录页默认开在**应用内窗口**（不依赖系统默认浏览器），失败再退回系统浏览器。
 */

/** 平台授权域（与账号插件默认的 platformOrigin 一致）。 */
export const DEFAULT_PLATFORM_ORIGIN = 'https://platform.deepseek.com'

/**
 * 这个地址允许在登录窗口内导航吗。
 *
 * 只放行两类：**平台授权域**（同一源）与**本机回环回调**（Host 的 `/oauth/callback`，
 * 授权完成后平台把 code 打回这里）。其余一律交给系统浏览器——登录窗口不是通用浏览器。
 * @param url - 目标地址
 * @param platformOrigin - 允许的平台源
 */
export function loginNavigationAllowed(url: string, platformOrigin: string = DEFAULT_PLATFORM_ORIGIN): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '') return false
  if (parsed.origin === platformOrigin) return true
  if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return true
  return false
}

/**
 * 是否强制用系统浏览器打开登录页（`DSH_DESKTOP_LOGIN_BROWSER=1`）。
 * 给"我就是要用浏览器授权"的用户留的后门；默认走应用内窗口。
 */
export function loginUsesExternalBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DSH_DESKTOP_LOGIN_BROWSER
  return value === '1' || value === 'true'
}
