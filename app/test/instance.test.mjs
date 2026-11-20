import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { SHUTDOWN_FALLBACK_MS, createApp } from '../server/app.mjs'
import { VAULT_HEADER, VERSION_HEADER, canonicalRoot, vaultDirOf, vaultIdOf } from '../server/config.mjs'
import { HANDOVER_EXIT, SERVER_VERSION } from '../server/version.mjs'
import { ALREADY_RUNNING, PORT_BASE, PORT_SPAN, acquireLock, isServingCheck, listenOnFreePort, preferredPort, putBack } from '../server/instance.mjs'

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'main.mjs')
const FAST = { waitMs: 1500, pollMs: 100 }

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readLock = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'server.lock'), 'utf8'))
const staleLeft = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith('server.lock.stale-'))
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid

function plantLock(dir, pid) {
  const nonce = crypto.randomBytes(16).toString('hex')
  fs.writeFileSync(path.join(dir, 'server.lock'), JSON.stringify({ pid, startedAt: Date.now(), nonce }))
  return nonce
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const close = (server) => new Promise((resolve) => server.close(resolve))

test('ALREADY_RUNNINGは75で、preferredPortは47000〜47999の決まった番号を返す', () => {
  assert.equal(ALREADY_RUNNING, 75)
  assert.equal(PORT_BASE, 47000)
  assert.equal(PORT_SPAN, 1000)
  for (let i = 0; i < 200; i++) {
    const id = crypto.randomBytes(8).toString('hex')
    const port = preferredPort(id)
    assert.ok(port >= 47000 && port <= 47999, `${id} -> ${port}`)
    assert.equal(preferredPort(id), port)
  }
  assert.equal(preferredPort('00000000ffffffff'), 47000)
  assert.equal(preferredPort('000003e9aaaaaaaa'), 47001)
})

test('ロックがあり、そのプロセスが動いていてserver.jsonがまだないとき、待っている間に応答が返れば null', async () => {
  const dir = tempDir('lock-wait-')
  const vaultId = crypto.randomBytes(8).toString('hex')
  const nonce = plantLock(dir, process.pid)
  // 起動の途中のサーバー：少し遅れて接続を受け付け、server.json を書く。
  const late = sleep(400).then(async () => {
    const server = await serve((req, res) => {
      res.writeHead(401, { [VAULT_HEADER]: vaultId })
      res.end()
    })
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: server.address().port }))
    return server
  })
  const check = isServingCheck(dir, vaultId)
  let calls = 0
  const isServing = async () => {
    calls += 1
    return check()
  }
  const started = Date.now()
  let result
  try {
    result = await acquireLock(dir, { isServing, waitMs: 5000, pollMs: 100 })
  } finally {
    await close(await late)
  }
  const elapsed = Date.now() - started
  assert.equal(result, null)
  assert.ok(elapsed >= 400, `すぐにあきらめず待つ（${elapsed}ms）`)
  assert.ok(elapsed < 3000, `応答したら待つのをやめる（${elapsed}ms）`)
  assert.ok(calls >= 3, '何度か確かめる')
  assert.equal(readLock(dir).nonce, nonce, 'ほかのロックに手を付けない')
})

test('ロックがなければ取れて、server.lockに自分のpid・nonce・startedAtを書く', async () => {
  const dir = tempDir('lock-fresh-')
  const lock = await acquireLock(dir, { now: () => 1234, ...FAST })
  assert.ok(lock)
  assert.match(lock.nonce, /^[0-9a-f]{32}$/)
  assert.deepEqual(readLock(dir), { pid: process.pid, startedAt: 1234, nonce: lock.nonce })
  lock.release()
  assert.equal(fs.existsSync(path.join(dir, 'server.lock')), false)
})

// 取れたほうはサーバーを起動するので、そのあとはほかのプロセスからの問い合わせに答える（本物と同じ）。
function servingAfterWin() {
  let serving = false
  return {
    isServing: async () => serving,
    mark: (lock) => {
      if (lock) serving = true
      return lock
    },
  }
}

test('古いロック（プロセスが動いていない）を2つが同時に引き継ごうとしても、取れるのは1つだけ', async () => {
  for (let round = 0; round < 3; round++) {
    const dir = tempDir('lock-race-')
    plantLock(dir, deadPid())
    const { isServing, mark } = servingAfterWin()
    const results = await Promise.all([1, 2, 3].map(() => acquireLock(dir, { isServing, ...FAST }).then(mark)))
    const winners = results.filter(Boolean)
    assert.equal(winners.length, 1, `round ${round}`)
    assert.equal(readLock(dir).nonce, winners[0].nonce)
    assert.deepEqual(staleLeft(dir), [])
  }
})

// 止まったままのプロセス（ロックの持ち主）は最後まで応答しない。引き継いだほうは、そのあと応答する。
// 別々のプロセスで同時に引き継ぐ。名前を変える・戻す処理が実際に入り組む。
const RACER = `
const { acquireLock } = await import(process.argv[1])
const fs = await import('node:fs')
const [dir, marker] = process.argv.slice(2)
const lock = await acquireLock(dir, { isServing: async () => fs.existsSync(marker), waitMs: 5000, pollMs: 100 })
if (lock) {
  fs.writeFileSync(marker, String(process.pid))
  console.log('WIN')
  setTimeout(() => {}, 1500)
} else console.log('LOSE')
`

test('古いロックを、別々の5つのプロセスが同時に引き継ごうとしても、取れるのは1つだけ', { timeout: 60_000 }, async () => {
  const instanceUrl = new URL('../server/instance.mjs', import.meta.url).href
  for (let round = 0; round < 3; round++) {
    const dir = tempDir('lock-procs-')
    plantLock(dir, deadPid())
    const marker = path.join(dir, 'serving')
    const runs = [1, 2, 3, 4, 5].map(
      () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', RACER, instanceUrl, dir, marker], { stdio: ['ignore', 'pipe', 'inherit'] })
          let out = ''
          child.stdout.on('data', (chunk) => (out += chunk))
          child.on('exit', () => resolve(out.trim()))
        }),
    )
    const outs = await Promise.all(runs)
    assert.equal(outs.filter((o) => o === 'WIN').length, 1, `round ${round}: ${outs}`)
    assert.equal(outs.filter((o) => o === 'LOSE').length, 4, `round ${round}: ${outs}`)
    assert.deepEqual(staleLeft(dir), [])
  }
})

