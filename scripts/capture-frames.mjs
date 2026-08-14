// 截屏连拍：捕捉导航瞬间的黑帧（分析窗口区域平均亮度）
// 用法：先启动窗口（浅色），运行本脚本（后台）同时 kill harness
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const outDir = path.join(os.tmpdir(), 'dsh-flash-frames')
mkdirSync(outDir, { recursive: true })

// 用 PowerShell System.Drawing 截屏窗口区域
const shotScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`
writeFileSync(path.join(outDir, 'shot.ps1'), shotScript, 'utf8')

console.log('capturing frames for 2.5s...')
const t0 = Date.now()
let idx = 0
while (Date.now() - t0 < 2500) {
  const file = path.join(outDir, `f${String(idx++).padStart(3, '0')}.png`)
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(outDir, 'shot.ps1'), file], { stdio: 'ignore', timeout: 800 })
  } catch { /* frame missed */ }
  await new Promise((r) => setTimeout(r, 30))
}
console.log(`captured ${idx} frames to ${outDir}`)
