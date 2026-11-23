import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAccess, fileKeyOf, sameToken, writeOpenAccess } from './access.mjs'
import { readAppearance } from './appearance.mjs'
import { VAULT_HEADER, VERSION_HEADER, vaultIdOf } from './config.mjs'
import { createBackups } from './backups.mjs'
import { createFolder, moveItem, planMove, trashItem } from './fileops.mjs'
import { createNote, readNote, writeNote } from './notes.mjs'
import { isHiddenFile } from './platform.mjs'
import { createTaskIndex } from './tasks.mjs'
import { openPeriodic, periodicMonth } from './periodic.mjs'
import { replaceFile } from './durable.mjs'
import { checkVaultSettings, readVaultSettings } from './vault-settings.mjs'
import { resolveAssetPath, scanVault } from './paths.mjs'
import { CSP, checkRequest } from './security.mjs'
import { SERVER_VERSION, VERSION_RE, compareVersions } from './version.mjs'
import { watchFile } from './watch.mjs'

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const MAX_JSON = 20 * 1024 * 1024
const MAX_ATTACHMENT = 25 * 1024 * 1024
// 画像の置き場を決めていないVaultで、貼った画像を入れるフォルダー（Vault直下。なければ作る）。
const DEFAULT_ATTACHMENT_DIR = 'attachments'
const CHAT_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const CHAT_IMAGE_MAX = 10 * 1024 * 1024
const CHAT_IMAGE_KEEP_MS = 7 * 24 * 60 * 60 * 1000
const SETTLE_RETRY_MS = 500
const TICKET_MS = 10 * 60 * 1000
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
}

const NEED_TICKET_GAP_MS = 2000
// チャット欄の結び付け。
// - Modは、エディターを開いたチャットごとに結び付けのフォルダー（chats/<推測できない名前>）を作り、link.json を書く。
//   link.json には、開くリンクに付けた「結び付けの合図」（一度だけ使える乱数）のハッシュと期限が入る。
// - 画面は、アドレスの #s=<合図> を POST /api/chat-bind で、このタブだけの鍵と引き換える。合図は一度使うと使えない。
// - そのあと画面は、鍵を x-note-chat で送る。サーバーは鍵そのものを保存せず、ハッシュの名前の目録（chat-tabs/<ハッシュ>.json）
//   からフォルダーを決める。link.json はModだけが書き、サーバーは書かない。
export const CHAT_HEADER = 'x-note-chat'
const CHAT_LINK_RE = /^[A-Za-z0-9_-]{43}$/
const CHAT_FOLDER_RE = /^[0-9a-f]{64}$/
const CHAT_USED_KEEP = 50 // 使い済みの合図のハッシュを、フォルダーごとにいくつ覚えるか
// Modは10秒ごとに link.json の時刻を書き直す。これより古ければ、結び付いたチャットはもう無いとみなす。
export const CHAT_LIVE_MS = 40 * 1000
// 使われなくなった結び付けのフォルダーを片付けるまでの日数（AIの判断）。
const CHAT_KEEP_MS = 7 * 24 * 60 * 60 * 1000

export function chatHashOf(link) {
  return crypto.createHash('sha256').update(link).digest('hex')
}
// 止める指示に 204 を送ったあと、finish も close も来ないときに、止める処理へ進むまでの時間（AIの判断）。
export const SHUTDOWN_FALLBACK_MS = 1_000

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function statusOf(error) {
  if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) return error.status
  if (error.message === 'path not allowed') return 400
  if (error.code === 'ENOENT') return 404
  if (error.code === 'EEXIST') return 409
  if (error.message === 'not editable') return 403
  return 500
}

