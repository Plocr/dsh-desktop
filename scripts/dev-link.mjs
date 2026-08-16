/**
 * 开发期：把 packages/ 下每个桌面插件（bridge / ui-dashboard …）以 junction
 * 链接进 desktop profile 的 node_modules，使 overlay 的 `name:` 行（从 profile
 * 目录解析）能加载该插件，且 dev 始终使用仓库源码。
 * （生产打包：壳在首次创建 profile 时从 resources/plugins 复制，见 src/main/runtime.ts。）
 *
 * 若目标已存在且是真实目录（例如打包版首启的同步副本），直接替换为 junction，
 * 保证 dev 始终加载仓库里的最新源码。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileNodeModules = path.join(dshHome, 'profiles', 'desktop', 'node_modules')
const packagesDir = path.resolve('packages')

mkdirSync(profileNodeModules, { recursive: true })

for (const name of readdirSync(packagesDir)) {
  if (name.startsWith('.')) continue
  const target = path.join(packagesDir, name)
  let isDir = false
  try {
    isDir = statSync(target).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) continue

  // 链接名用包名（package.json 的 name），不是目录名——overlay `name:` 按包名解析
  let pkgName = name
  try {
    const pkg = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'))
    if (typeof pkg.name === 'string' && pkg.name) pkgName = pkg.name
  } catch {
    /* 无 package.json 的目录跳过链接 */
    console.warn(`[dev-link] ${name}: 缺少 package.json，跳过`)
    continue
  }

  const link = path.join(profileNodeModules, pkgName)
  if (existsSync(link)) {
    let isLink = false
    try {
      isLink = lstatSync(link).isSymbolicLink()
    } catch {
      /* broken link */
    }
    if (isLink && path.resolve(readlinkSync(link)) === target) {
      console.log(`[dev-link] ${pkgName} 已链接: ${link}`)
      continue
    }
    console.warn(`[dev-link] ${link} 存在但不是指向本仓库的链接（可能是旧同步副本），替换为 junction`)
    rmSync(link, { recursive: true, force: true })
  }

  symlinkSync(target, link, 'junction')
  console.log(`[dev-link] ${link} -> ${target}`)
}
