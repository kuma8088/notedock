import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EditorState } from '@codemirror/state'

import { listItemStarts } from '../src/hanging.mjs'
import { noteMarkdown } from '../src/markdown-ext.mjs'

function starts(doc) {
  const state = EditorState.create({ doc, extensions: [noteMarkdown()] })
  return listItemStarts(state).map(({ line, lead, text }) => [doc.slice(line, lead), doc.slice(lead, text), doc.slice(text, doc.indexOf('\n', text) < 0 ? undefined : doc.indexOf('\n', text))])
}

test('箇条書き・番号・タスクの、本文が始まる位置を返す', () => {
  const doc = '- 項目\n1. 番号\n2) 括弧\n- [ ] タスク\n* [x] 終わった\n+ プラス'
  assert.deepEqual(starts(doc), [
    ['', '- ', '項目'],
    ['', '1. ', '番号'],
    ['', '2) ', '括弧'],
    ['', '- [ ] ', 'タスク'],
    ['', '* [x] ', '終わった'],
    ['', '+ ', 'プラス'],
  ])
})

test('タブとスペースの字下げ、二段の字下げでも、行頭の字下げと本文の先頭を分けて返す', () => {
  const doc = '- 親\n\t- 子\n\t\t- [ ] 孫\n    - スペース4つ'
  assert.deepEqual(starts(doc), [
    ['', '- ', '親'],
    ['\t', '- ', '子'],
    ['\t\t', '- [ ] ', '孫'],
    ['    ', '- ', 'スペース4つ'],
  ])
})

test('段落、引用のふつうの文、コードの中は対象にしない', () => {
  const doc = '段落\n\n> 引用の文\n\n```\n- コードの中\n```\n\n> ```\n> - 引用の中のコード\n> ```\n\n- 対象'
  assert.deepEqual(starts(doc), [['', '- ', '対象']])
})

test('本文のない項目も、項目の間のすき間と縦の線のために対象にする', () => {
  const state = EditorState.create({ doc: '- \n\t-\n- 本文', extensions: [noteMarkdown()] })
  assert.deepEqual(listItemStarts(state).map(({ line, text }) => text - line), [2, 2, 2])
})

test('引用の記号と字下げの境目（縦の線を引き始める位置）を返す', () => {
  const doc = '- 親\n\t- 子\n\t\t- 孫\n\n> - 引用の親\n> \t- 引用の子'
  const state = EditorState.create({ doc, extensions: [noteMarkdown()] })
  assert.deepEqual(listItemStarts(state).map(({ line, indent, lead }) => [doc.slice(line, indent), doc.slice(indent, lead)]), [
    ['', ''],
    ['', '\t'],
    ['', '\t\t'],
    ['> ', ''],
    ['> ', '\t'],
  ])
})

test('引用とコールアウトの中の項目は、引用の記号と字下げを行頭の部分として返す', () => {
  const doc = '> - 引用\n> \t- [ ] 子のタスク\n> 1. 番号\n> > - 二重の引用\n\n> [!note]\n> - コールアウト\n> \t- [x] 終わった'
  assert.deepEqual(starts(doc), [
    ['> ', '- ', '引用'],
    ['> \t', '- [ ] ', '子のタスク'],
    ['> ', '1. ', '番号'],
    ['> > ', '- ', '二重の引用'],
    ['> ', '- ', 'コールアウト'],
    ['> \t', '- [x] ', '終わった'],
  ])
})

test('範囲を渡すと、その中で始まる項目だけを返す', () => {
  const doc = '- 一\n- 二\n- 三'
  const state = EditorState.create({ doc, extensions: [noteMarkdown()] })
  const from = doc.indexOf('- 二')
  assert.deepEqual(listItemStarts(state, from, from + 3).map((s) => s.line), [from])
})
