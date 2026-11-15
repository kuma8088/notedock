// サーバーのファイルを用意する。ダウンロードするのは、帯のボタンを押したときだけ（ensureBinary）。
// 大きさと指紋（SHA-256）が合ったものだけを置き場に置く。同時に2つのチャットが取りに行かないよう、ロックで守る。
import { ASSETS, BASE_URL, VERSION } from './release'
import {
  binaryName, downloadCmd, joinPath, makeDirsCmd, makeExecutableCmd, mkdirExclusiveCmd, moveCmd, parseSha256, removeDirCmd,
  runCmd, sha256Cmd, type HostInfo,
} from './platform'
import { VERSION_RE } from './target'

type Host = any

export type Stage = 'checking' | 'downloading' | 'verifying'
export type Installed = { bin: string } | { problem: string }
// テストでは、配布の一覧を差し替えられる。
export type ReleaseInfo = { VERSION: string; BASE_URL: string; ASSETS: Record<string, { file: string; size: number; sha256: string } | undefined> }
const REAL: ReleaseInfo = { VERSION, BASE_URL, ASSETS }

const BEAT_EVERY_MS = 5000 // ロックを持つ側が、生きている印を書き直す間隔
const POLL_MS = 3000 // 待つ側が、置き場とロックを見る間隔
const STALE_MS = 30_000 // これだけ書き直されなければ、残ったロックとみなす

const MSG_UNSUPPORTED = 'このOSにはまだ対応していません。'
const MSG_CORRUPT = 'サーバーのファイルが壊れているか、差し替えられていたので消しました。「ノートを開く」を押すと、ダウンロードし直します。'
const MSG_RETRY = 'もう一度「ノートを開く」を押してください。'
const MSG_UNCHECKED = 'サーバーのファイルを確かめられませんでした。もう一度「ノートを開く」を押してください。'
const MSG_NO_SHA = 'このパソコンでファイルの指紋を調べられません。READMEの「困ったとき」を見てください'
const MSG_CANT_WRITE = `置き場に書けませんでした。${MSG_RETRY}`
const MSG_MISMATCH = `ダウンロードしたサーバーのファイルの大きさか指紋が合わなかったので、使わずに消しました。${MSG_RETRY}`

// Modが読み込まれてから、大きさと指紋を確かめ終えた場所。2回目からは確かめ直さない。
const verified = new Set<string>()
export function resetVerifiedForTest(): void {
  verified.clear()
  shaFailStreak = 0
}

// 指紋を調べるコマンドそのものが失敗した回数（続けて）。1回でも調べられれば0に戻す。ファイルの中身が違う場合は数えない。
const SHA_FAIL_LIMIT = 3
let shaFailStreak = 0
const unchecked = () => (shaFailStreak >= SHA_FAIL_LIMIT ? MSG_NO_SHA : MSG_UNCHECKED)

function binRoot(host: HostInfo): string {
  return joinPath(host.os, host.stateDir, 'bin')
}
function lockDir(host: HostInfo): string {
  return joinPath(host.os, binRoot(host), '.download-lock')
}
function binPath(host: HostInfo, version: string): string {
  return joinPath(host.os, binDir(host, version), binaryName(host.target))
}

// <保存フォルダー>/bin/<VERSION>
export function binDir(host: HostInfo, version: string = VERSION): string {
  return joinPath(host.os, binRoot(host), version)
}

// 表示用の関数が例外を投げても、ダウンロードの後始末を止めない。
function stage(onStage: (s: Stage) => void, s: Stage): void {
  try {
    onStage(s)
  } catch {
    // 表示の失敗は無視する。
  }
}

// 大きさ、指紋の順に確かめる。合えば ok、違えば bad。
// 大きさを読めない、指紋のコマンドが失敗した（時間切れ、ウイルス対策の走査中など）ときは unknown。
// unknown は「壊れている」とは限らないので、置き場のファイルは消さない。
async function matches($: Host, host: HostInfo, file: string, size: number, sha256: string): Promise<'ok' | 'bad' | 'unknown'> {
  try {
    const st = await $.fs.stat(file)
    if (st.size !== size) return 'bad'
  } catch {
    return 'unknown'
  }
  const r = await runCmd($, sha256Cmd(host, file))
  const got = r.exitCode === 0 ? parseSha256(r.stdout) : null
  if (!got) {
    shaFailStreak++
    return 'unknown'
  }
  shaFailStreak = 0
  return got === sha256.toLowerCase() ? 'ok' : 'bad'
}

// 置き場にあるファイルを返す。無ければ null。あっても合わなければ、消して problem を返す（ダウンロードはしない）。
export async function installedBinary($: Host, host: HostInfo, release: ReleaseInfo = REAL): Promise<string | { problem: string } | null> {
  const asset = release.ASSETS[host.target]
  if (!asset) return null
  const bin = binPath(host, release.VERSION)
  if (!(await $.fs.exists(bin))) return null
  if (verified.has(bin)) return bin
  const m = await matches($, host, bin, asset.size, asset.sha256)
  if (m === 'ok') {
    verified.add(bin)
    return bin
  }
  if (m === 'unknown') return { problem: unchecked() }
  await runCmd($, removeDirCmd(host, bin))
  return { problem: MSG_CORRUPT }
}

