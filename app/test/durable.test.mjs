import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, mock, test } from 'node:test'

import { removeStaleTemps, renameWithRetry, replaceFile } from '../server/durable.mjs'

let dir
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'durable-')))
})
afterEach(() => {
  mock.restoreAll()
  fs.rmSync(dir, { recursive: true, force: true })
})

const temps = () => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
const errorOf = (code) => Object.assign(new Error(code), { code })

test('Macで差し替えると、書き込みを確定させ、中身が新しくなり、一時ファイルが残らない', () => {
  const file = path.join(dir, 'a.md')
  fs.writeFileSync(file, 'old')
  const sync = mock.method(fs, 'fsyncSync')
  assert.equal(replaceFile(file, 'new', { platform: 'darwin' }), true)
  assert.ok(sync.mock.callCount() >= 2)
  assert.equal(fs.readFileSync(file, 'utf8'), 'new')
  assert.deepEqual(temps(), [])
})

test('fsyncがEIOで失敗すると、中身は元のまま、一時ファイルは残らず、エラーになる', () => {
  const file = path.join(dir, 'a.md')
  fs.writeFileSync(file, 'old')
  mock.method(fs, 'fsyncSync', () => { throw errorOf('EIO') })
  assert.throws(() => replaceFile(file, 'new', { platform: 'darwin' }), { code: 'EIO' })
  assert.equal(fs.readFileSync(file, 'utf8'), 'old')
  assert.deepEqual(temps(), [])
})

test('checkがfalseなら、中身は元のままでfalse', () => {
  const file = path.join(dir, 'a.md')
  fs.writeFileSync(file, 'old')
  assert.equal(replaceFile(file, 'new', { check: () => false, platform: 'darwin' }), false)
  assert.equal(fs.readFileSync(file, 'utf8'), 'old')
  assert.deepEqual(temps(), [])
})

test('modeが保たれる', () => {
  const file = path.join(dir, 'a.md')
  fs.writeFileSync(file, 'old')
  replaceFile(file, 'new', { mode: 0o664, platform: 'darwin' })
  assert.equal(fs.statSync(file).mode & 0o777, 0o664)
})

test('renameがEBUSYで2回失敗したあと成功すると、Windowsでは3回呼ばれ、Macでは1回目でエラー', () => {
  for (const [platform, calls, fails] of [['win32', 3, false], ['darwin', 1, true]]) {
    const from = path.join(dir, `${platform}-from`)
    const to = path.join(dir, `${platform}-to`)
    fs.writeFileSync(from, 'x')
    const real = fs.renameSync
    let n = 0
    const m = mock.method(fs, 'renameSync', (a, b) => {
      n += 1
      if (n <= 2) throw errorOf('EBUSY')
      return real(a, b)
    })
    if (fails) assert.throws(() => renameWithRetry(from, to, platform), { code: 'EBUSY' })
    else renameWithRetry(from, to, platform)
    assert.equal(m.mock.callCount(), calls, platform)
    mock.restoreAll()
  }
})

test('WindowsでEBUSYが6回続くとエラーになり、元のファイルは元のまま', () => {
  const file = path.join(dir, 'a.md')
  fs.writeFileSync(file, 'old')
  const m = mock.method(fs, 'renameSync', () => { throw errorOf('EBUSY') })
  assert.throws(() => replaceFile(file, 'new', { platform: 'win32' }), { code: 'EBUSY' })
  assert.equal(m.mock.callCount(), 6)
  assert.equal(fs.readFileSync(file, 'utf8'), 'old')
  assert.deepEqual(temps(), [])
})

test('removeStaleTempsは1時間より古い形の合う一時ファイルだけを消す', () => {
  fs.mkdirSync(path.join(dir, 'sub'))
  const old = path.join(dir, 'sub', '.a.md.notedock-1-x.tmp')
  const recent = path.join(dir, '.a.md.notedock-1-y.tmp')
  const other = path.join(dir, '.a.md.tmp')
  const bad = path.join(dir, '.a.md.notedock-x.tmp')
  const hidden = path.join(dir, '.git', '.a.md.notedock-1-z.tmp')
  fs.mkdirSync(path.join(dir, '.git'))
  for (const f of [old, recent, other, hidden, bad]) fs.writeFileSync(f, 'x')
  const now = Date.now()
  fs.utimesSync(old, new Date(now - 2 * 3600e3), new Date(now - 2 * 3600e3))
  fs.utimesSync(other, new Date(now - 2 * 3600e3), new Date(now - 2 * 3600e3))
  fs.utimesSync(bad, new Date(now - 2 * 3600e3), new Date(now - 2 * 3600e3))
  fs.utimesSync(hidden, new Date(now - 2 * 3600e3), new Date(now - 2 * 3600e3))
  fs.utimesSync(recent, new Date(now - 600e3), new Date(now - 600e3))
  assert.equal(removeStaleTemps(dir), 1)
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(recent), true)
  assert.equal(fs.existsSync(other), true)
  assert.equal(fs.existsSync(hidden), true)
  assert.equal(fs.existsSync(bad), true)
})

test('書き込みが途中で切れても、最後まで書く', () => {
  const file = path.join(dir, 'a.md')
  fs.writeFileSync(file, 'old')
  const real = fs.writeSync
  mock.method(fs, 'writeSync', (fd, buf, off, len) => real(fd, buf, off, Math.min(3, len)))
  replaceFile(file, '0123456789日本語', { platform: 'darwin' })
  assert.equal(fs.readFileSync(file, 'utf8'), '0123456789日本語')
})

test('書き込みが0バイトのままなら、エラーで元のまま、一時ファイルも残らない', () => {
  const file = path.join(dir, 'a.md')
  fs.writeFileSync(file, 'old')
  mock.method(fs, 'writeSync', () => 0)
  assert.throws(() => replaceFile(file, 'new', { platform: 'darwin' }))
  assert.equal(fs.readFileSync(file, 'utf8'), 'old')
  assert.deepEqual(temps(), [])
})

test('Windowsではfchmodを呼ばない', () => {
  const file = path.join(dir, 'a.md')
  fs.writeFileSync(file, 'old')
  const m = mock.method(fs, 'fchmodSync')
  replaceFile(file, 'new', { mode: 0o664, platform: 'win32' })
  assert.equal(m.mock.callCount(), 0)
  assert.equal(fs.readFileSync(file, 'utf8'), 'new')
})

test('replaceFileの一時ファイルの名前は、製品名から作っても今までどおり .notedock- の形', () => {
  const file = path.join(dir, 'a.md')
  let seen = []
  replaceFile(file, 'x', { check: () => ((seen = fs.readdirSync(dir).filter((name) => name !== 'a.md')), true) })
  assert.equal(seen.length, 1)
  assert.match(seen[0], new RegExp(`^\\.a\\.md\\.notedock-${process.pid}-[0-9a-f]{12}\\.tmp$`))
})
