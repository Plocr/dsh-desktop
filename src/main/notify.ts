/**
 * 系统通知与任务栏徽标。
 *
 * 一个容易踩的坑：`Notification` 是原生通知的**句柄**，主进程不持有引用时会被 GC 回收，
 * 部分平台上表现为「通知偶尔不出现」或「点了没反应」。这里保留引用直到 close/failed，
 * 并留一个兜底超时释放（避免用户从不点通知时无限堆积）。
 */
import { app, Notification } from 'electron'

/** 仍在使用中的通知句柄（GC 保护）。 */
const LIVE = new Set<Notification>()
/** 兜底释放时长：够长（通知早已被系统收起），又不会长期驻留。 */
const RELEASE_AFTER_MS = 10 * 60 * 1000

export function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  LIVE.add(n)
  let timer: NodeJS.Timeout | null = null
  const release = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    LIVE.delete(n)
  }
  n.once('close', release)
  n.once('failed', release)
  timer = setTimeout(release, RELEASE_AFTER_MS)
  // 通知句柄不该拖住进程退出（通知早已显示，进程退出与它无关）
  if (typeof timer.unref === 'function') timer.unref()
  if (onClick) n.on('click', onClick)
  try {
    n.show()
  } catch {
    // 平台拒绝显示（通知中心被关掉等）：释放引用，绝不冒泡成未捕获异常
    release()
  }
}

export function setBadge(count: number): void {
  try {
    app.setBadgeCount(Math.max(0, Math.floor(count)))
  } catch {
    /* 平台不支持则忽略 */
  }
}
