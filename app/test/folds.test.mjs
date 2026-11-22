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

test('たたんだときは覚え直す対象になり、たたんだ行の番号が分かる', () => {
  const tr = foldFirst(make())
  assert.equal(foldsChanged([tr]), true)
  assert.deepEqual(foldedLines(tr.state), [1])
})

test('開いたとき（unfoldEffect）も覚え直す対象になり、開いた行は残らない', () => {
  const folded = foldFirst(make()).state
  const range = foldable(folded, folded.doc.line(1).from, folded.doc.line(1).to)
  const tr = folded.update({ effects: unfoldEffect.of(range) })
  assert.equal(foldsChanged([tr]), true)
  assert.deepEqual(foldedLines(tr.state), [])
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
  assert.equal(foldsChanged(trs), true)
  assert.deepEqual(foldedLines(state), [])
})

test('たたみ・開きと関係のない変更では覚え直さない', () => {
  const tr = make().update({ changes: { from: 0, insert: 'x' } })
  assert.equal(foldsChanged([tr]), false)
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
