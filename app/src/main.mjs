import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewline, isolateHistory, undoDepth } from '@codemirror/commands'
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import {
  HighlightStyle,
  foldAll,
  foldEffect,
  foldGutter,
  foldKeymap,
  foldable,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
  unfoldAll,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, placeholder, crosshairCursor, drawSelection, dropCursor, hoverTooltip, keymap, rectangularSelection } from '@codemirror/view'
import { tags } from '@lezer/highlight'

import { bindChatCode, CHAT_PARTNER_TEXT, chatImageUrl, chatLinkFromHash, fileUrl, markKeyRefused, needTicketUrl, recalledChatLink, sendFailText, setFileKey, stashBindCode, takeKeyRefused, ticketFromHash, tokenFromHash } from './access.mjs'
import { appearanceVars } from './appearance.mjs'
import { findHeading, headingsOf, linkCompletion, wikiLinkCompletion } from './complete.mjs'
import { calendarModel, shiftMonth } from './calendar.mjs'
import { periodInfo, todayButtonHidden } from './periodic.mjs'
import { PRODUCT } from './product.mjs'
import { askChoice, askConfirm, askNewNote, askNewTask, askPlace, askText, showCopyable, showMessage } from './dialogs.mjs'
import { copyText } from './copy.mjs'
import { isBodyKey, keyLabel, localizeKeyHints } from './keys.mjs'
import { isExternal, normalizeKey, relativeHref, resolveHref, wikiLinkOf } from './links.mjs'
import { absolutePath, ancestorsOf, buildTree, checkNewNote, childFolders, defaultNoteDir, newNotePath, noteFolders, planFailure, rememberPlace, resolvePasted, searchFolders } from './files.mjs'
import { alphaChildEnter, alphaListEnter } from './alpha-list.mjs'
import { foldedLines, foldsChanged, listMarkerFold } from './folds.mjs'
import { hangingIndent } from './hanging.mjs'
import { noteMarkdown } from './markdown-ext.mjs'
import { MSG, createReplyWaiters, draftKey, isPaneMessage, pickDraft, targetPane } from './pane.mjs'
import { minimalChange } from './merge.mjs'
import { editableExtensions, endQuietAfterClick, focusEndsQuiet, partCursor, partKind, pasteOpensNote, pastePlace, pressedPart, refocusesBody } from './modes.mjs'
import { cursorQuiet, keyEndsQuiet, noteContext, noteMode, previewField, setComposing, setCursorQuiet, setMode, setNoteBusy, togglePropsPanel, typingStart } from './preview.mjs'
import { createSaver } from './save.mjs'
import { createSplit } from './split.mjs'
import { calloutSpec, codeBlockSpec, currentFormat, headingSpec, horizontalRuleSpec, inlineSpec, lineKindSpec, linkSpec, tableSpec } from './toolbar.mjs'
import { createConnectionWatch, createVersionWatch } from './connection.mjs'
import { linesFrom, selectedLines } from './lines.mjs'
import { applyMention, headingTarget, mentionCandidates, mentionQuery, sectionsOf, unwritableCount } from './mention.mjs'
import { beginTableCell, historyStep, showMenu } from './widgets.mjs'
import { TASK_FOLDER, isTaskNote } from './tasks.mjs'
import { checkNewTask, dailyDateOf } from './task-buckets.mjs'
import { createTaskSide } from './task-side.mjs'
import { createTaskPanel } from './task-panel.mjs'
import { collectDescendants, confirmedChildren, deleteChoices, deleteQuestion, deletedText, findTask, isUnderTaskFolder, pathKey, planUnlinkInNote, relocateLink, sourceLinkNote, sourceNoteOf, taskTitleOf, trashFailedNotice, unlinkedTrashCheck, unlinkRange, unsavedBlockText } from './task-delete.mjs'
import { MENU_HINT, canUndoDirectly, createFailedText, createdText, leftoverText, linkChange, linkRemoval, menuForLine, notLinkedText, planAfterCreate, reasonText, taskForDocLine, taskRequestBody } from './task-convert.mjs'
import { setProperty } from './yaml-lite.mjs'

const $ = (id) => document.getElementById(id)

// 左右に並べたときの右の枠は、同じページを ?pane=right で開く。右の枠では、上のボタン列と右端の一覧を使わない。
const PANE = new URLSearchParams(location.search).get('pane') === 'right' ? 'right' : 'left'
document.body.dataset.pane = PANE
// 右の枠への連絡の送り先。右の枠からは、いつも同じアドレスの左（親のページ）へ送る。
const toLeft = (message) => parent.postMessage(message, location.origin)
// 右の枠は全体の半分ほどの幅なので、自分の幅では決めず、いつも「狭くない」として扱う。
function isNarrow() {
  return PANE !== 'right' && matchMedia('(max-width: 640px)').matches
}
// 右の枠が開いているか（左の枠で使う）。一時保存を戻すときに見る。
let rightOpen = false
function setRightOpen(open) {
  rightOpen = Boolean(open)
}
// 右の枠が操作中か（右の枠で使う）。左から ACTIVE で知らされる。
let paneActive = false
// 左の枠で使う。右の枠から OPENED と STATE で知らされた、右の枠のノートの様子。
let rightState = { path: null, selection: '', dirty: false, headings: null, lines: null }
// 右の枠の準備ができたら開いてもらうノート。分けた直後や、分けてすぐ右で開くときに使う。
let rightWant = null
// 右の枠が最後に知らせてきた、開いているノート。同じノートの OPENED は見出しの更新として扱う。
let rightShown = null
// 画面を左右に分ける係。右の枠の中では使わない。
const split = PANE === 'right' ? null : createSplit({ layout: $('layout'), editor: $('editor'), onMessage: receiveFromRight, onActiveChange: activeChanged })
const rightActive = () => split?.active() === 'right'
const activePane = () => split?.active() ?? 'left'
const external = Annotation.define()
const contextSlot = new Compartment()
const editableSlot = new Compartment()

const REASONS = {
  'mixed-eol': '改行のしかたが2種類混ざっているので、編集できない状態で開いています。',
  bom: 'BOM付きのファイルなので、編集できない状態で開いています。',
  'not-utf8': 'UTF-8ではないファイルなので、編集できない状態で開いています。',
  excalidraw: 'Excalidrawのノートなので、データを壊さないよう編集できない状態で開いています。',
}
const STATUS_TEXT = {
  saved: '保存済み',
  updated: '保存済み（ほかからの変更を反映）',
  dirty: '未保存',
  saving: '保存中…',
  offline: 'サーバーにつながりません。入力は続けられます',
  gone: 'サーバーにつながりません',
  'save-failed': '保存できませんでした',
  conflict: '保存を止めています',
  removed: 'ファイルが見つかりません',
  blocked: '編集できません',
  elsewhere: '保存を止めています',
  readonly: '編集できません',
}

const storage = {
  get(key, fallback = null) {
    try {
      const value = localStorage.getItem(key)
      return value === null ? fallback : JSON.parse(value)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // 保存領域が使えなくても編集は続ける。
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key)
    } catch {
      // 同上
    }
  },
}

// タブを閉じる途中の送信は、keepaliveを付けないと捨てられる。付けられるのは64KBまで。
const KEEPALIVE_LIMIT = 60_000
let unloading = false
let rootId = ''
const TOKEN_KEY = 'access-token'
let accessToken = storage.get(TOKEN_KEY, '')
let tokenRefused = false
// 鍵付きの場所で開かれ、その鍵をサーバーに断られた（期限切れ・使用済み）。開けない画面は、これを need-ticket に付けて送る。
// 鍵を断られたあとに読み込み直したときは、タブの中の印から引き継ぐ。
const sessionStore = (() => {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
})()
let keyRefused = takeKeyRefused(sessionStore)
// チャット欄の送り先。chatLink は、このタブだけの鍵（サーバーが結び付けの合図と引き換えて渡したもの）。タブの中に覚え、読み込み直しても使う。
// アドレスの #s= は、エディターを開いたチャットのModが作った、一度だけ使える結び付けの合図。合言葉や鍵がアドレスから消される前に読む。
let chatLink = recalledChatLink(sessionStore)
// 合図は、アドレスから消す前にタブの中へ退避し、引き換えが済むまで残す（bindChatCode）。
function takeChatBindCode() {
  const code = chatLinkFromHash(location.hash)
  if (!code) return false
  stashBindCode(sessionStore, code)
  // 合言葉も鍵も無い形（#s= だけ）なら、ここでアドレスから消す。
  if (!tokenFromHash(location.hash) && !ticketFromHash(location.hash)) {
    window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}`)
  }
  return true
}
takeChatBindCode()

// 返事を見たか・このタブから送ったかの印。送り先はタブごとに違うので、タブの中（sessionStorage）に覚える。
const tabFlags = {
  get(key) {
    try {
      return Number(sessionStore?.getItem(`notedock-${key}`)) || 0
    } catch {
      return 0
    }
  },
  set(key, value) {
    try {
      sessionStore?.setItem(`notedock-${key}`, String(value))
    } catch {
      // 保存領域が使えなければ、覚えない。
    }
  },
}

// 退避した結び付けの合図を、このタブだけの鍵と引き換える。合言葉が要る。引き換えられたらtrueを返す。
// 起動時に合言葉が無く開けない画面（locked）になったタブでも送れるよう、request ではなく fetch で直接送る。
async function bindChat() {
  const cred = await bindChatCode({ store: sessionStore, fetchImpl: (url, init) => fetch(url, init), token: accessToken })
  if (!cred) return false
  chatLink = cred
  return true
}

// 合言葉がURLに残らないよう、受け取ったらすぐ消す。変わっていればtrueを返す。
function takeToken() {
  const token = tokenFromHash(location.hash)
  if (!token) return false
  window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}`)
  const changed = token !== accessToken
  accessToken = token
  storage.set(TOKEN_KEY, token)
  return changed
}

