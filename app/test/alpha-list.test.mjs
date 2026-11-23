import assert from 'node:assert/strict'
import { test } from 'node:test'

import { indentLess, indentMore } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'

import { alphaItemAt, alphaListEnter } from '../src/alpha-list.mjs'
import { listItemStarts } from '../src/hanging.mjs'
import { noteMarkdown } from '../src/markdown-ext.mjs'
import { buildDecorations, noteContext } from '../src/preview.mjs'

// | の位置にカーソルを置いた状態を作る。
function make(text) {
  const at = text.indexOf('|')
  const doc = at < 0 ? text : text.slice(0, at) + text.slice(at + 1)
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(at < 0 ? doc.length : at),
    extensions: [noteMarkdown(), indentUnit.of('\t'), EditorState.tabSize.of(4), noteContext.of({ path: 'a.md', known: null })],
  })
}

function run(command, text) {
  let state = make(text)
  const handled = command({ state, dispatch: (tr) => { state = tr.state } })
  const head = state.selection.main.head
  return { handled, text: state.doc.sliceString(0, head) + '|' + state.doc.sliceString(head) }
}

const isItem = (text, lineNumber) => Boolean(alphaItemAt(make(text), lineNumber))

test('行頭の「a. 」は項目として扱う（引用の中、字下げした行も）', () => {
  assert.ok(isItem('a. りんご', 1))
  assert.ok(isItem('> a. りんご', 1))
  assert.ok(isItem('- 親\n\ta. りんご', 2))
  assert.ok(isItem('  a. りんご', 1), '3文字までの字下げ')
  assert.ok(isItem('a. ', 1), '中身のない項目も')
})

test('本人の書き方：番号付きの3段目の「a. 」とその次の「b. 」', () => {
  const doc = '1. aaa\n\t1. 1111\n\t2. 222\n\t3. 333\n\t\ta. aaaa\n\t\tb. bbbb\n'
  assert.ok(isItem(doc, 5))
  assert.ok(isItem(doc, 6))
})

test('誤って項目にしないもの', () => {
  assert.ok(!isItem('Q. 質問', 1), '大文字（ひな形の「Q. 」）')
  assert.ok(!isItem('A. 答え', 1), '大文字')
  assert.ok(!isItem('文の途中の a. は対象外', 1))
  assert.ok(!isItem('a.りんご', 1), 'ピリオドの後に空白がない')
  assert.ok(!isItem('aa. りんご', 1), '2文字')
  assert.ok(!isItem('1. 番号', 1), '数字は今までどおり番号付き')
  assert.ok(!isItem('```\na. コード\n```\n', 2), 'コードの中')
  assert.ok(!isItem('本文\n\n    a. 字下げのコード\n', 3), '字下げで作ったコードの中')
  assert.ok(!isItem('---\na. b\n---\n', 2), 'ノートの先頭のプロパティの中')
})

test('分かっている限界：箇条書きの外で4文字以上字下げすると Markdown ではコードになるので、項目にしない', () => {
  assert.ok(!isItem('\ta. りんご', 1))
})

test('「a.」以外の文字は、すぐ上に項目があるときだけ項目にする（「e. g.」などを拾わない）', () => {
  assert.ok(isItem('a. x\nb. y', 2), 'a. の続き')
  assert.ok(isItem('a. x\n\t- 子\nb. y', 3), '間に深い行があってもよい')
  assert.ok(isItem('- 親\n\tb. y', 2), '項目のすぐ下の段の最初')
  assert.ok(!isItem('b. いきなり', 1))
  assert.ok(!isItem('本文の行\ne. g. のように', 2))
  assert.ok(!isItem('a. x\n\nb. y', 3), '空行のあと')
})

