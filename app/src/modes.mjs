import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { cursorQuiet, setCursorQuiet } from './preview.mjs'

// ノートの表示まわりの決まりのうち、画面（DOM）に頼らずに決められるもの。main.mjs から使い、テストで動きを確かめる。

// 編集できるノートなら画面も編集でき、編集できないノートなら画面も読み取り専用にする（表示の切り替えでは変えない）。
export function editableExtensions(canEdit) {
  const allow = canEdit === true
  return [EditorView.editable.of(allow), EditorState.readOnly.of(!allow)]
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
export function endQuietAfterClick(view, roundNow, later = setTimeout) {
  const round = roundNow()
  later(() => {
    if (roundNow() !== round || !cursorQuiet(view.state)) return
    view.dispatch({ effects: setCursorQuiet.of(false) })
  }, 0)
}
