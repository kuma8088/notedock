import assert from 'node:assert/strict'
import test from 'node:test'

import { applyMention, headingTarget, unwritableCount, lineToken, mentionCandidates, mentionQuery, noteForName, sectionsOf, writablePath } from '../src/mention.mjs'

test('@ の語は、文の頭か空白のあとだけ', () => {
  assert.deepEqual(mentionQuery('@', 1), { from: 0, to: 1, query: '' })
  assert.deepEqual(mentionQuery('見て @me', 6), { from: 3, to: 6, query: 'me' })
  assert.deepEqual(mentionQuery('a @memo b', 5), { from: 2, to: 7, query: 'me' })
  assert.equal(mentionQuery('mail@example', 12), null)
  assert.deepEqual(mentionQuery('これを@pl', 6), { from: 3, to: 6, query: 'pl' })
  assert.equal(mentionQuery('x.@a', 4), null)
  assert.equal(mentionQuery('abc', 3), null)
  assert.equal(mentionQuery('@a b', 4), null)
})

test('空白や # のある場所は書けない', () => {
  assert.equal(writablePath('a/b.md'), true)
  assert.equal(writablePath('a b.md'), false)
  assert.equal(writablePath('a#b.md'), false)
  assert.equal(writablePath(''), false)
  assert.equal(writablePath('a@b.md'), false)
  assert.equal(writablePath('.obsidian/x.md'), false)
})

test('行の指定。1行だけなら数は1つ', () => {
  assert.equal(lineToken('a.md', 3, 3), '@a.md#L3')
  assert.equal(lineToken('a.md', 3, 9), '@a.md#L3-9')
})

const DOC = ['---', 'title: x', '---', '# 上', '本文', '', '## 中', 'a', '```', '# コードの中', '```', '', '## 次', 'b', '', '# 別', 'c', ''].join('\n')

test('見出しの節は、次の同じか上の段の見出しの前まで。空行と、コードの中と、先頭の YAML は除く', () => {
  assert.deepEqual(sectionsOf(DOC), [
    { level: 1, text: '上', line: 4, to: 14 },
    { level: 2, text: '中', line: 7, to: 11 },
    { level: 2, text: '次', line: 13, to: 14 },
    { level: 1, text: '別', line: 16, to: 17 },
  ])
})

test('見出しの末尾の # と、CRLF', () => {
  assert.deepEqual(sectionsOf('# a ##\r\nx\r\n'), [{ level: 1, text: 'a', line: 1, to: 2 }])
  assert.deepEqual(sectionsOf('#タグ\n'), [])
})

const NOTES = ['memo/plan.md', 'Home.md', 'memo/a b.md', 'x#y.md', 'daily/plan-2.md']

test('並びは 選んでいる行・開いているノート・ほかのノート・見出し。書けないノートは出さない', () => {
  const list = mentionCandidates({
    query: '',
    editor: { path: 'Home.md', lines: { from: 12, to: 18 }, dirty: false },
    notes: NOTES,
    headings: { path: 'Home.md', sections: [{ level: 1, text: '上', line: 1, to: 5 }], dirty: false },
  })
  assert.deepEqual(list.map((c) => [c.kind, c.insert]), [
    ['selection', '@Home.md#L12-18'],
    ['current', '@Home.md'],
    ['note', '@memo/plan.md'],
    ['note', '@daily/plan-2.md'],
    ['heading', '@Home.md#L1-5'],
  ])
  assert.equal(list[0].label, '選んでいる行：Home.md の12〜18行')
})

test('打った文字で絞る。名前の頭が合うものが先', () => {
  const list = mentionCandidates({ query: 'pla', editor: { path: null }, notes: ['zplan.md', ...NOTES], headings: null })
  assert.deepEqual(list.map((c) => c.insert), ['@memo/plan.md', '@daily/plan-2.md', '@zplan.md'])
})

test('「選んでいる」と打っても、選んでいる行が出る', () => {
  const list = mentionCandidates({ query: '選んで', editor: { path: 'Home.md', lines: { from: 2, to: 2 } }, notes: NOTES, headings: null })
  assert.equal(list[0].insert, '@Home.md#L2')
})

test('保存していない変更があると、添え書きで知らせる', () => {
  const list = mentionCandidates({
    query: '',
    editor: { path: 'Home.md', lines: { from: 1, to: 2 }, dirty: true },
    notes: NOTES,
    headings: { path: 'Home.md', sections: [{ level: 1, text: '上', line: 1, to: 5 }], dirty: true },
  })
  assert.match(list[0].detail, /行がずれる/)
  assert.equal(list[0].warn, true)
  assert.match(list.at(-1).detail, /保存していない変更は入りません/)
})

test('開いているノートの場所に空白があれば、選んでいる行も開いているノートも出さない', () => {
  const list = mentionCandidates({ query: '', editor: { path: 'memo/a b.md', lines: { from: 1, to: 1 } }, notes: NOTES, headings: null })
  assert.equal(list.some((c) => c.kind === 'selection' || c.kind === 'current'), false)
})

test('ノート名#見出し。名前のノートを見つけ、見出しを打った文字で絞る', () => {
  assert.equal(noteForName(NOTES, 'plan'), 'memo/plan.md')
  assert.equal(noteForName(NOTES, 'daily/plan-2'), 'daily/plan-2.md')
  assert.equal(headingTarget({ query: 'plan#ab', editor: {}, notes: NOTES }), 'memo/plan.md')
  assert.equal(headingTarget({ query: 'pl', editor: { path: 'Home.md' }, notes: NOTES }), 'Home.md')
  const list = mentionCandidates({
    query: 'plan#次',
    editor: { path: 'Home.md', lines: { from: 1, to: 1 } },
    notes: NOTES,
    headings: { path: 'memo/plan.md', sections: sectionsOf(DOC), dirty: false },
  })
  assert.deepEqual(list.map((c) => c.insert), ['@memo/plan.md#L13-14'])
  assert.equal(list[0].label, 'plan#次')
})

test('空白か # があって出さなかったノートを数える', () => {
  assert.equal(unwritableCount('', NOTES), 2)
  assert.equal(unwritableCount('a b', NOTES), 1)
  assert.equal(unwritableCount('plan', NOTES), 0)
  assert.equal(unwritableCount('x#', NOTES), 0)
})

test('選んだら、打っていた語を入れ替えて、後ろに空白を置く', () => {
  assert.deepEqual(applyMention('見て @pl', { from: 3, to: 6 }, '@memo/plan.md'), { value: '見て @memo/plan.md ', caret: 17 })
  assert.deepEqual(applyMention('@pl です', { from: 0, to: 3 }, '@a.md'), { value: '@a.md です', caret: 6 })
})
