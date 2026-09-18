/**
 * 上游 dsh 版本巡检与同步（纯逻辑 + 显式写盘）。
 *
 * 背景：桌面端的更新模型是「壳 + 随包 dsh + Node + pnpm = 一个签名更新单元」（D29），
 * 官方 harness 发布新版后**不会**自动进到用户机器——必须有人把 pin 提上去、重建运行时树、
 * 出新的安装包。这一步不需要服务器：GitHub Actions 定时跑本脚本即可（见
 * `.github/workflows/upstream-dsh.yml`）。
 *
 * ⚠ 实测坑（这就是本脚本存在的理由之一）：npm 上 `@deepseek-ai/dsh` 的 `latest` dist-tag
 * 目前指向 **0.1.5-rc.2**，而真正最高版本是 **0.1.6-alpha.2**（我们当前绑定的）。
 * 所以「有没有新版」必须比**版本列表里的最大值**，不能比 `npm view <pkg> version`。
 * 版本比较复用壳自己的 `compareDots`（纯函数，有单测，语义与发布流程一致）。
 *
 * 用法：
 *   node scripts/upstream-dsh.mjs --check             # 只报告（有新版退出码 10，便于 CI 判定）
 *   node scripts/upstream-dsh.mjs --check --json      # 机器可读
 *   node scripts/upstream-dsh.mjs --sync              # 打印将要改的版本号（dry-run）
 *   node scripts/upstream-dsh.mjs --sync --write      # 落盘（package.json + packages/host）
 *   node scripts/upstream-dsh.mjs --self-test         # 跑内部断言（不联网）
 *
 * `--sync` 之后必须重建运行时树（`npm run setup:runtime`）并跑 `npm run check` / `npm run e2e:bridge`：
 * 版本号只是 pin，真正能跑与否由 e2e 说话。**只改版本号，不改 host/bridge 源码**——官方组合树
 * 或宿主 API 有破坏性变化时 e2e 会失败，那种情况需要人工改代码（脚本会明确报错而不是硬发版）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 显式 .ts：Node 的类型擦除可直接跑（与 test/、scripts/e2e-bridge.mjs 同一套做法）
import { compareDots } from '../src/main/version.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_PACKAGE = '@deepseek-ai/dsh'

/** 从版本列表里挑最高版本（忽略非法项）；空列表返回 null。 */
export function pickHighestVersion(versions) {
  const valid = (Array.isArray(versions) ? versions : [versions])
    .filter((v) => typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v.trim()))
    .map((v) => v.trim())
  if (valid.length === 0) return null
  return valid.reduce((best, v) => (compareDots(v, best) > 0 ? v : best))
}

/** 壳版本 → 下一版（patch +1；忽略/丢弃预发布段，与发布流程的“稳定号递增”一致）。 */
export function nextShellVersion(current) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(current))
  if (!m) throw new Error(`无法解析壳版本：${String(current)}`)
  return `${m[1]}.${m[2]}.${String(Number(m[3]) + 1)}`
}

/**
 * 计算需要改的版本号（纯函数，可单测）。
 * @param rootPkg - 根 package.json 的对象形态。
 * @param hostPkg - packages/host/package.json 的对象形态。
 * @param dshVersion - 目标 dsh 版本。
 * @param bump - 壳版本递增策略（`patch` 缺省；传 null 表示不动壳版本）。
 * @returns `{ shellVersion, changes }`，changes 是给人看的「文件：旧 → 新」列表。
 */
export function planSync(rootPkg, hostPkg, dshVersion, bump = 'patch') {
  const changes = []
  const from = rootPkg.dshRuntime?.dsh
  if (typeof from !== 'string') throw new Error('package.json 缺少 dshRuntime.dsh')
  const shellVersion = bump === null ? rootPkg.version : nextShellVersion(rootPkg.version)
  if (shellVersion !== rootPkg.version) {
    changes.push({ file: 'package.json', field: 'version', from: rootPkg.version, to: shellVersion })
  }
  if (from !== dshVersion) {
    changes.push({ file: 'package.json', field: 'dshRuntime.dsh', from, to: dshVersion })
  }
  if (hostPkg.version !== dshVersion) {
    changes.push({ file: 'packages/host/package.json', field: 'version', from: hostPkg.version, to: dshVersion })
  }
  for (const [name, spec] of Object.entries(hostPkg.dependencies ?? {})) {
    // 只动「跟随 dsh 版本号」的那批（cordis / cordis-plugin-include 等有独立版本，保持不动）
    if (spec === from && spec !== dshVersion) {
      changes.push({ file: 'packages/host/package.json', field: `dependencies.${name}`, from: spec, to: dshVersion })
    }
  }
  if (dshVersion === from && shellVersion === rootPkg.version) {
    // 相同版本：什么都不用改（幂等）
    return { shellVersion, changes: [] }
  }
  return { shellVersion, changes }
}

