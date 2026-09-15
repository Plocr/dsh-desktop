/**
 * macOS 已签名 DMG 的公证（notarize）、装订（staple）与验证。
 *
 * 适配自 DeepSeek Harness 官方桌面端（MIT License），上游文件：
 *   apps/desktop/scripts/package-macos.ts            （产物流编排思路）
 *   apps/desktop/scripts/notarize-macos-disk-images.mjs（DMG 公证 + 钉票 + 验证）
 *   apps/desktop/scripts/verify-macos-signature.mjs  （签名/身份核对）
 *   apps/desktop/scripts/desktop-release-environment.mjs（macOS 凭据策略）
 * 上游项目：DeepSeek Harness（apps/desktop）。本文件是衍生作品，遵循同一 MIT 许可。
 *
 * ── 与上游的差异（重要） ──────────────────────────────────────────────
 * 1. 上游先 `--dir` 产出已签名 .app，再并发两条产物流（zip：App 公证+钉票；
 *    dmg：封装已签名 App 后公证+钉票），DMG 的公证发生在 electron-builder 的
 *    artifactBuildCompleted 钩子里。本仓库只发布 DMG（`DSH.Desktop-${version}-${arch}.dmg`，
 *    无 zip 目标），因此这里对 electron-builder 已产出的 dmg 做：
 *    内层 App 签名核对 → notarytool submit --wait → stapler staple → stapler validate
 *    → spctl 评估 → 删除装订后必然过期的 blockmap（上游同样在公证后删除 dmg blockmap）。
 * 2. 上游要求四个环境变量（DSH_DESKTOP_APP_ID / DSH_DESKTOP_MACOS_SIGNING_IDENTITY /
 *    DSH_DESKTOP_MACOS_TEAM_ID / 公证凭据）。本仓库 appId 已固定在 electron-builder.yml
 *    （com.dsh.desktop.workbench），所以 DSH_DESKTOP_APP_ID 在此退化为**可选断言**：
 *    一旦设置，就要求产物 CFBundleIdentifier 与它一致；未设置则跳过该断言。
 * 3. 公证凭据直接交给 `xcrun notarytool`（上游经 @electron/notarize 提交，两者等价的
 *    notarytool 语义；本仓库 package.json 不新增依赖，故不走 npm 依赖）。
 * 4. 未配置签名环境时本脚本跳过（打印警告），只有「配置了一半」才报错——这样静态
 *    YAML 钩子与未签名构建可以共存；CI 签名分支额外传 --require-signing 强制要求。
 *
 * ── 安全性 ───────────────────────────────────────────────────────────
 * 凭据只通过参数/环境传给 Apple 官方工具，不写入仓库任何文件；CLI 解析出的参数
 * 中不含秘密值（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD 等由环境变量提供）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/** 期望的签名主体前缀（Developer ID Application）。 */
const DEVELOPER_ID_PREFIX = 'Developer ID Application: '
/** 期望的 Team ID 形态：10 位大写字母或数字。 */
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u
/** 未签名/跳过签名时的显式开关。 */
const UNSIGNED_ENV = 'DSH_DESKTOP_UNSIGNED'
/** 公证凭据三选一涉及的变量（与 electron-builder / notarytool 一致）。 */
const APPLE_ENVIRONMENT_VARIABLES = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_KEYCHAIN_PROFILE',
  'APPLE_KEYCHAIN',
]

