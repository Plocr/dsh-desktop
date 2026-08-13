/**
 * 桥接事件 → 桌面动作（徽标/通知）的纯逻辑，独立成模块以便单元测试。
 * 不依赖 Electron；副作用经 effects 注入。
 */

export const RUNNING_STATUSES = new Set(['running', 'starting', 'stopping'])

export function runningJobCount(jobs: unknown[]): number {
  return jobs.filter(
    (j) => j && typeof j === 'object' && RUNNING_STATUSES.has(String((j as { status?: unknown }).status)),
  ).length
}

export interface BridgeEventEffects {
  notify: (title: string, body: string) => void
  setBadge: (count: number) => void
}

export interface BridgeEventSettings {
  notifications: boolean
}

export function handleBridgeEvent(
  type: string,
  payload: unknown,
  settings: BridgeEventSettings,
  effects: BridgeEventEffects,
): void {
  const p = payload as { job?: { id?: unknown; label?: unknown; status?: unknown }; sessionId?: unknown } | undefined
  if (type === 'job.done') {
    if (settings.notifications) {
      const job = p?.job
      const label = typeof job?.label === 'string' && job.label ? job.label : ''
      const id = String(job?.id ?? '?')
      effects.notify('后台任务完成', label ? `任务 ${id}「${label.slice(0, 40)}」已结束` : `任务 ${id} 已结束`)
    }
    return
  }
  if (type === 'jobs.changed') {
    const jobs = (p as { jobs?: unknown[] } | undefined)?.jobs ?? []
    effects.setBadge(runningJobCount(jobs))
    return
  }
  if (type === 'approval.asked') {
    if (settings.notifications) {
      effects.notify('需要审批', `会话 ${String(p?.sessionId ?? '?')} 请求审批一个操作`)
    }
  }
}
