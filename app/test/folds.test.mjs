import assert from 'node:assert/strict'
import { test } from 'node:test'

import { codeFolding, foldEffect, foldable, unfoldAll, unfoldEffect } from '@codemirror/language'
import { EditorState } from '@codemirror/state'

import { foldedLines, foldsChanged, listMarkerFold } from '../src/folds.mjs'
import { noteMarkdown } from '../src/markdown-ext.mjs'

const doc = '- 親\n\t- 子1\n\t- 子2\n- 次\n'
const make = () => EditorState.create({ doc, extensions: [noteMarkdown(), codeFolding()] })
const foldFirst = (state) => {
  const line = state.doc.line(1)
  return state.update({ effects: foldEffect.of(foldable(state, line.from, line.to)) })
}

// 画面の更新（ViewUpdate）の代わり。比べるのは更新の前後の状態だけ。
const updateOf = (...trs) => ({ startState: trs[0].startState, state: trs[trs.length - 1].state, transactions: trs })

test('たたんだときは覚え直す対象になり、たたんだ行の番号が分かる', () => {
  const tr = foldFirst(make())
  assert.equal(foldsChanged(updateOf(tr)), true)
  assert.deepEqual(foldedLines(tr.state), [1])
})

test('開いたとき（unfoldEffect）も覚え直す対象になり、開いた行は残らない', () => {
  const folded = foldFirst(make()).state
  const range = foldable(folded, folded.doc.line(1).from, folded.doc.line(1).to)
  const tr = folded.update({ effects: unfoldEffect.of(range) })
  assert.equal(foldsChanged(updateOf(tr)), true)
  assert.deepEqual(foldedLines(tr.state), [])
})

test('カーソルがたたんだ範囲に入って自動で開いたときも覚え直す', () => {
  const folded = foldFirst(make()).state
  const tr = folded.update({ selection: { anchor: folded.doc.line(2).from + 3 } })
  assert.equal(tr.effects.length, 0, '開く操作（unfoldEffect）は出ない')
  assert.deepEqual(foldedLines(tr.state), [])
  assert.equal(foldsChanged(updateOf(tr)), true)
})

test('たたんだ範囲にかかる削除で開いたときも覚え直す', () => {
  const folded = foldFirst(make()).state
  const tr = folded.update({ changes: { from: folded.doc.line(1).to - 1, to: folded.doc.line(3).to } })
  assert.deepEqual(foldedLines(tr.state), [])
  assert.equal(foldsChanged(updateOf(tr)), true)
})

test('上に行を足して、たたんだ行の番号がずれたときも覚え直す（新しい番号で）', () => {
  const folded = foldFirst(make()).state
  const tr = folded.update({ changes: { from: 0, insert: '前の行\n' } })
  assert.deepEqual(foldedLines(tr.state), [2])
  assert.equal(foldsChanged(updateOf(tr)), true)
})

test('たたんだ範囲より下の変更や、範囲の外のカーソル移動では覚え直さない', () => {
  const folded = foldFirst(make()).state
  const below = folded.update({ changes: { from: folded.doc.length, insert: 'x' } })
  assert.equal(foldsChanged(updateOf(below)), false)
  const move = folded.update({ selection: { anchor: folded.doc.line(4).from } })
  assert.equal(foldsChanged(updateOf(move)), false)
})

test('すべて開く（unfoldAll）も覚え直す対象になる', () => {
  let state = foldFirst(make()).state
  const trs = []
  // view.dispatch には、トランザクションではなく中身（{ effects }）が渡される。
  unfoldAll({
    get state() { return state },
    dispatch: (spec) => {
      const tr = state.update(spec)
      trs.push(tr)
      state = tr.state
    },
  })
  assert.equal(trs.length, 1)
  assert.equal(foldsChanged(updateOf(...trs)), true)
  assert.deepEqual(foldedLines(state), [])
})

test('たたんだ範囲がないときの変更では覚え直さない', () => {
  const tr = make().update({ changes: { from: 0, insert: 'x' } })
  assert.equal(foldsChanged(updateOf(tr)), false)
})

const apply = (state, effect) => state.update({ effects: effect }).state

test('子のある項目の記号を押すとたたみ、もう一度押すと開く', () => {
  let state = make()
  const effect = listMarkerFold(state, 0)
  assert.ok(effect?.is(foldEffect))
  state = apply(state, effect)
  assert.deepEqual(foldedLines(state), [1])
  const again = listMarkerFold(state, 0)
  assert.ok(again?.is(unfoldEffect))
  state = apply(state, again)
  assert.deepEqual(foldedLines(state), [])
})

test('子のない項目の記号では何もしない（今までどおりカーソルを置く）', () => {
  const state = make()
  assert.equal(listMarkerFold(state, state.doc.line(2).from + 1), null)
  assert.equal(listMarkerFold(state, state.doc.line(4).from), null)
})

test('番号の項目でも同じ。番号の途中の位置でも項目として扱う', () => {
  const doc = '10. 親\n\t1. 子\n11. 次\n'
  let state = EditorState.create({ doc, extensions: [noteMarkdown(), codeFolding()] })
  const effect = listMarkerFold(state, 1)
  assert.ok(effect?.is(foldEffect))
  state = apply(state, effect)
  assert.deepEqual(foldedLines(state), [1])
})

test('記号ではない所（見出しや本文）では何もしない', () => {
  const doc = '# 見出し\n\n本文\n\n- 親\n\t- 子\n'
  const state = EditorState.create({ doc, extensions: [noteMarkdown(), codeFolding()] })
  assert.equal(listMarkerFold(state, 0), null)
  assert.equal(listMarkerFold(state, doc.indexOf('親')), null)
  assert.ok(listMarkerFold(state, doc.indexOf('- 親')))
})

test('引用の中の項目でも開閉できる', () => {
  const doc = '> - 親\n> \t- 子\n'
  const state = EditorState.create({ doc, extensions: [noteMarkdown(), codeFolding()] })
  assert.ok(listMarkerFold(state, 2)?.is(foldEffect))
})