test('ロックのプロセスは動いているが応答しないとき、1秒ずらして2つが引き継ごうとしても、取れるのは1つだけ', async () => {
  const dir = tempDir('lock-stuck-')
  plantLock(dir, process.pid)
  const { isServing, mark } = servingAfterWin()
  const first = acquireLock(dir, { isServing, ...FAST }).then(mark)
  await sleep(1000)
  const second = acquireLock(dir, { isServing, ...FAST }).then(mark)
  const results = await Promise.all([first, second])
  const winners = results.filter(Boolean)
  assert.equal(winners.length, 1)
  assert.equal(readLock(dir).nonce, winners[0].nonce)
  assert.deepEqual(staleLeft(dir), [])
})

test('ロックのプロセスが動いていても、server.jsonのポートがNoteDockの印を返さなければ引き継ぐ', async () => {
  const dir = tempDir('lock-other-')
  const vaultId = crypto.randomBytes(8).toString('hex')
  const plain = await serve((req, res) => res.end('hello'))
  try {
    plantLock(dir, process.pid)
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: plain.address().port, nonce: 'old' }))
    const check = isServingCheck(dir, vaultId)
    assert.equal(await check(), false)
    const lock = await acquireLock(dir, { isServing: check, waitMs: 800, pollMs: 200 })
    assert.ok(lock, '引き継げる')
    assert.equal(readLock(dir).nonce, lock.nonce)
    assert.deepEqual(staleLeft(dir), [])
  } finally {
    await close(plain)
  }
})

test('isServingCheck は、状態にかかわらずVaultの印が合えば true、それ以外は false', async () => {
  const dir = tempDir('serving-')
  const vaultId = crypto.randomBytes(8).toString('hex')
  const check = isServingCheck(dir, vaultId)
  assert.equal(await check(), false, 'server.jsonがない')
  const ours = await serve((req, res) => {
    res.writeHead(401, { [VAULT_HEADER]: vaultId })
    res.end()
  })
  const other = await serve((req, res) => {
    res.writeHead(200, { [VAULT_HEADER]: 'ffffffffffffffff' })
    res.end()
  })
  try {
    const point = (server) => fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: server.address().port }))
    point(ours)
    assert.equal(await check(), true, '401でも印があればよい')
    point(other)
    assert.equal(await check(), false, '別のVault')
    const freePort = other.address().port
    await close(other)
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: freePort }))
    assert.equal(await check(), false, '応答がない')
    fs.writeFileSync(path.join(dir, 'server.json'), '{broken')
    assert.equal(await check(), false, '読めない')
  } finally {
    await close(ours)
  }
})

test('isServingCheck は応答しないポートを3秒で打ち切る', async () => {
  const dir = tempDir('serving-hang-')
  const sockets = []
  const hang = net.createServer((socket) => sockets.push(socket))
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve))
  try {
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: hang.address().port }))
    const started = Date.now()
    assert.equal(await isServingCheck(dir, 'aaaaaaaaaaaaaaaa')(), false)
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 2900 && elapsed < 4500, `${elapsed}ms`)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => hang.close(resolve))
  }
})

test('4の直前の読み直し：待っている間にロックが入れ替わったら、名前を変えずにやり直す', async () => {
  const dir = tempDir('lock-4a-')
  plantLock(dir, process.pid)
  let replaced = null
  let calls = 0
  let renames = 0
  const started = Date.now()
  // 最初の問い合わせのときに、ほかのプロセスが新しいロックを作った（持ち主は動いている）。新しい持ち主は少しあとで応答する。
  const isServing = async () => {
    calls += 1
    if (calls === 1) {
      replaced = plantLock(dir, process.pid)
      return false
    }
    return Date.now() - started > 300
  }
  const result = await acquireLock(dir, { isServing, waitMs: 500, pollMs: 100, beforeRename: () => (renames += 1) })
  assert.equal(result, null)
  assert.equal(readLock(dir).nonce, replaced, '新しいロックはそのまま')
  assert.equal(renames, 0, '入れ替わったロックの名前を変えようとしない')
  assert.deepEqual(staleLeft(dir), [])
})

test('4の名前を変えたあとの確かめ：作られたばかりのロックの名前を変えてしまったら、元に戻してやり直す', async () => {
  const dir = tempDir('lock-4c-')
  plantLock(dir, deadPid())
  let fresh = null
  const beforeRename = () => {
    // 古いと決めて読み直したあと、名前を変える前に、ほかのプロセスが引き継いで新しいロックを作った。
    if (!fresh) fresh = plantLock(dir, process.pid)
  }
  let calls = 0
  const isServing = async () => {
    calls += 1
    return true
  }
  const result = await acquireLock(dir, { isServing, beforeRename, ...FAST })
  assert.equal(result, null)
  assert.equal(readLock(dir).nonce, fresh, '新しいロックは元の名前に戻っている')
  assert.equal(calls, 1, 'やり直して、新しいロックの持ち主に問い合わせた')
  assert.deepEqual(staleLeft(dir), [])
})

test('4の名前を変えたあとの確かめ：戻したロックの持ち主が動いていなければ、やり直して引き継ぐ', async () => {
  const dir = tempDir('lock-4c-dead-')
  plantLock(dir, deadPid())
  let fresh = null
  const beforeRename = () => {
    if (!fresh) fresh = plantLock(dir, deadPid())
  }
  const lock = await acquireLock(dir, { beforeRename, ...FAST })
  assert.ok(fresh, '名前を変える直前に割り込んだ')
  assert.ok(lock)
  assert.notEqual(lock.nonce, fresh)
  assert.equal(readLock(dir).nonce, lock.nonce)
  assert.deepEqual(staleLeft(dir), [])
})

