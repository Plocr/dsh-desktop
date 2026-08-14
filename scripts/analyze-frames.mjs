// 分析截屏帧：窗口区域的平均亮度时间线，找黑帧
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = path.join(os.tmpdir(), 'dsh-flash-frames')
const frames = readdirSync(dir).filter((f) => f.endsWith('.png')).sort()

// 用 PowerShell + System.Drawing 读每帧的"窗口区域"平均亮度。
// 窗口位置从 Get-Process MainWindowHandle 获取（简化：全屏主区域中心 400x300）。
const ps = `
Add-Type -AssemblyName System.Drawing
$files = @($args)
foreach ($f in $files) {
  $bmp = [System.Drawing.Bitmap]::FromFile($f)
  # 采样中心 400x300 区域（窗口所在）
  $x0 = [Math]::Max(0, [int](($bmp.Width - 400) / 2))
  $y0 = [Math]::Max(0, [int](($bmp.Height - 300) / 2))
  $sum = 0L; $n = 0
  for ($y = $y0; $y -lt $y0 + 300 -and $y -lt $bmp.Height; $y += 4) {
    for ($x = $x0; $x -lt $x0 + 400 -and $x -lt $bmp.Width; $x += 4) {
      $p = $bmp.GetPixel($x, $y)
      $sum += ([int]$p.R + [int]$p.G + [int]$p.B) / 3
      $n++
    }
  }
  $bmp.Dispose()
  Write-Output ("{0} {1:N1}" -f (Split-Path $f -Leaf), ($sum / $n))
}
`
writeFileSync(path.join(dir, 'analyze.ps1'), ps, 'utf8')
const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'analyze.ps1'), ...frames.map((f) => path.join(dir, f))], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const lines = out.trim().split('\n').filter(Boolean)
const series = lines.map((l) => {
  const [f, lum] = l.trim().split(/\s+/)
  return { f, lum: Number(lum) }
})
console.log('frames:', series.length)
for (const s of series) {
  const mark = s.lum < 80 ? ' <<< DARK' : ''
  console.log(`${s.f} lum=${s.lum.toFixed(0)}${mark}`)
}
// 找暗帧连续段
const dark = series.filter((s) => s.lum < 80)
console.log('dark frames:', dark.length, dark.map((d) => d.f).join(', '))
