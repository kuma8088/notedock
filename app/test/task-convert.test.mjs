import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState, Text } from '@codemirror/state'

import { MENU_HINT, leftoverText, notLinkedText, planAfterCreate } from '../src/task-convert.mjs'
import { canUndoDirectly, createFailedText, createdText, linkChange, linkRemoval, lineStillThere, menuForLine, reasonText, taskForDocLine, taskLinkText, taskRequestBody } from '../src/task-convert.mjs'
import { expectedTaskPath, moveChanges, moveUndoChange, movedBody } from '../src/task-convert.mjs'
import { Transaction } from '@codemirror/state'
import { history, isolateHistory, undo, undoDepth } from '@codemirror/commands'
import { noteMarkdown } from '../src/markdown-ext.mjs'
import { noteContext, previewField } from '../src/preview.mjs'
import { frontmatterGuard } from '../src/modes.mjs'
import { buildTaskNote } from '../src/tasks.mjs'

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

test('POST のあと：同じ場所ならそこへ、ずれただけなら同じ文字の行へ、ほかはゴミ箱へ', () => {
  const found = { from: 2, to: 6, lineText: '- 目標' }
  const base = { sameNote: true, canWrite: true, found }
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf('a\n- 目標\nb') }), { action: 'link', at: { from: 2, to: 6, lineText: '- 目標' }, moved: false })
  // 上に1行足されて、ずれただけ
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf('new\na\n- 目標\nb') }), { action: 'link', at: { from: 6, to: 10, lineText: '- 目標' }, moved: true })
  // 同じ文字の行が2つある（どちらか分からない）
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf('x\na\n- 目標\n- 目標') }), { action: 'trash', reason: 'changed' })
  // 行が書き換わった
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf('a\n- 目標X\nb') }), { action: 'trash', reason: 'changed' })
  // ノートを切り替えた・保存が止まった（切り替えを先に見る）
  assert.deepEqual(planAfterCreate({ ...base, sameNote: false, canWrite: false, doc: docOf('a\n- 目標') }), { action: 'trash', reason: 'switched' })
  assert.deepEqual(planAfterCreate({ ...base, canWrite: false, doc: docOf('a\n- 目標') }), { action: 'trash', reason: 'stopped' })
})

test('リンクを足さなかったときの知らせは、理由とゴミ箱へ移せたかで分ける', () => {
  assert.match(notLinkedText('switched', { trashed: true, taskPath: 'Tasks/a.md' }), /^作っている間に別のノートを開いたので、リンクは足していません。作ったタスクのノートはゴミ箱へ移しました。/)
  assert.match(notLinkedText('stopped', { trashed: true, taskPath: 'Tasks/a.md' }), /保存が止まった/)
  assert.match(notLinkedText('changed', { trashed: true, taskPath: 'Tasks/a.md' }), /行が書き換わった/)
  assert.match(notLinkedText('changed', { trashed: false, taskPath: 'Tasks/a.md' }), /作ったノート（Tasks\/a\.md）が Tasks に残っています。$/)
  assert.equal(leftoverText('Tasks/a.md'), 'リンクを足せませんでした。作ったノート（Tasks/a.md）が Tasks に残っています。')
  assert.equal(MENU_HINT, 'Shift+右クリックでいつものメニュー')
})


// ---- 入れ子の行をタスクのノートへ移す（段階1-D2） ----

const MARCH = '90_Periodic/2026/Monthly/2026-03.md'