test('putBack は server.lock がないときだけ元に戻し、あれば名前を変えたほうを消す', () => {
  const dir = tempDir('putback-')
  const file = path.join(dir, 'server.lock')
  const aside = path.join(dir, 'server.lock.stale-x')
  fs.writeFileSync(aside, 'moved')
  putBack(aside, file)
  assert.equal(fs.readFileSync(file, 'utf8'), 'moved')
  assert.equal(fs.existsSync(aside), false)

  fs.writeFileSync(aside, 'moved again')
  putBack(aside, file)
  assert.equal(fs.readFileSync(file, 'utf8'), 'moved', 'あとから作られたロックを上書きしない')
  assert.equal(fs.existsSync(aside), false)

  putBack(path.join(dir, 'server.lock.stale-gone'), path.join(dir, 'other.lock'))
  assert.equal(fs.existsSync(path.join(dir, 'other.lock')), false, '消えていれば何もしない')
})

test('待っている間にロックの持ち主が終わったら、待つ時間を使い切らずに引き継ぐ', async () => {
  const dir = tempDir('lock-holder-exit-')
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], { stdio: 'ignore' })
  const exited = new Promise((resolve) => holder.once('exit', resolve))
  try {
    plantLock(dir, holder.pid)
    const started = Date.now()
    const lock = await acquireLock(dir, { waitMs: 10_000, pollMs: 100 })
    const elapsed = Date.now() - started
    assert.ok(lock)
    assert.equal(readLock(dir).nonce, lock.nonce)
    assert.ok(elapsed >= 600 && elapsed < 3000, `${elapsed}ms`)
  } finally {
    holder.kill('SIGKILL')
    await exited
  }
})

test('引き継いだあと、server.lock.stale-* が残らない（ほかの残りも片づける）', async () => {
  const dir = tempDir('lock-clean-')
  plantLock(dir, deadPid())
  fs.writeFileSync(path.join(dir, 'server.lock.stale-leftover'), '{}')
  const lock = await acquireLock(dir, FAST)
  assert.ok(lock)
  assert.deepEqual(staleLeft(dir), [])
})

test('自分のnonceでないロックは、release() しても消えない', async () => {
  const dir = tempDir('lock-release-')
  const lock = await acquireLock(dir, FAST)
  assert.ok(lock)
  const other = plantLock(dir, process.pid)
  lock.release()
  assert.equal(readLock(dir).nonce, other)
})

test('中身が読めないロックは古いものとみなして引き継ぐ', async () => {
  const dir = tempDir('lock-broken-')
  fs.writeFileSync(path.join(dir, 'server.lock'), '')
  const lock = await acquireLock(dir, FAST)
  assert.ok(lock)
  assert.equal(readLock(dir).nonce, lock.nonce)
})

test('listenOnFreePort は、ふさがっていれば次の番号を返す', async () => {
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const start = blocker.address().port
  const servers = []
  const listen = (port) =>
    new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        servers.push(server)
        resolve(server)
      })
    })
  try {
    const got = await listenOnFreePort(listen, start)
    assert.notEqual(got, start)
    assert.ok(got > start && got <= start + 20, `${got}`)
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
    for (const server of servers) await new Promise((resolve) => server.close(resolve))
  }
})

test('listenOnFreePort は範囲の外に出たら PORT_BASE に戻り、20個までしか試さない', async () => {
  const busy = (port) => Promise.reject(Object.assign(new Error(`busy ${port}`), { code: 'EADDRINUSE' }))
  const tried = []
  const last = PORT_BASE + PORT_SPAN - 1
  const got = await listenOnFreePort(async (port) => {
    tried.push(port)
    if (port !== PORT_BASE) return busy(port)
  }, last)
  assert.equal(got, PORT_BASE)
  assert.deepEqual(tried, [last, PORT_BASE])

  const all = []
  await assert.rejects(listenOnFreePort((port) => (all.push(port), busy(port)), PORT_BASE), { code: 'EADDRINUSE' })
  assert.equal(all.length, 20)
})

test('listenOnFreePort は、Windowsでは EACCES も次へ進み、ほかのエラーはそのまま返す', async () => {
  const denied = (port) => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
  const ok = (bad) => async (port) => (port === bad ? denied(port) : undefined)
  assert.equal(await listenOnFreePort(ok(47010), 47010, 'win32'), 47011)
  await assert.rejects(listenOnFreePort(ok(47010), 47010, 'darwin'), { code: 'EACCES' })
  await assert.rejects(listenOnFreePort(() => Promise.reject(new Error('boom')), 47010, 'win32'), /boom/)
})

// --- 実際に起動して確かめる ---

function start(args, extra = {}) {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...extra })
  child.out = ''
  child.stdout.on('data', (chunk) => (child.out += chunk))
  child.stderr.on('data', (chunk) => (child.out += chunk))
  child.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  return child
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await sleep(100)
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function killAll(children) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(children.map((child) => child.exited))
}

