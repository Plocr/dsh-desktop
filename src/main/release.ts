/**
 * 移植自 `deepseek-ai/deepseek-harness` `apps/desktop/src/release.ts`（MIT）。
 *
 * [ported] 与上游的差异（发行身份字段，校验语义/错误文案保持一致）：
 *  1. release 增加 `dshVersion`：官方 Electron 与 `@deepseek-ai/dsh` 同号，本壳是独立
 *     发版号——`version` = 本壳（Electron 应用）版本，`dshVersion` = 随包 dsh 版本；
 *  2. host-protocol 版本现在随 Host 的 IPC 契约定义在 `./hostProcess.ts`；
 *  3. 其余（schemaVersion 约束、semver 校验、错误文案）逐字保留。
 */

/** Immutable version identity shared by one Electron shell and its bundled dsh runtime. */

// semver 7 不自带类型声明，本仓也未安装 @types/semver（package.json 不归本文件改）：
// 用 @ts-ignore 而非 @ts-expect-error——日后补上类型包时本抑制自动失效、不会误报。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore semver 无类型声明；只用到 valid()，运行时行为不受影响
import { valid } from 'semver'
import { DESKTOP_HOST_PROTOCOL_VERSION } from './hostProcess.ts'

/** Release facts embedded in the bundled runtime descriptor. */
export interface DesktopRelease {
  readonly schemaVersion: 1
  /** Exact version of this Electron shell release. */
  readonly version: string
  /** Exact bundled `@deepseek-ai/dsh` version bound to this shell release. */
  readonly dshVersion: string
  readonly hostProtocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly nodeVersion: string
  readonly pnpmVersion: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validate release data read from an installed or packaged filesystem resource. */
export function parseDesktopRelease(value: unknown): DesktopRelease {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.version !== 'string'
    || valid(value.version) === null || typeof value.dshVersion !== 'string' || valid(value.dshVersion) === null
    || value.hostProtocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION
    || typeof value.nodeVersion !== 'string' || valid(value.nodeVersion) === null
    || typeof value.pnpmVersion !== 'string' || valid(value.pnpmVersion) === null) {
    throw new Error('dsh desktop: invalid desktop release metadata')
  }
  return {
    schemaVersion: 1,
    version: value.version,
    dshVersion: value.dshVersion,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: value.nodeVersion,
    pnpmVersion: value.pnpmVersion,
  }
}
