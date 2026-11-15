import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { statusOf } from '../server/app.mjs'
import { scanVault } from '../server/paths.mjs'
import { isAlive, isHiddenFile, moveToTrash, ownerOnly, watchParent } from '../server/platform.mjs'

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'watch-child.mjs')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(file, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true
    await sleep(100)
  }
  return fs.existsSync(file)
}

test('isAlive は自分は true、終わった子プロセスは false', () => {
  assert.equal(isAlive(process.pid), true)
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  return new Promise((resolve) => {
    child.on('exit', () => {
      assert.equal(isAlive(child.pid), false)
      resolve()
    })
  })
})

test('起動元が強制終了されたら、見張っている子プロセスが目印のファイルを書いて終わる', { skip: process.platform !== 'darwin' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'))
  const marker = path.join(dir, 'gone.txt')
  const sh = spawn('sh', ['-c', `'${process.execPath}' '${CHILD}' '${marker}' & wait`], { stdio: 'ignore' })
  try {
    await sleep(1000)
    process.kill(sh.pid, 'SIGKILL')
    assert.equal(await waitFor(marker, 10000), true)
  } finally {
    try { sh.kill('SIGKILL') } catch {}
    try { execFileSync('pkill', ['-f', `${CHILD} ${marker}`]) } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('見張らない子プロセスは、起動元が終わっても目印を書かず動き続ける（くらべるため）', { skip: process.platform !== 'darwin' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'))
  const marker = path.join(dir, 'gone.txt')
  const sh = spawn('sh', ['-c', `'${process.execPath}' '${CHILD}' '${marker}' nowatch & echo $! > '${dir}/pid'; wait`], { stdio: 'ignore' })
  let pid = null
  try {
    await sleep(1000)
    pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'))
    process.kill(sh.pid, 'SIGKILL')
    assert.equal(await waitFor(marker, 4000), false)
    assert.equal(isAlive(pid), true)
  } finally {
    try { sh.kill('SIGKILL') } catch {}
    if (pid) try { process.kill(pid, 'SIGKILL') } catch {}
    try { execFileSync('pkill', ['-f', `${CHILD} ${marker}`]) } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Windowsのごみ箱: Vaultの.trashへ、同じ相対パスで移す。同名は (2) を付ける', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trash-')))
  try {
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), text)
    }
    put('日記/a.md', '1')
    moveToTrash(path.join(root, '日記/a.md'), { platform: 'win32', root })
    assert.equal(fs.existsSync(path.join(root, '日記/a.md')), false)
    assert.equal(fs.readFileSync(path.join(root, '.trash/日記/a.md'), 'utf8'), '1')
    put('日記/a.md', '2')
    moveToTrash(path.join(root, '日記/a.md'), { platform: 'win32', root })
    assert.equal(fs.readFileSync(path.join(root, '.trash/日記/a (2).md'), 'utf8'), '2')
    put('日記/a.md', '3')
    moveToTrash(path.join(root, '日記/a.md'), { platform: 'win32', root })
    assert.equal(fs.readFileSync(path.join(root, '.trash/日記/a (3).md'), 'utf8'), '3')
    put('フォルダー/x.md', 'x')
    moveToTrash(path.join(root, 'フォルダー'), { platform: 'win32', root })
    assert.equal(fs.existsSync(path.join(root, 'フォルダー')), false)
    assert.equal(fs.readFileSync(path.join(root, '.trash/フォルダー/x.md'), 'utf8'), 'x')
    put('フォルダー/y.md', 'y')
    moveToTrash(path.join(root, 'フォルダー'), { platform: 'win32', root })
    assert.equal(fs.readFileSync(path.join(root, '.trash/フォルダー (2)/y.md'), 'utf8'), 'y')
    const { notes, folders } = scanVault(root)
    assert.deepEqual(notes, [])
    assert.ok(!JSON.stringify(folders).includes('.trash'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Windowsのごみ箱: rootがなければ500。Macの/usr/bin/trashの失敗も500', () => {
  assert.throws(() => moveToTrash('C:\\a.md', { platform: 'win32' }), { status: 500 })
  const boom = () => {
    throw Object.assign(new Error('x'), { status: 1 })
  }
  assert.throws(() => moveToTrash('/a.md', { platform: 'darwin', run: boom }), { status: 500, message: 'trash failed' })
})

test('watchParent: stop() を呼ぶと、起動元が終わっても何も起きない', { skip: process.platform !== 'darwin' }, async () => {
  let called = false
  const stop = watchParent(() => { called = true }, { intervalMs: 20 })
  stop()
  await sleep(100)
  assert.equal(called, false)
})

test('watchParent: 覚えた起動元が1（もう終わっている）なら、すぐ終わる。Windowsで覚えた起動元が終わっていても終わる', async () => {
  let posix = false
  watchParent(() => { posix = true }, { platform: 'darwin', intervalMs: 20, parentPid: 1 })
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  let win = false
  watchParent(() => { win = true }, { platform: 'win32', intervalMs: 20, parentPid: dead })
  let kept = false
  const stop = watchParent(() => { kept = true }, { platform: 'darwin', intervalMs: 20, parentPid: process.ppid })
  await sleep(200)
  stop()
  assert.equal(posix, true)
  assert.equal(win, true)
  assert.equal(kept, false, '起動元が動いていれば終わらない')
})

// .trash がVaultの外へのリンクのとき、Windowsでは見分けずにたどってしまう。lstatと実際の場所で確かめる。
test('Windowsのごみ箱: .trash がリンクやファイルなら移さず500、ノートはそのまま残る', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trash-link-')))
  const root = path.join(base, 'vault')
  const outside = path.join(base, 'outside')
  try {
    fs.mkdirSync(path.join(root, '日記'), { recursive: true })
    fs.mkdirSync(outside)
    const note = path.join(root, '日記', 'a.md')
    fs.writeFileSync(note, '1')
    fs.symlinkSync(outside, path.join(root, '.trash'), 'junction')
    assert.throws(() => moveToTrash(note, { platform: 'win32', root }), { status: 500, message: 'trash failed' })
    assert.equal(fs.readFileSync(note, 'utf8'), '1')
    assert.deepEqual(fs.readdirSync(outside), [])

    fs.rmSync(path.join(root, '.trash'))
    fs.writeFileSync(path.join(root, '.trash'), 'not a folder')
    assert.throws(() => moveToTrash(note, { platform: 'win32', root }), { status: 500, message: 'trash failed' })
    assert.equal(fs.readFileSync(note, 'utf8'), '1')

    // .trash の中のフォルダーが外へのリンクでも移さない。
    fs.rmSync(path.join(root, '.trash'))
    fs.mkdirSync(path.join(root, '.trash'))
    fs.symlinkSync(outside, path.join(root, '.trash', '日記'), 'junction')
    assert.throws(() => moveToTrash(note, { platform: 'win32', root }), { status: 500, message: 'trash failed' })
    assert.equal(fs.readFileSync(note, 'utf8'), '1')
    assert.deepEqual(fs.readdirSync(outside), [])

    // Vaultの外のファイルや、Vaultそのものは移さない。
    const stray = path.join(outside, 'b.md')
    fs.writeFileSync(stray, 'b')
    assert.throws(() => moveToTrash(stray, { platform: 'win32', root }), { status: 500, message: 'trash failed' })
    assert.throws(() => moveToTrash(root, { platform: 'win32', root }), { status: 500, message: 'trash failed' })
    assert.equal(fs.existsSync(stray), true)

    // 普通の .trash なら移せる。
    fs.rmSync(path.join(root, '.trash'), { recursive: true })
    moveToTrash(note, { platform: 'win32', root })
    assert.equal(fs.existsSync(note), false)
    assert.equal(fs.readFileSync(path.join(root, '.trash', '日記', 'a.md'), 'utf8'), '1')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('statusOf は400〜599以外の status を使わない', () => {
  assert.equal(statusOf(Object.assign(new Error('x'), { status: 1 })), 500)
  assert.equal(statusOf(Object.assign(new Error('x'), { status: 409 })), 409)
  assert.equal(statusOf(Object.assign(new Error('path not allowed'), { status: 1 })), 400)
})

test('ownerOnly: Windowsでは普通のファイルなら true、シンボリックリンクなら false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-'))
  try {
    const file = path.join(dir, 'a.json')
    fs.writeFileSync(file, '{}', { mode: 0o666 })
    fs.symlinkSync(file, path.join(dir, 'link.json'))
    assert.equal(ownerOnly(file, 'win32'), true)
    assert.equal(ownerOnly(path.join(dir, 'link.json'), 'win32'), false)
    assert.equal(ownerOnly(path.join(dir, 'ない.json'), 'win32'), false)
    fs.chmodSync(file, 0o600)
    assert.equal(ownerOnly(file, 'darwin'), true)
    fs.chmodSync(file, 0o644)
    assert.equal(ownerOnly(file, 'darwin'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('isHiddenFile: Windows以外とDenoなしでは false', () => {
  assert.equal(isHiddenFile('/a/b.md', 'darwin'), false)
  assert.equal(isHiddenFile('C:\\a\\b.md', 'win32'), false)
})