test('同じVaultで3つ同時に起動すると、1つだけが動き続け、ほかは75で終わる。強制終了のあとは引き継げる', { timeout: 90_000 }, async () => {
  const root = tempDir('inst-root-')
  const stateDir = path.join(tempDir('inst-state-'), 'state')
  const vaultId = vaultIdOf(canonicalRoot(root))
  const vaultDir = vaultDirOf(stateDir, vaultId)
  const children = []
  try {
    const t0 = Date.now()
    for (let i = 0; i < 3; i++) children.push(start(['--root', root, '--state-dir', stateDir]))
    const ends = new Map()
    for (const child of children) child.exited.then((end) => ends.set(child, end))
    await waitFor(() => ends.size >= 2, 40_000, `two exits: ${children.map((c) => c.out).join('\n')}`)
    await sleep(1000)
    assert.equal(ends.size, 2, '1つは動き続ける')
    for (const end of ends.values()) assert.deepEqual(end, { code: ALREADY_RUNNING, signal: null })
    const survivor = children.find((child) => !ends.has(child))
    console.log(`3つ同時起動: ${Date.now() - t0}ms`)
    const info = await waitFor(() => readJson(path.join(vaultDir, 'server.json')), 10_000, 'server.json')
    assert.equal(info.pid, survivor.pid)
    assert.equal(info.nonce, readLock(vaultDir).nonce)
    assert.ok(info.port >= PORT_BASE && info.port < PORT_BASE + PORT_SPAN)
    const health = await fetch(`http://127.0.0.1:${info.port}/api/health`)
    assert.equal(health.status, 401)
    assert.equal(health.headers.get(VAULT_HEADER), vaultId)

    survivor.kill('SIGKILL')
    await survivor.exited
    assert.ok(fs.existsSync(path.join(vaultDir, 'server.lock')), '強制終了ではロックが残る')
    const t1 = Date.now()
    const next = start(['--root', root, '--state-dir', stateDir])
    children.push(next)
    const nextInfo = await waitFor(() => {
      const data = readJson(path.join(vaultDir, 'server.json'))
      return data?.pid === next.pid ? data : null
    }, 20_000, 'takeover')
    console.log(`強制終了のあとの引き継ぎ: ${Date.now() - t1}ms`)
    assert.equal(readLock(vaultDir).pid, next.pid)
    const again = await fetch(`http://127.0.0.1:${nextInfo.port}/api/health`)
    assert.equal(again.headers.get(VAULT_HEADER), vaultId)
    assert.deepEqual(staleLeft(vaultDir), [])

    next.kill('SIGTERM')
    await next.exited
    assert.equal(fs.existsSync(path.join(vaultDir, 'server.lock')), false, '普通に終わればロックを消す')
    assert.equal(readJson(path.join(vaultDir, 'server.json')).token, nextInfo.token, '合言葉を使い続けるため、server.jsonは残す')

    // 止めたあとに残ったserver.jsonのポートは答えないので、次の起動はすぐに動き出す。
    const t2 = Date.now()
    const third = start(['--root', root, '--state-dir', stateDir])
    children.push(third)
    const thirdInfo = await waitFor(() => {
      const data = readJson(path.join(vaultDir, 'server.json'))
      return data?.pid === third.pid ? data : null
    }, 10_000, 'restart after stop')
    console.log(`普通に止めたあとの起動: ${Date.now() - t2}ms`)
    assert.equal(thirdInfo.token, nextInfo.token, '同じポートとVaultなら同じ合言葉')
  } finally {
    await killAll(children)
  }
})

test('合言葉なしの2つ目の起動も、1つ目が動いているのに気づいてすぐ75で終わる', { timeout: 30_000 }, async () => {
  const root = tempDir('inst-open-root-')
  const stateDir = path.join(tempDir('inst-open-state-'), 'state')
  const vaultId = vaultIdOf(canonicalRoot(root))
  const vaultDir = vaultDirOf(stateDir, vaultId)
  const first = start(['--root', root, '--state-dir', stateDir, '--no-token'])
  const children = [first]
  try {
    const info = await waitFor(() => {
      const data = readJson(path.join(vaultDir, 'server.json'))
      return data?.pid === first.pid ? data : null
    }, 15_000, 'start')
    assert.equal(info.token, null)
    assert.equal(info.nonce, readLock(vaultDir).nonce)
    const t0 = Date.now()
    const second = start(['--root', root, '--state-dir', stateDir, '--no-token'])
    children.push(second)
    assert.deepEqual(await second.exited, { code: ALREADY_RUNNING, signal: null })
    const elapsed = Date.now() - t0
    console.log(`合言葉なしの2つ目: ${elapsed}ms`)
    assert.ok(elapsed < 5000, `${elapsed}ms`)
    assert.equal(first.exitCode, null, '1つ目は動き続ける')
    assert.equal(readJson(path.join(vaultDir, 'server.json')).pid, first.pid)
  } finally {
    await killAll(children)
  }
})

