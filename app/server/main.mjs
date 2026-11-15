import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { createApp } from './app.mjs'
import { removeStaleTemps, replaceFile } from './durable.mjs'
import { ALREADY_RUNNING, acquireLock, isServingCheck, listenOnFreePort, preferredPort } from './instance.mjs'
import { launcherPid, watchParent } from './platform.mjs'
import { canonicalRoot, defaultStateDir, isRefusedRoot, vaultDirOf, vaultIdOf } from './config.mjs'
import { HANDOVER_EXIT, HANDOVER_MS, SERVER_VERSION, VERSION_RE, compareVersions } from './version.mjs'

// 起動元は最初に覚える。ロック待ちなどの途中で起動元が終わると、あとからでは親が1に変わっていて分からないため。
const parentPid = launcherPid()

const options = {
  root: { type: 'string' },
  // テスト用のコピーのとき、元のVaultの場所。貼り付けたパスを同じ場所のノートとして開く。読み書きはしない。
  'same-as': { type: 'string' },
  // 付けたときは、その番号だけを使う。付けなければVaultから番号を決め、ふさがっていれば次へ移る。
  port: { type: 'string' },
  // 合言葉と設定を置く場所。試すときに本物の場所を使わないため。
  'state-dir': { type: 'string' },
  // 合言葉なしで使う。Modを入れていない環境でDev serversから開くときのため。
  'no-token': { type: 'boolean', default: false },
  'backup-dir': { type: 'string' },
  // 起動元が終わったら、自分も終わる。
  'watch-parent': { type: 'boolean', default: false },
  // vaultIdを1行出して終わる。Modが自分で計算せず、サーバーに聞けるようにする。
  'print-vault-id': { type: 'boolean', default: false },
}

// 引数の書き方が違うとき（--port -1 など）も、1行だけ出して2で終わる。
let values
try {
  ;({ values } = parseArgs({ options }))
} catch (error) {
  console.error(error.message.split('\n')[0])
  process.exit(2)
}

// 起動元が終わったら、起動の途中（ロック待ちなど）でも終わる。終わるときの片づけは下の exit で行う。
if (values['watch-parent']) watchParent(() => process.exit(0), { parentPid })

if (!values.root) {
  console.error('--root を指定してください')
  process.exit(2)
}

// 番号は 0〜65535 の整数だけ。0 は空いている番号をOSに選ばせる（テスト用）。
if (values.port !== undefined && !(/^\d{1,5}$/.test(values.port) && Number(values.port) <= 65535)) {
  console.error(`--port は 0〜65535 の整数で指定してください: ${values.port}`)
  process.exit(2)
}

let root
try {
  root = canonicalRoot(values.root)
  if (!fs.statSync(root).isDirectory()) throw new Error('not a directory')
  fs.readdirSync(root)
} catch {
  console.error(`Vaultのフォルダーが見つからないか、読めません: ${values.root}`)
  process.exit(2)
}
if (isRefusedRoot(root)) {
  console.error(`この場所はVaultにできません: ${root}`)
  process.exit(2)
}
const vaultId = vaultIdOf(root)
if (values['print-vault-id']) {
  console.log(vaultId)
  process.exit(0)
}

const stateDir = values['state-dir'] ?? defaultStateDir()
const backupDir = values['backup-dir'] ?? path.join(stateDir, 'backups')
const vaultDir = vaultDirOf(stateDir, vaultId)
fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 })

// 新しいバージョンに譲った直後なら、起動し直さずに終わる（古いバージョンのModが、止めたサーバーを起動し直すのを止める）。
// 10分たった記録、読めない記録、自分より新しくない記録は無視する。ロックを取る前に判断するので、何も残さない。
try {
  const handover = JSON.parse(fs.readFileSync(path.join(vaultDir, 'handover.json'), 'utf8'))
  const age = Date.now() - handover.at
  if (typeof handover.to === 'string' && VERSION_RE.test(handover.to) && Number.isFinite(age) && age >= 0 && age < HANDOVER_MS && compareVersions(handover.to, SERVER_VERSION) > 0) {
    console.error(`新しいバージョン（${handover.to}）に譲ったので、起動しません`)
    process.exit(HANDOVER_EXIT)
  }
} catch {
  // ない・壊れている → 普通に起動する。
}

// 終わるときはロックだけを消す（nonceが自分のものと同じときだけ）。ロックを取る前に終わったときは何もしない。
// server.json は残す。起動し直したとき、同じVaultとポートなら同じ合言葉を使い続け、開いているタブが止まらないようにするため。
// 残ったserver.jsonのポートはもう答えないので、次の起動の確かめ（isServingCheck）は false になり、すぐ動き出せる。
let lock = null
process.on('exit', () => {
  lock?.release()
})

// 同じVaultでサーバーは1つだけ。ほかが動いていれば、決まった終了コードで終わる。
lock = await acquireLock(vaultDir, { isServing: isServingCheck(vaultDir, vaultId) })
if (!lock) {
  console.error('このVaultのサーバーはもう動いています')
  process.exit(ALREADY_RUNNING)
}
// 終了の合図を受け取れないOSもあるので、設定に失敗しても続ける。process.exit で上の片づけが動く。
try {
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
} catch {
  // 使えなければ、起動元の見張りか強制終了で終わる。残ったロックは次の起動で引き継ぐ。
}

// 場所を移したあとの片づけや移行で、どのVaultのものか分かるようにする。ロックを取ったサーバーだけが書く。
replaceFile(path.join(vaultDir, 'root.txt'), `${root}\n`)

try {
  removeStaleTemps(root)
} catch (error) {
  console.error(`古い一時ファイルの片づけに失敗しました: ${error.message}`)
}

const fixedPort = values.port === undefined ? undefined : Number(values.port)
const preferred = preferredPort(vaultId)
const app = createApp({
  root,
  backupDir,
  stateDir,
  vaultDir,
  sameAs: values['same-as'],
  noToken: values['no-token'],
  lockNonce: lock.nonce,
  // 止める指示を受けたあと（保存を書き終え、接続を閉じたあと）に呼ばれる。譲った記録を書き、ロックを外して終わる。
  onShutdown: ({ to }) => {
    replaceFile(path.join(vaultDir, 'handover.json'), JSON.stringify({ to, at: Date.now() }), { mode: 0o600 })
    lock?.release()
    process.exit(0)
  },
  ...(fixedPort === undefined ? { preferredPort: preferred } : {}),
})
let server
try {
  if (fixedPort === undefined) {
    await listenOnFreePort(async (port) => {
      server = await app.listen(port)
    }, preferred)
  } else {
    server = await app.listen(fixedPort)
  }
} catch (error) {
  console.error(`接続を受け付けられませんでした: ${error.message}`)
  process.exit(1)
}
console.log(`NoteDock: http://127.0.0.1:${server.address().port}/ root=${root}`)
if (!values['no-token']) console.log('Claudeのアプリで、入力欄の上の「ノートを開く」から開いてください')
