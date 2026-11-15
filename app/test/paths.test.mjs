import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, test } from 'node:test'

import { createBackups } from '../server/backups.mjs'
import { listFolders, moveItem } from '../server/fileops.mjs'
import { checkSegment, listNotes, resolveInside, resolveNotePath, realPathMatches, scanVault } from '../server/paths.mjs'

let root
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-')))
})

const everywhere = ['', '.', '..', '.git/a.md', '.Obsidian/a.md', 'node_modules/a.md', 'Node_Modules/a.md', 'a\\b.md', 'a\x01b.md', 'a//b.md']
const winOnly = ['a:b.md', 'a<b.md', 'a>b.md', 'a"b.md', 'a|b.md', 'a?b.md', 'a*b.md', 'dir.', 'note .md ', 'CON', 'con.md', 'CON .md', 'nul.txt.md', 'PRN.md', 'AUX.md', 'CONIN$.md', 'CONOUT$.md', 'COM0.md', 'COM9.md', 'LPT1.md', 'COM¹.md', 'LPT³.md']
const fine = ['Daily/2026-11-14.md', '日本語 ノート.md', 'console.md', 'con-notes.md', 'COM10.md', 'a.b.md']

test('どのOSでも受け付けない名前', () => {
  for (const rel of everywhere) {
    assert.throws(() => resolveNotePath(root, rel.endsWith('.md') ? rel : `${rel}.md`), /path not allowed/, rel)
  }
  for (const name of ['', '.', '..', '.git', '.Obsidian', 'node_modules', 'NODE_MODULES', 'a\\b', 'a\x1fb']) {
    for (const platform of ['darwin', 'win32']) {
      assert.throws(() => checkSegment(name, platform), /path not allowed/, `${platform}:${name}`)
    }
  }
})

test('Windowsだけで受け付けない名前', () => {
  for (const rel of winOnly) {
    for (const name of rel.split('/')) {
      if (name === '') continue
      assert.throws(() => checkSegment(name, 'win32'), /path not allowed/, `win32:${name}`)
    }
  }
  for (const rel of winOnly) {
    for (const name of rel.split('/')) assert.doesNotThrow(() => checkSegment(name, 'darwin'), `darwin:${name}`)
  }
})

test('普通の名前はどちらのOSでも通る', () => {
  for (const rel of fine) {
    for (const platform of ['darwin', 'win32']) {
      for (const name of rel.split('/')) assert.doesNotThrow(() => checkSegment(name, platform), `${platform}:${name}`)
    }
    assert.doesNotThrow(() => resolveNotePath(root, rel), rel)
  }
})

test('フォルダーへのシンボリックリンクを通る指定は断る', () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-out-')))
  fs.symlinkSync(outside, path.join(root, 'link'))
  assert.throws(() => resolveNotePath(root, 'link/a.md'), /path not allowed/)
})

test('Windows用の実体の確認：ジャンクションや短い名前でVaultの外に出たら断る', () => {
  assert.equal(realPathMatches('C:\\V', 'C:\\V\\Sub\\x', ['Sub', 'x']), true)
  assert.equal(realPathMatches('C:\\V', 'C:\\V\\sub\\X', ['Sub', 'x']), true)
  assert.equal(realPathMatches('C:\\V', 'C:\\Windows\\x', ['Sub', 'x']), false)
  assert.equal(realPathMatches('C:\\V', 'C:\\V\\Other', ['Sub']), false)
  assert.equal(realPathMatches('C:\\V', 'C:\\V', []), true)
  assert.equal(realPathMatches('C:\\V', 'C:\\VV\\Sub', ['Sub']), false)
})

test('一時ファイルと受け付けない名前は一覧に出ない', () => {
  fs.writeFileSync(path.join(root, 'n.md'), 'x')
  fs.writeFileSync(path.join(root, '.n.md.123.456.tmp'), 'x')
  fs.writeFileSync(path.join(root, 'a\\b.md'), 'x')
  fs.mkdirSync(path.join(root, 'Node_Modules'))
  fs.writeFileSync(path.join(root, 'Node_Modules', 'in.md'), 'x')
  assert.deepEqual(listNotes(root), ['n.md'])
  assert.deepEqual(listFolders(root), [])
})

test('移動：もうあるファイルへは409、大文字小文字だけの変更は通る', () => {
  fs.writeFileSync(path.join(root, 'a.md'), 'A')
  fs.writeFileSync(path.join(root, 'b.md'), 'B')
  const backups = createBackups(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-bak-')), { vaultId: '0123456789abcdef' })
  assert.throws(() => moveItem(root, 'a.md', 'b.md', { backups }), (e) => e.status === 409)
  assert.equal(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), 'B')
  moveItem(root, 'a.md', 'A.md', { backups })
  assert.ok(fs.readdirSync(root).includes('A.md'))
  assert.equal(fs.readFileSync(path.join(root, 'A.md'), 'utf8'), 'A')
})

