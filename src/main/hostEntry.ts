/**
 * Host 进程入口的定位（**壳自带副本优先**，运行时树副本兜底）。
 *
 * 为什么不再只依赖随包运行时树里的那个散件（0.8.9 起）：
 *  真机事故（2026-09-23 起，本机复现）：卡巴斯基把
 *  `<安装目录>\resources\dsh\node_modules\dsh-desktop-host\lib\index.js` 判成
 *  `PDM:Trojan.Win32.Generic`（未签名 Electron + 内嵌 harness 的行为启发式误报）并清除。
 *  那个文件是**壳自己代码的构建产物**（`packages/host/src/index.ts`，MIT 移植），却被当成
 *  「深目录里一个未签名的脚本」——这正是启发式打分最高的形状，而它又是启动硬前提，
 *  于是应用只能弹「运行时缺少随包文件…加白名单后重装」。
 *
 * 现在把入口随壳打进 `dist/main/host-entry.cjs`（随 `files: dist/**` 进 **app.asar**）：
 *  1. Electron 的标准打包形态，杀软无法单独摘掉归档内部的某一个文件；
 *  2. 依赖仍从运行时树解析（入口 banner 把 `<runtimeDir>/node_modules` 加进模块搜索路径），
 *     所以「随包 dsh 闭包」这个不可变更新单元没有被拆开；
 *  3. 运行时树里那份副本保留：开发态（无 asar）与 e2e 仍照旧用它，它被隔离也不再致命。
 *
 * 本模块只做路径决策（不 import electron），因此可以在 node:test 里直接单测。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 壳自带的 Host 入口：打包态在 `app.asar` 内，开发态在仓库 `dist/` 下。 */
export function bundledHostEntry(appPath: string): string {
  return join(appPath, 'dist', 'main', 'host-entry.cjs')
}

/** 随包运行时树里的 Host 入口（开发态与 e2e-bridge 用的同一份构建产物）。 */
export function runtimeTreeHostEntry(runtimeDir: string): string {
  return join(runtimeDir, 'node_modules', 'dsh-desktop-host', 'lib', 'index.js')
}

/** 解析出的 Host 入口。 */
export interface ResolvedHostEntry {
  /** spawn 用的绝对路径。 */
  readonly entry: string
  /** true = 壳自带副本（app.asar / 开发态 dist）；false = 运行时树副本。 */
  readonly bundled: boolean
}

/**
 * 解析 spawn 用的 Host 入口。
 * @param appPath - `app.getAppPath()`（打包态指向 app.asar，开发态指向仓库根）。
 * @param runtimeDir - 随包 dsh 运行时树根。
 * @returns 壳自带副本优先；其次运行时树副本；两处都没有时返回 undefined（调用方按「运行时被破坏」处理）。
 */
export function resolveHostEntry(appPath: string, runtimeDir: string): ResolvedHostEntry | undefined {
  const bundled = bundledHostEntry(appPath)
  if (existsSync(bundled)) return { entry: bundled, bundled: true }
  const inTree = runtimeTreeHostEntry(runtimeDir)
  if (existsSync(inTree)) return { entry: inTree, bundled: false }
  return undefined
}