// チャットのリンクの鍵を合言葉に引き換える。鍵は一度しか使えないので、すぐURLから消す。変わっていればtrueを返す。
async function takeTicket() {
  const ticket = ticketFromHash(location.hash)
  if (!ticket) return false
  window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}`)
  let response
  try {
    response = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-note-editor': '1' },
      body: JSON.stringify({ ticket }),
    })
  } catch {
    return false
  }
  // 期限切れのリンクでも、覚えているものが合っていれば開けるので、ここでは止めない。
  if (response.status === 401) keyRefused = true
  if (!response.ok) return false
  keyRefused = false // 引き換えられたので、前に断られたことは忘れる（古い「断られた」を送らない）
  const { token } = await response.json()
  const changed = token !== accessToken
  accessToken = token
  storage.set(TOKEN_KEY, token)
  return changed
}

const tokenHeader = () => (accessToken ? { 'x-note-token': accessToken } : {})

// 開けない画面を出すときに、Modへ「鍵のリンクがほしい」と知らせる。1回目と、その3秒後の2回目だけ。
// どちらも、鍵を断られたかどうか（keyRefused）を付ける。Modは断られたときだけClaudeに頼み直す。
// 返事の pending（Modが開き直しを頼んでいるか）で、画面の文を出し分ける。返事が来なければ、初めの文のまま。
// 開き直しを待つのは最長150秒。それでも開かなければ、「ノートを開く」の案内に戻す。
const LOCKED_RETRY_MS = 3000
const LOCKED_PENDING_MAX_MS = 150 * 1000
let ticketAsked = false
function askForTicket() {
  if (ticketAsked) return
  ticketAsked = true
  const title = $('locked-title')
  const body = $('locked-body')
  const defaults = [title.textContent, body.textContent]
  const draw = (pending) => {
    ;[title.textContent, body.textContent] = pending ? ['開き直しています…', 'Claudeの作業が終わると開きます。'] : defaults
  }
  let giveUp = 0
  const url = needTicketUrl(keyRefused)
  const ask = () => fetch(url, { method: 'POST', headers: { 'x-note-editor': '1' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (document.body.dataset.locked !== 'true') return
      if (!data) return
      draw(data.pending === true)
      if (data.pending === true && !giveUp) giveUp = setTimeout(() => draw(false), LOCKED_PENDING_MAX_MS)
    })
    .catch(() => {})
  ask().then(() => setTimeout(ask, LOCKED_RETRY_MS))
  // 同じ場所の別のタブが開けたら、こちらも読み込み直して開く。
  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_KEY && event.newValue) location.reload()
  })
}

function refuseToken() {
  tokenRefused = true
  if (view) otherVault()
  else {
    document.body.dataset.locked = 'true'
    askForTicket()
  }
}

function otherVault() {
  if (saver) saver.elsewhere()
  else if ($('status').dataset.state !== 'elsewhere') setStatus('elsewhere')
}

async function request(url, options = {}) {
  // 開けない画面のあいだは、どうせ断られる問い合わせを送らない。
  if (document.body.dataset.locked) return { status: 0, ok: false, data: null }
  const response = await fetch(url, {
    ...options,
    keepalive: unloading && (options.body?.length ?? 0) * 3 < KEEPALIVE_LIMIT,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      'x-note-editor': '1',
      ...(rootId ? { 'x-note-root': rootId } : {}),
      ...tokenHeader(),
      ...(chatLink ? { 'x-note-chat': chatLink } : {}),
      ...options.headers,
    },
  })
  if (response.status === 412) otherVault()
  if (response.status === 401) refuseToken()
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : null
  return { status: response.status, ok: response.ok, data, version: response.headers.get(VERSION_HEADER) }
}

const noteUrl = (path) => `/api/note?path=${encodeURIComponent(path)}`
const api = {
  async read(path) {
    const result = await request(noteUrl(path))
    if (!result.ok) throw Object.assign(new Error(result.data?.error ?? 'read failed'), { status: result.status })
    return result.data
  },
  async write(path, text, baseHash) {
    const result = await request(noteUrl(path), { method: 'PUT', body: JSON.stringify({ text, baseHash }) })
    if (result.status === 409) return result.data
    if (!result.ok) throw Object.assign(new Error(result.data?.error ?? 'save failed'), { status: result.status })
    if (isTaskFolderPath(path)) tasksSaved()
    else noteSaved()
    return result.data
  },
  async backup(path, text) {
    await request(`/api/backup?path=${encodeURIComponent(path)}`, { method: 'POST', body: JSON.stringify({ text }) })
  },
}

// テスト用のコピーと実際のVaultで同じパスの下書きが混ざらないよう、Vaultごとの印で分ける。
let vaultName = ''
// 右の枠は、同じノートの左の一時保存を消さないよう、別の名前で残す。
const drafts = {
  set: (path, draft) => storage.set(draftKey(vaultName, path, PANE), draft),
  remove: (path) => storage.remove(draftKey(vaultName, path, PANE)),
  get: (path) => storage.get(draftKey(vaultName, path, PANE)),
}

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.processingInstruction, color: 'var(--muted)' },
  { tag: tags.contentSeparator, color: 'var(--muted)' },
  { tag: tags.monospace, fontFamily: 'var(--mono)' },
  { tag: tags.keyword, color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--code-string)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--code-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--code-type)' },
])

let view = null
let saver = null
let events = null
let notes = []
let known = null
let currentPath = null
// ノートは編集の表示（live）で開く。上の「ソース」で Markdown の文字のままの表示（source）に切り替えられる。
let mode = 'live'
// ノートを開いた回の番号（openNote で中身を入れ替えるたびに1つ増やす）。
let openRound = 0
let rootPaths = []
let platform = 'darwin'
let vaultLabel = ''
let allNotes = []
// ファイル欄に出すフォルダー。中身のないフォルダーも入る。
let folders = []
let sourceOnly = false
let editable = true
let hoverWithMeta = false
let stateTimer = null

const OFFLINE_TEXT = 'サーバーにつながっていません。このフォルダーのClaudeのチャットが開いていれば、すぐにまたつながります。入力は続けられます。'
const GONE_TEXT = 'このフォルダーでClaudeのチャットを開くと、また使えるようになります。書いた文字は、このタブの下書きに残っています。'
const PORT_MOVED_TEXT = 'いつもと違う接続先で動いています。前の接続先で書いた下書きは、ここには出ません。'
const CHECK_TIMEOUT_MS = 4000
// サーバーが応答に付ける、自分のバージョン（server/config.mjs の VERSION_HEADER と同じ名前）。
const VERSION_HEADER = `x-${PRODUCT.toLowerCase()}-version`
const VERSION_CONFLICT_TEXT = `新しいバージョンの${PRODUCT}に入れ替わりました。保存がほかの変更とぶつかっているので、画面を読み込み直していません。どちらを残すか選ぶと、読み込み直します。`
let connectionWatch = null
let versionWatch = null
let currentReason = null

// 何か応答があればつながっている。401・412も、今の処理に任せてつながっている扱いにする。
// 応答のバージョンが、画面を読み込んだときと違えば（新しいバージョンに入れ替わった）、つながった知らせのあとで確かめる。
async function checkConnection() {
  if (document.hidden) return 'skip'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const { version } = await request('/api/health', { signal: controller.signal })
    if (versionWatch && version) setTimeout(() => versionWatch.seen(version).catch(() => {}), 0)
    return 'up'
  } catch {
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}

function connectionChanged(next) {
  const current = $('status').dataset.state
  if (next === 'online') {
    if (current !== 'offline' && current !== 'gone') return
    restoreBanner()
    if (currentPath) connectEvents(currentPath)
    if (saver) saver.save()
    else setStatus('saved')
    return
  }
  // ぶつかった・消えた・編集できないなど、もっと大事な表示を上書きしない。
  if (['conflict', 'removed', 'blocked', 'elsewhere', 'readonly'].includes(current)) return
  setStatus(next)
}

// つながったら、つながらない表示を消し、開いているノート本来の案内に戻す。
function restoreBanner() {
  const banner = $('banner')
  if (!editable) {
    banner.hidden = false
    banner.textContent = REASONS[currentReason] ?? '編集できません。'
  } else if (sourceOnly) {
    banner.hidden = false
    banner.textContent = '大きいファイルなので、ソース表示で開いています。'
  } else {
    banner.hidden = true
  }
}

// 読み込み直す前に、左と右の枠の書きかけを保存しきる。保存しきれなければ、下書きを書き直して読み込み直さない。
async function saveBeforeReload() {
  commitOpenField()
  await saver?.flush()
  const state = $('status').dataset.state
  if (saver && state === 'conflict') return 'conflict'
  if (saver && !CLEAN_STATES.has(state)) {
    saver.keepDraft()
    return 'failed'
  }
  if (split?.isOpen() && (await split.save()).dirty) return 'failed'
  return 'saved'
}

// 右の枠は左のページの中にあるので、読み込み直すのは左だけ（右も一緒に読み込み直される）。
function startVersionWatch(loaded) {
  if (PANE === 'right' || versionWatch) return
  versionWatch = createVersionWatch({
    loaded,
    save: saveBeforeReload,
    reload: () => location.reload(),
    notify: () => showNotice(VERSION_CONFLICT_TEXT),
  })
}

function startConnectionWatch() {
  if (connectionWatch) return
  connectionWatch = createConnectionWatch({ check: checkConnection, onChange: connectionChanged })
  connectionWatch.start()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) connectionWatch.poke()
  })
}

// タブを開いている間に1回だけ出すための印。中身は今までどおり notedock.portMovedShown。
const PORT_MOVED_KEY = `${PRODUCT.toLowerCase()}.portMovedShown`

function showPortMovedOnce(health) {
  if (!health.portMoved) return
  try {
    if (sessionStorage.getItem(PORT_MOVED_KEY)) return
  } catch {
    // 覚えられなくても、出すだけは出す。
  }
  showNotice(PORT_MOVED_TEXT)
  try {
    sessionStorage.setItem(PORT_MOVED_KEY, '1')
  } catch {
    // 同上。
  }
}

// 閉じるボタン付きのお知らせを、画面の上に出す。
function showNotice(text) {
  const notice = $('port-moved-notice')
  notice.replaceChildren(document.createTextNode(text), bannerButton('閉じる', () => { notice.hidden = true }))
  notice.hidden = false
}

function setStatus(state, detail = {}) {
  // つながらない間は、保存側の「未保存」「保存中」などでつながらない表示を消さない。
  const watched = connectionWatch?.state()
  if (watched && watched !== 'online' && ['saved', 'updated', 'dirty', 'saving', 'offline'].includes(state)) state = watched
  $('status').textContent = STATUS_TEXT[state] ?? ''
  $('status').dataset.state = state
  delete $('status').dataset.hint
  scheduleState()
  const banner = $('banner')
  if (state === 'conflict') {
    banner.hidden = false
    banner.replaceChildren(
      document.createTextNode('同じ行がほかから変更されたので、自動保存を止めました。どちらを残しますか。選ばなかった方はバックアップに残ります。'),
      bannerButton('違いを見る', () => compare(detail.theirs)),
      bannerButton('保存されているファイルの内容を使う', () => saver.resolve('theirs')),
      bannerButton('自分の内容を使う', () => saver.resolve('mine')),
    )
  } else if (state === 'removed') {
    banner.hidden = false
    banner.textContent = 'このノートは消えたか、名前が変わりました。自動保存を止めました。画面の内容はバックアップに残しています。'
  } else if (state === 'blocked') {
    banner.hidden = false
    banner.textContent = 'このファイルは編集できない形式に変わりました。自動保存を止めました。画面の内容は下書きに残しています。'
  } else if (state === 'elsewhere') {
    banner.hidden = false
    banner.replaceChildren(
      document.createTextNode(tokenRefused
        ? 'サーバーが変わったか、開き直しが必要になったので、保存を止めました。画面の内容はこのタブの下書きに残しています。Claudeのアプリで、入力欄の上の「ノートを開く」を押すと、続きから保存できます。'
        : 'このタブを開いたあとで、サーバーが別のフォルダーのものに変わりました。ここの内容を向こうへ書かないよう、保存を止めました。画面の内容はこのタブの下書きに残しています。'),
      bannerButton('開き直す', () => location.reload()),
    )
  } else if (state === 'save-failed') {
    banner.hidden = false
    banner.textContent = '保存できませんでした。書いた文字は、このタブの下書きに残っています。'
  } else if (state === 'offline') {
    banner.hidden = false
    banner.textContent = OFFLINE_TEXT
  } else if (state === 'gone') {
    banner.hidden = false
    banner.textContent = GONE_TEXT
  } else if (state !== 'readonly') {
    banner.hidden = true
  }
}

function bannerButton(label, run) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', run)
  return button
}

function compare(theirs) {
  $('compare-mine').textContent = view.state.doc.toString()
  $('compare-theirs').textContent = theirs ?? ''
  $('compare').showModal()
}

function softBreak(target) {
  const { state } = target
  const line = state.doc.lineAt(state.selection.main.head)
  const match = line.text.match(/^(\s*)(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/)
  if (!match) return insertNewline(target)
  const indent = ' '.repeat(match[0].length)
  target.dispatch(state.replaceSelection(`\n${indent}`), { scrollIntoView: true })
  return true
}

function runSpec(make) {
  return (target) => {
    if (target.state.readOnly) return false
    // ボタン1回を、Cmd+Zの1回にする。
    target.dispatch(make(target.state), { annotations: isolateHistory.of('full') })
    target.focus()
    return true
  }
}

function insertTable(target) {
  if (target.state.readOnly) return false
  const { from, spec } = tableSpec(target.state)
  target.dispatch(spec, { annotations: isolateHistory.of('full') })
  target.focus()
  beginTableCell(target, from, 0, 0)
  return true
}

async function insertLink(target) {
  if (target.state.readOnly) return false
  const { from, to } = target.state.selection.main
  const label = from === to ? await askText('リンクに表示する文字') : target.state.sliceDoc(from, to)
  if (!label?.trim()) {
    target.focus()
    return true
  }
  target.dispatch(linkSpec(target.state, label.trim()))
  target.focus()
  startCompletion(target)
  return true
}

const HEADING_MENU = [['本文', 0], ['見出し1', 1], ['見出し2', 2], ['見出し3', 3]]
const CALLOUT_MENU = [
  ['ℹ Note（補足）', 'NOTE'],
  ['💡 Tip（ヒント）', 'TIP'],
  ['❗ Important（重要）', 'IMPORTANT'],
  ['⚠ Warning（警告）', 'WARNING'],
  ['🛑 Caution（注意）', 'CAUTION'],
]

function menuBelow(button, items) {
  const rect = button.getBoundingClientRect()
  showMenu({ clientX: rect.left, clientY: rect.bottom + 2 }, items)
}

const TOOLBAR_ACTIONS = {
  heading: (button) => menuBelow(button, HEADING_MENU.map(([label, level]) => ({ label, run: () => runSpec((state) => headingSpec(state, level))(view) }))),
  bold: () => runSpec((state) => inlineSpec(state, 'bold'))(view),
  italic: () => runSpec((state) => inlineSpec(state, 'italic'))(view),
  strike: () => runSpec((state) => inlineSpec(state, 'strike'))(view),
  code: () => runSpec((state) => inlineSpec(state, 'code'))(view),
  bullet: () => runSpec((state) => lineKindSpec(state, 'bullet'))(view),
  number: () => runSpec((state) => lineKindSpec(state, 'number'))(view),
  task: () => runSpec((state) => lineKindSpec(state, 'task'))(view),
  quote: () => runSpec((state) => lineKindSpec(state, 'quote'))(view),
  link: () => insertLink(view),
  image: () => $('toolbar-image').click(),
  table: () => insertTable(view),
  rule: () => runSpec(horizontalRuleSpec)(view),
  codeblock: () => runSpec(codeBlockSpec)(view),
  callout: (button) => menuBelow(button, CALLOUT_MENU.map(([label, kind]) => ({ label, run: () => runSpec((state) => calloutSpec(state, kind))(view) }))),
  maketask: () => makeTaskAtCursor(),
}

// 変換中と、表のマスやノートの情報の欄を編集している間は、押しても何もしない。
function toolbarBusy() {
  return Boolean(view?.composing || view?.compositionStarted || document.activeElement?.closest?.('.cm-cell-editing, .cm-props'))
}

function syncToolbar() {
  const bar = $('toolbar')
  bar.hidden = !currentPath || !editable
  if (bar.hidden || !view) return
  const busy = toolbarBusy()
  const format = currentFormat(view.state)
  const pressed = {
    heading: format.heading > 0,
    bold: format.inline.has('bold'),
    italic: format.inline.has('italic'),
    strike: format.inline.has('strike'),
    code: format.inline.has('code'),
    bullet: format.line === 'bullet',
    number: format.line === 'number',
    task: format.line === 'task',
    quote: format.quote,
  }
  for (const button of bar.querySelectorAll('button')) {
    button.setAttribute('aria-disabled', String(busy))
    if (button.dataset.action in pressed) button.setAttribute('aria-pressed', String(pressed[button.dataset.action]))
  }
  $('toolbar-heading-label').textContent = format.heading > 0 ? `見出し${format.heading}` : '見出し'
}

function bindToolbar() {
  const bar = $('toolbar')
  // 押してもエディターのカーソルと選択を保つ。
  bar.addEventListener('mousedown', (event) => event.preventDefault())
  bar.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button || !view || toolbarBusy()) return
    TOOLBAR_ACTIONS[button.dataset.action]?.(button)
  })
  $('toolbar-image').addEventListener('change', (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file && view && !view.state.readOnly) uploadImage(file, view)
  })
  $('editor').addEventListener('focusin', syncToolbar)
  $('editor').addEventListener('focusout', () => setTimeout(syncToolbar, 0))
}

function addProperty(target) {
  askText('追加する項目の名前').then((name) => applyNewProperty(target, name))
  return true
}

function applyNewProperty(target, name) {
  if (!name?.trim()) return
  const doc = target.state.doc.toString()
  const front = doc.match(/^---\n[\s\S]*?\n---(?=\n|$)/)
  if (front) {
    target.dispatch({ changes: { from: 0, to: front[0].length, insert: setProperty(front[0], name.trim(), '') } })
  } else {
    target.dispatch({ changes: { from: 0, insert: `---\n${name.trim()}:\n---\n` } })
  }
  target.dispatch({ effects: togglePropsPanel.of(true) })
}

function saveNow() {
  saver?.save()
  return true
}

const editorKeys = keymap.of([
  ...completionKeymap,
  // 「a. 」「b. 」の英字の項目は先に見る（alpha-list.mjs）。次に英字の項目の下の子。そうでなければ Markdown の標準の続け方。
  { key: 'Enter', run: alphaListEnter },
  { key: 'Enter', run: alphaChildEnter },
  { key: 'Enter', run: insertNewlineContinueMarkup },
  { key: 'Backspace', run: deleteMarkupBackward },
  { key: 'Shift-Enter', run: softBreak },
  { key: 'Mod-b', run: runSpec((state) => inlineSpec(state, 'bold')), preventDefault: true },
  { key: 'Mod-i', run: runSpec((state) => inlineSpec(state, 'italic')), preventDefault: true },
  { key: 'Mod-k', run: (target) => { insertLink(target); return true }, preventDefault: true },
  { key: 'Mod-s', run: saveNow, preventDefault: true },
  { key: 'Mod-Alt-f', run: openSearchPanel, preventDefault: true },
  { key: 'Mod-;', run: addProperty, preventDefault: true },
  { key: 'Mod-Shift-t', run: insertTable, preventDefault: true },
  { key: 'Mod-Alt-[', run: (target) => foldAll(target), preventDefault: true },
  { key: 'Mod-Alt-]', run: (target) => unfoldAll(target), preventDefault: true },
  { key: 'Mod-Alt-t', run: () => makeTaskAtCursor(), preventDefault: true },
  ...closeBracketsKeymap,
  ...searchKeymap,
  ...foldKeymap,
  ...historyKeymap,
  ...defaultKeymap,
  indentWithTab,
])

const JA = {
  Find: '検索',
  Replace: '置換',
  next: '次へ',
  previous: '前へ',
  all: 'すべて選択',
  'match case': '大文字と小文字を区別',
  'by word': '単語で探す',
  regexp: '正規表現',
  replace: '置換',
  'replace all': 'すべて置換',
  close: '閉じる',
  'current match': '現在の位置',
  'on line': '行',
  'Folded lines': '折りたたんだ行',
  'Unfolded lines': '開いた行',
  'Fold line': '折りたたむ',
  'Unfold line': '開く',
  'folded code': '折りたたみ',
  unfold: '開く',
}

// 「**」と打つと閉じる側も入れる。閉じる側を自分で打ったときは重ねずに先へ進む。
const boldAutoPair = EditorView.inputHandler.of((target, from, to, text) => {
  if (text !== '*' || from !== to) return false
  const doc = target.state.doc
  const after = doc.sliceString(to, to + 1)
  if (after === '*') {
    target.dispatch({ selection: { anchor: from + 1 } })
    return true
  }
  const before = doc.sliceString(Math.max(0, from - 2), from)
  if (!before.endsWith('*') || before === '**') return false
  target.dispatch({ changes: { from, insert: '***' }, selection: { anchor: from + 1 } })
  return true
})

const editorEvents = EditorView.domEventHandlers({
  compositionstart(_, target) {
    target.dispatch({ effects: setComposing.of(true) })
    syncToolbar()
    return false
  },
  compositionend(_, target) {
    setTimeout(() => {
      // 確定と同時に次の変換が始まっていたら、その変換が終わるまで待つ。
      if (target.compositionStarted) return
      target.dispatch({ effects: setComposing.of(false) })
      saver?.compositionEnded()
      syncToolbar()
    }, 0)
    return false
  },
  blur(_, target) {
    if (target.state.field(previewField).composing) target.dispatch({ effects: setComposing.of(false) })
    return false
  },
  // 箇条書きの記号（•）や番号を押すと、その項目の子を開閉する。たためない項目では何もせず、今までどおりカーソルを置く。
  mousedown(event, target) {
    if (event.button !== 0 || event.altKey || event.shiftKey || event.metaKey || event.ctrlKey) return false
    const marker = event.target.closest?.('.cm-bullet, .cm-list-number')
    if (!marker || !target.contentDOM.contains(marker)) return false
    const effect = listMarkerFold(target.state, target.posAtDOM(marker))
    if (!effect) return false
    event.preventDefault()
    target.dispatch({ effects: effect })
    return true
  },
  paste(event, target) {
    const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'))
    if (!file || target.state.readOnly) return false
    event.preventDefault()
    uploadImage(file, target)
    return true
  },
})

// 開いた直後の印（記号を出さない）を、本人がエディターをクリックするかキーを押したら外す。
// 選択が変わる操作では、その変更で印が外れる（preview.mjs の quietAfter）。ここで外すのは、選択が変わらない場合の分。
// フォーカスがあるときに、今のカーソルと同じ位置（開いた直後の本文の先頭）をクリックしても選択は変わらない。
const quietEnders = EditorView.domEventObservers({
  keydown(event, target) {
    if (cursorQuiet(target.state) && keyEndsQuiet(event)) target.dispatch({ effects: setCursorQuiet.of(false) })
  },
  // 本文にフォーカスが入ったら、必ず印を外す（Tab、Cmd+E、新しく作ったノート、「編集」「ソース」のボタンのあと、表のマスなど）。
  // 印があるとカーソルの行の記号が隠れたままなので、打った文字やEnter・Backspaceが、見た目と違う所に効く（見出しの # が消えるなど）。
  // マウスで押したときは、押した位置にカーソルが動いてから外す。先に外すと、押した位置がずれる。上の mousedown が先に予約した処理
  // （部品を押したときのカーソルの移動）のあとに動くよう、同じ待ち方で予約する。mousedown が届かない押し方でも、これで外れる。
  // focusin は、表のマスなど本文の中の場所にフォーカスが入ったときにも届く（focus は本文そのものだけ）。
  focusin(event, target) {
    if (!cursorQuiet(target.state)) return
    if (focusEndsQuiet({ quiet: true, pressing: pressingEditor })) target.dispatch({ effects: setCursorQuiet.of(false) })
    else endQuietAfterClick(target, () => openRound)
  },
})

// 本文を押したときに、開いた直後の印を外す。エディターがクリックの位置を決めてから外す。その間に別のノートを開いていたら外さない（modes.mjs）。
// 本文の中の部品（コールアウトの題名、表、チェックボックス、箇条書きの記号など）を押したときは、本文にフォーカスが入ったときだけ外す。
// そのときカーソルが開いたときの1行目のままなら、押した部品の所へ動かす（modes.mjs の endQuietAfterClick と partCursor）。
// エディターは、押した操作を受け取らない部品（コールアウトの題名、表）では mousedown をこちらに回さないので、エディターの外（document）で受ける。
// リンクは押した時点で開くので（bindChrome）、ここでは何もしない。
document.addEventListener(
  'mousedown',
  (event) => {
    if (event.button !== 0 || !view || !cursorQuiet(view.state) || !view.contentDOM.contains(event.target)) return
    if (event.target.closest?.('[data-href]')) return
    const target = view
    const part = pressedPart(event.target, target.contentDOM)
    if (!part) {
      endQuietAfterClick(target, () => openRound)
      return
    }
    const kind = partKind(part)
    endQuietAfterClick(target, () => openRound, setTimeout, {
      focus: () => {
        const active = document.activeElement
        if (active === target.contentDOM) return 'body'
        return target.contentDOM.contains(active) ? 'inside' : null
      },
      cursor: (state, focus) => {
        if (!target.contentDOM.contains(part)) return null
        // 本文の中の入力の場所（表のマス、ノートの情報の欄の入力など）に入ったときは、表のときだけ表のすぐ後ろへ動かす（表には触れないので、マスの編集は続く）。
        if (focus !== 'body' && kind !== 'table') return null
        const box = kind === 'table' ? part.closest('.cm-table-wrap') : part
        return partCursor(state, { pos: target.posAtDOM(box), kind, length: box.noteSource?.length ?? 0 })
      },
    })
  },
  true,
)

// エディターの中をマウスや指で押している最中か。押したときのフォーカスは、押した位置が決まる前に入るので、上の focus で印を外さない。
// フォーカスは押したのと同じ流れの中で入るので、次の処理の順番が来たら戻す。
let pressingEditor = false
document.addEventListener(
  'pointerdown',
  (event) => {
    if (!$('editor')?.contains(event.target)) return
    pressingEditor = true
    setTimeout(() => {
      pressingEditor = false
    }, 0)
  },
  true,
)

async function uploadImage(file, target) {
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png'
  const name = file.name && file.name.includes('.') ? file.name : `image.${ext}`
  const response = await fetch(`/api/attachment?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'x-note-editor': '1', 'x-note-root': rootId, ...tokenHeader() },
    body: file,
  })
  if (response.status === 412) otherVault()
  if (response.status === 401) refuseToken()
  if (!response.ok) {
    showMessage('画像を保存できませんでした。')
    return
  }
  const { path } = await response.json()
  target.dispatch(target.state.replaceSelection(`![](${relativeHref(currentPath, path)})`))
}

function linkAt(state, pos, side) {
  // [[ ]]は1つの部品として表示するので、位置は端に来る。マウスのある側を見る。
  let node = syntaxTree(state).resolveInner(pos, side)
  while (node && node.name !== 'Link' && node.name !== 'WikiLink' && node.name !== 'Document') node = node.parent
  if (node?.name === 'WikiLink') {
    const link = wikiLinkOf(state.doc.sliceString(node.from + 2, node.to - 2), state.facet(noteContext))
    return link?.href ? { href: link.href, from: node.from, to: node.to } : null
  }
  if (!node || node.name !== 'Link') return null
  const url = node.getChild('URL')
  return url ? { href: state.doc.sliceString(url.from, url.to), from: node.from, to: node.to } : null
}

const hoverPreview = hoverTooltip(
  async (target, pos, side) => {
    if (!hoverWithMeta) return null
    const link = linkAt(target.state, pos, side)
    if (!link || isExternal(link.href)) return null
    const resolved = resolveHref(currentPath, link.href)
    if (!resolved?.path.endsWith('.md')) return null
    let note
    try {
      note = await api.read(resolved.path)
    } catch {
      return null
    }
    return {
      pos: link.from,
      end: link.to,
      above: true,
      create() {
        const dom = document.createElement('div')
        dom.className = 'note-hover'
        const inner = new EditorView({
          parent: dom,
          state: EditorState.create({
            doc: note.text.slice(0, 20000),
            extensions: [
              noteMarkdown(languages),
              noteContext.of({ path: resolved.path, known, isTooltip: true }),
              previewField,
              EditorView.editable.of(false),
              EditorState.readOnly.of(true),
              EditorView.lineWrapping,
              syntaxHighlighting(highlight),
            ],
          }),
        })
        inner.dispatch({ effects: setMode.of('reading') })
        return { dom, destroy: () => inner.destroy() }
      },
    }
  },
  { hoverTime: 250 },
)

function extensionsFor(path, canEdit) {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor({ key: 'Alt' }),
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
    EditorState.tabSize.of(4),
    indentUnit.of('\t'),
    EditorView.lineWrapping,
    EditorState.phrases.of(JA),
    closeBrackets(),
    boldAutoPair,
    search({ top: true }),
    foldGutter({ openText: '▾', closedText: '▸' }),
    autocompletion({
      override: [
        linkCompletion({ notes: () => notes, currentPath: () => currentPath }),
        wikiLinkCompletion({ notes: () => notes, known: () => known, currentPath: () => currentPath }),
      ],
      icons: false,
      defaultKeymap: false,
    }),
    syntaxHighlighting(highlight),
    noteMarkdown(languages),
    contextSlot.of(noteContextFor(path, canEdit)),
    previewField,
    hangingIndent,
    editableSlot.of(editableExtensions(canEdit)),
    editorKeys,
    editorEvents,
    quietEnders,
    hoverPreview,
    EditorView.updateListener.of(onUpdate),
    EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
  ]
}

// リンクの解決などに使う、開いているノートの情報。作り直すとき（タスクを作ったあと）も同じ中身にする。
function noteContextFor(path, canEdit) {
  return noteContext.of({ path, known, newNoteDir: defaultNoteDir(path, noteFolders(notes)), api, editable: canEdit })
}

function onUpdate(update) {
  if (update.docChanged) {
    const fromOutside = update.transactions.some((tr) => tr.annotation(external))
    if (!fromOutside) saver?.changed()
    scheduleOutline()
    if (PANE === 'right' && paneActive) schedulePaneOutline()
  }
  if (update.docChanged || update.selectionSet) {
    scheduleState()
    syncToolbar()
  }
  if (foldsChanged(update)) rememberFolds()
}

function rememberFolds() {
  if (!view || !currentPath) return
  storage.set(`folds:${vaultName}:${currentPath}`, foldedLines(view.state))
}

function restoreFolds(path) {
  const effects = []
  for (const number of storage.get(`folds:${vaultName}:${path}`, [])) {
    if (number > view.state.doc.lines) continue
    const line = view.state.doc.line(number)
    const range = foldable(view.state, line.from, line.to)
    if (range) effects.push(foldEffect.of(range))
  }
  if (effects.length) view.dispatch({ effects })
}

function applyMode(requested) {
  // 古い呼び出しや右の枠への連絡で 'reading' などが来ても、編集の表示として扱う。
  const next = noteMode(requested)
  if (sourceOnly && next !== 'source') return
  mode = next
  showPasteHint(false)
  for (const button of $('modes').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
  }
  document.body.dataset.mode = mode
  if (view) {
    view.dispatch({ effects: [setMode.of(mode), editableSlot.reconfigure(editableExtensions(editable))] })
  }
  syncToolbar()
}

const CLEAN_STATES = new Set(['saved', 'updated', 'readonly'])

const CHAT_POLL_MS = 1500
const CHAT_WAIT_MS = 30 * 60 * 1000
// 見出しをつかんでから、これだけ動かしたら移動を始める（px）。
const CHAT_DRAG_START = 5
const CHAT_DOCKS = ['top-left', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']
const CHAT_MAX_IMAGES = 5
const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const CHAT_IMAGE_MAX = 10 * 1024 * 1024
// 作業中の印がこれより長く書き直されていなければ、Claudeが止まったとみなして出さない。
const CHAT_STALE_MS = 20 * 1000

// ドロップした場所に近い置き場所を選ぶ。上は左右の2か所、下は左・中央・右の3か所。
function chatDockAt(x, y, width, height) {
  if (y < height / 2) return x < width / 2 ? 'top-left' : 'top-right'
  if (x < width / 3) return 'bottom-left'
  return x < (width * 2) / 3 ? 'bottom-center' : 'bottom-right'
}

const CHAT_IMAGE_NOTE = '添付した画像（Readで開いて見てください）:'

// 送った文の最後に付けた画像の場所を外し、本文と画像のファイル名に分ける。
export function splitChatImages(text) {
  const at = text.indexOf(CHAT_IMAGE_NOTE)
  if (at < 0) return { body: text, images: [] }
  const images = text
    .slice(at + CHAT_IMAGE_NOTE.length)
    .split('\n')
    .map((line) => line.replace(/^- /, '').trim())
    .filter(Boolean)
    .map((path) => path.split('/').pop())
  return { body: text.slice(0, at).trim(), images }
}

function elapsedText(since) {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `作業中 ${minutes}分${seconds % 60}秒` : `作業中 ${seconds}秒`
}

function readerView(parent, text) {
  const reader = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        noteMarkdown(languages),
        noteContext.of({ path: currentPath ?? '', known, isTooltip: true, localImagesOnly: true }),
        previewField,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        syntaxHighlighting(highlight),
      ],
    }),
  })
  reader.dispatch({ effects: setMode.of('reading') })
  return reader
}