test('win32の分岐：存在する親フォルダーと実体の確認', (t) => {
  const win = { platform: 'win32' }
  fs.mkdirSync(path.join(root, 'Sub'))
  assert.equal(resolveInside(root, 'Sub/new.md', win), path.join(root, 'Sub', 'new.md'))
  assert.equal(resolveInside(root, 'Sub/x/y/new.md', win), path.join(root, 'Sub', 'x', 'y', 'new.md'))
  assert.equal(resolveInside(root, 'Sub', win), path.join(root, 'Sub'))
  assert.equal(resolveInside(root, 'new.md', win), path.join(root, 'new.md'))
  // ジャンクションの想定：lstatでは普通のフォルダーだが、実体はVaultの外。realpathの結果を差し替えて確かめる。
  fs.mkdirSync(path.join(root, 'Junc'))
  const real = fs.realpathSync.native
  const original = real
  t.mock.method(fs.realpathSync, 'native', (p) => (p === path.join(root, 'Junc') ? path.join(os.tmpdir(), 'elsewhere') : real(p)))
  assert.throws(() => resolveInside(root, 'Junc/a.md', win), /path not allowed/)
  t.mock.restoreAll()
  assert.equal(fs.realpathSync.native, original)
  // 短い名前（別の綴り）に化けた場合も断る。
  t.mock.method(fs.realpathSync, 'native', (p) => (p === path.join(root, 'Sub') ? path.join(root, 'SUB~1') : real(p)))
  assert.throws(() => resolveInside(root, 'Sub/a.md', win), /path not allowed/)
  t.mock.restoreAll()
  assert.equal(fs.realpathSync.native, original)
})

test('win32の分岐：実際の名前と大文字小文字だけが違う親は通る', (t) => {
  const probe = path.join(root, 'ProbeCase')
  fs.mkdirSync(probe)
  if (!fs.existsSync(path.join(root, 'probecase'))) return t.skip('大文字小文字を区別するファイルシステム')
  assert.equal(resolveInside(root, 'probecase/new.md', { platform: 'win32' }), path.join(root, 'probecase', 'new.md'))
})

const putNote = (rel) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), 'x')
}

test('scanVault：件数の上限を超えたら truncated', () => {
  for (const name of ['a', 'b', 'c', 'd', 'e']) putNote(`${name}.md`)
  assert.equal(scanVault(root, { maxEntries: 5 }).truncated, false)
  putNote('f.md')
  const result = scanVault(root, { maxEntries: 5 })
  assert.equal(result.truncated, true)
  assert.equal(result.notes.length, 5)
})

test('scanVault：深さの上限。3段目のノートは出ない', () => {
  putNote('one.md')
  putNote('a/two.md')
  putNote('a/b/three.md')
  const result = scanVault(root, { maxDepth: 2 })
  assert.deepEqual(result.notes, ['a/two.md', 'one.md'])
  assert.equal(result.truncated, true)
  assert.equal(scanVault(root, { maxDepth: 3 }).truncated, false)
})

test('scanVault：深いフォルダーが多くても、上の階層のノートは出る', () => {
  putNote('top.md')
  for (let i = 0; i < 10; i++) putNote(`deep/x/y/n${i}.md`)
  const result = scanVault(root, { maxEntries: 3 })
  assert.ok(result.notes.includes('top.md'))
  assert.equal(result.truncated, true)
})

test('scanVault：unlisted は一覧に出さず known には入れる。大文字小文字は区別しない', () => {
  putNote('Archives/a.md')
  putNote('Archives/sub/b.md')
  putNote('keep.md')
  const result = scanVault(root, { unlisted: new Set(['archives']) })
  assert.deepEqual(result.notes, ['keep.md'])
  assert.deepEqual(result.known, ['Archives/a.md', 'Archives/sub/b.md', 'keep.md'])
  assert.deepEqual(result.folders, [])
  assert.equal(scanVault(root).notes.length, 3)
})

test('scanVault：isHidden が true のものは、どこにも出さない', () => {
  putNote('shown.md')
  putNote('hidden.md')
  putNote('hdir/in.md')
  const isHidden = (full) => /hidden\.md$|hdir$/.test(full)
  const result = scanVault(root, { isHidden })
  assert.deepEqual(result.notes, ['shown.md'])
  assert.deepEqual(result.known, ['shown.md'])
  assert.deepEqual(result.folders, [])
})

test('scanVault：深さの上限にある空のフォルダーは途中までと数えない。ノートがあれば数える', () => {
  fs.mkdirSync(path.join(root, 'a/b'), { recursive: true })
  assert.equal(scanVault(root, { maxDepth: 2 }).truncated, false)
  putNote('a/b/n.md')
  assert.equal(scanVault(root, { maxDepth: 2 }).truncated, true)
})

test('scanVault：読めないフォルダーは unreadable に入れる', (t) => {
  if (process.getuid?.() === 0 || process.platform === 'win32') return t.skip('権限を外せない環境')
  putNote('ok/a.md')
  putNote('locked/b.md')
  fs.chmodSync(path.join(root, 'locked'), 0o000)
  try {
    const result = scanVault(root)
    assert.deepEqual(result.unreadable, ['locked'])
    assert.deepEqual(result.notes, ['ok/a.md'])
  } finally {
    fs.chmodSync(path.join(root, 'locked'), 0o755)
  }
})

test('listNotes：途中までしかたどれないときはエラー', () => {
  putNote('a.md')
  putNote('b.md')
  assert.deepEqual(listNotes(root), ['a.md', 'b.md'])
  assert.throws(() => listNotes(root, { maxEntries: 1 }), { message: 'list-truncated' })
})
