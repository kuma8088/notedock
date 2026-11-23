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


// ここから：「a. 」の項目の下の子（2026-11-23 の本人の書き方に子を足した形）。
import { foldable, syntaxTree, ensureSyntaxTree, foldEffect } from '@codemirror/language'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { alphaChildEnter } from '../src/alpha-list.mjs'
import { listMarkerFold } from '../src/folds.mjs'

const NOTE = '1. aaa\n\t1. 1111\n\t\ta. aaaa\n'
const nodeOnLine = (state, lineNumber, name) => {
  const line = state.doc.line(lineNumber)
  let found = null
  syntaxTree(state).iterate({ from: line.from, to: line.to, enter(node) { if (!found && node.name === name && node.from >= line.from && node.from <= line.to) found = node.node } })
  return found
}
// 本人の Enter の順番（main.mjs の editorKeys と同じ）。
const enterChain = (target) => alphaListEnter(target) || alphaChildEnter(target) || insertNewlineContinueMarkup(target)

test('「a. 」の下に Tab で入れた「- 」は箇条書き、「1. 」は番号付きとして読む', () => {
  const bullet = make(NOTE + '\t\t\t- child\n')
  assert.equal(nodeOnLine(bullet, 4, 'ListItem')?.parent.name, 'BulletList')
  assert.equal(nodeOnLine(bullet, 4, 'ListItem')?.parent.parent.name, 'AlphaItem')
  assert.ok(isItem(NOTE + '\t\t\t- child\n', 3), '「a. 」の項目のまま')
  const ordered = make(NOTE + '\t\t\t1. child\n')
  assert.equal(nodeOnLine(ordered, 4, 'ListItem')?.parent.name, 'OrderedList')
})

test('「a. 」の下の子の記号は箇条書きの記号（段は1つ深い）、番号は番号の色になり、ぶら下げ字下げの対象にもなる', () => {
  const state = make(NOTE + '\t\t\t- child\n\t\t\t1. n\n')
  const bullets = []
  const numbers = []
  buildDecorations(state, { mode: 'reading' }).between(0, state.doc.length, (from, to, deco) => {
    if (deco.spec.widget?.level) bullets.push([state.doc.lineAt(from).number, deco.spec.widget.level])
    if (deco.spec.class === 'cm-list-number') numbers.push(state.doc.sliceString(from, to))
  })
  assert.deepEqual(bullets, [[4, 4]], '1. → 1. → a. の下なので4段目（英字の項目も1段と数える）')
  assert.deepEqual(numbers, ['1.', '1.', 'a.', '1.'])
  assert.deepEqual(listItemStarts(state).map((item) => state.doc.lineAt(item.line).number), [1, 2, 3, 4, 5])
})

test('子のある「a. 」の項目はたためる。記号を押すと開閉する', () => {
  const state = make(NOTE + '\t\t\t- child\n')
  const line = state.doc.line(3)
  const range = foldable(state, line.from, line.to)
  assert.ok(range, 'たためる')
  assert.equal(state.doc.sliceString(range.from, range.to), '\n\t\t\t- child')
  const mark = alphaItemAt(state, 3).markFrom
  assert.ok(listMarkerFold(state, mark)?.is(foldEffect))
  assert.equal(listMarkerFold(make(NOTE), make(NOTE).doc.line(3).from + 2), null, '子がなければ何もしない')
})

test('「a. 」の下の子で Enter：同じ字下げで次の子が続く', () => {
  const run2 = (text) => run(enterChain, text).text
  assert.equal(run2(NOTE + '\t\t\t- child|'), NOTE + '\t\t\t- child\n\t\t\t- |')
  assert.equal(run2(NOTE + '\t\t\t1. child|'), NOTE + '\t\t\t1. child\n\t\t\t2. |')
  assert.equal(run2('a. x\n\t- c|'), 'a. x\n\t- c\n\t- |')
  assert.equal(run2('> a. x\n>     - c|'), '> a. x\n>     - c\n>     - |', '引用の中')
  // 字下げ・引用の扱いは、「a. 」を「1. 」にした文書での標準の Enter と同じ。
  for (const text of ['a. x\n\t- c|', '> a. x\n> \t- c|', 'a. x\n\t- c\n\t\t- d|', 'a. x\n\t1. p|\n\t2. q', NOTE + '\t\t\t- child|']) {
    assert.equal(run2(text).replace(/(^|\n)([\t >]*)[a-z]\. /g, '$1$21. '), run(insertNewlineContinueMarkup, text.replace(/(^|\n)([\t >]*)[a-z]\. /g, '$1$21. ')).text, text)
  }
  assert.equal(run2('a. x\n\t- c\n\t\t- d|'), 'a. x\n\t- c\n\t\t- d\n\t\t- |')
  assert.equal(run2('a. x\n\t1. p|\n\t2. q'), 'a. x\n\t1. p\n\t2. |\n\t3. q', '後ろの番号を振り直す')
})

