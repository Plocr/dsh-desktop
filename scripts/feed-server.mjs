// 本地模拟更新源服务器：剥离 base 前缀后从 feed 目录提供文件
import { createServer } from 'node:http'
import { existsSync, statSync, createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.join(os.tmpdir(), 'dsh-update-feed')
const BASE = '/dsh-desktop'
const port = Number(process.env.DSH_FEED_PORT ?? 8899)

createServer((req, res) => {
  console.log(`[feed] ${req.method} ${req.url}`)
  let p = req.url?.split('?')[0] ?? '/'
  try {
    p = decodeURIComponent(p)
  } catch {
    /* keep raw */
  }
  if (p.startsWith(BASE)) p = p.slice(BASE.length)
  const file = path.join(root, p)
  if (existsSync(file) && statSync(file).isFile()) {
    const stat = statSync(file)
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size })
    createReadStream(file).pipe(res)
  } else {
    res.writeHead(404)
    res.end('not found: ' + req.url)
  }
}).listen(port, '127.0.0.1', () => console.log(`update feed on http://127.0.0.1:${port}${BASE}`))
