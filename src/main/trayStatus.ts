/**
 * 托盘状态行（纯逻辑，无 Electron 依赖，可单测）：
 * 把「Host 运行状态 + 桥接连接/任务可见性」压成**一行**——托盘不再为状态开三行。
 *
 * 文案取舍：桥接是通知/徽标/深链的命脉，"连上了吗、jobs 在不在、版本对不对得上"
 * 必须一眼可见；其余（任务数、待审批、最近会话）都在界面内呈现。
 */

export interface TrayStatusState {
  /** '运行中' / '启动中' / '已停止' */
  harnessState: string
  /** 桥接通道状态（壳 ↔ harness 的原生能力通道；诊断来自插件 bridge.diag 与握手回执） */
  bridge: {
    connected: boolean
    jobs: 'present' | 'absent' | null
    protocol: 'ok' | 'mismatch' | 'unknown'
    /** 最新诊断码（排障用；如 auth.rejected / ws.server.error） */
    lastCode: string | null
  }
}

export function trayStatusLine(s: TrayStatusState): string {
  const bridge = s.bridge.connected
    ? [
        '桥接：已连接',
        s.bridge.jobs === 'present' ? '任务可用' : s.bridge.jobs === 'absent' ? '任务不可用' : null,
        s.bridge.protocol === 'mismatch' ? '⚠ 协议不匹配' : s.bridge.protocol === 'unknown' ? '⚠ 版本未知' : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')
    : `桥接：未连接${s.bridge.lastCode ? `（${s.bridge.lastCode}）` : ''}`
  return `Harness：${s.harnessState} · ${bridge}`
}
