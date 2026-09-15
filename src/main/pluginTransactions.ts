/**
 * 插件包事务（官方 `apps/desktop/src/project-manager.ts` 的包管理部分，MIT 适配）。
 *
 * 官方不变式，逐条落实：
 *  - **只用随包 pnpm**（`resources/runtime/pnpm`，execPath 也是随包 Node）——
 *    系统 npm/pnpm/node 永远不参与，PATH 只作为补充前缀；
 *  - pnpm 全局参数固定：registry、私有 store、关闭 global virtual store、空 userconfig；
 *  - add/remove/update 一律 `--save-exact` + 忽略生命周期脚本；依赖脚本只认
 *    profile `pnpm-workspace.yaml` 里审过的 `allowBuilds` 白名单；
 *  - 事务期间持有 `<profile>/lock`（wx 创建、写 owner PID、退出时归还），
 *    并以 `<profile>/desktop-packages-pending` 标记「未完成的包准备」；
 *  - **失败保留部分改动、不自动回滚**（官方语义）：用户可重试或手工修，
 *    但下次启动看到 pending 标记会明确报错而不是带病启动。
 *
 * 与官方差异：官方把 Host 的启停也放进事务（beforeChange/afterChange）；这里同样保留，
 * 但由调用方（index.ts）注入，模块本身只管包管理器与锁。
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { log } from './logger'
import type { DesktopPaths } from './paths'
import type { RuntimeSpec } from './runtime'

/** 与官方一致的 registry（私有信任源，避免被用户级 npmrc 改道）。 */
const DESKTOP_REGISTRY = 'https://registry.npmjs.org/'
/** pnpm 诊断输出保留上限（超出截尾，避免日志爆掉）。 */
const MAX_DIAGNOSTIC_BYTES = 64 * 1024

/** 未完成的包准备标记（官方同名文件）。 */
export const PENDING_MARKER = 'desktop-packages-pending'

export interface PluginTransactionHooks {
  /** 事务前：停掉 Host（官方要求写 profile 前后端必须停止）。 */
  beforeChange: () => Promise<void>
  /** 事务 + 后继准备成功后的重启入口（失败时不调用）。 */
  afterChange: () => Promise<void>
}

interface LockHandle {
  path: string
}

