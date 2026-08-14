/**
 * 面板注入基础设施：
 * 主进程直接读取面板资产（resources/panel-dist，dev=磁盘 / 打包=asar，fs 透明），
 * 在 harness 文档（http://127.0.0.1:*）dom-ready 时经 insertCSS + executeJavaScript 注入。
 *
 * 注：曾尝试 dsh-shell:// 自定义协议（registerSchemesAsPrivileged + protocol.handle），
 * 主进程自检 200，但渲染层网络服务返回 net::ERR_UNKNOWN_URL_SCHEME（dev 模式实测），
 * 故改为直接注入——与既有主题兜底 CSS 注入同机制，不依赖网络栈，零协议面。
 */
import { app, type BrowserWindow } from 'electron'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { log } from './logger'

let cached: { css: string; js: string; termCss: string; termJs: string } | null = null

function assets(): { css: string; js: string; termCss: string; termJs: string } {
  if (cached) return cached
  const root = path.join(app.getAppPath(), 'resources', 'panel-dist')
  const read = (name: string): string => {
    try {
      return readFileSync(path.join(root, name), 'utf8')
    } catch (err) {
      log('error', `panel asset missing: ${name} (${err instanceof Error ? err.message : String(err)})`)
      return ''
    }
  }
  cached = { css: read('panel.css'), js: read('panel.js'), termCss: read('xterm.css'), termJs: read('term.js') }
  return cached
}

/** 在 harness 文档注入面板（每次导航后调用；面板脚本自身防重入）。 */
export function injectChrome(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const url = win.webContents.getURL()
  if (!url.startsWith('http://127.0.0.1:')) return
  const { css, js } = assets()
  if (!css || !js) return
  void win.webContents.insertCSS(css).catch(() => {})
  void win.webContents
    .executeJavaScript(`(() => {
      if (document.getElementById('dshd-root') || document.querySelector('script[data-dshd-panel]')) return;
      const s = document.createElement('script');
      s.dataset.dshdPanel = '';
      s.textContent = ${JSON.stringify(js)};
      document.documentElement.appendChild(s);
    })()`)
    .catch(() => {})
}

/** 终端 lazy 资产注入（面板首次打开终端时调用）。 */
export function injectTerminalAssets(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const { termCss, termJs } = assets()
  if (!termCss || !termJs) return
  void win.webContents.insertCSS(termCss).catch(() => {})
  void win.webContents
    .executeJavaScript(`(() => {
      if (document.getElementById('dshd-term-xterm')?.dataset.dshdBooted) return;
      const s = document.createElement('script');
      s.dataset.dshdTerm = '';
      s.textContent = ${JSON.stringify(termJs)};
      document.documentElement.appendChild(s);
    })()`)
    .catch(() => {})
}