async function freePort() {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal}で普通に止めて、同じポートで起動し直すと、同じ合言葉を使う`, { timeout: 30_000 }, async () => {
    const root = tempDir('inst-keep-root-')
    const stateDir = path.join(tempDir('inst-keep-state-'), 'state')
    const vaultDir = vaultDirOf(stateDir, vaultIdOf(canonicalRoot(root)))
    const port = String(await freePort())
    const children = []
    const run = async () => {
      const child = start(['--root', root, '--state-dir', stateDir, '--port', port])
      children.push(child)
      const info = await waitFor(() => {
        const data = readJson(path.join(vaultDir, 'server.json'))
        return data?.pid === child.pid ? data : null
      }, 15_000, 'start')
      return { child, info }
    }
    try {
      const first = await run()
      first.child.kill(signal)
      assert.deepEqual(await first.child.exited, { code: signal === 'SIGTERM' ? 143 : 130, signal: null })
      assert.equal(fs.existsSync(path.join(vaultDir, 'server.lock')), false)
      const second = await run()
      assert.equal(second.info.token, first.info.token)
      const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'x-note-token': first.info.token } })
      assert.equal(health.status, 200, '開いているタブの合言葉がそのまま使える')
    } finally {
      await killAll(children)
    }
  })
}

test('終わるとき、自分のものでないロックとserver.jsonは消さない', { timeout: 30_000 }, async () => {
  const root = tempDir('inst-own-root-')
  const stateDir = path.join(tempDir('inst-own-state-'), 'state')
  const vaultDir = vaultDirOf(stateDir, vaultIdOf(canonicalRoot(root)))
  const child = start(['--root', root, '--state-dir', stateDir, '--port', '0'])
  try {
    await waitFor(() => readJson(path.join(vaultDir, 'server.json'))?.pid === child.pid, 15_000, 'start')
    fs.writeFileSync(path.join(vaultDir, 'server.lock'), JSON.stringify({ pid: 1, startedAt: 0, nonce: 'other' }))
    fs.writeFileSync(path.join(vaultDir, 'server.json'), JSON.stringify({ port: 1, nonce: 'other' }))
    child.kill('SIGINT')
    await child.exited
    assert.equal(readJson(path.join(vaultDir, 'server.lock')).nonce, 'other')
    assert.equal(readJson(path.join(vaultDir, 'server.json')).nonce, 'other')
  } finally {
    await killAll([child])
  }
})

test('--port を付けるとその番号だけを使い、healthのportMovedは false', { timeout: 30_000 }, async () => {
  const root = tempDir('inst-port-root-')
  const stateDir = path.join(tempDir('inst-port-state-'), 'state')
  const vaultDir = vaultDirOf(stateDir, vaultIdOf(canonicalRoot(root)))
  const child = start(['--root', root, '--state-dir', stateDir, '--port', '0'])
  try {
    const info = await waitFor(() => {
      const data = readJson(path.join(vaultDir, 'server.json'))
      return data?.pid === child.pid ? data : null
    }, 15_000, 'start')
    const health = await (await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { 'x-note-token': info.token } })).json()
    assert.equal(health.portMoved, false)
    assert.deepEqual(health.settingsErrors, [])
  } finally {
    await killAll([child])
  }
})

test('決まった番号がふさがっていれば次へ移り、healthのportMovedが true になる', { timeout: 30_000 }, async () => {
  const root = tempDir('inst-moved-root-')
  const stateDir = path.join(tempDir('inst-moved-state-'), 'state')
  const vaultId = vaultIdOf(canonicalRoot(root))
  const vaultDir = vaultDirOf(stateDir, vaultId)
  const blocker = net.createServer()
  const blocked = await new Promise((resolve) => {
    blocker.once('error', () => resolve(false))
    blocker.listen(preferredPort(vaultId), '127.0.0.1', () => resolve(true))
  })
  const child = start(['--root', root, '--state-dir', stateDir])
  try {
    const info = await waitFor(() => {
      const data = readJson(path.join(vaultDir, 'server.json'))
      return data?.pid === child.pid ? data : null
    }, 15_000, 'start')
    assert.notEqual(info.port, preferredPort(vaultId))
    const health = await (await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { 'x-note-token': info.token } })).json()
    assert.equal(health.portMoved, true, `blocked by test: ${blocked}`)
  } finally {
    await killAll([child])
    if (blocker.listening) await new Promise((resolve) => blocker.close(resolve))
  }
})

test('--print-vault-id は16文字を出して0で終わり、保存フォルダーを作らない', { timeout: 15_000 }, async () => {
  const root = tempDir('inst-id-root-')
  const stateDir = path.join(tempDir('inst-id-state-'), 'state')
  const child = start(['--root', root, '--state-dir', stateDir, '--print-vault-id'])
  const end = await child.exited
  assert.deepEqual(end, { code: 0, signal: null })
  assert.equal(child.out.trim(), vaultIdOf(canonicalRoot(root)))
  assert.match(child.out.trim(), /^[0-9a-f]{16}$/)
  assert.equal(fs.existsSync(stateDir), false)
})

test('Vaultにできない場所（/）は2で終わる', { timeout: 15_000 }, async () => {
  const stateDir = path.join(tempDir('inst-refused-'), 'state')
  const child = start(['--root', '/', '--state-dir', stateDir])
  const end = await child.exited
  assert.deepEqual(end, { code: 2, signal: null })
  assert.equal(fs.existsSync(stateDir), false)
})

test('起動するとVault別フォルダーにroot.txtを作り、バックアップは<state-dir>/backupsに置く', { timeout: 30_000 }, async () => {
  const root = tempDir('inst-files-root-')
  fs.writeFileSync(path.join(root, 'a.md'), 'one\n')
  const stateDir = path.join(tempDir('inst-files-state-'), 'state')
  const vaultId = vaultIdOf(canonicalRoot(root))
  const vaultDir = vaultDirOf(stateDir, vaultId)
  const child = start(['--root', root, '--state-dir', stateDir, '--port', '0'])
  try {
    const info = await waitFor(() => {
      const data = readJson(path.join(vaultDir, 'server.json'))
      return data?.pid === child.pid ? data : null
    }, 15_000, 'start')
    assert.equal(fs.readFileSync(path.join(vaultDir, 'root.txt'), 'utf8'), `${canonicalRoot(root)}\n`)
    const base = `http://127.0.0.1:${info.port}`
    const headers = { 'x-note-token': info.token, 'x-note-editor': '1', 'content-type': 'application/json' }
    const note = await (await fetch(`${base}/api/note?path=a.md`, { headers })).json()
    const put = await fetch(`${base}/api/note?path=a.md`, { method: 'PUT', headers, body: JSON.stringify({ text: 'two\n', baseHash: note.hash }) })
    assert.equal(put.status, 200)
    assert.ok(fs.existsSync(path.join(stateDir, 'backups', vaultId)), 'バックアップの場所')
  } finally {
    await killAll([child])
  }
})

