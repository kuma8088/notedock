import assert from 'node:assert/strict'
import test from 'node:test'

import { movedPath, planRelink, relinkText } from '../src/relink.mjs'

const known = ['日記/2026/11-08.md', 'プロジェクト/企画.md', 'プロジェクト/memo.md', 'Home.md', 'a/同名.md', 'b/同名.md']

test('動かす元と先から、新しい場所を出す', () => {
  assert.equal(movedPath('a/b.md', { from: 'a/b.md', to: 'c/b.md' }), 'c/b.md')
  assert.equal(movedPath('a/x/y.md', { from: 'a', to: 'z/a' }), 'z/a/x/y.md')
  assert.equal(movedPath('ab/y.md', { from: 'a', to: 'z/a' }), null)
})

test('動かしたノートを指す普通のリンクを、相手のノートから見た場所に直す', () => {
  const move = { from: 'プロジェクト/企画.md', to: 'アーカイブ/企画.md' }
  const plan = planRelink([{ path: 'Home.md', text: '[企画](プロジェクト/企画.md#目的) と [外](https://x.y) と [自分](#a)' }], move, known)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].text, '[企画](アーカイブ/企画.md#目的) と [外](https://x.y) と [自分](#a)')
  assert.equal(plan[0].count, 1)
})

test('動かしたノートの中の、ほかのノートへの普通のリンクも直す', () => {
  const move = { from: 'プロジェクト/企画.md', to: '日記/2026/企画.md' }
  const plan = planRelink([{ path: 'プロジェクト/企画.md', text: '[メモ](memo.md) [家](../Home.md) [上から](/Home.md)' }], move, known)
  assert.equal(plan[0].path, '日記/2026/企画.md')
  assert.equal(plan[0].text, '[メモ](../../プロジェクト/memo.md) [家](../../Home.md) [上から](/Home.md)')
})

test('名前だけの [[ ]] は、名前が変わったときだけ直す。見出しと表示名は残す', () => {
  const renamed = planRelink([{ path: 'Home.md', text: '[[企画#目的|企画の目的]] [[memo]]' }], { from: 'プロジェクト/企画.md', to: 'プロジェクト/計画.md' }, known)
  assert.equal(renamed[0].text, '[[計画#目的|企画の目的]] [[memo]]')
  const moved = planRelink([{ path: 'Home.md', text: '[[企画]]' }], { from: 'プロジェクト/企画.md', to: 'アーカイブ/企画.md' }, known)
  assert.equal(moved.length, 0)
})

test('同じ名前のノートがあって名前だけでは届かなくなるときは、場所付きにする', () => {
  const plan = planRelink([{ path: 'Home.md', text: '[[memo]]' }], { from: 'プロジェクト/memo.md', to: 'c/同名.md' }, known)
  assert.equal(plan[0].text, '[[c/同名]]')
})

test('場所付きの [[ ]] と、表の中の \\| はそのまま形を保つ', () => {
  const plan = planRelink([{ path: 'Home.md', text: '| [[プロジェクト/企画\\|企画]] |' }], { from: 'プロジェクト', to: 'アーカイブ/プロジェクト' }, known)
  assert.equal(plan[0].text, '| [[アーカイブ/プロジェクト/企画\\|企画]] |')
})

test('コードの中のリンクは書き換えない', () => {
  const text = '```\n[a](プロジェクト/企画.md)\n```\n`[[企画]]` [b](プロジェクト/企画.md)'
  const result = relinkText(text, { note: 'Home.md', after: 'Home.md', move: { from: 'プロジェクト/企画.md', to: 'x/y.md' }, knownBefore: known, knownAfter: known.map((p) => (p === 'プロジェクト/企画.md' ? 'x/y.md' : p)) })
  assert.equal(result.text, '```\n[a](プロジェクト/企画.md)\n```\n`[[企画]]` [b](x/y.md)')
  assert.equal(result.count, 1)
})

test('フォルダーごと動かすと、中の画像へのリンクも直す', () => {
  const plan = planRelink([{ path: 'Home.md', text: '![図](プロジェクト/図/a.png) <x> [企画](<プロジェクト/企画.md>)' }], { from: 'プロジェクト', to: '済み/プロジェクト' }, known)
  assert.equal(plan[0].text, '![図](済み/プロジェクト/図/a.png) <x> [企画](<済み/プロジェクト/企画.md>)')
  assert.equal(plan[0].count, 2)
})

test('参照の書き方の定義の行も書き換える', () => {
  const plan = planRelink([{ path: 'Home.md', text: '[企画][p]\n\n[p]: プロジェクト/企画.md "題"\n' }], { from: 'プロジェクト/企画.md', to: 'x/企画.md' }, known)
  assert.equal(plan[0].text, '[企画][p]\n\n[p]: x/企画.md "題"\n')
})

test('同じ名前のノートが近くに来て、名前だけのリンクの行き先が変わるときは、場所付きにする', () => {
  const list = ['Home.md', 'a/同名.md', 'b/同名.md', 'c/ノート.md']
  // c/ノート.md の [[同名]] は a/同名.md を指していた。b/同名.md が c/ に来ると、同じフォルダーのほうを指してしまう。
  const plan = planRelink([{ path: 'c/ノート.md', text: '[[同名]]' }], { from: 'b/同名.md', to: 'c/同名.md' }, list)
  assert.equal(plan[0].text, '[[a/同名]]')
})

test('分解した形の濁点の場所でも、同じ場所として書き換える', () => {
  const nfd = 'プロジェクト'.normalize('NFD')
  const plan = planRelink([{ path: 'Home.md', text: '[企画](プロジェクト/企画.md)' }], { from: `${nfd}/企画.md`, to: 'x/企画.md' }, known)
  assert.equal(plan[0].text, '[企画](x/企画.md)')
})

test('脚注の説明や、ファイルに見えない定義の行は書き換えない', () => {
  const text = '本文[^1]\n\n[^1]: これは説明です\n[メモ]: なにか\n'
  const plan = planRelink([{ path: 'a/n.md', text }], { from: 'a/n.md', to: 'b/c/n.md' }, ['a/n.md'])
  assert.equal(plan.length, 0)
})
