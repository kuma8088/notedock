import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { createApp } from '../server/app.mjs'
import { createBackups } from '../server/backups.mjs'
import { vaultIdOf } from '../server/config.mjs'
import { hashText, readNote, writeNote } from '../server/notes.mjs'
import { listNotes, resolveNotePath } from '../server/paths.mjs'
import { checkRequest } from '../server/security.mjs'
import { watchFile } from '../server/watch.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let root
let outside
let backupDir
let server
let base

function put(rel, content) {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editor-root-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editor-out-')))
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-bak-'))
  put('a.md', '# A\n本文\n')
  put('folder/b.md', 'no final newline')
  put('mixed.md', 'a\r\nb\n')
  put('crlf.md', 'a\r\nb\r\n')
  put('bom.md', '﻿a\n')
  put('excal.md', '---\nexcalidraw-plugin: parsed\n---\n# x\n')
  put('.obsidian/x.md', 'x')
  put('.git/x.md', 'x')
  put('node_modules/x.md', 'x')
  put('img.png', 'png')
  fs.writeFileSync(path.join(root, 'latin.md'), Buffer.from([0x61, 0xff, 0xfe, 0x0a]))
  fs.writeFileSync(path.join(outside, 'secret.md'), 'secret')
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'link.md'))
  fs.symlinkSync(outside, path.join(root, 'linkdir'))
  const app = createApp({ root, port: 0, backupDir, stateDir: backupDir, vaultDir: path.join(backupDir, 'vault'), noToken: true })
  server = await app.listen(0)
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => {
    server.closeAllConnections()
    server.close(r)
  })
})

test('パスの判定はVaultの外と隠しフォルダーを断る', () => {
  assert.equal(resolveNotePath(root, 'a.md'), path.join(root, 'a.md'))
  assert.equal(resolveNotePath(root, 'folder/b.md'), path.join(root, 'folder/b.md'))
  for (const bad of ['../x.md', '/etc/passwd.md', 'a/../../x.md', '.git/x.md', '.obsidian/x.md',
    '.claude/x.md', '.agents/x.md', 'node_modules/x.md', 'img.png', 'link.md', 'linkdir/secret.md', '']) {
    assert.throws(() => resolveNotePath(root, bad), /not allowed/, bad)
  }
})

test('一覧は隠しフォルダーとシンボリックリンクを含めない', () => {
  const notes = listNotes(root)
  assert.ok(notes.includes('a.md'))
  assert.ok(notes.includes('folder/b.md'))
  assert.ok(!notes.some((n) => n.startsWith('.') || n.startsWith('node_modules') || n === 'link.md'))
})

test('編集できないファイルを判定する', () => {
  assert.equal(readNote(root, 'a.md').editable, true)
  assert.equal(readNote(root, 'folder/b.md').text, 'no final newline')
  for (const [name, reason] of [['mixed.md', 'mixed-eol'], ['bom.md', 'bom'],
    ['latin.md', 'not-utf8'], ['excal.md', 'excalidraw']]) {
    const note = readNote(root, name)
    assert.equal(note.editable, false, name)
    assert.equal(note.reason, reason, name)
  }
  assert.equal(readNote(root, 'crlf.md').editable, true)
})

test('1MBを超えるファイルはソース表示にする', () => {
  put('big.md', 'x'.repeat(1_000_001))
  assert.equal(readNote(root, 'big.md').sourceOnly, true)
  assert.equal(readNote(root, 'a.md').sourceOnly, false)
})

