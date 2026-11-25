import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { deleteMarkupBackward } from '@codemirror/lang-markdown'

import { noteMarkdown } from '../src/markdown-ext.mjs'
import { breaksFrontmatter, editableExtensions, endQuietAfterClick, focusEndsQuiet, frontmatterEnd, frontmatterGuard, partCursor, partKind, pasteOpensNote, pastePlace, pressedPart, propsBlankAt, refocusesBody } from '../src/modes.mjs'
import { cursorQuiet, hiddenRanges, keyEndsQuiet, noteContext, previewField, quietAfter, setComposing, setCursorQuiet, setMode, togglePropsPanel, typingStart } from '../src/preview.mjs'
import { WikiLinkWidget } from '../src/widgets.mjs'

// 閲覧の表示をなくした（2026-11-25）。画面に、閲覧へ切り替えるボタンやキーの案内が戻っていないことを確かめる。
test('表示の切り替えのボタンは「編集」と「ソース」の2つだけ', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const group = html.match(/<div id="modes"[\s\S]*?<\/div>/)
  assert.ok(group, 'modes の欄がある')
  const modes = [...group[0].matchAll(/data-mode="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]])
  assert.deepEqual(modes, [['live', '編集'], ['source', 'ソース']])
  assert.equal(html.includes('閲覧'), false)
  // Cmd+E は「本文へ移る」キーとしてだけ案内する（閲覧へ切り替えるキーではない）。
  const cmdE = [...html.matchAll(/Cmd\+E(?!nter)[^"<]*/g)].map((m) => m[0])
  assert.ok(cmdE.length > 0)
  for (const hint of cmdE) assert.match(hint, /^Cmd\+E で本文へ移/)
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

// 開いた直後の印（quiet）。main.mjs の openNote と同じく、本文の最初の行の頭から typingStart で最初のカーソルを決める。
const FRONT = /^---\n[\s\S]*?\n---(?:\n|$)/
function opened(doc, { editable = true } = {}) {
  const front = doc.match(FRONT)
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(front ? Math.min(front[0].length, doc.length) : 0),
    extensions: [noteMarkdown(), noteContext.of({ path: 'a/b.md', known: new Set(['b.md']), editable }), previewField, editableExtensions(editable)],
  })
  state = state.update({ selection: { anchor: typingStart(state, state.selection.main.head) } }).state
  return state.update({ effects: setCursorQuiet.of(true) }).state
}
// 開いてすぐ text を打ったときの本文（カーソルの位置に入る）。
function typeNow(state, text, userEvent = 'input.type') {
  const at = state.selection.main.head
  return state.update({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent }).state
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
  // 開いてすぐ文字を打った（記号のあとのカーソルの位置に入り、記号が見える）。
  const typed = typeNow(opened(text), 'a')
  assert.equal(typed.doc.toString(), '# a見出し\n\n本文')
  assert.equal(cursorQuiet(typed), false)
  // 同じ位置への選択でも、選択を変える変更なら外れる。
  assert.equal(cursorQuiet(opened(text).update({ selection: { anchor: 2 } }).state), false)
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
  state = typeNow(state, '亜', 'input.type.compose')
  assert.equal(cursorQuiet(state), false)
  state = state.update({ effects: setComposing.of(false) }).state
  assert.equal(state.doc.toString(), '# 亜見出し\n\n本文')
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

test('開いたときの最初のカーソルは、本文の最初の行の、隠れた行頭の記号のすぐあと', () => {
  const head = (doc) => opened(doc).selection.main.head
  const cases = [
    ['# 見出し\n本文', 2],
    ['### 小見出し', 4],
    ['- 箇条書き', 2],
    ['* 箇条書き', 2],
    ['- [ ] やること', 6],
    ['- [x] 済んだこと', 6],
    ['> 引用', 2],
    ['1. 番号', 3],
    ['12) 番号', 4],
    ['> - [ ] 引用の中のやること', 8],
    ['  - 字下げした箇条書き', 4],
    // 記号でないものの前では止まる。先頭の [[ ]] のリンクの中には入れない。
    ['[[b]] で始まる行', 0],
    ['- [[b]] の箇条書き', 2],
    ['**太字**で始まる行', 0],
    ['ふつうの段落', 0],
    ['#タグ で始まる行', 0],
    ['', 0],
  ]
  for (const [doc, pos] of cases) assert.equal(head(doc), pos, JSON.stringify(doc))
  // frontmatter があれば、その次の本文の行で決める。
  const fm = '---\ntitle: a\n---\n# 見出し\n本文'
  assert.equal(head(fm), fm.indexOf('# ') + 2)
  // 本文の最初の行が空なら、その空の行のまま（記号はない）。
  const blank = '---\ntitle: a\n---\n\n# 見出し'
  assert.equal(head(blank), blank.indexOf('\n\n') + 1)
  // frontmatter だけのノートは、frontmatter の終わりのまま（frontmatter の中に戻さない）。
  const only = '---\ntitle: a\n---'
  assert.equal(head(only), only.length)
  // コールアウトは1行目が部品なので、中身の行の「> 」のあと。
  const callout = '> [!note]\n> 中身'
  assert.equal(head(callout), callout.indexOf('中身'))
  // 行の途中の位置は動かさない。
  const state = opened('# 見出し')
  assert.equal(typingStart(state, 1), 1)
})

test('開いてすぐ打った文字は、隠れた記号のあと（見た目どおりの位置）に入る', () => {
  const after = (doc, text = 'x') => typeNow(opened(doc), text).doc.toString()
  assert.equal(after('# 見出し'), '# x見出し')
  assert.equal(after('- 箇条書き'), '- x箇条書き')
  assert.equal(after('- [ ] やること'), '- [ ] xやること')
  assert.equal(after('> 引用'), '> x引用')
  assert.equal(after('1. 番号'), '1. x番号')
  assert.equal(after('---\ntitle: a\n---\n# 見出し', '亜'), '---\ntitle: a\n---\n# 亜見出し')
  assert.equal(after('[[b]] で始まる行'), 'x[[b]] で始まる行')
  // 開いた直後は、カーソルの行でも記号を隠したまま（先頭の [[b]] はリンクの部品のまま）。
  assert.deepEqual(hiddenRanges(opened('# 見出し')), ['# '])
  assert.deepEqual(wikiWidgets(opened('[[b]] で始まる行')), ['[[b]]'])
})

test('クリックのあとで印を外す処理は、その間に別のノートを開いていたら、新しいノートの印を外さない', () => {
  // 使い回す view の代わり。dispatch で state を入れ替える。
  const fakeView = (state) => ({ state, dispatch(spec) { this.state = this.state.update(spec).state } })
  let round = 1
  const pending = []
  const later = (fn) => pending.push(fn)
  // 同じノートのまま：外れる。
  const same = fakeView(opened('# 見出し'))
  endQuietAfterClick(same, () => round, later)
  pending.shift()()
  assert.equal(cursorQuiet(same.state), false)
  // 外す前に別のノートを開いた（setState で中身が入れ替わり、開いた回が変わった）：新しいノートの印は残る。
  const reused = fakeView(opened('# A'))
  endQuietAfterClick(reused, () => round, later)
  reused.state = opened('# B')
  round += 1
  pending.shift()()
  assert.equal(cursorQuiet(reused.state), true)
  assert.deepEqual(hiddenRanges(reused.state), ['# '])
})

test('本文にフォーカスが入ったときは、マウスで押している最中でなければ、開いた直後の印を外す', () => {
  // Tab で入ったとき、新しく作ったノートでフォーカスを入れたとき、「編集」「ソース」のボタンのあと：外す。
  assert.equal(focusEndsQuiet({ quiet: true, pressing: false }), true)
  // エディターを押した最中のフォーカス：押した位置が決まってから外すので、ここでは外さない。
  assert.equal(focusEndsQuiet({ quiet: true, pressing: true }), false)
  // 印がもうないとき：何もしない。
  assert.equal(focusEndsQuiet({ quiet: false, pressing: false }), false)
  assert.equal(focusEndsQuiet(), false)
})

test('「編集」「ソース」のボタンは、本文をクリックしたあとにマウスで押したときだけ本文にフォーカスを戻す', () => {
  assert.equal(refocusesBody({ detail: 1 }), true)
  assert.equal(refocusesBody({ detail: 2 }), true)
  // Enter・Space で押した click は detail が 0。
  assert.equal(refocusesBody({ detail: 0 }), false)
  assert.equal(refocusesBody(undefined), false)
  // 開いてからまだ本文をクリックしていない（印が残っている）ときは、マウスで押しても戻さない。
  assert.equal(refocusesBody({ detail: 1 }, { quiet: true }), false)
  assert.equal(refocusesBody({ detail: 1 }, { quiet: false }), true)
})

// 既にあるノートは、開いても本文にフォーカスを入れない（2026-11-25）。開いた直後のキーが本文に届くと、
// 隠れた記号の前後で打った文字が見た目と違う所に入る（見出しで Backspace を押すと # のあとの空白が消えてタグになる、など）。
// 新しく作ったノートだけ、すぐ打てるようにフォーカスを入れる。画面の処理（main.mjs）の書き方で確かめる。
test('ノートを開いたときに本文にフォーカスを入れるのは、新しく作ったノートだけ', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const body = main.slice(main.indexOf('async function openNote('), main.indexOf('function pushNoteUrl('))
  // 決まりがないときは入れない。
  assert.match(body, /startMode = 'live', focus = false \} = \{\}\) \{/)
  // 入れるのは focus のときだけ。前のノートから残ったフォーカスは外す。
  assert.match(body, /if \(focus\) view\.focus\(\)\n\s*else if \(\$\('editor'\)\.contains\(document\.activeElement\)\) document\.activeElement\.blur\(\)/)
  assert.equal((body.match(/view\.focus\(\)/g) ?? []).length, 1)
  // まだないノートを作ってから開くとき。
  assert.match(body, /return openNote\(path, \{ push, anchor, startMode: 'live', focus: true \}\)/)
  // 日付のノート（今作ったときだけ）、「新しいノート」（409 の既にあるノートは除く）、「新しいタスク」。
  assert.match(main, /path, \{ focus: created === true \}\)/)
  assert.match(main, /path, \{ focus: created\.ok \}\)/)
  assert.match(main, /created\.data\.path, \{ focus: true \}\)/)
  // 右の枠へは、左から届いた focus が true のときだけ。
  assert.match(main, /focus: data\.focus === true/)
  assert.match(main, /split\.post\(\{ type: MSG\.OPEN, path, anchor, startMode, focus \}\)/)
})