test('移す本文：リンクを新しいノートの場所から直す。末尾は改行1つ', () => {
  const vault = ['90_Periodic/2026/Monthly/2026-03.md', '90_Periodic/2026/Monthly/same.md', 'same.md', 'top.md', '90_Periodic/2026/Weekly/2026-W10.md', 'Tasks/S.md', 'a/2026-03-02-目標.md']
  const found = { title: '目標', children: { lines: [
    '- [[same]] と [[top]] と [[same.md|表示名]]',
    '\t- ![[Pasted image.png]] ![](../../../attachments/a.png) [相対](./same.md) [上から](/top.md)',
    '',
    '- [[Tasks/S|→タスク]] [[2026-W10]] [外](https://example.com/a.md)',
    '- [[2026-03-02-目標]]',
    '\x60[[same]]\x60 のコードの中はそのまま',
  ] } }
  const taskPath = expectedTaskPath(found, '2026-03-02')
  assert.equal(taskPath, 'Tasks/2026-03-02-目標.md')
  const body = movedBody(found, { notePath: MARCH, taskPath, known: new Set(vault) })
  assert.equal(body, [
    // 名前だけで別のノート（Vault の直下の same.md）を指すようになるリンクは、フォルダーつきに直す。同じノートに届くリンクはそのまま
    '- [[90_Periodic/2026/Monthly/same]] と [[top]] と [[90_Periodic/2026/Monthly/same.md|表示名]]',
    // ![[画像]] はそのまま（ノートの一覧にないので）。相対の Markdown のリンク・画像は新しい場所から直す。一番上からのリンクはそのまま
    '\t- ![[Pasted image.png]] ![](../attachments/a.png) [相対](../90_Periodic/2026/Monthly/same.md) [上から](/top.md)',
    '',
    // タスクへのリンク・週のリンク・外のリンクはそのまま
    '- [[Tasks/S|→タスク]] [[2026-W10]] [外](https://example.com/a.md)',
    // 新しいノートと同じ名前のリンク：新しいノートを一覧に足してから見るので、元のノートを指したままになるよう直す
    '- [[a/2026-03-02-目標]]',
    '\x60[[same]]\x60 のコードの中はそのまま',
  ].join('\n') + '\n')
  // 配列の known でも同じ。子がなければ空
  assert.equal(movedBody(found, { notePath: MARCH, taskPath, known: vault }), body)
  assert.equal(movedBody({ title: 'x', children: null }, { notePath: MARCH, taskPath, known: vault }), '')
  assert.equal(movedBody({ title: 'x' }, { notePath: MARCH, taskPath, known: vault }), '')
  // 送る中身：本文があれば body を足す。なければ今までと同じ
  assert.deepEqual(taskRequestBody({ title: 'A', due: '', goal: '[[g]]', parent: '' }, '2026-11-24', '- b\n'), { title: 'A', created: '2026-11-24', goal: '[[g]]', body: '- b\n' })
  assert.deepEqual(taskRequestBody({ title: 'A', due: '', goal: '[[g]]', parent: '' }, '2026-11-24', ''), { title: 'A', created: '2026-11-24', goal: '[[g]]' })
  // 親の goal がないサブタスク：parent だけを送る
  assert.deepEqual(taskRequestBody({ title: 'A', due: '', goal: '', parent: '[[Tasks/p]]' }, '2026-11-24', '- b\n'), { title: 'A', created: '2026-11-24', parent: '[[Tasks/p]]', body: '- b\n' })
})

const NESTED_NOTE = ['## 目標', '- [ ] 目標', '\t- [ ] 下書き', '', '\t\t- [x] 構図', '- [ ] 次'].join('\n')
const ctxOf = (path) => ({ path, periodicRoot: ROOT, known: new Set([path]) })

