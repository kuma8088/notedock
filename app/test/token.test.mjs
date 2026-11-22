import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { chatHashOf, createApp } from '../server/app.mjs'
import { VAULT_HEADER, vaultIdOf } from '../server/config.mjs'
import { bindChatCode, chatLinkFromHash, fileUrl, recalledChatLink, rememberChatLink, setFileKey, stashBindCode, stashedBindCode, ticketFromHash, tokenFromHash } from '../src/access.mjs'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const running = []
let root
let stateDir
let base
let port
let access

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

// 合言葉のファイルはVault別フォルダーに置く。ここでは渡したstateDirをそのままVault別フォルダーにも使う。
async function startServer({ port = 0, ...options }) {
  const server = await createApp({ backupDir: tempDir('token-bak-'), vaultDir: options.stateDir, ...options }).listen(port)
  running.push(server)
  return server
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  })
}

const accessFile = (dir) => path.join(dir, 'server.json')

before(async () => {
  root = tempDir('token-root-')
  stateDir = tempDir('token-state-')
  fs.writeFileSync(path.join(root, 'a.md'), '# A\n')
  fs.writeFileSync(path.join(root, 'img.png'), 'png')
  const publicDir = tempDir('token-public-')
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html>')
  const server = await startServer({ root, stateDir, publicDir })
  port = server.address().port
  base = `http://127.0.0.1:${port}`
  access = JSON.parse(fs.readFileSync(accessFile(stateDir), 'utf8'))
})

after(async () => {
  await Promise.all(running.map(closeServer))
})

test('合言葉のファイルは本人だけが読め、ポート番号とVaultの場所が入っている', () => {
  assert.match(access.token, TOKEN_RE)
  assert.equal(access.port, port)
  assert.equal(access.root, root)
  assert.equal(access.pid, process.pid, 'Modが本物のサーバーか確かめるのに使う')
  assert.equal(fs.statSync(accessFile(stateDir)).mode & 0o777, 0o600)
  assert.equal(access.nonce, null, 'ロックのnonceを渡していなければnull')
})

test('合言葉のファイルにはロックと同じnonceを書く', async () => {
  const dir = tempDir('token-nonce-')
  await startServer({ root, stateDir: dir, lockNonce: 'n'.repeat(32) })
  assert.equal(readAccessFile(dir).nonce, 'n'.repeat(32))
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name !== 'server.json' && name !== 'current-note.json'), [], '一時ファイルを残さない')
})

test('ポートが変わったら、同じVaultでも合言葉を作り直す', async () => {
  const dir = tempDir('token-moved-')
  const first = await startServer({ root, stateDir: dir })
  const fixed = first.address().port
  const saved = readAccessFile(dir)
  await closeServer(first)
  fs.writeFileSync(accessFile(dir), JSON.stringify({ ...saved, port: fixed + 1 }), { mode: 0o600 })
  await startServer({ root, stateDir: dir, port: fixed })
  assert.notEqual(readAccessFile(dir).token, saved.token)
})

test('どの応答にもVaultの印を付ける（401・403・404・画面のファイル）', async () => {
  const id = vaultIdOf(root)
  const cases = [
    [fetch(`${base}/api/health`), 401],
    [fetch(`${base}/api/note?path=a.md`, { headers: { 'x-note-token': access.token, origin: 'https://evil.example' } }), 403],
    [fetch(`${base}/api/nothing`, { headers: { 'x-note-token': access.token } }), 404],
    [fetch(`${base}/missing.js`), 404],
    [fetch(`${base}/`), 200],
    [fetch(`${base}/api/health`, { headers: { 'x-note-token': access.token } }), 200],
  ]
  for (const [request, status] of cases) {
    const response = await request
    assert.equal(response.status, status)
    assert.equal(response.headers.get(VAULT_HEADER), id, String(status))
  }
})

