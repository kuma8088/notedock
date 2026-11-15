import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, test } from 'node:test'

import { createBackups } from '../server/backups.mjs'
import { moveItem } from '../server/fileops.mjs'
import { hashBytes, readNote, toDisk, writeNote } from '../server/notes.mjs'

let root
let backups
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const raw = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eol-')))
  backups = createBackups(fs.mkdtempSync(path.join(os.tmpdir(), 'eol-bak-')), { vaultId: '0123456789abcdef' })
})

test('CRLFのノートは編集できる。textはLF、eolはcrlf、hashはディスク上の中身', () => {
  put('a.md', 'a\r\nb\r\n')
  const note = readNote(root, 'a.md')
  assert.equal(note.editable, true)
  assert.equal(note.reason, null)
  assert.equal(note.text, 'a\nb\n')
  assert.equal(note.eol, 'crlf')
  assert.equal(note.hash, hashBytes(Buffer.from('a\r\nb\r\n')))
})

test('LFのノートと改行のないノートはeolがlf', () => {
  put('l.md', 'a\nb\n')
  put('n.md', 'abc')
  assert.equal(readNote(root, 'l.md').eol, 'lf')
  assert.equal(readNote(root, 'n.md').eol, 'lf')
})

test('CRLFのノートに書くと、CRLFで保存し、返すhashは書いた中身から作る', () => {
  put('a.md', 'a\r\nb\r\n')
  const first = writeNote(root, 'a.md', 'a\nb\nc\n', readNote(root, 'a.md').hash, backups)
  assert.equal(raw('a.md'), 'a\r\nb\r\nc\r\n')
  assert.equal(first.conflict, false)
  assert.equal(first.hash, hashBytes(Buffer.from('a\r\nb\r\nc\r\n')))
  const second = writeNote(root, 'a.md', 'a\nb\nc\nd\n', first.hash, backups)
  assert.equal(second.conflict, false)
  assert.equal(raw('a.md'), 'a\r\nb\r\nc\r\nd\r\n')
})

test('LFとCRLFが混ざった文を渡しても、\\r\\r\\nにならない', () => {
  put('a.md', 'x\r\n')
  writeNote(root, 'a.md', 'a\r\nb\n', readNote(root, 'a.md').hash, backups)
  assert.equal(raw('a.md'), 'a\r\nb\r\n')
})

test('LFのノートはLFのまま保存する', () => {
  put('a.md', 'x\n')
  writeNote(root, 'a.md', 'a\nb\n', readNote(root, 'a.md').hash, backups)
  assert.equal(raw('a.md'), 'a\nb\n')
})

test('LFとCRLFが混ざったノートは編集できない', () => {
  put('m.md', 'a\r\nb\n')
  const note = readNote(root, 'm.md')
  assert.equal(note.editable, false)
  assert.equal(note.reason, 'mixed-eol')
})

test('CRLFのExcalidrawのノートは編集できない', () => {
  put('x.md', '---\r\nexcalidraw-plugin: parsed\r\n---\r\n')
  const note = readNote(root, 'x.md')
  assert.equal(note.editable, false)
  assert.equal(note.reason, 'excalidraw')
})

test('toDisk', () => {
  assert.equal(toDisk('a\r\nb\rc\n', 'lf'), 'a\nb\nc\n')
  assert.equal(toDisk('a\r\nb\rc\n', 'crlf'), 'a\r\nb\r\nc\r\n')
})

test('リンクの書き換えでも、CRLFのノートはCRLFのまま', () => {
  put('Home.md', '[企画](プロジェクト/企画.md)\r\nx\r\n')
  put('プロジェクト/企画.md', 'y\n')
  const moved = moveItem(root, 'プロジェクト/企画.md', '企画.md', { relink: true, backups })
  assert.deepEqual(moved.rewritten.map((r) => r.path), ['Home.md'])
  assert.equal(raw('Home.md'), '[企画](企画.md)\r\nx\r\n')
})

test('CRLFのノートで古いhashのまま保存すると、衝突を返し、ファイルは変わらない', () => {
  put('s.md', 'a\r\nb\r\n')
  const stale = hashBytes(Buffer.from('old\r\n'))
  const before = fs.readFileSync(path.join(root, 's.md'))
  const result = writeNote(root, 's.md', 'x\n', stale, backups)
  assert.equal(result.conflict, true)
  assert.equal(result.current, 'a\nb\n')
  assert.ok(!result.current.includes('\r'))
  assert.ok(fs.readFileSync(path.join(root, 's.md')).equals(before))
})