/** 应用 plan（直接改内存对象，调用方负责写盘）。 */
export function applyPlan(rootPkg, hostPkg, plan, dshVersion) {
  rootPkg.version = plan.shellVersion
  rootPkg.dshRuntime = { ...rootPkg.dshRuntime, dsh: dshVersion }
  hostPkg.version = dshVersion
  for (const name of Object.keys(hostPkg.dependencies ?? {})) {
    if (hostPkg.dependencies[name] !== dshVersion && plan.changes.some((c) => c.field === `dependencies.${name}`)) {
      hostPkg.dependencies[name] = dshVersion
    }
  }
}

/**
 * 读 npm registry 上某个包的全部已发布版本 + dist-tags。
 *
 * 直接问 registry（而不是 `npm view`）：① 不依赖 PATH 里有没有 npm；② 一次拿到
 * `dist-tags`，能把「latest 指向 0.1.5-rc.2，而最高版本是 0.1.6-alpha.2」这件事直接摆出来。
 * 网络失败时抛错，由调用方决定怎么报（CI 里应当失败，绝不静默当"无更新"）。
 */
export async function publishedVersions(pkg = DSH_PACKAGE, options = {}) {
  const registry = options.registry ?? process.env.DSH_DESKTOP_NPM_REGISTRY ?? 'https://registry.npmjs.org'
  const res = await fetch(`${registry.replace(/\/$/u, '')}/${pkg.replace('/', '%2f')}`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`registry 返回 HTTP ${String(res.status)}（${pkg}）`)
  const doc = await res.json()
  const versions = Object.keys(doc?.versions ?? {}).filter((v) => typeof v === 'string')
  return { versions, distTags: doc?.['dist-tags'] ?? {} }
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(root, file), 'utf8'))
}

