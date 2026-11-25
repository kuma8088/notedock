import assert from 'node:assert/strict'
import { test } from 'node:test'

import { linkRefsIn, linkedKeys, unlinkedMap } from '../src/task-unlinked.mjs'
import { pathKey } from '../src/task-delete.mjs'

const MONTH = '90_Periodic/2026/Monthly/2026-11.md'
const T = (name) => `Tasks/${name}.md`

// notes: { path: text }。tasks: [{ path, goal?, parent? }]。known は notes と tasks のパス全部。
function judge(tasks, notes, { extraKnown = [], complete = true, unreadable = [] } = {}) {
  const known = new Set([...Object.keys(notes), ...tasks.map((t) => t.path), ...extraKnown].map((p) => p.normalize('NFC')))
  const refsOf = (path) => (unreadable.includes(path) ? null : path in notes ? linkRefsIn(notes[path]) : null)
  const taskNotes = Object.entries(notes).filter(([p]) => p.startsWith('Tasks/')).map(([path, text]) => ({ path, refs: linkRefsIn(text) }))
  const map = unlinkedMap(tasks, { known, refsOf, taskNotes, complete })
  return Object.fromEntries(tasks.map((t) => [t.path, map.get(pathKey(t.path))]))
}

const goal = `"[[${MONTH.replace(/\.md$/, '')}]]"`.slice(1, -1)

test('goal だけ：goal のノートにリンクがあれば外れていない。なければ外れた', () => {
  const tasks = [{ path: T('a'), goal }, { path: T('b'), goal }]
  const notes = { [MONTH]: '- 目標A [[Tasks/a|→タスク]]\n- 目標B\n', [T('a')]: '', [T('b')]: '' }
  assert.deepEqual(judge(tasks, notes), { [T('a')]: false, [T('b')]: true })
})

test('parent あり：親のノートを見る（goal のノートにリンクがなくても外れていない）', () => {
  const tasks = [{ path: T('p'), goal }, { path: T('c'), goal, parent: '[[Tasks/p]]' }, { path: T('d'), goal, parent: '[[Tasks/p]]' }]
  const notes = { [MONTH]: '- P [[Tasks/p|→タスク]]\n', [T('p')]: '- [ ] C [[Tasks/c|→タスク]]\n', [T('c')]: '', [T('d')]: '' }
  const got = judge(tasks, notes)
  assert.equal(got[T('p')], false)
  assert.equal(got[T('c')], false)
  // d は親のノートからのリンクがない（goal のノートにもない）
  assert.equal(got[T('d')], true)
})

test('parent があれば goal のノートのリンクは見ない（親のノートに無ければ外れた）', () => {
  const tasks = [{ path: T('p'), goal }, { path: T('c'), goal, parent: '[[Tasks/p]]' }]
  const notes = { [MONTH]: '- P [[Tasks/p]]\n- C [[Tasks/c]]\n', [T('p')]: '本文\n', [T('c')]: '' }
  // ただし Tasks/ のノートからのリンクではないので、親を見て外れたと判定する
  assert.equal(judge(tasks, notes)[T('c')], true)
})

test('画面から作ったタスク（goal も parent もない）は出さない', () => {
  const tasks = [{ path: T('free') }, { path: T('blank'), goal: '', parent: '' }]
  assert.deepEqual(judge(tasks, { [T('free')]: '', [T('blank')]: '' }), { [T('free')]: false, [T('blank')]: false })
})

test('リンクを名前だけに書き換えても、同じノートに届けば外れていない。別のノートに届けば外れた', () => {
  const tasks = [{ path: T('2026-11-24-動画'), goal }]
  assert.equal(judge(tasks, { [MONTH]: '- 動画 [[2026-11-24-動画]]\n' })[T('2026-11-24-動画')], false)
  // 月のノートと同じフォルダーに同じ名前のノートがあると、名前だけのリンクはそちらを指す
  const same = '90_Periodic/2026/Monthly/2026-11-24-動画.md'
  assert.equal(judge(tasks, { [MONTH]: '- 動画 [[2026-11-24-動画]]\n', [same]: '' })[T('2026-11-24-動画')], true)
})

test('リンクの行を別のタスクのノートへ移したら、外れていない（Tasks/ のどれかからのリンク）', () => {
  const tasks = [{ path: T('x'), goal }, { path: T('y'), goal }]
  const notes = { [MONTH]: '- Y [[Tasks/y]]\n', [T('y')]: '- [ ] X [[Tasks/x|→タスク]]\n', [T('x')]: '' }
  assert.equal(judge(tasks, notes)[T('x')], false)
})

test('自分のノートの中の自分へのリンクは数えない', () => {
  const tasks = [{ path: T('self'), goal }]
  assert.equal(judge(tasks, { [MONTH]: '', [T('self')]: '[[Tasks/self]]\n' })[T('self')], true)
})

test('元のノートが消えたら外れた。一覧が途中まで（complete: false）なら、見つからないことを理由にしない', () => {
  const tasks = [{ path: T('a'), goal }]
  assert.equal(judge(tasks, { [T('a')]: '' })[T('a')], true)
  assert.equal(judge(tasks, { [T('a')]: '' }, { complete: false })[T('a')], false)
})

test('元のノートが読めないときは、外れたとしない', () => {
  const tasks = [{ path: T('a'), goal }]
  assert.equal(judge(tasks, { [MONTH]: '' }, { unreadable: [MONTH] })[T('a')], false)
})

