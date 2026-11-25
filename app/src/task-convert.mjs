// 「タスクにする」の画面の操作（段階1-C2）のうち、DOM に頼らない部分。
// 行の判定は task-line.mjs の taskFromLine。ここでは、エディターの文書との突き合わせ、リンクの文字、知らせの文を決める。
import { compileMoves, relinkText } from './relink.mjs'
import { TASK_FOLDER } from './tasks.mjs'
import { childrenOf, taskFileName, taskFromLine } from './task-line.mjs'

export const TASK_LINK_LABEL = '→タスク'

// 選べない理由を、短い知らせにする（ボタンやキーで選んだとき）。
const REASON_TEXT = {
  'no-source': '「タスクにする」は、週・月・四半期のノートと、タスクのノートで使えます。',
  'no-line': 'この行はタスクにできません。',
  front: 'プロパティの行はタスクにできません。',
  code: 'コードの中の行はタスクにできません。',
  heading: '見出しはタスクにできません。見出しの下の箇条書きの行で選んでください。',
  'not-list': 'タスクにできるのは箇条書きの行です。',
  empty: '中身のない行はタスクにできません。',
  'week-link': '週のリンクの行はタスクにできません。その下の行で選んでください。',
  struck: '取り消し線を引いた行はタスクにできません。',
  'has-task-link': 'この行は、もうタスクになっています。',
  callout: '囲みの見出しの行はタスクにできません。',
  rule: '区切り線はタスクにできません。',
}

// POST /api/tasks が断ったときの知らせ。
export function createFailedText(status, error) {
  if (status === 400 && error === 'tasks-folder') return 'Vault の直下に Tasks というフォルダーを作れませんでした（同じ名前のファイルがあるなど）。タスクのノートは作っていません。'
  if (status === 409) return '同じ名前のタスクのノートが多すぎて、作れませんでした。'
  if (status === 400 && error === 'body') return '下の行をタスクのノートへ移せなかったので（行が多すぎるなど）、作れませんでした。ノートは変えていません。'
  return 'タスクのノートを作れませんでした。'
}

export function reasonText(reason) {
  return REASON_TEXT[reason] ?? 'この行はタスクにできません。'
}

// エディターの文書（CodeMirror の Text。改行は LF にそろっている）と、行の番号から、タスクにできるかを調べる。
// taskFromLine に渡すのは doc.toString() なので、返った from・to はそのまま文書の位置になる。念のため、行の位置と文字を突き合わせる。
export function taskForDocLine(doc, lineNumber, { path, periodicRoot, known }) {
  if (!doc || !Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > doc.lines) return { ok: false, reason: 'no-line' }
  const found = taskFromLine({ path, text: doc.toString(), line: lineNumber, periodicRoot, known })
  if (!found.ok) return found
  const line = doc.line(lineNumber)
  if (line.from !== found.from || line.to !== found.to || line.text !== found.lineText) return { ok: false, reason: 'no-line' }
  return found
}

// 右クリックで自前のメニューを出すか。出すのは、タスクにできる行の上だけ（ほかは標準のメニュー）。
export function menuForLine(found) {
  return Boolean(found?.ok)
}

// 返った path（Tasks/2026-11-24-….md）から、行末に足すリンクを作る。
export function taskLinkText(path) {
  return '[[' + String(path).replace(/\.md$/i, '') + '|' + TASK_LINK_LABEL + ']]'
}

// 行末にリンクを足す変更。行末に空白があれば、空白の前（文の直後）に「 リンク」を入れる。
// 空白を残したまま後ろに足すと、リンクの前の空白が2つ以上になったり、行末の2つの空白（改行の印）が文の途中に来たりするため。
export function linkChange({ from, lineText }, path) {
  const body = lineText.replace(/[\t ]+$/, '')
  return { from: from + body.length, to: from + body.length, insert: ' ' + taskLinkText(path) }
}

// 作るタスクのノートの、予想のパス（Tasks/作成日-目標の文.md）。サーバーは、同じ名前があれば -2 を付け、Tasks の大文字小文字が
// 違えば実際の名前を使うが、どれも同じフォルダーの同じ深さなので、本文のリンクの直し方は変わらない。
export function expectedTaskPath(found, created) {
  return TASK_FOLDER + '/' + taskFileName(found.title, created)
}