test('保存は最後に読んだ内容と比べ、違えば書かない', () => {
  const backups = createBackups(backupDir, { vaultId: '0123456789abcdef' })
  put('w.md', 'one\n')
  fs.chmodSync(path.join(root, 'w.md'), 0o640)
  const first = readNote(root, 'w.md')
  const saved = writeNote(root, 'w.md', 'two\n', first.hash, backups)
  assert.equal(saved.conflict, false)
  assert.equal(fs.readFileSync(path.join(root, 'w.md'), 'utf8'), 'two\n')
  assert.equal(fs.statSync(path.join(root, 'w.md')).mode & 0o777, 0o640)
  assert.equal(saved.hash, hashText('two\n'))
  const stale = writeNote(root, 'w.md', 'three\n', first.hash, backups)
  assert.equal(stale.conflict, true)
  assert.equal(stale.current, 'two\n')
  assert.equal(fs.readFileSync(path.join(root, 'w.md'), 'utf8'), 'two\n')
  assert.ok(backups.list('w.md').some((b) => b.kind === 'previous' && backups.read('w.md', b.id) === 'one\n'))
})

test('編集できないファイルには書かない', () => {
  const backups = createBackups(backupDir, { vaultId: '0123456789abcdef' })
  const note = readNote(root, 'mixed.md')
  assert.throws(() => writeNote(root, 'mixed.md', 'x', note.hash, backups), /not editable/)
  assert.equal(fs.readFileSync(path.join(root, 'mixed.md'), 'utf8'), 'a\r\nb\n')
})

test('バックアップは3種類を分けて保管し、期限で消す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-bak2-'))
  let now = 1_000_000_000_000
  const backups = createBackups(dir, { vaultId: '0123456789abcdef', now: () => now })
  backups.save('n.md', 'p', 'previous')
  backups.save('n.md', 'c', 'conflict')
  assert.equal(backups.snapshot('n.md', 's1'), true)
  assert.equal(backups.snapshot('n.md', 's2'), false, '5分以内は残さない')
  now += 5 * 60 * 1000 + 1
  assert.equal(backups.snapshot('n.md', 's3'), true)
  assert.equal(backups.list('n.md').length, 4)
  now += 2 * 24 * 60 * 60 * 1000
  backups.prune()
  assert.ok(!backups.list('n.md').some((b) => b.kind === 'previous'), '直前の内容は1日で消える')
  assert.ok(backups.list('n.md').some((b) => b.kind === 'conflict'))
  now += 6 * 24 * 60 * 60 * 1000
  backups.prune()
  assert.equal(backups.list('n.md').length, 0, '7日で消える')
})

test('通信の出どころを判定する', () => {
  const req = (headers, method = 'GET', url = '/api/note') => ({ headers, method, url })
  const host = { host: '127.0.0.1:8795' }
  assert.equal(checkRequest(req(host), 8795).ok, true)
  assert.equal(checkRequest(req({ host: 'localhost:8795' }), 8795).ok, true)
  assert.equal(checkRequest(req({ host: 'evil.example:8795' }), 8795).ok, false)
  assert.equal(checkRequest(req({ ...host, origin: 'https://evil.example' }), 8795).ok, false)
  assert.equal(checkRequest(req({ ...host, origin: 'http://127.0.0.1:8795' }), 8795).ok, true)
  assert.equal(checkRequest(req({ ...host, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }), 8795).ok, false)
  assert.equal(checkRequest(req({ ...host, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, 'GET', '/'), 8795).ok, true)
  assert.equal(checkRequest(req({ ...host, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, 'GET', '/api/note'), 8795).ok, false, 'APIは画面の移動でも開かない')
  assert.equal(checkRequest(req(host, 'PUT'), 8795).ok, false, '書き込みは専用の印が必要')
  assert.equal(checkRequest(req({ ...host, 'x-note-editor': '1' }, 'PUT'), 8795).ok, true)
})

test('HTTPで読み書きできる', async () => {
  put('h.md', 'hello\n')
  const page = await fetch(`${base}/`)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/)
  assert.doesNotMatch(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const read = await (await fetch(`${base}/api/note?path=h.md`)).json()
  assert.equal(read.text, 'hello\n')
  const noHeader = await fetch(`${base}/api/note?path=h.md`, { method: 'PUT', body: '{}' })
  assert.equal(noHeader.status, 403)
  const put1 = await fetch(`${base}/api/note?path=h.md`, {
    method: 'PUT',
    headers: { 'x-note-editor': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'bye\n', baseHash: read.hash }),
  })
  assert.equal((await put1.json()).conflict, false)
  assert.equal(fs.readFileSync(path.join(root, 'h.md'), 'utf8'), 'bye\n')
  const conflict = await fetch(`${base}/api/note?path=h.md`, {
    method: 'PUT',
    headers: { 'x-note-editor': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'again\n', baseHash: read.hash }),
  })
  assert.equal(conflict.status, 409)
  assert.equal((await fetch(`${base}/api/note?path=../x.md`)).status, 400)
  assert.equal((await fetch(`${base}/api/note?path=none.md`)).status, 404)
})