test('NFC と NFD：ファイル名と書いたリンクで濁点の持ち方が違っても同じノート', () => {
  const nfd = 'Tasks/2026-11-24-ガイド'.normalize('NFD')
  const tasks = [{ path: `${nfd}.md`, goal }]
  const got = judge(tasks, { [MONTH]: `- [[${'Tasks/2026-11-24-ガイド'.normalize('NFC')}|→タスク]]\n` })
  assert.equal(got[`${nfd}.md`], false)
  const got2 = judge([{ path: 'Tasks/ガイド.md', goal }], { [MONTH]: `- [[${'Tasks/ガイド'.normalize('NFD')}]]\n` })
  assert.equal(got2['Tasks/ガイド.md'], false)
})

test('大文字小文字：リンクの書き方が違っても同じノート', () => {
  const tasks = [{ path: 'Tasks/Video.md', goal }]
  assert.equal(judge(tasks, { [MONTH]: '- [[tasks/VIDEO|→タスク]]\n' })['Tasks/Video.md'], false)
})

test('数えないもの：先頭のプロパティ・コードの中・埋め込み ![[…]]', () => {
  const tasks = [{ path: T('a'), goal }]
  for (const text of ['---\nrel: "[[Tasks/a]]"\n---\n本文\n', '```\n[[Tasks/a]]\n```\n', '![[Tasks/a]]\n']) {
    assert.equal(judge(tasks, { [MONTH]: text })[T('a')], true, text)
  }
})

test('Markdown のリンク（相対パス）も数える。外のリンクは数えない', () => {
  const tasks = [{ path: T('a'), goal }]
  assert.equal(judge(tasks, { [MONTH]: '[a](../../../Tasks/a.md)\n' })[T('a')], false)
  assert.equal(judge(tasks, { [MONTH]: '[a](https://example.com/Tasks/a.md)\n' })[T('a')], true)
})

test('CRLF のノートでも読める。linkedKeys は解決したキーを返す', () => {
  const refs = linkRefsIn('---\r\ntype: x\r\n---\r\n[[Tasks/A]]\r\n')
  assert.deepEqual(refs, [{ wiki: 'Tasks/A' }])
  assert.deepEqual([...linkedKeys(refs, MONTH, new Set(['Tasks/A.md']))], ['tasks/a'])
})

// ---- E2 のレビューの指摘（小1・小2・小9・中1） ----

test('BOM つきのタスクノート：先頭のプロパティ（parent: など）のリンクは数えない', () => {
  const BOM = String.fromCharCode(0xfeff)
  assert.deepEqual(linkRefsIn(BOM + '---\ntype: task\nparent: "[[Tasks/p]]"\n---\n'), [])
  assert.deepEqual(linkRefsIn(BOM + '---\ntype: task\n---\n[[Tasks/p]]\n'), [{ wiki: 'Tasks/p' }])
  // 子の parent: が親へのリンクに数えられて、親が「外れていない」にならない
  const tasks = [{ path: T('p'), goal }, { path: T('c'), goal, parent: '[[Tasks/p]]' }]
  const notes = { [MONTH]: '- 目標\n', [T('p')]: '', [T('c')]: BOM + '---\ntype: task\nparent: "[[Tasks/p]]"\n---\n' }
  assert.deepEqual(judge(tasks, notes), { [T('p')]: true, [T('c')]: true })
})

test('数えないもの：行内コードと HTML のコメント（行をまたぐものも）の中', () => {
  const tasks = [{ path: T('a'), goal }]
  for (const text of ['文中の `[[Tasks/a]]` はコード\n', '文中の ``a ` [[Tasks/a]]`` はコード\n', '<!-- [[Tasks/a]] -->\n', '<!--\n- [[Tasks/a]]\n-->\n本文\n']) {
    assert.equal(judge(tasks, { [MONTH]: text })[T('a')], true, text)
  }
  // 閉じたあとのリンク・閉じていない ` のあとのリンクは数える
  for (const text of ['`code` [[Tasks/a]]\n', '<!-- x --> [[Tasks/a]]\n', '<!--\nx\n--> [[Tasks/a]]\n', '閉じない ` [[Tasks/a]]\n']) {
    assert.equal(judge(tasks, { [MONTH]: text })[T('a')], false, text)
  }
})

test('known が途中まで（complete: false）なら、名前だけのリンクでも外れたとしない', () => {
  const tasks = [{ path: T('y'), goal }]
  // known に月のノートしかない（Tasks/y がない）と、名前だけの [[y]] は届かないが、途中までなので外れたとしない
  const known = new Set([MONTH])
  const refsOf = () => linkRefsIn('- [[y]]\n')
  assert.equal(unlinkedMap(tasks, { known, refsOf, complete: false }).get(pathKey(T('y'))), false)
  assert.equal(unlinkedMap(tasks, { known, refsOf, complete: true }).get(pathKey(T('y'))), true)
})

test('Tasks/ の中の type: task でないノートからのリンクでも、外れていない', () => {
  const tasks = [{ path: T('a'), goal }]
  assert.equal(judge(tasks, { [MONTH]: '', [T('memo')]: '- [[Tasks/a]]\n' })[T('a')], false)
})

test('known にない元のノートでも、ディスクにあれば（existsOnDisk）中のリンクを見る', () => {
  const tasks = [{ path: T('b'), goal: '[[90_Periodic/2026/Monthly/2026-12]]' }]
  const M2 = '90_Periodic/2026/Monthly/2026-12.md'
  const known = new Set([T('b')])
  const refsOf = (p) => (p === M2 ? linkRefsIn('- [[Tasks/b|→タスク]]\n') : null)
  assert.equal(unlinkedMap(tasks, { known, refsOf }).get(pathKey(T('b'))), true)
  assert.equal(unlinkedMap(tasks, { known, refsOf, existsOnDisk: (p) => p === M2 }).get(pathKey(T('b'))), false)
  // ディスクにあってリンクがなければ外れた
  assert.equal(unlinkedMap(tasks, { known, refsOf: () => [], existsOnDisk: () => true }).get(pathKey(T('b'))), true)
})
