/**
 * 终端壳解析与文本清理（纯函数，无 electron 依赖，可单测）。
 */
import { existsSync } from 'node:fs'

export type TermShell = 'auto' | 'powershell' | 'cmd' | 'pwsh' | 'bash' | 'zsh'

export interface TermShellSpec {
  cmd: string
  args: string[]
  label: string
}

function pathDelim(): string {
  return process.platform === 'win32' ? ';' : ':'
}

function joinPath(dir: string, cmd: string): string {
  return process.platform === 'win32' ? `${dir}\\${cmd}` : `${dir}/${cmd}`
}

function hasOnPath(cmd: string): boolean {
  const dirs = (process.env.PATH ?? '').split(pathDelim()).filter(Boolean)
  for (const dir of dirs) {
    try {
      if (existsSync(joinPath(dir, cmd))) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

/** 解析壳选择；'auto' 按平台探测。返回 null 表示该 shell 不可用。 */
export function resolveShellSpec(shell: TermShell): TermShellSpec | null {
  if (process.platform === 'win32') {
    switch (shell) {
      case 'powershell':
        return { cmd: 'powershell.exe', args: ['-NoLogo', '-NoExit'], label: 'PowerShell' }
      case 'cmd':
        return { cmd: 'cmd.exe', args: ['/K'], label: 'cmd' }
      case 'pwsh':
        return hasOnPath('pwsh.exe') ? { cmd: 'pwsh.exe', args: ['-NoLogo', '-NoExit'], label: 'pwsh' } : null
      case 'bash':
        return hasOnPath('bash.exe') ? { cmd: 'bash.exe', args: [], label: 'bash' } : null
      case 'zsh':
        return null
      case 'auto':
      default:
        return { cmd: 'powershell.exe', args: ['-NoLogo', '-NoExit'], label: 'PowerShell' }
    }
  }
  // macOS / Linux
  const shells: Record<string, TermShellSpec> = {
    bash: { cmd: 'bash', args: ['-l'], label: 'bash' },
    zsh: { cmd: 'zsh', args: ['-l'], label: 'zsh' },
    pwsh: { cmd: 'pwsh', args: ['-NoLogo'], label: 'pwsh' },
    powershell: { cmd: 'pwsh', args: ['-NoLogo'], label: 'pwsh' },
    cmd: { cmd: 'cmd.exe', args: [], label: 'cmd' },
  }
  if (shell !== 'auto' && shell in shells) {
    const spec = shells[shell]
    return hasOnPath(spec.cmd) ? spec : null
  }
  const envShell = process.env.SHELL
  if (envShell) {
    const base = envShell.split(/[\\/]/).pop() ?? 'bash'
    return { cmd: envShell, args: ['-l'], label: base }
  }
  return { cmd: 'bash', args: ['-l'], label: 'bash' }
}

/** 剥离 ANSI 转义（管道模式输出非 TTY，多数序列无意义；保留 \r\n）。 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*\x07/g, '') // OSC（标题等）
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[()][A-Z0-9]/g, '') // 字符集
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b[=<>]/g, '')
}
