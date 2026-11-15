// 1つのVaultで、サーバーを1つだけ動かす。ロック（server.lock）と、Vaultから決まるポート番号。
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { VAULT_HEADER } from './config.mjs'
import { renameWithRetry } from './durable.mjs'
import { isAlive } from './platform.mjs'

// 「もう動いている」の終了コード。Windowsで強制終了されたときの1とかぶらない。
export const ALREADY_RUNNING = 75
export const PORT_BASE = 47000
export const PORT_SPAN = 1000

const LOCK = 'server.lock'
const STALE_PREFIX = `${LOCK}.stale-`
const SETTLE_MS = 500
const RETRIES = 3
const HEALTH_TIMEOUT_MS = 3000
const PORT_TRIES = 20

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function preferredPort(vaultId) {
  return PORT_BASE + (parseInt(vaultId.slice(0, 8), 16) % PORT_SPAN)
}

// 起動情報のファイルにあるポートへhealthを1回たずね、このVaultのNoteDockが答えるかを見る。応答の状態は問わない。
export function isServingCheck(vaultDir, vaultId) {
  return () =>
    new Promise((resolve) => {
      let port
      try {
        port = JSON.parse(fs.readFileSync(path.join(vaultDir, 'server.json'), 'utf8')).port
      } catch {
        return resolve(false)
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) return resolve(false)
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
        res.resume()
        finish(res.headers[VAULT_HEADER] === vaultId)
        req.destroy()
      })
      req.on('error', () => finish(false))
      const timer = setTimeout(() => {
        finish(false)
        req.destroy()
      }, HEALTH_TIMEOUT_MS)
    })
}

// 読めないとき（ない、Windowsで名前を変えている途中など）は null。どの場面でも「やり直す」か「あきらめる」になる。
// 中身が壊れていれば data は null（書いている途中か、壊れたファイル）。
function readLock(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { text, data }
}

// 古いと決めたロックを見分ける値。壊れたファイルは中身そのもので比べる。
const identityOf = (seen) => (typeof seen?.data?.nonce === 'string' ? `nonce:${seen.data.nonce}` : `raw:${seen?.text}`)
const nonceOf = (file) => readLock(file)?.data?.nonce

function tryCreate(file, body) {
  try {
    fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
}

function removeStaleCopies(vaultDir) {
  for (const name of fs.readdirSync(vaultDir)) {
    if (name.startsWith(STALE_PREFIX)) fs.rmSync(path.join(vaultDir, name), { force: true })
  }
}

// 名前を変えてしまったほかのロックを、server.lock がまだないときだけ元に戻す。もうあれば、名前を変えたほうを消す。
// テストから直接確かめられるよう export する。
export function putBack(aside, file) {
  try {
    fs.linkSync(aside, file)
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOENT') {
      // 固いリンクを作れないディスク（FAT、一部のネットワークドライブ）では、ないことを確かめてから名前を戻す。確かめてから戻すまでの間はすき間があるが、持ち主の読み直しで1つに収まる。
      if (!fs.existsSync(file)) {
        try {
          renameWithRetry(aside, file)
          return
        } catch {
          // 戻せなければ消す。持ち主は読み直しで気づき、あきらめる。
        }
      }
    }
  }
  fs.rmSync(aside, { force: true })
}

// 取れたら { nonce, release() }、ほかのサーバーが動いているか取り合いに負けたら null。
// now はテストで時刻を決めるためのもの（startedAt と待つ時間の計算に使う）。
// beforeRename はテスト用の差し込み口。名前を変える直前に呼ぶ（ほかのプロセスが割り込む場面を作るため）。
export async function acquireLock(vaultDir, { pid = process.pid, isServing = async () => false, now = Date.now, waitMs = 25000, pollMs = 2000, beforeRename = () => {} } = {}) {
  const file = path.join(vaultDir, LOCK)
  const nonce = crypto.randomBytes(16).toString('hex')
  const body = JSON.stringify({ pid, startedAt: now(), nonce })
  const held = {
    nonce,
    release() {
      try {
        if (nonceOf(file) === nonce) fs.rmSync(file, { force: true })
      } catch {
        // 終わるときの片づけなので、失敗しても止めない。
      }
    },
  }
  // 作ってから少し待って読み直す。同時に引き継いだほかのプロセスに上書きされていたら、あきらめる。
  const settled = async () => {
    await sleep(SETTLE_MS)
    return nonceOf(file) === nonce ? held : null
  }

  for (let redo = 0; redo <= RETRIES; redo += 1) {
    // 1. ロックがなければ作る。
    if (tryCreate(file, body)) return settled()

    // 2・3. あれば中身を読み、古いかどうかを決める。
    const seen = readLock(file)
    if (!seen) continue
    const holder = seen.data?.pid
    const stale = identityOf(seen)
    const holderAlive = () => Number.isInteger(holder) && holder > 0 && isAlive(holder)
    if (holderAlive()) {
      // 起動の途中や、ごみ箱へ移す処理で一時的に答えないサーバーを、止まったと見なさないよう待つ。
      // 持ち主が終わったか、ロックが入れ替わったら、待つのをやめて下の確かめに進む（4の読み直しで安全に分かれる）。
      const deadline = now() + waitMs
      for (;;) {
        if (await isServing()) return null
        if (now() >= deadline) break
        await sleep(pollMs)
        const current = readLock(file)
        if (!current || identityOf(current) !== stale || !holderAlive()) break
      }
    }

    // 4. 古いロックを引き継ぐ。
    const before = readLock(file)
    if (!before || identityOf(before) !== stale) continue
    const aside = path.join(vaultDir, `${STALE_PREFIX}${nonce}`)
    beforeRename()
    try {
      renameWithRetry(file, aside)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const moved = readLock(aside)
    if (!moved || identityOf(moved) !== stale) {
      // ほかのプロセスが作ったばかりのロックの名前を変えてしまった。
      putBack(aside, file)
      continue
    }
    removeStaleCopies(vaultDir)
    if (!tryCreate(file, body)) continue
    return settled()
  }
  return null
}

// start から順に試し、ふさがっていれば次の番号へ。範囲の外に出たら PORT_BASE に戻る。
export async function listenOnFreePort(listen, start, platform = process.platform) {
  const end = PORT_BASE + PORT_SPAN
  let lastError
  for (let i = 0; i < PORT_TRIES; i += 1) {
    let port = start + i
    if (start < end && port >= end) port -= PORT_SPAN
    try {
      await listen(port)
      return port
    } catch (error) {
      // Windowsでは、予約されたポートの範囲に当たると EACCES になる。
      const busy = error.code === 'EADDRINUSE' || (platform === 'win32' && error.code === 'EACCES')
      if (!busy) throw error
      lastError = error
    }
  }
  throw lastError
}
