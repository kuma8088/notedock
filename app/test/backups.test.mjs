import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createBackups, localDay } from '../server/backups.mjs'
import { moveItem } from '../server/fileops.mjs'
import { hashBytes, readNote, writeNote } from '../server/notes.mjs'

const DAY = 24 * 60 * 60 * 1000
const A = '0123456789abcdef'
const B = 'fedcba9876543210'
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))

test('vaultIdがなければエラー', () => {
  assert.throws(() => createBackups(tmp('bk')), /vaultId/)
  assert.throws(() => createBackups(tmp('bk'), {}), /vaultId/)
})

test('2つのVaultで同じ場所のノートを保存しても、履歴が混ざらない', () => {
  const dir = tmp('bk')
  const a = createBackups(dir, { vaultId: A })
  const b = createBackups(dir, { vaultId: B })
  a.save('n.md', 'from A', 'previous')
  b.save('n.md', 'from B', 'previous')
  assert.equal(a.list('n.md').length, 1)
  assert.equal(b.list('n.md').length, 1)
  assert.equal(a.read('n.md', a.list('n.md')[0].id), 'from A')
  assert.equal(b.read('n.md', b.list('n.md')[0].id), 'from B')
  assert.ok(fs.existsSync(path.join(dir, A)) && fs.existsSync(path.join(dir, B)))
})

test('firstOfDayは1日1回。翌日は、中身が同じでも書く', () => {
  const dir = tmp('bk')
  let now = new Date(2026, 10, 14, 9, 0, 0).getTime()
  const backups = createBackups(dir, { vaultId: A, now: () => now })
  assert.equal(backups.firstOfDay('n.md', 'x'), true)
  now += 60 * 1000
  assert.equal(backups.firstOfDay('n.md', 'y'), false)
  assert.equal(backups.list('n.md').filter((b) => b.kind === 'daily').length, 1)
  now += DAY
  assert.equal(backups.firstOfDay('n.md', 'x'), true)
  assert.equal(backups.list('n.md').filter((b) => b.kind === 'daily').length, 2)
})

test('dayOfを差し込める', () => {
  const backups = createBackups(tmp('bk'), { vaultId: A, now: () => 1000, dayOf: () => 'same-day' })
  assert.equal(backups.firstOfDay('n.md', 'x'), true)
  assert.equal(backups.firstOfDay('n.md', 'x'), false)
})

test('localDayはYYYY-MM-DD', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05')
})

test('dailyは29日後に残り、31日後に消える', () => {
  const dir = tmp('bk')
  let now = 1_800_000_000_000
  const backups = createBackups(dir, { vaultId: A, now: () => now })
  backups.firstOfDay('n.md', 'x')
  now += 29 * DAY
  backups.prune()
  assert.equal(backups.list('n.md').filter((b) => b.kind === 'daily').length, 1)
  now += 2 * DAY
  backups.prune()
  assert.equal(backups.list('n.md').length, 0)
})

test('今の形（20文字の名前）のフォルダーはpruneで消さない', () => {
  const dir = tmp('bk')
  const old = path.join(dir, '0123456789abcdef0123')
  fs.mkdirSync(old)
  fs.writeFileSync(path.join(old, 'previous-1-1.md'), 'old')
  createBackups(dir, { vaultId: A, now: () => 1_800_000_000_000 }).prune()
  assert.ok(fs.existsSync(path.join(old, 'previous-1-1.md')))
})

test('writeNoteは書き換え前の中身をdailyに残す', () => {
  const root = fs.realpathSync(tmp('bkroot'))
  fs.writeFileSync(path.join(root, 'w.md'), 'one\r\n')
  const backups = createBackups(tmp('bk'), { vaultId: A })
  writeNote(root, 'w.md', 'two\n', hashBytes(Buffer.from('one\r\n')), backups)
  const daily = backups.list('w.md').filter((b) => b.kind === 'daily')
  assert.equal(daily.length, 1)
  assert.equal(backups.read('w.md', daily[0].id), 'one\n')
  writeNote(root, 'w.md', 'three\n', readNote(root, 'w.md').hash, backups)
  assert.equal(backups.list('w.md').filter((b) => b.kind === 'daily').length, 1)
})

test('移動でリンクを書き換えたノートにdailyができる', () => {
  const root = fs.realpathSync(tmp('bkroot'))
  fs.writeFileSync(path.join(root, 'a.md'), 'A\n')
  fs.writeFileSync(path.join(root, 'b.md'), 'see [[a]]\n')
  const backups = createBackups(tmp('bk'), { vaultId: A })
  const result = moveItem(root, 'a.md', 'c.md', { relink: true, backups })
  assert.deepEqual(result.rewritten.map((r) => r.path), ['b.md'])
  const daily = backups.list('b.md').filter((b) => b.kind === 'daily')
  assert.equal(daily.length, 1)
  assert.equal(backups.read('b.md', daily[0].id), 'see [[a]]\n')
})

test('「今日」はパソコンの暦の日。24時間ではなく日付の変わり目で決まる', () => {
  let now = new Date(2026, 10, 14, 23, 59).getTime()
  const backups = createBackups(tmp('bk'), { vaultId: A, now: () => now })
  assert.equal(backups.firstOfDay('n.md', 'x'), true)
  now = new Date(2026, 10, 15, 0, 1).getTime()
  assert.equal(backups.firstOfDay('n.md', 'x'), true, '2分後でも日付が変われば書く')
  now = new Date(2026, 10, 15, 23, 59).getTime()
  assert.equal(backups.firstOfDay('n.md', 'x'), false, '同じ日なら約24時間後でも書かない')
})

test('vaultIdは16文字の小文字16進だけ受け付ける', () => {
  for (const bad of ['..', 'abc', 'ABCDEF0123456789', '0123456789abcdeg', '../0123456789abc']) {
    assert.throws(() => createBackups(tmp('bk'), { vaultId: bad }), /vaultId/, bad)
  }
})

test('pruneは、Vaultフォルダーの中にファイルがあっても、フォルダーが消えても止まらない', () => {
  const dir = tmp('bk')
  fs.mkdirSync(path.join(dir, A))
  fs.writeFileSync(path.join(dir, A, 'stray.txt'), 'x')
  fs.writeFileSync(path.join(dir, B), 'file, not folder')
  const backups = createBackups(dir, { vaultId: A, now: () => 1_800_000_000_000 })
  assert.doesNotThrow(() => backups.prune())
  const note = path.join(dir, A, 'a'.repeat(20))
  fs.mkdirSync(note)
  fs.writeFileSync(path.join(note, 'previous-1-1.md'), 'old')
  fs.chmodSync(note, 0o500)
  try {
    assert.doesNotThrow(() => backups.prune())
  } finally {
    fs.chmodSync(note, 0o700)
  }
})
