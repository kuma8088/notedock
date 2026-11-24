import test from 'node:test'
import assert from 'node:assert/strict'

import { collectDescendants, deleteChoices, deleteQuestion, deletedText, findTask, isUnderTaskFolder, planUnlinkInNote, relocateLink, sourceNoteOf, taskLinksIn, trashFailedText, unlinkRange } from '../src/task-delete.mjs'

const T = (path, parentPath = null, title = '') => ({ path, parentPath, title })

test('子孫を集める：子・孫・深い・別の親', () => {
  const tasks = [
    T('Tasks/root.md'),
    T('Tasks/a.md', 'Tasks/root.md'),
    T('Tasks/b.md', 'Tasks/root.md'),
    T('Tasks/a1.md', 'Tasks/a.md'),
    T('Tasks/a1x.md', 'Tasks/a1.md'),
    T('Tasks/other.md'),
    T('Tasks/other-child.md', 'Tasks/other.md'),
  ]
  assert.deepEqual(collectDescendants(tasks, 'Tasks/root.md').map((t) => t.path), ['Tasks/a.md', 'Tasks/b.md', 'Tasks/a1.md', 'Tasks/a1x.md'])
  assert.deepEqual(collectDescendants(tasks, 'Tasks/other.md').map((t) => t.path), ['Tasks/other-child.md'])
  assert.deepEqual(collectDescendants(tasks, 'Tasks/b.md'), [])
})

test('子孫を集める：深い階層でも全部たどる', () => {
  const tasks = [T('Tasks/0.md')]
  for (let i = 1; i <= 50; i++) tasks.push(T('Tasks/' + i + '.md', 'Tasks/' + (i - 1) + '.md'))
  assert.equal(collectDescendants(tasks, 'Tasks/0.md').length, 50)
})

test('子孫を集める：輪になっていても止まり、自分は入れない', () => {
  const tasks = [T('Tasks/x.md', 'Tasks/z.md'), T('Tasks/y.md', 'Tasks/x.md'), T('Tasks/z.md', 'Tasks/y.md'), T('Tasks/self.md', 'Tasks/self.md')]
  assert.deepEqual(collectDescendants(tasks, 'Tasks/x.md').map((t) => t.path), ['Tasks/y.md', 'Tasks/z.md'])
  assert.deepEqual(collectDescendants(tasks, 'Tasks/self.md'), [])
})

test('子孫を集める：大文字小文字・濁点の持ち方・.md の有無をそろえて比べる', () => {
  const nfd = 'Tasks/ダイ.md'.normalize('NFD')
  const tasks = [T('Tasks/ダイ.md'), T('Tasks/c.md', nfd), T('Tasks/d.md', 'tasks/C')]
  assert.deepEqual(collectDescendants(tasks, 'Tasks/ダイ.md').map((t) => t.path), ['Tasks/c.md', 'Tasks/d.md'])
  assert.equal(findTask(tasks, 'TASKS/c').path, 'Tasks/c.md')
  assert.equal(findTask(tasks, 'Tasks/none.md'), null)
})

test('Tasks の下か', () => {
  assert.equal(isUnderTaskFolder('Tasks/a.md'), true)
  assert.equal(isUnderTaskFolder('tasks/sub/a.md'), true)
  assert.equal(isUnderTaskFolder('MyTasks/a.md'), false)
  assert.equal(isUnderTaskFolder('Tasks.md'), false)
})

// 行の中のリンクを外した結果。
const cut = (line, linkText, nth = 0) => {
  let at = -1
  for (let i = 0; i <= nth; i++) at = line.indexOf(linkText, at + 1)
  const r = unlinkRange(line, 100, 100 + at, 100 + at + linkText.length)
  return line.slice(0, r.from - 100) + line.slice(r.to - 100)
}
const L = '[[Tasks/a|→タスク]]'

test('リンクを外す位置：行末なら前の空白も外す', () => {
  assert.equal(cut('- 目標の文 ' + L, L), '- 目標の文')
  assert.equal(cut('- 目標の文\t ' + L, L), '- 目標の文')
  assert.equal(cut('> - [ ] 引用の中 ' + L, L), '> - [ ] 引用の中')
})

test('リンクを外す位置：行の途中なら前の空白とリンクだけ', () => {
  assert.equal(cut('- 目標 ' + L + ' 続き', L), '- 目標 続き')
  // リンクのあとに空白が2つ（改行の印）があっても、そのまま残す。
  assert.equal(cut('- 目標 ' + L + '  ', L), '- 目標  ')
})

test('リンクを外す位置：箇条書きの記号やチェックボックスのすぐ後ろなら、記号の空白を残す', () => {
  assert.equal(cut('- ' + L, L), '- ')
  assert.equal(cut('- [ ] ' + L + ' 続き', L), '- [ ] 続き')
  assert.equal(cut('\t- ' + L, L), '\t- ')
  assert.equal(cut(L + ' 文', L), '文')
})

test('リンクを外す位置：前の文字にくっついていれば、リンクだけ', () => {
  assert.equal(cut('- 目標' + L, L), '- 目標')
  assert.equal(cut('- 目標 ' + L + '。', L), '- 目標 。')
})

test('リンクを外す位置：同じ行に2つあれば、指したほうだけ', () => {
  const two = '- A ' + L + ' B ' + L
  assert.equal(cut(two, L, 0), '- A B ' + L)
  assert.equal(cut(two, L, 1), '- A ' + L + ' B')
})