// 窓のチャット欄の @ の候補。打っている語に合わせて一覧を出し、選んだら @場所#L12-18 か @場所 を入れる。
// 選んでいる行と見出しの節の行は、Mod が送るときに保存したファイルから読んで文に添える。
const MENTION_FRESH_MS = 5000
function editorForMention() {
  if (rightActive()) return { path: rightState.path, lines: rightState.lines, dirty: rightState.dirty }
  if (!currentPath || !view) return { path: null, lines: null, dirty: false }
  return { path: currentPath, lines: selectedLines(view.state), dirty: !CLEAN_STATES.has($('status').dataset.state) }
}
function noteIsDirty(path) {
  if (!path) return false
  if (path === rightState.path && rightState.dirty) return true
  return path === currentPath && Boolean(view) && !CLEAN_STATES.has($('status').dataset.state)
}
function setupMentions(input) {
  const list = $('chat-mentions')
  const saved = new Map() // 場所 → { at, sections }。見出しの行は保存した中身から数える。
  let items = []
  let hidden = 0
  let active = 0
  let at = null
  let seq = 0
  let closed = 0 // 閉じた回数。閉じる前に出した読み込みの中身は覚えない
  const hide = () => {
    list.hidden = true
    list.replaceChildren()
    items = []
    at = null
    input.removeAttribute('aria-activedescendant')
    input.setAttribute('aria-expanded', 'false')
  }
  const close = () => {
    // 待っている読み込みの結果で、閉じた一覧を出し直さない。保存した中身も次に開くときに読み直す。
    seq += 1
    closed += 1
    saved.clear()
    hide()
  }
  const sectionsFor = async (path) => {
    const mine = closed
    const got = saved.get(path)
    if (got && Date.now() - got.at < MENTION_FRESH_MS) return got.sections
    try {
      const data = await api.read(path)
      const sections = sectionsOf(data?.text ?? '')
      // 閉じたあとに届いた中身は覚えない（閉じるときに消したものを書き戻さない）。
      if (mine === closed) saved.set(path, { at: Date.now(), sections })
      return sections
    } catch {
      return null
    }
  }
  const choose = (index) => {
    const item = items[index]
    // 打ち進めたあとでも合うよう、語の場所はその場で取り直す。
    const here = mentionQuery(input.value, input.selectionStart ?? 0) ?? at
    if (!item || !here) return
    const next = applyMention(input.value, here, item.insert)
    input.focus()
    // 取り消し（Cmd+Z）で戻せるよう、打ったのと同じ形で入れる。使えなければ値を直接替える。
    input.setSelectionRange(here.from, here.to)
    const added = next.value.slice(here.from, next.value.length - (input.value.length - here.to))
    // insertText が使えないときは input が起きないので、高さを合わせるために自分で知らせる。
    if (!document.execCommand?.('insertText', false, added)) {
      input.value = next.value
      input.dispatchEvent(new Event('input'))
    }
    input.setSelectionRange(next.caret, next.caret)
    close()
  }
  const mark = () => {
    list.querySelectorAll('[role="option"]').forEach((row, index) => {
      const on = index === active
      row.setAttribute('aria-selected', String(on))
      if (on) {
        input.setAttribute('aria-activedescendant', row.id)
        row.scrollIntoView({ block: 'nearest' })
      }
    })
  }
  // 一覧の高さは、入力欄の上（枠が上にあるときは下）に画面の中で残っている分まで。
  const fit = () => {
    const box = input.getBoundingClientRect()
    const below = $('chat-panel').dataset.dock?.startsWith('top')
    list.dataset.side = below ? 'below' : 'above'
    const room = below ? innerHeight - box.bottom - 16 : box.top - 16
    list.style.maxHeight = `${Math.max(80, Math.min(280, room))}px`
  }
  const render = () => {
    if (!items.length && !hidden) {
      // 見出しを待っているあいだは、読み込みを止めずに隠すだけにする。
      hide()
      return
    }
    // 場所に空白や # @ : \ があるノートは、@ のあとに1語で書けない（# は行の指定と紛れる）ので出さず、理由だけ添える。
    const note = document.createElement('p')
    note.className = 'chat-mention-hidden'
    note.textContent = `場所に空白や # @ : \\ があるノート（${hidden}件）は、@ のあとに1語で書けないので出していません`
    list.replaceChildren(
      ...items.map((item, index) => {
        const row = document.createElement('div')
        row.id = `chat-mention-${index}`
        row.setAttribute('role', 'option')
        row.className = `chat-mention chat-mention-${item.kind}`
        const label = document.createElement('span')
        label.className = 'chat-mention-label'
        label.textContent = item.label
        row.append(label)
        if (item.detail) {
          const detail = document.createElement('span')
          detail.className = item.warn ? 'chat-mention-detail chat-mention-warn' : 'chat-mention-detail'
          detail.textContent = item.detail
          row.append(detail)
        }
        // 押したときに入力欄から目が離れないよう、mousedown で選ぶ。
        row.addEventListener('mousedown', (event) => {
          event.preventDefault()
          choose(index)
        })
        row.addEventListener('mousemove', () => {
          if (active === index) return
          active = index
          mark()
        })
        return row
      }),
      ...(hidden ? [note] : []),
    )
    list.hidden = false
    input.setAttribute('aria-expanded', 'true')
    fit()
    mark()
  }
  const refresh = async () => {
    const mine = ++seq
    const found = mentionQuery(input.value, input.selectionStart ?? 0)
    if (!found || input.selectionStart !== input.selectionEnd) {
      close()
      return
    }
    const editor = editorForMention()
    const target = headingTarget({ query: found.query, editor, notes })
    const show = (sections) => {
      const before = items[active]?.insert
      at = found
      items = mentionCandidates({
        query: found.query,
        editor,
        notes,
        headings: target && sections ? { path: target, sections, dirty: noteIsDirty(target) } : null,
      })
      hidden = unwritableCount(found.query, notes)
      const keep = items.findIndex((item) => item.insert === before)
      active = keep >= 0 ? keep : 0
      render()
    }
    // 先にノートの候補を出し、見出しは読めたら足す。
    const cached = target ? saved.get(target) : null
    show(cached && Date.now() - cached.at < MENTION_FRESH_MS ? cached.sections : null)
    if (!target || (cached && Date.now() - cached.at < MENTION_FRESH_MS)) return
    const sections = await sectionsFor(target)
    // 待っているあいだに打ち進めたり閉じたりしていたら、古い結果は捨てる。
    if (mine !== seq) return
    const again = mentionQuery(input.value, input.selectionStart ?? 0)
    if (!again || again.from !== found.from || again.query !== found.query) return
    show(sections)
  }
  // 一覧のスクロールバーを押しても、入力欄から目が離れて閉じないようにする。
  list.addEventListener('mousedown', (event) => event.preventDefault())
  input.setAttribute('aria-controls', 'chat-mentions')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-expanded', 'false')
  // IME の変換中は何もしない。確定したら（compositionend のあとの input で）読み直す。
  input.addEventListener('input', (event) => {
    if (event.isComposing) return
    refresh()
  })
  input.addEventListener('compositionend', () => refresh())
  input.addEventListener('click', () => refresh())
  input.addEventListener('blur', () => close())
  // チャット欄のほかの keydown（Cmd+Enter で送る）より先に呼ばれるよう、先に付ける。
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if (list.hidden) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') setTimeout(refresh)
      return
    }
    const take = () => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    if (!items.length && event.key !== 'Escape') return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      take()
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      mark()
    } else if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) || (event.key === 'Tab' && !event.shiftKey)) {
      take()
      choose(active)
    } else if (event.key === 'Escape') {
      take()
      close()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      setTimeout(refresh)
    } else if (event.key === 'Enter') {
      close()
    }
  })
  return { close }
}

// 会話を広げる・たたむボタンのアイコン。会話の記録が開く向きを指す山形にする（枠が下にあれば上へ、上にあれば下へ開く）。
const CHEVRON_UP = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10 8 5.5 12.5 10"/></svg>'
const CHEVRON_DOWN = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6 8 10.5 12.5 6"/></svg>'

// チャット枠はいつも出す。前は ?chat=1 のときだけ出していたが、開き方によっては付かず、枠が消えていた（2026-11-08）。
function setupChatBox() {
  const panel = $('chat-panel')
  const opener = $('chat-open')
  const box = $('chat-box')
  const input = $('chat-input')
  const wait = $('chat-wait')
  const notice = $('chat-notice')
  const log = $('chat-log')
  const expand = $('chat-expand')
  const files = $('chat-files')
  // 入力欄の高さを打った量に合わせる。上限（CSS の max-height）を超えたら、欄の中でスクロールする。
  // @ の候補より先に付け、候補の一覧の位置を測るときには、もう新しい高さになっているようにする。
  // 日本語の変換中も、変換中の文字の分だけ伸ばす（変換の窓が欄の外へずれないように、高さは変換中も合わせる）。
  const sizeInput = () => {
    input.style.height = 'auto'
    const max = parseFloat(getComputedStyle(input).maxHeight) || Infinity
    const want = input.scrollHeight + (input.offsetHeight - input.clientHeight)
    input.style.height = `${Math.min(want, max)}px`
    input.style.overflowY = want > max ? 'auto' : 'hidden'
  }
  input.addEventListener('input', sizeInput)
  // 窓の高さが変わると上限（40vh）も変わるので、合わせ直す。
  window.addEventListener('resize', sizeInput)
  // 枠の幅が変わると折り返しが変わるので、幅が変わったときも合わせる（高さの変化では呼ばない）。
  let inputWidth = 0
  new ResizeObserver(() => {
    if (input.clientWidth === inputWidth) return
    inputWidth = input.clientWidth
    sizeInput()
  }).observe(input)
  const mentions = setupMentions(input)
  let waiting = 0
  let timer = 0
  let lastFor = 0
  let logStamp = -1
  let working = 0
  let shown = []
  let logSeq = 0
  let images = []
  const say = (text) => {
    wait.textContent = text
  }
  // このタブを開いたチャット（サーバーが partner: 'live' と答えるあいだ）にだけ送る。つながっていなければ送れない。
  let noPartner = true
  let partner = 'none'
  let sending = false
  const syncSend = () => {
    $('chat-send').disabled = Boolean(waiting) || sending || noPartner
  }
  const readOwner = (got) => {
    partner = got?.partner === 'live' || got?.partner === 'gone' ? got.partner : 'none'
    noPartner = partner !== 'live'
    $('chat-owner').hidden = !noPartner
    if (noPartner) $('chat-owner').textContent = CHAT_PARTNER_TEXT[partner]
    $('chat-share-on').disabled = partner === 'none'
    if (partner === 'none') {
      $('chat-title').textContent = 'Claude（つながっていません）'
      $('chat-title').title = $('chat-title').textContent
    } else if (got?.title && !$('chat-title').dataset.fromLog) {
      $('chat-title').textContent = `Claude · ${got.title}`
      $('chat-title').title = $('chat-title').textContent
    }
    syncSend()
  }
  const refreshOwner = () => document.body.dataset.locked || panel.hidden ? Promise.resolve() : request('/api/chat-reply').then(({ data }) => readOwner(data)).catch(() => {})
  refreshOwner()
  setInterval(() => {
    if (!document.hidden) refreshOwner()
  }, CHAT_POLL_MS)

  // 開いているノートをClaudeに伝えるかどうか。最初はオフ。サーバーに覚えてもらう。
  const share = $('chat-share-on')
  request('/api/share').then(({ data }) => { share.checked = data?.on === true }).catch(() => {})
  share.addEventListener('change', async () => {
    const want = share.checked
    const saved = await request('/api/share', { method: 'PUT', body: JSON.stringify({ on: want }) }).catch(() => null)
    if (!saved?.ok) share.checked = !want
  })

  // 置き場所・広げたか・たたんだかは、次に開いたときも同じにする。
  const dockOf = () => (CHAT_DOCKS.includes(storage.get('chat-dock')) ? storage.get('chat-dock') : 'bottom-right')
  const place = (dock) => {
    panel.dataset.dock = dock
    opener.dataset.dock = dock
    storage.set('chat-dock', dock)
    drawExpand()
    document.body.classList.toggle('chat-on', !panel.hidden && dock.startsWith('bottom'))
  }
  // 読み上げのラベルは「会話」で固定し、開いているかは aria-expanded で伝える（ラベルも切り替えると二重に読まれる）。
  // マウスを乗せたときの説明（title）は、押すと何が起きるかを書く。
  const drawExpand = () => {
    const open = !log.hidden
    const top = panel.dataset.dock?.startsWith('top')
    expand.innerHTML = open === Boolean(top) ? CHEVRON_UP : CHEVRON_DOWN
    expand.title = open ? '会話をたたむ' : '会話を広げる'
  }
  const setExpanded = (open) => {
    log.hidden = !open
    expand.setAttribute('aria-expanded', String(open))
    // 文字のボタンは幅が狭いと2行に折り返すので、山形のアイコンにする（drawExpand）。
    drawExpand()
    storage.set('chat-expanded', open)
    if (open) {
      markSeen()
      logStamp = -1
      refreshLog()
    }
  }
  const setFolded = (folded, focus = false) => {
    panel.hidden = folded
    opener.hidden = !folded
    storage.set('chat-folded', folded)
    document.body.classList.toggle('chat-on', !folded && panel.dataset.dock.startsWith('bottom'))
    if (!folded) refreshOwner()
    if (!folded && focus) input.focus()
  }
  $('chat-fold').addEventListener('click', () => setFolded(true))
  opener.addEventListener('click', () => {
    setFolded(false, true)
    if (opener.classList.contains('unread')) setExpanded(true)
    opener.classList.remove('unread')
  })
  expand.addEventListener('click', () => setExpanded(log.hidden))

  // 見出しの部分をつかんで動かし、離した場所に近い置き場所へ収める。
  // 押しただけで動かさなければ何もしない。押した瞬間に枠が画面の上へ跳ねたり、置き場所が変わったりしないようにする（11/08）。
  const head = $('chat-head')
  head.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return
    event.preventDefault()
    const box = panel.getBoundingClientRect()
    const dx = event.clientX - box.left
    const dy = event.clientY - box.top
    head.setPointerCapture(event.pointerId)
    let started = false
    const move = (moved) => {
      if (!started) {
        if (Math.hypot(moved.clientX - event.clientX, moved.clientY - event.clientY) < CHAT_DRAG_START) return
        started = true
        panel.dataset.dragging = 'true'
      }
      panel.style.left = `${Math.min(Math.max(0, moved.clientX - dx), innerWidth - box.width)}px`
      panel.style.top = `${Math.min(Math.max(0, moved.clientY - dy), innerHeight - 40)}px`
    }
    const drop = (ended) => {
      head.removeEventListener('pointermove', move)
      head.removeEventListener('pointerup', drop)
      head.removeEventListener('pointercancel', drop)
      head.removeEventListener('lostpointercapture', drop)
      if (!started || !panel.dataset.dragging) return
      delete panel.dataset.dragging
      panel.style.left = ''
      panel.style.top = ''
      if (ended.type === 'pointerup') place(chatDockAt(ended.clientX, ended.clientY, innerWidth, innerHeight))
    }
    head.addEventListener('pointermove', move)
    head.addEventListener('pointerup', drop)
    head.addEventListener('pointercancel', drop)
    head.addEventListener('lostpointercapture', drop, { once: true })
  })

  // 枠の大きさを、端や角をドラッグして変える。置き場所の反対側の端をつかむ。
  const applySize = () => {
    const size = storage.get('chat-size', null)
    panel.style.setProperty('--chat-width', size?.width ? `${size.width}px` : '')
    panel.style.setProperty('--chat-log-height', size?.height ? `${size.height}px` : '')
  }
  applySize()
  for (const grip of panel.querySelectorAll('.chat-resize')) {
    grip.addEventListener('dblclick', () => {
      storage.remove('chat-size')
      applySize()
    })
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const axis = grip.dataset.axis
      const dock = panel.dataset.dock
      const startX = event.clientX
      const startY = event.clientY
      const width0 = panel.getBoundingClientRect().width
      const height0 = log.getBoundingClientRect().height || 0
      // 右に置いた枠は左の端を、左に置いた枠は右の端を引く。真ん中の枠は左右に同じだけ広がる。
      const xSign = dock.endsWith('right') ? -1 : dock === 'bottom-center' ? 2 : 1
      const ySign = dock.startsWith('top') ? 1 : -1
      grip.setPointerCapture(event.pointerId)
      panel.dataset.resizing = 'true'
      const move = (moved) => {
        const size = { ...storage.get('chat-size', {}) }
        if (axis.includes('x')) {
          size.width = Math.round(Math.min(Math.max(320, width0 + xSign * (moved.clientX - startX)), innerWidth - 32))
        }
        if (axis.includes('y') && !log.hidden) {
          size.height = Math.round(Math.min(Math.max(120, height0 + ySign * (moved.clientY - startY)), innerHeight - 220))
        }
        storage.set('chat-size', size)
        applySize()
      }
      const done = () => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', done)
        grip.removeEventListener('lostpointercapture', done)
        delete panel.dataset.resizing
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', done)
      grip.addEventListener('lostpointercapture', done)
    })
  }

  // 会話の表示。Modが書き出した最近の会話を並べ、作業中は経過時間を出す。
  const showWorking = () => {
    $('chat-state').textContent = working ? elapsedText(working) : ''
  }
  setInterval(showWorking, 1000)
  // 前と同じ項目は残し、変わったところから後ろだけ作り直す。読んでいる場所や選んだ文字が消えないようにする。
  const renderLog = (items) => {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
    // 古い項目が押し出されて先頭がずれた分は、先に外して並びを合わせる。
    const key = (item) => `${item.kind}\n${item.text}`
    if (items.length && shown.length && key(shown[0]) !== key(items[0])) {
      const at = shown.findIndex((old) => key(old) === key(items[0]))
      const drop = at > 0 ? at : shown.length
      for (const old of shown.slice(0, drop)) {
        old.reader?.destroy()
        old.row.remove()
      }
      shown = shown.slice(drop)
    }
    let same = 0
    while (same < items.length && same < shown.length && shown[same].kind === items[same].kind && shown[same].text === items[same].text) same += 1
    if (same === items.length && same === shown.length) return
    for (const old of shown.slice(same)) {
      old.reader?.destroy()
      old.row.remove()
    }
    log.querySelector('.chat-empty')?.remove()
    shown = shown.slice(0, same)
    for (const item of items.slice(same)) {
      const row = document.createElement('div')
      row.className = `chat-item chat-${item.kind}`
      const reader = item.kind === 'assistant' ? readerView(row, item.text) : null
      if (item.kind === 'user') {
        // 添付した画像は、場所の文字ではなく小さな見本で見せる。
        const { body, images: names } = splitChatImages(item.text)
        if (body && body !== '添付した画像を見てください。') row.append(body)
        if (names.length) {
          const strip = document.createElement('div')
          strip.className = 'chat-bubble-images'
          for (const name of names) {
            const image = document.createElement('img')
            image.src = chatImageUrl(name)
            image.alt = '添付した画像'
            image.addEventListener('error', () => image.replaceWith('（画像）'))
            strip.append(image)
          }
          row.append(strip)
        }
      } else if (!reader) row.textContent = item.text
      log.append(row)
      shown.push({ ...item, row, reader })
    }
    if (!shown.length) {
      const empty = document.createElement('p')
      empty.className = 'chat-empty'
      empty.textContent = 'まだ会話がありません。'
      log.append(empty)
    }
    if (nearBottom || logStamp <= 0) log.scrollTop = log.scrollHeight
  }
  const selectingInLog = () => {
    const selection = getSelection()
    return selection && !selection.isCollapsed && log.contains(selection.anchorNode)
  }
  const refreshLog = async () => {
    const seq = ++logSeq
    try {
      const { data } = await request('/api/chat-log')
      // 遅れて届いた古い応答で、新しい表示を上書きしない。
      if (!data || seq !== logSeq) return
      working = data.working && Date.now() - (data.at ?? 0) < CHAT_STALE_MS ? data.working : 0
      showWorking()
      // つながっているチャットの名前を出す（Modが分かる範囲で書いたもの）。まだ読めていなければ、プロジェクトの名前を出す。
      if (partner !== 'none' && (data.title || data.project)) {
        const name = data.title ? `Claude · ${data.title}` : `Claude · ${data.project}`
        $('chat-title').textContent = name
        $('chat-title').title = name
        $('chat-title').dataset.fromLog = '1'
      }
      if (log.hidden || (data.at ?? 0) === logStamp || selectingInLog()) return
      renderLog(data.items ?? [])
      logStamp = data.at ?? 0
    } catch {
      // 次に読むときにもう一度試す。
    }
  }
  refreshLog()
  setInterval(() => {
    if (!document.hidden) refreshLog()
  }, CHAT_POLL_MS)

  // 返事が届いたことを知らせる。会話を広げていれば、そこに出るので知らせない。
  const markSeen = () => {
    if (lastFor) tabFlags.set('chat-reply-seen', lastFor)
    notice.hidden = true
    opener.classList.remove('unread')
  }
  notice.addEventListener('click', () => setExpanded(true))
  const arrived = (got, unread = true) => {
    lastFor = got.for
    stopWaiting()
    // 送れなかった知らせは、返事としては扱わず、その場の一言だけにする。
    if (got.failed) {
      if (unread) say(got.text)
      markSeen()
      return
    }
    const visible = !panel.hidden && !log.hidden
    if (!unread || visible) {
      if (visible) markSeen()
      return
    }
    notice.hidden = false
    notice.textContent = '返事が届きました。クリックで開きます'
    opener.classList.add('unread')
  }
  const stopWaiting = () => {
    waiting = 0
    clearTimeout(timer)
    say('')
    syncSend()
    $('chat-cancel').hidden = true
  }
  $('chat-cancel').addEventListener('click', () => {
    stopWaiting()
    say('待つのをやめました。返事は、会話を広げるか、チャットのほうで見られます。')
  })
  const poll = async () => {
    if (!waiting) return
    if (Date.now() - waiting > CHAT_WAIT_MS) {
      stopWaiting()
      say('返事が届きませんでした。チャットのほうを見てください。')
      return
    }
    try {
      const { data: got } = await request('/api/chat-reply')
      if (got?.for === waiting) {
        arrived(got)
        return
      }
      if (got) readOwner(got)
      if (got && got.partner !== 'live') {
        say('つながっていたチャットが見つかりません。返事は届かないかもしれません。')
      } else if (wait.textContent.startsWith('つながっていた')) {
        say('送りました。返事を待っています…')
      }
    } catch {
      // 次に読むときにもう一度試す。
    }
    timer = setTimeout(poll, CHAT_POLL_MS)
  }
  const startWaiting = (at) => {
    waiting = at
    syncSend()
    notice.hidden = true
    $('chat-cancel').hidden = false
    say('送りました。返事を待っています…')
    clearTimeout(timer)
    timer = setTimeout(poll, CHAT_POLL_MS)
  }

  // 画像の添付。Vaultには入れず、エディターの作業フォルダーに置いて、その場所を文に添える。
  const showImages = () => {
    files.hidden = images.length === 0
    files.replaceChildren(
      ...images.map((image) => {
        const chip = document.createElement('span')
        chip.className = 'chat-file'
        const thumb = document.createElement('img')
        thumb.src = image.preview
        thumb.alt = image.name
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.textContent = '×'
        remove.title = 'この画像を外す'
        remove.addEventListener('click', () => {
          images = images.filter((other) => other !== image)
          showImages()
        })
        chip.append(thumb, remove)
        return chip
      }),
    )
  }
  const addImages = async (list) => {
    for (const file of list) {
      if (!CHAT_IMAGE_TYPES.has(file.type)) continue
      if (file.size > CHAT_IMAGE_MAX) {
        say('10MBより大きい画像は添付できません。')
        continue
      }
      if (images.length >= CHAT_MAX_IMAGES) {
        say(`画像は${CHAT_MAX_IMAGES}枚までです。`)
        break
      }
      const ext = file.type.split('/')[1].replace('jpeg', 'jpg')
      try {
        const { ok, data } = await request(`/api/chat-image?name=image.${ext}`, {
          method: 'POST',
          body: file,
          headers: { 'content-type': file.type },
        })
        if (!ok || !data?.path) throw new Error('upload')
        const preview = await new Promise((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = () => resolve('')
          reader.readAsDataURL(file)
        })
        images.push({ path: data.path, name: file.name || `image.${ext}`, preview })
      } catch {
        say('画像を添付できませんでした。')
      }
    }
    showImages()
  }
  $('chat-add').addEventListener('click', () => $('chat-file').click())
  $('chat-file').addEventListener('change', (event) => {
    addImages([...event.target.files])
    event.target.value = ''
  })
  input.addEventListener('paste', (event) => {
    const pasted = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
    if (!pasted.length) return
    event.preventDefault()
    addImages(pasted)
  })
  panel.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.types ?? [])].includes('Files')) event.preventDefault()
  })
  panel.addEventListener('drop', (event) => {
    const dropped = [...(event.dataTransfer?.files ?? [])]
    if (!dropped.length) return
    event.preventDefault()
    addImages(dropped)
  })

  box.addEventListener('submit', async (event) => {
    event.preventDefault()
    let text = input.value.trim()
    if ((!text && !images.length) || waiting || sending || noPartner) return
    if (images.length) {
      text = `${text || '添付した画像を見てください。'}\n\n添付した画像（Readで開いて見てください）:\n${images.map((image) => `- ${image.path}`).join('\n')}`
    }
    const at = Date.now()
    sending = true
    syncSend()
    // 送れたことを確かめてから入力欄を空にする。送れなければ、書いた文も画像もそのまま残す。
    const sent = await sendState({ sendChat: { text: text.slice(0, 4000), at } })
    sending = false
    syncSend()
    if (!sent?.ok) {
      // 文はそのまま残す。相手の様子を読み直してから、サーバーが断った理由に合わせた案内を出す。
      await refreshOwner()
      // 相手がいない案内がすでに出ていれば、同じ文を重ねて出さない。
      say(noPartner ? '送れませんでした。' : sendFailText(sent, partner))
      return
    }
    // このブラウザから送ったことを覚えておく。ほかのブラウザで送った文の返事は、読み込み直しても知らせない。
    tabFlags.set('chat-last-sent', at)
    input.value = ''
    sizeInput()
    mentions.close()
    images = []
    showImages()
    startWaiting(at)
  })
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault()
      box.requestSubmit()
    }
  })
  place(dockOf())
  setFolded(storage.get('chat-folded', false))
  setExpanded(storage.get('chat-expanded', false))
  // 読み込み直したときは、送ったまま返事がまだの文を待ち続け、届いていて見ていない返事は知らせる。
  request('/api/chat-reply')
    .then(({ data }) => {
      if (waiting || !data) return
      if (data.sent && data.for !== data.sent && Date.now() - data.sent < CHAT_WAIT_MS) startWaiting(data.sent)
      else if (data.for && data.text) arrived(data, data.for > tabFlags.get('chat-reply-seen') && data.for === tabFlags.get('chat-last-sent'))
    })
    .catch(() => {})
}

