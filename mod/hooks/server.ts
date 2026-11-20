// サーバーを見つける、起動する、見張る。
// 見つける：server.json と、返事の印（x-notedock-vault）の両方がそろったときだけ「動いている」とみなす。
// 起動する：--root と --watch-parent だけを付けて、Modの中の裏の処理から動かし続ける。
// 見張る：createWatcher は $ を使わない純粋な処理。呼ぶ側が find / start と時刻を渡す。
// 入れ替える：動いているサーバーが自分（Mod）より古いバージョンなら、止める指示を送り、止まってから自分のバージョンを起動する。
import { compareVersions } from './install'
import { joinPath, runCmd, type HostInfo } from './platform'
import { VERSION_RE } from './target'

type Host = any

export const ALREADY_RUNNING = 75 // もう動いている（ほかのチャットが起動した）
export const BAD_ARGS = 2 // Vaultの場所かポートの指定が使えない
export const HANDED_OVER = 76 // 新しいバージョンに譲ったので起動しなかった（サーバーの HANDOVER_EXIT と同じ）
export const HANDOVER_MS = 10 * 60_000 // handover.json を有効と見る時間（サーバーの HANDOVER_MS と同じ）
export const HELD_RETRY_MS = 30_000 // 起動を控えた（held）あと、もう一度 start を呼ぶまでの間隔

export type ServerInfo = { port: number; pid: number; root: string; token: string | null; ticket: string | null }
// version は、応答の x-notedock-version。見出しのないサーバー（古い開発用のビルド）は null。
// pid は server.json に書かれたもの。自分が起動したサーバーかを見分けるのに使う。
export type Running = { port: number; vaultId: string; ticket: string | null; version: string | null; pid: number }
// own：このチャットが起動したサーバー（75 で、ほかのチャットのサーバーを使ったときは false）。
// held：起動を控えた（新しいバージョンに譲ったあと）。失敗には数えない。
export type Started = { running: Running; own?: boolean } | { problem: string } | { held: true }
export type WatchState =
  | { kind: 'running'; running: Running }
  | { kind: 'starting' }
  | { kind: 'waiting'; until: number }
  | { kind: 'stopped'; problem: string }
  | { kind: 'replacing' } // 古いバージョンが止まるのを待っている。または、新しいバージョンが動き出すのを待っている
export type ShutdownResult = 'stopping' | 'refused' | 'failed'
// 入れ替えの知らせ。stopping＝止める指示が通った、failed＝入れ替えられなかった、legacy＝バージョンの見出しのないサーバー。
export type ReplaceEvent = { kind: 'stopping' } | { kind: 'failed'; reason: 'refused' | 'failed' | 'timeout' } | { kind: 'legacy' }

const POLL_MS = 500 // 起動後、動き出したかを見る間隔
const START_LIMIT_MS = 120_000 // 起動を待つ上限（2分）
const STABLE_MS = 60_000 // これだけ続けて動けば、失敗の数を0に戻す
const BACKOFF_MS = [30_000, 120_000] // 失敗1回目のあと、2回目のあと
const MAX_FAILURES = 3
const HEALTH_PATH = '/api/health'
const SHUTDOWN_PATH = '/api/shutdown'
const VAULT_HEADER = 'x-notedock-vault'
const VERSION_HEADER = 'x-notedock-version'
const STOP_WAIT_MS = 20_000 // 止める指示のあと、古いバージョンが止まるのを待つ上限
const SHUTDOWN_LIMIT_MS = 10_000 // 止める指示の返事を待つ上限

function failMessage(reason: string): string {
  return `NoteDockのサーバーを起動できませんでした（${reason}）`
}

// bin --root <root> --print-vault-id。16文字の16進だけを受け取る。
export async function vaultIdOf($: Host, bin: string, root: string): Promise<string | null> {
  const r = await runCmd($, { argv: [bin, '--root', root, '--print-vault-id'] })
  if (r.exitCode !== 0) return null
  const id = r.stdout.trim()
  return /^[0-9a-f]{16}$/.test(id) ? id : null
}

