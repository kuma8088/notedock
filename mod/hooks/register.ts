// NoteDockのMod。帯の「ノートを開く」、開いたフォルダーの記録、サーバーの見張り、Claudeに開いてもらう頼み、/note、チャット欄、ツール。
// 判断はすべて createNotedock の中にある。register はフックをつなぐだけ。
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Band } from '../types'
import { chatFile, coversSelection, describeNote, hexOf, hideKeys, isSentText, lineMention, linkDir, MAX_TEXT, newLinkText, noteForSend, quoteForPrompt, readMentions, shareIsOn, titleFrom, TYPED_ORIGINS, withNote, type EditorState } from './chat'
import { summarizeTranscript } from './chat-log'
import { compareVersions, ensureBinary, installedBinary, onlyNewerInstalled, removeOldVersions } from './install'
import { editorUrl, openPrompt, retryPrompt } from './open'
import { markOpened, readOpened, saveRefresh, type OpenedEntry, type RefreshEntry } from './opened'
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
const OWNER_BEAT_MS = 10_000 // 結び付けの印（link.json）の時刻を書き直す間隔（サーバーは40秒より古い印を「つながっていたチャットが無い」とみなす）
const LOG_MIN_MS = 2000 // 会話の記録の書き出しは、2秒に1回まで
const LOG_BEAT_MS = 5000 // Claudeの作業中は、5秒ごとに書き直して、まだ動いていると分かるようにする
const CHAT_RECENT_MS = 30 * 60_000 // 送った文の番を待つ上限
const SEND_STALE_MS = 2 * 60_000 // エディターが書いてから、これより時間がたった送る文は送らない（AIの判断）
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
// refused（相手のほうが新しい）は、そのまま使ってよい。failed・timeout は3回やり直しても入れ替えられなかったので、開き直してもらう。
const replaceRefused = (why: string) => `古いバージョンのサーバーを入れ替えられなかったので、そのまま使っています（${why}）`
const replaceFailed = (why: string) => `古いバージョンのサーバーを入れ替えられませんでした。アプリを終了して、開き直してください（${why}）`

export type { ToolContext } from './tools'
type Timer = { cancel: () => void }

// Modが外とやり取りする口。$ はここ（ioFor）でだけ使う。
// validate の決まりで、$ は「$.名前.動き(...)」か、名前で呼ぶ関数に渡す形でしか書けないため。
export type Io = {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => Timer
  every: (ms: number, fn: () => void) => Timer
  read: (path: string) => Promise<string>
  realPath: (path: string) => Promise<string> // たどった先の場所（シンボリックリンクを解いたもの）。無ければ throw
  write: (path: string, text: string) => Promise<void>
  root: () => Promise<string>
  surfaces: () => Promise<readonly string[]>
  registerNote: () => Promise<unknown>
  registerNotedock: () => Promise<unknown>
  submit: (text: string) => Promise<any>
  hostInfo: () => Promise<HostInfo | { problem: string }>
  canonicalRoot: (raw: string) => Promise<string | null>
  makeStateDir: (host: HostInfo) => Promise<number>
  readOpened: (host: HostInfo) => Promise<Record<string, OpenedEntry>>
  markOpened: (host: HostInfo, key: string, patch: Partial<OpenedEntry>) => Promise<void>
  saveRefresh: (host: HostInfo, entry: RefreshEntry) => Promise<void> // フォルダーを差し替えた記録（refresh.json）
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
  randomLink: () => string // 推測できない番号（このチャットとエディターを結び付ける）
  hashLink: (raw: string) => Promise<string> // 番号のハッシュ（結び付けのフォルダーの名前）
  loadLink: () => Promise<string | null> // このチャットの番号（Modを読み込み直しても残る $.state）
  saveLink: (raw: string | null) => Promise<void>
  shareIsOn: (dir: string, os: Os) => Promise<boolean>
  exists: (path: string) => Promise<boolean>
  messages: () => Promise<readonly any[]>
  fill: (text: string) => Promise<unknown> // 入力欄の今のカーソルの位置に入れる
  sendAsUser: (text: string) => Promise<any> // 本人の発言として送る（エディターのチャット欄から）
  move: (host: HostInfo, from: string, to: string) => Promise<number> // 差し替える（終了コード）
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text: string }>
  debug: (text: string) => void // Modのデバッグのログに1行（画面にもClaudeにも出さない）
}

