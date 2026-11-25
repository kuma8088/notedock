import { Annotation, EditorState, StateField, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { cursorQuiet, previewField, setComposing, setCursorQuiet, typingStart } from './preview.mjs'

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
// - cursor(state, focus) は、カーソルを動かす先（動かさないときは null、動かして印を残すときは { anchor, quiet: true }）。partCursor で決める。
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
    // { anchor, quiet: true }：カーソルを動かし、印は残す（表のマスに入ったが、表の外にカーソルを置ける所がないとき。
    // 印を外すと表が文字に戻り、マスの編集が終わってしまう。マスを出たあと（Escape）に打つ文字は、表の最後の行の後ろに入る）。
    if (anchor && typeof anchor === 'object') {
      view.dispatch({ selection: { anchor: anchor.anchor }, effects: setCursorQuiet.of(true) })
      return
    }
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
// - ノートの情報の欄：本文の最初の行（欄の閉じの --- の次の行）で、ノートを開いたときと同じ決め方（typingStart）。
//   閉じの --- の行やその前に置くと、欄が文字のまま見えたり、Backspace で閉じの --- と本文の行がつながったりする。
//   欄のあとに行がない（閉じの --- で終わる）ノートでは、閉じの --- のすぐあと（ノートの終わり）。そこで打った文字は、
//   frontmatterGuard が改行を1つ足して次の行に入れる（開いたり押したりしただけではファイルを変えない）。
// - 表：表のすぐ後ろ（次の行の頭）。表の中に置くと表が文字のまま見えて、マスの編集もできなくなる。length は表の文字数。
//   表がノートの最後にあって後ろに改行がないときは、表の前の空の行（表の外）。表のすぐ前が空の行でないとき（見出しや欄の閉じの --- など）と、
//   表がノートの先頭のときは、表の外に置ける所がないので null。main.mjs は、そのとき今のカーソルが表に触れていれば、
//   カーソルを表の終わりへ動かして印を残す（表の頭で打つと見出しの行が壊れるため）。
// - 行の頭から始まる部品：ノートを開いたときと同じ決め方（typingStart）。コールアウトの題名なら、すぐ下の中身の行の頭（「> 」のあと）。
// - それ以外：部品の前。
export function partCursor(state, { pos, kind, length = 0 }) {
  if (kind === 'props') {
    const end = frontmatterEnd(state.doc)
    if (end === null) return null
    return end >= state.doc.length ? end : typingStart(state, end + 1)
  }
  if (kind === 'table') {
    if (pos + length < state.doc.length) return pos + length + 1
    if (pos === 0) return null
    const before = state.doc.lineAt(pos - 1)
    return before.text.trim() === '' ? pos - 1 : null
  }
  return pos === state.doc.lineAt(pos).from ? typingStart(state, pos) : pos
}

// ノートの情報の欄で押した所が、何もない所（入力欄・選ぶ欄・ボタンでない所）か。
export function propsBlankAt(target) {
  const el = target?.closest ? target : target?.parentElement
  return Boolean(el?.closest?.('.cm-props')) && !el.closest('input, select, textarea, button, a, [data-href]')
}

// ノートの先頭の frontmatter（「---」で始まり「---」の行で閉じる部分）の終わり（閉じの --- の行の終わり）。なければ null。
// 見分け方は markdown-syntax.mjs の Frontmatter と同じ（1行目が「---」、後ろの行で最初の「---」が閉じ。前後の空白は見ない）。
export function frontmatterEnd(doc) {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') return null
  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (line.text.trimEnd() === '---') return line.to
  }
  return null
}