test('開いただけでは書き込まない', async () => {
  put('open.md', 'keep\n')
  const before = fs.statSync(path.join(root, 'open.md')).mtimeMs
  await fetch(`${base}/api/note?path=open.md`)
  await sleep(30)
  assert.equal(fs.statSync(path.join(root, 'open.md')).mtimeMs, before)
})

test('変更の見張りは書き込みが止まるまで待つ', async () => {
  const file = path.join(root, 'watched.md')
  fs.writeFileSync(file, 'start\n')
  const seen = []
  const stop = watchFile(file, (info) => seen.push(info), { settleMs: 300, pollMs: 50 })
  await sleep(120)
  for (let i = 0; i < 6; i++) {
    fs.appendFileSync(file, `line ${i}\n`)
    await sleep(100)
    assert.equal(seen.length, 0, '書き込み中は知らせない')
  }
  await sleep(600)
  stop()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].exists, true)
})

test('見張りはファイルが消えたことも知らせる', async () => {
  const file = path.join(root, 'gone.md')
  fs.writeFileSync(file, 'x')
  const seen = []
  const stop = watchFile(file, (info) => seen.push(info), { settleMs: 100, pollMs: 30 })
  await sleep(60)
  fs.unlinkSync(file)
  await sleep(300)
  stop()
  assert.equal(seen.at(-1).exists, false)
})

test('別のVault用に開いたタブからの操作は、書く前に断る', async () => {
  put('guard.md', 'keep\n')
  const health = await (await fetch(`${base}/api/health`)).json()
  assert.match(health.rootId, /^[0-9a-f]{16}$/)
  const hash = hashText('keep\n')
  const write = (rootId) =>
    fetch(`${base}/api/note?path=guard.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-note-editor': '1', 'x-note-root': rootId },
      body: JSON.stringify({ text: 'changed\n', baseHash: hash }),
    })
  assert.equal((await write('0000000000000000')).status, 412)
  assert.equal(fs.readFileSync(path.join(root, 'guard.md'), 'utf8'), 'keep\n')
  assert.equal((await fetch(`${base}/api/events?path=guard.md&root=0000000000000000`)).status, 412)
  assert.equal((await write(health.rootId)).status, 200)
  assert.equal(fs.readFileSync(path.join(root, 'guard.md'), 'utf8'), 'changed\n')
})

test('状態のファイルにVaultの場所を入れ、チャットへ送る文字を消さない', async () => {
  const send = (body) =>
    fetch(`${base}/api/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-note-editor': '1' },
      body: JSON.stringify(body),
    })
  await send({ path: 'a.md', askChat: { text: '質問', at: 5 } })
  await send({ path: 'a.md', selection: '' })
  const state = await (await fetch(`${base}/api/state`)).json()
  assert.equal(state.root, root)
  assert.deepEqual(state.askChat, { text: '質問', at: 5 })
})

test('履歴の一覧には本文を入れず、選んだものだけ読む', async () => {
  put('hist.md', 'first\n')
  writeNote(root, 'hist.md', 'second\n', hashText('first\n'), createBackups(backupDir, { vaultId: vaultIdOf(root) }))
  const { backups: items } = await (await fetch(`${base}/api/backups?path=hist.md`)).json()
  assert.ok(items.length > 0)
  assert.equal(items[0].text, undefined)
  const one = await (await fetch(`${base}/api/backup?path=hist.md&id=${encodeURIComponent(items[0].id)}`)).json()
  assert.equal(one.text, 'first\n')
  assert.equal((await fetch(`${base}/api/backup?path=hist.md&id=${encodeURIComponent('../../etc/passwd')}`)).status, 404)
})