// 送れたかどうかを返す。チャット枠は結果を見て、送れなかったら入力を残す。
function sendState(extra = {}) {
  if ($('status').dataset.state === 'elsewhere') return Promise.resolve(null)
  // Claudeに知らせるのは左の枠だけ。右の枠は同じ中身を左へ渡す。
  if (PANE === 'right') {
    const open = Boolean(currentPath && view)
    const selection = open ? view.state.selection.main : null
    toLeft({
      type: MSG.STATE,
      path: open ? currentPath : null,
      selection: open ? view.state.sliceDoc(selection.from, selection.to).slice(0, 4000) : '',
      lines: open ? selectedLines(view.state) : null,
      dirty: open && !CLEAN_STATES.has($('status').dataset.state),
      ...(extra.askChat ? { askChat: extra.askChat } : {}),
    })
    return Promise.resolve(null)
  }
  // 右の枠が操作中なら、右の枠から知らされた中身を知らせる。左にノートがなく右だけ開いているときも、これで送れる。
  if (rightActive()) return putRightState(extra)
  // ノートを開いていなくても、チャット枠からは送れるようにする（帯やDev serversから開くと、ノートを開く前の画面になるため）。
  if (!currentPath || !view) {
    if (!extra.sendChat) return Promise.resolve(null)
    return request('/api/state', {
      method: 'PUT',
      body: JSON.stringify({ path: null, selection: '', dirty: false, ...extra }),
    }).catch(() => null)
  }
  const selection = view.state.selection.main
  const text = view.state.sliceDoc(selection.from, selection.to).slice(0, 4000)
  return request('/api/state', {
    method: 'PUT',
    body: JSON.stringify({ path: currentPath, selection: text, lines: selectedLines(view.state), dirty: !CLEAN_STATES.has($('status').dataset.state), ...extra }),
  }).catch(() => null)
}

// 右の枠が操作中のときに、右の枠から知らされた中身でClaudeに知らせる。/api/state を呼ぶのは左だけ。
function putRightState(extra = {}) {
  if ($('status').dataset.state === 'elsewhere') return Promise.resolve(null)
  return request('/api/state', {
    method: 'PUT',
    body: JSON.stringify({ path: rightState.path, selection: rightState.selection, lines: rightState.lines, dirty: rightState.dirty, ...extra }),
  }).catch(() => null)
}

function scheduleState() {
  clearTimeout(stateTimer)
  stateTimer = setTimeout(sendState, 400)
}

// 右の枠が操作中の間は、書いている見出しの一覧を、目次と同じく少し間を置いて左へ送る。
let paneOutlineTimer = null
function schedulePaneOutline() {
  clearTimeout(paneOutlineTimer)
  paneOutlineTimer = setTimeout(postOpened, 300)
}

function headingsForPane() {
  return headingsOf(view.state).map(({ level, text, from }) => ({ level, text, from }))
}

function postOpened() {
  toLeft({ type: MSG.OPENED, path: currentPath, headings: paneActive && view ? headingsForPane() : null })
}

let outlineTimer = null
function scheduleOutline() {
  if ($('outline').hidden) return
  clearTimeout(outlineTimer)
  outlineTimer = setTimeout(renderOutline, 300)
}

function renderOutline() {
  const box = $('outline')
  // 右の枠が操作中なら、右の枠から知らされた見出しを出し、押したら右の枠をその見出しへ動かす。
  const right = rightActive()
  if (box.hidden || (!right && !view)) return
  box.replaceChildren()
  const headings = right ? (rightState.headings ?? []) : headingsOf(view.state)
  const path = right ? rightState.path : currentPath
  if (!headings.length) {
    const empty = document.createElement('p')
    empty.className = 'outline-empty'
    empty.textContent = path ? 'このノートには見出しがありません。' : 'ノートを開くと、見出しがここに出ます。'
    box.append(empty)
    return
  }
  for (const heading of headings) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `outline-item outline-${heading.level}`
    item.textContent = heading.text || '（無題）'
    item.addEventListener('click', () => {
      if (right) split.post({ type: MSG.JUMP, from: heading.from })
      else jumpTo(heading.from)
      // 狭い幅では目次が本文に重なるので、閉じて移動先を見せる。
      if (isNarrow()) box.hidden = true
    })
    box.append(item)
  }
}

// 目次と一覧は同じ場所に出る。目次を閉じたら、開く前に一覧が出ていれば一覧に戻す。
// 開く前の状態に戻すためなので、次回の表示の設定は変えない。
let filesUnderOutline = false
let calendarUnderOutline = false
let tasksUnderOutline = false
function closeOutline() {
  const box = $('outline')
  if (box.hidden) return
  box.hidden = true
  if (calendarUnderOutline) {
    $('calendar').hidden = false
    drawCalendar()
  }
  if (tasksUnderOutline) {
    $('tasks-side').hidden = false
    refreshTaskSide()
  }
  if (filesUnderOutline) {
    $('files').hidden = false
    drawFiles()
  }
  calendarUnderOutline = false
  tasksUnderOutline = false
  filesUnderOutline = false
}

function toggleOutline() {
  const box = $('outline')
  if (box.hidden) {
    filesUnderOutline = !$('files').hidden
    calendarUnderOutline = !$('calendar').hidden
    tasksUnderOutline = !$('tasks-side').hidden
    $('files').hidden = true
    $('calendar').hidden = true
    $('tasks-side').hidden = true
    box.hidden = false
    renderOutline()
  } else {
    closeOutline()
  }
}

// 狭い幅では右の列が本文に重なる。ノートを開いたら、一覧もカレンダーも閉じる（次回の表示の設定は変えない）。
// 右の列（カレンダーとファイルの一覧、目次）の幅を、左の端をドラッグして変える。幅はブラウザが覚える。
const SIDE_MIN = 200
const SIDE_MAX = 640
const EDITOR_MIN = 320

function clampSideWidth(width) {
  const room = $('layout').getBoundingClientRect().width - EDITOR_MIN
  return Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, room, width)))
}

function applySideWidth() {
  const saved = storage.get('side-width', null)
  if (typeof saved === 'number') $('layout').style.setProperty('--side-width', `${clampSideWidth(saved)}px`)
  else $('layout').style.removeProperty('--side-width')
}

function setupSideResize() {
  const grip = $('side-resize')
  applySideWidth()
  window.addEventListener('resize', applySideWidth)
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    grip.setPointerCapture(event.pointerId)
    document.body.classList.add('side-resizing')
    const right = $('layout').getBoundingClientRect().right
    let width = null
    const move = (e) => {
      width = clampSideWidth(right - e.clientX)
      $('layout').style.setProperty('--side-width', `${width}px`)
    }
    const end = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', end)
      grip.removeEventListener('pointercancel', end)
      document.body.classList.remove('side-resizing')
      if (width !== null) storage.set('side-width', width)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  })
  grip.addEventListener('dblclick', () => {
    storage.remove('side-width')
    applySideWidth()
  })
}

function closeSideIfNarrow() {
  if (!isNarrow()) return
  $('calendar').hidden = true
  $('tasks-side').hidden = true
  $('files').hidden = true
}

// 一覧もカレンダーもタスクも隠れたら、右の列ごと隠す。
function syncSide() {
  $('side').hidden = $('calendar').hidden && $('tasks-side').hidden && $('files').hidden
}
new MutationObserver(syncSide).observe($('calendar'), { attributes: true, attributeFilter: ['hidden'] })
new MutationObserver(syncSide).observe($('tasks-side'), { attributes: true, attributeFilter: ['hidden'] })
new MutationObserver(syncSide).observe($('files'), { attributes: true, attributeFilter: ['hidden'] })

function jumpTo(pos) {
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 20 }) })
}

// 見出しの位置まで見せるだけで、カーソルは動かさない（開いた直後の印も外さないので、先頭の見出しの # も出ない）。
function jumpToAnchor(anchor) {
  if (!anchor) return
  const heading = findHeading(headingsOf(view.state), anchor)
  if (heading) jumpTo(heading.from)
}

const RECONNECT_MS = 3000

function connectEvents(path) {
  events?.close()
  events = new EventSource(`/api/events?path=${encodeURIComponent(path)}&root=${rootId}${accessToken ? `&t=${accessToken}` : ''}`)
  // 別のVaultのサーバーに断られると再接続されないので、断られたのかを確かめる。
  events.onerror = async () => {
    connectionWatch?.poke()
    try {
      const { ok } = await request('/api/health')
      // ファイルが消えている間につながり直すと断られ、自動では再接続されない。
      if (ok && events?.readyState === EventSource.CLOSED) {
        setTimeout(() => {
          if (path === currentPath && events?.readyState === EventSource.CLOSED) connectEvents(path)
        }, RECONNECT_MS)
      }
    } catch {
      // サーバーが止まっている間は、ブラウザが自動でつなぎ直す。
    }
  }
  const receive = (note) => {
    if (saver && note.editable) saver.applyExternal(note.text, note.hash)
    else if (saver) saver.blocked()
    else docAdapter.set(note.text)
  }
  events.addEventListener('changed', (event) => receive(JSON.parse(event.data)))
  events.addEventListener('removed', () => saver?.removed())
  // つながるまでの間やつながり直すまでの間の変更は知らせが来ないので、読み直して確かめる。
  events.onopen = async () => {
    if (path !== currentPath) return
    try {
      const note = await api.read(path)
      if (path === currentPath) receive(note)
    } catch (error) {
      if (error.status === 404) saver?.removed()
    }
    if (['offline', 'save-failed'].includes($('status').dataset.state)) saver?.save()
  }
}

const docAdapter = {
  get: () => view.state.doc.toString(),
  set(text) {
    const change = minimalChange(view.state.doc.toString(), text)
    if (!change) return
    view.dispatch({ changes: change, annotations: [external.of(true), Transaction.addToHistory.of(false)] })
  },
  // 表のマスやノートの情報の欄を編集している間も、外からの変更で入力中の内容が消えないよう待つ。
  composing: () => view.composing || view.compositionStarted || Boolean(document.activeElement?.closest?.('.cm-cell-editing, .cm-props')),
  // 変換の途中の文字は保存しない。マスの編集中でも、本文に書き戻した分は保存してよい。
  holdSave: () => view.composing || view.compositionStarted,
}

// 編集中のマスや入力欄は、外へ出たときに本文へ書き戻される。
function commitOpenField() {
  const field = document.activeElement
  if (field?.closest?.('.cm-cell-editing, .cm-props')) field.blur()
}

let openRequest = 0

// focus：新しく作ったノートのときだけ true。本文にフォーカスを入れて、すぐ打てるようにする。
// 既にあるノートは入れない。開いた直後のキーが本文に届くと、隠れた記号の前後で打った文字が見た目と違う所に入るため（見出しの # が消えるなど）。
async function openNote(path, { push = true, anchor = '', startMode = 'live', focus = false } = {}) {
  openRequest += 1
  const thisRequest = openRequest
  let note
  try {
    note = await api.read(path)
  } catch (error) {
    if (error.status === 404 && (await askConfirm(`「${path}」はまだありません。新しく作りますか。`, '作る'))) {
      const created = await request(noteUrl(path), { method: 'POST', body: JSON.stringify({ text: '' }) })
      if (created.ok) {
        await refreshNotes()
        return openNote(path, { push, anchor, startMode: 'live', focus: true })
      }
      showMessage('このノートは作れません。')
      return
    }
    if (error.status === 400) showMessage('このファイルは開けません。')
    return
  }
  // 続けて開いたときは、最後に頼まれたノートを開く。
  if (thisRequest !== openRequest) return
  commitOpenField()
  await saver?.flush()
  if (thisRequest !== openRequest) return
  saver?.close()
  saver = null
  currentPath = path
  // 右の枠でゴミ箱へ移したノートの代わりに別のノートを開いたので、右の枠を閉じても読み込み直さない。
  reloadAfterSplit = false
  lastTask = null
  hideTaskNotice()
  // 右の枠では、カレンダーとファイルの一覧を使わない（左の一覧の開閉の記録も書き換えない）。
  if (PANE !== 'right') renderCalendar()
  sourceOnly = note.sourceOnly
  editable = note.editable
  const nextMode = sourceOnly ? 'source' : noteMode(startMode)
  mode = nextMode
  // YAMLの中にカーソルを置くと文字で見えてしまうので、本文の先頭から始める。
  const front = note.text.match(/^---\n[\s\S]*?\n---(?:\n|$)/)
  let state = EditorState.create({
    doc: note.text,
    selection: { anchor: front ? Math.min(front[0].length, note.text.length) : 0 },
    extensions: extensionsFor(path, editable),
  })
  // 本文の最初の行が見出しの # や箇条書きの - などで始まるなら、その記号のあとから始める（開いた直後は記号を隠すので、見た目の位置にそろえる）。
  const start = typingStart(state, state.selection.main.head)
  if (start !== state.selection.main.head) state = state.update({ selection: { anchor: start }, annotations: Transaction.addToHistory.of(false) }).state
  // 開いた回を数える。クリックのあとで印を外す処理が、次に開いたノートの印を外さないように使う。
  openRound += 1
  if (view) view.setState(state)
  else view = new EditorView({ state, parent: $('editor') })
  // 開いた直後は、カーソルが先頭にあっても記号を出さない（本人が本文をクリックするまで。マウス以外で本文にフォーカスが入ったときも外す）。
  view.dispatch({ effects: setCursorQuiet.of(true) })
  applyMode(nextMode)
  // タスクのノートは、開いたらすぐステータスや期日を直せるように、プロパティ欄を開いておく。
  if (isTaskNote(note.text)) view.dispatch({ effects: togglePropsPanel.of(true) })
  renderCrumbs(path)
  $('copy-path').disabled = false
  document.title = path.split('/').at(-1).replace(/\.md$/i, '')
  if (push) pushNoteUrl(path, anchor)
  rememberRecent(path)
  const banner = $('banner')
  banner.hidden = true
  currentReason = editable ? null : note.reason
  let restored = false
  if (editable) {
    saver = createSaver({ doc: docAdapter, api, path, baseText: note.text, baseHash: note.hash, onStatus: ({ state: s, ...d }) => setStatus(s, d), drafts })
    setStatus('saved')
    // 右の枠が閉じていて左の一時保存がなければ、右の枠に残った一時保存を左で戻す。
    const picked = pickDraft({
      pane: PANE,
      left: storage.get(draftKey(vaultName, path, 'left')),
      right: storage.get(draftKey(vaultName, path, 'right')),
      rightOpen,
    })
    // 右の一時保存を左へ移すときは、先に左に書いてから右を消す。どちらにも残っていない間を作らない。
    if (picked.removeRight) {
      drafts.set(path, picked.draft)
      storage.remove(draftKey(vaultName, path, 'right'))
    }
    restored = saver.restoreDraft(picked.draft)
  } else {
    setStatus('readonly')
    banner.hidden = false
    banner.textContent = REASONS[note.reason] ?? '編集できません。'
  }
  if (sourceOnly && editable) {
    banner.hidden = false
    banner.textContent = '大きいファイルなので、ソース表示で開いています。'
  }
  connectEvents(path)
  restoreFolds(path)
  renderOutline()
  if (PANE !== 'right') revealInFiles(path)
  jumpToAnchor(anchor)
  sendState()
  if (PANE === 'right') postOpened()
  // 既にあるノートでは、本文をクリックしてから書き始める。view は使い回すので、前のノートで本文（や表のマスなど）にフォーカスがあると、
  // そのまま残って開いた直後のキーが届く。残っていたら外す（リンクを押したとき、「探す」を閉じたとき、戻るボタンなど）。
  if (focus) view.focus()
  else if ($('editor').contains(document.activeElement)) document.activeElement.blur()
  if (restored && saver.isStopped() !== 'conflict') {
    showMessage('前回保存できなかった入力を戻して保存します。いらないときは、右上の「履歴」から前の内容に戻せます。')
  }
  refreshTaskPanel()
  return undefined
}

function pushNoteUrl(path, anchor) {
  const url = `/?note=${encodeURIComponent(path)}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`
  // 右の枠で開いたノートを、ブラウザの「戻る」の履歴に積まない。
  // アドレスは /?pane=right のままにする。?note= に変えると、右の枠を読み込み直したときに左として開いてしまう。
  if (PANE === 'right') window.history.replaceState({ path }, '', '/?pane=right')
  else window.history.pushState({ path }, '', url)
}

function rememberRecent(path) {
  const recent = storage.get(`recent:${vaultName}`, []).filter((item) => item !== path)
  recent.unshift(path)
  storage.set(`recent:${vaultName}`, recent.slice(0, 20))
}

function openHref(href, newTab) {
  if (isExternal(href)) {
    if (/^https?:|^mailto:/i.test(href)) window.open(href, '_blank', 'noopener')
    return
  }
  const target = resolveHref(currentPath, href)
  if (!target) {
    showMessage('Vaultの外へのリンクは開けません。')
    return
  }
  if (target.path === currentPath) {
    jumpToAnchor(target.anchor)
    return
  }
  if (!target.path.toLowerCase().endsWith('.md')) {
    if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(target.path)) {
      window.open(fileUrl(target.path), '_blank', 'noopener')
    } else {
      showMessage(`「${target.path}」はエディターで開けません。`)
    }
    return
  }
  if (newTab && PANE === 'right') {
    toLeft({ type: MSG.OPEN, path: target.path, anchor: target.anchor })
    return
  }
  // Cmd+クリックは、ブラウザの別のタブではなく、反対側（右）の枠で開く。
  if (newTab) {
    openIn(targetPane({ meta: true, from: 'left', active: activePane() }), target.path, { anchor: target.anchor })
    return
  }
  openNote(target.path, { anchor: target.anchor })
}

// 左右どちらかの枠でノートを開く。右に開くときは、分けていなければ先に分ける。
async function openIn(pane, path, { anchor = '', startMode = 'live', focus = false } = {}) {
  // 狭い画面では分けないので、左で開く。
  if (pane !== 'right' || !split || isNarrow()) return openNote(path, { anchor, startMode, focus })
  if (!split.isOpen()) {
    // 右の枠の準備ができたら開いてもらう（READY のところで送る）。
    rightWant = { path, anchor, startMode, focus }
    await openSplit()
    return undefined
  }
  split.post({ type: MSG.OPEN, path, anchor, startMode, focus })
  return undefined
}

async function refreshNotes() {
  const result = await request('/api/notes')
  if (!result.ok) return
  notes = result.data.notes
  allNotes = result.data.known
  folders = result.data.folders ?? []
  $('files-notice').hidden = !result.data.truncated
  const changed = JSON.stringify([result.data.notes, folders]) !== filesRendered
  known = new Set(result.data.known.map(normalizeKey))
  // 変わっていなければ描き直さない。キーボードの位置が外れないようにする。
  if (changed && PANE !== 'right') renderFiles()
}

const NARROW_WIDTH = 860
let filesOpen = new Set()
let filesRendered = ''

function saveFilesOpen() {
  storage.set(`files-open:${vaultName}`, [...filesOpen])
}