// 移す子の行（found.children.lines）から、タスクのノートの本文を作る。行を改行でつなぎ、末尾に改行を1つ足す。
// リンクは、元のノート（notePath）から新しいノート（taskPath）へ動いたものとして直す（relinkText。相対のリンクと、
// 名前だけで別のノートを指すようになるリンク）。known は Vault のノートの一覧（Set か配列）。子がなければ ''。
export function movedBody(found, { notePath, taskPath, known }) {
  const lines = found?.children?.lines
  if (!lines?.length) return ''
  const before = [...(known ?? [])]
  const after = before.includes(taskPath) ? before : [...before, taskPath]
  const { text } = relinkText(lines.join('\n'), { note: notePath, after: taskPath, move: compileMoves([]), knownBefore: before, knownAfter: after })
  return text + '\n'
}

// 1回の変更（dispatch）に入れる changes。行末にリンクを足し、子の行（children の from〜to。行の終わりから最後の子の行の終わりまで）を消す。
// どちらも変更の前の文書の位置で書く。リンクは行の終わり以下に入り、消すのは行の終わりから先なので、重ならない。
// at・children は planAfterCreate が返したもの。children がなければリンクだけ。
export function moveChanges(at, taskPath, children) {
  const link = linkChange(at, taskPath)
  return children ? [link, { from: children.from, to: children.to, insert: '' }] : [link]
}

// 文書の lineNumber 行目の子の行が、覚えた子の行（kids.text）とちょうど同じなら、今の文書での位置を返す。違えば null。
// 前から同じ文字で始まるだけでは足りない（最後の子の行に書き足した・子の行を足したときに、行の途中で消してしまうため）。
function sameChildren(doc, lineNumber, kids) {
  const now = childrenOf(doc.toString(), lineNumber - 1)
  return now && now.text === kids.text ? { from: now.from, to: now.to, text: now.text } : null
}

// POST /api/tasks のあと、覚えた行がまだ同じ場所に同じ文字であるか。
export function lineStillThere(doc, { from, to, lineText }) {
  if (!doc || to > doc.length) return false
  if (doc.sliceString(from, to) !== lineText) return false
  const line = doc.lineAt(from)
  return line.from === from && line.to === to
}

// POST /api/tasks が成功したあとに、どうするか。
//   { action: 'link', at: { from, to, lineText }, moved }：その行の末尾にリンクを足す。moved は、覚えた場所からずれた行へ足すとき true。
//   { action: 'trash', reason }：リンクは足さず、作ったノートをゴミ箱へ。reason は 'switched'（別のノートを開いた）・
//     'stopped'（保存が止まった・書き換えられない）・'changed'（行が書き換わった、または同じ文字の行が見つからない・2つ以上ある）。
// 位置がずれただけ（上で行を足した・消したなど）なら、同じ文字の行がちょうど1つあるときだけ、そこへ足す。
// 子の行を移すとき（found.children がある）は、行のすぐ下の子の行もちょうど同じであることを確かめ、今の位置を children で返す
// （{ action: 'link', at, moved, children: { from, to, text } }）。子の行が書き換わった・足された・減ったときは 'changed'。
export function planAfterCreate({ sameNote, canWrite, doc, found }) {
  if (!sameNote) return { action: 'trash', reason: 'switched' }
  if (!canWrite) return { action: 'trash', reason: 'stopped' }
  const kids = found.children ?? null
  const link = (line, moved) => {
    if (!kids) return { action: 'link', at: { from: line.from, to: line.to, lineText: line.text }, moved }
    const children = sameChildren(doc, line.number, kids)
    return children ? { action: 'link', at: { from: line.from, to: line.to, lineText: line.text }, moved, children } : null
  }
  const changed = { action: 'trash', reason: 'changed' }
  if (lineStillThere(doc, found)) return link(doc.lineAt(found.from), false) ?? changed
  const same = []
  for (let n = 1; n <= doc.lines && same.length < 2; n++) {
    const line = doc.line(n)
    if (line.text === found.lineText) same.push(line)
  }
  if (same.length === 1) return link(same[0], true) ?? changed
  return changed
}

const NOT_LINKED_WHY = {
  switched: '作っている間に別のノートを開いたので',
  stopped: '作っている間にこのノートの保存が止まったので',
  changed: '作っている間に行が書き換わったので',
}

// 下の行をタスクのノートの本文に入れて作ったのに、元のノートから消さなかったときに足す文。
const COPIED = '本文には、下の行と同じ行が入っています。'

// リンクを足さなかったときの知らせ。trashed はゴミ箱へ移せたか。moved は、本文に入れた下の行があるか（元のノートからは消していない）。
export function notLinkedText(reason, { trashed, taskPath, moved = false }) {
  const why = NOT_LINKED_WHY[reason] ?? '作っている間にノートが変わったので'
  return why + '、リンクは足していません。' + (trashed
    ? '作ったタスクのノートはゴミ箱へ移しました。もう一度選んでください。'
    : `作ったノート（${taskPath}）が Tasks に残っています。` + (moved ? COPIED : ''))
}

