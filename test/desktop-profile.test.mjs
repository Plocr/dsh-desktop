import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESKTOP_PROFILE,
  LEGACY_PROFILE,
  profilesRoot,
  desktopProfileDir,
  legacyProfileDir,
  migrateLegacyProfileDir,
  readProfileName,
} from '../src/main/desktopProfile.ts'

test('desktopProfile：profile 名不得为官方保留名 desktop（CLI 拒绝启动）', () => {
  assert.notEqual(DESKTOP_PROFILE.toLowerCase(), LEGACY_PROFILE)
  assert.equal(DESKTOP_PROFILE, 'dsh-workbench')
})

test('desktopProfile：目录路径拼接', () => {
  const home = join('X:', 'dsh-home')
  assert.equal(profilesRoot(home), join(home, 'profiles'))
  assert.equal(desktopProfileDir(home), join(home, 'profiles', DESKTOP_PROFILE))
  assert.equal(legacyProfileDir(home), join(home, 'profiles', LEGACY_PROFILE))
})

test('migrateLegacyProfileDir：迁移真实 profile；残缺目录/目标已存在/重复调用都不动', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
  try {
    const home = join(root, 'home')
    // ① 无旧目录 → false
    mkdirSync(join(home, 'profiles'), { recursive: true })
    assert.equal(migrateLegacyProfileDir(home), false)

    // ② 旧目录残缺（无 package.json）→ 不迁移
    mkdirSync(join(home, 'profiles', LEGACY_PROFILE, 'node_modules', 'x'), { recursive: true })
    assert.equal(migrateLegacyProfileDir(home), false)
    assert.equal(existsSync(legacyProfileDir(home)), true)

    // ③ 补上 package.json → 迁移成功，内容保留
    writeFileSync(join(home, 'profiles', LEGACY_PROFILE, 'package.json'), JSON.stringify({ name: 'dsh-profile' }))
    writeFileSync(join(home, 'profiles', LEGACY_PROFILE, 'cordis.patch.yml'), '- insert:\n')
    assert.equal(migrateLegacyProfileDir(home), true)
    assert.equal(existsSync(legacyProfileDir(home)), false)
    assert.equal(existsSync(desktopProfileDir(home)), true)
    assert.equal(readFileSync(join(desktopProfileDir(home), 'cordis.patch.yml'), 'utf8'), '- insert:\n')
    assert.equal(existsSync(join(desktopProfileDir(home), 'node_modules', 'x')), true)

    // ④ 幂等：再次调用无旧目录 → false
    assert.equal(migrateLegacyProfileDir(home), false)

    // ⑤ 目标已存在时不迁移（保留现状）
    mkdirSync(join(home, 'profiles', LEGACY_PROFILE), { recursive: true })
    writeFileSync(join(home, 'profiles', LEGACY_PROFILE, 'package.json'), '{}')
    assert.equal(migrateLegacyProfileDir(home), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readProfileName：读取 profile manifest 名（缺失/损坏返回 null）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
  try {
    assert.equal(readProfileName(root), null)
    mkdirSync(desktopProfileDir(root), { recursive: true })
    writeFileSync(join(desktopProfileDir(root), 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop' }))
    assert.equal(readProfileName(root), 'dsh-profile-desktop')
    writeFileSync(join(desktopProfileDir(root), 'package.json'), '{broken')
    assert.equal(readProfileName(root), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
