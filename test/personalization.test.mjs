import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  readPersonalization,
  writePersonalization,
  saveWallpaper,
  listWallpapers,
  removeWallpaper,
  readWallpaperData,
} from '../packages/better-setting/lib/index.js'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function makeConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-test-'))
  return {
    dir,
    config: { settingsFile: path.join(dir, 'settings.json'), wallpaperDir: path.join(dir, 'wallpapers') },
  }
}

test('personalization: 默认值与读写合并', () => {
  const { dir, config } = makeConfig()
  try {
    const d0 = readPersonalization(config)
    assert.equal(d0.skin, 'default')
    assert.equal(d0.accent, null)
    assert.equal(d0.wallpaper, null)
    assert.equal(d0.blur, 16)
    assert.equal(d0.glass, false)

    writePersonalization(config, { skin: 'midnight', accent: '#ff8800', blur: 24, glass: true })
    const d1 = readPersonalization(config)
    assert.equal(d1.skin, 'midnight')
    assert.equal(d1.accent, '#ff8800')
    assert.equal(d1.blur, 24)
    assert.equal(d1.glass, true)

    // 部分更新保留其余字段
    writePersonalization(config, { wallpaper: 'a.png' })
    const d2 = readPersonalization(config)
    assert.equal(d2.skin, 'midnight')
    assert.equal(d2.wallpaper, 'a.png')
    assert.equal(d2.blur, 24)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wallpaper: 保存/列出/读取/删除（图片·视频·HTML）', async () => {
  const { dir, config } = makeConfig()
  try {
    // 图片：文件名带空格要清洗，且不能出现 clip.mp4.mp4 双后缀
    const s1 = await saveWallpaper('test img.png', `data:image/png;base64,${PNG_BASE64}`, config)
    assert.equal(s1.status, 'ok')
    assert.ok(s1.file.endsWith('.png'))
    const files1 = (await listWallpapers(config)).items
    assert.equal(files1.length, 1)
    assert.ok(!files1[0].name.includes(' '), '名称中的空格应被清洗')

    const s2 = await saveWallpaper('clip.mp4', 'data:video/mp4;base64,AAAA', config)
    assert.equal(s2.status, 'ok')
    assert.ok(s2.file.endsWith('.mp4'), '不应出现双后缀 mp4.mp4')

    const s3 = await saveWallpaper('page.html', `data:text/html;base64,${Buffer.from('<html></html>').toString('base64')}`, config)
    assert.equal(s3.status, 'ok')
    assert.ok(s3.file.endsWith('.html'))

    const rImg = readWallpaperData(files1[0].name, config)
    assert.equal(rImg.status, 'ok')
    assert.equal(rImg.mime, 'image/png')
    assert.ok(rImg.dataUrl.startsWith('data:image/png;base64,'))
    // 内容一致性：回读 base64 == 原字节
    const saved = readFileSync(path.join(config.wallpaperDir, files1[0].name))
    assert.deepEqual([...saved], [...Buffer.from(PNG_BASE64, 'base64')])

    const rHtml = readWallpaperData('page.html', config)
    assert.equal(rHtml.status, 'ok')
    assert.equal(rHtml.mime, 'text/html')

    const rVid = readWallpaperData('clip.mp4', config)
    assert.equal(rVid.status, 'ok')
    assert.equal(rVid.mime, 'video/mp4')

    // 缺失文件 / 坏 data url
    assert.equal(readWallpaperData('nope.png', config).status, 'error')
    assert.equal((await saveWallpaper('bad.txt', 'not-a-data-url', config)).status, 'error')

    // 删除
    const del = await removeWallpaper(files1[0].name, config)
    assert.equal(del.status, 'ok')
    assert.equal((await listWallpapers(config)).items.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})