// 部品のクリック（2026-11-25 再レビューの指摘1）。開いた直後にコールアウトの題名などの部品を押すと、本文にフォーカスは入るのにカーソルが1行目のまま残り、
// Backspace で見出しの # のあとの空白が消えていた。
const fakeEl = (found) => ({ closest: (sel) => found[sel] ?? null })
test('押した所が本文の中の部品かを見分ける。編集できないノートの本文そのものは部品に数えない', () => {
  const part = { name: 'part' }
  const content = { contains: (el) => el === part || el === content }
  assert.equal(pressedPart(fakeEl({ '[contenteditable="false"]': part }), content), part)
  // 部品の外（ふつうの文字）。
  assert.equal(pressedPart(fakeEl({}), content), null)
  // 編集できないノートでは本文そのもの（content）が contenteditable="false"。
  assert.equal(pressedPart(fakeEl({ '[contenteditable="false"]': content }), content), null)
  // 本文の外の部品（ほかのエディターなど）。
  assert.equal(pressedPart(fakeEl({ '[contenteditable="false"]': { name: 'other' } }), content), null)
  assert.equal(pressedPart(null, content), null)
  // 文字のノード（closest がない）は、その親で調べる。
  assert.equal(pressedPart({ parentElement: fakeEl({ '[contenteditable="false"]': part }) }, content), part)
})

