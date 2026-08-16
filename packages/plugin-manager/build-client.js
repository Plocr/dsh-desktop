/**
 * build-client.js — 把 dsh-desktop-plugin-manager 的动态插件 Client 半边
 * （src/client.js）转换为持久插件的浏览器 bundle（lib/client.js）。
 *
 * 转换内容（照 ui-dashboard 的 build-client.js 模式）：
 *  1. 包一层 `window.__ModuleLoader__.load({ id, factory })`（官方 bundle 形态）；
 *  2. `React` 从模块表 require（动态版是 runner 闭包形参）；
 *  3. `host` 替身（apply 时接到 `ctx.connection.rpc.call('/rpc', …)`）；
 *  4. `return { inject, apply }` → `var plugin = { … }` + exports 导出。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(root, 'src', 'client.js'), 'utf8').replace(/\r\n/g, '\n')

// ---- 断言：转换锚点唯一 ----
const returnAnchor = 'return {\n  inject: [\'slots\', \'layout\', \'locale\', \'connection\'],\n  apply(ctx) {'
if (!src.includes(returnAnchor)) throw new Error('plugin-object anchor not found')
// 注意：组件里可能还有 `return { ... }`（对象字面量），不能数 `return {` 次数
if ((src.match(new RegExp(returnAnchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length !== 1) {
  throw new Error('plugin-object anchor must be unique')
}

// ---- 1. 插件对象：return -> var plugin，并在 apply 开头接好 host.call ----
const hostWiring = `var plugin = {
  inject: ['slots', 'layout', 'locale', 'connection'],
  apply(ctx) {
    // ---- 持久安装版：把 host.call 接到 connection 的 /pm-rpc 通道 ----
    host.call = function (endpoint, args) {
      var conn = ctx.get('connection')
      if (conn === void 0 || conn.rpc === void 0) return Promise.reject(new Error('plugin-manager: connection service unavailable'))
      return conn.rpc.call('/pm-rpc', endpoint, args === void 0 ? null : { args }).then(function (r) {
        if (r.ok) return r.value
        throw new Error('plugin-manager rpc "' + String(endpoint) + '" failed: ' + ((r.error && r.error.message) || 'unknown'))
      })
    }
`
let body = src.replace(returnAnchor, hostWiring)

// ---- 2. RPC 调用改走 host.call（持久版替身） ----
// client.js 里直接定义了 RPC 闭包用 ctx.connection.rpc.call；这里把函数体替换为 host.call
const rpcAnchor = `    const RPC = (endpoint, args) => {
      const conn = ctx.get('connection')
      if (!conn || !conn.rpc) return Promise.reject(new Error('connection service unavailable'))
      return conn.rpc.call('/pm-rpc', endpoint, args === void 0 ? null : { args }).then((r) => {
        if (r && r.ok) return r.value
        const msg = r && r.error && r.error.message ? r.error.message : 'rpc failed: ' + String(endpoint)
        throw new Error(msg)
      })
    }`
const rpcReplacement = `    const RPC = (endpoint, args) => host.call(endpoint, args)`
if (!body.includes(rpcAnchor)) throw new Error('rpc anchor not found')
body = body.replace(rpcAnchor, rpcReplacement)

// ---- 3. 尾部：闭合 plugin 对象后导出 ----
const tailAnchor = "    )\n  },\n}\n"
if (!body.endsWith(tailAnchor)) throw new Error('tail anchor not found')
body = body.slice(0, body.length - tailAnchor.length) +
  "    )\n  },\n}\nexports.inject = plugin.inject\nexports.apply = plugin.apply\n"

// ---- 4. 包装：ModuleLoader factory + React/styles/host ----
const header = `window.__ModuleLoader__.load({
  id: 'dsh-desktop-plugin-manager',
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
        tag.dataset.plugin = 'dsh-desktop-plugin-manager';
        tag.textContent = css;
        document.head.append(tag);
        return function () { tag.remove(); };
      }
    };
    var host = {
      call: function () {
        return Promise.reject(new Error('plugin-manager: host.call not wired (apply not run)'));
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