test('Enter で次の文字が続く', () => {
  assert.deepEqual(run(alphaListEnter, 'a. りんご|'), { handled: true, text: 'a. りんご\nb. |' })
  assert.deepEqual(run(alphaListEnter, '1. aaa\n\t3. 333\n\t\ta. aaaa|'), { handled: true, text: '1. aaa\n\t3. 333\n\t\ta. aaaa\n\t\tb. |' })
  assert.deepEqual(run(alphaListEnter, '> a. x|'), { handled: true, text: '> a. x\n> b. |' })
  assert.deepEqual(run(alphaListEnter, 'a. x\nb. y|').text, 'a. x\nb. y\nc. |')
})

test('本文の途中で Enter すると、後ろの文字は次の項目へ移る', () => {
  assert.deepEqual(run(alphaListEnter, 'a. りん|ご').text, 'a. りん\nb. |ご')
})

test('途中に入れたときは、後ろの項目の文字を振り直す', () => {
  assert.deepEqual(run(alphaListEnter, 'a. x|\nb. y\n\t- 子\nc. z\n\n次').text, 'a. x\nb. |\nc. y\n\t- 子\nd. z\n\n次')
})

test('空の項目で Enter すると項目を終える（記号を消す）', () => {
  assert.deepEqual(run(alphaListEnter, 'a. x\nb. |'), { handled: true, text: 'a. x\n|' })
  assert.deepEqual(run(alphaListEnter, '- 親\n\ta. x\n\tb. |').text, '- 親\n\ta. x\n\t|')
  assert.deepEqual(run(alphaListEnter, '> a. x\n> b. |').text, '> a. x\n> |')
})

test('z の次は続けず、普通の改行にする', () => {
  const lines = 'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `${c}. ${c}`).join('\n')
  assert.deepEqual(run(alphaListEnter, lines + '|').text, lines + '\n|')
})

test('項目でない行・選択中・記号の手前では何もしない（今までの Enter に任せる）', () => {
  assert.equal(run(alphaListEnter, '本文|').handled, false)
  assert.equal(run(alphaListEnter, 'Q. 質問|').handled, false)
  assert.equal(run(alphaListEnter, '1. 番号|').handled, false)
  assert.equal(run(alphaListEnter, 'a|. x').handled, false)
  let state = make('a. xyz')
  state = state.update({ selection: EditorSelection.range(3, 5) }).state
  assert.equal(alphaListEnter({ state, dispatch: () => {} }), false)
  const locked = EditorState.create({ doc: 'a. xyz', selection: EditorSelection.cursor(6), extensions: [noteMarkdown(), EditorState.readOnly.of(true)] })
  assert.equal(alphaListEnter({ state: locked, dispatch: () => assert.fail('閲覧中は書き換えない') }), false)
})

test('Tab / Shift+Tab の字下げは番号付きと同じに動き、字下げ後も項目のまま', () => {
  const tab = run(indentMore, 'a. x\nb. |y')
  assert.equal(tab.text, 'a. x\n\tb. |y')
  assert.equal(run(indentMore, '1. x\n2. |y').text, '1. x\n\t2. |y')
  assert.ok(isItem('a. x\n\tb. y', 2))
  assert.equal(run(indentLess, 'a. x\n\tb. |y').text, 'a. x\nb. |y')
  assert.equal(run(indentLess, '1. x\n\t2. |y').text, '1. x\n2. |y')
})

test('記号は番号と同じ色にし、ぶら下げ字下げの対象にもする', () => {
  const state = make('a. りんご\nb. みかん\nQ. 質問\n|')
  const marks = []
  buildDecorations(state, { mode: 'reading' }).between(0, state.doc.length, (from, to, deco) => {
    if (deco.spec.class === 'cm-list-number') marks.push(state.doc.sliceString(from, to))
  })
  assert.deepEqual(marks, ['a.', 'b.'])
  const starts = listItemStarts(make('> a. りんご\n本文'))
  assert.deepEqual(starts, [{ line: 0, indent: 2, lead: 2, text: 5 }])
})