// server/config.mjs の vaultDirOf と同じ場所
export function vaultDirOf(host: HostInfo, vaultId: string): string {
  return joinPath(host.os, host.stateDir, 'vaults', vaultId)
}

// server.json は、サーバーが止まっても残る。読めない・壊れていれば null。
export async function readServerInfo($: Host, host: HostInfo, vaultId: string): Promise<ServerInfo | null> {
  try {
    const j = JSON.parse(await $.fs.read(joinPath(host.os, vaultDirOf(host, vaultId), 'server.json')))
    if (!Number.isInteger(j?.port) || j.port < 1 || j.port > 65535 || !Number.isInteger(j?.pid)) return null
    // 鍵はURLにそのまま入るので、使える文字だけにする。
    if (typeof j.ticket === 'string' && !/^[A-Za-z0-9_-]+$/.test(j.ticket)) return null
    return {
      port: j.port,
      pid: j.pid,
      root: typeof j.root === 'string' ? j.root : '',
      token: typeof j.token === 'string' ? j.token : null,
      ticket: typeof j.ticket === 'string' ? j.ticket : null,
    }
  } catch {
    return null
  }
}

// 返事の印だけで見分ける。サーバーは断る返事（401・403）にも印を付けるので、状態の番号は見ない。
// つながらなければ ours: false。バージョンは x-notedock-version。無いか、バージョンの形でなければ null。
// 受け入れている弱点：サーバーが止まったあと、同じパソコンの別のユーザーのプログラムが同じ番号で待てば、
// なりすませる。同じユーザーのプログラムは合言葉のファイルを読めるので、危険があるのは共用のパソコンだけ。
export async function probe($: Host, port: number, vaultId: string): Promise<{ ours: boolean; version: string | null }> {
  try {
    const r = await $.http.fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`)
    const v = r?.headers?.[VERSION_HEADER]
    return { ours: r?.headers?.[VAULT_HEADER] === vaultId, version: typeof v === 'string' && VERSION_RE.test(v) ? v : null }
  } catch {
    return { ours: false, version: null }
  }
}

// server.json が残っていても、答えなければ動いていないとみなす。
export async function findRunning($: Host, host: HostInfo, vaultId: string): Promise<Running | null> {
  const info = await readServerInfo($, host, vaultId)
  if (!info) return null
  const p = await probe($, info.port, vaultId)
  if (!p.ours) return null
  return { port: info.port, vaultId, ticket: info.ticket, version: p.version, pid: info.pid }
}

// 動いているサーバーに止める指示を送る。合言葉は server.json から読み、記録には書かない。
// 204＝止まり始めた、503＝もう止まりかけている（ほかのチャットが先に送った）、409＝自分のほうが新しくない。
export async function requestShutdown($: Host, host: HostInfo, vaultId: string, myVersion: string): Promise<ShutdownResult> {
  const info = await readServerInfo($, host, vaultId)
  if (!info?.token) return 'failed'
  try {
    const r = await $.http.fetch(`http://127.0.0.1:${info.port}${SHUTDOWN_PATH}`, {
      method: 'POST',
      headers: { 'x-note-token': info.token, 'x-note-editor': '1', [VERSION_HEADER]: myVersion },
    })
    if (r?.status === 204 || r?.status === 503) return 'stopping'
    if (r?.status === 409) return 'refused'
    return 'failed'
  } catch {
    return 'failed'
  }
}

// handover.json：古いサーバーが、新しいバージョンに譲って止まったときに書く。読めない・壊れていれば null。
export async function readHandover($: Host, host: HostInfo, vaultId: string): Promise<{ to: string; at: number } | null> {
  try {
    const j = JSON.parse(await $.fs.read(joinPath(host.os, vaultDirOf(host, vaultId), 'handover.json')))
    if (typeof j?.to !== 'string' || !VERSION_RE.test(j.to) || typeof j?.at !== 'number' || !Number.isFinite(j.at)) return null
    return { to: j.to, at: j.at }
  } catch {
    return null
  }
}

