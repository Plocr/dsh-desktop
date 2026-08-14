/**
 * dsh:// 深链解析（纯逻辑，无 Electron 依赖，可单测）。
 *
 * 语法：
 *   dsh://                聚焦窗口
 *   dsh://focus           聚焦窗口
 *   dsh://new             聚焦 + 新建会话
 *   dsh://session/<id>    聚焦 + 尽力打开指定会话
 */
export interface DeepLinkAction {
  kind: 'focus' | 'new' | 'session'
  sessionId?: string
}

export function parseDeepLink(raw: string): DeepLinkAction | null {
  if (typeof raw !== 'string' || !raw.startsWith('dsh://')) return null
  const rest = raw.slice('dsh://'.length)
  const segments = rest.split('/').filter((s) => s.length > 0)
  const head = segments[0]?.toLowerCase()
  if (!head) return { kind: 'focus' }
  if (head === 'focus') return { kind: 'focus' }
  if (head === 'new') return { kind: 'new' }
  if (head === 'session') {
    const sessionId = segments[1] ? decodeURIComponent(segments[1]) : undefined
    if (sessionId) return { kind: 'session', sessionId }
  }
  return { kind: 'focus' }
}

/** 从进程 argv 中提取深链 URL（Windows/Linux 协议拉起时 URL 出现在 argv）。 */
export function extractDeepLinkFromArgv(argv: string[]): string | null {
  if (!Array.isArray(argv)) return null
  const url = argv.find((a) => typeof a === 'string' && a.startsWith('dsh://'))
  return url ?? null
}