// 変更 changes（元のノート startDoc から newDoc へ）が、ノートの情報の欄（frontmatter）を壊すか。止める決まり（frontmatterGuard）と、
// 日本語の変換が終わったあとの取り消し（frontmatterRepair）で同じ決まりを使う。
// 壊す：閉じの --- が元の位置で閉じなくなる（「---T」のように本文の行とつながる、「---x」「x---」になる、開きの --- の前に行が入る）、
//       閉じの --- のあとの改行がなくなる（本文の最初の空の行で Backspace を押したときなど。カーソルが閉じの --- のあとに来て、打っても止まるだけになる）。
// 壊さない：欄の中の項目の書き換え・行の追加（閉じの --- はずれた分だけ動く）、ノート全体を消す・置き換える変更（すべて選択して消す・打ち換える）、
//          欄をまるごと含む範囲（ノートの先頭から閉じの --- まで、またはその先まで）を選んで消す・打ち換える・貼り付ける変更のうち、
//          結果のノートが欄なしで始まる（1行目が --- でない）か、置き換えた文字の中で閉じる正しい欄で始まるもの（欄の部品からの書き換えもこれ）。
//          欄ごと消す・置き換える意図とみなす。欄の一部だけを選んで消す・打ち換える変更や、置き換えた結果「---T」のように閉じが本文とつながるものは壊す。
export function frontmatterDamage(startDoc, changes, newDoc) {
  const end = frontmatterEnd(startDoc)
  if (end === null) return false
  let cover = null
  changes.iterChanges((fromA, toA, fromB, toB) => {
    if (fromA === 0 && toA >= end && cover === null) cover = { whole: toA === startDoc.length, to: toB }
  })
  if (cover?.whole) return false
  const next = frontmatterEnd(newDoc)
  if (cover) return newDoc.line(1).text.trimEnd() === '---' && (next === null || next > cover.to)
  if (next !== changes.mapPos(end, -1)) return true
  return startDoc.sliceString(end, end + 1) === '\n' && newDoc.sliceString(next, next + 1) !== '\n'
}

// 欄を守る決まりを当てる表示か：編集の表示で、編集できるノート（読み取り専用でない）。
// ソースの表示では欄も文字のまま見えていて、本人がそのまま直せるので守らない（英字の「---x」も日本語の「---あ」もそのまま入る）。
// 大きいノートはソースの表示でしか開けない（server/notes.mjs の sourceOnly）。
// 止める決まり（guarded）、変換の記録（composeRecord）、変換のあとの取り消し（frontmatterRepair）で同じ条件を使う。
function guardsFrontmatter(state) {
  return state.field(previewField, false)?.mode === 'live' && !state.readOnly
}

// 欄を守る決まりを当てる変更か。編集の表示の編集できるノートで、本人の操作から来たもの（取り消し・やり直し、履歴に残さない変更（外からの変更の取り込み、
// 下の取り消しなど）、ソースの表示は除く）。
function guarded(tr) {
  if (!tr.docChanged) return false
  if (tr.isUserEvent('undo') || tr.isUserEvent('redo') || tr.annotation(Transaction.addToHistory) === false) return false
  return guardsFrontmatter(tr.startState)
}

// 日本語の変換中の変更か。変換中の変更は止めない。止めると、エディターの「変換中」の状態が戻らなくなり、自動保存が止まり続けるため
// （画面の文字とエディターの中身が食い違ったまま、変換の終わりが届かない）。変換が終わってから frontmatterRepair で取り消す。
// 止めないのは、変換中の印が付いている間の変更すべて。あとで取り消すのは、そのうち変換の変更（input.type.compose）だけ（composeRecord）。
function composingChange(tr) {
  return tr.startState.field(previewField, false)?.composing === true || tr.isUserEvent('input.type.compose')
}

// 編集の表示で、その変更がノートの情報の欄を壊すか（変換中の変更は除く）。壊すなら frontmatterGuard が止める。
export function breaksFrontmatter(tr) {
  if (!guarded(tr) || composingChange(tr)) return false
  return frontmatterDamage(tr.startState.doc, tr.changes, tr.newDoc)
}

// 欄だけで本文の行がない（閉じの --- でノートが終わる）ノートで、閉じの --- のすぐあとに文字を足す変更か。
// そのまま入れると「---abc」になって欄が壊れるので、止めずに改行を1つ足して次の行に入れる。足すのは本人が文字を打ったときだけ（開いただけではファイルを変えない）。
function typesAfterFrontmatterOnly(startDoc, changes) {
  const end = frontmatterEnd(startDoc)
  if (end === null || end !== startDoc.length) return false
  let only = true
  let count = 0
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    count += 1
    if (fromA !== end || toA !== end || inserted.length === 0 || inserted.sliceString(0, 1) === '\n') only = false
  })
  return only && count === 1
}