// ロックの持ち主が最後に書き直した時刻。beat.json があれば、読めなくてもそのファイルの更新時刻。
// beat.json がまだ無い（書く前）ときだけ、フォルダーの更新時刻で数える。
async function lastBeat($: Host, host: HostInfo, lock: string): Promise<number | null> {
  const file = joinPath(host.os, lock, 'beat.json')
  try {
    if (await $.fs.exists(file)) {
      try {
        const j = JSON.parse(await $.fs.read(file))
        if (typeof j?.t === 'number') return j.t
      } catch {
        // 読めない・壊れている。ファイルの更新時刻を使う。
      }
      return (await $.fs.stat(file)).mtimeMs
    }
    return (await $.fs.stat(lock)).mtimeMs
  } catch {
    return null
  }
}

// ほかのチャットのダウンロードを待つ。ready＝置き場に現れた、gone＝ロックが消えた、stale＝持ち主が止まっている。
// フックの中では眠らず、$.clock.every で見に行く。
function waitForOther($: Host, host: HostInfo, bin: string, lock: string): Promise<'ready' | 'gone' | 'stale'> {
  return new Promise(resolve => {
    let busy = false
    let done = false
    let failed = 0
    const timer = $.clock.every(POLL_MS, async () => {
      if (busy || done) return
      busy = true
      try {
        let d: 'ready' | 'gone' | 'stale' | null = null
        if (await $.fs.exists(bin)) d = 'ready'
        else if (!(await $.fs.exists(lock))) d = 'gone'
        else {
          const last = await lastBeat($, host, lock)
          if (last !== null && (await $.clock.now()) - last >= STALE_MS) d = 'stale'
        }
        failed = 0
        if (d) {
          done = true
          timer.cancel()
          resolve(d)
        }
      } catch {
        // 見られなかった回は飛ばして次の回で見る。続けて10回見られなければ、あきらめて取り直しへ進む。
        if (++failed >= 10) {
          done = true
          timer.cancel()
          resolve('gone')
        }
      } finally {
        busy = false
      }
    })
  })
}

async function download($: Host, host: HostInfo, url: string, part: string, asset: { size: number; sha256: string }, onStage: (s: Stage) => void, bin: string): Promise<Installed> {
  stage(onStage, 'downloading')
  let code: number | null
  try {
    // 長くかかるので $.process.run ではなく spawn で動かし、読み終えてから終わり方を受け取る。
    const cmd = downloadCmd(host, url, part)
    const req: { argv: string[]; env?: Record<string, string> } = { argv: cmd.argv }
    if (cmd.env) req.env = cmd.env
    const stream = $.process.spawn(req)
    for await (const _ of stream) {
      // 出力は使わない
    }
    code = (await stream.result).code
  } catch (e) {
    await runCmd($, removeDirCmd(host, part))
    return { problem: `サーバーのファイルをダウンロードできませんでした（curl を起動できません）。${MSG_RETRY}` }
  }
  if (code !== 0) {
    await runCmd($, removeDirCmd(host, part))
    return { problem: `サーバーのファイルをダウンロードできませんでした（curl の終了コード ${code ?? '不明'}）。${MSG_RETRY}` }
  }
  stage(onStage, 'verifying')
  const m = await matches($, host, part, asset.size, asset.sha256)
  if (m !== 'ok') {
    await runCmd($, removeDirCmd(host, part))
    // 指紋を調べられなかっただけなら、「合わなかった」とは言わない（3回続けば READMEの案内）。
    return { problem: m === 'unknown' ? unchecked() : MSG_MISMATCH }
  }
  const chmod = makeExecutableCmd(host, part)
  if (chmod && (await runCmd($, chmod)).exitCode !== 0) {
    await runCmd($, removeDirCmd(host, part))
    return { problem: MSG_CANT_WRITE }
  }
  if ((await runCmd($, moveCmd(host, part, bin))).exitCode !== 0) {
    // Windowsでは、ほかのチャットやウイルス対策が先に同じファイルを置くと移せないことがある。
    // 置き場に指紋の合うファイルがあれば、それを使う。
    const ok = host.os === 'win32' && (await $.fs.exists(bin)) && (await matches($, host, bin, asset.size, asset.sha256)) === 'ok'
    await runCmd($, removeDirCmd(host, part))
    if (!ok) return { problem: MSG_CANT_WRITE }
  }
  verified.add(bin)
  return { bin }
}

// 前の途中で止まったダウンロードの残り（.part-）を消す。ロックを持っているので、ほかのチャットの途中のものではない。
async function removeLeftoverParts($: Host, host: HostInfo, dir: string): Promise<void> {
  try {
    const entries: { name: string }[] = await $.fs.list(dir)
    for (const e of entries) if (e.name.startsWith('.part-')) await runCmd($, removeDirCmd(host, joinPath(host.os, dir, e.name)))
  } catch {
    // 見られなくても、ダウンロードは進める。
  }
}

