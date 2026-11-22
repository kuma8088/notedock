import assert from 'node:assert/strict'
import test from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'

import { linesFrom, selectedLines } from '../src/lines.mjs'

const DOC = 'a\nbb\nccc\ndddd\n'
const at = (anchor, head) => EditorState.create({ doc: DOC, selection: EditorSelection.single(anchor, head) })

test('何も選んでいなければ null', () => {
  assert.equal(selectedLines(at(3)), null)
})

test('1行の中の選択は、その行だけ', () => {
  assert.deepEqual(selectedLines(at(2, 4)), { from: 2, to: 2 })
})

test('複数行の選択は、始まりの行から終わりの行まで。逆向きに選んでも同じ', () => {
  assert.deepEqual(selectedLines(at(3, 8)), { from: 2, to: 3 })
  assert.deepEqual(selectedLines(at(8, 3)), { from: 2, to: 3 })
})

test('行ごと選んで次の行の頭で終わるときは、次の行を含めない', () => {
  // 2行目の頭（2）から4行目の頭（9）まで
  assert.deepEqual(selectedLines(at(2, 9)), { from: 2, to: 3 })
})

test('右の枠から届いた値は、正しい形のときだけ使う', () => {
  assert.deepEqual(linesFrom({ from: 2, to: 5 }), { from: 2, to: 5 })
  assert.equal(linesFrom({ from: 0, to: 5 }), null)
  assert.equal(linesFrom({ from: 5, to: 2 }), null)
  assert.equal(linesFrom({ from: '1', to: 2 }), null)
  assert.equal(linesFrom(null), null)
})
