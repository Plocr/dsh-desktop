/**
 * 发布前门禁：校验随包运行时树与 `resources/dsh/desktop-runtime.json` **逐文件**一致。
 *
 * 壳在启动时只读描述符（不哈希全树，见 src/main/runtime.ts —— 那是刻意的启动速度取舍），
 * 因此「清单 vs 实际文件」的完整比对放在这里，作为打包/发布流程的显式一步：
 *
 *   npm run verify:runtime
 *
 * 校验内容：壳版本绑定（desktop-runtime.json 的 release.version == package.json version）、
 * 平台/架构、三件共享包清单、以及每个文件的大小与 sha256。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyDesktopRuntime } from '../src/main/runtimeTree.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const runtimeDir = path.join(root, 'resources', 'dsh')

const started = Date.now()
const descriptor = await verifyDesktopRuntime(runtimeDir, pkg.version)
const mb = (descriptor.files.reduce((sum, file) => sum + file.bytes, 0) / 1024 / 1024).toFixed(1)
console.log(
  `[verify] runtime ok: dsh ${descriptor.release.dshVersion} · ${descriptor.files.length} files · ${mb} MB · `
    + `${Date.now() - started}ms`,
)
for (const entry of descriptor.sharedPackages) console.log(`[verify]   shared ${entry.name}@${entry.version}`)
