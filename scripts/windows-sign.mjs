/**
 * Windows EV 代码签名钩子：electron-builder 的 `win.signtoolOptions.sign`。
 *
 * 适配自 DeepSeek Harness 官方桌面端（MIT License）：
 *   apps/desktop/scripts/windows-sign.mjs（+ 其配套 windows-sign.cmd）
 * 上游项目：DeepSeek Harness（apps/desktop）。本文件是衍生作品，遵循同一 MIT 许可。
 *
 * ── 与上游的差异（重要，运维需知） ───────────────────────────────────────
 * 1. 调用方式：上游把每个产物交给 CRLF 批处理 `windows-sign.cmd`（`setlocal
 *    DisableDelayedExpansion` + 清空变量后再执行 SignTool）。本仓库不新增 .cmd
 *    文件，改为 Node `execFile(signtool, args)` 直接拉起：不经过 shell，参数以
 *    数组传递，因此 PIN 中的 `!` 与 `%` 不会被解释（`"`、`]`、换行仍按上游规则
 *    拒绝）。子进程环境同样是「只带签名字段」的白名单环境。
 * 2. 钩子契约：electron-builder 26.x 的配置键是 `win.signtoolOptions.sign`
 *    （不是旧版的 `win.sign`，26.x schema 已无该键，写进 YAML 会配置校验失败）。
 *    回调参数是 CustomWindowsSignTaskConfiguration：
 *      { path, options, name, site, cscInfo, hash, isNest, computeSignToolArgs }
 *    其中 `path` 即待签名文件，`hash` 为本次摘要算法，`isNest` 为「追加签名」
 *    （第二次及以后的摘要轮次，SignTool 需加 `/as`）。本文件只使用
 *    path / hash / isNest——与上游用法一致，但更明确地不依赖 cscInfo。
 * 3. 未签名回退：上游在 JS 配置里按 `DSH_DESKTOP_UNSIGNED` 决定是否注册钩子；
 *    本仓库 electron-builder.yml 是静态 YAML，钩子必须自行判断：
 *      · 四个签名变量全部缺失、或 DSH_DESKTOP_UNSIGNED=1 → 跳过签名（未签名构建）
 *      · 只配置了一部分 → 立即报错（避免「以为签了其实没签」）
 *      · 四个变量齐全 → 严格签名，SignTool 任何失败都终止构建
 *    跳过签名只打印警告，不产出「假装已签名」的结果。
 * 4. 增加 5 分钟 SignTool 超时（上游不设超时）。Token 未插入/被锁时
 *    SignTool 会等待，CI 上会一直挂住；超时后按失败处理并给出可读诊断。
 *
 * ── 安全性 ─────────────────────────────────────────────────────────────
 * PIN 必须出现在 SignTool 命令行（SafeNet `/kc` 语法要求），这是无法避免的；
 * 除此之外：诊断输出会把 PIN 替换成 <redacted>，SignTool 子进程环境里没有任何
 * 继承来的密钥类变量，签名相关字段在传给子进程前即被清除。
 */

import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Code Signing 扩展密钥用法 OID。 */
const CODE_SIGNING_EKU = '1.3.6.1.5.5.7.3.3'
/** SignTool 单次调用超时（毫秒）。 */
const SIGNTOOL_TIMEOUT_MS = 5 * 60 * 1000
/** RFC 3161 时间戳服务（与上游一致：DigiCert）。 */
const TIMESTAMP_URL = 'http://timestamp.digicert.com'
/** SafeNet 加密服务提供程序名称（与上游一致）。 */
const CRYPTO_PROVIDER = 'eToken Base Cryptographic Provider'
/** electron-builder 在 wine 下跑 NSIS 生成卸载器时设置兼容层值。 */
const NSIS_RUN_AS_INVOKER = 'RunAsInvoker'
/** 防止重复打补丁的幂等标记。 */
const NSIS_BOOTSTRAP_PATCH = Symbol.for('dsh-desktop/nsis-bootstrap-signing')
/** 凭据形态的变量名（子进程环境不继承）。 */
const SENSITIVE_ENVIRONMENT_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD)/iu
/** 签名相关变量前缀。 */
const WINDOWS_SIGNING_ENVIRONMENT_PREFIX = 'DSH_DESKTOP_WINDOWS_'
/** 四个必填签名输入（缺一不可，全有才签）。 */
export const WINDOWS_SIGNING_VARIABLES = [
  'DSH_DESKTOP_WINDOWS_CER_FILE',
  'DSH_DESKTOP_WINDOWS_SIGNTOOL',
  'DSH_DESKTOP_WINDOWS_KEY_CONTAINER',
  'DSH_DESKTOP_WINDOWS_TOKEN_PIN',
]
/** PE 头读取长度，足够覆盖 COFF/可选头与数据目录。 */
const PE_HEADER_READ_SIZE = 4096
const PE32_MAGIC = 0x10B
const PE32_PLUS_MAGIC = 0x20B