test('作ったノートは、一覧の控えを待たずにすぐ一覧に出る', async () => {
  const before = await (await fetch(`${base}/api/notes`)).json()
  assert.ok(!before.notes.includes('new-folder/x.md'))
  const created = await fetch(`${base}/api/note?path=${encodeURIComponent('new-folder/x.md')}`, {
    method: 'POST',
    headers: { 'x-note-editor': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ text: '' }),
  })
  assert.equal(created.status, 201)
  const after = await (await fetch(`${base}/api/notes`)).json()
  assert.ok(after.notes.includes('new-folder/x.md'))
  assert.equal(after.newNoteDir, undefined, '新しいノートの場所はサーバーでは決めない')
})

test('保存の差し替えが失敗したら500を返し、ノートは元のまま', async (t) => {
  put('rename-fail.md', 'before\n')
  const read = await (await fetch(`${base}/api/note?path=rename-fail.md`)).json()
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) })
  const res = await fetch(`${base}/api/note?path=rename-fail.md`, {
    method: 'PUT',
    headers: { 'x-note-editor': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'after\n', baseHash: read.hash }),
  })
  t.mock.restoreAll()
  assert.equal(res.status, 500)
  assert.equal(fs.readFileSync(path.join(root, 'rename-fail.md'), 'utf8'), 'before\n')
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.tmp')), [])
})

test('たどりきれないVaultでは、/api/notes に truncated が付き、移動の計画は409', async () => {
  const small = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editor-small-')))
  for (const name of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(small, `${name}.md`), 'x')
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-small-aux-'))
  const srv = await createApp({ root: small, port: 0, backupDir: aux, stateDir: aux, vaultDir: path.join(aux, 'vault'), noToken: true, scanLimits: { maxEntries: 3 } }).listen(0)
  const url = `http://127.0.0.1:${srv.address().port}`
  try {
    const list = await (await fetch(`${url}/api/notes`)).json()
    assert.equal(list.truncated, true)
    const plan = await fetch(`${url}/api/move/plan`, { method: 'POST', headers: { 'x-note-editor': '1' }, body: JSON.stringify({ from: 'a.md', to: 'z.md' }) })
    assert.equal(plan.status, 409)
    assert.deepEqual(await plan.json(), { error: 'list-truncated' })
    const whole = await (await fetch(`${base}/api/notes`)).json()
    assert.equal(whole.truncated, false)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
})

test('画面は、どの読み込みにも参照元を付けない（Mermaidの<image>なども含む）', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.match(html, /<meta name="referrer" content="no-referrer">/)
})

