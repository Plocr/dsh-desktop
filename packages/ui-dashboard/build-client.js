/**
 * build-client.js — 把 ui-dashboard 的动态插件 Client 半边（src/client.js）
 * 转换为持久插件的浏览器 bundle（lib/client.js，随仓库提交，安装无需构建）。
 *
 * 转换内容：
 *  1. 包一层 `window.__ModuleLoader__.load({ id, factory })`（官方 bundle 形态）；
 *  2. `React` 从模块表 require（动态版是 runner 闭包形参）；
 *  3. 提供 `styles`（<style data-plugin="ui-dashboard"> 注入）与 `host`
 *     （apply 时接到 `ctx.connection.rpc.call('/rpc', …)`）两个替身；
 *  4. 把 `return { inject, apply }` 改为 `var plugin = { … }` + exports 导出；
 *  5. `details` 槽位注册补 `priority: -100`，以遮蔽内置工具详情面板（默认 0）。
 *
 * 用法：`node build-client.js`（或 `npm run build`）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(root, 'src', 'client.js'), 'utf8').replace(/\r\n/g, '\n')

// ---- 断言：转换锚点唯一 ----
const returnAnchor = 'return {\n  inject: [\'slots\', \'layout\', \'locale\'],\n  apply(ctx) {'
if ((src.match(/return \{/g) ?? []).length !== 1) throw new Error('expect exactly one `return {`')
if (!src.includes(returnAnchor)) throw new Error('plugin-object anchor not found')

// ---- 1. 插件对象：return -> var plugin，并在 apply 开头接好 host.call ----
const hostWiring = `var plugin = {
  inject: ['slots', 'layout', 'locale'],
  apply(ctx) {
    // ---- 持久安装版：把 host.call 接到 connection 的 /rpc 通道（动态版由 runner 提供 host 形参） ----
    host.call = function (method, args) {
      var conn = ctx.get('connection')
      if (conn === void 0 || conn.rpc === void 0) return Promise.reject(new Error('ui-dashboard: connection service unavailable'))
      return conn.rpc.call('/rpc', method, args === void 0 ? null : args).then(function (r) {
        if (r.ok) return r.value
        throw new Error('ui-dashboard rpc "' + String(method) + '" failed: ' + ((r.error && r.error.message) || 'unknown'))
      })
    }
`
let body = src.replace(returnAnchor, hostWiring)

// ---- 2. details 槽位：priority -100 遮蔽内置面板（内置注册于默认 priority 0） ----
const detailsAnchor = "{ name: 'details', locale: NS, inject: () => ({ closeDetails: () => ctx.layout.closeDetails() }) }"
if (!body.includes(detailsAnchor)) throw new Error('details registration anchor not found')
body = body.replace(detailsAnchor, "{ name: 'details', priority: -100, locale: NS, inject: () => ({ closeDetails: () => ctx.layout.closeDetails() }) }")

// ---- 3. 尾部：闭合 plugin 对象后导出 ----
const tailAnchor = "`), 'ui-dashboard: styles')\n  }\n}\n"
if (!body.endsWith(tailAnchor)) throw new Error('tail anchor not found')
body = body.slice(0, body.length - tailAnchor.length) +
  "`), 'ui-dashboard: styles')\n  }\n}\nexports.inject = plugin.inject\nexports.apply = plugin.apply\n"

// ---- 4. 包装：ModuleLoader factory + React/styles/host ----
const header = `window.__ModuleLoader__.load({
  id: 'ui-dashboard',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    // 持久安装版适配：动态版的 runner 闭包形参（React / styles / host）在此提供。
    var React = require('react');
    var styles = {
      insert: function (css) {
        if (typeof document === 'undefined') return function () {};
        var tag = document.createElement('style');
        tag.dataset.plugin = 'ui-dashboard';
        tag.textContent = css;
        document.head.append(tag);
        return function () { tag.remove(); };
      }
    };
    var host = {
      call: function () {
        return Promise.reject(new Error('ui-dashboard: host.call not wired (apply not run)'));
      }
    };
`

const footer = `
    return module.exports;
  }
});
`

const out = header + body + footer
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), out, 'utf8')
console.log('lib/client.js written:', out.length, 'bytes')