test('部品の種類：ノートの情報の欄、表、それ以外', () => {
  assert.equal(partKind(fakeEl({ '.cm-props, .cm-frontmatter': {} })), 'props')
  assert.equal(partKind(fakeEl({ '.cm-table-wrap': {} })), 'table')
  assert.equal(partKind(fakeEl({})), 'other')
})

test('部品を押して本文に入ったときのカーソルの位置は、押した部品の所', () => {
  const doc = '# 見出し\n本文\n\n> [!note]\n> 中身\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- 項目\n画像 ![](a.png) のあと'
  const state = opened(doc)
  // コールアウトの題名（行の頭から始まる部品）：すぐ下の中身の行の「> 」のあと。1行目には残さない。
  assert.equal(partCursor(state, { pos: doc.indexOf('> [!note]'), kind: 'other' }), doc.indexOf('中身'))
  // 表：表のすぐ後ろ（次の行の頭）。表の中に置くと、表が文字のまま見えてしまう。
  const table = '| a | b |\n|---|---|\n| 1 | 2 |'
  assert.equal(partCursor(state, { pos: doc.indexOf(table), kind: 'table', length: table.length }), doc.indexOf(table) + table.length + 1)
  // 箇条書きの記号（行の頭）：記号のあと。
  assert.equal(partCursor(state, { pos: doc.indexOf('- 項目'), kind: 'other' }), doc.indexOf('項目'))
  // 行の途中の部品（画像など）：部品の前。
  assert.equal(partCursor(state, { pos: doc.indexOf('!['), kind: 'other' }), doc.indexOf('!['))
  // ノートの情報の欄：本文の最初の行（閉じの --- の次の行）で、開いたときと同じ位置（typingStart）。閉じの --- の行やその前には置かない。
  const front = '---\ntitle: a\n---\n'
  assert.equal(partCursor(opened(front + '# 見出し\n本文'), { pos: 0, kind: 'props' }), front.length + 2)
  assert.equal(partCursor(opened(front + 'T\n'), { pos: 0, kind: 'props' }), front.length)
  assert.equal(partCursor(opened(front), { pos: 0, kind: 'props' }), front.length)
  // 欄のあとに行がない（閉じの --- で終わる）ノートでは動かさない。
  assert.equal(partCursor(opened('---\ntitle: a\n---'), { pos: 0, kind: 'props' }), null)
  // 最後の表：ノートの終わりより後ろには置かない。
  const last = opened('本文\n\n| a |\n|---|')
  assert.equal(partCursor(last.state ?? last, { pos: 4, kind: 'table', length: 11 }), last.doc.length)
})

