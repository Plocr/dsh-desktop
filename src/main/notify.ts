/**
 * 系统通知与任务栏徽标。
 */
import { app, Notification } from 'electron'

export function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  if (onClick) n.on('click', onClick)
  n.show()
}

export function setBadge(count: number): void {
  try {
    app.setBadgeCount(Math.max(0, Math.floor(count)))
  } catch {
    /* 平台不支持则忽略 */
  }
}
