import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, test } from 'node:test'

import { createBackups } from '../server/backups.mjs'
import { createFolder, listFolders, moveItem, planMove, trashItem } from '../server/fileops.mjs'

let root
let backups
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-')))
  backups = createBackups(fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-bak-')), { vaultId: '0123456789abcdef' })
  put('Home.md', '[企画](プロジェクト/企画.md) [[企画]]\n')
  put('プロジェクト/企画.md', '[家](../Home.md)\n')
  put('日記/2026/11-08.md', 'x')
  fs.mkdirSync(path.join(root, '空のフォルダー'))
  fs.mkdirSync(path.join(root, '.obsidian'))
  fs.mkdirSync(path.join(root, 'archives'))
})

test('中身のないフォルダーもファイル欄に出す。隠しフォルダーと、unlisted に渡したフォルダーは出さない', () => {
  assert.deepEqual(listFolders(root, { unlisted: new Set(['archives']) }).sort(), ['プロジェクト', '日記', '日記/2026', '空のフォルダー'].sort())
})

test('画像だけが入ったフォルダーも、中身のないフォルダーも出す', () => {
  put('図/a.png', 'png')
  put('図/下/b.png', 'png')
  fs.mkdirSync(path.join(root, '空の親/空の子'), { recursive: true })
  const list = listFolders(root)
  for (const folder of ['図', '図/下', '空の親', '空の親/空の子']) assert.ok(list.includes(folder), folder)
  assert.ok(list.indexOf('図') < list.indexOf('図/下'))
})
test('フォルダーを作る。あるときと、親がないときは断る', () => {
  createFolder(root, '日記/2027')
  assert.ok(fs.statSync(path.join(root, '日記/2027')).isDirectory())
  assert.throws(() => createFolder(root, '日記/2027'), { status: 409 })
  assert.throws(() => createFolder(root, 'ない/下'), { status: 409 })
  assert.throws(() => createFolder(root, '../外'))
  assert.throws(() => createFolder(root, '.隠し'))
})

test('ノートを動かすと、確かめたときだけリンクも書き換える', () => {
  const { changes: plan } = planMove(root, 'プロジェクト/企画.md', '日記/企画.md')
  // 同じ深さへ動かすので、動かしたノートの中の ../Home.md はそのままでよい。
  assert.deepEqual(plan.map((c) => [c.path, c.count]), [['Home.md', 1]])
  const moved = moveItem(root, 'プロジェクト/企画.md', '日記/企画.md', { relink: true, backups })
  assert.equal(moved.rewritten.length, 1)
  assert.equal(read('Home.md'), '[企画](日記/企画.md) [[企画]]\n')
  assert.equal(read('日記/企画.md'), '[家](../Home.md)\n')
  assert.equal(backups.list('Home.md').filter((b) => b.kind === 'previous').length, 1)
  assert.equal(backups.list('Home.md').filter((b) => b.kind === 'daily').length, 1)
})

test('書き換えないを選ぶと、ノートを動かすだけ', () => {
  moveItem(root, 'プロジェクト/企画.md', '日記/企画.md', { relink: false, backups })
  assert.equal(read('Home.md'), '[企画](プロジェクト/企画.md) [[企画]]\n')
  assert.ok(fs.existsSync(path.join(root, '日記/企画.md')))
})

test('名前の変更は、名前だけの [[ ]] も書き換える', () => {
  moveItem(root, 'プロジェクト/企画.md', 'プロジェクト/計画.md', { relink: true, backups })
  assert.equal(read('Home.md'), '[企画](プロジェクト/計画.md) [[計画]]\n')
})

test('フォルダーごと動かす。自分の中や、同じ名前があるところへは動かさない', () => {
  assert.throws(() => moveItem(root, 'プロジェクト', 'プロジェクト/下/プロジェクト'), { message: 'into itself' })
  assert.throws(() => moveItem(root, 'プロジェクト', '日記'), { status: 409 })
  moveItem(root, 'プロジェクト', '日記/プロジェクト', { relink: true, backups })
  assert.equal(read('Home.md'), '[企画](日記/プロジェクト/企画.md) [[企画]]\n')
  assert.equal(read('日記/プロジェクト/企画.md'), '[家](../../Home.md)\n')
})