function renderFiles() {
  const box = $('files')
  if (box.hidden) return
  const scroll = box.scrollTop
  const rows = []
  const more = (row) => {
    // ボタンの中に置くので、押したときに行のほうの動き（開く）が起きないようにする。
    const dots = document.createElement('span')
    dots.className = 'files-more'
    dots.textContent = '…'
    dots.title = 'メニュー'
    dots.addEventListener('click', (event) => {
      event.stopPropagation()
      const rect = dots.getBoundingClientRect()
      openFilesMenu(row, rect.left, rect.bottom)
    })
    return dots
  }
  const walk = (folder, depth) => {
    for (const child of folder.folders) {
      const open = filesOpen.has(child.path)
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'files-row files-folder'
      row.style.setProperty('--depth', String(depth))
      row.setAttribute('aria-expanded', String(open))
      row.title = child.path
      row.dataset.path = child.path
      row.dataset.kind = 'folder'
      row.draggable = true
      const arrow = document.createElement('span')
      arrow.className = 'files-arrow'
      arrow.textContent = open ? '▾' : '▸'
      const name = document.createElement('span')
      name.className = 'files-name'
      name.textContent = child.name
      row.append(arrow, name, more(row))
      row.addEventListener('click', () => {
        if (filesOpen.has(child.path)) filesOpen.delete(child.path)
        else filesOpen.add(child.path)
        saveFilesOpen()
        renderFiles()
      })
      rows.push(row)
      if (open) walk(child, depth + 1)
    }
    for (const file of folder.files) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'files-row files-note'
      row.style.setProperty('--depth', String(depth))
      row.title = file.path
      row.dataset.path = file.path
      row.dataset.kind = 'note'
      row.draggable = true
      if (file.path === currentPath) row.setAttribute('aria-current', 'true')
      const name = document.createElement('span')
      name.className = 'files-name'
      name.textContent = file.name
      row.append(name, more(row))
      row.addEventListener('click', (event) => {
        openIn(targetPane({ meta: event.metaKey || event.ctrlKey, from: 'sidebar', active: activePane() }), file.path)
        // 狭い幅で自動で閉じるだけなので、次回の表示の設定は変えない。
        if (PANE !== 'right' && innerWidth < NARROW_WIDTH) $('files').hidden = true
        closeSideIfNarrow()
      })
      rows.push(row)
    }
  }
  walk(buildTree(notes, folders), 0)
  filesRendered = JSON.stringify([notes, folders])
  box.replaceChildren(...rows)
  box.scrollTop = scroll
}

// ---- ファイル欄の操作（右クリックと「…」のメニュー、ドラッグで動かす） ----

const baseOf = (path) => path.slice(path.lastIndexOf('/') + 1)
const dirOf = (path) => path.split('/').slice(0, -1).join('/')
const joinDir = (dir, name) => (dir ? `${dir}/${name}` : name)
const inside = (path, folder) => path === folder || path.startsWith(`${folder}/`)

// 置き場所を選ぶ画面に出すフォルダー。ファイル欄と同じく、中身のないフォルダーも入れる。
function placeFolders() {
  return [...new Set([...folders, ...noteFolders(notes)])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }))
}

const recentPlacesKey = () => `recent-places:${vaultName}`

function closeFilesMenu() {
  document.querySelector('.files-menu')?.remove()
}

function openFilesMenu(row, x, y) {
  closeFilesMenu()
  const path = row?.dataset.path ?? ''
  const kind = row?.dataset.kind ?? 'top'
  const items = []
  if (kind !== 'note') {
    items.push(['この中に新しいノート', () => newNoteIn(path)], ['この中に新しいフォルダー', () => newFolderIn(path)])
  }
  if (kind !== 'top') {
    items.push(['名前を変える', () => renameItem(path, kind)], ['移動…', () => moveItemTo(path, kind)], ['ゴミ箱に入れる', () => trashItem(path, kind)])
  }
  const menu = document.createElement('div')
  menu.className = 'files-menu'
  menu.setAttribute('role', 'menu')
  for (const [label, run] of items) {
    const item = document.createElement('button')
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    item.textContent = label
    item.addEventListener('click', () => {
      closeFilesMenu()
      run()
    })
    menu.append(item)
  }
  document.body.append(menu)
  const width = menu.offsetWidth
  const height = menu.offsetHeight
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`
  menu.querySelector('button')?.focus()
}

function newNoteIn(dir) {
  newNoteFromButton(dir)
}

async function newFolderIn(dir) {
  const name = (await askText(`「${dir || vaultLabel || '一番上'}」の中に作るフォルダーの名前`))?.trim()
  if (!name) return
  if (name.includes('/') || name.startsWith('.')) {
    showMessage('フォルダーの名前に「/」は使えません。点で始まる名前も使えません。')
    return
  }
  const path = joinDir(dir, name)
  const made = await request('/api/folder', { method: 'POST', body: JSON.stringify({ path }) })
  if (!made.ok) {
    showMessage(made.status === 409 ? '同じ名前のフォルダーかファイルが、もうあります。' : 'フォルダーを作れませんでした。')
    return
  }
  for (const folder of [...ancestorsOf(`${path}/x`)]) filesOpen.add(folder)
  saveFilesOpen()
  await refreshNotes()
  showFiles(true)
}

async function renameItem(path, kind) {
  const old = kind === 'note' ? baseOf(path).replace(/\.md$/i, '') : baseOf(path)
  const name = (await askText('新しい名前', old))?.trim()
  if (!name || name === old) return
  if (name.includes('/') || name.startsWith('.')) {
    showMessage('名前に「/」は使えません。点で始まる名前も使えません。')
    return
  }
  // 新しいノートを作るときと同じく、「\」と「:」は「-」に置き換える。
  const clean = name.replace(/[\\:]/g, '-')
  const to = joinDir(dirOf(path), kind === 'note' ? `${clean.replace(/\.md$/i, '')}.md` : clean)
  doMove(path, to, true)
}

async function moveItemTo(path, kind) {
  const dir = await askPlace({
    title: `「${baseOf(path)}」を動かす先`,
    folders: placeFolders(),
    start: dirOf(path),
    topLabel: vaultLabel || 'フォルダー',
    recent: storage.get(recentPlacesKey(), []),
    childFolders,
    searchFolders,
    exclude: (folder) => kind === 'folder' && inside(folder, path),
  })
  if (dir === null || dir === dirOf(path)) return
  doMove(path, joinDir(dir, baseOf(path)))
}

// 動かす前に、ほかのノートのリンクを数えて、書き換えるかを聞く。開いているノートは先に保存する。
// confirm を付けると、リンクがなくても動かしてよいかを聞く（フォルダーをドラッグしたときなど）。
async function doMove(from, to, rename = false, confirm = false) {
  if (to === from) return
  commitOpenField()
  await saver?.flush()
  const plan = await request('/api/move/plan', { method: 'POST', body: JSON.stringify({ from, to }) })
  let relink = false
  let skipPlan = false
  if (!plan.ok) {
    const reason = planFailure(plan.status, plan.data)
    if (reason !== 'truncated') {
      showMessage(reason === 'exists' ? '動かす先に、同じ名前のノートかフォルダーがもうあります。' : '動かせませんでした。')
      return
    }
    // 一覧が途中までなので、リンクは確かめられない。書き換えずに動かすかだけを聞く。
    const choice = await askChoice('ノートが多いため、リンクを全部は確かめられません。リンクは書き換えずに動かしますか？', [{ label: 'リンクは書き換えずに動かす', value: 'move', primary: true }])
    if (!choice) return
    skipPlan = true
  }
  const changes = skipPlan ? [] : plan.data.changes ?? []
  const blocked = skipPlan ? [] : plan.data.blocked ?? []
  const unreadable = skipPlan ? [] : plan.data.unreadable ?? []
  const what = rename ? `「${baseOf(from)}」を「${baseOf(to)}」に変えます。` : `「${from}」を「${dirOf(to) || vaultLabel || '一番上'}」へ動かします。`
  if (changes.length || blocked.length || unreadable.length) {
    const links = changes.reduce((sum, change) => sum + change.count, 0)
    const list = changes.slice(0, 5).map((change) => `・${change.path}`).join('\n')
    const lines = [what]
    if (changes.length) lines.push(`${changes.length}件のノートにある、${links}か所のリンクも書き換えます。`, `${list}${changes.length > 5 ? '\n…' : ''}`)
    // 改行の形などが違って、このエディターでは書き換えられないノートも知らせる。
    if (unreadable.length) lines.push(`読めないノートが${unreadable.length}件あり、その中のリンクは確かめていません（${unreadable.slice(0, 3).join('、')}${unreadable.length > 3 ? ' など' : ''}）。`)
    if (blocked.length) lines.push(`このほか${blocked.length}件のノートは書き換えられないので、リンクがそのまま残ります（${blocked.slice(0, 3).map((change) => change.path).join('、')}${blocked.length > 3 ? ' など' : ''}）。`)
    const choice = await askChoice(lines.join('\n'), [
      { label: rename ? '名前だけ変える' : '動かすだけ', value: 'move' },
      ...(changes.length ? [{ label: rename ? 'リンクも書き換えて名前を変える' : 'リンクも書き換えて動かす', value: 'relink', primary: true }] : []),
    ])
    if (!choice) return
    relink = choice === 'relink'
  } else if (confirm && !skipPlan && !(await askConfirm(what, '動かす'))) {
    return
  }
  // 確かめている間の入力も、動かす直前にもう一度保存する。動かし終わるまでは入力できないようにする。
  commitOpenField()
  const holdsCurrent = currentPath && inside(currentPath, from)
  // 右の枠で開いているノート（またはそれを含むフォルダー）を動かすときは、右の書きかけも動かす直前に保存する。
  const rightPath = split?.isOpen() && rightState.path && inside(rightState.path, from) ? rightState.path : null
  // 動かしている間は、プロパティ欄（タスクのステータス・日付）も止める。戻すときは欄を作り直す。
  const lock = (locked) =>
    view?.dispatch({ effects: [editableSlot.reconfigure(editableExtensions(locked ? false : editable)), setNoteBusy.of(locked)] })
  if (holdsCurrent) lock(true)
  let moved
  try {
    await saver?.flush()
    // 保存しきれていない変更があるときは、古い場所に取り残さないよう、動かさずに止める。
    if (holdsCurrent && saver && !CLEAN_STATES.has($('status').dataset.state)) {
      showMessage('開いているノートに、まだ保存できていない変更があります。保存できてから、もう一度動かしてください。')
      return
    }
    // 確かめる画面を出している間にも、右の枠では書けるので、ここで保存してもらう。
    // 右の枠も保存しきれなければ、左と同じく、古い場所に取り残さないよう動かさずに止める。
    if (rightPath && (await split.save()).dirty) {
      showMessage('開いているノートに、まだ保存できていない変更があります。保存できてから、もう一度動かしてください。')
      return
    }
    moved = await request('/api/move', { method: 'POST', body: JSON.stringify({ from, to, relink }) })
  } catch {
    moved = { ok: false }
  } finally {
    // うまく動いたときは開き直すので、ここで入力を戻すのはそれ以外のときだけ。
    if (holdsCurrent && !moved?.ok) lock(false)
  }
  if (!moved?.ok) {
    await refreshNotes()
    if (moved) showMessage('動かせませんでした。')
    return
  }
  if (filesOpen.has(from)) {
    filesOpen.delete(from)
    filesOpen.add(to)
    saveFilesOpen()
  }
  await refreshNotes()
  // タスクのノートや、goal・parent のノートを動かすと、タスクの一覧（リンクが外れたか）も変わる。
  tasksSaved()
  if (holdsCurrent) {
    // 古い場所へ保存しに行かないよう、開き直す前に保存の仕組みを閉じる。
    saver?.close()
    saver = null
    openNote(`${to}${currentPath.slice(from.length)}`)
  } else {
    renderFiles()
  }
  // 右の枠は、古い場所へ保存しに行かないよう、新しい場所で開き直してもらう。
  if (rightPath && split.isOpen()) split.post({ type: MSG.OPEN, path: `${to}${rightPath.slice(from.length)}`, reopen: true })
  const missed = [...(moved.data.skipped ?? []), ...(moved.data.failed ?? [])]
  if (missed.length) showMessage(`${rename ? '名前を変えました' : '動かしました'}。ただし、${missed.length}件のノートはリンクを書き換えられませんでした。\n${missed.slice(0, 5).map((path) => `・${path}`).join('\n')}`)
}

async function trashItem(path, kind) {
  const count = kind === 'folder' ? allNotes.filter((note) => note.startsWith(`${path}/`)).length : 0
  const what = kind === 'folder' ? `フォルダー「${path}」を、中のファイルごと（ノートは${count}件）` : `「${path}」`
  if (!(await askConfirm(`${what}をゴミ箱に入れます。Finderのゴミ箱から戻せます。`, 'ゴミ箱に入れる'))) return
  const holdsCurrent = currentPath && inside(currentPath, path)
  if (holdsCurrent) {
    commitOpenField()
    await saver?.flush()
  }
  // 右の枠で開いているノートがなくなるときは、右の書きかけを保存してから右の枠を閉じる。
  if (split?.isOpen() && rightState.path && inside(rightState.path, path)) await closeSplit()
  const done = await request('/api/trash', { method: 'POST', body: JSON.stringify({ path }) })
  if (!done.ok) {
    showMessage('ゴミ箱に入れられませんでした。')
    return
  }
  if (holdsCurrent) {
    // 開いていたノートがなくなったので、何も開いていない画面に戻す。
    saver?.close()
    saver = null
    location.href = '/'
    return
  }
  await refreshNotes()
  // 消したノートがタスク（または goal・parent のノート）なら、タスクの一覧から消す（外れたかも変わる）。
  tasksSaved()
}

function bindFilesPanel() {
  const box = $('files')
  box.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openFilesMenu(event.target.closest('.files-row'), event.clientX, event.clientY)
  })
  // ドラッグで動かす。フォルダーの上に落とすとその中へ、空いている所に落とすと一番上へ。
  let dragging = null
  box.addEventListener('dragstart', (event) => {
    const row = event.target.closest?.('.files-row')
    if (!row) return
    dragging = { path: row.dataset.path, kind: row.dataset.kind }
    event.dataTransfer.effectAllowed = 'move'
    // 本文に落としたときにパスが文字として入らないよう、エディター専用の種類だけで渡す。
    event.dataTransfer.setData('application/x-note-editor-path', row.dataset.path)
  })
  const targetOf = (event) => {
    const row = event.target.closest?.('.files-row')
    if (!row) return ''
    return row.dataset.kind === 'folder' ? row.dataset.path : dirOf(row.dataset.path)
  }
  const allowed = (item, dir) => item && dir !== dirOf(item.path) && !(item.kind === 'folder' && inside(dir, item.path))
  box.addEventListener('dragover', (event) => {
    if (!dragging) return
    const dir = targetOf(event)
    box.querySelectorAll('.files-drop').forEach((row) => row.classList.remove('files-drop'))
    if (!allowed(dragging, dir)) return
    event.preventDefault()
    const row = event.target.closest?.('.files-folder')
    if (row) row.classList.add('files-drop')
  })
  box.addEventListener('dragleave', () => box.querySelectorAll('.files-drop').forEach((row) => row.classList.remove('files-drop')))
  box.addEventListener('drop', (event) => {
    box.querySelectorAll('.files-drop').forEach((row) => row.classList.remove('files-drop'))
    if (!dragging) return
    const dir = targetOf(event)
    const item = dragging
    dragging = null
    if (!allowed(item, dir)) return
    event.preventDefault()
    // フォルダーは中身ごと動くので、落としたときは必ず確かめる。
    doMove(item.path, joinDir(dir, baseOf(item.path)), false, item.kind === 'folder')
  })
  box.addEventListener('dragend', () => {
    dragging = null
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('.files-menu')) closeFilesMenu()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeFilesMenu()
  })
}

// ---- パンくずリスト ----

// 開いているノートの場所を、押せるパンくずにする。フォルダーを押すと、ファイル欄がそこへ動く。
function renderCrumbs(path) {
  const box = $('note-path')
  const parts = path.split('/')
  const nodes = []
  const sep = () => {
    const node = document.createElement('span')
    node.className = 'crumb-sep'
    node.textContent = '›'
    return node
  }
  const folderButton = (label, target) => {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = 'crumb'
    node.textContent = label
    // 右の枠にはファイル欄がないので、押しても何もしない。
    if (PANE !== 'right') {
      node.title = target ? `${target} をファイル欄で開く` : '一番上をファイル欄で開く'
      node.addEventListener('click', () => revealFolder(target))
    }
    return node
  }
  nodes.push(folderButton(vaultLabel || 'Vault', ''))
  parts.slice(0, -1).forEach((part, index) => {
    nodes.push(sep(), folderButton(part, parts.slice(0, index + 1).join('/')))
  })
  const name = document.createElement('span')
  name.className = 'crumb-note'
  name.textContent = parts.at(-1)
  nodes.push(sep(), name)
  box.replaceChildren(...nodes)
  box.title = path
}

function revealFolder(folder) {
  if (folder) {
    for (const item of [...ancestorsOf(`${folder}/x`)]) filesOpen.add(item)
    saveFilesOpen()
  }
  showFiles(true)
  renderFiles()
  const box = $('files')
  const row = folder ? [...box.querySelectorAll('.files-folder')].find((item) => item.dataset.path === folder) : null
  if (row) {
    row.scrollIntoView({ block: 'start' })
    row.classList.add('files-flash')
    setTimeout(() => row.classList.remove('files-flash'), 1500)
  } else {
    box.scrollTop = 0
  }
}

// 開いたノートの場所が見えるように、上のフォルダーを開いてそこまで動かす。
function revealInFiles(path) {
  let changed = false
  for (const folder of ancestorsOf(path)) {
    if (!filesOpen.has(folder)) {
      filesOpen.add(folder)
      changed = true
    }
  }
  if (changed) saveFilesOpen()
  renderFiles()
  for (const row of $('files').querySelectorAll('.files-note')) {
    if (row.dataset.path === path) {
      row.scrollIntoView({ block: 'nearest' })
      break
    }
  }
}

// 今日のノートとカレンダー。日付はこのブラウザの現地時刻で決める。
const pad2 = (n) => String(n).padStart(2, '0')
function todayText() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function nowText() {
  const d = new Date()
  return `${todayText()}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

let calMonth = todayText().slice(0, 7)
let periodicState = null
let periodicStateMonth = null
let calendarRequest = 0

async function openPeriodicNote(period, date, { ask = false, from = 'sidebar', meta = false } = {}) {
  if (periodicState?.disabled) return
  try {
    const name = periodInfo(period, date).name
    const post = (extra) => request('/api/periodic/open', { method: 'POST', body: JSON.stringify({ period, date, now: nowText(), ...extra }) })
    const refuse = (result) => {
      if (result.status === 409 && result.data?.error === 'no-periodic-root') {
        periodicState = { disabled: true }
        $('today-note').hidden = true
        renderCalendar()
        return
      }
      showMessage(result.status === 409 ? (result.data?.message ?? '日付のノートの設定を読めません。') : 'このノートは作れません。')
    }
    if (ask) {
      // 先に、決まった場所にあるかを調べる。ないときだけ聞く。
      const probe = await post({ dryRun: true })
      if (!probe.ok) return refuse(probe)
      if (!probe.data.exists && !(await askConfirm(`${name}のノートはまだありません。作りますか？`, '作る'))) return
    }
    const result = await post()
    if (!result.ok) return refuse(result)
    const { path, created } = result.data
    if (created) await refreshNotes()
    // 今作ったノートだけ、すぐ打てるように本文にフォーカスを入れる。
    await openIn(targetPane({ meta, from, active: activePane() }), path, { focus: created === true })
    drawCalendar()
  } catch {
    showMessage('このノートは作れません。')
  }
}

// 右の枠はカレンダーを描かない（periodicState が null のまま）ので、日付のノートの置き場だけを別に問い合わせて覚える。
// undefined はまだ分からない、null は置き場がない（聞き直さない。60秒ごとの読み直しで、左のカレンダーと同じく追いつく）。
let rightPeriodicRoot
let rightRootLoad = null

async function loadRightPeriodicRoot() {
  try {
    const result = await request(`/api/periodic?month=${todayText().slice(0, 7)}`)
    if (result.ok) rightPeriodicRoot = typeof result.data?.periodicRoot === 'string' ? result.data.periodicRoot : null
  } catch {
    // 問い合わせられないときは、分からないままにして、次のきっかけでもう一度試す。
  }
}

// まだ分からないときだけ聞く。同時に頼まれても1回にまとめる。
function ensureRightPeriodicRoot() {
  if (rightPeriodicRoot !== undefined) return null
  rightRootLoad ??= loadRightPeriodicRoot().finally(() => {
    rightRootLoad = null
  })
  return rightRootLoad
}

// 開いているノートが <periodicRoot>/<年>/Daily/YYYY-MM-DD.md の形なら、その日付。
function openDateOf(path = currentPath) {
  return dailyDateOf(path, periodicState?.periodicRoot ?? (PANE === 'right' ? (rightPeriodicRoot ?? null) : null))
}

// ---- デイリーノートの上のタスクのパネル（読み取りだけ） ----

const taskPanel = createTaskPanel({
  box: $('task-panel'),
  store: storage,
  keyOf: (name) => `${name}:${vaultName}`,
  onOpen: (path, event) => {
    const newTab = event.metaKey || event.ctrlKey
    if (newTab && PANE === 'right') return toLeft({ type: MSG.OPEN, path })
    if (newTab) return openIn(targetPane({ meta: true, from: 'left', active: activePane() }), path)
    return openNote(path)
  },
})
let taskPanelRequest = 0

// 開いているのがデイリーノートなら、タスクの一覧を問い合わせて描く。そうでなければ隠す。
// 呼ぶきっかけ：ノートを開いたとき、60秒ごと、画面に戻ってきたとき。
async function refreshTaskPanel() {
  const mine = ++taskPanelRequest
  const path = currentPath
  let date = openDateOf(path)
  if (!date && PANE === 'right' && path) {
    const loading = ensureRightPeriodicRoot()
    if (loading) {
      await loading
      if (mine !== taskPanelRequest) return
      date = openDateOf(path)
    }
  }
  await taskPanel.refresh({
    date,
    load: async () => {
      const result = await request('/api/tasks')
      if (!result.ok) throw new Error('tasks')
      return result.data
    },
    isCurrent: () => path === currentPath,
  })
}

// タスクのノート（Tasks/ の下）を保存し終えたら、こちらと反対の枠のパネルを読み直す。
function isTaskFolderPath(path) {
  return typeof path === 'string' && path.toLowerCase().startsWith(`${TASK_FOLDER.toLowerCase()}/`)
}

// 反対の枠でタスクが作られた・保存されたとき。ファイル一覧を読み直してから、リンクの解決に使う情報を作り直す
// （新しいタスクへのリンクが、ないノートへのリンクとして描かれたままにならないように）。
async function refreshAfterTasks() {
  await refreshNotes()
  redrawLinks()
  refreshTaskPanel()
  refreshTaskSide()
}

// リンクの解決に使う情報を作り直し、表示も作り直す。previewField は setMode・文書の変更・選択の変更でしか描き直さないので、
// 今の表示の setMode を添える（リンクが「ないノート」の見た目のまま残らないように）。
function redrawLinks() {
  if (view && currentPath) view.dispatch({ effects: [contextSlot.reconfigure(noteContextFor(currentPath, editable)), setMode.of(mode)] })
}

function tasksSaved() {
  refreshTaskPanel()
  refreshTaskSide()
  if (PANE === 'right') toLeft({ type: MSG.TASKS })
  else if (split?.isOpen()) split.post({ type: MSG.TASKS })
}

// ---- 「タスクにする」（段階1-C2） ----

// 開いているノートの日付のノートの置き場。左はカレンダーの問い合わせ、右は B で覚えた置き場を使う。
function periodicRootNow() {
  return periodicState?.periodicRoot ?? (PANE === 'right' ? (rightPeriodicRoot ?? null) : null)
}

// 今の文書の、1から数えた行がタスクにできるか。
function taskAtLine(lineNumber) {
  if (!view || !currentPath) return { ok: false, reason: 'no-source' }
  return taskForDocLine(view.state.doc, lineNumber, { path: currentPath, periodicRoot: periodicRootNow(), known })
}

// 書き換えてよい状態か（編集できるノートで、保存が止まっていない。変換中でない）。
function canConvertNow() {
  return Boolean(view && currentPath && editable && saver && !saver.isStopped() && !view.composing && !view.compositionStarted)
}

// 「タスクにする」が使える行の上だけ、自前のメニューを出す。ほかの場所はブラウザーの標準のメニューのまま。
// チェックボックスや箇条書きの記号などの部品の上でも出すよう、エディターの handlers ではなく本文の DOM で受ける
// （部品の中の出来事は CodeMirror の handlers に届かない）。表のマスは自分のメニューを出すので（defaultPrevented）、ここでは何もしない。
function bindTaskContextMenu() {
  $('editor').addEventListener('contextmenu', (event) => {
    // Shift を押しながらの右クリックは、いつものブラウザーのメニューにする。
    if (event.shiftKey || !view || !view.contentDOM.contains(event.target)) return
    if (event.target.closest?.('.cm-props, .cm-table-wrap, #task-panel')) return
    // タスクのノートへのリンクの上なら「タスクを削除」。そうでなければ「タスクにする」が使える行か見る。
    if (taskLinkContextMenu(event, view)) return
    taskContextMenu(event, view)
  })
  // タスクのノートのプロパティ欄の「このタスクを削除」。
  // 開いているノートのエディターから来たものだけ受ける（ホバーの小窓などは別の部品なので、念のため確かめる）。
  $('editor').addEventListener('note-trash-task', (event) => {
    if (view?.dom.contains(event.target)) deleteThisTask()
  })
}

function taskContextMenu(event, target) {
  if (event.defaultPrevented || target !== view || !canConvertNow()) return false
  if (PANE === 'right' && rightPeriodicRoot === undefined) ensureRightPeriodicRoot()
  const pos = target.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos == null) return false
  const lineNumber = target.state.doc.lineAt(pos).number
  if (!menuForLine(taskAtLine(lineNumber))) return false
  event.preventDefault()
  const selection = target.state.sliceDoc(target.state.selection.main.from, target.state.selection.main.to)
  const items = [{ label: 'タスクにする', run: () => makeTask(lineNumber) }]
  // 自前のメニューを出すと標準のメニューが出ないので、選んだ文字があるときだけ「コピー」も置く。
  if (selection) items.push('-', { label: 'コピー', run: () => copyText(selection, { clipboard: navigator.clipboard, execCopy }) })
  showMenu(event, items)
  addMenuHint()
  return true
}

