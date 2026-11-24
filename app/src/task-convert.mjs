// 「タスクにする」の画面の操作（段階1-C2）のうち、DOM に頼らない部分。
// 行の判定は task-line.mjs の taskFromLine。ここでは、エディターの文書との突き合わせ、リンクの文字、知らせの文を決める。
import { taskFromLine } from './task-line.mjs'

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

// POST /api/tasks のあと、覚えた行がまだ同じ場所に同じ文字であるか。
export function lineStillThere(doc, { from, to, lineText }) {
  if (!doc || to > doc.length) return false
  if (doc.sliceString(from, to) !== lineText) return false
  const line = doc.lineAt(from)
  return line.from === from && line.to === to
}

// 送る中身（作成日は画面の今日）。
export function taskRequestBody(found, created) {
  const body = { title: found.title, created }
  if (found.due) body.due = found.due
  if (found.goal) body.goal = found.goal
  if (found.parent) body.parent = found.parent
  return body
}

// 作ったあとの知らせ。期日は M/D で出す（年は出さない）。
export function createdText(due) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(due ?? '')
  const head = m ? `期日 ${Number(m[1])}/${Number(m[2])} で作りました。` : '期日なしで作りました。'
  return head + '「取り消す」を押すと、行のリンクだけを外します（タスクのノートは Tasks に残ります）。'
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