function writeJson(file, value) {
  writeFileSync(path.join(root, file), `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
}

function selfTest() {
  const assert = (cond, message) => {
    if (!cond) throw new Error(`self-test failed: ${message}`)
  }
  // 关键回归：latest dist-tag 是 0.1.5-rc.2，但最高版本是 0.1.6-alpha.2
  assert(pickHighestVersion(['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2']) === '0.1.6-alpha.2', '预发布排序')
  assert(pickHighestVersion(['0.1.2-alpha.5', '0.1.2-rc.1']) === '0.1.2-rc.1', 'rc > alpha')
  assert(pickHighestVersion(['1.0.0-beta.1', '1.0.0']) === '1.0.0', '稳定版 > 预发布')
  assert(pickHighestVersion([]) === null, '空列表')
  assert(pickHighestVersion(['garbage', '0.1.0']) === '0.1.0', '过滤非法项')
  assert(nextShellVersion('0.8.2') === '0.8.3', '壳版本 patch+1')
  const rootPkg = { version: '0.8.2', dshRuntime: { dsh: '0.1.6-alpha.2', node: 'v24.15.0', pnpm: '11.7.0' } }
  const hostPkg = {
    version: '0.1.6-alpha.2',
    dependencies: { '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/dsh': '0.1.6-alpha.2', '@deepseek-ai/dsh-api-gateway': '0.1.6-alpha.2' },
  }
  const plan = planSync(rootPkg, hostPkg, '0.1.6-alpha.3')
  assert(plan.shellVersion === '0.8.3', '壳版本进 plan')
  assert(plan.changes.some((c) => c.field === 'dshRuntime.dsh'), 'dsh pin 进 plan')
  assert(plan.changes.some((c) => c.field === 'dependencies.@deepseek-ai/dsh'), 'host dep 进 plan')
  assert(!plan.changes.some((c) => c.field === 'dependencies.@deepseek-ai/cordis'), '独立版本依赖不动')
  applyPlan(rootPkg, hostPkg, plan, '0.1.6-alpha.3')
  assert(rootPkg.dshRuntime.dsh === '0.1.6-alpha.3', 'apply: dsh pin')
  assert(rootPkg.version === '0.8.3', 'apply: 壳版本')
  assert(hostPkg.version === '0.1.6-alpha.3', 'apply: host 版本')
  assert(hostPkg.dependencies['@deepseek-ai/dsh-api-gateway'] === '0.1.6-alpha.3', 'apply: host 依赖')
  assert(hostPkg.dependencies['@deepseek-ai/cordis'] === '4.0.2', 'apply: 独立版本依赖保持')
  // 幂等：已经是该版本 → 无变更
  const noop = planSync({ version: '0.8.2', dshRuntime: { dsh: '0.1.6-alpha.2' } }, { version: '0.1.6-alpha.2', dependencies: {} }, '0.1.6-alpha.2', null)
  assert(noop.changes.length === 0, '幂等')
  console.log('[upstream-dsh] self-test OK')
}

async function main() {
  const argv = process.argv.slice(2)
  const has = (flag) => argv.includes(flag)
  const valueOf = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (has('--self-test')) return selfTest()
  if (has('--help') || argv.length === 0) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim())
    return
  }

  const rootPkg = readJson('package.json')
  const current = rootPkg.dshRuntime?.dsh
  if (typeof current !== 'string') throw new Error('package.json 缺少 dshRuntime.dsh')

  if (has('--check')) {
    const { versions, distTags } = await publishedVersions()
    const highest = pickHighestVersion(versions)
    const update = highest !== null && compareDots(highest, current) > 0
    const info = { current, highest, update, published: versions.length, latestTag: distTags.latest ?? null }
    // CI：直接把结果写进 $GITHUB_OUTPUT（workflow 的后续步骤据此判断要不要同步/出包）
    if (has('--github-output')) {
      const file = process.env.GITHUB_OUTPUT
      if (file === undefined) throw new Error('--github-output 需要 GITHUB_OUTPUT 环境变量（只在 CI 里用）')
      const lines = `update=${String(info.update)}\ncurrent=${info.current}\nhighest=${String(info.highest)}\nlatest_tag=${String(info.latestTag)}\n`
      writeFileSync(file, lines, { flag: 'a' })
      console.log(`[upstream-dsh] GITHUB_OUTPUT: ${lines.trim().replace(/\n/gu, ' | ')}`)
    } else if (has('--json')) console.log(JSON.stringify(info))
    else {
      console.log(`[upstream-dsh] 当前绑定 ${current}｜npm 最高 ${String(highest)}｜已发布 ${versions.length} 个版本`)
      if (distTags.latest !== undefined && distTags.latest !== highest) {
        console.log(`[upstream-dsh] 注意：npm 的 latest tag 指向 ${distTags.latest}，比最高版本低——检测按最高版本判定`)
      }
      console.log(update ? `[upstream-dsh] 有新版本可用：${current} → ${highest}` : '[upstream-dsh] 已是最新（按最高版本比较，不看 latest dist-tag）')
    }
    process.exitCode = update ? 10 : 0
    return
  }

  if (has('--sync')) {
    const target = valueOf('--version') ?? pickHighestVersion((await publishedVersions()).versions)
    if (target === null) throw new Error('无法确定目标 dsh 版本（npm 查询失败？）')
    const hostPkg = readJson('packages/host/package.json')
    // 防误降级：CI 里手抖填了旧版本号，绝不能把用户端 version 往下拽（electron-updater 也不会接受降级）
    if (compareDots(target, current) <= 0 && !has('--allow-downgrade')) {
      throw new Error(`目标版本 ${target} 不高于当前绑定 ${current}（要降级请显式加 --allow-downgrade）`)
    }
    const plan = planSync(rootPkg, hostPkg, target, has('--keep-shell-version') ? null : 'patch')
    if (plan.changes.length === 0) {
      console.log(`[upstream-dsh] 已经是 ${target}，无需修改`)
      return
    }
    for (const c of plan.changes) console.log(`[upstream-dsh] ${has('--write') ? '改' : '将改'} ${c.file}: ${c.field} ${c.from} → ${c.to}`)
    if (!has('--write')) {
      console.log('[upstream-dsh] dry-run（加 --write 落盘；之后必须 npm run setup:runtime + npm run check + npm run e2e:bridge）')
      return
    }
    applyPlan(rootPkg, hostPkg, plan, target)
    writeJson('package.json', rootPkg)
    writeJson('packages/host/package.json', hostPkg)
    console.log(`[upstream-dsh] 已写入。下一步：npm run setup:runtime && npm run check && npm run e2e:bridge`)
    console.log(`[upstream-dsh] 发版号：v${plan.shellVersion}（electron-updater 只认更高的壳版本）`)
    return
  }

  throw new Error(`未知参数：${argv.join(' ')}（用 --help 看用法）`)
}

// 直接运行时才执行 CLI；被 test/ 引用时只导出纯函数（import.meta.main 由 Node 提供）
if (import.meta.main) {
  main().catch((error) => {
    console.error(`[upstream-dsh] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
