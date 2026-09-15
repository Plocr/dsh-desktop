/**
 * scripts/windows-sign.mjs 的类型声明。
 *
 * 适配自 DeepSeek Harness 官方桌面端（MIT License）：
 *   apps/desktop/scripts/windows-sign.d.mts
 *
 * 说明：本声明仅用于编辑器/消费者类型提示；`tsconfig.json` 的 include 只覆盖
 * `scripts/**/*.mjs`，因此它不参与 `npm run typecheck`。
 */

/** 四个必填签名输入（缺一不可，全有才签）。 */
export declare const WINDOWS_SIGNING_VARIABLES: readonly [
  'DSH_DESKTOP_WINDOWS_CER_FILE',
  'DSH_DESKTOP_WINDOWS_SIGNTOOL',
  'DSH_DESKTOP_WINDOWS_KEY_CONTAINER',
  'DSH_DESKTOP_WINDOWS_TOKEN_PIN',
]

/**
 * 判断本次构建是否签名，并拒绝「只配置一半」的状态。
 * @param environment 打包环境。
 * @returns 构建应签名还是跳过签名。
 */
export declare function resolveWindowsSigningMode(environment: NodeJS.ProcessEnv): 'sign' | 'unsigned'

/**
 * 移除继承来的凭据，再交给签名子进程。
 * @param environment 父进程环境。
 * @returns 不含凭据形态变量名的环境。
 */
export declare function scrubWindowsSigningEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv

/**
 * 组装一次 SignTool 调用的参数。
 * @param input 已校验的签名身份与目标。
 * @returns SignTool 参数。
 */
export declare function buildSignToolArguments(input: {
  certificateFile: string
  tokenPin: string
  keyContainer: string
  path: string
  isNest: boolean
}): string[]

/**
 * 为单个 Electron 产物组装最小签名环境。
 * @param environment 父进程环境。
 * @param input 已校验的签名身份与任务。
 * @returns 脱敏环境 + 本次签名任务字段。
 */
export declare function buildWindowsSigningEnvironment(environment: NodeJS.ProcessEnv, input: {
  certificateFile: string
  signTool: string
  path: string
  isNest: boolean
  tokenPin: string
  keyContainer: string
}): NodeJS.ProcessEnv

/**
 * 用不含命令行的诊断替换 SignTool 失败。
 * @param error SignTool 进程失败。
 * @param path 签名失败的产物。
 * @param secrets 不允许出现在诊断里的值。
 * @returns 脱敏失败。
 */
export declare function createRedactedWindowsSigningError(error: unknown, path: string, secrets: readonly string[]): Error

/**
 * 清除指向文件末尾之外的证书表项。
 * @param path 待检查的可执行文件。
 * @returns 是否清除了无效的证书表项。
 */
export declare function repairDanglingAuthenticodeDirectory(path: string): Promise<boolean>

/**
 * 用 SafeNet Token 背后的 EV 证书创建签名钩子（严格模式）。
 * @param options 发布签名配置。
 * @returns 签名钩子。
 */
export declare function createWindowsTokenSigner(options: {
  certificateFile?: string | undefined
  signTool?: string | undefined
  tokenPin?: string | undefined
  keyContainer?: string | undefined
}): (configuration: { path: string, hash: string, isNest: boolean }) => Promise<void>

/**
 * 创建 `win.signtoolOptions.sign` 钩子（YAML 可用的宽容入口）。
 * @param environment 打包环境。
 * @returns 签名钩子。
 */
export declare function createWindowsSigningHook(environment?: NodeJS.ProcessEnv): (
  configuration: { path: string, hash: string, isNest: boolean },
) => Promise<void>

/**
 * 在企业代码完整性策略生效前，先给 electron-builder 生成的临时 NSIS 卸载器签名。
 * @param options 签名钩子与可注入的宿主取值。
 * @returns 打补丁完成。
 */
export declare function installWindowsNsisBootstrapSigner(options: {
  sign: (configuration: { path: string, hash: string, isNest: boolean }) => Promise<void>
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
}): Promise<void>

/** electron-builder `win.signtoolOptions.sign` 入口（命名导出）。 */
export declare const sign: (configuration: { path: string, hash: string, isNest: boolean }) => Promise<void>

export default sign
