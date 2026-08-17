/**
 * harness stdout 发现行解析（纯逻辑，无 Electron 依赖，可单测）。
 */

export interface HarnessReadyLike {
  url: string
  port: number
  bridgePort: number | null
  token: string | null
}

/**
 * 解析 harness stdout 发现行：
 *  - `dsh web: <url>` → 更新 url/port
 *  - `dsh desktop: {port,token}` → 更新 bridgePort/token
 *  - 其他行 → 返回 null（无变化）
 * 返回新 ready 状态；ready 参数为空时从零构造。
 */
export function parseHarnessLine(line: string, ready: HarnessReadyLike | null): HarnessReadyLike | null {
  const web = /^dsh web: (https?:\/\/[^\s]+)/.exec(line)
  if (web) {
    try {
      const url = web[1]
      const port = Number(new URL(url).port || 0)
      return { ...(ready ?? { url: '', port: 0, bridgePort: null, token: null }), url, port }
    } catch {
      return null
    }
  }
  const br = /^dsh desktop: (\{.*\})$/.exec(line)
  if (br) {
    try {
      const info = JSON.parse(br[1]) as { port?: unknown; token?: unknown }
      return {
        ...(ready ?? { url: '', port: 0, bridgePort: null, token: null }),
        bridgePort: Number(info.port) || null,
        token: typeof info.token === 'string' ? info.token : null,
      }
    } catch {
      return null
    }
  }
  return null
}