// 起動元（sh）の下でサーバーを起動し、起動の途中で起動元を強制終了する。サーバーのプロセス番号を返す。
async function startUnderDoomedParent(args, killAfterMs) {
  const dir = tempDir('inst-parent-')
  const pidFile = path.join(dir, 'pid')
  const quoted = [process.execPath, MAIN, ...args].map((arg) => `'${arg}'`).join(' ')
  const sh = spawn('sh', ['-c', `${quoted} & echo $! > '${pidFile}'; wait`], { stdio: 'ignore' })
  const pid = await waitFor(() => {
    const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : ''
    return text ? Number(text) : null
  }, 5_000, 'server pid')
  await sleep(killAfterMs)
  sh.kill('SIGKILL')
  return pid
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

test('起動の途中で起動元が終わっても、起動し終えたサーバーは10秒以内に終わり、ロックとポートを手放す', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const root = tempDir('inst-orphan-root-')
  const stateDir = path.join(tempDir('inst-orphan-state-'), 'state')
  const vaultDir = vaultDirOf(stateDir, vaultIdOf(canonicalRoot(root)))
  const pid = await startUnderDoomedParent(['--root', root, '--state-dir', stateDir, '--watch-parent', '--no-token'], 400)
  try {
    const info = await waitFor(() => {
      const data = readJson(path.join(vaultDir, 'server.json'))
      return data?.pid === pid ? data : !alive(pid) ? { gone: true } : null
    }, 10_000, 'server.json')
    await waitFor(() => !alive(pid), 10_000, 'server exits after launcher died')
    assert.equal(fs.existsSync(path.join(vaultDir, 'server.lock')), false, 'ロックを手放す')
    if (info.port) await assert.rejects(fetch(`http://127.0.0.1:${info.port}/api/health`), 'ポートを手放す')
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
})

test('ロックを待っている間に起動元が終わっても、待ち終わるのを待たずに10秒以内に終わる', { skip: process.platform === 'win32', timeout: 40_000 }, async () => {
  const root = tempDir('inst-orphan-wait-root-')
  const stateDir = path.join(tempDir('inst-orphan-wait-state-'), 'state')
  const vaultDir = vaultDirOf(stateDir, vaultIdOf(canonicalRoot(root)))
  fs.mkdirSync(vaultDir, { recursive: true })
  // 動いているが答えない持ち主。サーバーはロックを最大25秒待つ。
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  const nonce = plantLock(vaultDir, holder.pid)
  let pid = null
  try {
    pid = await startUnderDoomedParent(['--root', root, '--state-dir', stateDir, '--watch-parent', '--no-token'], 400)
    const t0 = Date.now()
    await waitFor(() => !alive(pid), 10_000, 'server exits while waiting for the lock')
    console.log(`ロック待ちの間に起動元が終わってから: ${Date.now() - t0}ms`)
    assert.equal(readLock(vaultDir).nonce, nonce, '持ち主のロックには触らない')
    assert.notEqual(readJson(path.join(vaultDir, 'server.json'))?.pid, pid)
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    holder.kill('SIGKILL')
  }
})

test('--root のフォルダーがない・フォルダーでない・読めないとき、--port が0〜65535の整数でないときは、1行だけ出して2で終わる', { timeout: 30_000 }, async () => {
  const base = tempDir('inst-args-')
  const stateDir = path.join(base, 'state')
  const root = path.join(base, 'vault')
  fs.mkdirSync(root)
  const file = path.join(base, 'file.md')
  fs.writeFileSync(file, 'x')
  const locked = path.join(base, 'locked')
  fs.mkdirSync(locked)
  fs.chmodSync(locked, 0o000)
  const cases = [
    ['--root', path.join(base, 'ない')],
    ['--root', file],
    ['--root', root, '--port', 'abc'],
    ['--root', root, '--port', '1.5'],
    ['--root', root, '--port', '-1'],
    ['--root', root, '--port', '65536'],
    ['--root', root, '--port', ''],
  ]
  if (process.platform !== 'win32' && process.getuid?.() !== 0) cases.push(['--root', locked])
  try {
    for (const args of cases) {
      const child = start([...args, '--state-dir', stateDir])
      const end = await child.exited
      assert.deepEqual(end, { code: 2, signal: null }, `${args.join(' ')}: ${child.out}`)
      const lines = child.out.trim().split('\n')
      assert.equal(lines.length, 1, `${args.join(' ')}: ${child.out}`)
      assert.doesNotMatch(child.out, /\n\s+at /, 'スタックトレースを出さない')
    }
    assert.equal(fs.existsSync(stateDir), false)
  } finally {
    fs.chmodSync(locked, 0o700)
  }
})

// --- 止める指示と、新しいバージョンへの引き渡し ---

const NOTE_HEADERS = { 'x-note-editor': '1' }

async function startWithInfo(root, stateDir, vaultDir, extra = []) {
  const child = start(['--root', root, '--state-dir', stateDir, ...extra])
  const info = await waitFor(() => {
    const i = readJson(path.join(vaultDir, 'server.json'))
    return i && i.pid === child.pid ? i : null
  }, 20_000, `server.json: ${child.out}`)
  return { child, info, base: `http://127.0.0.1:${info.port}` }
}

function shutdownSetup() {
  const root = tempDir('shut-root-')
  fs.writeFileSync(path.join(root, 'a.md'), 'before\n')
  const stateDir = path.join(tempDir('shut-state-'), 'state')
  const vaultDir = vaultDirOf(stateDir, vaultIdOf(canonicalRoot(root)))
  return { root, stateDir, vaultDir }
}

test('どの応答にも x-notedock-version が付く（401 と 404 でも）', { timeout: 60_000 }, async () => {
  const { root, stateDir, vaultDir } = shutdownSetup()
  const children = []
  try {
    const { child, info, base } = await startWithInfo(root, stateDir, vaultDir)
    children.push(child)
    const withToken = { ...NOTE_HEADERS, 'x-note-token': info.token }
    const cases = [
      [`${base}/api/health`, {}, 401],
      [`${base}/api/health`, withToken, 200],
      [`${base}/api/nothing`, withToken, 404],
      [`${base}/nothing.js`, {}, 404],
      [`${base}/api/health?root=zzz`, { ...withToken, 'x-note-root': 'zzz' }, 412],
      [`${base}/api/health`, { origin: 'http://evil.example' }, 403],
    ]
    for (const [url, headers, status] of cases) {
      const res = await fetch(url, { headers })
      assert.equal(res.status, status, url)
      assert.equal(res.headers.get(VERSION_HEADER), SERVER_VERSION, `${status}`)
    }
  } finally {
    await killAll(children)
  }
})

test('POST /api/shutdown は合言葉・x-note-editor: 1・より新しいバージョンがそろえば 204 を返し、handover.json を書き、0 で終わり、ロックが外れる', { timeout: 60_000 }, async () => {
  const { root, stateDir, vaultDir } = shutdownSetup()
  const children = []
  try {
    const { child, info, base } = await startWithInfo(root, stateDir, vaultDir)
    children.push(child)
    const t0 = Date.now()
    const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { ...NOTE_HEADERS, 'x-note-token': info.token, [VERSION_HEADER]: '0.1.0' } })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get(VERSION_HEADER), SERVER_VERSION)
    assert.deepEqual(await child.exited, { code: 0, signal: null })
    const handover = readJson(path.join(vaultDir, 'handover.json'))
    assert.equal(handover.to, '0.1.0')
    assert.ok(handover.at >= t0 - 1000 && handover.at <= Date.now())
    assert.equal(fs.existsSync(path.join(vaultDir, 'server.lock')), false, 'ロックが外れている')
    assert.ok(!JSON.stringify(handover).includes(info.token))
  } finally {
    await killAll(children)
  }
})