function requireEnvironmentValue(environment, name) {
  const value = environment[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop macOS signing: ${name} must be set to a non-empty value`)
  }
  return value
}

/**
 * 解析并校验发布身份（证书限定名 + Team ID）。
 *
 * @param {NodeJS.ProcessEnv} environment 打包环境。
 * @param {{ identity?: string, teamId?: string }} overrides 命令行覆盖值。
 * @returns {{ signingIdentity: string, teamId: string }} 期望的证书限定名与 Team ID。
 */
export function resolveMacOSSigningEnvironment(environment = process.env, overrides = {}) {
  const signingIdentity = (overrides.identity ?? environment.DSH_DESKTOP_MACOS_SIGNING_IDENTITY ?? environment.CSC_NAME ?? '').trim()
  if (signingIdentity === '') {
    throw new Error('desktop macOS signing: DSH_DESKTOP_MACOS_SIGNING_IDENTITY (or CSC_NAME) must contain the Developer ID Application certificate qualifier')
  }
  if (signingIdentity.startsWith('Developer ID Application:')) {
    throw new Error('desktop macOS signing: DSH_DESKTOP_MACOS_SIGNING_IDENTITY must omit the "Developer ID Application:" prefix')
  }
  const teamId = (overrides.teamId ?? environment.DSH_DESKTOP_MACOS_TEAM_ID ?? '').trim()
  if (!TEAM_ID_PATTERN.test(teamId)) {
    throw new Error('desktop macOS signing: DSH_DESKTOP_MACOS_TEAM_ID must contain 10 uppercase letters or digits')
  }
  return { signingIdentity, teamId }
}

/**
 * 解析 notarytool 接受的一套完整凭据（与上游三种策略一致）。
 *
 * @param {NodeJS.ProcessEnv} environment 打包环境。
 * @returns {{ strategy: 'apple-id', appleId: string, appleIdPassword: string, teamId: string }
 *   | { strategy: 'api-key', appleApiKey: string, appleApiKeyId: string, appleApiIssuer: string }
 *   | { strategy: 'keychain-profile', keychainProfile: string, keychain?: string }} 公证凭据。
 */
export function resolveMacOSNotarizationEnvironment(environment = process.env) {
  const appleIdValues = [environment.APPLE_ID, environment.APPLE_APP_SPECIFIC_PASSWORD, environment.APPLE_TEAM_ID]
  if (appleIdValues.some(value => value !== undefined)) {
    return {
      strategy: 'apple-id',
      appleId: requireEnvironmentValue(environment, 'APPLE_ID'),
      appleIdPassword: requireEnvironmentValue(environment, 'APPLE_APP_SPECIFIC_PASSWORD'),
      teamId: requireEnvironmentValue(environment, 'APPLE_TEAM_ID'),
    }
  }

  const apiKeyValues = [environment.APPLE_API_KEY, environment.APPLE_API_KEY_ID, environment.APPLE_API_ISSUER]
  if (apiKeyValues.some(value => value !== undefined)) {
    return {
      strategy: 'api-key',
      appleApiKey: requireEnvironmentValue(environment, 'APPLE_API_KEY'),
      appleApiKeyId: requireEnvironmentValue(environment, 'APPLE_API_KEY_ID'),
      appleApiIssuer: requireEnvironmentValue(environment, 'APPLE_API_ISSUER'),
    }
  }

  const keychainProfile = environment.APPLE_KEYCHAIN_PROFILE?.trim()
  if (keychainProfile !== undefined && keychainProfile !== '') {
    const keychain = environment.APPLE_KEYCHAIN?.trim()
    return keychain === undefined || keychain === ''
      ? { strategy: 'keychain-profile', keychainProfile }
      : { strategy: 'keychain-profile', keychainProfile, keychain }
  }

  throw new Error('desktop macOS signing: macOS notarization requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID; APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER; or APPLE_KEYCHAIN_PROFILE')
}

/**
 * 判断本次是否走签名/公证链路。
 *
 * 规则与 Windows 侧保持一致：什么都没配 → 未签名（可用 --require-signing 强制报错）；
 * 配了一部分 → 一定报错（由 resolve* 抛出精确的缺失项）；全配齐 → 签名。
 *
 * @param {NodeJS.ProcessEnv} environment 打包环境。
 * @param {boolean} requireSigning 缺少配置时是否直接报错（CI 签名分支）。
 * @returns {'sign' | 'unsigned'} 执行模式。
 */
export function resolveMacOSReleaseMode(environment = process.env, requireSigning = false) {
  if (environment[UNSIGNED_ENV] !== undefined && !['0', '1'].includes(environment[UNSIGNED_ENV])) {
    throw new Error(`desktop macOS signing: ${UNSIGNED_ENV} must be 0 or 1`)
  }
  if (environment[UNSIGNED_ENV] === '1') return 'unsigned'
  if (requireSigning) return 'sign'
  const nothingConfigured = APPLE_ENVIRONMENT_VARIABLES
    .concat(['DSH_DESKTOP_MACOS_SIGNING_IDENTITY', 'DSH_DESKTOP_MACOS_TEAM_ID', 'CSC_NAME'])
    .every(name => (environment[name] ?? '').trim() === '')
  return nothingConfigured ? 'unsigned' : 'sign'
}

/**
 * 拒绝与发布身份不符的签名元数据。
 *
 * @param {string} details `codesign --display --verbose=4` 输出。
 * @param {{ signingIdentity: string, teamId: string }} expected 期望的发布身份。
 * @returns {void}
 */
export function assertMacOSSignatureDetails(details, expected) {
  const fields = new Set(details.split(/\r?\n/u).map(line => line.trim()))
  const expectedAuthority = `Authority=Developer ID Application: ${expected.signingIdentity}`
  const expectedTeam = `TeamIdentifier=${expected.teamId}`
  const missing = [expectedAuthority, expectedTeam].filter(field => !fields.has(field))
  if (missing.length > 0) {
    throw new Error(`desktop macOS signing: signature does not match the release identity; missing ${missing.join(', ')}`)
  }
}

/**
 * 执行一个 Apple 官方工具并返回输出。
 *
 * @param {string} command 绝对可执行文件路径。
 * @param {readonly string[]} args 参数。
 * @param {string} label 诊断名称。
 * @returns {string} stdout + stderr。
 */
export function runAppleCommand(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) {
    throw new Error(`desktop macOS signing: could not execute ${label}: ${result.error.message}`)
  }
  if (result.signal !== null) {
    throw new Error(`desktop macOS signing: ${label} was terminated by ${result.signal}`)
  }
  if (result.status !== 0) {
    const diagnostic = `${result.stdout}${result.stderr}`.trim()
    throw new Error(`desktop macOS signing: ${label} exited with ${String(result.status)}${diagnostic === '' ? '' : `: ${diagnostic}`}`)
  }
  return `${result.stdout}${result.stderr}`
}

/**
 * 执行一个 Apple 官方工具（异步，供长耗时公证使用）。
 *
 * @param {string} command 绝对可执行文件路径。
 * @param {readonly string[]} args 参数。
 * @param {string} label 诊断名称。
 * @returns {Promise<{ stdout: string, stderr: string }>} 两个诊断流分开返回（notarytool JSON 在 stdout）。
 */
export function runAppleCommandAsync(command, args, label) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let spawnError
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { spawnError = error })
    child.once('close', (code, signal) => {
      if (spawnError !== undefined) {
        reject(new Error(`desktop macOS signing: could not execute ${label}: ${spawnError.message}`))
        return
      }
      if (signal !== null) {
        reject(new Error(`desktop macOS signing: ${label} was terminated by ${signal}`))
        return
      }
      if (code !== 0) {
        const diagnostic = `${stdout}${stderr}`.trim()
        reject(new Error(`desktop macOS signing: ${label} exited with ${String(code)}${diagnostic === '' ? '' : `: ${diagnostic}`}`))
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

function runCodeSign(args) {
  return runAppleCommand('/usr/bin/codesign', args, 'codesign')
}

/**
 * 深度严格校验 .app 签名，并要求其属于期望的发布身份。
 *
 * @param {string} appPath .app 目录。
 * @param {{ signingIdentity: string, teamId: string }} expected 期望的发布身份。
 * @returns {void}
 */
export function verifyMacOSSignature(appPath, expected) {
  runCodeSign(['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const details = runCodeSign(['--display', '--verbose=4', appPath])
  assertMacOSSignatureDetails(details, expected)
}

/**
 * 校验 DMG 的签名、钉票与 Gatekeeper 评估结果。
 *
 * @param {string} diskImagePath .dmg 文件。
 * @param {{ signingIdentity: string, teamId: string } | undefined} expected 期望的发布身份（DMG 未签名时为 undefined）。
 * @returns {void}
 */
export function verifyMacOSDiskImage(diskImagePath, expected) {
  if (expected !== undefined) {
    runCodeSign(['--verify', '--strict', '--verbose=2', diskImagePath])
    assertMacOSSignatureDetails(runCodeSign(['--display', '--verbose=4', diskImagePath]), expected)
  }
  runAppleCommand('/usr/bin/xcrun', ['stapler', 'validate', diskImagePath], 'stapler validate')
  runAppleCommand('/usr/sbin/spctl', ['--assess', '--type', 'install', '--verbose=4', diskImagePath], 'spctl')
}

/**
 * 读取 .app 的 CFBundleIdentifier（经 plutil，兼容二进制 plist）。
 *
 * @param {string} appPath .app 目录。
 * @returns {string} bundle identifier。
 */
export function readMacOSBundleIdentifier(appPath) {
  const output = runAppleCommand('/usr/bin/plutil', [
    '-extract', 'CFBundleIdentifier', 'raw', '-o', '-',
    join(appPath, 'Contents', 'Info.plist'),
  ], 'plutil')
  return output.trim()
}

/**
 * 构造 notarytool 的凭据参数。
 *
 * @param {ReturnType<typeof resolveMacOSNotarizationEnvironment>} credentials 公证凭据。
 * @returns {string[]} notarytool 凭据参数。
 */
export function buildNotaryToolCredentialArguments(credentials) {
  switch (credentials.strategy) {
    case 'apple-id':
      return ['--apple-id', credentials.appleId, '--password', credentials.appleIdPassword, '--team-id', credentials.teamId]
    case 'api-key':
      return ['--key', credentials.appleApiKey, '--key-id', credentials.appleApiKeyId, '--issuer', credentials.appleApiIssuer]
    case 'keychain-profile':
      return credentials.keychain === undefined
        ? ['--keychain-profile', credentials.keychainProfile]
        : ['--keychain-profile', credentials.keychainProfile, '--keychain', credentials.keychain]
    default:
      throw new Error('desktop macOS signing: unsupported notarization credential strategy')
  }
}

/**
 * 提交 DMG 到 Apple 公证服务并等待结果；Invalid 时打印官方日志后失败。
 *
 * @param {string} diskImagePath .dmg 文件。
 * @param {ReturnType<typeof resolveMacOSNotarizationEnvironment>} credentials 公证凭据。
 * @returns {Promise<void>}
 */
export async function notarizeMacOSDiskImage(diskImagePath, credentials) {
  const credentialArguments = buildNotaryToolCredentialArguments(credentials)
  const started = performance.now()
  process.stdout.write(`desktop macOS notarization: submitting ${diskImagePath} at ${new Date().toISOString()}\n`)
  let result
  try {
    result = await runAppleCommandAsync('/usr/bin/xcrun', [
      'notarytool', 'submit', diskImagePath,
      ...credentialArguments,
      '--wait', '--output-format', 'json',
    ], 'notarytool submit')
  }
  catch (error) {
    // notarytool 失败时输出里可能带 submission id，尽量把官方日志一并打印出来。
    const submissionId = /"id"\s*:\s*"([^"]+)"/u.exec(String(error.message))?.[1]
    if (submissionId !== undefined) await printNotaryLog(submissionId, credentialArguments)
    throw error
  }
  if (result.stderr.trim() !== '') process.stderr.write(result.stderr)
  const summary = parseNotaryToolResult(result.stdout)
  const seconds = ((performance.now() - started) / 1000).toFixed(2)
  if (summary.status !== 'Accepted') {
    if (summary.id !== undefined) await printNotaryLog(summary.id, credentialArguments)
    throw new Error(`desktop macOS notarization: Apple rejected ${diskImagePath} with status ${summary.status}${summary.message === undefined ? '' : `: ${summary.message}`}`)
  }
  process.stdout.write(`desktop macOS notarization: accepted ${basename(diskImagePath)} in ${seconds}s (id ${summary.id ?? 'unknown'})\n`)
}

async function printNotaryLog(submissionId, credentialArguments) {
  try {
    const result = await runAppleCommandAsync('/usr/bin/xcrun', [
      'notarytool', 'log', submissionId, ...credentialArguments,
    ], 'notarytool log')
    process.stderr.write(`desktop macOS notarization: Apple log for ${submissionId}\n${result.stdout}${result.stderr}\n`)
  }
  catch (error) {
    process.stderr.write(`desktop macOS notarization: could not fetch Apple log for ${submissionId}: ${error.message}\n`)
  }
}

function parseNotaryToolResult(stdout) {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(`desktop macOS notarization: could not parse notarytool output: ${stdout.trim()}`)
  }
  let parsed
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1))
  }
  catch {
    throw new Error(`desktop macOS notarization: could not parse notarytool output: ${stdout.trim()}`)
  }
  return {
    id: typeof parsed.id === 'string' ? parsed.id : undefined,
    status: typeof parsed.status === 'string' ? parsed.status : 'Unknown',
    message: typeof parsed.message === 'string' ? parsed.message : undefined,
  }
}

/**
 * 钉票（staple）并验证，随后删除装订后必然过期的 blockmap。
 *
 * @param {string} diskImagePath .dmg 文件。
 * @returns {void}
 */
export function stapleMacOSDiskImage(diskImagePath) {
  runAppleCommand('/usr/bin/xcrun', ['stapler', 'staple', diskImagePath], 'stapler staple')
  runAppleCommand('/usr/bin/xcrun', ['stapler', 'validate', diskImagePath], 'stapler validate')
  const blockmap = `${diskImagePath}.blockmap`
  if (existsSync(blockmap)) {
    rmSync(blockmap, { force: true })
    process.stdout.write(`desktop macOS notarization: removed stale ${basename(blockmap)} (invalidated by stapling)\n`)
  }
}

/**
 * 在产物目录中定位 DMG。
 *
 * @param {string} releaseDirectory electron-builder 输出目录。
 * @param {string | undefined} arch 目标架构（arm64 / x64）。
 * @returns {string} DMG 绝对路径。
 */
export function findMacOSDiskImage(releaseDirectory, arch) {
  if (!existsSync(releaseDirectory)) {
    throw new Error(`desktop macOS signing: output directory ${releaseDirectory} does not exist; run the dmg packaging step first`)
  }
  const candidates = readdirSync(releaseDirectory)
    .filter(name => name.endsWith('.dmg'))
    .filter(name => arch === undefined || name.includes(`-${arch}.`))
  if (candidates.length === 0) {
    throw new Error(`desktop macOS signing: no ${arch === undefined ? '' : `${arch} `}dmg found in ${releaseDirectory}; run the dmg packaging step first`)
  }
  if (candidates.length > 1) {
    throw new Error(`desktop macOS signing: multiple dmgs found in ${releaseDirectory} (${candidates.join(', ')}); pass --dmg explicitly`)
  }
  return join(resolve(releaseDirectory), candidates[0])
}

/**
 * 在产物目录中定位 electron-builder 留下的 .app：
 * arm64 在 `mac-arm64/`（x64 默认架构后缀为空，落在 `mac/`），universal 在 `mac-universal/`。
 *
 * @param {string} releaseDirectory electron-builder 输出目录。
 * @param {string | undefined} arch 目标架构（arm64 / x64），用于决定优先顺序。
 * @returns {string | undefined} .app 绝对路径（找不到时 undefined）。
 */
export function findMacOSApplication(releaseDirectory, arch) {
  if (!existsSync(releaseDirectory)) return undefined
  const ordered = arch === 'arm64'
    ? ['mac-arm64', 'mac', 'mac-universal', 'mac-x64']
    : arch === 'x64'
      ? ['mac', 'mac-x64', 'mac-arm64', 'mac-universal']
      : ['mac-arm64', 'mac', 'mac-universal', 'mac-x64']
  const roots = ordered
    .map(name => join(releaseDirectory, name))
    .filter(directory => existsSync(directory))
  for (const root of roots) {
    const app = readdirSync(root).find(name => name.endsWith('.app'))
    if (app !== undefined) return join(root, app)
  }
  for (const entry of readdirSync(releaseDirectory)) {
    if (!entry.endsWith('.app')) continue
    const candidate = join(releaseDirectory, entry)
    if (statSync(candidate).isDirectory()) return candidate
  }
  return undefined
}

/**
 * 完整的「核对 → 公证 → 钉票 → 验证」流程（CLI 与 electron-builder 钩子共用）。
 *
 * @param {{
 *   environment?: NodeJS.ProcessEnv,
 *   releaseDirectory?: string,
 *   arch?: string,
 *   appPath?: string,
 *   diskImagePath?: string,
 *   requireSigning?: boolean,
 *   skipNotarize?: boolean,
 *   skipSpctl?: boolean,
 *   identity?: string,
 *   teamId?: string,
 * }} options 运行参数。
 * @returns {Promise<{ appPath: string | undefined, diskImagePath: string | undefined }>} 已处理的产物路径。
 */
export async function packageMacOSArtifacts(options = {}) {
  const environment = options.environment ?? process.env
  if (process.platform !== 'darwin') {
    throw new Error('desktop macOS signing: notarization and stapling require a macOS build host')
  }
  const mode = resolveMacOSReleaseMode(environment, options.requireSigning === true)
  if (mode === 'unsigned') {
    process.stdout.write('desktop macOS signing: macOS signing variables are not set, skipping notarization and stapling (unsigned dmg)\n')
    return { appPath: options.appPath, diskImagePath: options.diskImagePath }
  }
  const expected = resolveMacOSSigningEnvironment(environment, { identity: options.identity, teamId: options.teamId })
  const credentials = options.skipNotarize === true ? undefined : resolveMacOSNotarizationEnvironment(environment)

  const appPath = options.appPath ?? (options.releaseDirectory === undefined ? undefined : findMacOSApplication(options.releaseDirectory, options.arch))
  if (appPath !== undefined) {
    verifyMacOSSignature(appPath, expected)
    const bundleIdentifier = readMacOSBundleIdentifier(appPath)
    const expectedAppId = environment.DSH_DESKTOP_APP_ID?.trim()
    if (expectedAppId !== undefined && expectedAppId !== '' && expectedAppId !== bundleIdentifier) {
      throw new Error(`desktop macOS signing: packaged bundle identifier ${bundleIdentifier} does not match DSH_DESKTOP_APP_ID ${expectedAppId}`)
    }
    process.stdout.write(`desktop macOS signing: verified Developer ID Application: ${expected.signingIdentity} (${expected.teamId}) on ${bundleIdentifier}\n`)
  }

  if (options.diskImagePath === undefined && options.releaseDirectory === undefined) {
    return { appPath, diskImagePath: undefined }
  }
  const diskImagePath = options.diskImagePath ?? findMacOSDiskImage(options.releaseDirectory, options.arch)
  if (credentials !== undefined) {
    await notarizeMacOSDiskImage(diskImagePath, credentials)
    stapleMacOSDiskImage(diskImagePath)
    if (options.skipSpctl === true) {
      runAppleCommand('/usr/bin/xcrun', ['stapler', 'validate', diskImagePath], 'stapler validate')
    }
    else {
      verifyMacOSDiskImage(diskImagePath, expected)
    }
    process.stdout.write(`desktop macOS notarization: verified disk image ${diskImagePath}\n`)
  }
  else {
    // --skip-notarize：只核对 DMG 是否带 Developer ID 签名，失败仅告警（dmg.sign 可能为 false）。
    process.stdout.write(`desktop macOS notarization: skipped for ${basename(diskImagePath)} (--skip-notarize)\n`)
    try {
      runCodeSign(['--verify', '--strict', '--verbose=2', diskImagePath])
      assertMacOSSignatureDetails(runCodeSign(['--display', '--verbose=4', diskImagePath]), expected)
      process.stdout.write(`desktop macOS signing: verified Developer ID Application: ${expected.signingIdentity} (${expected.teamId}) on ${basename(diskImagePath)}\n`)
    }
    catch (error) {
      process.stderr.write(`desktop macOS signing: disk image signature not verified (not notarized): ${error.message}\n`)
    }
  }
  return { appPath, diskImagePath }
}

/**
 * electron-builder `afterSign` 钩子：核对已签名 .app 的发布身份。
 *
 * @param {{ electronPlatformName: string, appOutDir: string, packager: { appInfo: { productFilename: string } } }} context electron-builder 钩子上下文。
 * @param {NodeJS.ProcessEnv} environment 打包环境。
 * @returns {Promise<void>}
 */
export async function afterSign(context, environment = process.env) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = resolve(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const mode = resolveMacOSReleaseMode(environment, false)
  if (mode === 'unsigned') {
    process.stdout.write('desktop macOS signing: macOS signing variables are not set, skipping release identity verification\n')
    return
  }
  const expected = resolveMacOSSigningEnvironment(environment)
  verifyMacOSSignature(appPath, expected)
  process.stdout.write(`desktop macOS signing: verified Developer ID Application: ${expected.signingIdentity} (${expected.teamId})\n`)
}

/**
 * electron-builder `artifactBuildCompleted` 钩子：DMG 公证 + 钉票 + 验证。
 *
 * @param {{ file: string }} artifact 已完成的产物。
 * @param {NodeJS.ProcessEnv} environment 打包环境。
 * @returns {Promise<void>}
 */
export async function artifactBuildCompleted(artifact, environment = process.env) {
  if (!artifact.file.endsWith('.dmg')) return
  const mode = resolveMacOSReleaseMode(environment, false)
  if (mode === 'unsigned') {
    process.stdout.write('desktop macOS signing: macOS signing variables are not set, skipping dmg notarization\n')
    return
  }
  const expected = resolveMacOSSigningEnvironment(environment)
  const credentials = resolveMacOSNotarizationEnvironment(environment)
  await notarizeMacOSDiskImage(artifact.file, credentials)
  stapleMacOSDiskImage(artifact.file)
  verifyMacOSDiskImage(artifact.file, expected)
  process.stdout.write(`desktop macOS notarization: verified disk image ${artifact.file}\n`)
}

function parseCliArguments(argv) {
  const options = {
    releaseDirectory: 'release',
    arch: undefined,
    appPath: undefined,
    diskImagePath: undefined,
    requireSigning: false,
    skipNotarize: false,
    skipSpctl: false,
    identity: undefined,
    teamId: undefined,
    appOnly: false,
  }
  let releaseDirectoryExplicit = false
  let diskImageExplicit = false
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`desktop macOS signing: ${argument} requires a value`)
      return value
    }
    switch (argument) {
      case '--release-dir': options.releaseDirectory = next(); releaseDirectoryExplicit = true; break
      case '--arch': options.arch = next(); break
      case '--app': options.appPath = resolve(next()); break
      case '--dmg': options.diskImagePath = resolve(next()); diskImageExplicit = true; break
      case '--identity': options.identity = next(); break
      case '--team-id': options.teamId = next(); break
      case '--require-signing': options.requireSigning = true; break
      case '--skip-notarize': options.skipNotarize = true; break
      case '--skip-spctl': options.skipSpctl = true; break
      case '--help':
        process.stdout.write([
          'usage: node scripts/package-macos.mjs [options]',
          '',
          '  --release-dir <dir>    electron-builder 输出目录（默认 release）',
          '  --arch <arm64|x64>     只挑选该架构的 DMG',
          '  --dmg <file>           直接指定 DMG',
          '  --app <path>           只核对指定 .app 的签名身份',
          '  --identity <name>      覆盖 DSH_DESKTOP_MACOS_SIGNING_IDENTITY',
          '  --team-id <id>         覆盖 DSH_DESKTOP_MACOS_TEAM_ID',
          '  --require-signing      缺少签名变量时直接失败（CI 用）',
          '  --skip-notarize        只核对签名，不提交公证',
          '  --skip-spctl           跳过 spctl（部分 CI 镜像不可用）',
          '',
        ].join('\n'))
        process.exit(0)
        break
      default:
        throw new Error(`desktop macOS signing: unknown argument ${argument}`)
    }
  }
  // 只给了 --app 时只核对 .app 签名，不顺手去公证 release 目录里的 dmg。
  options.appOnly = options.appPath !== undefined && !releaseDirectoryExplicit && !diskImageExplicit
  return options
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2))
  if (options.appOnly) options.releaseDirectory = undefined
  const result = await packageMacOSArtifacts(options)
  process.stdout.write(`desktop macOS signing: done (${result.appPath ?? 'no app'}, ${result.diskImagePath ?? 'no dmg'})\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
