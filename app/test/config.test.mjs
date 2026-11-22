import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { CHAT_HEADER, chatHashOf, createApp } from '../server/app.mjs'

const LINK = 'L'.repeat(43)
import { canonicalRoot, defaultStateDir, isRefusedRoot, vaultDirOf, vaultIdOf } from '../server/config.mjs'

test('defaultStateDir はOSごとの場所を返す', () => {
  assert.equal(defaultStateDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } }), 'C:\\Users\\a\\AppData\\Local\\NoteDock')
  assert.equal(defaultStateDir({ platform: 'darwin', home: '/Users/a' }), '/Users/a/Library/Application Support/NoteDock')
  assert.throws(() => defaultStateDir({ platform: 'win32', env: {} }))
  assert.throws(() => defaultStateDir({ platform: 'linux' }), /unsupported platform/)
})

test('vaultIdOf は場所から16文字を作る', () => {
  assert.equal(vaultIdOf('C:\\Notes', 'win32'), vaultIdOf('c:/notes', 'win32'))
  assert.notEqual(vaultIdOf('/A/Notes'), vaultIdOf('/B/Notes'))
  assert.match(vaultIdOf('/A/Notes'), /^[0-9a-f]{16}$/)
  assert.equal(vaultDirOf('/s', 'abc'), path.join('/s', 'vaults', 'abc'))
})

test('canonicalRoot は実際の書き方にそろえる', (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')))
  fs.mkdirSync(path.join(tmp, 'Notes'))
  const insensitive = fs.existsSync(path.join(tmp, 'notes'))
  if (!insensitive) return t.skip('大文字と小文字を区別するディスク')
  assert.equal(canonicalRoot(path.join(tmp, 'notes')), path.join(tmp, 'Notes'))
})

test('isRefusedRoot は広すぎる場所を断る', () => {
  const win = { platform: 'win32', home: 'C:\\Users\\a' }
  for (const r of ['C:\\', 'c:\\users', 'D:\\', 'C:\\Users\\a']) assert.equal(isRefusedRoot(r, win), true, r)
  assert.equal(isRefusedRoot('C:\\Users\\a\\Notes', win), false)
  const mac = { platform: 'darwin', home: '/Users/a' }
  for (const r of ['/', '/Users', '/Users/a']) assert.equal(isRefusedRoot(r, mac), true, r)
  assert.equal(isRefusedRoot('/Users/a/Notes', mac), false)
})

test('isRefusedRoot はMacでは大文字と小文字を区別せず、ホームの実際の書き方とも比べる', () => {
  const mac = { platform: 'darwin', home: '/Users/a' }
  for (const r of ['/users', '/USERS/', '/Users/A', '/users/a/']) assert.equal(isRefusedRoot(r, mac), true, r)
  assert.equal(isRefusedRoot('/Users/a/notes', mac), false)
  // ホームがシンボリックリンク経由で渡されても、たどった先と比べる。
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')))
  fs.mkdirSync(path.join(tmp, 'Real'))
  fs.symlinkSync(path.join(tmp, 'Real'), path.join(tmp, 'link'))
  const linked = { platform: 'darwin', home: path.join(tmp, 'link') }
  assert.equal(isRefusedRoot(path.join(tmp, 'Real'), linked), true)
  assert.equal(isRefusedRoot(path.join(tmp, 'real'), linked), true)
  assert.equal(isRefusedRoot(path.join(tmp, 'Real', 'Notes'), linked), false)
  // ホームが見つからなくても、渡された書き方で比べる。
  assert.equal(isRefusedRoot('/nowhere/Home', { platform: 'darwin', home: '/nowhere/home' }), true)
  // Mac以外（Linuxなど）は大文字と小文字を区別する。
  assert.equal(isRefusedRoot('/users', { platform: 'linux', home: '/home/a' }), false)
})

test('createApp は stateDir と vaultDir が必須', () => {
  assert.throws(() => createApp({ root: os.tmpdir(), port: 0, backupDir: os.tmpdir(), vaultDir: os.tmpdir() }), /stateDir/)
  assert.throws(() => createApp({ root: os.tmpdir(), port: 0, backupDir: os.tmpdir(), stateDir: os.tmpdir() }), /vaultDir/)
})

test('同名で場所の違う2つのVaultは、開いているノートの状態のファイルが別になる', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'two-')))
  const stateDir = path.join(tmp, 'state')
  const servers = []
  const dirs = []
  try {
    for (const side of ['A', 'B']) {
      const root = path.join(tmp, side, 'Notes')
      fs.mkdirSync(root, { recursive: true })
      const vaultDir = vaultDirOf(stateDir, vaultIdOf(canonicalRoot(root)))
      fs.mkdirSync(vaultDir, { recursive: true })
      // Modの代わりに、このVaultのチャットとの結び付けの印を書き、合図を鍵と引き換える（同じ合図でも、Vaultが違えば別のフォルダー）。
      const chatDir = path.join(vaultDir, 'chats', 'f'.repeat(64))
      fs.mkdirSync(chatDir, { recursive: true })
      fs.writeFileSync(path.join(chatDir, 'link.json'), JSON.stringify({ at: Date.now(), binds: [{ h: chatHashOf(LINK), until: Date.now() + 60_000 }] }))
      dirs.push(chatDir)
      const server = await createApp({ root, port: 0, backupDir: path.join(tmp, 'bak'), stateDir, vaultDir, noToken: true }).listen(0)
      servers.push(server)
      const { cred } = await (await fetch(`http://127.0.0.1:${server.address().port}/api/chat-bind`, {
        method: 'POST',
        headers: { 'x-note-editor': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ bind: LINK }),
      })).json()
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/state`, {
        method: 'PUT',
        headers: { 'x-note-editor': '1', 'content-type': 'application/json', [CHAT_HEADER]: cred },
        body: JSON.stringify({ path: `${side}.md`, title: side }),
      })
      assert.equal(res.status, 200)
    }
    assert.notEqual(dirs[0], dirs[1])
    const [a, b] = dirs.map((d) => JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8')))
    assert.equal(a.path, 'A.md')
    assert.equal(b.path, 'B.md')
    assert.equal(fs.existsSync(path.join(stateDir, 'current-note.json')), false)
    assert.equal(fs.existsSync(path.join(stateDir, 'chats')), false)
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r))
  }
})

test('製品名は src/product.mjs の1か所から読む', async () => {
  const { PRODUCT } = await import('../server/config.mjs')
  const shared = await import('../src/product.mjs')
  assert.equal(PRODUCT, shared.PRODUCT)
  assert.equal(PRODUCT, 'NoteDock')
})