// 自分より新しいバージョンに譲ってから10分たっていなければ true（サーバーの起動時の判断と同じ決まり）。
export function handoverHolds(h: { to: string; at: number } | null, myVersion: string, now: number): boolean {
  if (!h) return false
  const age = now - h.at
  return age >= 0 && age < HANDOVER_MS && compareVersions(h.to, myVersion) > 0
}

// サーバーを起動し、動き出すか、2分たつか、終わるまで待つ。
// 起動したサーバーの命は、裏の for await の中にある（この関数が終わっても続く）。
// ただし、あきらめて problem を返すときは、自分の子プロセスを止める（return で for await を抜ける）。
export function startServer($: Host, host: HostInfo, bin: string, root: string, vaultId: string): Promise<Started> {
  return new Promise<Started>(resolve => {
    let lastLine = ''
    let exitCode: number | null = null // null＝まだ動いている
    let spawnFailed: string | null = null
    let done = false
    let busy = false
    let gaveUp = false
    let stream: any = null
    let timer: { cancel: () => void } | null = null
    let limit: { cancel: () => void } | null = null
    const stopChild = () => {
      try {
        void Promise.resolve(stream?.return?.()).catch(() => {})
      } catch {
        // 止められなくても、problem は返す。
      }
    }
    const finish = (s: Started) => {
      if (done) return
      done = true
      timer?.cancel()
      limit?.cancel()
      if ('problem' in s && exitCode === null) {
        gaveUp = true
        stopChild()
      }
      resolve(s)
    }
    const detail = () => (lastLine ? `${lastLine}` : '理由は出ませんでした')

    // 2分の上限は、見に行く処理とは別のタイマーで守る（見に行く処理が返ってこなくても止まる）。
    limit = $.clock.after(START_LIMIT_MS, () => {
      finish({ problem: failMessage(`2分たっても答えませんでした。${exitCode === ALREADY_RUNNING ? 'ほかのチャットのサーバーが見つかりません。' : detail()}`) })
    })

    // 裏の処理。標準エラーの最後の1行を覚え、読み終えたら終わり方を受け取る。
    void (async () => {
      let buf = ''
      try {
        stream = $.process.spawn({ argv: [bin, '--root', root, '--watch-parent'] })
        for await (const chunk of stream) {
          if (gaveUp) break
          if (chunk?.stream !== 'stderr') continue
          buf += chunk.text
          const lines = buf.split(/\r?\n/)
          buf = lines.pop() ?? ''
          for (const l of lines) if (l.trim()) lastLine = l.trim()
        }
        if (buf.trim()) lastLine = buf.trim()
        const end = await stream.result
        exitCode = typeof end?.code === 'number' ? end.code : -1
      } catch (e) {
        spawnFailed = e instanceof Error && e.message ? e.message : 'プログラムを起動できません'
      }
    })()

    timer = $.clock.every(POLL_MS, async () => {
      if (busy || done) return
      busy = true
      try {
        if (spawnFailed !== null) return finish({ problem: failMessage(spawnFailed) })
        // 新しいバージョンに譲ったあとなので起動しなかった。失敗ではない（見張りが、新しいサーバーを探し続ける）。
        if (exitCode === HANDED_OVER) return finish({ held: true })
        if (exitCode !== null && exitCode !== ALREADY_RUNNING) {
          const why = exitCode === BAD_ARGS ? `Vaultの場所が使えません。${detail()}` : `終了コード ${exitCode}。${detail()}`
          return finish({ problem: failMessage(why) })
        }
        const running = await findRunning($, host, vaultId)
        // まだ自分の子が動いていれば、自分が起動したもの。75 で終わっていれば、ほかのチャットのもの。
        if (running) return finish({ running, own: exitCode === null })
      } catch (e) {
        finish({ problem: failMessage(e instanceof Error && e.message ? e.message : '状態を確かめられません') })
      } finally {
        busy = false
      }
    })
  })
}

