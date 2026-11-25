import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { noteMarkdown } from '../src/markdown-ext.mjs'
import { editableExtensions, pasteOpensNote, pastePlace } from '../src/modes.mjs'
import { cursorQuiet, hiddenRanges, keyEndsQuiet, noteContext, previewField, quietAfter, setComposing, setCursorQuiet, setMode, togglePropsPanel } from '../src/preview.mjs'
import { WikiLinkWidget } from '../src/widgets.mjs'

// 閲覧の表示をなくした（2026-11-25）。画面に、閲覧へ切り替えるボタンやキーの案内が戻っていないことを確かめる。
test('表示の切り替えのボタンは「編集」と「ソース」の2つだけ', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const group = html.match(/<div id="modes"[\s\S]*?<\/div>/)
  assert.ok(group, 'modes の欄がある')
  const modes = [...group[0].matchAll(/data-mode="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]])
  assert.deepEqual(modes, [['live', '編集'], ['source', 'ソース']])
  assert.equal(html.includes('閲覧'), false)
  assert.equal(/Cmd\+E(?!nter)/.test(html), false)
})

test('編集できるノートは画面も編集でき、編集できないノートは画面も読み取り専用になる', () => {
  const stateOf = (canEdit) => EditorState.create({ doc: 'x', extensions: editableExtensions(canEdit) })
  assert.equal(stateOf(true).readOnly, false)
  assert.equal(stateOf(true).facet(EditorView.editable), true)
  for (const canEdit of [false, undefined, null]) {
    assert.equal(stateOf(canEdit).readOnly, true, String(canEdit))
    assert.equal(stateOf(canEdit).facet(EditorView.editable), false, String(canEdit))
  }
})

test('Cmd+V でノートを開くか：本文や入力欄の外では開き、中ではふつうの貼り付け', () => {
  const note = { hasNote: true, editable: true }
  // フォーカスが本文や入力欄の外（ファイルの一覧、ページの何もない所など）にあるとき。
  assert.equal(pasteOpensNote({ ...note }), true)
  assert.equal(pasteOpensNote({ ...note, editable: false }), true)
  assert.equal(pasteOpensNote({ hasNote: false }), true)
  // 編集できるノートの本文の中では、ふつうの貼り付け。
  assert.equal(pasteOpensNote({ ...note, inText: true }), false)
  // 編集できないノートの本文や、ノートを開いていないときは、貼る場所がないので開く。
  assert.equal(pasteOpensNote({ ...note, editable: false, inText: true }), true)
  assert.equal(pasteOpensNote({ hasNote: false, inText: true }), true)
  // 入力欄・表のマス・ノートの情報の欄の中は、どのノートでもふつうの貼り付け（本文の中にある欄も含む）。
  for (const base of [note, { ...note, editable: false }, { hasNote: false }]) {
    assert.equal(pasteOpensNote({ ...base, inField: true }), false)
    assert.equal(pasteOpensNote({ ...base, inField: true, inText: true }), false)
  }
})

test('貼り付けた先がどこか（入力欄か、本文か）を調べる', () => {
  // closest だけを持つ、画面の部品の代わり。matches に当てはまる祖先があれば返す。
  const el = (...inside) => ({ closest: (selector) => (selector.split(',').some((s) => inside.includes(s.trim())) ? {} : null) })
  assert.deepEqual(pastePlace(el()), { inField: false, inText: false })
  assert.deepEqual(pastePlace(el('.cm-content')), { inField: false, inText: true })
  for (const field of ['input', 'textarea', 'select', '.cm-cell-editing', '.cm-props']) {
    assert.deepEqual(pastePlace(el(field)), { inField: true, inText: false }, field)
  }
  assert.deepEqual(pastePlace(el('.cm-props', '.cm-content')), { inField: true, inText: true })
  // 文字の部品（Text）のときは、親の要素で調べる。何もないときは外。
  assert.deepEqual(pastePlace({ parentElement: el('.cm-content') }), { inField: false, inText: true })
  assert.deepEqual(pastePlace(null), { inField: false, inText: false })
})

// 開いた直後の印（quiet）。
function opened(doc, cursor = 0, { editable = true } = {}) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [noteMarkdown(), noteContext.of({ path: 'a/b.md', known: new Set(['b.md']), editable }), previewField, editableExtensions(editable)],
  })
  return state.update({ effects: setCursorQuiet.of(true) }).state
}
const wikiWidgets = (state) => {
  const found = []
  state.field(previewField).deco.between(0, state.doc.length, (from, to, deco) => {
    if (deco.spec.widget instanceof WikiLinkWidget) found.push(state.doc.sliceString(from, to))
  })
  return found
}