test('POST のあと（子の行あり）：行と子の行がちょうど同じときだけ、今の位置で移す', () => {
  const found = taskForDocLine(docOf(NESTED_NOTE), 2, ctxOf(MARCH))
  assert.equal(found.children.count, 2)
  const base = { sameNote: true, canWrite: true, found }
  const kids = { from: found.children.from, to: found.children.to, text: found.children.text }
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf(NESTED_NOTE) }), { action: 'link', at: { from: found.from, to: found.to, lineText: '- [ ] 目標' }, moved: false, children: kids })
  // 上に行を足してずれた（子も同じ）
  const shifted = planAfterCreate({ ...base, doc: docOf('上の行\n' + NESTED_NOTE) })
  assert.deepEqual(shifted, { action: 'link', at: { from: found.from + 4, to: found.to + 4, lineText: '- [ ] 目標' }, moved: true, children: { ...kids, from: kids.from + 4, to: kids.to + 4 } })
  // 下に兄弟の行を足しただけなら移せる
  assert.equal(planAfterCreate({ ...base, doc: docOf(NESTED_NOTE + '\n- [ ] 足した兄弟') }).action, 'link')
  const changed = { action: 'trash', reason: 'changed' }
  // 子の行が書き換わった・子の行のあいだに行が足された・最後の子の行に書き足した・子の行が増えた・減った
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf(NESTED_NOTE.replace('構図', '構図を直す')) }), changed)
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf(NESTED_NOTE.replace('\t- [ ] 下書き\n', '\t- [ ] 下書き\n\t- [ ] 足した子\n')) }), changed)
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf(NESTED_NOTE.replace('構図', '構図と線画')) }), changed)
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf(NESTED_NOTE.replace('\n- [ ] 次', '\n\t\t- [ ] 足した孫\n- [ ] 次')) }), changed)
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf(NESTED_NOTE.replace('\n\t\t- [x] 構図', '')) }), changed)
  // 同じ文字の行が2つ（子の行も同じ）
  assert.deepEqual(planAfterCreate({ ...base, doc: docOf('x\n' + NESTED_NOTE + '\n' + NESTED_NOTE) }), changed)
  // 子のない行は今までと同じ形（children を付けない）
  const plain = taskForDocLine(docOf(NESTED_NOTE), 6, ctxOf(MARCH))
  assert.equal(plain.children, null)
  assert.deepEqual(planAfterCreate({ ...base, found: plain, doc: docOf(NESTED_NOTE) }), { action: 'link', at: { from: plain.from, to: plain.to, lineText: '- [ ] 次' }, moved: false })
})

const applyChanges = (text, changes) => EditorState.create({ doc: text }).update({ changes }).state.doc.toString()

test('移す変更：リンクを足すのと子の行を消すのは重ならない。取り消し用の変更で元に戻る', () => {
  const cases = [
    [NESTED_NOTE, 2, '## 目標\n- [ ] 目標 [[Tasks/x|→タスク]]\n- [ ] 次'],
    // 行末に空白があるとき：リンクは空白の前、消すのは行の終わりから
    [NESTED_NOTE.replace('- [ ] 目標', '- [ ] 目標  '), 2, '## 目標\n- [ ] 目標 [[Tasks/x|→タスク]]  \n- [ ] 次'],
    // 引用の中
    ['> - [ ] 目標\n> \t- 子\n>\n> - 兄弟', 1, '> - [ ] 目標 [[Tasks/x|→タスク]]\n>\n> - 兄弟'],
  ]
  for (const [text, line, want] of cases) {
    const found = taskForDocLine(docOf(text), line, ctxOf(MARCH))
    const plan = planAfterCreate({ sameNote: true, canWrite: true, doc: docOf(text), found })
    const changes = moveChanges(plan.at, 'Tasks/x.md', plan.children)
    assert.equal(changes.length, 2)
    assert.ok(changes[0].to <= changes[1].from, '重ならない')
    const after = applyChanges(text, changes)
    assert.equal(after, want)
    // 取り消し用の変更（履歴を使えないとき）：リンクを外し、消した子の行を同じ行の下へ戻す
    assert.equal(applyChanges(after, moveUndoChange(after, 'Tasks/x.md', found.children.text)), text)
  }
  // 子がなければリンクだけ
  assert.deepEqual(moveChanges({ from: 0, to: 4, lineText: '- 目標' }, 'Tasks/x.md', undefined), [{ from: 4, to: 4, insert: ' [[Tasks/x|→タスク]]' }])
  // リンクがない・2つあるときは null。ファイルの終わりの行でも戻せる
  assert.equal(moveUndoChange('- 目標\n- 次', 'Tasks/x.md', '\n  - 子'), null)
  assert.equal(moveUndoChange('- 目標 [[Tasks/x|→タスク]]\n- 目標 [[Tasks/x|→タスク]]', 'Tasks/x.md', '\n  - 子'), null)
  assert.equal(applyChanges('- 目標 [[Tasks/x|→タスク]]', moveUndoChange('- 目標 [[Tasks/x|→タスク]]', 'Tasks/x.md', '\n  - 子')), '- 目標\n  - 子')
})