// ここから：Modとのやり取り用の入口（合言葉あり）。Vault別フォルダーは一時フォルダーだけを使う。
describe('Modとのやり取り', () => {
  let mroot
  let mdir
  let mserver
  let mbase
  let headers
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(mdir, name), 'utf8'))
  const call = (method, url, body, extra = headers) =>
    fetch(mbase + url, { method, headers: { 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })

  before(async () => {
    mroot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mod-root-')))
    mdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mod-vault-')))
    const app = createApp({ root: mroot, backupDir: mdir, stateDir: mdir, vaultDir: mdir })
    mserver = await app.listen(0)
    mbase = `http://127.0.0.1:${mserver.address().port}`
    const { token } = JSON.parse(fs.readFileSync(path.join(mdir, 'server.json'), 'utf8'))
    headers = { 'x-note-token': token, 'x-note-editor': '1' }
  })

  after(async () => {
    await new Promise((r) => {
      mserver.closeAllConnections()
      mserver.close(r)
    })
  })

  test('need-ticket は合言葉なしで受け付け、時刻だけを書く', async () => {
    const before = Date.now()
    const res = await call('POST', '/api/need-ticket', undefined, { 'x-note-editor': '1' })
    assert.equal(res.status, 200)
    const saved = readJson('need-ticket.json')
    assert.deepEqual(Object.keys(saved), ['at'])
    assert.ok(saved.at >= before && saved.at <= Date.now())
  })

  test('need-ticket は2秒に1回しか書かない', async () => {
    fs.writeFileSync(path.join(mdir, 'need-ticket.json'), JSON.stringify({ at: 1 }))
    // 直前に書いてから2秒たっていれば書き直す。
    assert.equal((await call('POST', '/api/need-ticket', undefined, { 'x-note-editor': '1' })).status, 200)
    const first = readJson('need-ticket.json').at
    assert.ok(first > 1)
    await sleep(50)
    assert.equal((await call('POST', '/api/need-ticket', undefined, { 'x-note-editor': '1' })).status, 200)
    assert.equal(readJson('need-ticket.json').at, first)
  })

  // 画面は「アドレスに鍵が無かった（hadKey=0）」と「鍵を断られた（hadKey=1）」を分けて知らせる。Modは hadKey: true のときだけ頼み直す。
  test('need-ticket は hadKey=1 と hadKey=0 を、時刻と一緒に書く。鍵や合言葉は書かない', async () => {
    const file = path.join(mdir, 'need-ticket.json')
    fs.rmSync(file, { force: true })
    assert.equal((await call('POST', '/api/need-ticket?hadKey=1', undefined, { 'x-note-editor': '1' })).status, 200)
    const yes = readJson('need-ticket.json')
    assert.deepEqual(Object.keys(yes).sort(), ['at', 'hadKey'])
    assert.equal(yes.hadKey, true)
    fs.rmSync(file, { force: true })
    assert.equal((await call('POST', '/api/need-ticket?hadKey=0', undefined, { 'x-note-editor': '1' })).status, 200)
    const no = readJson('need-ticket.json')
    assert.equal(no.hadKey, false)
    const { token, ticket } = JSON.parse(fs.readFileSync(path.join(mdir, 'server.json'), 'utf8'))
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(!text.includes(token))
    if (ticket) assert.ok(!text.includes(ticket))
    // 知らない値は、書かない（古い画面と同じく、時刻だけ）。
    fs.rmSync(file, { force: true })
    assert.equal((await call('POST', '/api/need-ticket?hadKey=yes', undefined, { 'x-note-editor': '1' })).status, 200)
    assert.deepEqual(Object.keys(readJson('need-ticket.json')), ['at'])
    fs.rmSync(file, { force: true })
  })

  test('need-ticket は2秒以内でも、hadKey: false のあとの hadKey: true は書き直す。逆は書き直さない', async () => {
    const file = path.join(mdir, 'need-ticket.json')
    fs.rmSync(file, { force: true })
    // 鍵の無い場所を読んだすぐあとに、鍵付きの場所で鍵を断られた場合。
    await call('POST', '/api/need-ticket?hadKey=0', undefined, { 'x-note-editor': '1' })
    const first = readJson('need-ticket.json')
    await sleep(20)
    await call('POST', '/api/need-ticket?hadKey=1', undefined, { 'x-note-editor': '1' })
    const second = readJson('need-ticket.json')
    assert.equal(second.hadKey, true)
    assert.ok(second.at > first.at)
    // 断られた知らせを、2秒以内の「鍵が無かった」で上書きしない。
    await sleep(20)
    await call('POST', '/api/need-ticket?hadKey=0', undefined, { 'x-note-editor': '1' })
    assert.deepEqual(readJson('need-ticket.json'), second)
    fs.rmSync(file, { force: true })
  })

  test('need-ticket も x-note-editor が無ければ403、よそのサイトからは断る', async () => {
    fs.rmSync(path.join(mdir, 'need-ticket.json'), { force: true })
    assert.equal((await call('POST', '/api/need-ticket', undefined, {})).status, 403)
    assert.equal((await call('POST', '/api/need-ticket', undefined, { 'x-note-editor': '1', origin: 'https://evil.example' })).status, 403)
    assert.equal(fs.existsSync(path.join(mdir, 'need-ticket.json')), false)
  })

  test('share は合言葉がなければ401、最初は on: false', async () => {
    assert.equal((await call('GET', '/api/share', undefined, { 'x-note-editor': '1' })).status, 401)
    assert.equal((await call('PUT', '/api/share', { on: true }, { 'x-note-editor': '1' })).status, 401)
    const res = await call('GET', '/api/share')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { on: false })
  })

  test('share を on にすると share-note.json に書く', async () => {
    const res = await call('PUT', '/api/share', { on: true })
    assert.equal(res.status, 200)
    assert.deepEqual(readJson('share-note.json'), { on: true })
    assert.deepEqual(await (await call('GET', '/api/share')).json(), { on: true })
    assert.equal((await call('PUT', '/api/share', { on: 'yes' })).status, 400)
    await call('PUT', '/api/share', { on: false })
    assert.deepEqual(readJson('share-note.json'), { on: false })
  })

  test('settings を読むと、今の中身と errors を返す', async () => {
    fs.rmSync(path.join(mdir, 'settings.json'), { force: true })
    assert.deepEqual(await (await call('GET', '/api/settings')).json(), { settings: {}, errors: [] })
    fs.writeFileSync(path.join(mdir, 'settings.json'), JSON.stringify({ attachmentDir: '../x' }))
    assert.deepEqual(await (await call('GET', '/api/settings')).json(), {
      settings: { attachmentDir: '../x' },
      errors: ['attachmentDirの場所が使えません：../x'],
    })
    assert.equal((await call('GET', '/api/settings', undefined, { 'x-note-editor': '1' })).status, 401)
  })

  test('settings を重ねて書き、ほかの項目は残す', async () => {
    fs.writeFileSync(path.join(mdir, 'settings.json'), JSON.stringify({ attachmentDir: 'img' }))
    const res = await call('PUT', '/api/settings', { unlisted: ['archives'] })
    assert.equal(res.status, 200)
    const want = { attachmentDir: 'img', unlisted: ['archives'] }
    assert.deepEqual(await res.json(), { settings: want, errors: [] })
    assert.deepEqual(readJson('settings.json'), want)
  })

  test('periodicRoot を変えても periodic.templates は残る', async () => {
    fs.writeFileSync(path.join(mdir, 'settings.json'), JSON.stringify({ periodic: { root: 'Days', templates: { daily: 'templates/daily.md' } } }))
    assert.equal((await call('PUT', '/api/settings', { periodicRoot: 'Logs' })).status, 200)
    assert.deepEqual(readJson('settings.json'), { periodic: { root: 'Logs', templates: { daily: 'templates/daily.md' } } })
    // 何もなかったところへ足すと、rootだけの periodic ができる。
    fs.writeFileSync(path.join(mdir, 'settings.json'), '{}')
    await call('PUT', '/api/settings', { periodicRoot: 'Logs' })
    assert.deepEqual(readJson('settings.json'), { periodic: { root: 'Logs' } })
  })

  test('null を渡すとその項目を消す', async () => {
    fs.writeFileSync(path.join(mdir, 'settings.json'), JSON.stringify({
      attachmentDir: 'img', unlisted: ['a'], periodic: { root: 'Days', templates: { daily: 'x.md' } },
    }))
    const res = await call('PUT', '/api/settings', { attachmentDir: null, unlisted: null, periodicRoot: null })
    assert.equal(res.status, 200)
    assert.deepEqual(readJson('settings.json'), {})
    assert.deepEqual(await res.json(), { settings: {}, errors: [] })
  })

  test('settings に使えない場所があれば、書かずに400で理由を返す', async () => {
    fs.writeFileSync(path.join(mdir, 'settings.json'), JSON.stringify({ attachmentDir: 'img' }))
    const res = await call('PUT', '/api/settings', { attachmentDir: '../x' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).errors.length, 1)
    assert.deepEqual(readJson('settings.json'), { attachmentDir: 'img' })
    assert.equal((await call('PUT', '/api/settings', { unlisted: 'abc' })).status, 400)
  })

  test('今の settings.json が壊れていれば、書かずに409を返す', async () => {
    for (const broken of ['{oops', '[1]']) {
      fs.writeFileSync(path.join(mdir, 'settings.json'), broken)
      const res = await call('PUT', '/api/settings', { attachmentDir: 'img' })
      assert.equal(res.status, 409)
      assert.ok((await res.json()).errors.length >= 1)
      assert.equal(fs.readFileSync(path.join(mdir, 'settings.json'), 'utf8'), broken)
    }
  })

  test('share と settings は壊れたJSONや配列を400で断る', async () => {
    const raw = (url, body) => fetch(mbase + url, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body })
    for (const url of ['/api/share', '/api/settings']) {
      assert.equal((await raw(url, '{oops')).status, 400, url)
      assert.equal((await raw(url, '[1]')).status, 400, url)
      assert.equal((await raw(url, 'null')).status, 400, url)
    }
  })

  test('need-ticket は中身を付けて送られたら413で、書かない', async () => {
    fs.rmSync(path.join(mdir, 'need-ticket.json'), { force: true })
    const res = await fetch(mbase + '/api/need-ticket', { method: 'POST', headers: { 'x-note-editor': '1', 'content-type': 'application/json' }, body: '{"a":1}' })
    assert.equal(res.status, 413)
    assert.equal(fs.existsSync(path.join(mdir, 'need-ticket.json')), false)
  })

  test('need-ticket は未来の時刻が残っていても書き直す', async () => {
    fs.writeFileSync(path.join(mdir, 'need-ticket.json'), JSON.stringify({ at: Date.now() + 3_600_000 }))
    assert.equal((await call('POST', '/api/need-ticket', undefined, { 'x-note-editor': '1' })).status, 200)
    assert.ok(readJson('need-ticket.json').at <= Date.now())
  })

  test('need-ticket は open-pending.json の期限の前なら pending: true を返す', async () => {
    fs.writeFileSync(path.join(mdir, 'open-pending.json'), JSON.stringify({ until: Date.now() + 60_000 }))
    const res = await call('POST', '/api/need-ticket', undefined, { 'x-note-editor': '1' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { pending: true })
  })

  test('need-ticket は open-pending.json が無い、期限が過ぎた、読めないときは pending: false を返す', async () => {
    const file = path.join(mdir, 'open-pending.json')
    const ask = async () => (await call('POST', '/api/need-ticket', undefined, { 'x-note-editor': '1' })).json()
    fs.rmSync(file, { force: true })
    assert.deepEqual(await ask(), { pending: false })
    fs.writeFileSync(file, JSON.stringify({ until: Date.now() - 1 }))
    assert.deepEqual(await ask(), { pending: false })
    for (const broken of ['{oops', '[1]', JSON.stringify({ until: 'soon' }), 'null']) {
      fs.writeFileSync(file, broken)
      assert.deepEqual(await ask(), { pending: false }, broken)
    }
    fs.rmSync(file, { force: true })
  })

  test('need-ticket の返事に、合言葉も鍵も入らない', async () => {
    const { token } = JSON.parse(fs.readFileSync(path.join(mdir, 'server.json'), 'utf8'))
    fs.writeFileSync(path.join(mdir, 'open-pending.json'), JSON.stringify({ until: Date.now() + 60_000 }))
    const res = await call('POST', '/api/need-ticket', undefined, { 'x-note-editor': '1' })
    const text = await res.text()
    assert.deepEqual(Object.keys(JSON.parse(text)), ['pending'])
    assert.ok(!text.includes(token))
    assert.ok(![...res.headers.values()].some((v) => v.includes(token)))
    fs.rmSync(path.join(mdir, 'open-pending.json'), { force: true })
  })
})