test('部品を押したあと：本文にフォーカスが入ったらカーソルを部品の所へ動かして印を外し、入らなかったら印を残す', () => {
  const fakeView = (state) => ({ state, dispatch(spec) { this.state = this.state.update(spec).state } })
  const doc = '# 見出し\n本文\n\n> [!note]\n> 中身'
  const run = (focus, prepare) => {
    const view = fakeView(opened(doc))
    prepare?.(view)
    const pending = []
    endQuietAfterClick(view, () => 1, (fn) => pending.push(fn), { focus: () => focus, cursor: (s, f) => (f === 'body' ? partCursor(s, { pos: doc.indexOf('> [!note]'), kind: 'other' }) : null) })
    pending.shift()()
    return view.state
  }
  // 本文にフォーカスが入った（コールアウトの題名を押した）：中身の行へ動き、印が外れる。
  const body = run('body')
  assert.equal(cursorQuiet(body), false)
  assert.equal(body.selection.main.head, doc.indexOf('中身'))
  assert.deepEqual(hiddenRanges(body).includes('# '), true, '1行目の見出しの記号は、カーソルが離れたので隠れたまま')
  // 本文の中の入力の場所にフォーカスが入った：印は外す。カーソルを動かすかは cursor が決める（ここでは動かさない）。
  const inside = run('inside')
  assert.equal(cursorQuiet(inside), false)
  assert.equal(inside.selection.main.head, 2)
  // 表のマスに入ったとき：表のすぐ後ろへ動かす（Escape でマスの編集を終えて本文に戻ったときに、1行目に残さない）。
  const tdoc = '# 見出し\n\n| a |\n|---|\n\n本文'
  const table = '| a |\n|---|'
  const tview = fakeView(opened(tdoc))
  const tpending = []
  endQuietAfterClick(tview, () => 1, (fn) => tpending.push(fn), { focus: () => 'inside', cursor: (s) => partCursor(s, { pos: tdoc.indexOf(table), kind: 'table', length: table.length }) })
  tpending.shift()()
  assert.equal(cursorQuiet(tview.state), false)
  assert.equal(tview.state.selection.main.head, tdoc.indexOf(table) + table.length + 1)
  // 本文にフォーカスが入らなかった（チェックボックス、子を開閉した箇条書きの記号）：印を残す。
  const none = run(null)
  assert.equal(cursorQuiet(none), true)
  assert.equal(none.selection.main.head, 2)
  // エディターが押した位置にカーソルを動かしていた（画像、数式など）：その位置のまま（印は動かしたときに外れている）。
  const moved = run('body', (view) => view.dispatch({ selection: { anchor: doc.indexOf('本文') } }))
  assert.equal(moved.selection.main.head, doc.indexOf('本文'))
  assert.equal(cursorQuiet(moved), false)
})

