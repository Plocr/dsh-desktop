// 生成模拟更新源 latest.yml（假版本 9.9.9，文件用旧安装包）
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const feed = path.join(os.tmpdir(), 'dsh-update-feed')
rmSync(feed, { recursive: true, force: true })
mkdirSync(feed, { recursive: true })

const setupName = 'DSH Desktop-9.9.9-setup.exe'
cpSync(path.resolve('release', 'DSH Desktop-0.1.0-setup.exe'), path.join(feed, setupName))
const buf = readFileSync(path.join(feed, setupName))
const sha = createHash('sha512').update(buf).digest('base64')
const yml = `version: 9.9.9
files:
  - url: ${setupName}
    sha512: ${sha}
    size: ${buf.length}
path: ${setupName}
sha512: ${sha}
releaseDate: '2026-08-14T00:00:00.000Z'
`
writeFileSync(path.join(feed, 'latest.yml'), yml)
console.log(`feed ready at ${feed} (sha512 len ${sha.length}, size ${buf.length})`)