test('開いた直後は、カーソルが先頭にあっても記号を出さない（見出し・太字・先頭の [[ ]]）', () => {
  // 印がなければ、カーソルの行の記号が見える（ふつうの編集の動き）。
  const plain = EditorState.create({ doc: '# 見出し\n\n本文', extensions: [noteMarkdown(), noteContext.of({ path: 'a/b.md', known: new Set() }), previewField] })
  assert.equal(cursorQuiet(plain), false)
  assert.deepEqual(hiddenRanges(plain), [])
  // 印があれば、見出しの # も、太字の ** も隠れる。
  assert.deepEqual(hiddenRanges(opened('# 見出し\n\n本文')), ['# '])
  assert.deepEqual(hiddenRanges(opened('**太字**で始まる行')), ['**', '**'])
  // 先頭の [[b]] はリンクの部品になる（押せば開く）。
  assert.deepEqual(wikiWidgets(opened('[[b]] で始まる行')), ['[[b]]'])
  assert.equal(cursorQuiet(opened('x')), true)
})

test('印は、選択が変わる変更（クリック・文字の入力・タスク機能など）で外れる', () => {
  const text = '# 見出し\n\n本文'
  // クリックや矢印キーでカーソルが動いた。
  const moved = opened(text).update({ selection: { anchor: 1 } }).state
  assert.equal(cursorQuiet(moved), false)
  assert.deepEqual(hiddenRanges(moved), [])
  // 開いてすぐ文字を打った（カーソルの位置に入り、記号が見える）。
  const typed = opened(text).update({ changes: { from: 0, insert: 'a' }, selection: { anchor: 1 }, userEvent: 'input.type' }).state
  assert.equal(typed.doc.toString(), 'a# 見出し\n\n本文')
  assert.equal(cursorQuiet(typed), false)
  // 同じ位置への選択でも、選択を変える変更なら外れる。
  assert.equal(cursorQuiet(opened(text).update({ selection: { anchor: 0 } }).state), false)
  // 印を外す効果（同じ位置をクリックした、キーを押した）。
  const asked = opened(text).update({ effects: setCursorQuiet.of(false) }).state
  assert.equal(cursorQuiet(asked), false)
  assert.deepEqual(hiddenRanges(asked), [])
})

test('印は、選択を変えない変更では外れない（外からの書き換え、表示の切り替え、ノートの情報の開閉）', () => {
  const text = '# 見出し\n\n本文'
  let state = opened(text)
  // 外からの書き換え（ほかのアプリでの変更・一時保存の戻し）は、文字だけを変える。
  state = state.update({ changes: { from: state.doc.length, insert: '\n追記' } }).state
  assert.equal(cursorQuiet(state), true)
  assert.deepEqual(hiddenRanges(state), ['# '])
  state = state.update({ effects: [setMode.of('source')] }).state
  state = state.update({ effects: [setMode.of('live'), togglePropsPanel.of(true)] }).state
  assert.equal(cursorQuiet(state), true)
  assert.deepEqual(hiddenRanges(state), ['# '])
  // 選択を変えるときでも、印を付ける効果があれば付いたまま（効果が優先）。
  assert.equal(quietAfter(true, state.update({ selection: { anchor: 2 }, effects: setCursorQuiet.of(true) })), true)
  assert.equal(quietAfter(false, state.update({ selection: { anchor: 2 } })), false)
})

test('開いてすぐ日本語の変換で打っても、変換が終われば印は外れている', () => {
  let state = opened('# 見出し\n\n本文')
  state = state.update({ effects: setComposing.of(true) }).state
  state = state.update({ changes: { from: 0, insert: 'あ' }, selection: { anchor: 1 }, userEvent: 'input.type.compose' }).state
  assert.equal(cursorQuiet(state), false)
  state = state.update({ effects: setComposing.of(false) }).state
  assert.equal(state.doc.toString(), 'あ# 見出し\n\n本文')
  assert.deepEqual(hiddenRanges(state), [])
})

test('印を外すキー：ふつうのキーは外し、Cmd・Ctrl・Shift などだけのとき、ショートカット、変換の始まりでは外さない', () => {
  for (const key of ['a', 'Enter', 'Backspace', 'ArrowDown', 'ArrowLeft', 'Escape', 'Tab', ' ']) assert.equal(keyEndsQuiet({ key }), true, key)
  assert.equal(keyEndsQuiet({ key: 'A', shiftKey: true }), true)
  for (const key of ['Meta', 'Control', 'Shift', 'Alt', 'CapsLock']) assert.equal(keyEndsQuiet({ key }), false, key)
  assert.equal(keyEndsQuiet({ key: 'o', metaKey: true }), false)
  assert.equal(keyEndsQuiet({ key: 'v', ctrlKey: true }), false)
  assert.equal(keyEndsQuiet({ key: 'Process' }), false)
  assert.equal(keyEndsQuiet({ key: 'a', isComposing: true }), false)
  assert.equal(keyEndsQuiet({ key: 'Unidentified', keyCode: 229 }), false)
  assert.equal(keyEndsQuiet(undefined), false)
})