/**
 * 判断本次构建是否签名，并拒绝「只配置一半」的状态。
 *
 * @param {NodeJS.ProcessEnv} environment 打包环境。
 * @returns {'sign' | 'unsigned'} 构建应签名还是跳过签名。
 */
export function resolveWindowsSigningMode(environment) {
  if (environment.DSH_DESKTOP_UNSIGNED !== undefined && !['0', '1'].includes(environment.DSH_DESKTOP_UNSIGNED)) {
    throw new Error('desktop windows signing: DSH_DESKTOP_UNSIGNED must be 0 or 1')
  }
  const present = WINDOWS_SIGNING_VARIABLES.filter(name => (environment[name] ?? '').trim() !== '')
  if (present.length === WINDOWS_SIGNING_VARIABLES.length) {
    if (environment.DSH_DESKTOP_UNSIGNED === '1') {
      throw new Error('desktop windows signing: DSH_DESKTOP_UNSIGNED=1 cannot be combined with a complete signing environment')
    }
    return 'sign'
  }
  if (present.length > 0) {
    const missing = WINDOWS_SIGNING_VARIABLES.filter(name => !present.includes(name))
    throw new Error(`desktop windows signing: incomplete signing environment; missing ${missing.join(', ')} (set all four variables, or none for an unsigned build)`)
  }
  return 'unsigned'
}

/**
 * 移除继承来的凭据，再交给签名子进程。
 *
 * @param {NodeJS.ProcessEnv} environment 父进程环境。
 * @returns {NodeJS.ProcessEnv} 不含凭据形态变量名的环境。
 */
export function scrubWindowsSigningEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !SENSITIVE_ENVIRONMENT_NAME.test(name)
      && !name.startsWith(WINDOWS_SIGNING_ENVIRONMENT_PREFIX)))
}

