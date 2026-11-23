import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'

import { noteMarkdown } from '../src/markdown-ext.mjs'

function names(doc) {
  const state = EditorState.create({ doc, extensions: [noteMarkdown()] })
  const tree = ensureSyntaxTree(state, doc.length, 5000)
  const found = []
  tree.iterate({ enter: (node) => void found.push(node.name) })
  return found
}

const setext = (doc) => names(doc).filter((name) => name.startsWith('SetextHeading'))

test('「Q. 〜」の直後の空の「- 」は見出しの下線にせず、空の箇条書きとして読む', () => {
  const doc = 'Q. 上記の目標を書いてください。\n- \n\n次の段落'
  assert.deepEqual(setext(doc), [])
  assert.ok(names(doc).includes('BulletList'))
  assert.ok(names(doc).includes('Paragraph'))
})

test('「-」だけの行（後ろの空白なし・空白いくつか）も同じ', () => {
  for (const dash of ['-', '-   ', '-\t']) assert.deepEqual(setext(`Q. 質問\n${dash}\n`), [], JSON.stringify(dash))
})

test('引用の中の「> - 」も見出しにしない', () => {
  const doc = '> Q. 質問\n> - \n'
  assert.deepEqual(setext(doc), [])
  assert.ok(names(doc).includes('BulletList'))
})

test('箇条書きの中で空の子の項目を書き始めたときも見出しにしない', () => {
  assert.deepEqual(setext('- foo\n\t- \n'), [])
})

test('「---」「--」「===」「=」の下線は今までどおり見出し', () => {
  assert.deepEqual(setext('題名\n---\n'), ['SetextHeading2'])
  assert.deepEqual(setext('題名\n--\n'), ['SetextHeading2'])
  assert.deepEqual(setext('題名\n===\n'), ['SetextHeading1'])
  assert.deepEqual(setext('題名\n=\n'), ['SetextHeading1'])
  assert.deepEqual(setext('> 題名\n> ---\n'), ['SetextHeading2'])
})

test('4文字以上字下げした「-」は、今までどおり段落の続き（コードにしない）', () => {
  const found = names('Q. 質問\n    -\n')
  assert.ok(!found.includes('CodeBlock'))
  assert.ok(!found.includes('BulletList'))
  assert.deepEqual(found.filter((name) => name.startsWith('SetextHeading')), [])
})

test('「- 」のあとに文字がある項目は、今までどおり段落の続きにならず箇条書き', () => {
  const doc = 'Q. 質問\n- 答え\n'
  assert.deepEqual(setext(doc), [])
  assert.ok(names(doc).includes('BulletList'))
})