const bandAtom = atom({ plugin: 'notedock', key: 'band' } as const, null)
const LINK_RE = /^[A-Za-z0-9_-]{43}$/ // 乱数（32バイト）を base64url にした形
const FOLDER_RE = /^[0-9a-f]{64}$/ // 結び付けのフォルダーの名前（乱数のハッシュ）
const BIND_KEEP = 5 // 同時に使える結び付けの合図の数（開き直しや /note を重ねたとき）

// テストでは over で、ダウンロード・起動・帯などを代役に差し替える。
export function ioFor($: Host, over: Partial<Io> = {}): Io {
  const io: Io = {
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    every: (ms, fn) => $.clock.every(ms, fn),
    read: path => $.fs.read(path),
    realPath: async path => {
      const found = await $.fs.stat(path, { resolve: true })
      if (typeof found?.realPath !== 'string') throw new Error('no real path')
      return found.realPath
    },
    write: (path, text) => $.fs.write(path, text),
    root: () => $.session.root(),
    surfaces: () => $.session.surfaces(),
    registerNote: () => $.command.register({ name: 'note', description: 'ノートをNoteDockで開くリンクを出す（例: /note Home.md）', argumentHint: '[ノートの場所]' }),
    registerNotedock: () => $.command.register({ name: 'notedock', description: 'ノートをNoteDockで開くリンクを出す（例: /notedock Home.md）', argumentHint: '[ノートの場所]' }),
    submit: text => $.prompt.submit({ text }),
    hostInfo: () => hostInfo($),
    canonicalRoot: raw => canonicalRoot($, raw),
    makeStateDir: async host => (await runCmd($, makeStateDirCmd(host))).exitCode,
    readOpened: host => readOpened($, host),
    markOpened: (host, key, patch) => markOpened($, host, key, patch),
    saveRefresh: (host, entry) => saveRefresh($, host, entry),
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
    randomLink: () => {
      const bytes = new Uint8Array(32)
      crypto.getRandomValues(bytes)
      return newLinkText(bytes)
    },
    hashLink: async raw => hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))),
    loadLink: async () => {
      const value = (await $.state.get({ plugin: 'notedock', key: 'chatLink' }))?.value
      return typeof value === 'string' && FOLDER_RE.test(value) ? value : null
    },
    saveLink: async raw => {
      await $.state.set({ plugin: 'notedock', key: 'chatLink' }, raw)
    },
    shareIsOn: (dir, os) => shareIsOn($, dir, os),
    exists: path => $.fs.exists(path),
    messages: () => $.session.messages(),
    fill: text => $.prompt.fill({ text, mode: 'insert' }),
    sendAsUser: text => $.prompt.submit({ text, asUser: true }),
    move: async (host, from, to) => (await runCmd($, moveCmd(host, from, to))).exitCode,
    fetch: (url, init) => $.http.fetch(url, init),
    debug: text => $.ui.log(text, { to: 'debug' }),
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
  link: string | null // 開くリンクに付けた、このチャットの番号（頼み直しにも付ける）
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
  // 入れ替えの案内。until 0 は、次に描くときに10分後に決める。Infinity は、このチャットのあいだ出し続ける（3回やり直しても入れ替えられなかったとき）
  let replaceNote: { text: string; until: number } | null = null
  let stopSeen = false // 止める指示が通ったことがある（2回目以降は、消し直しを10秒おきに数え直さない）
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

  // チャット欄。エディターを開いたこのチャットが作った番号（link）に結び付いたエディターだけと、送る・引用・会話の記録をやり取りする。
  let link: { hash: string } | null = null // このチャットの結び付けのフォルダーの名前（推測できない乱数のハッシュ）
  let binds: { h: string; until: number }[] = [] // まだ使える結び付けの合図のハッシュと期限
  let endedWhy = 'unknown' // 最後にチャットが終わった理由（「終わった」の印に書く）
  let bindsLoaded = false // Modを読み込み直したあと、link.json から合図を戻したか
  let linkP: Promise<void> | null = null
  let restoreP: Promise<void> | null = null
  let chatDir: string | null = null // Vault別フォルダーがあると確かめた場所
  let chatInitFor = '' // どの番号の結び付けのフォルダーで、残っていた頼みを読んだか
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
  let lastBeat = 0
  let title = '' // エディターに出す、このチャットの名前（分かる範囲で）
  let titleFixed = false // 本人の発言から名前を決めた

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
    basePromise ??= computeBase().then(b => (base = b))
    return basePromise
  }

  // チャットのフォルダーを読み、NoteDock を使えるかを判定する。
  async function computeBase(): Promise<Base> {
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
  }

  // 予備のチャット（~/.claude/spares/ で始まり、メッセージを送ると選んだフォルダーへ移る）では、
  // 開始時に読んだフォルダーが予備のフォルダーのままになる。押したときと /note のときに取り直す。
  // 差し替えるのは、まだ開いていないときに、新しい判定が ok で、前と違うフォルダーのときだけ。
  // それ以外（消えたフォルダーで skip になった、読めない、同じフォルダー）は、前の判定のまま進む（0.1.0 と同じ動き）。
  let refreshP: Promise<void> | null = null
  function refreshBase(fromPress: boolean): Promise<void> {
    // 押した側は、/note の取り直しが動いていればそれを待ってから、自分でもう一度取り直す
    // （/note の側は、押したあと busy になると差し替えずに終わるため）。
    if (fromPress) return (refreshP ?? Promise.resolve()).then(() => refreshOnce(true))
    refreshP ??= refreshOnce(false).finally(() => (refreshP = null))
    return refreshP
  }

  async function refreshOnce(fromPress: boolean): Promise<void> {
    const opening = () => active || activateP !== null || (!fromPress && busy)
    try {
      const before = await getBase()
      if (opening()) return
      const next = await computeBase()
      // 前の判定が ok でないとき（ホームなど）は、帯も見回りも始まっていないので差し替えない。
      if (opening() || before.kind !== 'ok' || next.kind !== 'ok' || before.key === next.key) return
      base = next
      basePromise = Promise.resolve(next)
      vaultId = null
      toolCtx = null
      chatDir = null
      chatInitP = null
      chatInitFor = ''
      needSeen = 0
      try {
        await io.saveRefresh(next.host, { at: await now(), from: before.root, to: next.root })
      } catch {
        // 記録できなくても、差し替えは保ち、押したあとの処理も止めない
      }
    } catch {
      // 読めなければ、前の判定のまま進む
    }
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
    void restoreLink()
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
    // refused の帯は10分で消す。failed・timeout は、古いサーバーが止まりかけのまま残ると保存が断られ続けるので、出し続ける。
    if (e.kind === 'failed') {
      replaceNote = e.reason === 'refused'
        ? { text: replaceRefused(REPLACE_WHY[e.reason]), until: 0 }
        : { text: replaceFailed(REPLACE_WHY[e.reason]), until: Infinity }
    } else if (e.kind === 'legacy') replaceNote = { text: MSG_LEGACY, until: 0 }
    else if (stopSeen) {
      // やり直しで、もう一度止める指示が通った。自分のバージョンが動いていなくても消し直せる時間だけを延ばす。
      // 10秒おきに消し直すのは、最初に通ったときから2分だけ（cleanSince は数え直さない）。
      void (async () => {
        stopWindowUntil = (await now()) + CLEAN_RETRY_LIMIT_MS
      })().catch(() => {})
    } else {
      // 止める指示が通った。止まるのを待たずに、古いバージョンのフォルダーを消す（消し直しの間隔も、ここから数え直す）。
      stopSeen = true
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
    // 最初の合図は、ほかのタブが使ったかもしれないので、頼み直しでは新しい合図を付ける。
    const code = s.link ? await ensureLink() : null
    submit(retryPrompt({ port: info.port, ticket: info.ticket, today: s.today, link: code }), s.req, () => {})
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
    await refreshBase(true)
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
      // アプリの画面があるチャットだけが、エディターのチャット欄の送り先になる。開くリンクに、このチャットの番号を付ける。
      const chat = (await hasApp()) && takesLink(st.running.version) ? await ensureLink() : null
      if (r !== req) return
      const text = openPrompt({ port: info?.port ?? st.running.port, ticket: info?.ticket ?? st.running.ticket ?? null, today: pressedToday, link: chat })
      const at = await now()
      await writePending(at + OPEN_WAIT_MS) // 頼む直前に書く
      if (r !== req) return
      const s: Sent = { text, at, today: pressedToday, turnId: null, turnStart: 0, confirmed: false, retried: false, req: r, link: chat }
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

  // 画面がターミナルだけのチャットは、エディターのチャット欄の送り先にしない（Claudeアプリやエディター拡張の画面があるときだけ）。
  async function hasApp(): Promise<boolean> {
    try {
      return (await io.surfaces()).some(s => s !== 'terminal')
    } catch {
      return false
    }
  }

  // 結び付けの合図（#s=）を読めるのは、このModと同じか新しいバージョンのサーバーの画面だけ。古い画面は #c= だけの形しか読めない。
  function takesLink(version: unknown): boolean {
    return typeof version === 'string' && VERSION_RE.test(version) && compareVersions(version, mine) >= 0
  }

  // Modを読み込み直したときは、このチャットの結び付けのフォルダーの名前を $.state から戻す（開いているエディターが、そのまま送れるように）。
  function restoreLink(): Promise<void> {
    restoreP ??= (async () => {
      try {
        const saved = await io.loadLink()
        if (saved && !link) link = { hash: saved }
      } catch {
        // 戻せなければ、次に開いたときに新しく作る。
      }
    })()
    return restoreP
  }

  // エディターを開くときに呼ぶ。このチャットの結び付けのフォルダー（名前は推測できない乱数）が無ければ作り、
  // 開くリンクに付ける「結び付けの合図」（一度だけ使える乱数）を作って返す。リンクに載るのは合図だけで、
  // サーバーは合図と引き換えに、そのタブだけの鍵を渡す。合図は使うか15分たつと使えなくなるので、会話の記録に残っても使い回せない。
  async function ensureLink(): Promise<string | null> {
    await restoreLink()
    if (!link) {
      linkP ??= (async () => {
        const raw = io.randomLink()
        if (!LINK_RE.test(raw)) throw new Error('番号を作れませんでした')
        const hash = await io.hashLink(raw)
        try {
          await io.saveLink(hash)
        } catch {
          // 覚えられなくても、このModが動いているあいだは使える。
        }
        link = { hash }
        binds = []
        bindsLoaded = true
        // 新しい結び付けのフォルダーには、まだ何も無い。これから届く頼みは、どれも新しいものとして扱う。
        chatInitFor = hash
        lastAsk = lastSend = lastReplied = 0
        chatInitP = Promise.resolve()
      })().finally(() => (linkP = null))
      try {
        await linkP
      } catch {
        return null
      }
    }
    let code: string
    try {
      code = io.randomLink()
      if (!LINK_RE.test(code)) return null
      const t = await now()
      binds = [...binds.filter(b => b.until > t), { h: await io.hashLink(code), until: t + OPEN_WAIT_MS }].slice(-BIND_KEEP)
    } catch {
      return null
    }
    await beat(true)
    return code
  }

  // 結び付けのフォルダー。Vaultが分かっていて、フォルダーの名前があるときだけ。
  function myLinkDir(): string | null {
    if (base?.kind !== 'ok' || !vaultId || !link) return null
    return linkDir(base.host.os, vaultDirOf(base.host, vaultId), link.hash)
  }

  // 結び付けの印（link.json）を書き直す。サーバーは、この印がある結び付けのタブからだけ、送る文を受け付ける。
  // 印には、まだ使える結び付けの合図のハッシュも書く（合図そのものは書かない）。
  async function beat(force = false): Promise<void> {
    const dir = myLinkDir()
    const hash = link?.hash
    if (!dir || !hash || base?.kind !== 'ok' || !vaultId) return
    const t = await now()
    if (!force && t - lastBeat < OWNER_BEAT_MS) return
    if (!(await hasApp())) return
    try {
      if (!(await io.exists(vaultDirOf(base.host, vaultId)))) return
      // Modを読み込み直したあとは、まだ使える合図を link.json から戻す（開く途中だったタブが引き換えられるように）。
      if (!bindsLoaded) {
        bindsLoaded = true
        const saved = (await readJson(cf(dir, 'link.json')))?.binds
        if (Array.isArray(saved)) {
          const known = new Set(binds.map(b => b.h))
          for (const b of saved) if (b && typeof b.h === 'string' && /^[0-9a-f]{64}$/.test(b.h) && Number(b.until) > t && !known.has(b.h)) binds.unshift({ h: b.h, until: Number(b.until) })
          binds = binds.slice(-BIND_KEEP)
        }
      }
      // チャットが終わったあと（番号を捨てたあと）に、古い見回りが印を生き返らせない。
      if (link?.hash !== hash) return
      binds = binds.filter(b => b.until > t)
      await io.write(cf(dir, 'link.json'), JSON.stringify({ at: t, title, binds }))
      // 書いているあいだにチャットが終わっていたら、「終わった」の印を書き直し、$.state にも戻さない。
      if (link?.hash !== hash) {
        await io.write(cf(dir, 'link.json'), JSON.stringify({ at: 0, closed: true, reason: endedWhy }))
        return
      }
      lastBeat = t
      // $.state が消えていたら（/clear のあとなど）、覚え直す。
      if ((await io.loadLink().catch(() => hash)) !== hash && link?.hash === hash) await io.saveLink(hash).catch(() => {})
    } catch {
      // 書けなければ、次の見回りで書き直す。
    }
  }

  // チャット欄を使える場所（このチャットの結び付けのフォルダー）。画面のあるチャットで、Vaultが分かっていて、
  // Vault別フォルダーがあり（サーバーが一度動いた）、このチャットの番号があるときだけ。ほかのVault・ほかの番号のファイルは読まない、書かない。
  async function chatReady(): Promise<string | null> {
    if (stage !== 'screen' || base?.kind !== 'ok' || !vaultId) return null
    await restoreLink()
    const vdir = vaultDirOf(base.host, vaultId)
    if (chatDir !== vdir) {
      try {
        if (!(await io.exists(vdir))) return null
      } catch {
        return null
      }
      chatDir = vdir
    }
    const dir = myLinkDir()
    if (!dir || !link) return null
    // 読み込んだときに残っていた頼みは、もう済んだものとみなす。
    if (chatInitFor !== link.hash) {
      chatInitFor = link.hash
      chatInitP = (async () => {
        const state = (await readJson(cf(dir, 'state.json'))) as EditorState | null
        lastAsk = Number(state?.askChat?.at) || 0
        lastSend = Number(state?.sendChat?.at) || 0
        lastReplied = Number((await readJson(cf(dir, 'reply.json')))?.for) || 0
      })()
    }
    await chatInitP
    return dir
  }

  async function failReply(dir: string, at: number, why: string): Promise<void> {
    try {
      await io.write(cf(dir, 'reply.json'), JSON.stringify({ for: at, text: `チャットへ送れませんでした。（${why}）`, failed: true, at: await now() }))
    } catch {
      // 書けなければ、エディターは待つのをやめるボタンで抜けられる。
    }
  }

  // チャット欄の見回りの1回分。このチャットの番号に結び付いたエディターとだけやり取りする。
  async function chatStep(t: number): Promise<void> {
    const dir = await chatReady()
    if (!dir || base?.kind !== 'ok') return
    // ターミナルだけのチャットになっていれば、印も書き直さない（40秒たつと、エディターは送れない状態になる）。
    // そのあいだに届いた送る文は、あとで遅れて送らないよう、送れなかったことを返して済ませる。
    if (!(await hasApp())) {
      const waiting = ((await readJson(cf(dir, 'state.json'))) as EditorState | null)?.sendChat
      if (waiting && waiting.at > lastSend) {
        lastSend = waiting.at
        lastReplied = waiting.at
        await failReply(dir, waiting.at, 'このチャットの画面が開いていません')
      }
      return
    }
    if (working && t - logWritten > LOG_BEAT_MS) logDirty = true
    await beat()
    if (logDirty && t - logWritten >= LOG_MIN_MS) {
      logDirty = false
      logWritten = t
      try {
        // Claudeへの「開いて」の頼みには鍵付きのURLが入るので、書く前に鍵と番号を消す（誰の発言でも）。
        const items = summarizeTranscript(await io.messages()).map(item => ({ ...item, text: hideKeys(item.text) }))
        const project = baseName(base.root)
        if (!titleFixed) {
          title = titleFrom(items, project)
          titleFixed = title !== project
        }
        await io.write(cf(dir, 'log.json'), JSON.stringify({ working: working?.since ?? 0, items, project, title, at: t }))
      } catch {
        // 書けなくても、次に会話が動いたときにもう一度書く。
      }
    }
    const state = (await readJson(cf(dir, 'state.json'))) as EditorState | null
    if (state?.askChat && state.askChat.at > lastAsk) {
      lastAsk = state.askChat.at
      try {
        await io.fill(quoteForPrompt(String(state.askChat.text ?? '')))
      } catch {
        // 入れられなければ、それまで。
      }
    }
    if (state?.sendChat && state.sendChat.at > lastSend) {
      lastSend = state.sendChat.at
      // 書かれてから時間がたった文は送らない（Modが止まっていたあいだに受け付けた文を、あとで本人の発言として入れないため）。
      if (t - state.sendChat.at > SEND_STALE_MS) {
        lastReplied = state.sendChat.at
        await failReply(dir, state.sendChat.at, '時間がたったので送りませんでした')
        return
      }
      const typed = String(state.sendChat.text ?? '').slice(0, MAX_TEXT)
      const at = state.sendChat.at
      // Modが送る文には、Mod自身の prompt.submit フックが呼ばれない（呼んだプラグインのフックは通らず、context も渡せない）。
      // そこで、切り替えがオンなら、開いているノートの短い案内を文の末尾に足す（打った文と選んだ文字の上限はそれぞれ守る）。
      // 打った文の「@場所#L12-18」は、エンジンが読まない（Modが送る文のため）ので、Modが保存したファイルから読んで添える。
      // 共有の切り替えには関係なく、本人が @ で指したときだけ。
      const mentions = await readMentions(typed, state, base.root, base.host.os, io.read, io.realPath).catch(() => ({ text: null, attached: [] }))
      // 選んでいる行を @ で指して添えたときは、案内から選んでいる文字を省く（同じ行が2回届かないように）。場所と保存の様子は残す。
      const note = (await io.shareIsOn(dir, base.host.os)) ? noteForSend(state, t, base.root, base.host.os, !coversSelection(mentions.attached, state)) : null
      const text = withNote(withNote(typed, mentions.text), note)
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
      const asked = ((await readJson(cf(dir, 'state.json'))) as EditorState | null)?.sendChat
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
    const dir = myLinkDir()
    if (!chatTurn || e.turnId !== chatTurn.turnId || !dir) return
    const reply = { for: chatTurn.at, text: hideKeys(e.answer ?? ''), reason: e.reason, at: await now() }
    lastReplied = chatTurn.at
    chatTurn = null
    try {
      await io.write(cf(dir, 'reply.json'), JSON.stringify(reply))
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
      restoreP = null // 読み込み直したときは、このチャットの番号を $.state から戻し直す
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

    // 本人が打った発言にだけ、このチャットに結び付いたエディターの切り替えがオンなら、開いているノートを添える文を返す。
    // 別のセッションからのメッセージやタスクの知らせ（打った発言ではないもの）には添えない。発言しても、送り先は変わらない。
    async promptSubmit(e: { text?: string; origin?: { kind?: string } }): Promise<string | null> {
      if (!io || !TYPED_ORIGINS.has(e.origin?.kind ?? '')) return null
      const dir = await chatReady()
      if (!dir || base?.kind !== 'ok') return null
      if (!(await hasApp())) return null
      // エディターから送った文（案内を足し済み）がここへ来ても、二重に添えない（ふつうは呼ばれないが念のため）。
      if (pending && isSentText(String(e.text ?? ''), pending.text)) return null
      if (!(await io.shareIsOn(dir, base.host.os))) return null
      const state = (await readJson(cf(dir, 'state.json'))) as EditorState | null
      // 選んでいる行の @ を見て選んでいる文字を省くのは、入力欄（composer）で打った文だけ（候補から @ を入れられるのはそこだけ）。
      const typed = e.origin?.kind === 'composer' ? String(e.text ?? '') : ''
      return state ? describeNote(state, await now(), base.root, base.host.os, typed) : null
    },

    // ターミナル版の入力欄で @ から打っているとき、このチャットに結び付いたエディターで選んでいる行を、候補の1行として返す。
    // 選ぶと「@場所#L12-18」が入り、エンジンがその行を読んでClaudeに渡す。共有の切り替え（share.json）には関係なく出す。
    async autocomplete(e: { token?: string }): Promise<{ text: string; label: string; description: string } | null> {
      if (!io || typeof e.token !== 'string' || !e.token.startsWith('@')) return null
      const dir = await chatReady()
      if (!dir || base?.kind !== 'ok') return null
      const state = (await readJson(cf(dir, 'state.json'))) as EditorState | null
      return state ? lineMention(state, await now(), base.root, base.host.os, e.token) : null
    },

    // チャットが終わったら、結び付けの印を「終わった」にし、番号を捨てる（エディターは送れない状態になる）。
    // /clear では同じチャットの画面が続く（Modもそのまま）ので、結び付けは残し、名前と会話の記録だけを新しくする。
    async sessionEnd(reason: string | undefined): Promise<void> {
      // どの理由で終わったかを、デバッグのログと「終わった」の印に残す（決まった言葉だけ。ほかは unknown）。
      // 型定義では /clear は reason 'clear' で届くが、Claudeアプリでは別の言葉で届くことがある（2026-11-22、VMで /clear のあと送れなくなった）。
      const why = typeof reason === 'string' && /^[a-z_]{1,32}$/.test(reason) ? reason : 'unknown'
      try {
        void Promise.resolve(io?.debug(`notedock: session.end reason=${why}`)).catch(() => {})
      } catch {
        // 書けなくても続ける。
      }
      if (reason === 'clear') {
        title = ''
        titleFixed = false
        logDirty = true
        return
      }
      const dir = myLinkDir()
      endedWhy = why
      link = null
      binds = []
      lastBeat = 0
      // 終わりの持ち時間は短いので、送れなくする印を先に書く。会話の抜粋も消す。
      if (dir) {
        try {
          await io.write(cf(dir, 'link.json'), JSON.stringify({ at: 0, closed: true, reason: why }))
          await io.write(cf(dir, 'log.json'), '{}')
        } catch {
          // 書けなくても、40秒たてばエディターは送れない状態になる。
        }
      }
      try {
        await io.saveLink(null)
      } catch {
        // 消せなくても、印を「終わった」にしたので送れない。
      }
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
    await refreshBase(false)
    const b = await getBase()
    if (b.kind === 'skip') return { text: 'このフォルダーでは NoteDock を使えません。' }
    if (b.kind === 'problem') return { text: b.text }
    if (!vaultId) {
      // ダウンロードはしない。置いてあるファイルだけを使う。
      const have = await io.installedBinary(b.host)
      if (typeof have === 'string') {
        const id = await io.vaultIdOf(have, b.root)
        if (base === b) vaultId = id // 待つあいだに押した側が差し替えていれば、古いフォルダーの ID は使わない
      }
    }
    if (!vaultId) return { text: superseded ? `${MSG_NEWER}。` : MSG_PRESS }
    // 画面なしで始まり、session.attach なしで画面が付いたチャット：見回りも始める（結び付いても送れない、を防ぐ）。
    if (await hasScreen()) screenArrived()
    const running = await io.findRunning(b.host, vaultId)
    if (!running) return { text: MSG_PRESS }
    const info = await io.readServerInfo(b.host, vaultId)
    const ticket = info?.ticket ?? running.ticket
    if (!ticket) return { text: MSG_PRESS }
    // アプリの画面があるチャットだけが、エディターのチャット欄の送り先になる。リンクに、このチャットの番号を付ける。
    const app = await hasApp()
    const chat = app && takesLink(running.version) ? await ensureLink() : null
    const path = notePathFrom(args, b.root, b.host.os)
    const url = editorUrl({ port: running.port, today: false, note: path || undefined, ticket, link: chat })
    const where = chat
      ? 'このリンクで開いたエディターのチャット欄から送った文は、このチャットに届きます。'
      : !app
        ? 'このチャットはターミナルだけで開いているので、エディターのチャット欄からこのチャットへは送れません（送れるのは、Claudeアプリなど画面のあるチャットから開いたときです）。'
        : ''
    return {
      text: `${path ? `${path} を開くには` : 'NoteDockを開くには'}、次のリンクを押してください。Chromeで開くことがあります。リンクは一度しか使えません。使えるのは長くて10分で、先に「ノートを開く」などで開くと使えなくなります。${where}\n${url}`,
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

  // ターミナル版の入力欄の @ の候補に「選んでいる行：○○.md の12〜18行目」を足す。エンジンの候補の下に並ぶ。
  // デスクトップアプリの入力欄では、このフックは呼ばれない（2026-11 に実機で確かめた）。窓のチャット欄の @ はエディターの画面が出す。
  on('prompt.autocomplete', { token: /^@/ }, async ($, e, next) => {
    const got = await next(e)
    const row = await nd.autocomplete(e).catch(() => null)
    return row ? { suggestions: [row, ...got.suggestions] } : got
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