test('healthはportMovedとsettingsErrorsを返す', async () => {
  const health = await (await fetch(`${base}/api/health`, { headers: { 'x-note-token': access.token } })).json()
  assert.equal(health.portMoved, false)
  assert.deepEqual(health.settingsErrors, [])
  const dir = tempDir('token-moved-health-')
  const server = await startServer({ root, stateDir: dir, preferredPort: 1, noToken: true })
  const moved = await (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json()
  assert.equal(moved.portMoved, true, '決まった番号と違う')
  const same = await startServer({ root, stateDir: tempDir('token-same-health-'), noToken: true })
  const p = same.address().port
  await closeServer(same)
  await startServer({ root, stateDir: tempDir('token-same-health2-'), preferredPort: p, port: p, noToken: true })
  assert.equal((await (await fetch(`http://127.0.0.1:${p}/api/health`)).json()).portMoved, false)
})

test('鍵を作り直すタイマーで書けなくても、サーバーは落ちない', async () => {
  const dir = tempDir('token-timer-error-')
  const server = await startServer({ root, stateDir: dir, ticketMs: 40 })
  const url = `http://127.0.0.1:${server.address().port}`
  fs.rmSync(dir, { recursive: true, force: true })
  fs.writeFileSync(dir, 'not a folder')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal((await fetch(`${url}/`)).status, 200)
  fs.rmSync(dir, { force: true })
})

test('合言葉がないとノートの読み書きもVaultの情報も断る', async () => {
  for (const url of ['/api/health', '/api/note?path=a.md', '/api/notes', '/api/state', '/api/backups?path=a.md', '/api/file?path=img.png', '/api/events?path=a.md', '/api/appearance']) {
    const response = await fetch(`${base}${url}`)
    assert.equal(response.status, 401, url)
    assert.deepEqual(await response.json(), { error: 'token' }, '場所もノートも返さない')
  }
  const write = await fetch(`${base}/api/note?path=a.md`, { method: 'PUT', headers: { 'x-note-editor': '1' }, body: '{}' })
  assert.equal(write.status, 401)
  const state = await fetch(`${base}/api/state`, { method: 'PUT', headers: { 'x-note-editor': '1' }, body: '{"askChat":{"text":"x","at":1}}' })
  assert.equal(state.status, 401, 'チャットの入力欄へ文字を差し込めない')
})

test('画面のファイルは合言葉がなくても返す', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200)
})

test('正しい合言葉をヘッダーに入れると通り、違う合言葉は断る', async () => {
  const read = (token) => fetch(`${base}/api/note?path=a.md`, { headers: { 'x-note-token': token } })
  assert.equal((await read(access.token)).status, 200)
  assert.equal((await read('x'.repeat(43))).status, 401)
  assert.equal((await read('short')).status, 401)
})

test('URLに付けた合言葉は変更の通知だけに使える', async () => {
  const t = encodeURIComponent(access.token)
  const controller = new AbortController()
  const events = await fetch(`${base}/api/events?path=a.md&t=${t}`, { signal: controller.signal })
  assert.equal(events.status, 200)
  controller.abort()
  assert.equal((await fetch(`${base}/api/note?path=a.md&t=${t}`)).status, 401)
  assert.equal((await fetch(`${base}/api/health?t=${t}`)).status, 401)
  assert.equal((await fetch(`${base}/api/file?path=img.png&t=${t}`)).status, 401)
})

test('画像用の鍵は画像を読むことにしか使えない', async () => {
  const { fileKey } = await (await fetch(`${base}/api/health`, { headers: { 'x-note-token': access.token } })).json()
  assert.ok(fileKey, 'healthが返す')
  assert.notEqual(fileKey, access.token)
  assert.equal((await fetch(`${base}/api/file?path=img.png&k=${fileKey}`)).status, 200)
  assert.equal((await fetch(`${base}/api/note?path=a.md&k=${fileKey}`)).status, 401)
  assert.equal((await fetch(`${base}/api/events?path=a.md&t=${fileKey}`)).status, 401)
  assert.equal((await fetch(`${base}/api/note?path=a.md`, { headers: { 'x-note-token': fileKey } })).status, 401)
  assert.equal((await fetch(`${base}/api/file?path=img.png&k=wrong`)).status, 401)
})

test('出どころの確認は合言葉があっても働く', async () => {
  const response = await fetch(`${base}/api/note?path=a.md`, { headers: { 'x-note-token': access.token, origin: 'https://evil.example' } })
  assert.equal(response.status, 403)
})

test('同じポートとVaultで起動し直しても、開いているタブが止まらないよう同じ合言葉を使う', async () => {
  const dir = tempDir('token-restart-')
  const first = await startServer({ root, stateDir: dir })
  const fixed = first.address().port
  const { token } = JSON.parse(fs.readFileSync(accessFile(dir), 'utf8'))
  await closeServer(first)
  await startServer({ root, stateDir: dir, port: fixed })
  assert.equal(JSON.parse(fs.readFileSync(accessFile(dir), 'utf8')).token, token)
})

