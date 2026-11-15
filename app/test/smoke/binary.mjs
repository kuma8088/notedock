// 実行ファイルの確認（スモークテスト）。Node.jsでも、Denoで作った実行ファイルでも動く。
// 使い方：binary.mjs <サーバーを起動するコマンド> [その引数…]
//   例：node test/smoke/binary.mjs node server/main.mjs
//       dist/notedock-smoke-aarch64-apple-darwin dist/notedock-server-aarch64-apple-darwin
// 項目ごとに「PASS 名前」「FAIL 名前: 理由」「SKIP 名前: 理由」を1行ずつ出す。FAILが1つでもあれば終了コード1。
// 一時フォルダーの中だけを使い、起動したサーバーと一時フォルダーは、失敗したときも片づける。
// 内部用：--launcher <コマンド> [引数…] で、サーバーを起動するだけの「起動役」として動く（Mac）。Windowsの起動役はcmd.exe。
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ARGS = globalThis.Deno ? [...globalThis.Deno.args] : process.argv.slice(2)
const WIN = process.platform === 'win32'
const ALREADY_RUNNING = 75
const START_TIMEOUT_MS = 40000
const PARENT_WAIT_MS = 10000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (ARGS[0] === '--launcher') {
  runLauncher(ARGS.slice(1))
} else {
  main(ARGS).then(
    (code) => process.exit(code),
    (error) => {
      console.log(`FAIL smoke: ${error?.stack ?? error}`)
      process.exit(1)
    },
  )
}

// 起動役：サーバーを起動して、そのまま待つだけ。強制終了されるのを待つ。
function runLauncher([cmd, ...args]) {
  const child = spawn(cmd, args, { stdio: 'ignore' })
  child.on('exit', () => process.exit(0))
  child.on('error', () => process.exit(1))
  setInterval(() => {}, 1000)
}

// 自分自身をもう一度起動するためのコマンド。Nodeとdeno run、作った実行ファイルで違う。
function selfCommand() {
  if (globalThis.Deno) {
    const exe = globalThis.Deno.execPath()
    if (path.basename(exe).toLowerCase().replace(/\.exe$/, '') === 'deno') return [exe, ['run', '-A', fileURLToPath(import.meta.url)]]
    return [exe, []]
  }
  return [process.execPath, [fileURLToPath(import.meta.url)]]
}

function request(port, method, pathname, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    const all = { 'x-note-editor': '1', ...headers }
    if (token) all['x-note-token'] = token
    if (data) {
      all['content-type'] = 'application/json'
      all['content-length'] = String(data.length)
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: all, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
      res.on('error', reject)
    })
    req.setTimeout(15000, () => req.destroy(new Error(`timeout ${method} ${pathname}`)))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// ポートで何かが接続を受け付けているか。
// Windowsでは、誰もいないポートへの接続が断られるまでに約2秒かかるので、待つ時間はそれより長くする。
function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(6000, () => done(true))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

const q = (rel) => encodeURIComponent(rel)

function check(condition, message) {
  if (!condition) throw new Error(message)
}