/** 进程是否还活着（EPERM=存在但无权限，视为活着；ESRCH=不存在）。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class PluginTransactions {
  private lock: LockHandle | null = null

  constructor(
    private readonly runtime: RuntimeSpec,
    private readonly paths: DesktopPaths,
    private readonly hooks: PluginTransactionHooks,
  ) {}

  /** pending 标记路径（profile 内）。 */
  get pendingPath(): string {
    return path.join(this.paths.profile, PENDING_MARKER)
  }

  /** 启动时检查：上一次事务没走完 → 拒绝启动（官方 'package preparation is incomplete'）。 */
  assertSettled(): void {
    if (existsSync(this.pendingPath)) {
      throw new Error(
        '上一次插件包操作未完成（desktop-packages-pending 存在）：请在托盘「桌面插件 → 重试包准备」重试，' +
          '或删除该文件后重启（profile 可能处于部分改动状态）。',
      )
    }
  }

  /**
   * 取得包事务独占锁（官方语义）：lock 文件以 wx 创建并写入 owner PID；
   * 已存在时若 owner 进程已消失则视为陈旧锁并接管，否则报「另一个事务在进行中」。
   */
  acquire(): void {
    const lockPath = this.paths.lock
    mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600)
        try {
          writeSync(fd, String(process.pid))
        } finally {
          closeSync(fd)
        }
        this.lock = { path: lockPath }
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        const owner = (() => {
          try {
            const value = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
            return Number.isInteger(value) && value > 0 ? value : null
          } catch {
            return null
          }
        })()
        if (owner !== null && processAlive(owner)) {
          throw new Error(`另一个插件包事务正在进行中（owner pid=${owner}），请稍后重试`)
        }
        // 陈旧锁（进程已消失 / 内容不可读）：清掉后重试一次
        rmSync(lockPath, { force: true })
      }
    }
    throw new Error('无法取得插件包事务锁')
  }

  /** 事务结束归还锁（finally 里调用；文件不存在也不报错）。 */
  release(): void {
    if (this.lock === null) return
    try {
      rmSync(this.lock.path, { force: true })
    } catch {
      /* ignore */
    }
    this.lock = null
  }

  /**
   * 执行一次 pnpm 命令（随包 Node + 随包 pnpm，官方同款参数与环境）。
   * 事务期间 lock 归 Electron 持有；pnpm 子进程退出后立即写回 owner。
   */
  private async runPnpm(args: readonly string[]): Promise<void> {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('plugin transaction: pnpm command is required')
    for (const dir of [
      this.paths.root,
      this.paths.pnpm.store,
      this.paths.pnpm.cache,
      this.paths.pnpm.state,
      this.paths.pnpm.config,
      this.paths.pnpm.home,
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const npmrc = path.join(this.paths.pnpm.config, 'npmrc')
    if (!existsSync(npmrc)) writeFileSync(npmrc, '', { mode: 0o600 })
    // 过滤环境：官方同款——NODE_OPTIONS/NODE_PATH/DSH_DESKTOP_*/npm|pnpm|corepack_* 一律不带进去
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          name !== 'NODE_OPTIONS' &&
          name !== 'NODE_PATH' &&
          !/^DSH_DESKTOP_/u.test(name) &&
          !/^(?:npm|pnpm|corepack)_/iu.test(name),
      ),
    )
    // 进入事务：先立 pending 标记（官方：失败留下标记，下次启动明确报错）
    writeFileSync(this.pendingPath, '')
    await new Promise<void>((settle, reject) => {
      const child = spawn(
        this.runtime.node,
        [
          this.runtime.pnpmEntry,
          `--config.registry=${DESKTOP_REGISTRY}`,
          `--config.store-dir=${this.paths.pnpm.store}`,
          '--config.enable-global-virtual-store=false',
          `--config.userconfig=${npmrc}`,
          command,
          ...commandArgs,
        ],
        {
          cwd: this.paths.profile,
          env: {
            ...inherited,
            COREPACK_HOME: this.paths.pnpm.home,
            NPM_CONFIG_REGISTRY: DESKTOP_REGISTRY,
            NPM_CONFIG_STORE_DIR: this.paths.pnpm.store,
            NPM_CONFIG_USERCONFIG: npmrc,
            PATH: `${path.dirname(this.runtime.node)}${path.delimiter}${process.env.PATH ?? ''}`,
            PNPM_HOME: this.paths.pnpm.home,
            XDG_CACHE_HOME: this.paths.pnpm.cache,
            XDG_CONFIG_HOME: this.paths.pnpm.config,
            XDG_STATE_HOME: this.paths.pnpm.state,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let diagnostics = ''
      const append = (chunk: string): void => {
        diagnostics = (diagnostics + chunk).slice(-MAX_DIAGNOSTIC_BYTES)
      }
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', append)
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', append)
      child.once('error', (err) => reject(err))
      child.once('close', (code, signal) => {
        if (code === 0) {
          settle()
          return
        }
        const tail = diagnostics.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ')
        reject(
          new Error(
            `pnpm ${command} 失败（code=${String(code)} signal=${String(signal)}）：${tail.slice(0, 400) || '无输出'}`,
          ),
        )
      })
    }).catch((err: unknown) => {
      log('error', `plugin transaction: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    })
  }

  /** 事务主流程：停 Host → 持锁 → pnpm → rebuild → 清 pending → 起 Host。 */
  private async transact(run: () => Promise<void>): Promise<void> {
    this.acquire()
    try {
      await this.hooks.beforeChange()
      let ok = false
      try {
        await run()
        // 依赖脚本策略：pnpm 只对 allowBuilds 白名单里的包执行构建（--pending 补做）
        await this.runPnpm(['rebuild', '--pending'])
        ok = true
      } finally {
        if (ok) rmSync(this.pendingPath, { force: true })
      }
    } finally {
      this.release()
    }
    // 官方语义：失败保留部分改动、不自动回滚；只有成功才重启 Host
    await this.hooks.afterChange()
  }

  /** 安装一个插件（npm spec / 路径 / tgz；精确版本 + 不跑生命周期脚本）。 */
  add(spec: string): Promise<void> {
    return this.transact(() => this.runPnpm(['add', spec, '--save-exact', '--ignore-scripts']))
  }

  /** 按固定版本重装/升级一个已装插件。 */
  update(name: string, version: string): Promise<void> {
    return this.transact(() => this.runPnpm(['add', `${name}@${version}`, '--save-exact', '--ignore-scripts']))
  }

  /** 卸载一个插件。 */
  remove(name: string): Promise<void> {
    return this.transact(() => this.runPnpm(['remove', name, '--config.ignore-scripts=true']))
  }

  /** 按 lockfile 重装 profile 依赖（reconcile / 手工修复用）。 */
  install(): Promise<void> {
    return this.transact(() => this.runPnpm(['install', '--frozen-lockfile', '--ignore-scripts']))
  }

  /** 只补做一次依赖脚本（pending 重试入口）。 */
  async rebuildPending(): Promise<void> {
    this.acquire()
    try {
      await this.hooks.beforeChange()
      await this.runPnpm(['rebuild', '--pending'])
      rmSync(this.pendingPath, { force: true })
    } finally {
      this.release()
    }
    await this.hooks.afterChange()
  }
}