test('POST /api/shutdown は、指示を送った側のバージョンが同じか古ければ 409 で、止まらない', { timeout: 60_000 }, async () => {
  const { root, stateDir, vaultDir } = shutdownSetup()
  const children = []
  try {
    const { child, info, base } = await startWithInfo(root, stateDir, vaultDir)
    children.push(child)
    for (const v of [SERVER_VERSION, '0.0.0-alpha']) {
      const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { ...NOTE_HEADERS, 'x-note-token': info.token, [VERSION_HEADER]: v } })
      assert.equal(res.status, 409, v)
    }
    // 版が無い・形が違うときは 400
    for (const v of [undefined, 'new', '1.0']) {
      const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { ...NOTE_HEADERS, 'x-note-token': info.token, ...(v ? { [VERSION_HEADER]: v } : {}) } })
      assert.equal(res.status, 400, String(v))
    }
    await sleep(500)
    assert.equal(child.exitCode, null)
    assert.equal(fs.existsSync(path.join(vaultDir, 'handover.json')), false)
    assert.equal((await fetch(`${base}/api/health`, { headers: { ...NOTE_HEADERS, 'x-note-token': info.token } })).status, 200)
  } finally {
    await killAll(children)
  }
})

test('POST /api/shutdown は合言葉がなければ 401、x-note-editor がなければ 403、よそのサイトからは 403、--no-token のときは 403 で、止まらない', { timeout: 60_000 }, async () => {
  const { root, stateDir, vaultDir } = shutdownSetup()
  const children = []
  try {
    const a = await startWithInfo(root, stateDir, vaultDir)
    children.push(a.child)
    const newer = { [VERSION_HEADER]: '0.1.0' }
    const post = (headers) => fetch(`${a.base}/api/shutdown`, { method: 'POST', headers })
    assert.equal((await post({ ...NOTE_HEADERS, ...newer })).status, 401)
    assert.equal((await post({ ...NOTE_HEADERS, ...newer, 'x-note-token': 'x'.repeat(43) })).status, 401)
    assert.equal((await post({ 'x-note-token': a.info.token, ...newer })).status, 403)
    assert.equal((await post({ ...NOTE_HEADERS, 'x-note-token': a.info.token, ...newer, origin: 'http://evil.example' })).status, 403)
    assert.equal((await post({ ...NOTE_HEADERS, 'x-note-token': a.info.token, ...newer, 'sec-fetch-site': 'cross-site' })).status, 403)
    // GET では止まらない
    assert.equal((await fetch(`${a.base}/api/shutdown`, { headers: { ...NOTE_HEADERS, 'x-note-token': a.info.token, ...newer } })).status, 404)
    await sleep(500)
    assert.equal(a.child.exitCode, null, '止まらない')
    assert.equal(fs.existsSync(path.join(vaultDir, 'handover.json')), false)
  } finally {
    await killAll(children)
  }
  // --no-token（別のVault）
  const b = shutdownSetup()
  try {
    const n = await startWithInfo(b.root, b.stateDir, b.vaultDir, ['--no-token'])
    children.push(n.child)
    const res = await fetch(`${n.base}/api/shutdown`, { method: 'POST', headers: { ...NOTE_HEADERS, [VERSION_HEADER]: '0.1.0' } })
    assert.equal(res.status, 403)
    await sleep(500)
    assert.equal(n.child.exitCode, null)
  } finally {
    await killAll(children)
  }
})

test('止まる前に、受け付けていた保存を書き終える', { timeout: 60_000 }, async () => {
  const { root, stateDir, vaultDir } = shutdownSetup()
  const children = []
  try {
    const { child, info, base } = await startWithInfo(root, stateDir, vaultDir)
    children.push(child)
    const headers = { ...NOTE_HEADERS, 'x-note-token': info.token }
    const note = await (await fetch(`${base}/api/note?path=a.md`, { headers })).json()
    const body = JSON.stringify({ text: 'after shutdown request\n', baseHash: note.hash })
    // 本文を途中まで送った保存（受け付けたが、まだ書いていない）
    let req
    const saving = new Promise((resolve, reject) => {
      req = http.request({ host: '127.0.0.1', port: info.port, path: '/api/note?path=a.md', method: 'PUT', headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.write(body.slice(0, 10))
    })
    await sleep(300)
    const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { ...headers, [VERSION_HEADER]: '0.1.0' } })
    assert.equal(res.status, 204)
    // 止める指示のあとに来た新しい保存は 503 で、ファイルは変わらない
    const late = await fetch(`${base}/api/note?path=a.md`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'late\n', baseHash: note.hash }) }).then((r) => r.status, () => 'refused')
    assert.ok(late === 503 || late === 'refused', String(late))
    assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'before\n')
    await sleep(500)
    assert.equal(child.exitCode, null, '保存が終わるまで止まらない')
    req.end(body.slice(10))
    const status = await saving
    assert.equal(status, 200)
    assert.deepEqual(await child.exited, { code: 0, signal: null })
    assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'after shutdown request\n')
    assert.ok(readJson(path.join(vaultDir, 'handover.json')))
  } finally {
    await killAll(children)
  }
})