// 右クリックした場所の、Tasks の下にあるノートへのリンク。{ from, to, linkText, taskPath } か null。
// [[…]] は1つの部品として描くので、部品の要素から位置を取る（posAtCoords は部品の端に来る）。ソースの表示では位置から探す。
function taskLinkAtEvent(event, target) {
  const state = target.state
  let link = null
  const anchor = event.target.closest?.('.cm-link')
  if (anchor && target.contentDOM.contains(anchor)) {
    try {
      const pos = target.posAtDOM(anchor)
      link = linkAt(state, pos, 1) ?? linkAt(state, Math.min(pos + 1, state.doc.length), -1)
    } catch {
      link = null
    }
  }
  if (!link) {
    const pos = target.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos != null) link = linkAt(state, pos, 1) ?? linkAt(state, pos, -1)
  }
  if (!link?.href || isExternal(link.href)) return null
  const resolved = resolveHref(currentPath, link.href)
  if (!resolved?.path || !isUnderTaskFolder(resolved.path) || !known?.has(normalizeKey(resolved.path))) return null
  return { from: link.from, to: link.to, linkText: state.sliceDoc(link.from, link.to), taskPath: resolved.path }
}

// タスクのノートへのリンクの上だけ、自前のメニューに「タスクを削除」を出す。type: task かは選んだあとに一覧で確かめる。
function taskLinkContextMenu(event, target) {
  if (event.defaultPrevented || target !== view || !canConvertNow()) return false
  const info = taskLinkAtEvent(event, target)
  if (!info) return false
  event.preventDefault()
  const selection = target.state.sliceDoc(target.state.selection.main.from, target.state.selection.main.to)
  const items = [{ label: 'タスクを削除', run: () => deleteTaskFromLink(info) }]
  if (selection) items.push('-', { label: 'コピー', run: () => copyText(selection, { clipboard: navigator.clipboard, execCopy }) })
  showMenu(event, items)
  addMenuHint()
  return true
}

// 自前のメニューの下に、いつものメニューの出し方を小さく出す。足した分だけ下や右にはみ出したら、内側へずらす。
function addMenuHint() {
  const menu = [...document.querySelectorAll('.note-menu')].at(-1)
  if (!menu) return
  const hint = document.createElement('p')
  hint.className = 'note-menu-hint'
  hint.textContent = MENU_HINT
  menu.append(hint)
  const rect = menu.getBoundingClientRect()
  if (rect.bottom > innerHeight) menu.style.top = `${Math.max(4, innerHeight - rect.height - 4)}px`
  if (rect.right > innerWidth) menu.style.left = `${Math.max(4, innerWidth - rect.width - 4)}px`
}

// ツールバーのボタンとキー（Cmd+Option+T）。カーソルのある行をタスクにする。
function makeTaskAtCursor() {
  if (!view || !currentPath) return true
  if (!editable) {
    showMessage('このノートは編集できないので、タスクにできません。')
    return true
  }
  const lineNumber = view.state.doc.lineAt(view.state.selection.main.head).number
  const found = taskAtLine(lineNumber)
  if (!found.ok) {
    showMessage(reasonText(found.reason))
    return true
  }
  makeTask(lineNumber)
  return true
}

let taskBusy = false
// 最後に作ったタスクの「取り消す」に使う。{ view, path, taskPath, doc, depth }
let lastTask = null

async function makeTask(lineNumber) {
  if (taskBusy) return
  if (!canConvertNow()) {
    showMessage(editable ? '今は書き換えられないので、タスクにできません。' : 'このノートは編集できないので、タスクにできません。')
    return
  }
  const found = taskAtLine(lineNumber)
  if (!found.ok) {
    showMessage(reasonText(found.reason))
    return
  }
  taskBusy = true
  let taskPath = null
  // リンクを足し終えたか。足したあとの失敗（一覧の読み直しがつながらないなど）を、リンクを足せなかったと知らせないため。
  let linked = false
  const path = currentPath
  const target = view
  try {
    commitOpenField()
    const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify(taskRequestBody(found, todayText())) })
    if (!created.ok || typeof created.data?.path !== 'string') {
      showMessage(createFailedText(created.status, created.data?.error))
      return
    }
    taskPath = created.data.path
    const plan = planAfterCreate({ sameNote: path === currentPath && target === view, canWrite: canConvertNow(), doc: view?.state.doc, found })
    if (plan.action === 'trash') {
      // リンクを足さないときは、作ったノートをゴミ箱へ移す。
      const trashed = await request('/api/trash', { method: 'POST', body: JSON.stringify({ path: taskPath }) })
      showMessage(notLinkedText(plan.reason, { trashed: trashed.ok, taskPath }))
      await refreshNotes()
      tasksSaved()
      return
    }
    // 新しいノートを known に足してから、リンクの解決に使う情報を作り直す。同じ1回の変更にして、リンクがすぐ解決済みとして描かれるようにする。
    known = new Set(known ?? [])
    known.add(normalizeKey(taskPath))
    view.dispatch({
      changes: linkChange(plan.at, taskPath),
      // リンクを足した行を見える所へ出す（右クリックした行が画面の外へずれていることがあるため）。
      // 狭いペインでは下半分にチャットの欄が重なるので、真ん中ではなく上のほうに出す。
      effects: [contextSlot.reconfigure(noteContextFor(currentPath, editable)), EditorView.scrollIntoView(plan.at.from, { y: 'start', yMargin: 60 })],
      annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.task')],
    })
    linked = true
    lastTask = { view, path, taskPath, doc: view.state.doc, depth: undoDepth(view.state) }
    saver?.save()
    showTaskNotice(createdText(created.data.due ?? found.due))
    await refreshNotes()
    tasksSaved()
  } catch {
    // リンクを足したあとの失敗（一覧の読み直しなど）は、次の読み直しで追いつくので知らせない。
    // ノートを作ったあと、リンクを足す前の失敗なら、ノートが残っていることを知らせる。
    if (!linked) showMessage(taskPath ? leftoverText(taskPath) : 'タスクのノートを作れませんでした。')
  } finally {
    taskBusy = false
  }
}

// 「取り消す」：足したリンクを外す。ノートは Tasks に残る。
function undoLastTask() {
  const last = lastTask
  hideTaskNotice()
  if (!last || last.view !== view || last.path !== currentPath) {
    showMessage('ノートを切り替えたので、取り消せません。リンクを手で消してください。')
    return
  }
  if (canUndoDirectly(last, { doc: view.state.doc, depth: undoDepth(view.state) })) {
    historyStep(view, 0)
  } else {
    // あとで打った文字があるときは、それを消さないよう、足したリンクの文字だけを外す。
    const change = linkRemoval(view.state.doc.toString(), last.taskPath)
    if (!change) {
      showMessage('リンクが見つからないので、取り消せません。')
      return
    }
    view.dispatch({ changes: change, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('delete.task')] })
  }
  lastTask = null
  saver?.save()
  tasksSaved()
}

function showTaskNotice(text) {
  const notice = $('task-notice')
  notice.replaceChildren(
    document.createTextNode(text),
    bannerButton('取り消す', undoLastTask),
    bannerButton('閉じる', hideTaskNotice),
  )
  notice.hidden = false
}

function hideTaskNotice() {
  $('task-notice').hidden = true
}

// ---- 「タスクを削除」（段階1-E1） ----

// サーバーのタスクの一覧（GET /api/tasks の tasks）。読めなければ null。
async function loadTaskList() {
  const result = await request('/api/tasks').catch(() => null)
  return result?.ok && Array.isArray(result.data?.tasks) ? result.data.tasks : null
}

// 保存し終えて、書きかけが残っていないか。
function savedClean() {
  return Boolean(saver) && !saver.isStopped() && CLEAN_STATES.has($('status').dataset.state)
}

// タスクのノートを順にゴミ箱へ移す。先頭（消すタスク）を移せなければ、子は移さない。
// 右の枠でそのノートを開いていれば、先に右の書きかけを保存して右の枠を閉じる（trashItem と同じ流れ）。
// open：右の枠から移したとき、左でそのどれかを開いていれば左で開き直すノート（リンク元。なければ null で何も開いていない画面）。
async function trashTaskNotes(paths, { open = null } = {}) {
  if (PANE !== 'right' && split?.isOpen() && rightState.path && paths.some((path) => pathKey(path) === pathKey(rightState.path))) await closeSplit()
  // 右の枠から移すときは、左で同じノートを開いていれば、先に左の書きかけを保存してもらう（ゴミ箱のノートに入れるため）。
  // 保存しきれなかったときは、左の一時保存に残る（打った文字をなくさない）。
  if (PANE === 'right') await askLeftToSave(paths)
  const moved = []
  const failed = []
  for (const [index, path] of paths.entries()) {
    const done = await request('/api/trash', { method: 'POST', body: JSON.stringify({ path }) }).catch(() => ({ ok: false }))
    if (done.ok) moved.push(path)
    else if (index === 0) {
      failed.push(...paths)
      break
    } else failed.push(path)
  }
  // 「取り消す」の相手がゴミ箱へ行ったら、もう取り消せないので知らせを閉じる。
  if (lastTask && moved.some((path) => pathKey(path) === pathKey(lastTask.taskPath))) {
    lastTask = null
    hideTaskNotice()
  }
  if (PANE === 'right' && moved.length) toLeft({ type: MSG.TRASHED, paths: moved, open })
  return { moved, failed }
}

// 右の枠でゴミ箱へ移したノートを左で開いていたら、保存を止めて（消えたノートを書き戻さないように）開き直す。
// 開き直すノートがないときは、何も開いていない画面に戻す。右の枠が知らせを見せている間は、枠が閉じるまで待つ
// （すぐ読み込み直すと、右の枠の知らせごと消えるため）。
let reloadAfterSplit = false
async function trashedElsewhere({ paths, open }) {
  if (PANE === 'right' || !Array.isArray(paths)) return
  // 左のファイル一覧・サイドバー・パネル・リンクの見た目は、開いているノートに関係なく読み直す。
  refreshAfterTasks().catch(() => {})
  if (!currentPath || !paths.some((path) => typeof path === 'string' && pathKey(path) === pathKey(currentPath))) return
  saver?.close()
  saver = null
  if (typeof open === 'string' && open && pathKey(open) !== pathKey(currentPath)) await openNote(open)
  else if (split?.isOpen()) {
    reloadAfterSplit = true
    // 枠が閉じるまでの間に打った文字は、保存も一時保存もされないので、打てないようにしておく。
    // 別のノートを開けば（openNote）、読み込み直しはやめる。
    editable = false
    view?.dispatch({ effects: [editableSlot.reconfigure(editableExtensions(false)), setNoteBusy.of(true)] })
    const banner = $('banner')
    banner.hidden = false
    banner.textContent = 'このノートは右の枠でゴミ箱へ移しました。右の枠を閉じると、何も開いていない画面に戻ります。'
  } else location.href = '/'
}

// 右の枠から：左で paths のどれかを開いていれば、左に書きかけを保存してもらう。返事は { dirty }（5秒たっても返事がなければ dirty）。
// 頼みごとに id を付け、返事は同じ id の待ちだけを解く（切れたあとに遅れて来た返事で、次の待ちを解かないように）。
const leftSaveWaiters = createReplyWaiters()
function askLeftToSave(paths) {
  const { id, promise } = leftSaveWaiters.wait(5_000, { dirty: true })
  toLeft({ type: MSG.SAVE_LEFT, id, paths })
  return promise
}

// 左の枠で：右の枠から頼まれたら、開いているノートが paths のどれかのときだけ保存して返事をする。
async function saveForRight({ id, paths }) {
  let dirty = false
  try {
    if (currentPath && Array.isArray(paths) && paths.some((path) => typeof path === 'string' && pathKey(path) === pathKey(currentPath))) {
      commitOpenField()
      await saver?.flush()
      dirty = Boolean(saver) && !CLEAN_STATES.has($('status').dataset.state)
    }
  } finally {
    split?.post({ type: MSG.LEFT_SAVED, id, dirty })
  }
}

// 移したあと：知らせ、両方の枠のファイル一覧・パネル・リンクの見た目を読み直す。読み直しの失敗は、次の読み直しで追いつくので知らせない。
async function afterTaskTrash({ title, rootPath, result, undo, unlinked, sourceName = '' }) {
  const rootMoved = result.moved.some((path) => pathKey(path) === pathKey(rootPath))
  if (rootMoved) showDeleteNotice(deletedText({ title, movedChildren: result.moved.length - 1, undo, unlinked, sourceName, keyLabel }))
  if (result.failed.length) showMessage(trashFailedNotice({ failed: result.failed, rootMoved, unlinked, undo, sourceName, keyLabel }))
  try {
    await refreshNotes()
    redrawLinks()
    tasksSaved()
  } catch {
    // 何もしない
  }
}

function showDeleteNotice(text) {
  const notice = $('task-notice')
  notice.replaceChildren(document.createTextNode(text), bannerButton('閉じる', hideTaskNotice))
  notice.hidden = false
}

// 月のノートなどの行のリンク（→タスク）から削除する。リンクを外す変更（履歴に積む）→ すぐ保存 → ゴミ箱へ。
async function deleteTaskFromLink(info) {
  if (taskBusy) return
  if (!canConvertNow()) {
    showMessage('今は書き換えられないので、タスクを削除できません。')
    return
  }
  taskBusy = true
  const path = currentPath
  const target = view
  try {
    const list = await loadTaskList()
    if (!list) {
      showMessage('タスクの一覧を読めなかったので、削除できません。')
      return
    }
    const task = findTask(list, info.taskPath)
    if (!task) {
      showMessage('リンク先はタスクのノート（Tasks の下の type: task のノート）ではないので、削除できません。')
      return
    }
    const children = collectDescendants(list, task.path)
    const title = taskTitleOf(task)
    // 開いているノートがリンク元（parent があれば親、なければ goal）でなければ、参照として書いたリンクから消している。
    // そのときは、リンク元の中のリンクも「このタスクを削除」と同じ手順で外す（外せないときは理由を確認の文に書く）。
    const own = sourceNoteOf(task, known)
    const extra = own && pathKey(own.path) !== pathKey(currentPath) ? await sourceUnlinkPlan(task) : null
    const also = extra && extra.unlink !== 'none-source' ? extra : null
    const choice = await askChoice(deleteQuestion({ title, childCount: children.length, unlink: 'line', also }), deleteChoices(children.length))
    if (!choice) return
    if (path !== currentPath || target !== view || !canConvertNow()) {
      showMessage('確かめている間にノートが変わったので、削除をやめました。')
      return
    }
    if (!relocateLink(view.state.doc.toString(), info, { notePath: currentPath, taskPath: task.path, known })) {
      showMessage('外すリンクが見つからない（または同じリンクが2つ以上ある）ので、削除をやめました。')
      return
    }
    // 先にリンク元のリンクを外す（外せなければ、何も変えずにやめる）。
    let sourceUnlinked = ''
    if (also?.unlink === 'source') {
      if (!(await unlinkInSource(also.source, task, also.sourceName))) return
      sourceUnlinked = also.sourceName
      if (path !== currentPath || target !== view || !canConvertNow()) {
        showMessage('「' + sourceUnlinked + '」の中のリンクは外しましたが、その間にノートが変わったので、行のリンクは外さず、ゴミ箱へも移していません。')
        return
      }
    }
    const at = relocateLink(view.state.doc.toString(), info, { notePath: currentPath, taskPath: task.path, known })
    if (!at) {
      showMessage(sourceUnlinked
        ? '「' + sourceUnlinked + '」の中のリンクは外しましたが、行のリンクが見つからなくなったので、ゴミ箱へは移していません。'
        : '外すリンクが見つからない（または同じリンクが2つ以上ある）ので、削除をやめました。')
      return
    }
    const range = unlinkRange(at.lineText, at.lineFrom, at.from, at.to)
    commitOpenField()
    view.dispatch({ changes: { ...range, insert: '' }, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('delete.task')] })
    await saver?.flush()
    if (!savedClean()) {
      showMessage('リンクは外しましたが、保存できなかったので、タスクのノートはゴミ箱へ移していません。' + sourceLinkNote(sourceUnlinked))
      return
    }
    const paths = [task.path, ...(choice === 'all' ? children.map((child) => child.path) : [])]
    const result = await trashTaskNotes(paths, { open: path })
    await afterTaskTrash({ title, rootPath: task.path, result, undo: true, unlinked: true, sourceName: sourceUnlinked })
  } catch {
    showMessage('タスクを削除する途中で失敗しました。ファイル一覧で、残っているものを確かめてください。')
  } finally {
    taskBusy = false
  }
}

// リンク元のノート（parent があれば親、なければ goal）の中のリンクを外せるか調べる。
// unlink：'source'（ちょうど1つあるので外せる）・'none-count'（0 か 2つ以上）・'none-editable'（編集できない）・'none-missing'（見つからない）・'none-source'（goal も parent もない）。
async function sourceUnlinkPlan(task) {
  const source = sourceNoteOf(task, known)
  const sourceName = source ? source.path.split('/').at(-1).replace(/\.md$/i, '') : ''
  let unlink = source ? 'none-missing' : 'none-source'
  let linkCount = 0
  if (source?.exists) {
    const note = await api.read(source.path).catch(() => null)
    if (note && !note.editable) unlink = 'none-editable'
    else if (note) {
      const plan = planUnlinkInNote(note.text, source.path, task.path, known)
      linkCount = plan.count
      unlink = plan.change ? 'source' : 'none-count'
    }
  }
  return { source, sourceName, unlink, linkCount }
}

// リンク元のノートの中のリンクを、今の保存の経路（PUT /api/note のハッシュ照合）で外す。外せなければ知らせて false。
// 確かめている間に変わっていてもよいよう、読み直してから外す。ハッシュが合わなければ（書き換えられた）外さない。
async function unlinkInSource(source, task, sourceName) {
  const fresh = await api.read(source.path).catch(() => null)
  const plan = fresh?.editable ? planUnlinkInNote(fresh.text, source.path, task.path, known) : null
  if (!plan?.change) {
    showMessage('「' + sourceName + '」の中のリンクが見つからなくなったので、削除をやめました。')
    return false
  }
  const next = fresh.text.slice(0, plan.change.from) + fresh.text.slice(plan.change.to)
  const saved = await api.write(source.path, next, fresh.hash).catch(() => null)
  if (!saved || saved.conflict) {
    showMessage('「' + sourceName + '」がちょうど書き換えられたか、保存できなかったので、リンクを外せませんでした。削除をやめました。もう一度選んでください。')
    return false
  }
  return true
}

