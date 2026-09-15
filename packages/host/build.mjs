/**
 * [ported] Build entry for the ported Desktop Host.
 *
 * Upstream emits `lib/index.js` with tsdown (ESM, node, es2024) from the tsc
 * output in `lib/types`. This repo has no tsdown, so the same artifact is
 * produced from the TypeScript sources with the shell repo's esbuild.
 *
 * Only this package's own code is bundled: `@deepseek-ai/*` specifiers (and
 * Node builtins, which esbuild keeps external for `platform: 'node'`) are left
 * as runtime imports resolved from the dsh runtime tree the Electron shell
 * points the host at. Any other bare specifier is an error, so this package
 * cannot silently grow a dependency the runtime tree does not carry.
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  charset: 'utf8',
  logLevel: 'info',
  banner: {
    js: '/* dsh-desktop-host - adapted from deepseek-ai/deepseek-harness apps/desktop-host (MIT). */',
  },
})