// プロセスを起動せず、createApp に記録用の onShutdown を渡して動かす。終わったら closeApp で必ず閉じる。
async function startAppWithMock() {
  const { root, stateDir, vaultDir } = shutdownSetup()
  const calls = []
  const server = await createApp({ root, backupDir: path.join(stateDir, 'backups'), stateDir, vaultDir, onShutdown: (arg) => { calls.push(arg) } }).listen(0)
  const { port, token } = readJson(path.join(vaultDir, 'server.json'))
  return { root, server, port, token, calls, headers: { ...NOTE_HEADERS, 'x-note-token': token } }
}

function closeApp(server) {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

test('停止リクエストに 204 を返したあと、レスポンスを先に壊しても、onShutdown が1回だけ呼ばれる', { timeout: 30_000 }, async () => {
  const app = await startAppWithMock()
  try {
    const socket = net.connect(app.port, '127.0.0.1')
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const head = new Promise((resolve) => {
      socket.once('data', (chunk) => {
        // 204 の最初の行が届いた直後に、こちらからソケットを壊す
        socket.destroy()
        resolve(chunk.toString('latin1'))
      })
    })
    socket.write([
      'POST /api/shutdown HTTP/1.1',
      `host: 127.0.0.1:${app.port}`,
      'x-note-editor: 1',
      `x-note-token: ${app.token}`,
      `${VERSION_HEADER}: 0.1.0`,
      'content-length: 0',
      '',
      '',
    ].join('\r\n'))
    assert.match(await head, /^HTTP\/1\.1 204 /)
    await waitFor(() => app.calls.length > 0, SHUTDOWN_FALLBACK_MS + 1000, 'onShutdown が呼ばれない')
    await sleep(300)
    assert.deepEqual(app.calls, [{ to: '0.1.0' }])
  } finally {
    await closeApp(app.server)
  }
})

test('停止処理の途中に来た2回目の停止リクエストは 503 を返し、onShutdown は1回だけ', { timeout: 30_000 }, async () => {
  const app = await startAppWithMock()
  try {
    const base = `http://127.0.0.1:${app.port}`
    const note = await (await fetch(`${base}/api/note?path=a.md`, { headers: app.headers })).json()
    const body = JSON.stringify({ text: 'after shutdown request\n', baseHash: note.hash })
    // 本文を途中まで送った保存で、止める処理を引き延ばす
    let req
    const saving = new Promise((resolve, reject) => {
      req = http.request({ host: '127.0.0.1', port: app.port, path: '/api/note?path=a.md', method: 'PUT', headers: { ...app.headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.write(body.slice(0, 10))
    })
    await sleep(300)
    const first = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { ...app.headers, [VERSION_HEADER]: '0.1.0' } })
    assert.equal(first.status, 204)
    const second = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { ...app.headers, [VERSION_HEADER]: '0.2.0' } })
    assert.equal(second.status, 503)
    // 予備のタイマーの時間を過ぎても、保存が終わるまでは止める処理の最後（onShutdown）へ進まない
    await sleep(SHUTDOWN_FALLBACK_MS + 300)
    assert.deepEqual(app.calls, [], '保存が終わるまで onShutdown を呼ばない')
    req.end(body.slice(10))
    assert.equal(await saving, 200)
    await waitFor(() => app.calls.length > 0, 5_000, 'onShutdown が呼ばれない')
    await sleep(SHUTDOWN_FALLBACK_MS + 300)
    assert.deepEqual(app.calls, [{ to: '0.1.0' }])
    assert.equal(fs.readFileSync(path.join(app.root, 'a.md'), 'utf8'), 'after shutdown request\n')
  } finally {
    await closeApp(app.server)
  }
})

test('起動のとき handover.json が自分より新しいバージョンを指し、10分たっていなければ 76 で終わる。10分たっていれば起動する', { timeout: 60_000 }, async () => {
  const { root, stateDir, vaultDir } = shutdownSetup()
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
  const file = path.join(vaultDir, 'handover.json')
  const children = []
  try {
    // 新しい版に譲った直後 → 76。ロックも残さない。
    fs.writeFileSync(file, JSON.stringify({ to: '0.1.0', at: Date.now() - 60_000 }))
    const a = start(['--root', root, '--state-dir', stateDir])
    children.push(a)
    assert.deepEqual(await a.exited, { code: HANDOVER_EXIT, signal: null })
    assert.equal(fs.existsSync(path.join(vaultDir, 'server.lock')), false)
    // 自分と同じか古い版に譲った記録、壊れた記録は無視して起動する
    for (const text of [JSON.stringify({ to: SERVER_VERSION, at: Date.now() }), '{broken', JSON.stringify({ to: 'zzz', at: Date.now() }), JSON.stringify({ to: '0.1.0' }), JSON.stringify({ to: '0.1.0', at: Date.now() + 60 * 60_000 })]) {
      fs.writeFileSync(file, text)
      const c = start(['--root', root, '--state-dir', stateDir])
      children.push(c)
      await waitFor(() => /NoteDock: http/.test(c.out), 20_000, `start: ${c.out}`)
      assert.equal(c.exitCode, null)
      await killAll([c])
    }
    // 10分たっていれば起動する
    fs.writeFileSync(file, JSON.stringify({ to: '0.1.0', at: Date.now() - 10 * 60_000 - 1000 }))
    const b = start(['--root', root, '--state-dir', stateDir])
    children.push(b)
    await waitFor(() => /NoteDock: http/.test(b.out), 20_000, `start: ${b.out}`)
    assert.equal(b.exitCode, null)
  } finally {
    await killAll(children)
  }
})
