import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'

import { noteMarkdown } from '../src/markdown-ext.mjs'
import { buildDecorations, noteContext } from '../src/preview.mjs'
import { BulletWidget } from '../src/widgets.mjs'

function bullets(doc, cursor = doc.length) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [noteMarkdown(), noteContext.of({ path: 'a.md', known: null })],
  })
  const out = []
  buildDecorations(state, { mode: 'reading' }).between(0, doc.length, (from, to, deco) => {
    if (deco.spec.widget instanceof BulletWidget) out.push([state.doc.lineAt(from).number, deco.spec.widget.symbol])
  })
  return out
}

test('箇条書きの記号は段ごとに • → ◦ → ▪ を繰り返す', () => {
  const doc = '- 1段\n\t- 2段\n\t\t- 3段\n\t\t\t- 4段\n\t\t\t\t- 5段\n- 1段\n'
  assert.deepEqual(bullets(doc), [[1, '•'], [2, '◦'], [3, '▪'], [4, '•'], [5, '◦'], [6, '•']])
})

test('番号付きの項目の下の箇条書きも1段深く数える', () => {
  assert.deepEqual(bullets('1. 番号\n\t- 下\n\t\t- さらに下\n'), [[2, '◦'], [3, '▪']])
})

test('引用の中の箇条書きも段で変わる', () => {
  assert.deepEqual(bullets('> - 1段\n> \t- 2段\n'), [[1, '•'], [2, '◦']])
})

test('ファイルの中身（「-」）は変えない。段の違う記号は別の部品として比べる', () => {
  assert.equal(new BulletWidget(1).eq(new BulletWidget(1)), true)
  assert.equal(new BulletWidget(1).eq(new BulletWidget(2)), false)
  assert.equal(new BulletWidget(2).symbol, '◦')
})
