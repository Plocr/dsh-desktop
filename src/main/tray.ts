/**
 * 托盘：Electron 侧只是「按 trayMenu.ts 的模板建菜单 + 状态变化时重建」。
 *
 * 菜单结构、删了哪些项、为什么删，全部写在 trayMenu.ts 的模块注释里
 * （那里是纯逻辑，可以直接单测——菜单结构本身就是用户的验收项）。
 */
import { Menu, nativeImage, Tray } from 'electron'
import { trayMenuTemplate, type TrayActions, type TrayState } from './trayMenu'

/** 托盘依赖：状态读取 + 动作集合（动作由 index.ts 注入）。 */
export type TrayDeps = { getState: () => TrayState } & TrayActions

export interface TrayHandle {
  tray: Tray
  refresh: () => void
}

export function createTray(iconPath: string, deps: TrayDeps): TrayHandle {
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createEmpty()
  const tray = new Tray(image)
  tray.setToolTip('DSH Desktop')

  const refresh = (): void => {
    const s = deps.getState()
    const menu = Menu.buildFromTemplate(trayMenuTemplate(s, deps))
    tray.setContextMenu(menu)
  }

  refresh()
  return { tray, refresh }
}