test('起動し直すと、合言葉は同じままプロセス番号を書き直す', async () => {
  const dir = tempDir('token-pid-')
  const first = await startServer({ root, stateDir: dir })
  const fixed = first.address().port
  const file = accessFile(dir)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  await closeServer(first)
  fs.writeFileSync(file, JSON.stringify({ ...saved, pid: 1 }), { mode: 0o600 })
  await startServer({ root, stateDir: dir, port: fixed })
  const now = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(now.token, saved.token)
  assert.equal(now.pid, process.pid)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('別のVaultでは別の合言葉にする', async () => {
  const dir = tempDir('token-other-')
  const first = await startServer({ root, stateDir: dir })
  const fixed = first.address().port
  const { token } = JSON.parse(fs.readFileSync(accessFile(dir), 'utf8'))
  await closeServer(first)
  await startServer({ root: tempDir('token-root2-'), stateDir: dir, port: fixed })
  assert.notEqual(JSON.parse(fs.readFileSync(accessFile(dir), 'utf8')).token, token)
})

test('ほかの人が読めるファイルの合言葉は使わず、作り直す', async () => {
  const dir = tempDir('token-loose-')
  const first = await startServer({ root, stateDir: dir })
  const fixed = first.address().port
  const file = accessFile(dir)
  const { token } = JSON.parse(fs.readFileSync(file, 'utf8'))
  await closeServer(first)
  fs.chmodSync(file, 0o644)
  await startServer({ root, stateDir: dir, port: fixed })
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, token)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('シンボリックリンクの先には書かず、中身も信用しない', async () => {
  const dir = tempDir('token-link-')
  const first = await startServer({ root, stateDir: dir })
  const fixed = first.address().port
  const file = accessFile(dir)
  const planted = path.join(dir, 'planted.json')
  await closeServer(first)
  const known = 'k'.repeat(43)
  fs.writeFileSync(planted, JSON.stringify({ port: fixed, root, token: known }), { mode: 0o600 })
  fs.rmSync(file)
  fs.symlinkSync(planted, file)
  await startServer({ root, stateDir: dir, port: fixed })
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false)
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, known)
  assert.equal(JSON.parse(fs.readFileSync(planted, 'utf8')).token, known)
})

test('--no-tokenのときは今までどおり使え、起動情報のファイルは合言葉なしで書く', async () => {
  const dir = tempDir('token-off-')
  const server = await startServer({ root, stateDir: dir, noToken: true, lockNonce: 'm'.repeat(32) })
  const port = server.address().port
  const url = `http://127.0.0.1:${port}`
  assert.equal((await fetch(`${url}/api/note?path=a.md`)).status, 200)
  const health = await (await fetch(`${url}/api/health`)).json()
  assert.equal(health.fileKey, undefined)
  assert.deepEqual(readAccessFile(dir), { port, root, token: null, ticket: null, pid: process.pid, nonce: 'm'.repeat(32) })
  assert.equal(fs.statSync(accessFile(dir)).mode & 0o777, 0o600)
})

test('--no-tokenで起動すると、前の合言葉と鍵を残さない', async () => {
  const dir = tempDir('token-stale-')
  const first = await startServer({ root, stateDir: dir })
  const fixed = first.address().port
  await closeServer(first)
  assert.match(readAccessFile(dir).token, TOKEN_RE)
  await startServer({ root, stateDir: dir, port: fixed, noToken: true })
  const after = readAccessFile(dir)
  assert.equal(after.token, null)
  assert.equal(after.ticket, null)
  assert.equal(after.port, fixed)
})

test('URLの#から合言葉を取り出す。見出しへのリンクとは間違えない', () => {
  const token = 'a'.repeat(43)
  assert.equal(tokenFromHash(`#t=${token}`), token)
  for (const hash of ['', '#', '#見出し', '#t=', '#t=short', `#t=${token}&x=1`, `#x=${token}`]) {
    assert.equal(tokenFromHash(hash), null, hash)
  }
})

test('画像のURLには画像用の鍵だけを付ける', () => {
  setFileKey('')
  assert.equal(fileUrl('a b.png'), '/api/file?path=a%20b.png')
  setFileKey('key')
  assert.equal(fileUrl('a b.png'), '/api/file?path=a%20b.png&k=key')
  setFileKey('')
})

const claim = (url, ticket, headers = { 'x-note-editor': '1' }) =>
  fetch(`${url}/api/claim`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ticket }) })

function readAccessFile(dir) {
  return JSON.parse(fs.readFileSync(accessFile(dir), 'utf8'))
}

