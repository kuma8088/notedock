import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TASK_DEFAULT_STATUS,
  TASK_QUICK_KEYS,
  TASK_STATUSES,
  buildTaskFrontmatter,
  buildTaskNote,
  isTaskDone,
  isTaskNote,
  readTaskProps,
  statusOptions,
  taskFieldKind,
} from '../src/tasks.mjs'
import { parseFrontmatter } from '../src/yaml-lite.mjs'

test('ステータスは4つで、初期値は未着手', () => {
  assert.deepEqual(TASK_STATUSES, ['未着手', '進行中', '完了', '保留'])
  assert.equal(TASK_DEFAULT_STATUS, '未着手')
  assert.deepEqual(TASK_QUICK_KEYS, ['status', 'start', 'due'])
  assert.ok(Object.isFrozen(TASK_STATUSES))
})

test('知らないステータスの値は、そのまま選択肢の先頭に足す', () => {
  assert.deepEqual(statusOptions('進行中'), TASK_STATUSES)
  assert.deepEqual(statusOptions('done'), ['done', ...TASK_STATUSES])
  assert.deepEqual(statusOptions('未着手 # メモ'), ['未着手 # メモ', ...TASK_STATUSES])
  assert.deepEqual(statusOptions(''), ['', ...TASK_STATUSES])
  assert.deepEqual(statusOptions(undefined), ['', ...TASK_STATUSES])
  assert.equal(isTaskDone('完了'), true)
  assert.equal(isTaskDone('done'), false)
})

test('type: task のノートだけをタスクとして見分ける', () => {
  assert.equal(isTaskNote('---\ntitle: a\ntype: task\n---\n本文'), true)
  assert.equal(isTaskNote('---\ntype: "task"\n---\n'), true)
  assert.equal(isTaskNote('---\ntype: design-memo\n---\n'), false)
  assert.equal(isTaskNote('---\ntype:\n  - task\n---\n'), false)
  assert.equal(isTaskNote('type: task\n'), false)
  assert.equal(isTaskNote(''), false)
})

test('タスクのノートでは、項目の名前で欄を決める', () => {
  assert.equal(taskFieldKind('status', '未着手'), 'status')
  assert.equal(taskFieldKind('status', 'done'), 'status')
  assert.equal(taskFieldKind('due', ''), 'date')
  assert.equal(taskFieldKind('start', '2026-11-25'), 'date')
  // 日付でない値は、隠さないように今までの欄に任せる。
  assert.equal(taskFieldKind('due', '2026-11-30 # 仮'), null)
  assert.equal(taskFieldKind('due', '2026-11-30 10:00'), null)
  // title は数字やチェックの形でも文字の欄。
  assert.equal(taskFieldKind('title', '2026'), 'text')
  assert.equal(taskFieldKind('title', 'true'), 'text')
  assert.equal(taskFieldKind('goal', '[[x]]'), null)
  assert.equal(taskFieldKind('status', ['a']), null)
})

test('タスクのノートのプロパティを組み立てる', () => {
  const front = buildTaskFrontmatter({ title: '11月の動画を1本公開する', start: '2026-11-25', due: '2026-11-30', goal: '90_Periodic/2026/Monthly/2026-11.md' })
  assert.equal(
    front,
    '---\ntitle: 11月の動画を1本公開する\ntype: task\nstatus: 未着手\nstart: 2026-11-25\ndue: 2026-11-30\ngoal: "[[90_Periodic/2026/Monthly/2026-11]]"\n---',
  )
  const empty = buildTaskFrontmatter({ title: 'x' })
  assert.equal(empty, '---\ntitle: x\ntype: task\nstatus: 未着手\nstart:\ndue:\n---')
  const child = buildTaskFrontmatter({ title: 'y', goal: '[[a/b]]', parent: 'Tasks/2026-11-24-親' })
  assert.match(child, /^parent: "\[\[Tasks\/2026-11-24-親\]\]"$/m)
  assert.equal(parseFrontmatter(child).simple, true)
})

test('組み立てたノートを読み直すと同じ値になる（題名の引用符・コロン・バックスラッシュを含む）', () => {
  const props = { title: '6/4 動画公開。"本番": ¥1,000 \\ 🎬', status: '進行中', start: '', due: '2026-06-04', goal: '[[90_Periodic/2026/Monthly/2026-05]]', parent: '[[Tasks/2026-05-01-親]]' }
  const text = buildTaskNote(props, '- [ ] サブタスク\n')
  assert.ok(text.endsWith('---\n- [ ] サブタスク\n'))
  assert.equal(isTaskNote(text), true)
  assert.deepEqual(readTaskProps(text), props)
  assert.equal(readTaskProps('---\ntype: note\n---\n'), null)
  assert.equal(buildTaskNote({ title: 'z' }), '---\ntitle: z\ntype: task\nstatus: 未着手\nstart:\ndue:\n---\n')
})
