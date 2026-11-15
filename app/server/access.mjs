import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { renameWithRetry } from './durable.mjs'
import { ownerOnly } from './platform.mjs'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const digest = (value) => crypto.createHash('sha256').update(value).digest()

export function sameToken(given, expected) {
  return typeof given === 'string' && crypto.timingSafeEqual(digest(given), digest(expected))
}

// 画面に出る画像のURLに付ける鍵。コピーされても、画像を読むことにしか使えない。
export function fileKeyOf(token) {
  return digest(`file:${token}`).toString('base64url')
}

// ほかの人が読めるファイルやシンボリックリンクの中身は、合言葉として信用しない。
// 合言葉を使い回すのは、Vaultの場所とポートの両方が同じときだけ。
function reusableToken(file, root, port) {
  try {
    if (!ownerOnly(file)) return null
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return saved.root === root && saved.port === port && TOKEN_RE.test(saved.token) ? saved.token : null
  } catch {
    return null
  }
}

// 起動情報のファイル。Vault別フォルダーに1つだけ置く。
const accessFile = (vaultDir) => path.join(vaultDir, 'server.json')
const newSecret = () => crypto.randomBytes(32).toString('base64url')

// 本人だけが読めるファイルを、途中の状態を見せずに置き換える。
// Modやウイルス対策ソフトが読んでいても失敗しにくいよう、差し替えは renameWithRetry で行う。
function writeAccess(vaultDir, data) {
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
  const file = accessFile(vaultDir)
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}`
  fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' })
  try {
    renameWithRetry(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

// 起動し直すたびに変えると開いているタブの保存が止まるので、同じポートとVaultなら同じ合言葉を使う。
// プロセス番号は毎回書き直す。Modが、ポートを使っているのが本物のサーバーか確かめるのに使う。
// nonce はロック（server.lock）と同じ値。どのロックの持ち主が書いたかが分かる。終わってもこのファイルは消さない（合言葉を使い続けるため）。
// リンク用の鍵は、チャットの記録に残るので合言葉と分ける。一度使うか時間が経つと変える。
export function createAccess(vaultDir, port, root, ticketMs, lockNonce = null) {
  const token = reusableToken(accessFile(vaultDir), root, port) ?? newSecret()
  let ticket = newSecret()
  let timer = null
  const save = () => writeAccess(vaultDir, { port, root, token, ticket, pid: process.pid, nonce: lockNonce })
  // 作り直してからの時間で数える。固定の間隔だと、出した直後のリンクが切れることがある。
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(rotateTicket, ticketMs)
    timer.unref?.()
  }
  // 書けなくても（フォルダーが消された、ほかのソフトが使っている、など）サーバーは落とさない。
  // 古い鍵はもう使えないので、安全な側に倒れる。次の作り直しでまた書く。
  function rotateTicket() {
    ticket = newSecret()
    schedule()
    try {
      save()
    } catch (error) {
      console.error(`起動情報のファイルを書けませんでした: ${error.message}`)
    }
  }
  save()
  schedule()
  return {
    token,
    claim(given) {
      if (!sameToken(given, ticket)) return null
      rotateTicket()
      return token
    },
    stop() {
      clearTimeout(timer)
    },
  }
}

// 合言葉なしで動くときも起動情報のファイルは書く。ないと、次に起動したサーバーがこのサーバーを見つけられず、2つ目が動いてしまう。
// 前の合言葉と鍵は残さない（token と ticket は null）。
export function writeOpenAccess(vaultDir, port, root, lockNonce = null) {
  writeAccess(vaultDir, { port, root, token: null, ticket: null, pid: process.pid, nonce: lockNonce })
}