// 開いているタスクのノートを削除する（プロパティ欄の「このタスクを削除」）。
// リンクを外す相手は parent があれば親のノート、なければ goal のノート。その中でこのタスクを指すリンクがちょうど1つなら外す。
// 開いていないノートなので、今の保存の経路（PUT /api/note のハッシュ照合）で書き換える。
async function deleteThisTask() {
  if (taskBusy) return
  if (!view || !currentPath || !editable || !saver || saver.isStopped()) {
    showMessage('今はこのノートを削除できません。')
    return
  }
  taskBusy = true
  const taskPath = currentPath
  try {
    commitOpenField()
    await saver.flush()
    const list = await loadTaskList()
    const task = list ? findTask(list, taskPath) : null
    if (!task) {
      showMessage(list ? 'このノートはタスクの一覧にない（Tasks の下の type: task のノートではない）ので、削除できません。' : 'タスクの一覧を読めなかったので、削除できません。')
      return
    }
    const children = collectDescendants(list, task.path)
    const title = taskTitleOf(task)
    const { source, sourceName, unlink, linkCount } = await sourceUnlinkPlan(task)
    const choice = await askChoice(deleteQuestion({ title, childCount: children.length, unlink, sourceName, linkCount }), deleteChoices(children.length))
    if (!choice) return
    if (taskPath !== currentPath) {
      showMessage('確かめている間に別のノートを開いたので、削除をやめました。')
      return
    }
    let unlinked = false
    if (unlink === 'source') {
      if (!(await unlinkInSource(source, task, sourceName))) return
      unlinked = true
    }
    commitOpenField()
    await saver?.flush()
    const paths = [task.path, ...(choice === 'all' ? children.map((child) => child.path) : [])]
    const result = await trashTaskNotes(paths, { open: source?.exists ? source.path : null })
    if (result.moved.some((path) => pathKey(path) === pathKey(task.path))) {
      // 開いていたノートがなくなったので、リンク元のノートを開く（openNote が今の保存の仕組みを閉じる）。
      // リンク元がなければ、左は知らせを見せてから何も開いていない画面に戻す。右の枠ではそのまま残し、
      // 今の「ファイルが消えた」ときの扱い（保存を止める）に任せる。
      if (source?.exists) await openNote(source.path)
      else {
        // 移せなかったサブタスクがあれば、同じ知らせに書き添える（このあと画面を移るので、afterTaskTrash は通らない）。
        const failed = result.failed.length ? '\n' + trashFailedNotice({ failed: result.failed, rootMoved: true, keyLabel }) : ''
        await showMessage(deletedText({ title, movedChildren: result.moved.length - 1, undo: false, unlinked, keyLabel }) + failed)
        saver?.close()
        saver = null
        // 右の枠は、開いていたノートがなくなったので枠を閉じてもらう。左は何も開いていない画面に戻す。
        if (PANE === 'right') toLeft({ type: MSG.CLOSE })
        else location.href = '/'
        return
      }
    }
    await afterTaskTrash({ title, rootPath: task.path, result, undo: false, unlinked })
  } catch {
    showMessage('タスクを削除する途中で失敗しました。ファイル一覧で、残っているものを確かめてください。')
  } finally {
    taskBusy = false
  }
}

// ---- サイドバーの「タスク」（段階1-E2）。左の枠だけで使う ----

const taskSide = createTaskSide({
  box: $('tasks-side'),
  store: storage,
  keyOf: (name) => `${name}:${vaultName}`,
  today: todayText,
  onOpen: (path, event) => {
    openIn(targetPane({ meta: event.metaKey || event.ctrlKey, from: 'sidebar', active: activePane() }), path)
    // 狭い幅では右の列が本文に重なるので閉じる（次回の表示の設定は変えない）。
    closeSideIfNarrow()
  },
  onTrash: (path) => trashUnlinkedTask(path),
  onCreate: () => createTaskFromSide(),
})

// 読み直し。きっかけ：起動、60秒ごと、画面に戻ったとき、タスクを作った・消した・Tasks の下を保存したとき、
// 反対の枠からの知らせ、ほかのノートを保存したとき（リンクを手で消すと「外れた」に変わるため。少し待ってまとめる）。
function refreshTaskSide() {
  if (PANE === 'right' || $('tasks-side').hidden) return
  taskSide.refresh(async () => {
    const result = await request('/api/tasks')
    if (!result.ok) throw new Error('tasks')
    return result.data
  })
}

let noteSavedTimer = null
function noteSaved() {
  if (PANE === 'right') {
    toLeft({ type: MSG.NOTE_SAVED })
    return
  }
  clearTimeout(noteSavedTimer)
  noteSavedTimer = setTimeout(refreshTaskSide, 500)
}

// 「新しいタスク」：題名と期日を聞いて、goal も parent もないタスクのノートを作り、開く。
async function createTaskFromSide() {
  const input = await askNewTask(checkNewTask)
  if (!input) return
  const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: input.title, due: input.due, created: todayText() }) }).catch(() => ({ ok: false }))
  if (!created.ok || typeof created.data?.path !== 'string') {
    showMessage(createFailedText(created.status, created.data?.error))
    return
  }
  await refreshNotes()
  tasksSaved()
  await openIn(targetPane({ meta: false, from: 'sidebar', active: activePane() }), created.data.path, { focus: true })
  closeSideIfNarrow()
}

// 開いているノート（左と、右の枠）の書きかけを保存してみる。返り値：保存しきれなかったノート [{ pane, path }]。
// 止めるかどうかは、そのノートが判定に関わるかで決める（unsavedBlockText）。
async function saveOpenNotes() {
  const stuck = []
  commitOpenField()
  await saver?.flush()
  if (saver && currentPath && !CLEAN_STATES.has($('status').dataset.state)) stuck.push({ pane: 'left', path: currentPath })
  if (split?.isOpen() && rightState.path && (await split.save()).dirty) stuck.push({ pane: 'right', path: rightState.path })
  return stuck
}

// 「リンクが外れたタスク」の「ゴミ箱へ」。外れたリンクはないので、リンクは外さずにノートをゴミ箱へ移す。
// 子がいれば一緒に移すか聞く。開いていて書き換えられるノートなら「このタスクを削除」と同じ流れにする。
async function trashUnlinkedTask(path) {
  if (taskBusy) return
  taskBusy = true
  let handOff = false
  try {
    // 判定はサーバーのファイルで決まるので、開いているノート（左と右）の書きかけを先に保存する。
    // 判定に関わるノート（このタスクと移すサブタスク、その goal・parent のノート）を保存しきれなければやめる。
    const stuck = await saveOpenNotes()
    const list = await loadTaskList()
    const checked = unlinkedTrashCheck(list, path)
    if (!checked.ok) {
      showMessage(checked.message)
      refreshTaskSide()
      return
    }
    const { task } = checked
    const children = collectDescendants(list, task.path)
    // 左で開いているノートで、書き換えられるなら「このタスクを削除」と同じ流れにする。編集できない（BOM つきなど）ときは、
    // 開いていないノートと同じ流れで移す（移したあとは何も開いていない画面に戻す）。
    const handing = Boolean(currentPath) && pathKey(currentPath) === pathKey(path) && editable && saver && !saver.isStopped()
    // サブタスクは、ふだんは移すと決めてから（確認のあとで）確かめる。「このタスクを削除」へ渡すときは、そちらでは確かめないのでここで。
    const blocked = unsavedBlockText(stuck, { paths: [task.path, ...(handing ? children.map((child) => child.path) : [])], task, known, split: Boolean(split?.isOpen()) })
    if (blocked) {
      showMessage(blocked)
      return
    }
    if (handing) {
      handOff = true
      return
    }
    const title = taskTitleOf(task)
    const source = sourceNoteOf(task, known)
    const sourceName = source ? source.path.split('/').at(-1).replace(/\.md$/i, '') : ''
    const unlink = source?.exists ? 'none-count' : 'none-missing'
    const choice = await askChoice(deleteQuestion({ title, childCount: children.length, unlink, sourceName, linkCount: 0 }), deleteChoices(children.length))
    if (!choice) return
    // 確かめている間に書いた分も保存してから、まだ外れているかを確かめ直す（リンクを戻したのに移さないように）。
    const stuckAgain = await saveOpenNotes()
    const fresh = await loadTaskList()
    const again = unlinkedTrashCheck(fresh, path)
    if (!again.ok) {
      showMessage(again.message)
      refreshTaskSide()
      return
    }
    // 移すサブタスクは、確認の文で数えたもののうち、今もこのタスクの下にあるものだけ（確認の間に増えたものは移さない）。
    const moving = choice === 'all' ? confirmedChildren(children, collectDescendants(fresh, again.task.path)) : []
    const paths = [again.task.path, ...moving.map((child) => child.path)]
    const blockedAgain = unsavedBlockText(stuckAgain, { paths, task: again.task, known, split: Boolean(split?.isOpen()) })
    if (blockedAgain) {
      showMessage(blockedAgain)
      return
    }
    // 左で開いているノートを一緒に移すときは、移したあとは何も開いていない画面に戻す（保存は上で済ませた）。
    const openGoes = Boolean(currentPath) && paths.some((item) => pathKey(item) === pathKey(currentPath))
    const result = await trashTaskNotes(paths)
    if (openGoes && result.moved.some((item) => pathKey(item) === pathKey(currentPath))) {
      // 移せなかったサブタスクがあれば、同じ知らせに書き添える（このあと画面を移るので、afterTaskTrash は通らない）。
      const failed = result.failed.length ? '\n' + trashFailedNotice({ failed: result.failed, rootMoved: true, keyLabel }) : ''
      await showMessage(deletedText({ title, movedChildren: result.moved.length - 1, undo: false, unlinked: false }) + failed)
      saver?.close()
      saver = null
      location.href = '/'
      return
    }
    await afterTaskTrash({ title, rootPath: task.path, result, undo: false, unlinked: false })
  } catch {
    showMessage('タスクをゴミ箱へ移す途中で失敗しました。ファイル一覧で、残っているものを確かめてください。')
  } finally {
    taskBusy = false
    // 「このタスクを削除」は taskBusy が立っていると何もしないので、下ろしてからすぐ渡す（間に await を挟まない）。
    if (handOff) deleteThisTask()
  }
}

async function drawCalendar() {
  const mine = ++calendarRequest
  const month = calMonth
  let result
  try {
    result = await request(`/api/periodic?month=${month}`)
  } catch {
    return
  }
  if (mine !== calendarRequest) return
  periodicState = result.ok ? result.data : null
  periodicStateMonth = month
  // 今日のノートの置き場が決まっていないVaultでは、ボタンも出さない（カレンダーの場所に案内を出す）。
  $('today-note').hidden = todayButtonHidden(periodicState)
  renderCalendar()
}

function renderCalendar() {
  const box = $('calendar')
  if (box.hidden) return
  if (periodicState?.disabled) {
    const notice = document.createElement('p')
    notice.id = 'calendar-notice'
    notice.textContent = '今日のノートの置き場は、チャットでClaudeに頼むと決められます'
    box.replaceChildren(notice)
    return
  }
  // 今開いている日の印は、操作中の枠のノートに付ける。
  const model = calendarModel(calMonth, todayText(), openDateOf(rightActive() ? rightState.path : currentPath), periodicStateMonth === calMonth ? (periodicState ?? {}) : {})
  const part = (tag, className, text, extra = {}) => {
    const el = document.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    if (tag === 'button') el.type = 'button'
    Object.assign(el, extra)
    return el
  }
  const act = (el, handler) => {
    el.addEventListener('click', handler)
    return el
  }
  const open = (period, date) => async (event) => {
    await openPeriodicNote(period, date, { ask: !(period === 'daily' && date === todayText()), from: 'sidebar', meta: event.metaKey || event.ctrlKey })
    closeSideIfNarrow()
  }
  const go = (month) => () => {
    calMonth = month
    drawCalendar()
  }
  const mark = (el, has) => {
    if (has) el.classList.add('cal-has')
    return el
  }
  const head = part('div', 'cal-head')
  // 左に「2026年11月」、右に前後の月への矢印と「今日」を並べる（Obsidianのカレンダーと同じ並び）。
  head.append(
    act(mark(part('button', 'cal-title', model.title, { title: `${model.title}のノートを開く` }), model.hasMonth), open('monthly', model.monthDate)),
    act(part('button', '', '‹', { title: '前の月' }), go(shiftMonth(calMonth, -1))),
    act(part('button', '', '今日', { title: '今月に戻る' }), go(todayText().slice(0, 7))),
    act(part('button', '', '›', { title: '次の月' }), go(shiftMonth(calMonth, 1))),
  )
  const grid = part('div', 'cal-grid')
  grid.append(part('span', 'cal-dow', 'W'))
  for (const dow of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) grid.append(part('span', 'cal-dow', dow))
  for (const week of model.weeks) {
    grid.append(act(mark(part('button', 'cal-week', week.label, { title: `${week.name}のノートを開く` }), week.hasNote), open('weekly', week.date)))
    for (const day of week.days) {
      const button = part('button', '', String(day.day))
      if (!day.inMonth) button.classList.add('cal-out')
      if (day.isToday) button.classList.add('cal-today')
      if (day.isOpen) button.classList.add('cal-open')
      mark(button, day.hasNote)
      if (day.isOpen) button.setAttribute('aria-current', 'date')
      button.title = day.date
      grid.append(act(button, open('daily', day.date)))
    }
  }
  box.replaceChildren(head, grid)
}

function showCalendar(show, { remember = true } = {}) {
  $('calendar').hidden = !show
  if (remember) storage.set('calendar-shown', show)
  if (show) {
    closeOutline()
    $('calendar').hidden = false
    drawCalendar()
  }
}

function showTasksSide(show, { remember = true } = {}) {
  $('tasks-side').hidden = !show
  if (remember) storage.set('tasks-shown', show)
  if (show) {
    closeOutline()
    $('tasks-side').hidden = false
    refreshTaskSide()
  }
}

function showFiles(show) {
  $('files').hidden = !show
  storage.set('files-shown', show)
  if (show) {
    closeOutline()
    $('files').hidden = false
    drawFiles()
    if (!$('calendar').hidden) drawCalendar()
  }
}

function drawFiles() {
  if (currentPath) revealInFiles(currentPath)
  else renderFiles()
}

function openSwitcher() {
  const dialog = $('switcher')
  const input = $('switcher-input')
  input.value = ''
  renderSwitcher('')
  if (!dialog.open) dialog.showModal()
  input.focus()
  refreshNotes().then(() => renderSwitcher(input.value))
}

function renderSwitcher(query) {
  const list = $('switcher-list')
  const pasted = resolvePasted(query, rootPaths, allNotes, platform)
  const needle = pasted ? pasted.toLowerCase().normalize('NFC') : query.trim().toLowerCase().normalize('NFC')
  const source = needle ? notes.filter((note) => note.toLowerCase().normalize('NFC').includes(needle)) : storage.get(`recent:${vaultName}`, []).filter((note) => notes.includes(note)).concat(notes.slice(0, 30))
  // 名前に入っているものを先に並べてから、上限で切る。
  const nameHit = (note) => (note.split('/').at(-1).toLowerCase().includes(needle) ? 0 : 1)
  const ordered = needle ? [...source].sort((a, b) => nameHit(a) - nameHit(b)) : source
  const seen = new Set()
  const shown = []
  for (const note of ordered) {
    if (seen.has(note)) continue
    seen.add(note)
    shown.push(note)
    if (shown.length >= 50) break
  }
  const fresh = query.trim()
  // 新しいノートは、いま開いているノートと同じフォルダーに作る。パスのように見える文字からは作らない。
  const newPath = pasted ? null : newNotePath(query, defaultNoteDir(currentPath, noteFolders(notes)), allNotes)
  const rows = pasted ? [pasted] : [...shown]
  // パスを貼っても開けないときは、黙って空にせず理由を出す。
  if (!pasted && fresh.includes('/') && rows.length === 0) {
    const item = document.createElement('li')
    item.className = 'switcher-missing'
    item.textContent = `このパスのノートは「${vaultLabel}」の中に見つかりません。`
    list.replaceChildren(item)
    return
  }
  const createRow = Boolean(newPath)
  if (createRow) rows.push(newPath)
  list.replaceChildren(
    ...rows.map((note, index) => {
      const item = document.createElement('li')
      if (createRow && index === rows.length - 1) {
        const label = document.createElement('span')
        label.className = 'switcher-name'
        label.textContent = `「${fresh}」を新しく作る`
        const place = document.createElement('span')
        place.className = 'switcher-folder'
        place.textContent = newPath
        item.append(label, place)
        item.dataset.path = newPath
        item.dataset.create = 'true'
        item.setAttribute('aria-selected', String(index === 0))
        item.addEventListener('click', () => createFromSwitcher(newPath))
        return item
      }
      const parts = note.split('/')
      const name = document.createElement('span')
      name.className = 'switcher-name'
      name.textContent = parts.at(-1).replace(/\.md$/i, '')
      const folder = document.createElement('span')
      folder.className = 'switcher-folder'
      folder.textContent = parts.slice(0, -1).join('/')
      item.append(name, folder)
      item.dataset.path = note
      item.setAttribute('aria-selected', String(index === 0))
      item.addEventListener('click', () => chooseSwitcher(note))
      return item
    }),
  )
}

function chooseSwitcher(path) {
  if (!path) return
  $('switcher').close()
  if (path) openIn(targetPane({ meta: false, from: 'sidebar', active: activePane() }), path)
}

const KIND_LABEL = { previous: '保存の直前', snapshot: '定期', conflict: 'ぶつかったとき・上書きされたとき', daily: 'その日最初の保存の前' }
let historyChoice = null

async function openHistory() {
  if (!currentPath) return
  const result = await request(`/api/backups?path=${encodeURIComponent(currentPath)}`)
  const list = $('history-list')
  historyChoice = null
  $('history-text').textContent = ''
  $('history-restore').disabled = true
  const items = result.data?.backups ?? []
  if (items.length === 0) {
    const empty = document.createElement('li')
    empty.textContent = 'このノートのバックアップはまだありません'
    list.replaceChildren(empty)
  } else {
    list.replaceChildren(
      ...items.map((backup) => {
        const item = document.createElement('li')
        item.tabIndex = 0
        const time = new Date(backup.time).toLocaleString('ja-JP')
        item.textContent = `${time}（${KIND_LABEL[backup.kind] ?? backup.kind}）`
        item.addEventListener('click', () => {
          for (const other of list.children) other.removeAttribute('aria-selected')
          item.setAttribute('aria-selected', 'true')
          historyChoice = null
          $('history-text').textContent = ''
          $('history-restore').disabled = true
          const chosen = `/api/backup?path=${encodeURIComponent(currentPath)}&id=${encodeURIComponent(backup.id)}`
          request(chosen).then(({ ok, data }) => {
            if (!ok || item.getAttribute('aria-selected') !== 'true') return
            historyChoice = data.text
            $('history-text').textContent = data.text
            $('history-restore').disabled = !editable
          }).catch(() => {})
        })
        return item
      }),
    )
  }
  $('history').showModal()
}

// 「新しいノート」のボタン。最初は今のノートと同じフォルダーを選んでおく。
async function newNoteFromButton(start = null) {
  const list = placeFolders()
  const path = await askNewNote({
    folders: list,
    selected: typeof start === 'string' ? start : defaultNoteDir(currentPath, list),
    topLabel: vaultLabel || 'フォルダー',
    recent: storage.get(recentPlacesKey(), []),
    childFolders,
    searchFolders,
    check: (name, dir) => checkNewNote(name, dir, allNotes),
  })
  if (path) createFromSwitcher(path)
}

async function createFromSwitcher(path) {
  $('switcher').close()
  const created = await request(noteUrl(path), { method: 'POST', body: JSON.stringify({ text: '' }) })
  if (!created.ok && created.status !== 409) {
    showMessage('ノートを作れませんでした。')
    return
  }
  storage.set(recentPlacesKey(), rememberPlace(storage.get(recentPlacesKey(), []), dirOf(path)))
  await refreshNotes()
  // 409 は、同じ名前のノートが既にあったとき。そのときは既にあるノートとして開く（フォーカスを入れない）。
  openIn(targetPane({ meta: false, from: 'sidebar', active: activePane() }), path, { focus: created.ok })
}

function moveSwitcher(delta) {
  const items = [...$('switcher-list').children]
  if (!items.length) return
  const index = items.findIndex((item) => item.getAttribute('aria-selected') === 'true')
  const next = Math.max(0, Math.min(items.length - 1, index + delta))
  items[index]?.setAttribute('aria-selected', 'false')
  items[next].setAttribute('aria-selected', 'true')
  items[next].scrollIntoView({ block: 'nearest' })
}

// Cmd+V でノートを開くか。決まりは modes.mjs の pasteOpensNote。target は貼り付けた先（フォーカスのある場所）。
function pasteOpensNoteAt(target) {
  return pasteOpensNote({ hasNote: Boolean(currentPath), editable, ...pastePlace(target) })
}

// 本文をクリックしても見た目が変わらないと分からないので、貼り付けを待っていることを見せる。
function showPasteHint(show) {
  $('paste-hint').hidden = !show
  document.body.classList.toggle('paste-ready', show)
}

// フォーカスが本文や入力欄の外にあるとき（と、ノートを開いていないとき、編集できないノート）は文字を貼る場所がないので、
// Cmd+Vをコピーしたパスのノートを開く操作に使う。本文や入力欄の中では、ふつうの貼り付け。
function openFromPaste(event) {
  if (document.querySelector('dialog[open]')) return
  if (!pasteOpensNoteAt(event.target)) return
  const text = event.clipboardData?.getData('text/plain') ?? ''
  const pasted = resolvePasted(text, rootPaths, allNotes, platform)
  if (pasted) {
    event.preventDefault()
    openIn(targetPane({ meta: false, from: 'sidebar', active: activePane() }), pasted)
  } else if (/\.md\b/i.test(text) && text.includes('/')) {
    setStatusHint('コピーしたパスのノートが見つかりません')
  }
}