test('「a. 」の下の空の子で Enter すると、「a. 」と同じ段の次の文字の項目になる（番号付きの下の空の子と同じ動き）', () => {
  assert.equal(run(enterChain, 'a. x\n\t- |').text, 'a. x\nb. |')
  assert.equal(run(enterChain, NOTE + '\t\t\t- |').text, NOTE + '\t\tb. |')
  assert.equal(run(enterChain, 'a. x\n\t- |\nb. y').text, 'a. x\nb. |\nc. y', '後ろの文字を振り直す')
  // 番号付きの下では同じ形で「2. 」になる。
  assert.equal(run(insertNewlineContinueMarkup, '1. x\n\t- |').text, '1. x\n2. |')
})

test('「a. 」の項目そのものの Enter は今までどおり（英字の Enter が先に動く）', () => {
  assert.equal(run(enterChain, NOTE.trimEnd() + '|').text, NOTE + '\t\tb. |')
  assert.equal(run(alphaChildEnter, 'a. x|').handled, false)
  assert.equal(run(alphaChildEnter, '- x|').handled, false, '英字の項目の下でなければ標準の Enter に任せる')
})

test('分かっている限界：「a. 」と「b. 」の間に空行を足しても、すぐには「b. 」がただの文に戻らない（その行を書き換えると戻る）', () => {
  // 読み取りは書き換えた所の近くだけを読み直し、離れた所は前の結果を使う。「b. 」が項目かどうかは上の行で決まるので、
  // 上だけを書き換えると前の結果が残る。保存されるファイルは変わらず、見た目と Enter の続け方だけの違い。
  const before = make('a. x\nb. y\n')
  ensureSyntaxTree(before, before.doc.length, 1e9)
  const after = before.update({ changes: { from: 4, insert: '\n' } }).state
  assert.ok(alphaItemAt(after, 3), '前の結果が残る')
  assert.ok(!alphaItemAt(make(after.doc.toString()), 3), '最初から読むとただの文')
})

test('書き換えたあとの読み方は、最初から読んだときと同じ（途中から読み直しても食い違わない）', () => {
  const edits = [
    ['a. x\nb. y\nc. z\n', { from: 0, to: 1, insert: 'q' }],
    ['本文\n\na. x\n\t- c\nb. y\n', { from: 0, insert: '前\n' }],
    [NOTE + '\t\t\t- child\n', { from: NOTE.length - 1, insert: '\n\t\t\t- c0' }],
  ]
  // 前の結果が使われるのは、書き換えた所から離れた部分だけ。長い本文を前後に置いて、使われる形で確かめる。
  const PAD = '本文の段落。'.repeat(60) + '\n\n'
  const TAIL = '\n' + 'あとの段落。'.repeat(60) + '\n'
  const abc = PAD + 'a. x\nb. y\nc. z' + TAIL
  edits.push([abc, { from: abc.indexOf('c. z') + 4, insert: '\nd. ' }])
  edits.push([abc, { from: abc.indexOf('b. y') + 4, insert: '1' }])
  const nested = PAD + '1. aaa\n\t1. 1111\n\t\ta. aaaa\n\t\tb. bbbb\n\t\t\t- child' + TAIL
  edits.push([nested, { from: nested.indexOf('child') + 5, insert: 'x' }])
  edits.push([nested, { from: nested.indexOf('bbbb') + 4, insert: 'x' }])
  edits.push([nested, { from: nested.indexOf('aaaa') + 4, insert: 'x' }])
  const dump = (state) => {
    ensureSyntaxTree(state, state.doc.length, 1e9)
    const out = []
    syntaxTree(state).iterate({ enter: (n) => { out.push(`${n.name}:${n.from}-${n.to}`) } })
    return out.join(' ')
  }
  for (const [doc, change] of edits) {
    const before = make(doc)
    ensureSyntaxTree(before, before.doc.length, 1e9)
    const after = before.update({ changes: change }).state
    assert.equal(dump(after), dump(make(after.doc.toString())), JSON.stringify([doc, change]))
  }
})