// ボタンを押したときだけ呼ぶ。置き場に無ければダウンロードして、指紋を確かめてから置く。
export async function ensureBinary($: Host, host: HostInfo, onStage: (stage: Stage) => void, release: ReleaseInfo = REAL): Promise<Installed> {
  const asset = release.ASSETS[host.target]
  if (!asset) return { problem: MSG_UNSUPPORTED }
  stage(onStage, 'checking')
  const have = await installedBinary($, host, release)
  if (typeof have === 'string') return { bin: have }
  // 確かめられなかったときは、ファイルを残したまま、ダウンロードもしない（もう一度押してもらう）。
  if (have && (have.problem === MSG_UNCHECKED || have.problem === MSG_NO_SHA)) return have
  // 壊れていて消した場合は、そのままダウンロードし直す。

  const dir = binDir(host, release.VERSION)
  const bin = binPath(host, release.VERSION)
  const lock = lockDir(host)
  if ((await runCmd($, makeDirsCmd(host, dir))).exitCode !== 0) return { problem: MSG_CANT_WRITE }

  for (let attempt = 0; attempt < 20; attempt++) {
    let made = (await runCmd($, mkdirExclusiveCmd(host, lock))).exitCode === 0
    if (!made && !(await $.fs.exists(lock))) made = (await runCmd($, mkdirExclusiveCmd(host, lock))).exitCode === 0 // 1回だけやり直す
    if (made) {
      // ロックを持った。生きている印をすぐ書き、5秒ごとに書き直す。
      const beatFile = joinPath(host.os, lock, 'beat.json')
      // 止めたあとに書くと、消したロックのフォルダーを作り直してしまう。止めたら書かず、書きかけは待つ。
      let stopped = false
      let busy = false
      let inflight: Promise<void> = Promise.resolve()
      const beat = () => {
        if (stopped || busy) return
        busy = true
        inflight = (async () => {
          try {
            await $.fs.write(beatFile, JSON.stringify({ t: await $.clock.now() }))
          } catch {
            // 書けない回があっても、次の回で書く。
          } finally {
            busy = false
          }
        })()
      }
      beat()
      await inflight
      const timer = $.clock.every(BEAT_EVERY_MS, beat)
      try {
        await removeLeftoverParts($, host, dir)
        const part = joinPath(host.os, dir, `.part-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`)
        return await download($, host, release.BASE_URL + asset.file, part, asset, onStage, bin)
      } finally {
        stopped = true
        timer.cancel()
        await inflight
        await runCmd($, removeDirCmd(host, lock))
      }
    }
    if (!(await $.fs.exists(lock))) return { problem: MSG_CANT_WRITE }
    // ほかのチャットがダウンロード中。
    const w = await waitForOther($, host, bin, lock)
    if (w === 'ready') {
      const got = await installedBinary($, host, release)
      if (typeof got === 'string') return { bin: got }
      if (got) return got
    } else if (w === 'stale') {
      await runCmd($, removeDirCmd(host, lock))
    }
    // gone か、取り損ねたときは、もう一度ロックを取りに行く。
  }
  return { problem: `サーバーのファイルを用意できませんでした。${MSG_RETRY}` }
}

// 2つの版の名前を比べる（semver の順。-dev などの付いた版は、付いていない同じ番号の版より古い）。
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const i = v.indexOf('-')
    return { core: (i < 0 ? v : v.slice(0, i)).split('.').map(Number), pre: i < 0 ? [] : v.slice(i + 1).split('.') }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

// bin/ の中の、今のバージョンより古いバージョン名のフォルダーを消す。新しい版（ほかのチャットの新しいModが
// 入れたもの）は消さない。.download-lock などは消さない。
// 全部消せた（消すものが無かった）ら true。Windowsで、止めたばかりのサーバーがまだファイルを使っていると、消せずに false になる。
export async function removeOldVersions($: Host, host: HostInfo, release: ReleaseInfo = REAL): Promise<boolean> {
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(binRoot(host))
  } catch {
    return true // bin/ が無い
  }
  let all = true
  for (const e of entries) {
    if (e.kind !== 'dir' || !VERSION_RE.test(e.name) || compareVersions(e.name, release.VERSION) >= 0) continue
    try {
      if ((await runCmd($, removeDirCmd(host, joinPath(host.os, binRoot(host), e.name)))).exitCode !== 0) all = false
    } catch {
      all = false
    }
  }
  return all
}

// 自分のバージョンのファイルが置き場に無く、自分より新しいバージョンのフォルダーがあれば true。
// 新しいバージョンのModが入れ替えて、古いバージョン（自分）のフォルダーを片づけたあと、と考える。
// 確かめられないときは false（いつもどおりの動きにする）。
export async function onlyNewerInstalled($: Host, host: HostInfo, release: ReleaseInfo = REAL): Promise<boolean> {
  try {
    if (await $.fs.exists(binPath(host, release.VERSION))) return false
    const entries: { name: string; kind: string }[] = await $.fs.list(binRoot(host))
    return entries.some(e => e.kind === 'dir' && VERSION_RE.test(e.name) && compareVersions(e.name, release.VERSION) > 0)
  } catch {
    return false
  }
}