test('ゴミ箱に入れるのはVaultの中のノートとフォルダーだけ', () => {
  const calls = []
  const run = (cmd, args) => {
    calls.push([cmd, ...args])
    fs.rmSync(args[0], { recursive: true })
  }
  trashItem(root, 'プロジェクト/企画.md', { run })
  trashItem(root, '空のフォルダー', { run })
  assert.deepEqual(calls, [['/usr/bin/trash', path.join(root, 'プロジェクト/企画.md')], ['/usr/bin/trash', path.join(root, '空のフォルダー')]])
  assert.throws(() => trashItem(root, '../x.md', { run }))
  assert.throws(() => trashItem(root, 'ない.md', { run }), { status: 404 })
  assert.throws(() => trashItem(root, '.obsidian', { run }))
})

test('大文字と小文字だけを変える名前の変更は通す。別のノートがある名前には変えない', () => {
  put('日記/abc.md', 'x')
  moveItem(root, '日記/abc.md', '日記/ABC.md', { backups })
  assert.ok(fs.readdirSync(path.join(root, '日記')).includes('ABC.md'))
  put('日記/other.md', 'y')
  assert.throws(() => moveItem(root, '日記/other.md', '日記/ABC.md', { backups }), { status: 409 })
})

test('編集できない形のノートは書き換えず、書き換えられなかったノートとして返す', () => {
  put('crlf.md', '[企画](プロジェクト/企画.md)\r\nx\n')
  const plan = planMove(root, 'プロジェクト/企画.md', '日記/企画.md')
  assert.deepEqual(plan.blocked.map((c) => c.path), ['crlf.md'])
  const moved = moveItem(root, 'プロジェクト/企画.md', '日記/企画.md', { relink: true, backups })
  assert.ok(moved.skipped.includes('crlf.md'))
  assert.equal(read('crlf.md'), '[企画](プロジェクト/企画.md)\r\nx\n')
})

test('ノートを動かすと、履歴も新しい場所へ移る', () => {
  backups.save('プロジェクト/企画.md', '前の中身', 'previous')
  moveItem(root, 'プロジェクト/企画.md', '日記/企画.md', { backups })
  assert.equal(backups.list('プロジェクト/企画.md').length, 0)
  assert.equal(backups.list('日記/企画.md').length, 1)
})

test('ゴミ箱に入れられなかったときは、残っているので失敗として返す', () => {
  assert.throws(() => trashItem(root, 'Home.md', { run: () => {} }), { message: 'still there' })
  assert.ok(fs.existsSync(path.join(root, 'Home.md')))
})

test('読めないノートは、書き換えの計画とは別に知らせる', () => {
  put('読めない.md', '[企画](プロジェクト/企画.md)')
  fs.chmodSync(path.join(root, '読めない.md'), 0o000)
  try {
    const plan = planMove(root, 'プロジェクト/企画.md', '日記/企画.md')
    assert.deepEqual(plan.unreadable, ['読めない.md'])
  } finally {
    fs.chmodSync(path.join(root, '読めない.md'), 0o644)
  }
})

test('たどりきれなかったときは、リンクの書き換えを計画せず409。書き換えない移動はできる', () => {
  const limited = { maxEntries: 2 }
  assert.throws(() => planMove(root, 'Home.md', 'Home2.md', limited), { status: 409, message: 'list-truncated' })
  assert.throws(() => moveItem(root, 'Home.md', 'Home2.md', { relink: true, backups, scanOptions: limited }), { status: 409, message: 'list-truncated' })
  assert.ok(fs.existsSync(path.join(root, 'Home.md')))
  moveItem(root, 'Home.md', 'Home2.md', { relink: false, backups, scanOptions: limited })
  assert.ok(fs.existsSync(path.join(root, 'Home2.md')))
})

test('読めないフォルダーは、計画の unreadable に入る', (t) => {
  if (process.getuid?.() === 0 || process.platform === 'win32') return t.skip('権限を外せない環境')
  put('locked/x.md', 'x')
  fs.chmodSync(path.join(root, 'locked'), 0o000)
  try {
    assert.ok(planMove(root, 'Home.md', 'Home3.md').unreadable.includes('locked'))
  } finally {
    fs.chmodSync(path.join(root, 'locked'), 0o755)
  }
})