// 見張りの頭脳。find で動いているかを見て、止まっていれば start で起動し直す。
// now は、start が終わった時刻を取り直すのに使う（起動に時間がかかるため）。
// after を渡すと、find・start が返ってこないときも一定時間で打ち切る（find は10秒、start は130秒）。
// version（自分のバージョン）と shutdown を渡すと、古いバージョンのサーバーを入れ替える。
//   自分が起動したサーバー（own）は、バージョンにかかわらず止めない。
//   止める指示が通ったら、最長20秒、見張りの回ごとに見る。答えなくなるか、自分と同じか新しいバージョンが答えたら、止まったとみなす。
//   pid が変わっただけでは、止まったとみなさない（古いバージョンが起動し直したときにも変わるため）。
//   返事がない・読めない（failed）か、20秒たっても止まらない（timeout）ときは、起動の失敗と同じ間隔（30秒・2分）でやり直し、
//   3回で止める。onReplace の failed は、3回目の失敗で1回だけ出す。やり直しを待つあいだは、そのサーバーをそのまま使う。
//   refused（相手のほうが新しい）は、やり直さない。やり直しの数は、起動の失敗とは別に数え、reset でも戻さない。
// start が held（新しいバージョンに譲ったので、起動を控えた）を返したら、HELD_RETRY_MS のあいだは start を呼ばずに待つ（reset で戻す）。
export function createWatcher(deps: {
  find: () => Promise<Running | null>
  start: () => Promise<Started>
  now?: () => Promise<number> | number
  after?: (ms: number, fn: () => void) => { cancel: () => void }
  version?: string
  shutdown?: () => Promise<ShutdownResult>
  onReplace?: (e: ReplaceEvent) => void
}): {
  tick(now: number): Promise<WatchState>
  reset(): void
} {
  const FIND_LIMIT_MS = 10_000
  const START_CALL_LIMIT_MS = 130_000
  let failures = 0
  let until = 0 // この時刻まで起動しない
  let runningSince: number | null = null // このウォッチャーが起動したサーバーが、動いているのを見た最初の時刻
  let stopped: string | null = null
  let busy: 'find' | 'start' | null = null
  let last: WatchState = { kind: 'starting' }
  let replaceOver = false // もう入れ替えを試さない（refused、または3回失敗した）
  let replaceFailures = 0 // 入れ替えに失敗した回数（起動の失敗 failures とは別）
  let replaceUntil = 0 // この時刻まで、入れ替えを試し直さない
  let heldUntil = 0 // この時刻まで、start を呼ばない（held のあと）
  let stopSince: number | null = null // 止める指示が通った時刻（止まるのを待っているあいだ）
  let ownPid: number | null = null // このチャットが起動したサーバーの pid
  let legacySeen = false
  const mine = deps.version
  const versionOf = (r: Running): string | null => (typeof r.version === 'string' && VERSION_RE.test(r.version) ? r.version : null)
  const notNewer = (r: Running) => versionOf(r) !== null && mine !== undefined && compareVersions(versionOf(r)!, mine) >= 0
  const emit = (e: ReplaceEvent) => {
    try {
      deps.onReplace?.(e)
    } catch {
      // 知らせの失敗で、見張りを止めない。
    }
  }

  // 一定時間で打ち切る。after が無ければそのまま待つ。
  const bound = <T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> => {
    if (!deps.after) return p
    return new Promise<T>((resolve, reject) => {
      const t = deps.after!(ms, () => resolve(onTimeout))
      p.then(
        v => { t.cancel(); resolve(v) },
        e => { t.cancel(); reject(e) },
      )
    })
  }
  const clock = async (fallback: number): Promise<number> => {
    if (!deps.now) return fallback
    try {
      return await deps.now()
    } catch {
      return fallback
    }
  }
  const safeFind = async (): Promise<Running | null> => {
    try {
      return await bound(deps.find(), FIND_LIMIT_MS, null)
    } catch {
      return null
    }
  }
  const set = (s: WatchState): WatchState => (last = s)
  // 失敗を数える。3回目なら stopped、それ以外はあける時間を決める。
  const fail = (at: number, problem: string): WatchState => {
    failures++
    if (failures >= MAX_FAILURES) {
      stopped = problem
      return { kind: 'stopped', problem }
    }
    until = at + BACKOFF_MS[failures - 1]
    return { kind: 'waiting', until }
  }

  // 入れ替えの失敗を数える。3回目なら failed を知らせて、もう試さない。それ以外は、試し直す時刻を決める。
  const replaceFail = (at: number, reason: 'failed' | 'timeout') => {
    replaceFailures++
    if (replaceFailures >= MAX_FAILURES) {
      replaceOver = true
      emit({ kind: 'failed', reason })
      return
    }
    replaceUntil = at + BACKOFF_MS[replaceFailures - 1]!
  }

  return {
    async tick(now) {
      if (busy === 'start') return { kind: 'starting' }
      if (busy) return last
      busy = 'find'
      try {
        const found = await safeFind()
        // 止める指示のあと、古いバージョンが止まるのを待っている。
        if (stopSince !== null) {
          if (found && !notNewer(found)) {
            if (now - stopSince < STOP_WAIT_MS) return set({ kind: 'replacing' })
            stopSince = null
            replaceFail(now, 'timeout')
            return set({ kind: 'running', running: found })
          }
          stopSince = null // 止まった。答えなければ下で起動し、新しいバージョンが答えればそれを使う
        }
        if (found) {
          const replaceable = mine !== undefined && deps.shutdown !== undefined && found.pid !== ownPid
          const v = versionOf(found)
          if (replaceable && !replaceOver && now >= replaceUntil && v !== null && compareVersions(v, mine!) < 0) {
            let r: ShutdownResult
            try {
              r = await bound(deps.shutdown!(), SHUTDOWN_LIMIT_MS, 'failed' as ShutdownResult)
            } catch {
              r = 'failed'
            }
            if (r === 'stopping') {
              stopSince = await clock(now)
              emit({ kind: 'stopping' })
              return set({ kind: 'replacing' })
            }
            if (r === 'refused') {
              replaceOver = true
              emit({ kind: 'failed', reason: 'refused' })
            } else replaceFail(await clock(now), 'failed')
            // やり直しを待つあいだは、そのサーバーを使う。返事が届かないまま止まっていれば、次の回に見つからず、下で起動する。
            return set({ kind: 'running', running: found })
          }
          if (replaceable && v === null && !legacySeen) {
            legacySeen = true
            emit({ kind: 'legacy' })
          }
          if (runningSince !== null && now - runningSince >= STABLE_MS) failures = 0
          return set({ kind: 'running', running: found })
        }
        // 止まっている。起動を見張りが自分で始めたサーバーだけが、失敗の数に入る。
        let early = false
        if (runningSince !== null) {
          if (now - runningSince >= STABLE_MS) failures = 0
          else early = true
          runningSince = null
        }
        if (stopped !== null) return set({ kind: 'stopped', problem: stopped })
        if (early) {
          const s = fail(now, failMessage('起動してすぐ止まりました'))
          if (s.kind === 'stopped') return set(s)
        }
        if (now < until) return set({ kind: 'waiting', until })
        if (now < heldUntil) return set({ kind: 'replacing' }) // 新しいバージョンを待っている。探すのは毎回続ける
        busy = 'start'
        let started: Started
        try {
          started = await bound(deps.start(), START_CALL_LIMIT_MS, { problem: failMessage('起動の処理が終わりませんでした') } as Started)
        } catch (e) {
          started = { problem: failMessage(e instanceof Error && e.message ? e.message : '起動の処理が失敗しました') }
        }
        const after = await clock(now) // 起動にかかった時間のあとの時刻
        if ('held' in started) {
          heldUntil = after + HELD_RETRY_MS
          return set({ kind: 'replacing' }) // 新しいバージョンを待つ。失敗には数えない
        }
        if ('running' in started) {
          runningSince = after
          // ほかのチャットのサーバーを使ったとき（75）は、「自分が起動したサーバーは止めない」に入れない。
          ownPid = started.own === false ? null : started.running.pid
          return set({ kind: 'running', running: started.running })
        }
        return set(fail(after, started.problem))
      } finally {
        busy = null
      }
    },
    reset() {
      failures = 0
      until = 0
      runningSince = null
      stopped = null
      heldUntil = 0
    },
  }
}