// 編集の表示で、ノートの情報の欄を壊す変更を止める。欄の部品の何もない所を押したあとや、本文の先頭で Backspace を押したとき、
// 矢印キーで欄の文字の中へ入ってから打ったときなど、どのキーやコマンドから来ても同じ決まりで止める（何もしない）。
// 欄だけのノートで閉じの --- のすぐあとに打った文字は、止めずに改行を1つ足して次の行に入れる。
const frontmatterFilter = EditorState.transactionFilter.of((tr) => {
  if (!breaksFrontmatter(tr)) return tr
  if (typesAfterFrontmatterOnly(tr.startState.doc, tr.changes)) {
    const end = frontmatterEnd(tr.startState.doc)
    return [tr, { changes: { from: end, insert: '\n' }, sequential: true }]
  }
  return []
})

// 日本語の変換が始まってから終わるまでの変更を覚えておく。変換が終わったときに、その変更が欄を壊していたら取り消すため（frontmatterRepair）。
// 値：null か { start（変換が始まる前の状態）, changes（それからの変更をまとめたもの。まだなければ null）}。欄のないノートでは覚えない。
// 覚えるのは、欄を守る表示（編集の表示の編集できるノート。guardsFrontmatter）の間だけ。ソースの表示や読み取り専用では覚えず、
// 変換中に編集の表示からソースの表示へ切り替えたら忘れる（ソースの表示で確定した文字は取り消さない）。ソースの表示から編集の表示へ
// 切り替えたときは、切り替えたあとの変換の変更から覚える。
// 覚えるのは変換の変更（input.type.compose）だけ。変換中の印が付いている間でも、それ以外の変更（チェックボックスの切り替え、
// 表のマスや欄の書き戻し、外からの変更の取り込みなど）が入ったら、それまでの記録を忘れる。その時点までの変換は取り消さない
// （変換と関係のない変更まで、まとめて取り消さないため）。そのあとの変換の変更は、その時点から新しく覚える。
// 変換が終わった（setComposing(false)）、取り消したときも忘れる。
const repairMark = Annotation.define()
const composeRecord = StateField.define({
  create: () => null,
  update(value, tr) {
    if (tr.annotation(repairMark)) return null
    if (!guardsFrontmatter(tr.state)) return null
    for (const effect of tr.effects) {
      if (!effect.is(setComposing)) continue
      if (effect.value !== true) return null
      if (!value && frontmatterEnd(tr.state.doc) !== null) return { start: tr.state, changes: null }
    }
    if (!tr.docChanged) return value
    if (!tr.isUserEvent('input.type.compose')) return null
    if (!value) return frontmatterEnd(tr.startState.doc) === null || !guardsFrontmatter(tr.startState) ? null : { start: tr.startState, changes: tr.changes }
    return { start: value.start, changes: value.changes ? value.changes.compose(tr.changes) : tr.changes }
  },
})

// 日本語の変換が終わったときに、変換で入った変更がノートの情報の欄を壊していたら、その変更を取り消す変更（なければ null）。
// main.mjs の compositionend（と変換中に本文からフォーカスが外れたとき）で、setComposing(false) と同じ変更として使う。
// 取り消すのは、欄を守る表示（編集の表示の編集できるノート）で覚えた変換だけ。ソースの表示では何もしない（composeRecord も覚えない）。
// - 欄だけのノートで閉じの --- のすぐあとに打ったときは、取り消さずに改行を1つ足して次の行に入れる（ふつうの入力と同じ）。
// - それ以外は、変換で入った変更を取り消して、カーソルを本文の最初の行（開いたときと同じ位置）に置く。
// 取り消しの履歴には残さない。Cmd+Z で壊れた文字が戻らないように（履歴の変換の分は、この取り消しで消えた所に当たるので何も戻さない）。
export function frontmatterRepair(state) {
  if (!guardsFrontmatter(state)) return null
  const record = state.field(composeRecord, false)
  if (!record?.changes) return null
  const startDoc = record.start.doc
  if (!frontmatterDamage(startDoc, record.changes, state.doc)) return null
  const end = frontmatterEnd(startDoc)
  const annotations = [Transaction.addToHistory.of(false), repairMark.of(true)]
  if (typesAfterFrontmatterOnly(startDoc, record.changes)) return { changes: { from: end, insert: '\n' }, annotations }
  const anchor = end < startDoc.length ? typingStart(record.start, end + 1) : end
  return { changes: record.changes.invert(startDoc), selection: { anchor }, annotations }
}

// 欄を守る決まり（止める決まりと、変換中の変更を覚えておく欄）。main.mjs のエディターに入れる。
export const frontmatterGuard = [frontmatterFilter, composeRecord]
