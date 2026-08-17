/**
 * build-client.js — convert the dynamic-plugin Client half (src/client.js)
 * into the persisted browser bundle (lib/client.js).
 *
 * Transformation (following ui-dashboard's build-client.js pattern):
 *  1. Wrap into `window.__ModuleLoader__.load({ id, factory })` (official bundle shape);
 *  2. `React` required from the module table (the runner closure arg in the dynamic version);
 *  3. `host` shim wired at apply time to `ctx.connection.rpc.call('/pm-rpc', ...)`;
 *  4. `return { inject, apply }` -> `var plugin = { ... }` + exports.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(root, 'src', 'client.js'), 'utf8').replace(/\r\n/g, '\n')

// ---- guard: the transformation anchor must be unique ----
const returnAnchor = 'return {\n  inject: [\'slots\', \'layout\', \'locale\', \'connection\'],\n  apply(ctx) {'
if (!src.includes(returnAnchor)) throw new Error('plugin-object anchor not found')
// note: components may contain other `return { ... }` (object literals); count only the exact anchor
if ((src.match(new RegExp(returnAnchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length !== 1) {
  throw new Error('plugin-object anchor must be unique')
}

// ---- 1. plugin object: return -> var plugin, and wire host.call at apply start ----
const hostWiring = `var plugin = {
  inject: ['slots', 'layout', 'locale', 'connection'],
  apply(ctx) {
    // persisted build: route host.call through connection rpc /pm-rpc
    host.call = function (endpoint, args) {
      var conn = ctx.get('connection')
      if (conn === void 0 || conn.rpc === void 0) return Promise.reject(new Error('better-setting: connection service unavailable'))
      return conn.rpc.call('/pm-rpc', endpoint, args === void 0 ? null : { args }).then(function (r) {
        if (r.ok) return r.value
        throw new Error('better-setting rpc "' + String(endpoint) + '" failed: ' + ((r.error && r.error.message) || 'unknown'))
      })
    }
`
let body = src.replace(returnAnchor, hostWiring)

// ---- 2. reroute RPC calls to host.call (persisted shim) ----
// client.js defines the RPC wrapper around ctx.connection.rpc.call; replace the body
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

// ---- 3. tail: close the plugin object and export ----
const tailAnchor = "    )\n  },\n}\n"
if (!body.endsWith(tailAnchor)) throw new Error('tail anchor not found')
body = body.slice(0, body.length - tailAnchor.length) +
  "    )\n  },\n}\nexports.inject = plugin.inject\nexports.apply = plugin.apply\n"

// ---- 4. wrap: ModuleLoader factory + React/styles/host ----
const header = `window.__ModuleLoader__.load({
  id: 'dsh-desktop-better-setting',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
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
        return Promise.reject(new Error('better-setting: host.call not wired (apply not run)'));
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