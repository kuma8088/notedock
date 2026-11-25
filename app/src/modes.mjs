import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { cursorQuiet, setCursorQuiet, typingStart } from './preview.mjs'

// ノートの表示まわりの決まりのうち、画面（DOM）に頼らずに決められるもの。main.mjs から使い、テストで動きを確かめる。

// 編集できるノートなら画面も編集でき、編集できないノートなら画面も読み取り専用にする（表示の切り替えでは変えない）。
export function editableExtensions(canEdit) {
  const allow = canEdit === true
  return [EditorView.editable.of(allow), EditorState.readOnly.of(!allow)]
}

// 本文にフォーカスが入ったときに、開いた直後の印（記号を出さない）を外すか。
// マウスや指でエディターを押している最中（pressing）は外さない。押した位置にカーソルが動いてから、endQuietAfterClick で外す。
// それ以外（Tab で入ったとき、新しく作ったノートで本文にフォーカスを入れたとき、「編集」「ソース」のボタンのあと）は外す。
// 印があると、カーソルの行の記号が隠れたまま打つことになり、Enter や Backspace が見た目と違う所に効くため。
export function focusEndsQuiet({ quiet = false, pressing = false } = {}) {
  return quiet === true && pressing !== true
}

// 「編集」「ソース」のボタンを押したあと、本文にフォーカスを戻すか。マウスで押したとき（click の detail が 1 以上）だけ戻す。
// キーボードの Enter・Space で押したとき（detail が 0）は、ボタンに残す。キーボードだけで使う人が、続けてボタンを操作できるように。
// 開いてからまだ本文をクリックしていない（開いた直後の印 quiet が残っている）ときも戻さない。既にあるノートは、本文をクリックしてから書き始めるため。
// 戻すと、隠れていた先頭の記号の前後にカーソルがある状態で打つことになる。
export function refocusesBody(event, { quiet = false } = {}) {
  return Number(event?.detail) > 0 && quiet !== true
}

// 貼り付けた先（フォーカスのある場所）を調べる。inField: 入力欄・表のマス・ノートの情報の欄。inText: 本文。
const FIELD = 'input, textarea, select, .cm-cell-editing, .cm-props'
export function pastePlace(target) {
  const el = target?.closest ? target : target?.parentElement
  return { inField: Boolean(el?.closest?.(FIELD)), inText: Boolean(el?.closest?.('.cm-content')) }
}

// Cmd+V を、コピーしたパスのノートを開く操作にするか。
// - 入力欄・表のマス・ノートの情報の欄の中では、ふつうの貼り付け。
// - 本文の中では、編集できるノートならふつうの貼り付け。ノートを開いていないときと、編集できないノートでは開く。
// - それ以外（フォーカスが本文や入力欄の外にあるとき）は、ノートを開く。
export function pasteOpensNote({ hasNote = false, editable = false, inField = false, inText = false } = {}) {
  if (inField) return false
  if (inText) return !hasNote || !editable
  return true
}

// エディターをクリックしたあと、開いた直後の印（記号を出さない）を外す。エディターがクリックの位置を決めてから外す。
// 先に外すと、先頭の行の見た目が変わって、押した位置がずれる。
// 外すまでの間に別のノートを開いていたら（roundNow() の開いた回が変わったら）、新しいノートの印は外さない。
// view は使い回す（ノートを開くたびに setState で中身を入れ替える）ので、view だけでは見分けられない。
// part：本文の中の部品（コールアウトの題名、表など）を押したとき。{ focus, cursor }。
// - focus() は、押したあとのフォーカスの場所。'body'（本文）、'inside'（表のマスなど、本文の中の入力の場所）、null（本文の外）。
// - cursor(state, focus) は、カーソルを動かす先（動かさないときは null）。partCursor で決める。
//   表のマスに入ったとき（'inside'）も、表のすぐ後ろへ動かす。マスの編集を Escape で終えると本文にフォーカスが戻るので、1行目に残さないため。
// 部品を押すと、エディターは押した位置にカーソルを動かさないことがある（題名や表は押した操作をエディターに渡さない）。
// 印が残っている（カーソルが開いたときの1行目のまま）のに本文にフォーカスが入っていたら、カーソルを部品の所へ動かしてから印を外す。
// 1行目にカーソルが残ると、隠れた記号の前後で打つことになる（見出しで Backspace を押すと # のあとの空白が消える、など）。
// 本文にフォーカスが入らなかったとき（チェックボックス、子を開閉した箇条書きの記号）は、その操作のためなので印を残す。
export function endQuietAfterClick(view, roundNow, later = setTimeout, part = null) {
  const round = roundNow()
  later(() => {
    if (roundNow() !== round || !cursorQuiet(view.state)) return
    if (!part) {
      view.dispatch({ effects: setCursorQuiet.of(false) })
      return
    }
    const focus = part.focus()
    if (!focus) return
    const anchor = part.cursor(view.state, focus)
    view.dispatch(anchor === null ? { effects: setCursorQuiet.of(false) } : { selection: { anchor }, effects: setCursorQuiet.of(false) })
  }, 0)
}

// 押した所が、本文の中の部品（エディターが書き換えさせない [contenteditable="false"] の部分）なら、その部品を返す。
// 編集できないノートでは本文そのもの（content）も contenteditable="false" なので、本文そのものは部品に数えない。
export function pressedPart(target, content) {
  const el = target?.closest ? target : target?.parentElement
  const part = el?.closest?.('[contenteditable="false"]')
  if (!part || !content || part === content || !content.contains(part)) return null
  return part
}

// 部品の種類。props：ノートの情報の欄（先頭の --- の部分）。table：表。line：行の頭から始まる部品（コールアウトの題名など）。
export function partKind(part) {
  if (part?.closest?.('.cm-props, .cm-frontmatter')) return 'props'
  if (part?.closest?.('.cm-table-wrap')) return 'table'
  return 'other'
}

// 部品を押して本文にフォーカスが入ったときに、カーソルを置く位置。pos は部品の始まり（view.posAtDOM）。
// - ノートの情報の欄：動かさない（null）。欄の中（--- の中）に置くと、欄が文字のまま見えてしまう。欄のすぐ下が本文の1行目なので、そのままでよい。
// - 表：表のすぐ後ろ（次の行の頭）。表の中に置くと表が文字のまま見えて、マスの編集もできなくなる。length は表の文字数。
// - 行の頭から始まる部品：ノートを開いたときと同じ決め方（typingStart）。コールアウトの題名なら、すぐ下の中身の行の頭（「> 」のあと）。
// - それ以外：部品の前。
export function partCursor(state, { pos, kind, length = 0 }) {
  if (kind === 'props') return null
  if (kind === 'table') return Math.min(state.doc.length, pos + length + 1)
  return pos === state.doc.lineAt(pos).from ? typingStart(state, pos) : pos
}