test('リンク用の鍵は合言葉と別の値で、ファイルに入っている', () => {
  assert.match(access.ticket, TOKEN_RE)
  assert.notEqual(access.ticket, access.token)
})

test('リンク用の鍵は合言葉に引き換えられ、一度使うと無効になる', async () => {
  const { ticket, token } = readAccessFile(stateDir)
  const first = await claim(base, ticket)
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { token })
  assert.equal((await claim(base, ticket)).status, 401)
  const next = readAccessFile(stateDir)
  assert.notEqual(next.ticket, ticket)
  assert.equal(next.token, token)
  assert.equal(fs.statSync(accessFile(stateDir)).mode & 0o777, 0o600)
})

test('違う鍵や、ほかのサイトからの引き換えは断る', async () => {
  const { ticket } = readAccessFile(stateDir)
  assert.equal((await claim(base, 'x'.repeat(43))).status, 401)
  assert.equal((await claim(base, undefined)).status, 401)
  assert.equal((await claim(base, ticket, {})).status, 403, '専用の印がない')
  assert.equal((await claim(base, ticket, { 'x-note-editor': '1', origin: 'https://evil.example' })).status, 403)
  assert.equal(readAccessFile(stateDir).ticket, ticket, '断ったときは鍵を変えない')
})

test('リンク用の鍵は合言葉の代わりにならない', async () => {
  const { ticket } = readAccessFile(stateDir)
  assert.equal((await fetch(`${base}/api/note?path=a.md`, { headers: { 'x-note-token': ticket } })).status, 401)
  assert.equal((await fetch(`${base}/api/events?path=a.md&t=${ticket}`)).status, 401)
})

test('使われなかった鍵は時間で無効になる', async () => {
  const dir = tempDir('token-expire-')
  const server = await startServer({ root, stateDir: dir, ticketMs: 40 })
  const fixed = server.address().port
  const { ticket } = readAccessFile(dir)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.notEqual(readAccessFile(dir).ticket, ticket)
  assert.equal((await claim(`http://127.0.0.1:${fixed}`, ticket)).status, 401)
})

test('起動し直すと鍵は変わり、合言葉は変わらない', async () => {
  const dir = tempDir('token-ticket-restart-')
  const first = await startServer({ root, stateDir: dir })
  const fixed = first.address().port
  const before = readAccessFile(dir)
  await closeServer(first)
  await startServer({ root, stateDir: dir, port: fixed })
  const after = readAccessFile(dir)
  assert.equal(after.token, before.token)
  assert.notEqual(after.ticket, before.ticket)
})

test('URLの#からリンク用の鍵を取り出す', () => {
  const ticket = 'b'.repeat(43)
  assert.equal(ticketFromHash(`#c=${ticket}`), ticket)
  for (const hash of ['', '#見出し', '#c=', '#c=short', `#t=${ticket}`]) assert.equal(ticketFromHash(hash), null, hash)
})

function listenOn(port, host) {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer()
    blocker.once('error', reject)
    blocker.listen(port, host, () => resolve(blocker))
  })
}

test('::1の同じ番号も自分で取り、別のプログラムに取らせない', async () => {
  const dir = tempDir('token-v6-')
  const server = await startServer({ root, stateDir: dir })
  const fixed = server.address().port
  await assert.rejects(listenOn(fixed, '::1'), { code: 'EADDRINUSE' })
  await closeServer(server)
  const again = await listenOn(fixed, '::1')
  await new Promise((resolve) => again.close(resolve))
})

test('::1で受けても、接続元の確認は同じように働く', async () => {
  const dir = tempDir('token-v6-host-')
  const server = await startServer({ root, stateDir: dir })
  const response = await fetch(`http://[::1]:${server.address().port}/api/health`)
  assert.equal(response.status, 403)
})

test('::1を別のプログラムが使っていたら起動しない', async () => {
  const dir = tempDir('token-v6-taken-')
  const probe = await listenOn(0, '127.0.0.1')
  const fixed = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const blocker = await listenOn(fixed, '::1')
  await assert.rejects(createApp({ root, backupDir: dir, stateDir: dir, vaultDir: dir }).listen(fixed), { code: 'EADDRINUSE' })
  await new Promise((resolve) => blocker.close(resolve))
  assert.equal(fs.existsSync(accessFile(dir)), false)
})

