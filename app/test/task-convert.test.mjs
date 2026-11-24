import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState, Text } from '@codemirror/state'

import { canUndoDirectly, createFailedText, createdText, linkChange, linkRemoval, lineStillThere, menuForLine, reasonText, taskForDocLine, taskLinkText, taskRequestBody } from '../src/task-convert.mjs'

const ROOT = '90_Periodic'
const MONTH = '90_Periodic/2026/Monthly/2026-05.md'
const known = new Set([MONTH, 'Tasks/2026-11-24-既存.md'])
const NOTE = [
  '---',
  'month: 2026-05',
  '---',
  '',
  '## Target',
  '',
  '- [ ] 週4本配信 × 4-5週 = **16-20本公開**',
  '- [[2026-W18]] (5/4-5/10)',
  '\t- YouTube',
  '\t\t- [ ] 動画4本公開  ',
  '- ',
  '- もうある [[Tasks/2026-11-24-既存|→タスク]]',
].join('\n')

const docOf = (text) => EditorState.create({ doc: text }).doc

test('タスクにできる行だけメニューを出す', () => {
  const doc = docOf(NOTE)
  const ctx = { path: MONTH, periodicRoot: ROOT, known }
  assert.equal(menuForLine(taskForDocLine(doc, 7, ctx)), true)
  assert.equal(menuForLine(taskForDocLine(doc, 5, ctx)), false) // 見出し
  assert.equal(menuForLine(taskForDocLine(doc, 8, ctx)), false) // 週のリンクの行
  assert.equal(menuForLine(taskForDocLine(doc, 9, ctx)), true) // 分野の行も箇条書きなので選べる
  assert.equal(menuForLine(taskForDocLine(doc, 11, ctx)), false) // 中身のない行
  assert.equal(menuForLine(taskForDocLine(doc, 12, ctx)), false) // もうリンクがある
  assert.equal(menuForLine(taskForDocLine(doc, 2, ctx)), false) // プロパティ
  assert.equal(menuForLine(taskForDocLine(doc, 0, ctx)), false)
  assert.equal(menuForLine(taskForDocLine(doc, 99, ctx)), false)
  assert.equal(menuForLine(taskForDocLine(doc, 7, { ...ctx, path: 'メモ.md' })), false)
})

test('週のリンクの下の行は (M/D-M/D) の終わりの日が期日になる', () => {
  const found = taskForDocLine(docOf(NOTE), 10, { path: MONTH, periodicRoot: ROOT, known })
  assert.equal(found.ok, true)
  assert.equal(found.due, '2026-05-10')
  assert.equal(found.goal, '[[90_Periodic/2026/Monthly/2026-05]]')
})

test('CRLF のノートでも、エディターの文書の位置と行がずれない', () => {
  // サーバーは CRLF のノートを LF にそろえて渡すが、CRLF のまま文書を作っても CodeMirror は LF の文書にする。
  const crlf = NOTE.replace(/\n/g, '\r\n')
  const doc = docOf(crlf)
  const found = taskForDocLine(doc, 10, { path: MONTH, periodicRoot: ROOT, known })
  assert.equal(found.ok, true)
  assert.equal(doc.sliceString(found.from, found.to), found.lineText)
  assert.equal(found.lineText.includes('\r'), false)
  assert.equal(doc.line(10).from, found.from)
  // 足したリンクは同じ行の末尾に入る。
  const change = linkChange(found, 'Tasks/2026-11-24-動画4本公開.md')
  const next = EditorState.create({ doc }).update({ changes: change }).state.doc
  assert.equal(next.line(10).text, '\t\t- [ ] 動画4本公開 [[Tasks/2026-11-24-動画4本公開|→タスク]]  ')
  assert.equal(next.line(11).text, '- ')
})

