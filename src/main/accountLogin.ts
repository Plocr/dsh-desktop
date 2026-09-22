/**
 * DeepSeek 账号登录（官方「左下角登录」）在壳侧需要的那点原生动作 —— 纯逻辑，可单测。
 *
 * 官方桌面端对同一个登录流程只做两件原生事（`apps/desktop/src/main.ts`）：
 *  1. 尝试进入 `waiting-browser`（已经拿到授权链接、在等浏览器回跳）时，**用系统浏览器打开**
 *     那条 `authorizeUrl`，并且把当前主题塞进 `theme=` 参数，登录页跟应用同色；
 *     同一次尝试只开一次（用户手动关掉后再点「打开浏览器」是页面自己的链接）。
 *  2. 尝试以 `failed` / `expired` 结束时**把主窗口唤回前台**——用户此刻通常停在浏览器里，
 *     不唤回他只会觉得"点了登录没反应"。
 *
 * 官方把这两件事挂在账号状态流上（`welcomeBackend.account.watch`）。本壳没有那条 Remote 流，
 * 状态由桥接插件（`packages/bridge`）在宿主进程内订阅同一个账号服务后推给壳，
 * 事件名 `account.changed`，负载与这里解析的字段一一对应。
 *
 * 登录本身（PKCE、换 token、写凭据）全部在 harness 里，壳不接触任何凭据；
 * 这里只决定"要不要开浏览器 / 要不要把窗口叫回来"。
 */

/** 账号登录尝试的阶段（与官方 `AccountView.attempt.phase` 同集合）。 */
export const ACCOUNT_ATTEMPT_PHASES = [
  'initializing',
  'waiting-browser',
  'exchanging',
  'committing',
  'succeeded',
  'cancelled',
  'expired',
  'failed',
] as const

export type AccountAttemptPhase = (typeof ACCOUNT_ATTEMPT_PHASES)[number]

export interface AccountAttempt {
  id: string
  phase: AccountAttemptPhase
  /** 等待浏览器阶段才有：官方平台授权页（已是本壳可打开的 https 地址）。 */
  authorizeUrl: string | null
  /** 平台的失败分类（network / protocol / expired / storage）。 */
  errorCode: string | null
}

export interface AccountState {
  /** `signed-out` / `credential-stored`；凭据内容永不过桥（桥接只发这一个枚举）。 */
  status: 'signed-out' | 'credential-stored' | null
  attempt: AccountAttempt | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析桥接的 `account.changed` 负载（字段非法一律忽略，绝不让壳被噪声事件带崩）。 */
export function accountStateOf(payload: unknown): AccountState | null {
  if (!isRecord(payload)) return null
  const status = payload.status === 'signed-out' || payload.status === 'credential-stored' ? payload.status : null
  const raw = payload.attempt
  let attempt: AccountAttempt | null = null
  if (isRecord(raw) && typeof raw.id === 'string' && raw.id !== '') {
    const phase = ACCOUNT_ATTEMPT_PHASES.find((candidate) => candidate === raw.phase)
    if (phase !== undefined) {
      attempt = {
        id: raw.id,
        phase,
        authorizeUrl: typeof raw.authorizeUrl === 'string' && raw.authorizeUrl !== '' ? raw.authorizeUrl : null,
        errorCode: typeof raw.errorCode === 'string' && raw.errorCode !== '' ? raw.errorCode : null,
      }
    }
  }
  if (status === null && attempt === null) return null
  return { status, attempt }
}

/**
 * 授权链接的浏览器版本：官方桌面端会把应用当前明暗写进 `theme`，登录页跟随应用配色。
 * 非法 URL 原样返回（壳照常打开，平台自己会报错，而不是让壳静默吞掉这次登录）。
 */
export function platformLoginUrl(authorizeUrl: string, dark: boolean): string {
  try {
    const url = new URL(authorizeUrl)
    url.searchParams.set('theme', dark ? 'dark' : 'light')
    return url.href
  } catch {
    return authorizeUrl
  }
}

/** 壳侧记忆：同一次尝试只开一次浏览器、只在结束时唤回一次窗口。 */
export interface AccountLoginMemory {
  openedAttemptId: string | null
  returnedAttemptId: string | null
}

export function emptyAccountLoginMemory(): AccountLoginMemory {
  return { openedAttemptId: null, returnedAttemptId: null }
}

export type AccountLoginStep =
  | { kind: 'open-browser'; attemptId: string; url: string }
  | { kind: 'focus-window'; attemptId: string; reason: 'failed' | 'expired'; errorCode: string | null }

/**
 * 状态 → 原生动作。纯函数：记忆进、记忆出新，调用方只负责执行 `steps`。
 *
 * @param state - 桥接推送的账号状态。
 * @param dark - 当前有效主题是否为深色（决定登录页 `theme=`）。
 * @param memory - 上一步的记忆（attempt id 去重）。
 * @returns 要执行的原生动作与新的记忆。
 */
export function accountLoginSteps(
  state: AccountState,
  dark: boolean,
  memory: AccountLoginMemory,
): { steps: AccountLoginStep[]; memory: AccountLoginMemory } {
  const step: AccountLoginStep[] = []
  const next: AccountLoginMemory = { ...memory }
  const attempt = state.attempt
  if (attempt === null) return { steps: step, memory: next }
  if (attempt.phase === 'waiting-browser' && attempt.authorizeUrl !== null && memory.openedAttemptId !== attempt.id) {
    next.openedAttemptId = attempt.id
    step.push({ kind: 'open-browser', attemptId: attempt.id, url: platformLoginUrl(attempt.authorizeUrl, dark) })
    return { steps: step, memory: next }
  }
  if ((attempt.phase === 'failed' || attempt.phase === 'expired') && memory.returnedAttemptId !== attempt.id) {
    next.returnedAttemptId = attempt.id
    step.push({ kind: 'focus-window', attemptId: attempt.id, reason: attempt.phase, errorCode: attempt.errorCode })
  }
  return { steps: step, memory: next }
}

/** 失败原因的人话文案（通知/日志用）。 */
export function accountLoginFailureText(step: Extract<AccountLoginStep, { kind: 'focus-window' }>): string {
  if (step.reason === 'expired') return '登录超时（浏览器里未完成授权），可再次点击登录重试。'
  switch (step.errorCode) {
    case 'network':
      return '登录失败：与 DeepSeek 平台的网络请求未完成（检查网络/代理后重试）。'
    case 'storage':
      return '登录失败：本机未能保存凭据，请检查磁盘权限。'
    case 'expired':
      return '登录超时（浏览器里未完成授权），可再次点击登录重试。'
    default:
      return '登录失败：平台拒绝了这次授权，请重试。'
  }
}