test('鍵の期限は、鍵を作り直すたびに数え直す', async () => {
  const dir = tempDir('token-ticket-timer-')
  const server = await startServer({ root, stateDir: dir, ticketMs: 150 })
  const fixed = server.address().port
  const url = `http://127.0.0.1:${fixed}`
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await claim(url, readAccessFile(dir).ticket)).status, 200)
  const fresh = readAccessFile(dir).ticket
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(readAccessFile(dir).ticket, fresh, '作り直してから150msは同じ')
})

test('アドレスの # から、鍵（c=）とチャットの番号（s=）を & つなぎで読む。ほかの形は読まない', () => {
  const k = 'K'.repeat(43)
  const s = 'S'.repeat(42) + '_'
  assert.equal(ticketFromHash(`#c=${k}`), k)
  assert.equal(ticketFromHash(`#c=${k}&s=${s}`), k)
  assert.equal(chatLinkFromHash(`#c=${k}&s=${s}`), s)
  assert.equal(chatLinkFromHash(`#s=${s}`), s)
  assert.equal(chatLinkFromHash(`#c=${k}`), null)
  assert.equal(tokenFromHash(`#t=${k}`), k)
  // 見出しへの移動・形の違う値・同じ名前が2つ・知らない名前があれば、どれも読まない。
  for (const hash of ['', '#', '#見出し', `#c=${k}&s=short`, `#c=${k}&c=${k}`, `#c=${k}&x=${s}`, `#c=${k}&`, `#s=${s}/../x`]) {
    assert.equal(ticketFromHash(hash), null, hash)
    assert.equal(chatLinkFromHash(hash), null, hash)
  }
})

test('チャットの番号はタブの中にだけ覚え、形の違う値は覚えない', () => {
  const store = new Map()
  const fake = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null }
  assert.equal(recalledChatLink(fake), '')
  rememberChatLink(fake, 'bad')
  assert.equal(recalledChatLink(fake), '')
  const s = 'S'.repeat(43)
  rememberChatLink(fake, s)
  assert.equal(recalledChatLink(fake), s)
  assert.equal(recalledChatLink(undefined), '')
  assert.equal(recalledChatLink({ getItem: () => { throw new Error('使えない') } }), '')
})

// 実機（2026-11-22、VM）：Claudeはまず鍵の無い場所を開く（合言葉が無く401、開けない画面になる）。続く #c=…&s=… への移動で
// 合言葉は取れるが、前の作りは開けない画面のあいだ問い合わせを送らず、合図を捨てていた。
test('起動で合言葉が無く断られたあとでも、退避した合図で結び付く。読み込み直しても合図は残る。使えない合図は捨てる', async () => {
  const store = new Map()
  const tab = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null, removeItem: (k) => store.delete(k) }
  const folder = 'e'.repeat(64)
  const dir = path.join(stateDir, 'chats', folder)
  fs.mkdirSync(dir, { recursive: true })
  const code = 'G'.repeat(43)
  const used = 'U'.repeat(43)
  fs.writeFileSync(path.join(dir, 'link.json'), JSON.stringify({ at: Date.now(), binds: [{ h: chatHashOf(code), until: Date.now() + 60_000 }] }))
  const fetchImpl = (url, init) => fetch(base + url, init)
  // アドレスの合図を、消す前にタブの中へ退避する。
  stashBindCode(tab, code)
  // 合言葉がまだ無い：401。合図は残す。
  assert.equal(await bindChatCode({ store: tab, fetchImpl }), null)
  assert.equal(stashedBindCode(tab), code)
  // つながらないときも残す。
  assert.equal(await bindChatCode({ store: tab, fetchImpl: async () => { throw new Error('切れた') }, token: access.token }), null)
  assert.equal(stashedBindCode(tab), code)
  // 読み込み直したあと（同じタブの中の退避から）、合言葉が取れていれば結び付く。
  const cred = await bindChatCode({ store: tab, fetchImpl, token: access.token })
  assert.match(cred, TOKEN_RE)
  assert.equal(recalledChatLink(tab), cred)
  assert.equal(stashedBindCode(tab), '')
  // 使えない合図（使用済み・知らない合図）は捨てる。
  stashBindCode(tab, code)
  assert.equal(await bindChatCode({ store: tab, fetchImpl, token: access.token }), null)
  assert.equal(stashedBindCode(tab), '')
  stashBindCode(tab, used)
  assert.equal(await bindChatCode({ store: tab, fetchImpl, token: access.token }), null)
  assert.equal(stashedBindCode(tab), '')
  assert.equal(recalledChatLink(tab), cred)
  // 形の違う値は退避しない。
  stashBindCode(tab, '../x')
  assert.equal(stashedBindCode(tab), '')
})