// 「本文へ移る」（Cmd+E、WindowsはCtrl+E）。開いているノートが編集できるときに、本文にフォーカスを入れる。
// 既にあるノートは開いても本文にフォーカスを入れないので、キーボードだけで使う人が Tab を何十回も押さずに書き始められるようにする。
// 開いてからまだ本文に入っていなければ、カーソルは開いたときの位置（typingStart。見出しの # などの記号のあと）のまま。
// フォーカスが入ると印が外れて記号が見える（quietEnders の focusin）。前に本文でカーソルを置いていれば、そこに戻る。本文にいるときは何もしない。
function enterBody() {
  if (!currentPath || !view || !editable) return
  if (view.contentDOM.contains(document.activeElement)) return
  view.focus()
  view.dispatch({ effects: [setCursorQuiet.of(false), EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' })] })
}

function bindChrome() {
  bindToolbar()
  bindTaskContextMenu()
  // 右の枠では、上のボタン列、ファイルの一覧、「探す」を使わない。貼り付けでノートを開く処理は、どちらの枠でも使う（その枠で開く）。
  bindPasteOpen()
  if (PANE !== 'right') bindLeftChrome()
  else bindRightChrome()
  $('history-close').addEventListener('click', () => $('history').close())
  $('history-restore').addEventListener('click', async () => {
    if (historyChoice === null || !saver) return
    await saver.restore(historyChoice)
    $('history').close()
  })
  for (const button of $('modes').querySelectorAll('button')) {
    // 本文をクリックしたあとにマウスで押したときは、切り替えたあと本文にフォーカスを戻す。ボタンに残ると、そのあとの Cmd+V が、貼り付けでなくノートを開く操作になる。
    // キーボード（Enter・Space）で押したときと、開いてからまだ本文をクリックしていないときは、戻さない（modes.mjs の refocusesBody）。
    button.addEventListener('click', (event) => {
      applyMode(button.dataset.mode)
      if (currentPath && view && refocusesBody(event, { quiet: cursorQuiet(view.state) })) view.focus()
    })
  }
  // 書式の付いたリンクは、マウスを押した時点で開く。離す前にカーソルが入ると表示が変わるため。
  $('editor').addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0 || event.altKey || mode === 'source') return
      const link = event.target.closest?.('[data-href]')
      if (!link) return
      event.preventDefault()
      event.stopPropagation()
      openHref(link.dataset.href, event.metaKey || event.ctrlKey)
    },
    true,
  )
  $('editor').addEventListener('note-toggle-props', () => view.dispatch({ effects: togglePropsPanel.of(null) }))
  // 表のマスなどの編集が終わったら、待たせていた外からの変更を反映する。
  $('editor').addEventListener('focusout', () => setTimeout(() => saver?.compositionEnded(), 0))
  window.addEventListener('keydown', (event) => {
    hoverWithMeta = event.metaKey || event.ctrlKey
    // 本文へ移る。ダイアログ（「探す」など）を出している間は使わない。
    // 本文にいるときも、ブラウザの同じキーの働き（WindowsのCtrl+Eはアドレス欄へ移る）が動かないように止める。
    if (isBodyKey(event) && !document.querySelector('dialog[open]')) {
      event.preventDefault()
      // 左右に分けていて右の枠が操作中なら、右の枠の本文へ移ってもらう（一覧から右の枠に開いたノートなど）。
      if (PANE !== 'right' && rightActive() && split?.isOpen()) split.post({ type: MSG.FOCUS })
      else enterBody()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault()
      // 右の枠では、左に「探す」を画面いっぱいに出してもらう。
      if (PANE === 'right') {
        toLeft({ type: MSG.CLICKED })
        toLeft({ type: MSG.SEARCH })
      } else {
        openSwitcher()
      }
    }
  })
  window.addEventListener('keyup', (event) => {
    hoverWithMeta = event.metaKey || event.ctrlKey
  })
  window.addEventListener('popstate', () => {
    const path = new URLSearchParams(location.search).get('note')
    if (path) openNote(path, { push: false })
  })
  window.addEventListener('pagehide', () => {
    unloading = true
    saver?.close()
    // 右の枠はClaudeに知らせない。右の枠を閉じたあとは、左が知らせ直す。
    if (PANE !== 'right') request('/api/state', { method: 'PUT', body: JSON.stringify({ path: null }) }).catch(() => {})
  })
  window.addEventListener('beforeunload', () => {
    unloading = true
    commitOpenField()
    if ($('status').dataset.state === 'dirty') saver?.save()
  })
  // 戻るボタンなどでページが保存されていた状態から戻ると、保存の係はもう閉じている。下書きから開き直す。
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload()
  })
}

// Cmd+V でコピーしたパスのノートを開く処理と、その案内。左右どちらの枠でも同じ決まりで動き、押した枠で開く
// （右の枠には split がないので、openFromPaste の openIn はその枠の openNote になる）。
function bindPasteOpen() {
  document.addEventListener('paste', openFromPaste)
  document.addEventListener('click', (event) => {
    // チェックやリンク、本文の中の部品（箇条書きの記号、コールアウトの題名、表など）を押したときは、その操作のためなので案内を出さない。
    const content = view?.contentDOM
    const onPart = Boolean(pressedPart(event.target, content)) || Boolean(event.target.closest?.('.cm-list-number'))
    const onBody = event.target.closest?.('#editor') && !event.target.closest('.cm-task-box, [data-href], a, #task-panel') && !onPart
    showPasteHint(Boolean(onBody) && pasteOpensNoteAt(document.activeElement))
  })
  // 案内が最後の行に重なるので、読み進めるときは消す。
  $('editor').addEventListener('scroll', () => showPasteHint(false), { capture: true, passive: true })
  window.addEventListener('blur', () => showPasteHint(false))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') showPasteHint(false)
  })
}

function bindLeftChrome() {
  $('open-note').addEventListener('click', openSwitcher)
  $('new-note').addEventListener('click', () => newNoteFromButton())
  bindFilesPanel()
  // 右の枠が操作中なら、履歴は右の枠の中に出してもらう（前の版に戻すのは、そのノートを開いている枠でしかできない）。
  $('open-history').addEventListener('click', () => (rightActive() ? split.post({ type: MSG.HISTORY }) : openHistory()))
  bindSplit()
  $('switcher-input').addEventListener('input', (event) => renderSwitcher(event.target.value))
  $('switcher-input').addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSwitcher(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSwitcher(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const selected = $('switcher-list').querySelector('[aria-selected="true"]')
      if (selected?.dataset.create) createFromSwitcher(selected.dataset.path)
      else if (selected) chooseSwitcher(selected.dataset.path)
    }
  })
  $('toggle-outline').addEventListener('click', toggleOutline)
  $('toggle-calendar').addEventListener('click', () => showCalendar($('calendar').hidden))
  $('toggle-tasks').addEventListener('click', () => showTasksSide($('tasks-side').hidden))
  $('today-note').addEventListener('click', () => openPeriodicNote('daily', todayText(), { ask: false }))
  $('toggle-files').addEventListener('click', () => showFiles($('files').hidden))
  // 押しても、書いていた場所からカーソルが動かないようにする。
  $('copy-path').addEventListener('mousedown', (event) => event.preventDefault())
  $('copy-path').addEventListener('click', copyNotePath)
  $('to-chat').addEventListener('click', () => (rightActive() ? split.post({ type: MSG.CHAT }) : sendSelectionToChat()))
  setupChatBox()
  setupSideResize()
}

// ---- 左右に分ける（左の枠で使う） ----

function syncSplitButton() {
  const button = $('toggle-split')
  const open = split.isOpen()
  button.hidden = isNarrow()
  button.textContent = open ? '分割を閉じる' : '右に分ける'
  button.title = open ? '右の枠を閉じる' : 'ノートを左右に並べる'
}

async function openSplit() {
  if (split.isOpen() || isNarrow()) return
  setRightOpen(true)
  const opened = split.open()
  syncSplitButton()
  await opened
}

async function closeSplit() {
  if (!split.isOpen()) return
  // 右の書きかけを保存してから外す。閉じると左の枠が操作中になり、Claudeへ知らせ直す。
  await split.close()
  setRightOpen(false)
  rightWant = null
  rightShown = null
  rightState = { path: null, selection: '', dirty: false, headings: null, lines: null }
  syncSplitButton()
  if (reloadAfterSplit) {
    reloadAfterSplit = false
    location.href = '/'
  }
}

function bindSplit() {
  $('toggle-split').addEventListener('click', () => {
    if (split.isOpen()) {
      closeSplit()
      return
    }
    // 左にノートが開いていれば、右にも同じノートを出す。開いていなければ、右は空のまま。
    rightWant = currentPath ? { path: currentPath } : null
    openSplit()
  })
  // 左の枠のノートを押したり打ったりしたら、左を操作中にする（枠が変わったときだけ動く）。
  $('editor').addEventListener('pointerdown', () => split.setActive('left'), true)
  $('editor').addEventListener('keydown', () => split.setActive('left'), true)
  window.addEventListener('resize', () => {
    syncSplitButton()
    if (isNarrow()) closeSplit()
  })
  syncSplitButton()
}

// 操作中の枠が変わったら、Claudeへの知らせ、カレンダーの印、目次を、その枠のノートに合わせる。
function activeChanged() {
  // 左が操作中になったのに左でノートを開いていなければ、閉じた右の枠のノートを開いたままだとClaudeに思われないよう、空で知らせる。
  if (!rightActive() && !(currentPath && view)) {
    if ($('status').dataset.state !== 'elsewhere') {
      request('/api/state', { method: 'PUT', body: JSON.stringify({ path: null, selection: '', dirty: false }) }).catch(() => {})
    }
  } else {
    sendState()
  }
  drawCalendar()
  renderOutline()
}

function receiveFromRight(data) {
  if (data.type === MSG.READY) {
    // 分けた直後は頼んでおいたノート、右の枠だけ読み込み直したときは、そこで開いていたノートを送り直す。
    const want = rightWant ?? (rightState.path ? { path: rightState.path } : null)
    rightWant = null
    if (want) split.post({ type: MSG.OPEN, ...want })
    split.post({ type: MSG.ACTIVE, active: rightActive() })
    split.post({ type: MSG.THEME, theme: chosenTheme() })
  } else if (data.type === MSG.OPEN) {
    // 右の枠でCmd+クリックしたリンクは、左で開く。
    if (typeof data.path === 'string') openIn('left', data.path, { anchor: typeof data.anchor === 'string' ? data.anchor : '' })
  } else if (data.type === MSG.TASKS) {
    refreshAfterTasks()
  } else if (data.type === MSG.NOTE_SAVED) {
    refreshTaskSide()
  } else if (data.type === MSG.TRASHED) {
    trashedElsewhere(data)
  } else if (data.type === MSG.SAVE_LEFT) {
    saveForRight(data)
  } else if (data.type === MSG.CLICKED) {
    split.setActive('right')
  } else if (data.type === MSG.OPENED) {
    const path = typeof data.path === 'string' ? data.path : null
    rightState.path = path
    rightState.headings = Array.isArray(data.headings) ? data.headings : null
    // 同じノートの OPENED は、書いている間の見出しの更新。ノートが変わったときだけカレンダーを描き直す。
    if (path !== rightShown) {
      rightShown = path
      if (rightActive()) drawCalendar()
    }
    if (rightActive()) renderOutline()
  } else if (data.type === MSG.STATE) {
    rightState.path = typeof data.path === 'string' ? data.path : null
    rightState.selection = typeof data.selection === 'string' ? data.selection : ''
    rightState.dirty = Boolean(data.dirty)
    rightState.lines = linesFrom(data.lines)
    if (data.askChat) {
      // 右の枠で選んだ文字を、左の「チャットへ」と同じくチャットの入力欄へ送る。
      putRightState({ askChat: data.askChat })
      setStatusHint('チャットの入力欄へ送りました')
    } else if (rightActive()) {
      sendState()
    }
  } else if (data.type === MSG.SEARCH) {
    openSwitcher()
  } else if (data.type === MSG.CLOSE) {
    closeSplit()
  }
}

// 選んでいる文字をチャットの入力欄へ送る。右の枠では、左から CHAT を受けたときに使う。
function sendSelectionToChat() {
  const selection = view.state.selection.main
  const text = view.state.sliceDoc(selection.from, selection.to)
  if (!text) {
    setStatusHint('先に文字を選んでください')
    return
  }
  sendState({ askChat: { text: text.slice(0, 4000), at: Date.now() } })
  setStatusHint('チャットの入力欄へ送りました')
}

function bindRightChrome() {
  $('pane-close').hidden = false
  $('pane-close').addEventListener('click', () => toLeft({ type: MSG.CLOSE }))
  // 右の枠を押したり打ったりしたら、左に操作中にしてもらう。
  const clicked = () => {
    if (!paneActive) toLeft({ type: MSG.CLICKED })
  }
  $('editor').addEventListener('pointerdown', clicked, true)
  $('editor').addEventListener('keydown', clicked, true)
  window.addEventListener('message', (event) => {
    if (!isPaneMessage(event, { origin: location.origin, source: parent })) return
    receiveFromLeft(event.data)
  })
}

async function receiveFromLeft(data) {
  if (data.type === MSG.OPEN) {
    if (typeof data.path !== 'string') return
    // 名前を変えたり動かしたりしたあとは、古い場所へ保存しに行かずに開き直す。
    if (data.reopen) {
      const oldPath = currentPath
      saver?.close()
      saver = null
      // close で古い場所の名前で残した一時保存を、新しい場所の名前へ移す。開き直したときに戻せるように。
      const draft = oldPath && oldPath !== data.path ? drafts.get(oldPath) : null
      if (draft) {
        drafts.set(data.path, draft)
        drafts.remove(oldPath)
      }
    }
    await openNote(data.path, { push: false, anchor: data.anchor, startMode: data.startMode, focus: data.focus === true })
  } else if (data.type === MSG.ACTIVE) {
    paneActive = Boolean(data.active)
    if (paneActive) {
      postOpened()
      sendState()
    }
  } else if (data.type === MSG.JUMP) {
    if (!currentPath || !view) return
    const pos = Math.max(0, Math.min(Number(data.from) || 0, view.state.doc.length))
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 20 }) })
  } else if (data.type === MSG.TASKS) {
    refreshAfterTasks()
  } else if (data.type === MSG.FOCUS) {
    enterBody()
  } else if (data.type === MSG.CHAT) {
    sendSelectionToChat()
  } else if (data.type === MSG.HISTORY) {
    openHistory()
  } else if (data.type === MSG.THEME) {
    // 左が選んだ配色に合わせる。記録は左が持つので、ここでは保存しない。
    themeChoice = data.theme === 'light' || data.theme === 'dark' ? data.theme : null
    applyTheme()
  } else if (data.type === MSG.LEFT_SAVED) {
    leftSaveWaiters.answer(data.id, { dirty: data.dirty !== false })
  } else if (data.type === MSG.SAVE) {
    try {
      commitOpenField()
      await saver?.flush()
      // 保存しきれなかったら、右の枠が閉じられたり移動を止めたりする前に、今の内容で一時保存を書き直しておく。
      if (saver && !CLEAN_STATES.has($('status').dataset.state)) saver.keepDraft()
    } finally {
      // 保存が止まっているとき（ぶつかった、見つからないなど）は flush しても書けないので、まだ書きかけがあると返す。
      toLeft({ type: MSG.SAVED, id: data.id, dirty: Boolean(saver) && !CLEAN_STATES.has($('status').dataset.state) })
    }
  }
}

// 埋め込みの画面では選択してコピーする方法しか通らないことがあるので、それも用意する。
function execCopy(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    return document.execCommand('copy')
  } finally {
    area.remove()
  }
}

// 今開いているノートの絶対パスをコピーする。編集できないノートでも使える。
// 押した直後でないとコピーを断るブラウザがあるので、サーバーを待たずにその場で作る。
async function copyNotePath() {
  if (!currentPath) return
  const full = absolutePath(rootPaths, currentPath, platform)
  if (!full) {
    showMessage('このノートのパスを調べられませんでした。')
    return
  }
  // 表のマスなどで入力していた場所へ戻す。
  const before = document.activeElement
  if (await copyText(full, { clipboard: navigator.clipboard, execCopy })) {
    setStatusHint('コピーしました')
    if (view && before === view.contentDOM) view.focus()
    else if (before instanceof HTMLElement && before !== document.body && before.isConnected) before.focus()
  } else {
    showCopyable(keyLabel('コピーできませんでした。下のパスは選択済みです。Cmd+C でコピーしてください。'), full)
  }
}

function setStatusHint(text) {
  const box = $('status')
  const previous = box.dataset.state
  box.textContent = text
  // 右の枠では「保存済み」を隠すので、案内を出している間だけ印を付けて見えるようにする。
  box.dataset.hint = '1'
  setTimeout(() => {
    if (box.textContent !== text) return
    box.textContent = STATUS_TEXT[previous] ?? ''
    delete box.dataset.hint
  }, 2500)
}

// チャットからClaudeが設定ファイルを書き換えたら、開いている画面にも反映する。
const APPEARANCE_POLL_MS = 3000
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
let appearance = {}
let appliedVars = []

// 明るい画面・暗い画面。エディターで選んだほうを使い、選んでいなければアプリの設定に従う（2026-11-08）。
// アプリと同じ側を選び直したときは、選んだ記録を消して、またアプリの設定に従う。
// ブラウザの保存領域が使えなくても、このタブの間は選んだほうを使えるよう、手元にも持つ。
let themeChoice

function chosenTheme() {
  if (themeChoice === undefined) {
    const theme = storage.get('theme', null)
    themeChoice = theme === 'light' || theme === 'dark' ? theme : null
  }
  return themeChoice
}

function isDark() {
  const theme = chosenTheme()
  return theme ? theme === 'dark' : darkScheme.matches
}

function applyTheme() {
  const theme = chosenTheme()
  if (theme) document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
  const button = $('toggle-theme')
  const dark = isDark()
  button.textContent = dark ? '☀' : '☾'
  button.title = dark ? '明るい画面にする' : '暗い画面にする'
  button.setAttribute('aria-label', button.title)
  applyAppearance()
  // 本文の中の図（Mermaid）を、新しい明暗で描き直す。
  view?.dispatch({ effects: setMode.of(mode) })
  // 分けていれば、右の枠も同じ配色にしてもらう。
  if (split?.isOpen()) split.post({ type: MSG.THEME, theme: chosenTheme() })
}

function toggleTheme() {
  const next = isDark() ? 'light' : 'dark'
  if (next === (darkScheme.matches ? 'dark' : 'light')) {
    themeChoice = null
    storage.remove('theme')
  } else {
    themeChoice = next
    storage.set('theme', next)
  }
  applyTheme()
}

function applyAppearance() {
  const vars = appearanceVars(appearance, isDark())
  for (const name of appliedVars) document.documentElement.style.removeProperty(name)
  for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value)
  appliedVars = Object.keys(vars)
  // 文字の大きさが変わると、行の高さの計算をやり直す必要がある。
  view?.requestMeasure()
}

async function syncAppearance() {
  if (document.hidden) return
  try {
    const { ok, data } = await request('/api/appearance')
    if (!ok || JSON.stringify(data) === JSON.stringify(appearance)) return
    appearance = data
    applyAppearance()
  } catch {
    // サーバーが止まっている間は、今の見た目のままにする。
  }
}

async function start() {
  localizeKeyHints(document) // WindowsではCmdの案内をCtrlにする（鍵の確認を待たずに）
  await takeTicket()
  await bindChat()
  bindChrome()
  applyTheme()
  if (PANE !== 'right') $('toggle-theme').addEventListener('click', toggleTheme)
  applyMode(mode)
  const reply = await request('/api/health')
  if (reply.status === 401) return
  const health = reply.data
  setFileKey(health.fileKey)
  await syncAppearance()
  darkScheme.addEventListener('change', applyTheme)
  setInterval(syncAppearance, APPEARANCE_POLL_MS)
  vaultName = health.rootId
  rootId = health.rootId
  startVersionWatch(reply.version)
  startConnectionWatch()
  rootPaths = health.rootPaths
  platform = health.platform === 'win32' ? 'win32' : 'darwin'
  vaultLabel = health.root
  if (PANE === 'right') {
    await startRight()
    return
  }
  filesOpen = new Set(storage.get(`files-open:${vaultName}`, []))
  $('files').hidden = !storage.get('files-shown', innerWidth >= NARROW_WIDTH)
  await refreshNotes()
  const narrow = isNarrow()
  showCalendar(storage.get('calendar-shown', !narrow), { remember: false })
  showTasksSide(storage.get('tasks-shown', !narrow), { remember: false })
  // カレンダーをたたんでいても、今日のノートのボタンを出すか隠すかは起動時に決める。
  await drawCalendar()
  const params = new URLSearchParams(location.search)
  const path = params.get('note')
  if (path) {
    await openNote(path, { push: false, anchor: decodeURIComponent(location.hash.slice(1)) })
  } else {
    if (params.get('today') === '1') await openPeriodicNote('daily', todayText(), { ask: false })
  }
  if (!path && !view) {
    view = new EditorView({
      state: EditorState.create({ doc: '', extensions: [EditorView.editable.of(false), placeholder(keyLabel('右の一覧からノートを開いてください。コピーしたパスをCmd+Vで貼っても開けます'))] }),
      parent: $('editor'),
    })
    if ($('files').hidden) showFiles(true)
  }
  showPortMovedOnce(health)
  setInterval(() => {
    refreshNotes()
    drawCalendar().catch(() => {})
    refreshTaskPanel()
    refreshTaskSide()
  }, 60_000)
  watchTaskPanelVisibility()
}

function watchTaskPanelVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    refreshTaskPanel()
    refreshTaskSide()
  })
}

// 右の枠は ?note や ?today を見ず、案内も出さない。空のまま左に準備ができたと知らせ、開くノートを待つ。
async function startRight() {
  // カレンダーとファイルの一覧は出さないので、描く処理が動かないよう隠しておく。
  $('calendar').hidden = true
  $('tasks-side').hidden = true
  $('files').hidden = true
  await refreshNotes()
  if (!view) {
    view = new EditorView({
      state: EditorState.create({ doc: '', extensions: [EditorView.editable.of(false)] }),
      parent: $('editor'),
    })
  }
  // 置き場の問い合わせは待たない（開くノートを受け取るのを遅らせない）。パネルを描くときに、まだなら待つ。
  ensureRightPeriodicRoot()
  toLeft({ type: MSG.READY })
  setInterval(() => {
    refreshNotes()
    // 置き場の設定が変わったときに追いつくよう、60秒ごとに聞き直す（左はカレンダーの読み直しで同じことをしている）。
    loadRightPeriodicRoot().finally(refreshTaskPanel)
  }, 60_000)
  watchTaskPanelVisibility()
}

window.noteEditor = { getView: () => view, getSaver: () => saver }
takeToken()
// 開いているタブへ#だけ変えて移動してきたときは、読み込み直しが起きない。
window.addEventListener('hashchange', async () => {
  // 別のチャットから同じタブへ移ってきたときは、送り先もそのチャットに変える（引き換えてから読み込み直して、チャット欄を結び付け直す）。
  const hadCode = takeChatBindCode()
  const isToken = Boolean(tokenFromHash(location.hash))
  const isTicket = Boolean(ticketFromHash(location.hash))
  if (!isToken && !isTicket) {
    if (hadCode && (await bindChat())) location.reload()
    return
  }
  const changed = isToken ? takeToken() : await takeTicket()
  const linkChanged = hadCode ? await bindChat() : false
  // 起動に失敗していたタブは、合言葉が同じでも開き直す。鍵を断られたことは、読み込み直したあとの開けない画面へ引き継ぐ。
  if (changed || !view || linkChanged) {
    if (!changed && keyRefused) markKeyRefused(sessionStore)
    location.reload()
  }
})
start()