// preferredPort は、--port なしで起動したときにVaultから決まる番号。違う番号で動いたら health の portMoved で知らせる。
// lockNonce はロックと同じ値。起動情報のファイルに書き、どのロックの持ち主が書いたかを分かるようにする。終わってもファイルは消さない。
export function createApp({ root, backupDir, stateDir, vaultDir, publicDir = PUBLIC_DIR, sameAs, noToken = false, ticketMs = TICKET_MS, scanLimits = {}, preferredPort, lockNonce = null, onShutdown = null }) {
  if (!stateDir) throw new Error('stateDir is required')
  if (!vaultDir) throw new Error('vaultDir is required')
  // VaultごとのファイルはvaultDir、全Vault共通の設定（見た目）はstateDirに置く。
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
  // タブがどのVaultのものか見分ける印。サーバーを起動し直しても同じフォルダーなら変わらない。
  const rootId = vaultIdOf(root)
  const backups = createBackups(backupDir, { vaultId: rootId })
  let actualPort = 0
  let access = null
  let token = null
  let fileKey = null
  // scanLimits はテスト用に件数と深さを小さくするため。一覧に出さないフォルダー（unlisted）は、問い合わせのたびに settings.json から読む。
  const baseScanOptions = { isHidden: (p) => isHiddenFile(p), ...scanLimits }
  const settings = () => readVaultSettings(vaultDir, root)
  const scanOptionsOf = (loaded) => ({ ...baseScanOptions, unlisted: loaded.unlisted })
  // タスクのノートの一覧。求められたときに、変わったファイルだけ読み直す。
  const taskIndex = createTaskIndex(root, { isHidden: (p) => isHiddenFile(p) })
  let notesCache = null
  let notesCachedAt = 0
  let notesCacheKey = ''
  // 止める指示のあと、書き終えるのを待つ対象。処理中の要求（長く続く /api/events は除く）と、開いている接続。
  const inflight = new Set()
  const streams = new Set()
  let shuttingDown = false

  function allowed(req, url) {
    if (noToken) return true
    if (!token) return false
    if (sameToken(req.headers['x-note-token'], token)) return true
    // ヘッダーを付けられない接続だけ、それぞれに必要な分をURLで受け取る。
    const route = `${req.method} ${url.pathname}`
    if (route === 'GET /api/events') return sameToken(url.searchParams.get('t'), token)
    if (route === 'GET /api/file' || route === 'GET /api/chat-image') return sameToken(url.searchParams.get('k'), fileKey)
    return false
  }

  // この要求の画面が結び付いているチャットのフォルダー。鍵が無い・形が違う・引き換えたものでない・Modの印が無いときは registered: false。
  function chatOf(req) {
    const cred = req.headers[CHAT_HEADER]
    if (typeof cred !== 'string' || !CHAT_LINK_RE.test(cred)) return { dir: null, registered: false, partner: 'none' }
    const folder = readChatJson(path.join(vaultDir, 'chat-tabs'), `${chatHashOf(cred)}.json`)?.chat
    if (typeof folder !== 'string' || !CHAT_FOLDER_RE.test(folder)) return { dir: null, registered: false, partner: 'none' }
    const dir = path.join(vaultDir, 'chats', folder)
    let info = null
    try { info = JSON.parse(fs.readFileSync(path.join(dir, 'link.json'), 'utf8')) } catch {}
    if (!info || typeof info !== 'object') return { dir: null, registered: false, partner: 'none' }
    const at = Number(info.at) || 0
    const live = !info.closed && Date.now() - at <= CHAT_LIVE_MS
    return { dir, registered: true, partner: live ? 'live' : 'gone', title: typeof info.title === 'string' ? info.title.slice(0, 200) : '' }
  }

  const readChatJson = (dir, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) } catch { return null }
  }

  // 結び付けの合図を、このタブだけの鍵と引き換える。合図は、Modが link.json に書いた期限内のもので、まだ使っていないものだけ。
  async function chatBind(req, res) {
    let bind
    try { bind = JSON.parse(await readBody(req, 1024))?.bind } catch (error) {
      if (error.status) throw error
    }
    if (typeof bind !== 'string' || !CHAT_LINK_RE.test(bind)) return send(res, 400, { error: 'bind' })
    const want = chatHashOf(bind)
    const top = path.join(vaultDir, 'chats')
    let names = []
    try { names = fs.readdirSync(top) } catch {}
    for (const name of names) {
      if (!CHAT_FOLDER_RE.test(name)) continue
      const dir = path.join(top, name)
      const info = readChatJson(dir, 'link.json')
      if (!info || info.closed || !Array.isArray(info.binds)) continue
      if (!info.binds.some((b) => b && b.h === want && Number(b.until) > Date.now())) continue
      const used = readChatJson(dir, 'used.json')
      const list = Array.isArray(used?.binds) ? used.binds : []
      if (list.includes(want)) break
      // 読む→書くを途中で待たずに行う（同じ合図が同時に2回来ても、引き換えるのは1回だけ）。
      replaceFile(path.join(dir, 'used.json'), JSON.stringify({ binds: [...list, want].slice(-CHAT_USED_KEEP) }), { mode: 0o600 })
      const cred = crypto.randomBytes(32).toString('base64url')
      const tabs = path.join(vaultDir, 'chat-tabs')
      fs.mkdirSync(tabs, { recursive: true, mode: 0o700 })
      replaceFile(path.join(tabs, `${chatHashOf(cred)}.json`), JSON.stringify({ chat: name }), { mode: 0o600 })
      return send(res, 200, { cred })
    }
    return send(res, 404, { error: 'bind' })
  }

  // 使われなくなった結び付けのフォルダー（link.json が7日より古い）と、そこを指すタブの鍵の目録を片付ける。
  // 前の版の、Vaultに1つだけだったチャット欄のファイルも消す（もう使わない。前の版のModが読んでも、送らない側に倒れる）。
  function pruneChats() {
    for (const old of ['chat-owner.json', 'current-note.json', 'chat-reply.json', 'chat-log.json', 'share-note.json']) {
      try { fs.rmSync(path.join(vaultDir, old), { force: true }) } catch {}
    }
    const top = path.join(vaultDir, 'chats')
    let names = []
    try { names = fs.readdirSync(top) } catch {}
    const alive = new Set()
    for (const name of names) {
      if (!CHAT_FOLDER_RE.test(name)) continue
      const dir = path.join(top, name)
      try {
        if (Date.now() - fs.statSync(path.join(dir, 'link.json')).mtimeMs > CHAT_KEEP_MS) fs.rmSync(dir, { recursive: true, force: true })
        else alive.add(name)
      } catch {
        // link.json の無いフォルダーは、Modが書く途中かもしれないので残す。
        alive.add(name)
      }
    }
    const tabs = path.join(vaultDir, 'chat-tabs')
    let tabNames = []
    try { tabNames = fs.readdirSync(tabs) } catch {}
    for (const name of tabNames) {
      const chat = readChatJson(tabs, name)?.chat
      if (typeof chat === 'string' && alive.has(chat)) continue
      try { fs.rmSync(path.join(tabs, name), { force: true }) } catch {}
    }
  }

  function notes() {
    const loaded = settings()
    const key = [...loaded.unlisted].sort().join('\n')
    if (!notesCache || key !== notesCacheKey || Date.now() - notesCachedAt > 10_000) {
      notesCache = scanVault(root, scanOptionsOf(loaded))
      notesCachedAt = Date.now()
      notesCacheKey = key
    }
    return notesCache
  }

  function events(req, res, rel) {
    readNote(root, rel)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    const file = path.join(root, rel)
    const stop = watchFile(file, ({ exists }) => {
      if (!exists) {
        res.write(`event: removed\ndata: {}\n\n`)
        return
      }
      const publish = (retried) => {
        let note
        try {
          note = readNote(root, rel)
        } catch {
          res.write(`event: removed\ndata: {}\n\n`)
          return
        }
        // 文字の途中で切れた内容を読まないよう、読めなければ少し待ってもう一度だけ読む。
        if (note.reason === 'not-utf8' && !retried) {
          setTimeout(() => publish(true), SETTLE_RETRY_MS)
          return
        }
        res.write(`event: changed\ndata: ${JSON.stringify(note)}\n\n`)
      }
      publish(false)
    })
    const beat = setInterval(() => res.write(': beat\n\n'), 15_000)
    beat.unref?.()
    streams.add(res)
    req.on('close', () => {
      streams.delete(res)
      stop()
      clearInterval(beat)
    })
  }

  async function claim(req, res) {
    const { ticket } = JSON.parse(await readBody(req, 1024))
    const claimed = access?.claim(ticket)
    return claimed ? send(res, 200, { token: claimed }) : send(res, 401, { error: 'ticket' })
  }

  // 画面が合言葉も鍵もないまま開かれたことを、Modへ知らせる。2秒に1回まで。合言葉や鍵には触らない。
  // 画面は ?hadKey=1（鍵付きの場所で、鍵を断られた）か ?hadKey=0（アドレスに鍵が無かった）を付ける。
  // Modは hadKey: true のときだけClaudeに頼み直す。付いていない・知らない値なら、前と同じく時刻だけを書く。
  function needTicket(req, res, url) {
    // この入口は中身を受け取らない。
    if (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined) {
      return send(res, 413, { error: 'body' })
    }
    const flag = url.searchParams.get('hadKey')
    const hadKey = flag === '1' ? true : flag === '0' ? false : undefined
    const file = path.join(vaultDir, 'need-ticket.json')
    const now = Date.now()
    let last = 0
    let lastHadKey
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      last = Number(saved.at) || 0
      lastHadKey = saved.hadKey
    } catch {}
    // 未来の時刻が残っていたら古いものとして扱う（時計が戻ったあとも書けなくならないように）。
    if (last > now) last = 0
    // 鍵の無い場所を読んだすぐあとに鍵を断られたら、2秒以内でも書き直す（断られた知らせを落とさないため）。
    const upgrade = hadKey === true && lastHadKey === false
    if (now - last >= NEED_TICKET_GAP_MS || upgrade) {
      try {
        fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
        // Modは時刻が進んだときだけ読むので、書き直すときは前の時刻より必ずあとにする。
        const at = Math.max(now, last + 1)
        replaceFile(file, JSON.stringify(hadKey === undefined ? { at } : { at, hadKey }), { mode: 0o600 })
      } catch {
        // 書けなくても、場所などを含む理由は返さない。
      }
    }
    // Modが開き直しを頼んでいるあいだは pending: true。画面はこれで文を出し分ける。秘密は返さない。
    let until = 0
    try { until = Number(JSON.parse(fs.readFileSync(path.join(vaultDir, 'open-pending.json'), 'utf8'))?.until) || 0 } catch {}
    return send(res, 200, { pending: until > now })
  }

  // settings.json を今の中身のまま読む。壊れていれば ok: false で理由を返す。
  function loadSettingsFile() {
    let text
    try {
      text = fs.readFileSync(path.join(vaultDir, 'settings.json'), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { ok: true, json: {} }
      return { ok: false, errors: [`settings.jsonを読めません：${error.message}`] }
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, errors: ['settings.jsonのJSONが壊れています'] }
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { ok: false, errors: ['settings.jsonの中身がオブジェクトではありません'] }
    }
    return { ok: true, json }
  }

  async function putSettings(req, res) {
    let body
    try { body = JSON.parse(await readBody(req, MAX_JSON)) } catch (error) {
      if (error.status) throw error
      return send(res, 400, { errors: ['送る中身がJSONとして読めません'] })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { errors: ['送る中身がオブジェクトではありません'] })
    // 読む→混ぜる→書くを途中で待たずに行う（同時に2件来ても、片方の変更が消えないように）。
    const current = loadSettingsFile()
    if (!current.ok) return send(res, 409, { errors: current.errors })
    const merged = { ...current.json }
    const typeErrors = []
    const isText = (v) => typeof v === 'string'
    if (body.attachmentDir !== undefined) {
      if (body.attachmentDir === null) delete merged.attachmentDir
      else if (isText(body.attachmentDir)) merged.attachmentDir = body.attachmentDir
      else typeErrors.push('attachmentDirが文字ではありません')
    }
    if (body.unlisted !== undefined) {
      if (body.unlisted === null) delete merged.unlisted
      else merged.unlisted = body.unlisted
    }
    if (body.periodicRoot !== undefined) {
      if (body.periodicRoot === null) delete merged.periodic
      else if (isText(body.periodicRoot)) {
        const old = merged.periodic && typeof merged.periodic === 'object' && !Array.isArray(merged.periodic) ? merged.periodic : {}
        merged.periodic = { ...old, root: body.periodicRoot }
      } else typeErrors.push('periodicRootが文字ではありません')
    }
    const errors = [...typeErrors, ...(typeErrors.length ? [] : checkVaultSettings(merged, root).errors)]
    if (errors.length) return send(res, 400, { errors })
    fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
    replaceFile(path.join(vaultDir, 'settings.json'), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
    return send(res, 200, { settings: merged, errors: [] })
  }

  // 止める指示。合言葉・x-note-editor: 1（checkRequest）・送った側のほうが新しいバージョン、がそろったときだけ受け付ける。
  // 204を送ってから、処理中の保存を待ち、接続を閉じ、onShutdown（handover.json・ロック・終了）へ進む。
  // 2回目以降の指示は、handle の入口で 503 になるので、ここへは来ない。
  function shutdown(req, res) {
    if (noToken) return send(res, 403, { error: 'no-token' })
    const from = req.headers[VERSION_HEADER]
    if (typeof from !== 'string' || !VERSION_RE.test(from)) return send(res, 400, { error: 'version' })
    if (compareVersions(from, SERVER_VERSION) <= 0) return send(res, 409, { error: 'not newer' })
    shuttingDown = true
    inflight.delete(res)
    let started = false
    let fallback = null
    // 204 を送り終えた（finish）、接続が先に切れた（close）、どちらも来ない（予備のタイマー）、のいちばん早いもので1回だけ動く。
    // finish だけを待つと、送り終える前に接続が壊れたとき、いつまでも止まらない。
    const stop = async () => {
      if (started) return
      started = true
      clearTimeout(fallback)
      // 受け付けていた保存を書き終える。30秒は、処理中の要求を待つ上限（AIの判断。終わらない要求があっても止まれるように）。
      const deadline = Date.now() + 30_000
      while (inflight.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      for (const stream of streams) stream.end()
      streams.clear()
      try {
        await onShutdown?.({ to: from })
      } catch (error) {
        console.error(`止める処理に失敗しました: ${error.message}`)
        process.exit(1)
      }
    }
    fallback = setTimeout(stop, SHUTDOWN_FALLBACK_MS)
    fallback.unref?.()
    res.once('finish', stop)
    res.once('close', stop)
    return send(res, 204, '')
  }

  async function api(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/claim') return claim(req, res)
    if (req.method === 'POST' && url.pathname === '/api/need-ticket') return needTicket(req, res, url)
    if (!allowed(req, url)) return send(res, 401, { error: 'token' })
    const rel = url.searchParams.get('path')
    const route = `${req.method} ${url.pathname}`
    const claimed = req.headers['x-note-root'] ?? url.searchParams.get('root')
    if (claimed && claimed !== rootId) return send(res, 412, { error: 'other vault' })
    switch (route) {
      case 'POST /api/shutdown':
        return shutdown(req, res)
      case 'POST /api/chat-bind':
        return chatBind(req, res)
      case 'GET /api/health':
        return send(res, 200, {
          ok: true,
          root: path.basename(root),
          rootId,
          rootPaths: sameAs ? [root, sameAs] : [root],
          platform: process.platform === 'win32' ? 'win32' : 'darwin',
          portMoved: preferredPort !== undefined && actualPort !== preferredPort,
          settingsErrors: settings().errors,
          ...(fileKey ? { fileKey } : {}),
        })
      // 開いているノートを伝えるかどうかは、結び付いたチャットごとに覚える。
      case 'GET /api/share': {
        const chat = chatOf(req)
        return send(res, 200, { on: chat.registered && readChatJson(chat.dir, 'share.json')?.on === true })
      }
      case 'PUT /api/share': {
        let on
        try { on = JSON.parse(await readBody(req, 1024))?.on } catch (error) {
          if (error.status) throw error
        }
        if (typeof on !== 'boolean') return send(res, 400, { error: 'on' })
        const chat = chatOf(req)
        if (!chat.registered) return send(res, 409, { error: 'no-chat' })
        replaceFile(path.join(chat.dir, 'share.json'), JSON.stringify({ on }), { mode: 0o600 })
        return send(res, 200, { on })
      }
      case 'GET /api/settings': {
        const current = loadSettingsFile()
        if (!current.ok) return send(res, 200, { settings: {}, errors: current.errors })
        return send(res, 200, { settings: current.json, errors: checkVaultSettings(current.json, root).errors })
      }
      case 'PUT /api/settings':
        return putSettings(req, res)
      case 'GET /api/appearance':
        return send(res, 200, readAppearance(stateDir))
      case 'GET /api/note':
        return send(res, 200, readNote(root, rel))
      case 'PUT /api/note': {
        const { text, baseHash } = JSON.parse(await readBody(req, MAX_JSON))
        const saved = writeNote(root, rel, text, baseHash, backups)
        return send(res, saved.conflict ? 409 : 200, saved)
      }
      case 'POST /api/note': {
        const { text = '' } = JSON.parse(await readBody(req, MAX_JSON))
        const created = createNote(root, rel, text)
        // 作ったノートと、新しくできたフォルダーがすぐ一覧に出るようにする。
        notesCache = null
        return send(res, 201, created)
      }
      // ファイル欄の操作。どれも一覧の控えを消して、すぐ一覧に出す。
      case 'POST /api/folder': {
        const { path: target } = JSON.parse(await readBody(req, MAX_JSON))
        const created = createFolder(root, target)
        notesCache = null
        return send(res, 201, created)
      }
      case 'POST /api/move/plan': {
        const { from, to } = JSON.parse(await readBody(req, MAX_JSON))
        const { changes, blocked, unreadable } = planMove(root, from, to, scanOptionsOf(settings()))
        const brief = (list) => list.map(({ path: note, count }) => ({ path: note, count }))
        return send(res, 200, { changes: brief(changes), blocked: brief(blocked), unreadable })
      }
      case 'POST /api/move': {
        const { from, to, relink = false } = JSON.parse(await readBody(req, MAX_JSON))
        const moved = moveItem(root, from, to, { relink: Boolean(relink), backups, scanOptions: scanOptionsOf(settings()) })
        notesCache = null
        return send(res, 200, moved)
      }
      case 'POST /api/trash': {
        const { path: target } = JSON.parse(await readBody(req, MAX_JSON))
        const trashed = trashItem(root, target)
        notesCache = null
        return send(res, 200, trashed)
      }
      case 'GET /api/periodic': {
        const { periodic } = settings()
        if (!periodic) return send(res, 200, { disabled: true })
        return send(res, 200, periodicMonth(root, url.searchParams.get('month'), periodic))
      }
      case 'POST /api/periodic/open': {
        let body
        try {
          body = JSON.parse(await readBody(req, MAX_JSON))
        } catch (error) {
          if (error.status) throw error
          return send(res, 400, { error: 'bad request' })
        }
        const { periodic } = settings()
        if (!periodic) return send(res, 409, { error: 'no-periodic-root' })
        let opened
        try {
          opened = openPeriodic(root, body, periodic)
        } catch (error) {
          if (error.body) return send(res, error.status, error.body)
          throw error
        }
        if (body.dryRun === true) return send(res, 200, opened)
        notesCache = null
        return send(res, opened.created ? 201 : 200, opened)
      }
      case 'GET /api/notes':
        return send(res, 200, notes())
      case 'GET /api/tasks':
        return send(res, 200, taskIndex.list())
      case 'GET /api/events':
        return events(req, res, rel)
      case 'GET /api/file': {
        const file = resolveAssetPath(root, rel)
        const bytes = fs.readFileSync(file)
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()],
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'cache-control': 'no-cache',
        })
        return res.end(bytes)
      }
      case 'POST /api/backup': {
        const { text } = JSON.parse(await readBody(req, MAX_JSON))
        backups.save(rel, text, 'conflict')
        return send(res, 200, { ok: true })
      }
      case 'GET /api/backups':
        readNote(root, rel)
        return send(res, 200, { backups: backups.list(rel) })
      case 'GET /api/backup': {
        readNote(root, rel)
        const text = backups.read(rel, url.searchParams.get('id'))
        return text === null ? send(res, 404, { error: 'not found' }) : send(res, 200, { text })
      }
      case 'POST /api/attachment': {
        const name = path.basename(url.searchParams.get('name') ?? 'image.png')
        const ext = path.extname(name).toLowerCase()
        const stem = path.basename(name, ext).replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'image'
        const now = new Date()
        const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().replace(/\D/g, '').slice(0, 14)
        const target = `${settings().attachmentDir ?? DEFAULT_ATTACHMENT_DIR}/${stem}-${stamp}${ext}`
        const file = resolveAssetPath(root, target)
        const bytes = await readBody(req, MAX_ATTACHMENT)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, bytes, { flag: 'wx' })
        return send(res, 201, { path: target })
      }
      // 開いているノート・引用・送る文は、この画面が結び付いたチャットのフォルダーにだけ書く。
      // 結び付いたチャットが無い画面の状態は、どのチャットにも渡さない（書かない）。送る文と引用は断る。
      case 'PUT /api/state': {
        const state = JSON.parse(await readBody(req, MAX_JSON))
        if (!state || typeof state !== 'object' || Array.isArray(state)) return send(res, 400, { error: 'state' })
        const chat = chatOf(req)
        const asks = Boolean(state.askChat || state.sendChat)
        if (!chat.registered) return asks ? send(res, 409, { error: 'no-chat' }) : send(res, 200, { ok: true, linked: false })
        if (asks && chat.partner !== 'live') return send(res, 409, { error: 'chat-gone' })
        const file = path.join(chat.dir, 'state.json')
        // Modが読み取る前に次の状態で消えないよう、チャットへ送る文字は残す。
        let { askChat, sendChat } = state
        if (!askChat || !sendChat) {
          const saved = readChatJson(chat.dir, 'state.json')
          askChat ??= saved?.askChat
          sendChat ??= saved?.sendChat
        }
        replaceFile(file, JSON.stringify({ ...state, askChat, sendChat, root, updatedAt: Date.now() }), { mode: 0o600 })
        return send(res, 200, { ok: true, linked: true })
      }
      // チャット欄の試験：Modが書いた最後の返事と、最後に送った文の時刻を返す。
      // 時刻も返すのは、ページを読み込み直しても返事待ちを続けられるようにするため。
      // partner: 'live'（結び付いたチャットが動いている）・'gone'（結び付いたチャットがもう無い）・'none'（結び付いていない）。
      // title は結び付いたチャットの名前（Modが分かる範囲で書いたもの）。
      case 'GET /api/chat-reply': {
        const chat = chatOf(req)
        if (!chat.registered) return send(res, 200, { partner: 'none', sent: 0 })
        const reply = readChatJson(chat.dir, 'reply.json') ?? {}
        const sent = readChatJson(chat.dir, 'state.json')?.sendChat?.at ?? 0
        return send(res, 200, { ...(reply && typeof reply === 'object' ? reply : {}), sent, partner: chat.partner, title: chat.title })
      }
      // チャット枠の試験：Modが書き出した最近の会話を返す。
      case 'GET /api/chat-log': {
        const chat = chatOf(req)
        return send(res, 200, (chat.registered && readChatJson(chat.dir, 'log.json')) || {})
      }
      // チャット枠に添付した画像は、Vaultに混ぜず、エディターの作業フォルダーに置く。
      case 'POST /api/chat-image': {
        const ext = path.extname(path.basename(url.searchParams.get('name') ?? '')).toLowerCase()
        if (!CHAT_IMAGE_EXT.has(ext)) return send(res, 400, { error: 'image only' })
        const bytes = await readBody(req, CHAT_IMAGE_MAX)
        if (!bytes.length) return send(res, 400, { error: 'empty' })
        const dir = path.join(vaultDir, 'chat-images')
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        // 古い添付画像は、新しく添付するときに片付ける。
        for (const name of fs.readdirSync(dir)) {
          const old = path.join(dir, name)
          try {
            if (Date.now() - fs.statSync(old).mtimeMs > CHAT_IMAGE_KEEP_MS) fs.rmSync(old)
          } catch {
            // 消せなければ次の機会に。
          }
        }
        const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`)
        fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
        return send(res, 201, { path: file })
      }
      // チャット枠の吹き出しに、添付した画像の小さな見本を出す。作業フォルダーの中のファイル名だけを受け付ける。
      case 'GET /api/chat-image': {
        const name = url.searchParams.get('file') ?? ''
        if (!/^\d+-[0-9a-f]{8}\.(png|jpe?g|gif|webp)$/.test(name)) return send(res, 400, { error: 'bad name' })
        try {
          const bytes = fs.readFileSync(path.join(vaultDir, 'chat-images', name))
          const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[name.split('.').pop()]
          res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' })
          return res.end(bytes)
        } catch {
          return send(res, 404, { error: 'not found' })
        }
      }
      case 'GET /api/state': {
        const chat = chatOf(req)
        return send(res, 200, (chat.registered && readChatJson(chat.dir, 'state.json')) || {})
      }
      default:
        return send(res, 404, { error: 'not found' })
    }
  }

  function page(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' })
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const file = path.normalize(path.join(publicDir, rel))
    if (!file.startsWith(publicDir + path.sep)) return send(res, 400, { error: 'path' })
    let bytes
    try {
      bytes = fs.readFileSync(file)
    } catch {
      return send(res, 404, { error: 'not found' })
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    })
    return res.end(bytes)
  }

  async function handle(req, res) {
    // 断るときも含めて、どの応答にも付ける。起動するとき、このポートにいるのが同じVaultのサーバーか確かめるのに使う。
    res.setHeader(VAULT_HEADER, rootId)
    res.setHeader(VERSION_HEADER, SERVER_VERSION)
    const check = checkRequest(req, actualPort)
    if (!check.ok) return send(res, 403, { error: check.reason })
    const url = new URL(req.url, `http://127.0.0.1:${actualPort}`)
    // 止める指示を受け付けたあとに来た、書き込みを伴う要求は受け付けない（処理中のものだけ書き終える）。
    if (shuttingDown && req.method !== 'GET' && req.method !== 'HEAD') return send(res, 503, { error: 'shutting down' })
    // 長く続く接続（events）以外は、終わるまで数える。止める前に、受け付けた保存を書き終えるため。
    const counted = !(req.method === 'GET' && url.pathname === '/api/events')
    if (counted) {
      inflight.add(res)
      res.once('close', () => inflight.delete(res))
    }
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url)
      return page(req, res, url)
    } catch (error) {
      if (res.headersSent) return res.end()
      return send(res, statusOf(error), { error: error.message })
    }
  }

  return {
    backups,
    // 127.0.0.1 と ::1 の両方で待ち受ける。呼ぶたびに新しく作るので、ふさがっていたら次の番号で呼び直せる。
    listen(port) {
      return new Promise((resolve, reject) => {
        const server = http.createServer(handle)
        // localhostは::1に向くことがある。空けておくと、同じ番号を別のプログラムに取られ、リンクの鍵を読まれる。
        const seat6 = http.createServer(handle)
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          actualPort = server.address().port
          const finish = () => {
            server.once('close', () => {
              seat6.closeAllConnections()
              seat6.close()
              access?.stop()
            })
            try {
              if (noToken) {
                writeOpenAccess(vaultDir, actualPort, root, lockNonce)
              } else {
                access = createAccess(vaultDir, actualPort, root, ticketMs, lockNonce)
                token = access.token
                fileKey = fileKeyOf(token)
              }
            } catch (error) {
              server.close()
              reject(error)
              return
            }
            backups.prune()
            pruneChats()
            const pruner = setInterval(() => {
              backups.prune()
              pruneChats()
            }, 60 * 60 * 1000)
            pruner.unref?.()
            server.once('close', () => clearInterval(pruner))
            resolve(server)
          }
          seat6.once('error', (error) => {
            // IPv6が使えない環境では取らなくてよい。番号を決めて待ち受けたのに取られているときは、両方を閉じて失敗する（次の番号へ進むため）。
            if (error.code === 'EADDRINUSE' && port !== 0) {
              server.close(() => reject(error))
              return
            }
            finish()
          })
          seat6.listen(actualPort, '::1', finish)
        })
      })
    },
  }
}