test('リンクの文字は、返った path から .md を外す（番号つき・フォルダー名もそのまま）', () => {
  assert.equal(taskLinkText('Tasks/2026-11-24-動画.md'), '[[Tasks/2026-11-24-動画|→タスク]]')
  assert.equal(taskLinkText('tasks/2026-11-24-動画-2.md'), '[[tasks/2026-11-24-動画-2|→タスク]]')
  assert.equal(taskLinkText('Tasks/a.MD'), '[[Tasks/a|→タスク]]')
})

test('行末の空白の前にリンクを入れる', () => {
  assert.deepEqual(linkChange({ from: 10, lineText: '- 目標' }, 'Tasks/x.md'), { from: 14, to: 14, insert: ' [[Tasks/x|→タスク]]' })
  assert.deepEqual(linkChange({ from: 0, lineText: '- 目標  ' }, 'Tasks/x.md'), { from: 4, to: 4, insert: ' [[Tasks/x|→タスク]]' })
  assert.deepEqual(linkChange({ from: 0, lineText: '> - 目標\t' }, 'Tasks/x.md').from, 6)
})

test('作っている間に行が変わったら、照合に失敗する', () => {
  const doc = docOf('a\n- 目標\nb')
  const found = { from: 2, to: 6, lineText: '- 目標' }
  assert.equal(lineStillThere(doc, found), true)
  assert.equal(lineStillThere(docOf('a\n- 目標x\nb'), found), false)
  assert.equal(lineStillThere(docOf('aa\n- 目標\nb'), found), false) // 上で1文字増えて場所がずれた
  assert.equal(lineStillThere(docOf('a\n- 目'), found), false) // 短くなった
  assert.equal(lineStillThere(docOf('a\n- 目標'), found), true)
  // 同じ文字でも、行の途中に入ったものは別の行。
  assert.equal(lineStillThere(docOf('a\nx- 目標'), { from: 3, to: 7, lineText: '- 目標' }), false)
})

test('送る中身は空の値を入れない', () => {
  assert.deepEqual(taskRequestBody({ title: 'A', due: '', goal: '[[g]]', parent: '' }, '2026-11-24'), { title: 'A', created: '2026-11-24', goal: '[[g]]' })
  assert.deepEqual(taskRequestBody({ title: 'A', due: '2026-05-10', goal: '[[g]]', parent: '[[p]]' }, '2026-11-24'), { title: 'A', created: '2026-11-24', due: '2026-05-10', goal: '[[g]]', parent: '[[p]]' })
})

test('知らせの文', () => {
  assert.match(createdText('2026-05-10'), /^期日 5\/10 で作りました。/)
  assert.match(createdText(''), /^期日なしで作りました。/)
  assert.match(createdText(undefined), /^期日なしで作りました。/)
  assert.match(createdText('2026-05-10'), /Tasks に残ります/)
  assert.equal(reasonText('heading').includes('見出し'), true)
  assert.equal(typeof reasonText('unknown'), 'string')
  assert.match(createFailedText(400, 'tasks-folder'), /Tasks というフォルダーを作れませんでした/)
  assert.match(createFailedText(409), /多すぎて/)
  assert.equal(createFailedText(500), 'タスクのノートを作れませんでした。')
})

test('取り消し：作った直後と同じなら履歴で戻す。違えばリンクの文字だけを外す', () => {
  const doc = Text.of(['a'])
  assert.equal(canUndoDirectly({ doc, depth: 3 }, { doc, depth: 3 }), true)
  assert.equal(canUndoDirectly({ doc, depth: 3 }, { doc: Text.of(['b']), depth: 3 }), false)
  assert.equal(canUndoDirectly({ doc, depth: 3 }, { doc, depth: 4 }), false)
  const text = '- 目標 [[Tasks/x|→タスク]]\n- 次'
  assert.deepEqual(linkRemoval(text, 'Tasks/x.md'), { from: 4, to: 21, insert: '' })
  assert.equal(linkRemoval('- 目標', 'Tasks/x.md'), null)
  assert.equal(linkRemoval(text + '\n' + text, 'Tasks/x.md'), null)
})