test('本文にフォーカスが入ったら印を外す処理は、押している最中でも、押した位置が決まったあとに必ず外す', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const enders = main.slice(main.indexOf('const quietEnders = EditorView.domEventObservers({'), main.indexOf('let pressingEditor = false'))
  const press = enders.slice(enders.indexOf("document.addEventListener(\n  'mousedown',"))
  assert.ok(press.length > 0, 'エディターが受け取らない部品の mousedown も受けるよう、document で受ける')
  // 表のマスなどに入ったときにも届くよう、focusin で受ける。
  assert.match(enders, /focusin\(event, target\) \{/)
  assert.match(enders, /else endQuietAfterClick\(target, \(\) => openRound\)/)
  // 部品を押したときも、早く戻らずに endQuietAfterClick に部品を渡す。
  assert.match(press, /const part = pressedPart\(event\.target, target\.contentDOM\)/)
  assert.match(press, /endQuietAfterClick\(target, \(\) => openRound, setTimeout, \{/)
  // 本文の中の入力の場所に入ったときにカーソルを動かすのは、表のときだけ。
  assert.match(press, /if \(focus !== 'body' && kind !== 'table'\) return null/)
  assert.equal(enders.includes("closest?.('[contenteditable=\"false\"]')) return"), false)
})

// キーボードだけで本文に入る（再レビューの指摘2）。Cmd+E（Windows は Ctrl+E）。
test('Cmd+E で本文へ移る：編集できるノートで本文の外にいるときだけ。右の枠が操作中なら右の本文へ', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const enter = main.slice(main.indexOf('function enterBody() {'), main.indexOf('function bindChrome() {'))
  assert.match(enter, /if \(!currentPath \|\| !view \|\| !editable\) return/)
  assert.match(enter, /if \(view\.contentDOM\.contains\(document\.activeElement\)\) return/)
  // 選択は変えない（開いた直後なら開いたときの位置＝typingStart、前に本文でカーソルを置いていればそこ）。
  assert.equal(/selection:/.test(enter), false)
  assert.match(enter, /view\.focus\(\)/)
  assert.match(main, /if \(isBodyKey\(event\) && !document\.querySelector\('dialog\[open\]'\)\) \{/)
  assert.match(main, /if \(PANE !== 'right' && rightActive\(\) && split\?\.isOpen\(\)\) split\.post\(\{ type: MSG\.FOCUS \}\)/)
  assert.match(main, /data\.type === MSG\.FOCUS\) \{\n\s*enterBody\(\)/)
})

// 右の枠でも Cmd+V でノートを開く（再レビューの指摘3）。本文の中の部品を押したときは案内を出さない（指摘5）。
test('Cmd+V でノートを開く処理は左右どちらの枠でも使い、部品を押したときは案内を出さない', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const chrome = main.slice(main.indexOf('function bindChrome() {'), main.indexOf("$('history-close')"))
  assert.match(chrome, /bindPasteOpen\(\)\n\s*if \(PANE !== 'right'\) bindLeftChrome\(\)/)
  const left = main.slice(main.indexOf('function bindLeftChrome() {'), main.indexOf('function bindLeftChrome() {') + 400)
  assert.equal(left.includes("addEventListener('paste'"), false)
  const paste = main.slice(main.indexOf('function bindPasteOpen() {'), main.indexOf('function bindLeftChrome() {'))
  assert.match(paste, /document\.addEventListener\('paste', openFromPaste\)/)
  assert.match(paste, /pressedPart\(event\.target, content\)/)
  assert.match(paste, /&& !onPart/)
  // 右の枠で案内を隠さない。
  const css = fs.readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
  assert.equal(/body\[data-pane='right'\] #paste-hint/.test(css), false)
})

// ノートの情報の欄（frontmatter）を、編集の表示のキーで壊さない（欄の何もない所を押してから Backspace で「---T」になった不具合）。
const TASK = '---\ntitle: "試しの課題"\nstatus: 未着手\nstart:\ndue:\n---\nT\n'
function guarded(doc, anchor, mode = 'live') {
  const state = EditorState.create({ doc, selection: { anchor }, extensions: [noteMarkdown(), noteContext.of({ path: 'a.md', known: new Set() }), previewField, frontmatterGuard] })
  return mode === 'live' ? state : state.update({ effects: setMode.of(mode) }).state
}
// キーで本文を書き換えたときの本文（エディターのコマンドと同じ変更）。
const del = (state, from, to, userEvent = 'delete.backward') => state.update({ changes: { from, to }, userEvent }).state.doc.toString()
const ins = (state, at, insert, userEvent = 'input.type') => state.update({ changes: { from: at, insert }, userEvent }).state.doc.toString()

test('frontmatterEnd：先頭の --- で始まり --- の行で閉じる部分の終わり（Markdown の読み方と同じ）', () => {
  const doc = (text) => EditorState.create({ doc: text }).doc
  assert.equal(frontmatterEnd(doc(TASK)), TASK.indexOf('---\nT') + 3)
  assert.equal(frontmatterEnd(doc('---\n---')), 7)
  assert.equal(frontmatterEnd(doc('--- \na: 1\n---  \n本文')), '--- \na: 1\n---  '.length)
  assert.equal(frontmatterEnd(doc('---\na: 1\n本文')), null)
  assert.equal(frontmatterEnd(doc('x\n---\na\n---')), null)
  assert.equal(frontmatterEnd(doc('---')), null)
})

test('編集の表示：本文の先頭で Backspace を押しても、閉じの --- と本文の行がつながらない（何もしない）', () => {
  const end = TASK.indexOf('---\nT') + 3
  const state = guarded(TASK, end + 1)
  // Backspace・Cmd+Backspace・Option+Backspace・Ctrl+H は、どれも閉じの --- のあとの改行を消す変更になる。
  for (const userEvent of ['delete.backward', 'delete.group.backward', 'delete.line', 'delete']) assert.equal(del(state, end, end + 1, userEvent), TASK, userEvent)
  // エディターの Backspace のコマンド（Markdown の記号を消すもの）でも同じ。
  let doc = state.doc.toString()
  deleteMarkupBackward({ state, dispatch: (tr) => (doc = tr.state.doc.toString()) })
  assert.equal(doc, TASK)
  // x・Delete・Enter は本文の中で効く（欄は壊れない）。
  assert.equal(ins(state, end + 1, 'x'), TASK.replace('\nT', '\nxT'))
  assert.equal(del(state, end + 1, end + 2, 'delete.forward'), TASK.replace('\nT\n', '\n\n'))
  assert.equal(ins(state, end + 1, '\n', 'input'), TASK.replace('\nT', '\n\nT'))
  // 本文の最初の行が空でも、閉じの --- のあとの改行は消さない（カーソルが閉じの --- のあとに来て、打っても止まるだけになるため）。
  const empty = TASK.replace('T\n', '')
  assert.equal(del(guarded(empty, empty.length), empty.length - 1, empty.length), empty)
})

test('編集の表示：矢印キーで欄の文字の中へ入っても、閉じの --- と開きの --- は壊れない', () => {
  const end = TASK.indexOf('---\nT') + 3
  // 左の矢印で閉じの --- のあと：Delete、文字、Backspace、貼り付けは止める。Enter（改行）はよい。
  const atEnd = guarded(TASK, end)
  assert.equal(del(atEnd, end, end + 1, 'delete.forward'), TASK)
  assert.equal(ins(atEnd, end, 'x'), TASK)
  assert.equal(ins(atEnd, end, 'はりつけ', 'input.paste'), TASK)
  assert.equal(del(atEnd, end - 1, end), TASK)
  assert.equal(ins(atEnd, end, '\n', 'input'), TASK.replace('---\nT', '---\n\nT'))
  // 上の矢印で開きの --- の前：文字、Delete、Enter は止める。
  const atTop = guarded(TASK, 0)
  assert.equal(ins(atTop, 0, 'x'), TASK)
  assert.equal(del(atTop, 0, 1, 'delete.forward'), TASK)
  assert.equal(ins(atTop, 0, '\n', 'input'), TASK)
  // ツールバーのボタンなど、userEvent のない変更でも止める。
  assert.equal(atTop.update({ changes: { from: 0, insert: '# ' } }).state.doc.toString(), TASK)
  // 欄を文字で編集しているとき：値の書き換え、行の追加と削除はできる。
  const at = TASK.indexOf('未着手')
  assert.equal(ins(atTop, at, '★'), TASK.replace('未着手', '★未着手'))
  assert.equal(ins(atTop, TASK.indexOf('due:') + 4, '\nmemo: x', 'input'), TASK.replace('due:', 'due:\nmemo: x'))
  assert.equal(del(atTop, TASK.indexOf('start:'), TASK.indexOf('due:')), TASK.replace('start:\n', ''))
})

test('欄を壊す変更を止めるのは編集の表示だけ。ソースの表示、取り消し、外からの変更、欄ごとの書き換えは止めない', () => {
  const end = TASK.indexOf('---\nT') + 3
  // ソースの表示では、今までどおり自由に書き換えられる。
  assert.equal(del(guarded(TASK, end + 1, 'source'), end, end + 1), TASK.replace('---\nT', '---T'))
  const state = guarded(TASK, end + 1)
  // 取り消し・やり直し、履歴に残さない変更（外からの変更の取り込み）。
  for (const spec of [{ userEvent: 'undo' }, { userEvent: 'redo' }, { annotations: Transaction.addToHistory.of(false) }]) {
    assert.equal(state.update({ changes: { from: end, to: end + 1 }, ...spec }).state.doc.toString(), TASK.replace('---\nT', '---T'))
  }
  // すべて選択して消す・打ち換える。欄の部品からの書き換え（欄をまるごと正しい欄に置き換える）。
  assert.equal(del(state, 0, TASK.length), '')
  assert.equal(state.update({ changes: { from: 0, to: TASK.length, insert: 'x' }, userEvent: 'input.type' }).state.doc.toString(), 'x')
  const next = TASK.slice(0, end).replace('未着手', '進行中')
  assert.equal(state.update({ changes: { from: 0, to: end, insert: next } }).state.doc.toString(), TASK.replace('未着手', '進行中'))
  // 欄だけ・欄と本文の先頭を選んで打ち換える・消す（Shift+上の矢印で本文の先頭から選んだときなど）は止める。
  assert.equal(state.update({ changes: { from: 0, to: end + 1, insert: 'x' }, userEvent: 'input.type' }).state.doc.toString(), TASK)
  assert.equal(del(state, 0, end + 1), TASK)
  assert.equal(del(state, 0, end), TASK)
  // 項目を足した欄に置き換える（Cmd+; と同じ変更）。
  const added = TASK.slice(0, end).replace('due:', 'due:\nmemo:')
  assert.equal(state.update({ changes: { from: 0, to: end, insert: added } }).state.doc.toString(), TASK.replace('due:', 'due:\nmemo:'))
  // 欄のないノートは何もしない。
  assert.equal(del(guarded('# a\nb', 4), 3, 4), '# ab')
  assert.equal(breaksFrontmatter(state.update({ selection: { anchor: 0 } })), false)
})

test('ノートの情報の欄の何もない所：入力欄・選ぶ欄・ボタン・リンクは数えない', () => {
  const at = (inside, hit = '') => ({ closest: (sel) => (sel === '.cm-props' ? (inside ? {} : null) : sel.split(', ').some((s) => s === hit) ? {} : null) })
  assert.equal(propsBlankAt(at(true)), true)
  for (const hit of ['input', 'select', 'textarea', 'button', 'a']) assert.equal(propsBlankAt(at(true, hit)), false, hit)
  assert.equal(propsBlankAt(at(false)), false)
  assert.equal(propsBlankAt({ parentElement: at(true) }), true)
  assert.equal(propsBlankAt(null), false)
})

test('エディターに欄を守る決まりを入れ、欄の何もない所を押したら印があってもなくても本文の最初の行へ', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  assert.match(main, /previewField,\n\s*frontmatterGuard,/)
  const down = main.slice(main.indexOf("document.addEventListener(\n  'mousedown',"), main.indexOf('let pressingEditor'))
  assert.match(down, /if \(event\.button !== 0 \|\| !view \|\| !view\.contentDOM\.contains\(event\.target\)\) return/)
  assert.ok(down.indexOf("partKind(part) === 'props' && propsBlankAt(event.target)") < down.indexOf('if (!cursorQuiet(target.state)) return'))
})
