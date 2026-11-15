// NoteDockのMod。帯の「ノートを開く」、開いたフォルダーの記録、サーバーの見張り、Claudeに開いてもらう頼み、/note、チャット欄、ツール。
// 判断はすべて createNotedock の中にある。register はフックをつなぐだけ。
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Band } from '../types'
import { chatFile, claimChat, describeNote, hideKeys, isSentText, MAX_TEXT, noteForSend, quoteForPrompt, releaseChat, shareIsOn, TYPED_ORIGINS, withNote, type EditorState } from './chat'
import { summarizeTranscript } from './chat-log'
import { compareVersions, ensureBinary, installedBinary, onlyNewerInstalled, removeOldVersions } from './install'
import { editorUrl, openPrompt, retryPrompt } from './open'
import { markOpened, readOpened, type OpenedEntry } from './opened'
import { baseName, canonicalRoot, hostInfo, joinPath, makeStateDirCmd, moveCmd, PRODUCT, refusedReason, rootKey, runCmd, type HostInfo, type Os } from './platform'
import { VERSION } from './release'
import {
  createWatcher, findRunning, handoverHolds, readHandover, readServerInfo, requestShutdown, startServer, vaultDirOf, vaultIdOf,
  type ReplaceEvent, type Running, type ServerInfo, type ShutdownResult, type Started, type WatchState,
} from './server'
import { VERSION_RE } from './target'
import { registerTools, setAppearance, setVaultSettings, type ToolAnswer, type ToolContext, type ToolFailure } from './tools'

type Host = any

const LOOP_MS = 500 // 裏の処理が状態を見直す間隔
const SCREEN_WAIT_MS = 10_000 // 画面が付くのを待つ長さ
const TICK_MS = 5000 // 見張りの間隔
const SETTINGS_MS = 10_000 // settings.json（今日のノート）を読み直す間隔
const OPENED_MS = 30_000 // opened.json を読み直す間隔
const NEED_MS = 1000 // need-ticket.json を見る間隔
const OPEN_WAIT_MS = 15 * 60_000 // 頼んでから、帯を opening のままにする上限。open-pending の最初の期限
const RETRY_WINDOW_MS = 2 * 60_000 // 番が始まってから、頼み直しを受け付ける長さ
const HINT_MS = 10 * 60_000 // 頼んでいないときの案内や、押したあとの理由を出しておく長さ
const RUN_WAIT_MS = 140_000 // 押したあと、サーバーが動き出すのを待つ上限（起動の上限2分＋少し）
const CHAT_MS = 1000 // チャット欄の見回りの間隔（エディターから送られた文、引用、話し相手の印、会話の記録）
const OWNER_BEAT_MS = 10_000 // 話し相手は、この間隔で印の時刻を書き直す（エディターは40秒より古い印を「相手なし」とみなす）
const LOG_MIN_MS = 2000 // 会話の記録の書き出しは、2秒に1回まで
const LOG_BEAT_MS = 5000 // Claudeの作業中は、5秒ごとに書き直して、まだ動いていると分かるようにする
const CHAT_RECENT_MS = 30 * 60_000 // 送った文の番を待つ上限
const TOOLS_RETRY_MS = 30_000 // ツールを登録できなかったとき、登録し直す間隔
const CLEAN_RETRY_MS = 10_000 // 古いバージョンのフォルダーを消せなかったとき、消し直す間隔
const CLEAN_RETRY_LIMIT_MS = 2 * 60_000 // 消し直しを10秒おきに続ける長さ
const CLEAN_SLOW_MS = 10 * 60_000 // それを過ぎても消せなければ、この間隔で消し直す（自分のバージョンが動いているあいだだけ）

const MSG_NETWORK = 'ネットワーク上のフォルダーでは使えません'
const MSG_HINT = 'エディターを開き直すには「ノートを開く」を押してください'
const MSG_PRESS = '入力欄の上の『ノートを開く』を押してください。'
const MSG_AGAIN = 'もう一度「ノートを開く」を押してください。'
const TOOL_FAILED = `${PRODUCT}のツールが答えを返せませんでした（途中で止まったか、時間がかかりすぎました）。もう一度試してください。`
const MSG_LEGACY = '古い開発用のサーバーが動いています。このフォルダーのチャットをすべて閉じると入れ替わります'
const MSG_NEWER = `新しいバージョンの${PRODUCT}が入っています。新しいチャットを開いてください`
const REPLACE_WHY: Record<'refused' | 'failed' | 'timeout', string> = {
  refused: 'サーバーに断られました',
  failed: '止める指示が届きませんでした',
  timeout: '20秒たっても止まりませんでした',
}
const replaceFailed = (why: string) => `古いバージョンのサーバーを入れ替えられなかったので、そのまま使っています（${why}）`

export type { ToolContext } from './tools'
type Timer = { cancel: () => void }

// Modが外とやり取りする口。$ はここ（ioFor）でだけ使う。
// validate の決まりで、$ は「$.名前.動き(...)」か、名前で呼ぶ関数に渡す形でしか書けないため。
export type Io = {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => Timer
  every: (ms: number, fn: () => void) => Timer
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  root: () => Promise<string>
  surfaces: () => Promise<readonly string[]>
  sessionId: () => Promise<string>
  registerNote: () => Promise<unknown>
  registerNotedock: () => Promise<unknown>
  submit: (text: string) => Promise<any>
  hostInfo: () => Promise<HostInfo | { problem: string }>
  canonicalRoot: (raw: string) => Promise<string | null>
  makeStateDir: (host: HostInfo) => Promise<number>
  readOpened: (host: HostInfo) => Promise<Record<string, OpenedEntry>>
  markOpened: (host: HostInfo, key: string, patch: Partial<OpenedEntry>) => Promise<void>
  installedBinary: (host: HostInfo) => Promise<string | { problem: string } | null>
  ensureBinary: (host: HostInfo) => Promise<{ bin: string } | { problem: string }>
  removeOldVersions: (host: HostInfo) => Promise<boolean | void> // false＝消せないフォルダーがあった
  superseded: (host: HostInfo) => Promise<boolean> // 自分のファイルが無く、新しいバージョンのフォルダーがある
  requestShutdown: (host: HostInfo, vaultId: string, version: string) => Promise<ShutdownResult>
  readHandover: (host: HostInfo, vaultId: string) => Promise<{ to: string; at: number } | null>
  vaultIdOf: (bin: string, root: string) => Promise<string | null>
  findRunning: (host: HostInfo, vaultId: string) => Promise<Running | null>
  startServer: (host: HostInfo, bin: string, root: string, vaultId: string) => Promise<Started>
  readServerInfo: (host: HostInfo, vaultId: string) => Promise<ServerInfo | null>
  setBand: (band: Band) => Promise<void>
  registerTools: (ctx: ToolContext) => Promise<ToolFailure[] | void> // 断られたツールの名前と理由（空なら全部登録できた）
  claimChat: (vaultDir: string, sessionId: string, os: Os, since?: number) => Promise<void>
  releaseChat: (vaultDir: string, sessionId: string, os: Os) => Promise<void>
  shareIsOn: (vaultDir: string, os: Os) => Promise<boolean>
  exists: (path: string) => Promise<boolean>
  messages: () => Promise<readonly any[]>
  fill: (text: string) => Promise<unknown> // 入力欄の今のカーソルの位置に入れる
  sendAsUser: (text: string) => Promise<any> // 本人の発言として送る（エディターのチャット欄から）
  move: (host: HostInfo, from: string, to: string) => Promise<number> // 差し替える（終了コード）
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text: string }>
}