async function main(argv) {
  if (argv.length === 0) {
    console.log('使い方：binary.mjs <サーバーを起動するコマンド> [その引数…]')
    return 2
  }
  const [serverCmd, ...serverArgs] = argv
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'notedock-smoke-')))
  const vault = path.join(tmp, '山田 My Notes')
  const stateDir = path.join(tmp, 'state')
  const outside = path.join(tmp, 'outside')
  const children = new Set()
  // server.json で見たサーバーのプロセス番号と、そのポート。止まったと確かめたら消す。
  const serverPids = new Map()
  const trashLeft = []
  let failed = 0

  const killPid = (pid, signal = 'SIGKILL') => {
    try {
      process.kill(pid, WIN ? 'SIGKILL' : signal)
    } catch {
      // もう終わっている。
    }
  }
  // 急に終わるときは、まだ動いている直接の子だけを止める（番号だけのプロセスは、別のプログラムかもしれないので止めない）。
  const lastResort = () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) killPid(child.pid)
  }
  process.on('exit', lastResort)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    try {
      process.on(signal, () => {
        lastResort()
        try {
          fs.rmSync(tmp, { recursive: true, force: true })
        } catch {
          // 残れば最後に場所を出す。
        }
        process.exit(130)
      })
    } catch {
      // 受け取れないOSでは、終わるときの片づけに任せる。
    }
  }

  function track(child) {
    children.add(child)
    child.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
      child.once('error', (error) => resolve({ code: null, signal: null, error }))
    })
    return child
  }
  const baseArgs = (extra = []) => [...serverArgs, '--root', vault, '--state-dir', stateDir, ...extra]
  const startServer = (extra = []) => track(spawn(serverCmd, baseArgs(extra), { stdio: 'ignore' }))
  const startLauncher = (extra = []) => {
    // Windowsでは、Denoで作ったプログラムを強制終了すると、それが起動したプログラムも一緒に終わる
    // （起動役なしでも同じになり、見張りを確かめられない）。そのためcmd.exeを起動役にする。
    if (WIN) {
      const line = `/d /s /c "${[serverCmd, ...baseArgs(extra)].map((arg) => `"${arg}"`).join(' ')}"`
      return track(spawn('cmd.exe', [line], { stdio: 'ignore', windowsVerbatimArguments: true }))
    }
    const [self, selfArgs] = selfCommand()
    return track(spawn(self, [...selfArgs, '--launcher', serverCmd, ...baseArgs(extra)], { stdio: 'ignore' }))
  }
  const waitExit = async (child, ms) => {
    const timer = sleep(ms).then(() => null)
    return Promise.race([child.exited, timer])
  }

  // ---- 準備：Vault、保存フォルダー、settings.json ----
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(vault, 'home.md'), '# ホーム\n')
  fs.mkdirSync(path.join(vault, 'Archive'))
  fs.writeFileSync(path.join(vault, 'Archive', 'old.md'), 'old\n')
  fs.writeFileSync(path.join(outside, 'secret.md'), 'outside\n')
  const vaultId = execFileSync(serverCmd, [...serverArgs, '--print-vault-id', '--root', vault], { encoding: 'utf8', timeout: 30000 }).trim()
  check(/^[0-9a-f]{16}$/.test(vaultId), `vaultId: ${vaultId}`)
  const vaultDir = path.join(stateDir, 'vaults', vaultId)
  const serverJson = path.join(vaultDir, 'server.json')
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(vaultDir, 'settings.json'), JSON.stringify({ unlisted: ['Archive'] }), { mode: 0o600 })
  console.log(`INFO platform=${process.platform} runtime=${globalThis.Deno ? `deno ${globalThis.Deno.version.deno}` : `node ${process.version}`} vaultId=${vaultId}`)

  const readJson = () => {
    try {
      return JSON.parse(fs.readFileSync(serverJson, 'utf8'))
    } catch {
      return null
    }
  }
  // server.json に、条件に合うサーバーが書かれ、そのポートがこのVaultの印を付けて答えるまで待つ。
  async function waitServing(accept, { child = null, ms = START_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`server exited early: code=${child.exitCode} signal=${child.signalCode}`)
      const info = readJson()
      if (info && Number.isInteger(info.port) && accept(info)) {
        try {
          const res = await request(info.port, 'GET', '/api/health')
          if (res.headers['x-notedock-vault'] === vaultId) {
            serverPids.set(info.pid, info.port)
            return { ...info, health: res }
          }
        } catch {
          // まだ受け付けていない。
        }
      }
      await sleep(150)
    }
    throw new Error('server.json / health did not become ready in time')
  }
  async function claimToken(info) {
    const res = await request(info.port, 'POST', '/api/claim', { body: { ticket: info.ticket } })
    check(res.status === 200 && typeof res.json?.token === 'string', `claim: ${res.status} ${res.text}`)
    return res.json.token
  }
  async function stopGracefully(child) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      if (!(await waitExit(child, 10000))) {
        child.kill('SIGKILL')
        if (!(await waitExit(child, 10000))) return
      }
    }
    serverPids.delete(child.pid)
  }
  // ポートで、このVaultのサーバーが答えるか。
  async function serving(port) {
    try {
      const res = await request(port, 'GET', '/api/health')
      return res.headers['x-notedock-vault'] === vaultId
    } catch {
      return false
    }
  }
  // その番号が、まだ自分の起動したサーバーか。動いている直接の子か、server.json の番号で、そのポートがこのVaultの印を返すときだけ。
  async function isOurServer(pid) {
    for (const child of children) if (child.pid === pid && child.exitCode === null && child.signalCode === null) return true
    const info = readJson()
    return Boolean(info && info.pid === pid && Number.isInteger(info.port) && (await serving(info.port)))
  }
  async function stopOurServer(pid, signal = 'SIGKILL') {
    if (await isOurServer(pid)) killPid(pid, signal)
  }
  async function waitPortFree(port, ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!(await portBusy(port))) return true
      await sleep(250)
    }
    return !(await portBusy(port))
  }

  let current = null // { child, info, token }
  async function ensureServer() {
    if (current && current.child.exitCode === null && current.child.signalCode === null) return current
    const child = startServer()
    const info = await waitServing((i) => i.pid === child.pid, { child })
    current = { child, info, token: await claimToken(info) }
    return current
  }
  const api = (method, pathname, options = {}) => request(current.info.port, method, pathname, { token: current.token, ...options })

  async function item(name, fn) {
    try {
      const result = await fn()
      if (typeof result === 'string' && result.startsWith('SKIP')) console.log(`SKIP ${name}: ${result.slice(5)}`)
      else console.log(`PASS ${name}`)
    } catch (error) {
      failed += 1
      console.log(`FAIL ${name}: ${error?.message ?? error}`)
    }
  }
  const winOnly = (fn) => (WIN ? fn : async () => 'SKIP windows only')

  try {
    await item('start', async () => {
      const child = startServer()
      const info = await waitServing((i) => i.pid === child.pid, { child })
      check(info.health.status === 401, `health without token: ${info.health.status}`)
      check(typeof info.ticket === 'string' && typeof info.token === 'string', 'server.json has no ticket/token')
      current = { child, info, token: null }
    })

    await item('claim', async () => {
      check(current, 'no server')
      const token = await claimToken(current.info)
      check(token === current.info.token, 'claimed token differs from server.json')
      current.token = token
      const again = await request(current.info.port, 'POST', '/api/claim', { body: { ticket: current.info.ticket } })
      check(again.status === 401, `ticket reused: ${again.status}`)
      const health = await api('GET', '/api/health')
      check(health.status === 200, `health with token: ${health.status}`)
      check(health.json.rootId === vaultId, `rootId: ${health.json.rootId}`)
      check(Array.isArray(health.json.settingsErrors) && health.json.settingsErrors.length === 0, `settingsErrors: ${JSON.stringify(health.json.settingsErrors)}`)
    })

    await item('save', async () => {
      await ensureServer()
      const rel = '日本語 フォルダー/ノート 1.md'
      const first = '# 見出し\n本文です。\n'
      const created = await api('POST', `/api/note?path=${q(rel)}`, { body: { text: first } })
      check(created.status === 201, `create: ${created.status} ${created.text}`)
      let read = await api('GET', `/api/note?path=${q(rel)}`)
      check(read.status === 200 && read.json.text === first, `read after create: ${read.status}`)
      const second = `${first}追記した行。\n`
      const put = await api('PUT', `/api/note?path=${q(rel)}`, { body: { text: second, baseHash: read.json.hash } })
      check(put.status === 200 && put.json.conflict === false, `save: ${put.status} ${put.text}`)
      read = await api('GET', `/api/note?path=${q(rel)}`)
      check(read.status === 200 && read.json.text === second, 'read after save differs')
      check(fs.readFileSync(path.join(vault, rel), 'utf8') === second, 'disk differs')

      fs.writeFileSync(path.join(vault, 'crlf.md'), 'a\r\nb\r\n')
      read = await api('GET', '/api/note?path=crlf.md')
      check(read.status === 200 && read.json.eol === 'crlf' && read.json.text === 'a\nb\n' && read.json.editable, `crlf read: ${read.text}`)
      const crlfPut = await api('PUT', '/api/note?path=crlf.md', { body: { text: 'a\nb\nc\n', baseHash: read.json.hash } })
      check(crlfPut.status === 200, `crlf save: ${crlfPut.status} ${crlfPut.text}`)
      const disk = fs.readFileSync(path.join(vault, 'crlf.md'), 'utf8')
      check(disk === 'a\r\nb\r\nc\r\n', `crlf on disk after save: ${JSON.stringify(disk)}`)
    })

    await item('refuse', async () => {
      await ensureServer()
      for (const rel of ['a\\..\\..\\x.md', '.git/x.md']) {
        const read = await api('GET', `/api/note?path=${q(rel)}`)
        check(read.status === 400, `GET ${rel}: ${read.status}`)
        const write = await api('POST', `/api/note?path=${q(rel)}`, { body: { text: 'x' } })
        check(write.status === 400, `POST ${rel}: ${write.status}`)
      }
      check(!fs.existsSync(path.join(tmp, 'x.md')) && !fs.existsSync(path.join(vault, '.git')), 'a file was written')
    })

    await item('refuse-win', winOnly(async () => {
      await ensureServer()
      for (const rel of ['CON.md', 'a:b.md']) {
        const read = await api('GET', `/api/note?path=${q(rel)}`)
        check(read.status === 400, `GET ${rel}: ${read.status}`)
        const write = await api('POST', `/api/note?path=${q(rel)}`, { body: { text: 'x' } })
        check(write.status === 400, `POST ${rel}: ${write.status}`)
      }
      const long = 'Long Folder Name'
      fs.mkdirSync(path.join(vault, long), { recursive: true })
      fs.writeFileSync(path.join(vault, long, 'x.md'), 'long\n')
      const control = await api('GET', `/api/note?path=${q(`${long}/x.md`)}`)
      check(control.status === 200, `GET ${long}/x.md: ${control.status}`)
      const out = spawnSync('cmd.exe', ['/d', '/c', 'for /d %I in (Long?Folder?Name) do @echo %~snxI'], { cwd: vault, encoding: 'utf8' })
      check(out.status === 0, `short name lookup failed: ${out.status} ${out.stderr}`)
      const short = out.stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
      if (!short || short.toLowerCase() === long.toLowerCase()) return 'SKIP short names (8.3) are not created on this volume'
      const viaShort = await api('GET', `/api/note?path=${q(`${short}/x.md`)}`)
      check(viaShort.status === 400, `GET ${short}/x.md (short name of "${long}"): ${viaShort.status}`)
      console.log(`INFO refuse-win: short name of "${long}" is ${short}`)
    }))

    await item('hidden', winOnly(async () => {
      await ensureServer()
      const hidden = '隠し フォルダー'
      const shown = '見える フォルダー'
      for (const dir of [hidden, shown]) {
        fs.mkdirSync(path.join(vault, dir), { recursive: true })
        fs.writeFileSync(path.join(vault, dir, 'n.md'), 'n\n')
      }
      const attrib = spawnSync('attrib', ['+h', path.join(vault, hidden)], { encoding: 'utf8' })
      check(attrib.status === 0, `attrib +h failed: ${attrib.status} ${attrib.stdout} ${attrib.stderr}`)
      // 一覧の控えを消すため、ノートを1つ作る（作ると控えが消える）。
      const refresh = await api('POST', `/api/note?path=${q('hidden-refresh.md')}`, { body: { text: '' } })
      check(refresh.status === 201, `cache-busting note: ${refresh.status}`)
      const list = await api('GET', '/api/notes')
      check(list.status === 200, `notes: ${list.status}`)
      check(list.json.folders.includes(shown), `control folder "${shown}" is not listed`)
      check(!list.json.folders.includes(hidden), `hidden folder is listed`)
      check(!list.json.notes.some((n) => n.startsWith(`${hidden}/`)), 'note in hidden folder is listed')
    }))

    await item('junction', winOnly(async () => {
      await ensureServer()
      const link = spawnSync('cmd.exe', ['/d', '/c', 'mklink /J junc ..\\outside'], { cwd: vault, encoding: 'utf8' })
      check(link.status === 0, `mklink /J failed: ${link.status} ${link.stdout} ${link.stderr}`)
      check(fs.existsSync(path.join(vault, 'junc', 'secret.md')), 'junction does not reach the outside folder')
      const read = await api('GET', `/api/note?path=${q('junc/secret.md')}`)
      check(read.status === 400, `GET junc/secret.md: ${read.status}`)
      const write = await api('POST', `/api/note?path=${q('junc/new.md')}`, { body: { text: 'x' } })
      check(write.status === 400, `POST junc/new.md: ${write.status}`)
      const put = await api('PUT', `/api/note?path=${q('junc/secret.md')}`, { body: { text: 'x', baseHash: 'x' } })
      check(put.status === 400, `PUT junc/secret.md: ${put.status}`)
      check(!fs.existsSync(path.join(outside, 'new.md')), 'a note was written outside the vault')
      check(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8') === 'outside\n', 'outside note changed')
      // 一覧の控えを消し、比べるための普通のフォルダーも作る（作ると控えが消える）。
      const control = await api('POST', `/api/note?path=${q('junction-control/n.md')}`, { body: { text: 'n\n' } })
      check(control.status === 201, `control note: ${control.status}`)
      const list = await api('GET', '/api/notes')
      check(list.status === 200, `notes: ${list.status}`)
      check(list.json.folders.includes('junction-control') && list.json.notes.includes('junction-control/n.md'), 'control folder is not listed (list may be stale)')
      check(!list.json.folders.includes('junc') && !list.json.notes.some((n) => n.startsWith('junc/')), 'junction is listed')
    }))

    await item('move-exists', async () => {
      await ensureServer()
      for (const [rel, text] of [['m/a.md', 'A\n'], ['m/b.md', 'B\n'], ['m/case.md', 'C\n']]) {
        const res = await api('POST', `/api/note?path=${q(rel)}`, { body: { text } })
        check(res.status === 201, `create ${rel}: ${res.status}`)
      }
      const move = await api('POST', '/api/move', { body: { from: 'm/a.md', to: 'm/b.md' } })
      check(move.status === 409, `move onto existing note: ${move.status} ${move.text}`)
      check(fs.readFileSync(path.join(vault, 'm', 'a.md'), 'utf8') === 'A\n', 'm/a.md changed')
      check(fs.readFileSync(path.join(vault, 'm', 'b.md'), 'utf8') === 'B\n', 'm/b.md changed')
      // 大文字と小文字だけの変更は、結果を記録するだけ（FAILにしない）。
      let note
      try {
        const caseMove = await api('POST', '/api/move', { body: { from: 'm/case.md', to: 'm/Case.md' } })
        const names = fs.readdirSync(path.join(vault, 'm')).filter((n) => n.toLowerCase() === 'case.md')
        const content = names.length === 1 ? fs.readFileSync(path.join(vault, 'm', names[0]), 'utf8') : null
        note = `status ${caseMove.status}${caseMove.json?.error ? ` (${caseMove.json.error})` : ''}, on disk: ${JSON.stringify(names)}, content kept: ${content === 'C\n'}`
      } catch (error) {
        note = `error ${error.message}`
      }
      console.log(`INFO move-exists case-only rename m/case.md -> m/Case.md: ${note}`)
    })

    await item('trash', async () => {
      await ensureServer()
      const name = `notedock-smoke-${crypto.randomBytes(6).toString('hex')}.md`
      const created = await api('POST', `/api/note?path=${q(name)}`, { body: { text: 'trash me\n' } })
      check(created.status === 201, `create: ${created.status}`)
      const trashed = await api('POST', '/api/trash', { body: { path: name } })
      const gone = !fs.existsSync(path.join(vault, name))
      try {
        check(trashed.status === 200, `trash: ${trashed.status} ${trashed.text}`)
        check(gone, 'note is still in the vault')
        const list = await api('GET', '/api/notes')
        check(list.status === 200 && !list.json.notes.includes(name), 'note is still listed')
        if (WIN) check(fs.existsSync(path.join(vault, '.trash', name)), `not found under <vault>\\.trash\\${name}`)
      } finally {
        if (!WIN && gone) {
          // サーバーは /usr/bin/trash を使う。入れた1つだけを、正確な名前で消す（ゴミ箱の中は一覧しない）。
          const inTrash = path.join(os.homedir(), '.Trash', name)
          const rm = spawnSync('/bin/rm', [inTrash], { encoding: 'utf8' })
          if (rm.status === 0) console.log(`INFO trash cleanup: removed ~/.Trash/${name}`)
          else {
            trashLeft.push(inTrash)
            console.log(`INFO trash cleanup: could not remove ~/.Trash/${name} (left in Trash): ${rm.stderr.trim()}`)
          }
        }
      }
    })

    await item('token-reuse', async () => {
      const before = await ensureServer()
      const { token, port } = { token: before.token, port: before.info.port }
      await stopGracefully(before.child)
      check(await waitPortFree(port, 10000), 'old server did not release its port')
      const child = startServer()
      const info = await waitServing((i) => i.pid === child.pid, { child })
      current = { child, info, token: info.token }
      check(info.port === port, `port changed: ${port} -> ${info.port}`)
      const health = await request(info.port, 'GET', '/api/health', { token })
      check(health.status === 200, `health with the previous token: ${health.status} (new server.json token ${info.token === token ? 'same' : 'differs'})`)
    })

    await item('single', async () => {
      await ensureServer()
      const second = startServer()
      const result = await waitExit(second, 60000)
      if (!result) {
        second.kill('SIGKILL')
        throw new Error('second server did not exit within 60s')
      }
      check(result.code === ALREADY_RUNNING, `second server exit code: ${result.code} signal: ${result.signal}`)
      const health = await api('GET', '/api/health')
      check(health.status === 200, `first server stopped answering: ${health.status}`)
    })

    await item('stale', async () => {
      const old = await ensureServer()
      old.child.kill('SIGKILL')
      check(await waitExit(old.child, 10000), 'first server did not die')
      serverPids.delete(old.child.pid)
      check(fs.existsSync(path.join(vaultDir, 'server.lock')), 'no lock left after the forced kill (cannot test)')
      const child = startServer()
      const info = await waitServing((i) => i.pid === child.pid, { child })
      current = { child, info, token: info.token }
      const health = await api('GET', '/api/health')
      check(health.status === 200, `new server health: ${health.status}`)
    })

    // 起動役ごとサーバーを起動し、起動役を強制終了したあとのポートを見る。
    async function launcherRun(watch) {
      const previousToken = current?.token
      if (current) {
        const port = current.info.port
        await stopGracefully(current.child)
        await waitPortFree(port, 10000)
        current = null
      }
      const previous = readJson()?.pid
      const launcher = startLauncher(watch ? ['--watch-parent'] : [])
      const info = await waitServing((i) => i.pid !== previous && i.pid !== launcher.pid, { child: launcher })
      if (previousToken) {
        // 普通に止めて起動し直しても、前の合言葉が使える。
        const health = await request(info.port, 'GET', '/api/health', { token: previousToken })
        if (health.status !== 200) {
          launcher.kill('SIGKILL')
          await stopOurServer(info.pid)
          throw new Error(`health with the token from before the restart: ${health.status}`)
        }
      }
      launcher.kill('SIGKILL')
      check(await waitExit(launcher, 10000), 'launcher did not die')
      return info
    }

    await item('parent', async () => {
      const info = await launcherRun(true)
      const started = Date.now()
      const free = await waitPortFree(info.port, PARENT_WAIT_MS)
      if (free) serverPids.delete(info.pid)
      else await stopOurServer(info.pid)
      check(free, `port ${info.port} still in use ${PARENT_WAIT_MS / 1000}s after the launcher was killed`)
      console.log(`INFO parent: port released ${((Date.now() - started) / 1000).toFixed(1)}s after the launcher was killed`)
    })

    await item('parent-control', async () => {
      const info = await launcherRun(false)
      const deadline = Date.now() + PARENT_WAIT_MS
      // 生きているかは、ポートが開いているかではなく、このVaultの印を付けて答えるかで見る。
      let freed = false
      while (Date.now() < deadline) {
        if (!(await serving(info.port))) {
          freed = true
          break
        }
        await sleep(500)
      }
      await stopOurServer(info.pid, 'SIGTERM')
      let stopped = await waitPortFree(info.port, 10000)
      if (!stopped) {
        await stopOurServer(info.pid)
        stopped = await waitPortFree(info.port, 5000)
      }
      if (stopped) serverPids.delete(info.pid)
      check(!freed, 'server stopped answering without --watch-parent')
      check(stopped, 'could not stop the server afterwards')
    })
  } finally {
    // 片づけ：起動したものを止め、一時フォルダーを消す。
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await waitExit(child, 5000)
      }
    }
    // 番号だけが残っているものは、まだ自分のサーバーだと確かめられたときだけ止める。
    let leftover = 0
    for (const pid of serverPids.keys()) {
      if (await isOurServer(pid)) {
        killPid(pid)
        leftover += 1
      }
    }
    if (leftover) console.log(`INFO cleanup: stopped ${leftover} leftover server(s) confirmed by pid + vault header`)
    await sleep(300)
    let removed = false
    for (let i = 0; i < 10 && !removed; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
        removed = !fs.existsSync(tmp)
      } catch {
        await sleep(500)
      }
    }
    console.log(removed ? 'INFO cleanup: servers stopped, temp folder removed' : `INFO cleanup: could not remove ${tmp}`)
    if (trashLeft.length) console.log(`INFO cleanup: left in Trash: ${trashLeft.join(', ')}`)
  }
  console.log(failed ? `RESULT ${failed} FAIL` : 'RESULT no FAIL')
  return failed ? 1 : 0
}