function resolveTokenIdentity(input) {
  const keyContainer = input.keyContainer?.trim()
  if (!keyContainer) {
    throw new Error('DSH_DESKTOP_WINDOWS_KEY_CONTAINER must contain the SafeNet private-key container name')
  }
  if (/["\r\n]/u.test(keyContainer)) {
    throw new Error('DSH_DESKTOP_WINDOWS_KEY_CONTAINER cannot contain quotes or line breaks')
  }
  const tokenPin = input.tokenPin
  if (tokenPin === undefined || tokenPin.length === 0) {
    throw new Error('DSH_DESKTOP_WINDOWS_TOKEN_PIN must contain the SafeNet Token Password')
  }
  if (/[\]"\r\n]/u.test(tokenPin)) {
    throw new Error('DSH_DESKTOP_WINDOWS_TOKEN_PIN cannot contain "]", quotes, or line breaks because the SafeNet key-container syntax uses them as delimiters')
  }
  return { keyContainer, tokenPin }
}

function resolveCertificateFile(value) {
  const candidate = value?.trim()
  if (!candidate) {
    throw new Error('DSH_DESKTOP_WINDOWS_CER_FILE must identify the public X.509 leaf certificate file')
  }
  let path
  let certificate
  try {
    path = realpathSync(candidate)
    certificate = new X509Certificate(readFileSync(path))
  }
  catch {
    throw new Error(`Windows code-signing certificate file is missing or invalid: ${candidate}`)
  }
  if (certificate.ca || !certificate.keyUsage?.includes(CODE_SIGNING_EKU)) {
    throw new Error(`Windows code-signing certificate file must contain a non-CA Code Signing certificate: ${path}`)
  }
  return path
}

function resolveSignTool(value) {
  const candidate = value?.trim()
  if (!candidate) {
    throw new Error('DSH_DESKTOP_WINDOWS_SIGNTOOL must identify the SafeNet-compatible SignTool executable')
  }
  let path
  try {
    path = realpathSync(candidate)
    if (!statSync(path).isFile() || !path.toLowerCase().endsWith('.exe')) throw new Error('not an executable file')
  }
  catch {
    throw new Error(`DSH_DESKTOP_WINDOWS_SIGNTOOL is missing or is not an executable file: ${candidate}`)
  }
  return path
}

function redactedSigningOutput(value, secrets) {
  let output = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : ''
  for (const secret of secrets) {
    if (secret !== '') output = output.replaceAll(secret, '<redacted>')
  }
  return output
}

/**
 * 用不含命令行的诊断替换 SignTool 失败，避免 PIN 泄漏到日志。
 *
 * @param {unknown} error SignTool 进程失败。
 * @param {string} path 签名失败的产物。
 * @param {readonly string[]} secrets 不允许出现在诊断里的值。
 * @returns {Error} 不含原始 error 作为 cause 的脱敏失败。
 */
export function createRedactedWindowsSigningError(error, path, secrets) {
  const record = error !== null && typeof error === 'object' ? error : undefined
  const code = record !== undefined && 'code' in record
    && (typeof record.code === 'number' || typeof record.code === 'string')
    ? ` (exit ${String(record.code)})`
    : ''
  const signal = record !== undefined && 'signal' in record && typeof record.signal === 'string'
    ? ` (signal ${record.signal})`
    : ''
  const timeout = record !== undefined && 'killed' in record && record.killed === true
    ? ` [SignTool 超过 ${SIGNTOOL_TIMEOUT_MS / 1000}s 未结束：检查 Token 是否插入/解锁]`
    : ''
  const stderr = record !== undefined && 'stderr' in record
    ? redactedSigningOutput(record.stderr, secrets).trim()
    : ''
  return new Error(`Windows release signing failed for ${path}${code}${signal}${timeout}${stderr === '' ? '' : `: ${stderr}`}`)
}

/**
 * 组装一次 SignTool 调用的参数（等效上游 windows-sign.cmd 的第 16 行）。
 *
 * @param {{ certificateFile: string, tokenPin: string, keyContainer: string, path: string, isNest: boolean }} input 已校验的签名身份与目标。
 * @returns {string[]} SignTool 参数。
 */
export function buildSignToolArguments(input) {
  const args = [
    'sign',
    '/v',
    '/fd', 'sha256',
    '/f', input.certificateFile,
    '/kc', `[{{${input.tokenPin}}}]=${input.keyContainer}`,
    '/csp', CRYPTO_PROVIDER,
  ]
  if (input.isNest) args.push('/as')
  args.push('/tr', TIMESTAMP_URL, '/td', 'sha256', input.path)
  return args
}

/**
 * 为单个 Electron 产物组装最小环境（仅签名 CMD/子进程需要的字段）。
 *
 * @param {NodeJS.ProcessEnv} environment 父进程环境。
 * @param {{ certificateFile: string, signTool: string, path: string, isNest: boolean, tokenPin: string, keyContainer: string }} input 已校验的签名身份与任务。
 * @returns {NodeJS.ProcessEnv} 脱敏环境 + 本次签名任务字段。
 */
export function buildWindowsSigningEnvironment(environment, input) {
  return {
    ...scrubWindowsSigningEnvironment(environment),
    DSH_DESKTOP_WINDOWS_SIGNTOOL: input.signTool,
    DSH_DESKTOP_WINDOWS_CER_FILE: input.certificateFile,
    DSH_DESKTOP_WINDOWS_TOKEN_PIN: input.tokenPin,
    DSH_DESKTOP_WINDOWS_KEY_CONTAINER: input.keyContainer,
    DSH_DESKTOP_WINDOWS_SIGN_TARGET: input.path,
    DSH_DESKTOP_WINDOWS_SIGN_APPEND: input.isNest ? '1' : '',
  }
}

/**
 * 用 SafeNet Token 背后的 EV 证书创建 electron-builder 签名钩子（严格模式）。
 *
 * @param {{ certificateFile?: string, signTool?: string, tokenPin?: string, keyContainer?: string }} options 发布签名配置。
 * @returns {(configuration: { path: string, hash: string, isNest: boolean }) => Promise<void>} 签名钩子。
 */
export function createWindowsTokenSigner(options) {
  if (process.platform !== 'win32') {
    throw new Error('desktop windows signing: SafeNet-backed EV signing requires a Windows build host')
  }
  const certificateFile = resolveCertificateFile(options.certificateFile)
  const signTool = resolveSignTool(options.signTool)
  const { keyContainer, tokenPin } = resolveTokenIdentity(options)
  const secrets = [tokenPin]
  return async (configuration) => {
    if (configuration.hash !== 'sha256') {
      throw new Error(`Windows release signing requires SHA-256, received ${configuration.hash}`)
    }
    await repairDanglingAuthenticodeDirectory(configuration.path)
    const args = buildSignToolArguments({
      certificateFile,
      tokenPin,
      keyContainer,
      path: configuration.path,
      isNest: configuration.isNest === true,
    })
    let result
    try {
      result = await execFileAsync(signTool, args, {
        env: buildWindowsSigningEnvironment(process.env, {
          certificateFile,
          signTool,
          path: configuration.path,
          isNest: configuration.isNest === true,
          tokenPin,
          keyContainer,
        }),
        windowsHide: false,
        timeout: SIGNTOOL_TIMEOUT_MS,
      })
    }
    catch (error) {
      throw createRedactedWindowsSigningError(error, configuration.path, secrets)
    }
    const stdout = redactedSigningOutput(result.stdout, secrets)
    const stderr = redactedSigningOutput(result.stderr, secrets)
    if (stdout !== '') process.stdout.write(stdout)
    if (stderr !== '') process.stderr.write(stderr)
  }
}

/**
 * 清除指向文件末尾之外的证书表项（electron-builder 生成的 exe 偶发此问题）。
 *
 * @param {string} path 待检查的可执行文件。
 * @returns {Promise<boolean>} 是否清除了无效的证书表项。
 */
export async function repairDanglingAuthenticodeDirectory(path) {
  const file = await open(path, 'r+')
  try {
    const { size } = await file.stat()
    const header = Buffer.alloc(Math.min(PE_HEADER_READ_SIZE, size))
    await file.read(header, 0, header.length, 0)
    const directoryOffset = findDanglingAuthenticodeDirectory(header, size)
    if (directoryOffset === undefined) return false
    await file.write(Buffer.alloc(8), 0, 8, directoryOffset)
    return true
  }
  finally {
    await file.close()
  }
}

/**
 * 定位声明的字节范围超出文件的 Authenticode 证书表项。
 *
 * @param {Buffer} header 可执行文件头部字节。
 * @param {number} fileSize 完整文件大小。
 * @returns {number | undefined} 无效数据目录项的偏移。
 */
function findDanglingAuthenticodeDirectory(header, fileSize) {
  if (header.length < 64 || header.toString('ascii', 0, 2) !== 'MZ') return undefined
  const peOffset = header.readUInt32LE(60)
  const optionalHeaderOffset = peOffset + 24
  if (optionalHeaderOffset + 2 > header.length
    || header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return undefined
  const magic = header.readUInt16LE(optionalHeaderOffset)
  const dataDirectoryOffset = magic === PE32_MAGIC
    ? optionalHeaderOffset + 96
    : magic === PE32_PLUS_MAGIC
      ? optionalHeaderOffset + 112
      : undefined
  if (dataDirectoryOffset === undefined) return undefined
  const certificateDirectoryOffset = dataDirectoryOffset + (4 * 8)
  if (certificateDirectoryOffset + 8 > header.length) return undefined
  const certificateOffset = header.readUInt32LE(certificateDirectoryOffset)
  const certificateSize = header.readUInt32LE(certificateDirectoryOffset + 4)
  if (certificateOffset === 0 && certificateSize === 0) return undefined
  return certificateOffset > 0
    && certificateSize > 0
    && certificateOffset + certificateSize <= fileSize
    ? undefined
    : certificateDirectoryOffset
}

let nsisBootstrapInstalled = false

/**
 * 在企业代码完整性策略生效前，先给 electron-builder 生成的临时 NSIS 卸载器签名。
 *
 * 上游做法一致：electron-builder 26.x 仍以 `__COMPAT_LAYER=RunAsInvoker` 通过
 * WineVmManager 运行该临时 exe（NsisTarget.buildUninstaller），这里劫持同一个
 * 原型方法，在执行前插入一次签名，并把继承环境脱敏后再交给子进程。
 *
 * @param {{ sign: (configuration: { path: string, hash: string, isNest: boolean }) => Promise<void>, platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv }} options 签名钩子与可注入的宿主取值。
 * @returns {Promise<void>} 打补丁完成。
 */
export async function installWindowsNsisBootstrapSigner(options) {
  if ((options.platform ?? process.platform) !== 'win32') return
  if (nsisBootstrapInstalled) return
  let WineVmManager
  try {
    const wineVmModule = await import('app-builder-lib/out/vm/WineVm.js')
    WineVmManager = wineVmModule.WineVmManager ?? wineVmModule.default?.WineVmManager
  }
  catch {
    // app-builder-lib 内部结构变化时跳过补丁：卸载器只是少一次签名，不阻断构建。
    return
  }
  if (typeof WineVmManager !== 'function') return
  const prototype = WineVmManager.prototype
  if (prototype[NSIS_BOOTSTRAP_PATCH] === true) {
    nsisBootstrapInstalled = true
    return
  }
  const originalExec = prototype.exec
  prototype.exec = async function (file, args, execOptions, isLogOutIfDebug) {
    const isNsisBootstrap = typeof file === 'string'
      && file.toLowerCase().endsWith('.exe')
      && execOptions?.env?.__COMPAT_LAYER === NSIS_RUN_AS_INVOKER
    if (!isNsisBootstrap) {
      return originalExec.call(this, file, args, execOptions, isLogOutIfDebug)
    }
    await options.sign({ path: file, hash: 'sha256', isNest: false })
    return originalExec.call(this, file, args, {
      ...execOptions,
      env: scrubWindowsSigningEnvironment({
        ...(options.environment ?? process.env),
        ...execOptions.env,
      }),
    }, isLogOutIfDebug)
  }
  Object.defineProperty(prototype, NSIS_BOOTSTRAP_PATCH, { value: true })
  nsisBootstrapInstalled = true
}

/**
 * 创建 electron-builder `win.signtoolOptions.sign` 钩子（YAML 可用的宽容入口）。
 *
 * @param {NodeJS.ProcessEnv} environment 打包环境。
 * @returns {(configuration: { path: string, hash: string, isNest: boolean }) => Promise<void>} 签名钩子。
 */
export function createWindowsSigningHook(environment = process.env) {
  const mode = resolveWindowsSigningMode(environment)
  if (mode === 'unsigned') {
    if (environment.DSH_DESKTOP_UNSIGNED === '1') {
      process.stdout.write('desktop windows signing: DSH_DESKTOP_UNSIGNED=1, skipping Windows signing (unsigned artifact)\n')
    }
    else {
      process.stdout.write(`desktop windows signing: ${WINDOWS_SIGNING_VARIABLES.join(', ')} are not set, skipping Windows signing (unsigned artifact)\n`)
    }
    return async () => {}
  }
  const signer = createWindowsTokenSigner({
    certificateFile: environment.DSH_DESKTOP_WINDOWS_CER_FILE,
    signTool: environment.DSH_DESKTOP_WINDOWS_SIGNTOOL,
    tokenPin: environment.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
    keyContainer: environment.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
  })
  const hook = async (configuration) => {
    await installWindowsNsisBootstrapSigner({ sign: hook, platform: process.platform, environment })
    await signer(configuration)
  }
  return hook
}

/**
 * electron-builder `win.signtoolOptions.sign` 入口。
 *
 * 命名导出 `sign` 与默认导出等价：electron-builder 的 resolveFunction 会先找
 * 同名命名导出（name === 'sign'），找不到再退回 default。
 */
export const sign = createWindowsSigningHook()

export default sign