// ノートを作ったあと、リンクを足す途中で失敗したときの知らせ。moved は notLinkedText と同じ。
export function leftoverText(taskPath, { moved = false } = {}) {
  return `リンクを足せませんでした。作ったノート（${taskPath}）が Tasks に残っています。` + (moved ? COPIED : '')
}

// ノートを作れたかわからないまま失敗したとき（作る問い合わせの応答が届かなかったなど）の知らせ。元のノートは変えていない。
// moved は、送った本文に下の行を入れていたか。
export function createLostText({ moved = false } = {}) {
  if (!moved) return 'タスクのノートを作れませんでした。'
  return 'タスクのノートを作れたかどうか、確かめられませんでした。作れていた場合は、Tasks のそのノートの本文に下の行と同じ行が入っています。元のノートは変えていません。'
}

// 自前のメニューの下に出す案内。
export const MENU_HINT = 'Shift+右クリックでいつものメニュー'

// 送る中身（作成日は画面の今日）。
// text は本文（movedBody の結果）。空なら送らない。
export function taskRequestBody(found, created, text = '') {
  const body = { title: found.title, created }
  if (found.due) body.due = found.due
  if (found.goal) body.goal = found.goal
  if (found.parent) body.parent = found.parent
  if (text) body.body = text
  return body
}

// 作ったあとの知らせ。期日は M/D で出す（年は出さない）。
// moved は、タスクのノートへ移した子の行の数（空の行は数えない）。1以上なら、移したことと、取り消すと戻ることを書く。
// 取り消してもタスクのノートは消えないこと（移した行は、タスクのノートにも残ること）も書く。
export function createdText(due, { moved = 0 } = {}) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(due ?? '')
  const head = m ? `期日 ${Number(m[1])}/${Number(m[2])} で作りました。` : '期日なしで作りました。'
  if (Number.isInteger(moved) && moved > 0) return head + `下の${moved}行をタスクのノートへ移しました。「取り消す」を押すと、リンクを外して行を元に戻します。タスクのノートは、同じ行が入ったまま Tasks に残ります。`
  return head + '「取り消す」を押すと、行のリンクだけを外します。タスクのノートは Tasks に残ります。'
}

// 「取り消す」のあとの知らせ。moved は、移した行を戻したか。
export function undoneText({ moved = false } = {}) {
  const left = moved ? 'タスクのノートは、戻した行と同じ行が入ったまま Tasks に残っています。' : 'タスクのノートは Tasks に残っています。'
  return '取り消しました。' + left + 'いらなければ、サイドバーの「リンクが外れたタスク」からゴミ箱へ移せます。'
}

// 履歴の undo（Cmd+Z）で、「タスクにする」の変更まで戻ったか。last は作った直後の履歴の深さ（depth）。
// 「タスクにする」の変更は1つの履歴になっている（isolateHistory）ので、深さがそれより浅くなれば、その変更は戻っている。
export function undidTask(last, { undo, depth }) {
  return Boolean(last && undo && Number.isInteger(last.depth) && depth < last.depth)
}

// 「取り消す」で、履歴の undo をそのまま使ってよいか。作った直後の文書と同じで、履歴の深さも同じときだけ。
export function canUndoDirectly({ doc, depth }, now) {
  return Boolean(now?.doc && doc && now.doc.eq(doc) && now.depth === depth)
}

// 履歴の undo を使えないとき（あとで打った文字がある）に、足したリンクだけを外す変更。
// 足した文字（「 リンク」）が文書にちょうど1つあるときだけ。見つからない・2つ以上なら null。
export function linkRemoval(text, path) {
  const insert = ' ' + taskLinkText(path)
  const first = text.indexOf(insert)
  if (first < 0 || text.indexOf(insert, first + 1) >= 0) return null
  return { from: first, to: first + insert.length, insert: '' }
}

// 子の行を移したあとで、履歴の undo を使えないとき（あとで打った文字がある）に、足したリンクを外し、消した子の行
// （removedText。先頭の改行を含む）をその行のすぐ下へ戻す changes。linkRemoval の子のある版。
// 足した文字（「 リンク」）が文書にちょうど1つあるときだけ。見つからない・2つ以上なら null。
export function moveUndoChange(text, path, removedText) {
  const removal = linkRemoval(text, path)
  if (!removal) return null
  const next = text.indexOf('\n', removal.to)
  const end = next < 0 ? text.length : next
  return [removal, { from: end, to: end, insert: removedText }]
}