const bandAtom = atom({ plugin: 'notedock', key: 'band' } as const, null)

// テストでは over で、ダウンロード・起動・帯などを代役に差し替える。
export function ioFor($: Host, over: Partial<Io> = {}): Io {
  const io: Io = {
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    every: (ms, fn) => $.clock.every(ms, fn),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    root: () => $.session.root(),
    surfaces: () => $.session.surfaces(),
    sessionId: () => $.session.id(),
    registerNote: () => $.command.register({ name: 'note', description: 'ノートをNoteDockで開くリンクを出す（例: /note Home.md）', argumentHint: '[ノートの場所]' }),
    registerNotedock: () => $.command.register({ name: 'notedock', description: 'ノートをNoteDockで開くリンクを出す（例: /notedock Home.md）', argumentHint: '[ノートの場所]' }),
    submit: text => $.prompt.submit({ text }),
    hostInfo: () => hostInfo($),
    canonicalRoot: raw => canonicalRoot($, raw),
    makeStateDir: async host => (await runCmd($, makeStateDirCmd(host))).exitCode,
    readOpened: host => readOpened($, host),
    markOpened: (host, key, patch) => markOpened($, host, key, patch),
    installedBinary: host => installedBinary($, host),
    ensureBinary: host => ensureBinary($, host, () => {}),
    removeOldVersions: host => removeOldVersions($, host),
    superseded: host => onlyNewerInstalled($, host),
    requestShutdown: (host, id, version) => requestShutdown($, host, id, version),
    readHandover: (host, id) => readHandover($, host, id),
    vaultIdOf: (bin, root) => vaultIdOf($, bin, root),
    findRunning: (host, id) => findRunning($, host, id),
    startServer: (host, bin, root, id) => startServer($, host, bin, root, id),
    readServerInfo: (host, id) => readServerInfo($, host, id),
    setBand: band => update($, bandAtom, () => band),
    registerTools: ctx => registerTools($, ctx),
    claimChat: (dir, sessionId, os, since) => claimChat($, dir, sessionId, os, since),
    releaseChat: (dir, sessionId, os) => releaseChat($, dir, sessionId, os),
    shareIsOn: (dir, os) => shareIsOn($, dir, os),
    exists: path => $.fs.exists(path),
    messages: () => $.session.messages(),
    fill: text => $.prompt.fill({ text, mode: 'insert' }),
    sendAsUser: text => $.prompt.submit({ text, asUser: true }),
    move: async (host, from, to) => (await runCmd($, moveCmd(host, from, to))).exitCode,
    fetch: (url, init) => $.http.fetch(url, init),
  }
  return { ...io, ...over }
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

// /note の場所を、Vaultのフォルダーから見た場所（区切りは /）に直す。/ と \ の両方を区切りとみなす。
export function notePathFrom(args: string, root: string, os: Os): string {
  const typed = args.trim().replace(/^["']|["']$/g, '')
  if (!typed) return ''
  const parts = (p: string) => p.split(/[\\/]+/).filter(Boolean)
  const same = (a: string, b: string) => (os === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  const t = parts(typed)
  const r = parts(root)
  const absolute = /^([\\/]|[A-Za-z]:)/.test(typed)
  if (absolute && t.length > r.length && r.every((p, i) => same(p, t[i]))) return t.slice(r.length).join('/')
  return t.join('/')
}

// 帯の中身。このビルドでは帯はプラグインごとに1行で、並べるのはエンジン（AbovePromptList）。このModの行だけを返す。
export function bandTree(band: Exclude<Band, null>, ui: any, press: (today: boolean) => void): unknown {
  const { Box, Button, Markdown } = ui
  const open = (today: boolean) =>
    Button({ key: today ? 'notedock-today' : 'notedock-open', label: today ? '今日のノート' : 'ノートを開く', onPress: () => press(today) })
  const note = (text: string) => Markdown({ key: 'notedock-band', text, dimColor: true })
  let row: unknown[]
  switch (band.kind) {
    case 'button':
      row = band.today ? [open(false), open(true)] : [open(false)]
      break
    case 'preparing':
      row = [note('準備しています…（初めてのときは、約80MBをダウンロードします）')]
      break
    case 'starting':
      row = [note('NoteDockを起動しています…')]
      break
    case 'opening':
      row = [note('開いています…（Claudeの作業が終わると開きます）')]
      break
    case 'replacing':
      row = [note('新しいバージョンに入れ替えています…')]
      break
    case 'problem':
      row = band.button ? [note(band.text), open(false)] : [note(band.text)]
      break
  }
  return Box({ key: 'notedock-row', flexDirection: 'row', gap: 1, children: row })
}

type Base =
  | { kind: 'skip' } // 何もしない（場所をたどれない、ホームなど）
  | { kind: 'problem'; text: string } // 帯に理由だけを出す
  | { kind: 'ok'; host: HostInfo; root: string; key: string }

// Modが送った「開いてください」の頼み。
type Sent = {
  text: string
  at: number
  today: boolean
  turnId: string | null
  turnStart: number // 0＝まだ取りかかっていない
  confirmed: boolean // turn.start で番が始まったのを見た（submit が返った時刻は仮）
  retried: boolean
  req: number // どの押した回の頼みか
}

// version は、このModのバージョン（テストでは差し替える）。サーバーを入れ替えるかどうかを、これと比べて決める。
export function createNotedock(opts: { version?: string } = {}) {
  const mine = opts.version ?? VERSION
  let io: Io = null as unknown as Io // session.start で受け取る。裏の処理はこれを使う
  let basePromise: Promise<Base> | null = null
  let base: Base | null = null
  let stage: 'init' | 'waitScreen' | 'noScreen' | 'screen' | 'off' = 'init'
  let attached = false
  let commandProblem: string | null = null
  let req = 0 // 押した回の番号。古い回の結果で今の帯を書き換えないため
  let activateP: Promise<boolean> | null = null
  let screenTimer: { cancel: () => void } | null = null

  // 見張りを始めたあとの状態
  let vaultId: string | null = null
  let active = false
  let toolsDone = false
  let toolCtx: ToolContext | null = null // ツールを登録したときの場所。登録する前は null（呼ばれても何もしない）
  let toolProblem: string | null = null // ツールを登録できなかった理由。/note の返事に添える
  let toolsBusy = false
  let lastToolTry = 0
  let cleaned = false // 古いバージョンのフォルダーを消し終えた
  let cleanBusy = false
  let cleanSince = 0 // 消し始めた時刻（0は、まだ消そうとしていない）。ここから2分は10秒おき、そのあとは10分おきに消し直す
  let stopWindowUntil = 0 // 止める指示が通ったあと、この時刻までは、自分のバージョンが動いていなくても消し直す
  let mineRunning = false // 最後に見張りが見たのが、自分のバージョンのサーバー
  let lastClean = 0
  let replaceNote: { text: string; until: number } | null = null // 入れ替えの案内（10分だけ）。until 0 は、次に描くときに決める
  let superseded = false // 新しいバージョンのModが入っている（自分のファイルが無い）。新しいチャットを案内する
  // チャットが始まったときから、自分のファイルが無く新しいバージョンのフォルダーがあった。新しいバージョンを入れたあとで
  // 古いModに戻した（作業場所の開発用のModも同じ）とみなし、このチャットでは案内を出さず、いつもどおりダウンロードして使う。
  // 始まったチャットには入れてあるModが読み込まれ、開いているチャットは、読み込み直すまで前のModのまま（公式の説明）。
  let startedSuperseded = false
  let watcher: ReturnType<typeof createWatcher> | null = null
  let watchState: WatchState | null = null
  let tickBusy = false
  let today = false
  let lastTick = 0
  let lastSettings = 0
  let lastOpened = 0
  let lastNeed = 0
  let needSeen = 0 // 最後に見た need-ticket.json の at
  let needBusy = false

  // 帯
  let baseBand: Band = null // 見張りを始める前の帯
  let pressStage: 'preparing' | 'starting' | 'opening' | null = null
  let notice: { band: Band; until: number } | null = null
  let busy = false // 押したあと、button か problem に戻るまで true（二度押しを受け付けない）
  let queued: { today: boolean; req: number } | null = null
  let shown = 'null'
  let sent: Sent | null = null

  // チャット欄。話し相手（chat-owner.json に書かれたチャット）だけが、送る・引用・会話の記録を受け持つ。
  let sessionId = ''
  let chatDir: string | null = null // Vault別フォルダーがあると確かめた場所
  let chatInitP: Promise<void> | null = null
  let lastAsk = 0 // 最後に見た引用の頼み（askChat）の時刻
  let lastSend = 0 // 最後に見た送る文（sendChat）の時刻
  let lastReplied = 0 // 返事（または送れなかったこと）を書き終えた送る文の時刻
  let pending: { text: string; at: number } | null = null // 送ったが、まだ番が始まっていない文
  let chatTurn: { turnId: string; at: number } | null = null // 送った文で始まった番
  let working: { since: number } | null = null // Claudeの作業中
  let logDirty = true
  let logWritten = 0
  let lastChat = 0
  let chatBusy = false
  let claimWanted = 0 // 準備が終わる前に本人が発言した時刻。準備が終わったら、この時刻で相手になる（0は無し）

  const now = async (): Promise<number> => io.now()
  const delay = (ms: number) => new Promise<void>(resolve => io.after(ms, () => resolve()))
  const vaultDir = () => (base?.kind === 'ok' && vaultId ? vaultDirOf(base.host, vaultId) : null)

  async function readJson(path: string): Promise<any> {
    try {
      return JSON.parse(await io.read(path))
    } catch {
      return null
    }
  }

  // open-pending.json：画面が「開き直しています…」を出すかどうかに使う。秘密は書かない。
  async function writePending(until: number): Promise<void> {
    const dir = vaultDir()
    if (!dir || base?.kind !== 'ok') return
    try {
      await io.write(joinPath(base.host.os, dir, 'open-pending.json'), JSON.stringify({ until }))
    } catch {
      // 書けなくても開く処理は続ける。画面はいつもの文を出す。
    }
  }

  // 今の状態から帯を決めて、変わったときだけ書く。
  async function render(): Promise<void> {
    if (stage !== 'screen') return
    const t = await now()
    if (notice && t >= notice.until) notice = null
    if (replaceNote && replaceNote.until === 0) replaceNote.until = t + HINT_MS
    if (replaceNote && t >= replaceNote.until) replaceNote = null
    const guide: Band = { kind: 'problem', text: MSG_NEWER, button: false }
    let band: Band
    // 押したあと、入れ替えを待っているあいだは、起動中ではなく入れ替え中と出す。
    if (pressStage === 'starting' && watchState?.kind === 'replacing') band = superseded ? guide : { kind: 'replacing' }
    else if (pressStage) band = { kind: pressStage }
    else if (notice) band = notice.band
    else if (active && watchState) {
      if (watchState.kind === 'running') band = replaceNote ? { kind: 'problem', text: replaceNote.text, button: true } : { kind: 'button', today }
      else if (superseded) band = guide
      else if (watchState.kind === 'stopped') band = { kind: 'problem', text: watchState.problem, button: true }
      else if (watchState.kind === 'replacing') band = { kind: 'replacing' }
      else band = { kind: 'starting' } // 起動中と、失敗のあとに少し待っているとき
    } else band = superseded ? guide : baseBand
    const s = JSON.stringify(band)
    if (s === shown) return
    shown = s
    await io.setBand(band)
  }

  function getBase(): Promise<Base> {
    basePromise ??= (async (): Promise<Base> => {
      const host = await io.hostInfo()
      if ('problem' in host) return { kind: 'problem', text: host.problem }
      const raw = String((await io.root()) ?? '')
      // $.fs はネットワーク上の場所を断るので、canonicalRoot より先に見る。
      if (raw.startsWith('\\\\') || raw.startsWith('//')) return { kind: 'problem', text: MSG_NETWORK }
      const root = await io.canonicalRoot(raw)
      if (!root) return { kind: 'skip' }
      const why = refusedReason(root, host)
      if (why === 'network') return { kind: 'problem', text: MSG_NETWORK }
      if (why === 'broad') return { kind: 'skip' }
      return { kind: 'ok', host, root, key: rootKey(root, host.os) }
    })().then(b => (base = b))
    return basePromise
  }

  async function hasScreen(): Promise<boolean> {
    try {
      return (await io.surfaces()).length > 0
    } catch {
      return false
    }
  }

  // 裏の処理の始まり。session.start から $.clock.after(0) で呼ぶ。
  async function boot(): Promise<void> {
    const b = await getBase()
    if (b.kind === 'skip') {
      stage = 'off'
      return
    }
    if (attached || (await hasScreen())) return onScreen()
    stage = 'waitScreen'
    const started = await now()
    screenTimer = io.every(LOOP_MS, () => {
      void (async () => {
        if (stage !== 'waitScreen') return
        if (await hasScreen()) return onScreen()
        if ((await now()) - started >= SCREEN_WAIT_MS) {
          // 画面のないチャット。あとで session.attach が来たら続ける。
          stage = 'noScreen'
          claimWanted = 0 // 画面のないチャットへの発言は、本人が画面で打ったものではない
          screenTimer?.cancel()
        }
      })().catch(() => {})
    })
  }

  async function onScreen(): Promise<void> {
    if (stage === 'screen' || stage === 'off') return
    stage = 'screen'
    screenTimer?.cancel()
    const b = base!
    if (b.kind === 'problem') {
      baseBand = { kind: 'problem', text: b.text, button: false }
      return render()
    }
    if (b.kind !== 'ok') return
    io.every(LOOP_MS, () => {
      void step().catch(() => {})
    })
    baseBand = { kind: 'button', today: false }
    lastOpened = await now()
    // /note と /notedock を登録できなかった理由は、10分だけ出す。そのあとは、いつもの帯に戻す。
    if (commandProblem) notice = { band: { kind: 'problem', text: commandProblem, button: true }, until: lastOpened + HINT_MS }
    try {
      startedSuperseded = await io.superseded(b.host)
    } catch {
      startedSuperseded = false
    }
    const opened = await io.readOpened(b.host)
    if (opened[b.key]) {
      const have = await io.installedBinary(b.host)
      if (typeof have === 'string') await activate(have)
      else if (have) baseBand = { kind: 'problem', text: have.problem, button: true }
    }
    await render()
  }

  // サーバーのファイルがあるとき：Vaultを調べ、ツールを登録し、見張りを始める。
  function activate(file: string): Promise<boolean> {
    if (active) return Promise.resolve(true)
    // 押したときと、30秒ごとの見直しが重なっても、同じ処理の結果を待つ。
    activateP ??= activateOnce(file).finally(() => (activateP = null))
    return activateP
  }

  async function activateOnce(file: string): Promise<boolean> {
    if (base?.kind !== 'ok') return false
    {
      const host = base.host
      const root = base.root
      const id = await io.vaultIdOf(file, root)
      if (!id) {
        baseBand = { kind: 'problem', text: `サーバーのファイルからVaultを調べられませんでした。${MSG_AGAIN}`, button: true }
        return false
      }
      vaultId = id
      // ツールは、画面のあるチャットで、押したことのあるフォルダーのときだけ登録する（ここに来るのはそのときだけ）。
      if (!toolCtx) {
        toolCtx = { host, root, vaultId: id }
        await tryTools() // 登録できなくても、見張りは始める。裏の処理が30秒ごとに登録し直す
      }
      watcher = createWatcher({
        find: () => io.findRunning(host, id),
        // 新しいバージョンに譲ったあと10分は、起動し直さない（新しいバージョンのサーバーを待つ）。
        // 自分のファイルが片づけられていれば、起動せずに新しいチャットを案内する。
        start: async (): Promise<Started> => {
          if (await handoverHeld(host, id)) return { held: true }
          if (await nowSuperseded(host)) {
            superseded = true
            return { held: true }
          }
          return io.startServer(host, file, root, id)
        },
        now: () => io.now(),
        after: (ms, fn) => io.after(ms, fn),
        version: mine,
        shutdown: () => io.requestShutdown(host, id, mine),
        onReplace: replaced,
      })
      needSeen = Number((await readJson(joinPath(host.os, vaultDirOf(host, id), 'need-ticket.json')))?.at) || 0
      active = true
      lastTick = lastSettings = await now()
      void tick()
      void readToday()
      return true
    }
  }

  // ツールを登録する。全部登録できたときだけ toolsDone にする。断られたら理由を覚え、/note の返事に添える。
  async function tryTools(): Promise<void> {
    if (toolsDone || !toolCtx || toolsBusy) return
    toolsBusy = true
    try {
      lastToolTry = await now()
      let failed: ToolFailure[]
      try {
        failed = (await io.registerTools(toolCtx)) ?? []
      } catch (e) {
        failed = [{ name: 'set_appearance・set_vault_settings', reason: errorText(e) }]
      }
      if (failed.length === 0) {
        toolsDone = true
        toolProblem = null
      } else {
        const list = failed.map(f => `${f.name}（${f.reason}）`).join('、')
        toolProblem = `Claudeが使う${PRODUCT}のツールを登録できませんでした：${list}。30秒ごとに登録し直しています。`
      }
    } finally {
      toolsBusy = false
    }
  }

  async function tick(): Promise<void> {
    if (!watcher || tickBusy) return
    tickBusy = true
    try {
      watchState = await watcher.tick(await now())
      afterWatch(watchState)
      await render()
    } finally {
      tickBusy = false
    }
  }

  async function handoverHeld(host: HostInfo, id: string): Promise<boolean> {
    try {
      return handoverHolds(await io.readHandover(host, id), mine, await now())
    } catch {
      return false
    }
  }

  // チャットの途中で、自分のファイルが無く新しいバージョンのフォルダーがある状態になったか（新しいバージョンのModが入れ替えて、
  // 片づけた）。始まったときからその状態だったチャットでは、案内しない（startedSuperseded）。
  async function nowSuperseded(host: HostInfo): Promise<boolean> {
    if (startedSuperseded) return false
    try {
      return await io.superseded(host)
    } catch {
      return false
    }
  }

  // 見張りが見たサーバーのバージョンで、案内と片づけを決める。
  // 自分と同じか新しいバージョンが動いていれば、入れ替えの失敗の案内は消す（ほかのチャットが入れ替えた）。
  // 自分のバージョンが動いているのを確かめたときだけ、古いバージョンのフォルダーを消す（step が、決まった間隔で消し直す）。
  function afterWatch(st: WatchState): void {
    const v = st.kind === 'running' ? st.running.version : null
    const c = typeof v === 'string' && VERSION_RE.test(v) ? compareVersions(v, mine) : null
    mineRunning = c === 0
    if (c !== null && c >= 0) {
      replaceNote = null
      superseded = false
    }
  }

  // 入れ替えの知らせ。見張りの中から呼ばれるので、待たずに返る。
  function replaced(e: ReplaceEvent): void {
    if (e.kind === 'failed') replaceNote = { text: replaceFailed(REPLACE_WHY[e.reason]), until: 0 }
    else if (e.kind === 'legacy') replaceNote = { text: MSG_LEGACY, until: 0 }
    else {
      // 止める指示が通った。止まるのを待たずに、古いバージョンのフォルダーを消す（消し直しの間隔も、ここから数え直す）。
      cleaned = false
      void (async () => {
        const t = await now()
        cleanSince = t
        stopWindowUntil = t + CLEAN_RETRY_LIMIT_MS
        lastClean = t
        await clean()
      })().catch(() => {})
    }
  }

  async function clean(): Promise<void> {
    if (cleanBusy || base?.kind !== 'ok') return
    cleanBusy = true
    try {
      let ok: boolean
      try {
        ok = (await io.removeOldVersions(base.host)) !== false
      } catch {
        ok = false
      }
      if (ok) {
        cleaned = true
        cleanSince = 0
        stopWindowUntil = 0
      }
    } finally {
      cleanBusy = false
    }
  }

  async function readToday(): Promise<void> {
    const dir = vaultDir()
    if (!dir || base?.kind !== 'ok') return
    const root = (await readJson(joinPath(base.host.os, dir, 'settings.json')))?.periodic?.root
    today = typeof root === 'string' && root.trim() !== ''
    await render()
  }

  // まだ見張っていないフォルダー：ほかのチャットで押されて、ファイルも置かれたら見張りを始める。
  async function pollOpened(): Promise<void> {
    if (base?.kind !== 'ok' || active || busy) return // 押した処理の最中は、押した処理に任せる
    const opened = await io.readOpened(base.host)
    if (!opened[base.key]) return
    const have = await io.installedBinary(base.host)
    if (typeof have === 'string' && (await activate(have))) await render()
  }

  function inWindow(s: Sent, t: number): boolean {
    return s.confirmed ? t <= s.turnStart + RETRY_WINDOW_MS : t < s.at + OPEN_WAIT_MS
  }

  // need-ticket.json を見る。頼んだ番の窓の中なら1回だけ頼み直す。窓の外なら案内だけを出す。
  async function checkNeed(t: number): Promise<void> {
    const dir = vaultDir()
    if (!dir || base?.kind !== 'ok') return
    const need = await readJson(joinPath(base.host.os, dir, 'need-ticket.json'))
    const at = Number(need?.at) || 0
    if (at <= needSeen) return
    needSeen = at
    // hadKey: false は、画面が鍵の無い場所で開かれただけ（Claudeが preview_start で鍵の無い場所を読んでから
    // 鍵付きの場所へ移る、ふつうの開き方の途中でも起きる）。開くのに失敗したのではないので、窓の中でも外でも、
    // 頼み直しにも案内にも使わない（帯も変えない）。
    // hadKey の無い need-ticket.json（hadKey を書く前のサーバー）は、前と同じく「鍵を断られた」とみなす。
    // こうしておけば、サーバーが古いままでも頼み直しが黙って止まることはない。
    if (need?.hadKey === false) return
    if (sent && inWindow(sent, t)) {
      if (sent.turnStart && at > sent.turnStart && !sent.retried) await retry(sent)
      return // 窓の中では、何度来ても、ほかには何もしない
    }
    const until = Number((await readJson(joinPath(base.host.os, dir, 'open-pending.json')))?.until) || 0
    if (until > t) return // ほかのチャットが頼んでいるところ
    // よそから送られても、Claudeが勝手に動かないよう、頼まずに案内だけを出す。
    notice = { band: { kind: 'problem', text: MSG_HINT, button: true }, until: t + HINT_MS }
    await render()
  }

  // 頼み直しは1回だけ。そのときの鍵を読む（Claudeの作業で待たされて、鍵が切れていた場合のため）。
  async function retry(s: Sent): Promise<void> {
    s.retried = true
    const info = base?.kind === 'ok' && vaultId ? await io.readServerInfo(base.host, vaultId) : null
    // 鍵が読めなければ頼めない。開いている途中の帯を終わらせ、押し直してもらう（fail が open-pending も0にする）。
    if (!info?.ticket) return fail(MSG_HINT, s.req)
    submit(retryPrompt({ port: info.port, ticket: info.ticket, today: s.today }), s.req, () => {})
    await writePending(0)
  }

  // Claudeに頼む（asUser は付けない。Modからの依頼として届ける）。
  // 返るのはClaudeが取りかかったとき、または作業中の番のうしろに並んだとき（だから時刻は仮）。
  // drop か失敗なら帯に理由を出す。r は押した回の番号。古い回の結果は捨てる。
  function submit(text: string, r: number, onStart: (t: number) => void | Promise<void>): void {
    let p: Promise<any>
    try {
      p = Promise.resolve(io.submit(text))
    } catch (e) {
      p = Promise.reject(e)
    }
    p.then(
      async result => {
        if (result && typeof result === 'object' && result.drop) return fail(`Claudeに頼めませんでした（${result.drop}）`, r)
        if (r === req) await onStart(await now())
      },
      error => fail(`Claudeに頼めませんでした（${errorText(error)}）`, r),
    ).catch(() => {})
  }

  async function fail(text: string, r: number = req): Promise<void> {
    if (r !== req) return // 古い回の結果
    pressStage = null
    busy = false
    // 頼めなかったので、画面やほかのチャットが「開き直しています」と15分待たないよう、期限を消す。
    if (sent?.req === r) {
      sent = null
      await writePending(0)
    }
    notice = { band: { kind: 'problem', text, button: true }, until: (await now()) + HINT_MS }
    await render()
  }

  // submit が返った時刻は仮に使うだけ。turn.start で番が始まったのを見たら、その時刻で数え直す。
  async function markTurnStarted(s: Sent, t: number, confirmed: boolean): Promise<void> {
    if (s.confirmed) return
    if (!confirmed && s.turnStart) return
    s.turnStart = Math.max(s.turnStart, t)
    s.confirmed = confirmed
    if (sent === s) await writePending(s.turnStart + RETRY_WINDOW_MS)
  }

  // 新しいチャットを案内する帯にして、押した処理を終える（ダウンロードはしない）。
  async function showSuperseded(r: number): Promise<void> {
    if (r !== req) return
    superseded = true
    pressStage = null
    busy = false
    await render()
  }

  async function finishOpening(): Promise<void> {
    if (pressStage !== 'opening') return
    pressStage = null
    busy = false
    await render()
  }

  // 押したあとの処理。ボタンのフックの外（裏の処理）で動く。
  async function pressWork(pressedToday: boolean, r: number): Promise<void> {
    if (base?.kind !== 'ok') return fail('このフォルダーでは使えません', r)
    const host = base.host
    try {
      if ((await io.makeStateDir(host)) !== 0) return fail(`保存フォルダーを作れませんでした。${MSG_AGAIN}`, r)
      await io.markOpened(host, base.key, { at: await now() })
      // 新しいバージョンのModが入っている、または新しいバージョンに譲ったばかりのときは、ダウンロードしない。
      // 置いてある自分のファイルか、動いている新しいバージョンのサーバーだけを使う。
      let file: string | null = null
      const hold = (await nowSuperseded(host)) || (vaultId !== null && (await handoverHeld(host, vaultId)))
      if (hold) {
        if (!active) {
          const have = await io.installedBinary(host)
          if (typeof have !== 'string') return showSuperseded(r)
          file = have
        }
      } else {
        const got = await io.ensureBinary(host)
        if ('problem' in got) return fail(got.problem, r)
        file = got.bin
      }
      if (file !== null && !(await activate(file))) return fail(`サーバーのファイルからVaultを調べられませんでした。${MSG_AGAIN}`, r)
      if (r !== req) return
      pressStage = 'starting'
      await render()
      // 押す前から動いていた見張りの1回が終わるのを待つ（その古い結果を使わないため）。
      for (let i = 0; tickBusy && i < 150; i++) await delay(1000)
      if (r !== req) return
      watcher!.reset()
      const limit = (await now()) + RUN_WAIT_MS
      let st: WatchState
      for (;;) {
        st = await watcher!.tick(await now())
        if (r !== req) return
        watchState = st
        afterWatch(st)
        if (superseded && st.kind !== 'running') return showSuperseded(r)
        await render()
        if (st.kind === 'running' || st.kind === 'stopped' || (await now()) >= limit) break
        await delay(1000)
      }
      if (r !== req) return
      watchState = st
      if (st.kind !== 'running') return fail(st.kind === 'stopped' ? st.problem : `NoteDockのサーバーが動き出しませんでした。${MSG_AGAIN}`, r)
      // 鍵は、その時点の server.json から読む。
      const info = await io.readServerInfo(host, vaultId!)
      const text = openPrompt({ port: info?.port ?? st.running.port, ticket: info?.ticket ?? st.running.ticket ?? null, today: pressedToday })
      const at = await now()
      await writePending(at + OPEN_WAIT_MS) // 頼む直前に書く
      if (r !== req) return
      const s: Sent = { text, at, today: pressedToday, turnId: null, turnStart: 0, confirmed: false, retried: false, req: r }
      sent = s
      pressStage = 'opening'
      await render()
      submit(text, r, t => markTurnStarted(s, t, false))
    } catch (e) {
      return fail(`開けませんでした（${errorText(e)}）`, r)
    }
  }

  // Vault別フォルダーの中のファイル。区切りはこのチャットのOSで決める。
  const os = (): Os => (base?.kind === 'ok' ? base.host.os : 'darwin')
  const cf = (dir: string, name: string) => chatFile(os(), dir, name)

  // 話し相手の印を読み直し、このチャットのものか確かめる。書く・送る直前に呼ぶ（ほかのチャットが移したばかりの印を上書きしないため）。
  async function ownerNow(dir: string, me: string): Promise<{ session?: string; at?: number } | null> {
    const current = await readJson(cf(dir, 'chat-owner.json'))
    return me !== '' && current?.session === me ? current : null
  }

  async function mySession(): Promise<string> {
    if (!sessionId) sessionId = String((await io.sessionId()) ?? '')
    return sessionId
  }

  // チャット欄を使える場所。画面のあるチャットで、Vaultが分かっていて、Vault別フォルダーがある（サーバーが一度動いた）ときだけ。
  // ほかのVaultのファイルは読まない、書かない。
  async function chatReady(): Promise<string | null> {
    if (stage !== 'screen' || base?.kind !== 'ok' || !vaultId) return null
    const dir = vaultDirOf(base.host, vaultId)
    if (chatDir !== dir) {
      try {
        if (!(await io.exists(dir))) return null
      } catch {
        return null
      }
      chatDir = dir
    }
    // 読み込んだときに残っていた頼みは、もう済んだものとみなす。
    chatInitP ??= (async () => {
      const state = (await readJson(cf(dir, 'current-note.json'))) as EditorState | null
      lastAsk = Number(state?.askChat?.at) || 0
      lastSend = Number(state?.sendChat?.at) || 0
      lastReplied = Number((await readJson(cf(dir, 'chat-reply.json')))?.for) || 0
    })()
    await chatInitP
    return dir
  }

  // 準備が終わる前に本人が発言していたら、ここで相手になる。ただし、そのあとにほかのチャットで
  // 本人が発言して相手が移っていたら（印の since がこちらの発言より新しければ）、取らない。
  // 期限は付けない（発言してから「ノートを開く」を押すまで、人の時間がかかることがあるため）。
  // あとから別のチャットで本人が発言していれば、since の比べ合いで負けるので、取るのは最後に本人が打ったチャットだけ。
  async function claimLater(dir: string, me: string): Promise<void> {
    if (!me) return // チャットの番号がまだ分からない。覚えたまま、次の見回りでやり直す
    const said = claimWanted
    claimWanted = 0
    const cur = (await readJson(cf(dir, 'chat-owner.json'))) as { session?: string; at?: number; since?: number } | null
    if (cur?.session === me) return
    // since の無い印（前の版のModが書いたもの）は、いつ相手になったかが分からないので、取る側に倒す。
    // at は10秒ごとに書き直されるので、比べると、生きている前の版の相手からはいつまでも取れなくなるため。
    const theirs = Number(cur?.since) || 0
    if (cur?.session && theirs >= said) return
    await io.claimChat(dir, me, os(), said)
  }

  async function failReply(dir: string, at: number, why: string): Promise<void> {
    try {
      await io.write(cf(dir, 'chat-reply.json'), JSON.stringify({ for: at, text: `チャットへ送れませんでした。（${why}）`, failed: true, at: await now() }))
    } catch {
      // 書けなければ、エディターは待つのをやめるボタンで抜けられる。
    }
  }

  // チャット欄の見回りの1回分（今のModの見回りと同じ動き）。自分から話し相手になることはしない。
  async function chatStep(t: number): Promise<void> {
    const dir = await chatReady()
    if (!dir || base?.kind !== 'ok') return
    if (working && t - logWritten > LOG_BEAT_MS) logDirty = true
    const me = await mySession()
    if (claimWanted) await claimLater(dir, me)
    const owner = (await ownerNow(dir, me)) !== null
    // 印が自分のもので古ければ書き直す（スリープ明けで10秒以上あいたときも）。これは引き継ぎではない。
    // ほかのチャットの印は、古くても書き換えない。書く直前にもう一度読み、移っていれば何もしない。
    if (owner) {
      const mine = await ownerNow(dir, me)
      if (mine && t - (Number(mine.at) || 0) > OWNER_BEAT_MS) await io.claimChat(dir, me, os(), Number((mine as { since?: number }).since) || undefined)
    }
    if (owner && logDirty && t - logWritten >= LOG_MIN_MS) {
      logDirty = false
      logWritten = t
      try {
        // Claudeへの「開いて」の頼みには鍵付きのURLが入るので、書く前に鍵を消す（誰の発言でも）。
        const items = summarizeTranscript(await io.messages()).map(item => ({ ...item, text: hideKeys(item.text) }))
        // タイトルは読まない（記録ファイルを読むコマンドを使わないため）。エディターはフォルダーの名前を出す。
        await io.write(cf(dir, 'chat-log.json'), JSON.stringify({ working: working?.since ?? 0, items, project: baseName(base.root), title: '', at: t }))
      } catch {
        // 書けなくても、次に会話が動いたときにもう一度書く。
      }
    }
    const state = (await readJson(cf(dir, 'current-note.json'))) as EditorState | null
    if (state?.askChat && state.askChat.at > lastAsk) {
      lastAsk = state.askChat.at
      if (owner) {
        try {
          await io.fill(quoteForPrompt(String(state.askChat.text ?? '')))
        } catch {
          // 入れられなければ、それまで。
        }
      }
    }
    if (state?.sendChat && state.sendChat.at > lastSend) {
      lastSend = state.sendChat.at
      if (!owner || !(await ownerNow(dir, me))) return // 送る直前に、まだ話し相手か確かめる
      const typed = String(state.sendChat.text ?? '').slice(0, MAX_TEXT)
      const at = state.sendChat.at
      // Modが送る文には、Mod自身の prompt.submit フックが呼ばれない（呼んだプラグインのフックは通らず、context も渡せない）。
      // そこで、切り替えがオンなら、開いているノートの短い案内を文の末尾に足す（打った文と選んだ文字の上限はそれぞれ守る）。
      const note = (await io.shareIsOn(dir, base.host.os)) ? noteForSend(state, t, base.root, base.host.os) : null
      const text = withNote(typed, note)
      pending = { text, at }
      // Claudeが作業中なら、終わってから送られる。
      let p: Promise<any>
      try {
        p = Promise.resolve(io.sendAsUser(text))
      } catch (e) {
        p = Promise.reject(e)
      }
      p.then(
        async result => {
          if (!(result && typeof result === 'object' && result.drop)) return
          if (pending?.at === at) pending = null
          lastReplied = at
          await failReply(dir, at, String(result.drop))
        },
        async error => {
          if (pending?.at === at) pending = null
          lastReplied = at
          await failReply(dir, at, errorText(error))
        },
      ).catch(() => {})
    }
  }

  // 番が始まった。送った文で始まった番を覚える（中身で見分ける）。
  async function chatTurnStart(e: { text: string; turnId: string }): Promise<void> {
    working = { since: await now() }
    logDirty = true
    const dir = await chatReady()
    if (!dir) return
    // 送った文の目印は、Modを読み込み直すと消える。そのときはエディターが書いた送る文と照らし合わせる。
    if (!pending) {
      const asked = ((await readJson(cf(dir, 'current-note.json'))) as EditorState | null)?.sendChat
      if (asked && asked.at > lastReplied) pending = { text: String(asked.text ?? '').slice(0, MAX_TEXT), at: asked.at }
    }
    if (!pending) return
    if (isSentText(String(e.text ?? ''), pending.text)) {
      chatTurn = { turnId: e.turnId, at: pending.at }
      pending = null
    } else if ((await now()) - pending.at > CHAT_RECENT_MS) {
      pending = null
    }
  }

  // 番が終わった。送った文の番なら、返事をエディターへ渡す。
  async function chatTurnComplete(e: { turnId: string; answer?: string; reason?: string }): Promise<void> {
    working = null
    logDirty = true
    if (!chatTurn || e.turnId !== chatTurn.turnId || !chatDir) return
    const reply = { for: chatTurn.at, text: hideKeys(e.answer ?? ''), reason: e.reason, at: await now() }
    lastReplied = chatTurn.at
    chatTurn = null
    try {
      await io.write(cf(chatDir, 'chat-reply.json'), JSON.stringify(reply))
    } catch {
      // 書けなければ、エディターは待つのをやめるボタンで抜けられる。
    }
  }

  // 画面が付いた。続きはフックの外（タイマー）で始める。ダウンロードや起動を、フックの持ち時間に結び付けないため。
  function screenArrived(): void {
    attached = true
    if (stage === 'waitScreen' || stage === 'noScreen') io.after(0, () => void onScreen().catch(() => {}))
  }

  // 裏の処理の1回分。重い処理は待たずに始め、それぞれの印で重ならないようにする。
  async function step(): Promise<void> {
    const t = await now()
    if (queued) {
      const q = queued
      queued = null
      void pressWork(q.today, q.req)
    }
    if (!active && t - lastOpened >= OPENED_MS) {
      lastOpened = t
      void pollOpened().catch(() => {})
    }
    // 押した処理が自分で見張りを回すあいだ（preparing・starting）だけ止める。opening のあいだは続ける。
    const pressing = pressStage === 'preparing' || pressStage === 'starting'
    if (active && !pressing && t - lastTick >= TICK_MS) {
      lastTick = t
      void tick().catch(() => {})
    }
    if (active && toolCtx && !toolsDone && !toolsBusy && t - lastToolTry >= TOOLS_RETRY_MS) {
      void tryTools().catch(() => {})
    }
    if (active && t - lastSettings >= SETTINGS_MS) {
      lastSettings = t
      void readToday().catch(() => {})
    }
    if (active && !needBusy && t - lastNeed >= NEED_MS) {
      lastNeed = t
      needBusy = true
      void checkNeed(t)
        .catch(() => {})
        .finally(() => (needBusy = false))
    }
    if (!chatBusy && t - lastChat >= CHAT_MS) {
      lastChat = t
      chatBusy = true
      void chatStep(t)
        .catch(() => {})
        .finally(() => (chatBusy = false))
    }
    // 古いバージョンのフォルダーを消す。消すのは、止める指示が通ったあとの2分と、自分のバージョンが動いているあいだだけ。
    // 消せなければ、消し始めてから2分は10秒おき、そのあとは10分おきに消し直す（Windowsで、ほかのVaultの古いサーバーが
    // ファイルを使い続けていても、PowerShell を何度も起動しない）。
    if (!cleaned && !cleanBusy && (mineRunning || t <= stopWindowUntil)) {
      const gap = cleanSince === 0 ? 0 : t - cleanSince <= CLEAN_RETRY_LIMIT_MS ? CLEAN_RETRY_MS : CLEAN_SLOW_MS
      if (cleanSince === 0 || t - lastClean >= gap) {
        if (cleanSince === 0) cleanSince = t
        lastClean = t
        void clean().catch(() => {})
      }
    }
    if (sent && pressStage === 'opening' && t - sent.at >= OPEN_WAIT_MS) await finishOpening()
    if ((notice && t >= notice.until) || (replaceNote && replaceNote.until !== 0 && t >= replaceNote.until)) await render()
  }

  return {
    // すぐ返る。/note の登録だけをして、残りは裏の処理で行う（最初の発言を待たせない）。
    async sessionStart(given: Io): Promise<void> {
      io = given
      // 読み込み直したとき、前の帯が残らないように、まず消す。
      try {
        await io.setBand(null)
      } catch {
        // 消せなくても続ける。
      }
      // 同じModの中で session.start がもう一度来たときのため、覚えている帯もそろえ、画面があれば描き直す。
      shown = 'null'
      sessionId = '' // /clear のあとなどに変わっていれば、読み直す
      if (stage === 'screen') {
        try {
          await render()
        } catch {
          // 描けなくても、/note の登録と裏の処理は続ける。次に状態が変わったときに描き直す。
        }
      }
      // 同じ名前があると、例外にならずに置き換わることがある。返ってきた名前も確かめる。
      const named = (r: any, name: string) => r?.command === name
      try {
        if (!named(await io.registerNote(), 'note')) throw new Error('/note は別の名前で登録されました')
      } catch {
        try {
          if (!named(await io.registerNotedock(), 'notedock')) throw new Error('/notedock は別の名前で登録されました')
        } catch (e) {
          commandProblem = `/note と /notedock を登録できませんでした（${errorText(e)}）`
        }
      }
      io.after(0, () => {
        void boot().catch(() => {})
      })
    },

    // 画面なしで始まり、あとからアプリで開かれたチャットのため。
    async attach(): Promise<void> {
      screenArrived()
    },

    // ボタン。すぐ preparing にして返る。重い処理は裏の処理が拾う。
    async press(pressedToday: boolean): Promise<void> {
      if (busy || stage !== 'screen') return
      busy = true
      notice = null
      sent = null
      pressStage = 'preparing'
      queued = { today: pressedToday, req: ++req }
      await render()
    },

    // 送った文と同じ文で始まった番を、その頼みの番とみなす。
    async turnStart(e: { text: string; turnId: string; agentId?: string }): Promise<void> {
      if (e.agentId) return
      await chatTurnStart(e).catch(() => {})
      if (!sent || sent.turnId) return
      // Modからの頼みは「The notedock plugin sent a message: …」のように包まれて届くことがあるので、含むかで見る。
      if (!e.text.includes(sent.text.trim())) return
      sent.turnId = e.turnId
      await markTurnStarted(sent, await now(), true)
    },

    async turnComplete(e: { turnId: string; agentId?: string; answer?: string; reason?: string }): Promise<void> {
      if (e.agentId) return
      await chatTurnComplete(e).catch(() => {})
      if (!sent || e.turnId !== sent.turnId) return
      await finishOpening()
    },

    // 本人が発言したら、このチャットを話し相手にする。エディターの切り替えがオンなら、開いているノートを添える文を返す。
    async promptSubmit(e: { text?: string; origin?: { kind?: string } }): Promise<string | null> {
      const typed = TYPED_ORIGINS.has(e.origin?.kind ?? '')
      const dir = await chatReady()
      if (!dir || base?.kind !== 'ok') {
        // 新しいチャットの最初の発言は、Modの準備（画面の確認、Vaultの確認）より先に届く。
        // 本人の発言なら時刻を覚えておき、準備が終わったところで相手になる（見回りの claimLater）。
        // session.start より先に届いたとき（io がまだ無いとき）は、この場で時計を読む。
        // $.clock.now() も壁時計（Date.now() と同じ時計）である前提。since の比べ合いに使うため。
        if (typed && stage !== 'off' && stage !== 'noScreen') claimWanted = io ? await now() : Date.now()
        return null
      }
      if (typed) {
        claimWanted = 0
        await io.claimChat(dir, await mySession(), base.host.os)
      }
      // エディターから送った文（案内を足し済み）がここへ来ても、二重に添えない（ふつうは呼ばれないが念のため）。
      if (pending && isSentText(String(e.text ?? ''), pending.text)) return null
      if (!(await io.shareIsOn(dir, base.host.os))) return null
      const state = (await readJson(cf(dir, 'current-note.json'))) as EditorState | null
      return state ? describeNote(state, await now(), base.root, base.host.os) : null
    },

    // チャットが終わったら話し相手を外す。/clear では同じチャットが続くので外さない。
    async sessionEnd(reason: string | undefined): Promise<void> {
      if (reason === 'clear') return
      const dir = chatDir ?? (base?.kind === 'ok' && vaultId ? vaultDirOf(base.host, vaultId) : null)
      if (!dir) return
      await io.releaseChat(dir, await mySession(), os())
    },

    // 道具を使うたびに、会話の記録を書き直す（メインの会話だけ）。
    toolActivity(e: { agentId?: string }): void {
      if (!e.agentId) logDirty = true
    },

    // 2つのツールの呼び出しに答える。登録していない（押していない・画面がない）ときは、何もせずに案内を返す。
    // callIo は、そのツールの呼び出しのフックの $ から作った口（フックの持ち時間は、そのフックの $ を待つあいだだけ止まるため）。
    async useTool(which: 'appearance' | 'vault', input: Record<string, any>, callIo?: Io): Promise<ToolAnswer> {
      const use = callIo ?? io
      if (!use || !toolCtx) return { isError: true, result: MSG_PRESS }
      return which === 'appearance' ? setAppearance(use, toolCtx, input) : setVaultSettings(use, toolCtx, input)
    },

    // ツールを登録できなかった理由があれば、/note の返事の最後に添える。
    async note(args: string): Promise<{ text: string }> {
      const answer = await noteText(args)
      return toolProblem ? { text: `${answer.text}\n${toolProblem}` } : answer
    },
  }

  async function noteText(args: string): Promise<{ text: string }> {
    if (!io) return { text: MSG_PRESS }
    const b = await getBase()
    if (b.kind === 'skip') return { text: 'このフォルダーでは NoteDock を使えません。' }
    if (b.kind === 'problem') return { text: b.text }
    if (!vaultId) {
      // ダウンロードはしない。置いてあるファイルだけを使う。
      const have = await io.installedBinary(b.host)
      if (typeof have === 'string') vaultId = await io.vaultIdOf(have, b.root)
    }
    if (!vaultId) return { text: superseded ? `${MSG_NEWER}。` : MSG_PRESS }
    // 画面のあるチャットだけが話し相手になる。
    if (await hasScreen()) {
      // 画面なしで始まり、session.attach なしで画面が付いたチャット：見回りも始める（話し相手になっても送れない、を防ぐ）。
      screenArrived()
      await io.claimChat(vaultDirOf(b.host, vaultId), await mySession(), b.host.os)
    }
    const running = await io.findRunning(b.host, vaultId)
    if (!running) return { text: MSG_PRESS }
    const info = await io.readServerInfo(b.host, vaultId)
    const ticket = info?.ticket ?? running.ticket
    if (!ticket) return { text: MSG_PRESS }
    const path = notePathFrom(args, b.root, b.host.os)
    const url = editorUrl({ port: running.port, today: false, note: path || undefined, ticket })
    return {
      text: `${path ? `${path} を開くには` : 'NoteDockを開くには'}、次のリンクを押してください。Chromeで開くことがあります。リンクは一度しか使えません。使えるのは長くて10分で、先に「ノートを開く」などで開くと使えなくなります。\n${url}`,
    }
  }
}

// フックをつなぐ。テストでは nd を代役にして、つなぎ方だけを確かめる。
export function wire(on: Parameters<Register>[0], nd: ReturnType<typeof createNotedock>): void {
  on('session.start', async ($, e, next) => {
    await nd.sessionStart(ioFor($))
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    await nd.attach()
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const band = ((await read($, bandAtom)) ?? null) as Band
    if (!band) return next(e)
    return bandTree(band, $.ui.resolve(e), today => {
      void nd.press(today)
    }) as any
  })

  on('command.run', { command: 'note' }, async (_$, e) => nd.note(e.args ?? ''))
  on('command.run', { command: 'notedock' }, async (_$, e) => nd.note(e.args ?? ''))

  on('turn.start', async ($, e, next) => {
    await nd.turnStart(e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await nd.turnComplete(e)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const note = await nd.promptSubmit(e).catch(() => null)
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  on('session.end', async ($, e, next) => {
    await nd.sessionEnd(e.reason).catch(() => {})
    return next(e)
  })

  // 2つのツール。名前は mcp__<plugin.json の名前>__<ツールの名前>。
  // 読み書きと問い合わせは、このフックの $ で行う（フックの持ち時間は、自分の $ を待つあいだだけ止まるため）。
  // 失敗や時間切れでも、理由を付けて答える（.catch の持ち時間は1秒なので、何も待たずに返す）。
  on('tool.call', { tool: 'mcp__notedock__set_appearance' }, async ($, e) => (await nd.useTool('appearance', e as unknown as Record<string, any>, ioFor($))) as any).catch(
    () => ({ isError: true, result: TOOL_FAILED }) as any,
  )
  on('tool.call', { tool: 'mcp__notedock__set_vault_settings' }, async ($, e) => (await nd.useTool('vault', e as unknown as Record<string, any>, ioFor($))) as any).catch(
    () => ({ isError: true, result: TOOL_FAILED }) as any,
  )

  on('tool.call', async ($, e, next) => {
    const main = e as unknown as { agentId?: string }
    nd.toolActivity(main)
    const result = await next(e)
    nd.toolActivity(main)
    return result
  })
}

export const register: Register = on => wire(on, createNotedock())