test('作ったあとの知らせ：移した行があれば行数と、取り消すと戻ること', () => {
  assert.equal(createdText('2026-05-10', { moved: 3 }), '期日 5/10 で作りました。下の行3行をタスクのノートへ移しました。「取り消す」を押すと、リンクを外して移した行を戻します（タスクのノートは Tasks に残ります）。')
  assert.match(createdText('', { moved: 1 }), /^期日なしで作りました。下の行1行を/)
  // 移した行がなければ今までと同じ文
  assert.equal(createdText('2026-05-10', { moved: 0 }), createdText('2026-05-10'))
  assert.equal(createdText('2026-05-10'), '期日 5/10 で作りました。「取り消す」を押すと、行のリンクだけを外します（タスクのノートは Tasks に残ります）。')
})

// エディターと同じ拡張（Markdown・ノートの情報・プレビュー・プロパティの欄を守る決まり・履歴）で、1回の変更にまとめて入れる。
function editorOf(text, path) {
  return EditorState.create({ doc: text, extensions: [noteMarkdown(), noteContext.of({ path, known: new Set([path]) }), previewField, frontmatterGuard, history()] })
}

test('エディターでの変更：1回の変更でリンクを足して子の行を消し、Cmd+Z 1回で戻る。プロパティの欄を守る決まりは止めない', () => {
  const parentProps = { title: '親', due: '2026-06-04', goal: '[[90_Periodic/2026/Monthly/2026-05]]' }
  const taskNote = buildTaskNote(parentProps, '- [ ] 下の行\n  - 孫\n    - ひ孫\n- [ ] 兄弟\n')
  const cases = [
    ['月のノート', MARCH, NESTED_NOTE, '- [ ] 目標', '## 目標\n- [ ] 目標 [[Tasks/x|→タスク]]\n- [ ] 次'],
    ['タスクのノート', 'Tasks/2026-05-01-親.md', taskNote, '- [ ] 下の行', taskNote.replace('- [ ] 下の行\n  - 孫\n    - ひ孫', '- [ ] 下の行 [[Tasks/x|→タスク]]')],
    // 閉じが「--- 」で、プロパティのすぐ次の行を変える
    ['閉じが「--- 」のタスクのノート', 'Tasks/2026-05-01-親.md', taskNote.replace('\n---\n', '\n--- \n'), '- [ ] 下の行', taskNote.replace('\n---\n', '\n--- \n').replace('- [ ] 下の行\n  - 孫\n    - ひ孫', '- [ ] 下の行 [[Tasks/x|→タスク]]')],
    ['引用の中', MARCH, '> [!目標]\n> - [ ] 目標  \n> \t- 子\n> \t\t- 孫\n> - 兄弟', '- [ ] 目標', '> [!目標]\n> - [ ] 目標 [[Tasks/x|→タスク]]  \n> - 兄弟'],
  ]
  for (const [label, path, text, needle, want] of cases) {
    const state = editorOf(text, path)
    const line = text.split('\n').findIndex((row) => row.includes(needle)) + 1
    const found = taskForDocLine(state.doc, line, ctxOf(path))
    assert.equal(found.ok, true, label)
    if (path.startsWith('Tasks/')) assert.equal(found.parent, '[[Tasks/2026-05-01-親]]', label)
    const plan = planAfterCreate({ sameNote: true, canWrite: true, doc: state.doc, found })
    const tr = state.update({ changes: moveChanges(plan.at, 'Tasks/x.md', plan.children), annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.task')] })
    // 欄を守る決まりが止めると、文書が変わらないまま返る。ちょうど期待の文書になることで、止めていないことを確かめる
    assert.equal(tr.state.doc.toString(), want, label)
    assert.equal(undoDepth(tr.state), undoDepth(state) + 1, label)
    let undone = tr.state
    assert.equal(undo({ state: tr.state, dispatch: (t) => (undone = t.state) }), true, label)
    assert.equal(undone.doc.toString(), text, label)
  }
})