test('リンクを外す位置：範囲が行の外なら null', () => {
  assert.equal(unlinkRange('- a', 0, 5, 9), null)
  assert.equal(unlinkRange('- a', 0, 2, 2), null)
})

const known = new Set(['Tasks/a.md', 'Tasks/b.md', '90_Periodic/2026/Monthly/2026-11.md', 'a.md'])
const MONTH = '90_Periodic/2026/Monthly/2026-11.md'

test('goal・parent のノートの中のリンク：ちょうど1つなら外す変更', () => {
  const text = ['---', 'type: monthly', '---', '## ターゲット', '- 目標 [[Tasks/a|→タスク]]', '- 別 [[Tasks/b|→タスク]]'].join('\n')
  const plan = planUnlinkInNote(text, MONTH, 'Tasks/a.md', known)
  assert.equal(plan.count, 1)
  const after = text.slice(0, plan.change.from) + text.slice(plan.change.to)
  assert.equal(after.split('\n')[4], '- 目標')
  assert.equal(after.split('\n')[5], '- 別 [[Tasks/b|→タスク]]')
})

test('goal・parent のノートの中のリンク：0 か 2つ以上なら外さない', () => {
  assert.deepEqual(planUnlinkInNote('- なし', MONTH, 'Tasks/a.md', known), { count: 0, change: null })
  const two = '- 1 [[Tasks/a|→タスク]]\n- 2 [[Tasks/a]]'
  assert.deepEqual(planUnlinkInNote(two, MONTH, 'Tasks/a.md', known), { count: 2, change: null })
})

test('goal・parent のノートの中のリンク：プロパティ・コード・埋め込みは数えない。Markdown のリンクは数える', () => {
  const text = ['---', 'parent: "[[Tasks/a]]"', '---', '\x60\x60\x60', '[[Tasks/a]]', '\x60\x60\x60', '![[Tasks/a]]', '- [リンク](../../../Tasks/a.md)'].join('\n')
  const links = taskLinksIn(text, MONTH, 'Tasks/a.md', known)
  assert.equal(links.length, 1)
  assert.equal(links[0].text, '[リンク](../../../Tasks/a.md)')
})

test('goal・parent のノートの中のリンク：名前だけのリンクも、今のエディターと同じ規則で解決する', () => {
  // Tasks/a と、一番上の a.md がある。月のノートからの [[a]] は一番上の a.md を指すので、Tasks/a へのリンクではない。
  assert.equal(taskLinksIn('- [[a]]', MONTH, 'Tasks/a.md', known).length, 0)
  assert.equal(taskLinksIn('- [[a]]', 'Tasks/parent.md', 'Tasks/a.md', known).length, 1)
})

test('確認のあいだに文書が変わったら、リンクを見つけ直す', () => {
  const ctx = { notePath: MONTH, taskPath: 'Tasks/a.md', known }
  const text = '- 目標 [[Tasks/a|→タスク]]'
  const at = { from: 5, to: text.length, linkText: '[[Tasks/a|→タスク]]' }
  assert.equal(relocateLink(text, at, ctx).from, 5)
  const shifted = '- 追加\n' + text
  assert.equal(relocateLink(shifted, at, ctx).from, 5 + 5)
  assert.equal(relocateLink('- 目標', at, ctx), null)
  assert.equal(relocateLink(text + '\n' + text, { ...at, from: 0 }, ctx), null)
})

test('リンクを外しに行くノート：parent があれば親、なければ goal', () => {
  assert.deepEqual(sourceNoteOf({ path: 'Tasks/x.md', goal: '[[90_Periodic/2026/Monthly/2026-11]]', parent: '[[Tasks/a]]' }, known), { kind: 'parent', path: 'Tasks/a.md', exists: true })
  assert.deepEqual(sourceNoteOf({ path: 'Tasks/x.md', goal: '[[90_Periodic/2026/Monthly/2026-11]]', parent: '' }, known), { kind: 'goal', path: MONTH, exists: true })
  assert.equal(sourceNoteOf({ path: 'Tasks/x.md', goal: '', parent: '' }, known), null)
  assert.equal(sourceNoteOf({ path: 'Tasks/x.md', goal: '[[消えたノート]]' }, known).exists, false)
})

test('知らせの文', () => {
  assert.match(deleteQuestion({ title: 'T' }), /タスク「T」をゴミ箱へ移します。\n行のリンクも外します。/)
  assert.match(deleteQuestion({ title: 'T', childCount: 2 }), /サブタスクが2件あります/)
  assert.match(deleteQuestion({ title: 'T', unlink: 'none-count', sourceName: '2026-11', linkCount: 2 }), /2つある/)
  assert.match(deleteQuestion({ title: 'T', unlink: 'none-source' }), /goal も parent もない/)
  assert.deepEqual(deleteChoices(0).map((c) => c.value), ['root'])
  assert.deepEqual(deleteChoices(3).map((c) => c.value), ['all', 'root'])
  assert.ok(deleteChoices(3).every((c) => c.label.length <= 5))
  assert.match(deletedText({ title: 'T', movedChildren: 1 }), /とサブタスク1件をゴミ箱へ移しました。.*ノートはゴミ箱にあります/)
  assert.match(deletedText({ title: 'T', undo: false, unlinked: true }), /リンクも外しました。ノートはゴミ箱にあります。$/)
  assert.doesNotMatch(deletedText({ title: 'T', undo: false, unlinked: false }), /元に戻す|リンクも/)
  assert.match(trashFailedText(['Tasks/a.md']), /1件/)
})
