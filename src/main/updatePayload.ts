/**
 * 「这个更新包能不能在应用内自己装完」的纯逻辑（无 Electron 依赖，可单测）。
 *
 * 起因：macOS 上 electron-updater 的 `MacUpdater` **只认 zip** —— 它用
 * `findFile(files, 'zip', ['pkg', 'dmg'])` 挑包（`electron-updater/out/MacUpdater.js`
 * 第 81 行），该函数只匹配 `.zip` 且显式排除 dmg（`out/providers/Provider.js` 第 74-88 行），
 * 取不到就抛 `ERR_UPDATER_ZIP_FILE_NOT_FOUND`。所以清单里没有 zip 时
 * `downloadUpdate()` **必失败**，而 `update-available` 早就发过了。
 *
 * 壳如果照旧宣告「已开始本地下载」，用户看到的就是「弹了通知，然后什么都没有」；
 * 手动检查还会得到一句毫无信息量的「检查更新失败」。所以壳要能在**开始下载之前**
 * 判断出「这个版本装不了」，把话说明白（给出手动下载地址）。
 *
 * Windows（NSIS `.exe`）与 Linux 不受这条约束：拿不到差分所需的 blockmap 也只是
 * 退回整包下载，不是失败。
 */

/** 取 URL / 文件名的扩展名（忽略 query 与 hash，大小写不敏感）。 */
function extensionOf(url: unknown): string {
  if (typeof url !== 'string') return ''
  const clean = url.split(/[?#]/u, 1)[0] ?? ''
  const dot = clean.lastIndexOf('.')
  return dot === -1 ? '' : clean.slice(dot).toLowerCase()
}

/**
 * 更新清单里是否有本平台能在应用内安装的载荷。
 *
 * @param files - `update-available` 事件的 `info.files`。GitHub provider 下 `url`
 *   可能是相对文件名，也可能是绝对 URL，两种都要认（与 updater.ts 里 `fileUrlOf` 同理）。
 * @param platform - `process.platform`，注入以便单测。
 * @returns macOS 要求存在 `.zip`；其它平台一律 true（不额外限制：未知形状交给
 *   electron-updater 自己判断，比壳凭猜测拦下来更不容易误伤——拦错了会变成
 *   「明明能更新却告诉用户不能」）。
 */
export function hasInstallablePayload(files: unknown, platform: string): boolean {
  if (platform !== 'darwin') return true
  if (!Array.isArray(files)) return false
  return files.some((file) => extensionOf((file as { url?: unknown } | null)?.url) === '.zip')
}

/**
 * 「装不了」的人话原因（用于通知与右上角卡片）。
 *
 * @param platform - `process.platform`。
 * @returns 面向用户的一句话解释。
 */
export function unsupportedPayloadReason(platform: string): string {
  return platform === 'darwin'
    ? '此版本未提供 macOS 自动更新包（zip）'
    : '此版本未提供本平台的自动更新包'
}
