/**
 * build-client.js 鈥?鎶?dsh-desktop-better-setting 鐨勫姩鎬佹彃浠?Client 鍗婅竟
 * 锛坰rc/client.js锛夎浆鎹负鎸佷箙鎻掍欢鐨勬祻瑙堝櫒 bundle锛坙ib/client.js锛夈€? *
 * 杞崲鍐呭锛堢収 ui-dashboard 鐨?build-client.js 妯″紡锛夛細
 *  1. 鍖呬竴灞?`window.__ModuleLoader__.load({ id, factory })`锛堝畼鏂?bundle 褰㈡€侊級锛? *  2. `React` 浠庢ā鍧楄〃 require锛堝姩鎬佺増鏄?runner 闂寘褰㈠弬锛夛紱
 *  3. `host` 鏇胯韩锛坅pply 鏃舵帴鍒?`ctx.connection.rpc.call('/rpc', 鈥?`锛夛紱
 *  4. `return { inject, apply }` 鈫?`var plugin = { 鈥?}` + exports 瀵煎嚭銆? */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(root, 'src', 'client.js'), 'utf8').replace(/\r\n/g, '\n')

// ---- 鏂█锛氳浆鎹㈤敋鐐瑰敮涓€ ----
const returnAnchor = 'return {\n  inject: [\'slots\', \'layout\', \'locale\', \'connection\'],\n  apply(ctx) {'
if (!src.includes(returnAnchor)) throw new Error('plugin-object anchor not found')
// 娉ㄦ剰锛氱粍浠堕噷鍙兘杩樻湁 `return { ... }`锛堝璞″瓧闈㈤噺锛夛紝涓嶈兘鏁?`return {` 娆℃暟
if ((src.match(new RegExp(returnAnchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length !== 1) {
  throw new Error('plugin-object anchor must be unique')
}

// ---- 1. 鎻掍欢瀵硅薄锛歳eturn -> var plugin锛屽苟鍦?apply 寮€澶存帴濂?host.call ----
const hostWiring = `var plugin = {
  inject: ['slots', 'layout', 'locale', 'connection'],
  apply(ctx) {
    // ---- 鎸佷箙瀹夎鐗堬細鎶?host.call 鎺ュ埌 connection 鐨?/pm-rpc 閫氶亾 ----
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

// ---- 2. RPC 璋冪敤鏀硅蛋 host.call锛堟寔涔呯増鏇胯韩锛?----
// client.js 閲岀洿鎺ュ畾涔変簡 RPC 闂寘鐢?ctx.connection.rpc.call锛涜繖閲屾妸鍑芥暟浣撴浛鎹负 host.call
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

// ---- 3. 灏鹃儴锛氶棴鍚?plugin 瀵硅薄鍚庡鍑?----
const tailAnchor = "    )\n  },\n}\n"
if (!body.endsWith(tailAnchor)) throw new Error('tail anchor not found')
body = body.slice(0, body.length - tailAnchor.length) +
  "    )\n  },\n}\nexports.inject = plugin.inject\nexports.apply = plugin.apply\n"

// ---- 4. 鍖呰锛歁oduleLoader factory + React/styles/host ----
const header = `window.__ModuleLoader__.load({
  id: 'dsh-desktop-better-setting',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    // 鎸佷箙瀹夎鐗堥€傞厤锛氬姩鎬佺増鐨?runner 闂寘褰㈠弬锛圧eact / styles / host锛夊湪姝ゆ彁渚涖€?    var React = require('react');
    var styles = {
      insert: function (css) {
        if (typeof document === 'undefined') return function () {};
        var tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-desktop-better-setting';
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
