/**
 * 开发期把 dsh-desktop-bridge 以 junction 链接进 desktop profile 的 node_modules，
 * 使 overlay 的 `name:` 行（从 profile 目录解析）能加载该插件。
 * （生产打包：壳在首次创建 profile 时从 resources/bridge 复制，见 src/main/runtime.ts。）
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileNodeModules = path.join(dshHome, 'profiles', 'desktop', 'node_modules')
const link = path.join(profileNodeModules, 'dsh-desktop-bridge')
const target = path.resolve('packages', 'bridge')

mkdirSync(profileNodeModules, { recursive: true })

if (existsSync(link)) {
  let ok = false
  try {
    ok = lstatSync(link).isSymbolicLink() && path.resolve(readlinkSync(link)) === target
  } catch {
    /* broken link */
  }
  if (ok) {
    console.log(`[dev-link] bridge 已链接: ${link}`)
    process.exit(0)
  }
  console.error(`[dev-link] ${link} 已存在但不是指向本仓库的链接，请手动处理`)
  process.exit(1)
}

symlinkSync(target, link, 'junction')
console.log(`[dev-link] ${link} -> ${target}`)
