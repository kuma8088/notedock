import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DATE_FIELD_IDLE,
  TASK_DEFAULT_STATUS,
  TASK_STATUSES,
  buildTaskFrontmatter,
  buildTaskNote,
  dateFieldStep,
  frontmatterBlock,
  isDateTypingKey,
  isTaskDone,
  isTaskNote,
  propsRowAccess,
  readTaskProps,
  statusOptions,
  taskFieldKind,
} from '../src/tasks.mjs'
import { parseFrontmatter } from '../src/yaml-lite.mjs'

test('ステータスは4つで、初期値は未着手', () => {
  assert.deepEqual(TASK_STATUSES, ['未着手', '進行中', '完了', '保留'])
  assert.equal(TASK_DEFAULT_STATUS, '未着手')
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
    '---\ntitle: "11月の動画を1本公開する"\ntype: task\nstatus: 未着手\nstart: 2026-11-25\ndue: 2026-11-30\ngoal: "[[90_Periodic/2026/Monthly/2026-11]]"\n---',
  )
  const empty = buildTaskFrontmatter({ title: 'x' })
  assert.equal(empty, '---\ntitle: "x"\ntype: task\nstatus: 未着手\nstart:\ndue:\n---')
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
  assert.equal(buildTaskNote({ title: 'z' }), '---\ntitle: "z"\ntype: task\nstatus: 未着手\nstart:\ndue:\n---\n')
  // 本文の末尾は改行1つで終える（改行で終わっていれば足さない）。頭の改行は外す。改行だけの本文は本文なしと同じ
  assert.ok(buildTaskNote({ title: 'z' }, '- a').endsWith('---\n- a\n'))
  assert.ok(buildTaskNote({ title: 'z' }, '\n\n- a\n').endsWith('---\n- a\n'))
  assert.ok(buildTaskNote({ title: 'z' }, '- a\n\n').endsWith('---\n- a\n\n'))
  assert.equal(buildTaskNote({ title: 'z' }, '\n\n'), buildTaskNote({ title: 'z' }))
})

// YAML として読み違えやすい題名。引用符なしだと、リスト・真偽値・数・null・日付・別の項目として読まれうる。
const TRICKY_TITLES = ['やること:', 'a:', '- foo', '? a', '-', 'true', 'yes', 'No', 'null', '~', '2026', '.5', '0x1F', '2026-11-24', '6/4 動画公開。', '**太字** の行', '"q" x', '', 'a\\"b', '末尾が \\']

test('題名はいつも二重引用符で書き、読み直すと同じ文字に戻る', () => {
  for (const title of TRICKY_TITLES) {
    const front = buildTaskFrontmatter({ title })
    const line = front.split('\n')[1]
    assert.match(line, /^title: "(?:[^"\\]|\\["\\])*"$/, line)
    assert.equal(parseFrontmatter(front).simple, true, front)
    assert.equal(readTaskProps(front + '\n').title, title, front)
    assert.equal(isTaskNote(front), true)
  }
})

test('項目の名前は小文字だけを対象にする（Type・Status などは対象外）', () => {
  assert.equal(isTaskNote('---\nType: task\n---\n'), false)
  assert.equal(taskFieldKind('Status', '未着手'), null)
  assert.equal(taskFieldKind('DUE', '2026-11-30'), null)
  assert.equal(readTaskProps('---\ntype: task\nStatus: 完了\n---\n').status, '')
})

test('プロパティ欄の1行を直せるか（画面が編集できるか・入れ子があるか・動かしている間か で決まる）', () => {
  // 画面が編集できて、入れ子がなく、動かしていなければ、すべて直せる。
  assert.deepEqual(propsRowAccess({ viewEditable: true, simple: true, busy: false }), { full: true, value: true })
  // どれか1つでも外れたら、どれも直せない（タスクの status・start・due も同じ。閲覧の表示だけの決まりはなくした）。
  for (const viewEditable of [true, false]) {
    for (const simple of [true, false]) {
      for (const busy of [true, false]) {
        const ok = viewEditable && simple && !busy
        assert.deepEqual(propsRowAccess({ viewEditable, simple, busy }), { full: ok, value: ok }, JSON.stringify({ viewEditable, simple, busy }))
      }
    }
  }
  // 何も渡さないときは、画面が編集できないものとして扱う。
  assert.deepEqual(propsRowAccess(), { full: false, value: false })
})

test('日付の欄で「打った」とみなすキー', () => {
  for (const key of ['0', '9', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) assert.equal(isDateTypingKey(key), true, key)
  for (const key of ['Tab', 'Enter', 'Shift', 'Meta', 'Control', 'z', 'Escape', ' ', 'Process', '10', undefined]) assert.equal(isDateTypingKey(key), false, String(key))
})

test('日付の欄の確定：選んだらすぐ、打ったら欄を離れるか Enter', () => {
  const run = (events) => {
    let state = DATE_FIELD_IDLE
    const commits = []
    events.forEach((event, i) => {
      const next = dateFieldStep(state, event)
      state = { typed: next.typed, pending: next.pending }
      if (next.commit) commits.push(i)
    })
    return { commits, state }
  }
  // カレンダーから選んだ（キーを打っていない）：change ですぐ確定。
  assert.deepEqual(run([{ type: 'change', focused: true }]).commits, [0])
  // 数字を打っている途中の change は待ち、blur で1回だけ確定。
  const typed = run([{ type: 'keydown', key: '2' }, { type: 'change', focused: true }, { type: 'keydown', key: '0' }, { type: 'change', focused: true }, { type: 'blur' }])
  assert.deepEqual(typed.commits, [4])
  assert.deepEqual(typed.state, DATE_FIELD_IDLE)
  // Enter でも確定。そのあとの blur では書かない。
  assert.deepEqual(run([{ type: 'keydown', key: '2' }, { type: 'change', focused: true }, { type: 'keydown', key: 'Enter' }, { type: 'blur' }]).commits, [2])
  // 打ったが change が来ていない（日付として成り立っていない）なら、blur・Enter で書かない。
  assert.deepEqual(run([{ type: 'keydown', key: '2' }, { type: 'blur' }]).commits, [])
  assert.deepEqual(run([{ type: 'keydown', key: '2' }, { type: 'keydown', key: 'Enter' }]).commits, [])
  // Tab・Cmd+Z（z）・Shift などでは「打った」にならず、そのあと選べばすぐ確定する。
  assert.deepEqual(run([{ type: 'keydown', key: 'Tab' }, { type: 'keydown', key: 'Meta' }, { type: 'keydown', key: 'z' }, { type: 'change', focused: true }]).commits, [3])
  // 変換中のキーは数えない。
  assert.deepEqual(run([{ type: 'keydown', key: '2', composing: true }, { type: 'change', focused: true }]).commits, [1])
  // 欄の外（フォーカスがない）で来た change はすぐ確定。
  assert.deepEqual(run([{ type: 'keydown', key: 'Backspace' }, { type: 'change', focused: false }]).commits, [1])
  // Backspace で空にして離れる：空の値を確定する（日付を消す手段として、仕様として残す）。
  assert.deepEqual(run([{ type: 'keydown', key: 'Backspace' }, { type: 'change', focused: true }, { type: 'blur' }]).commits, [2])
})

test('先頭のプロパティの部分（frontmatterBlock）：行末の空白を許し、閉じは --- だけ', () => {
  assert.equal(frontmatterBlock('---\ntype: task\n---\n本文'), '---\ntype: task\n---')
  assert.equal(frontmatterBlock('---\ntype: task\n---'), '---\ntype: task\n---')
  // 開き・閉じの行末の空白・タブ
  assert.equal(frontmatterBlock('--- \ntype: task\n---\t \n本文'), '--- \ntype: task\n---\t ')
  // 閉じがない・'...' は閉じにしない・1行目が --- でない
  assert.equal(frontmatterBlock('---\ntype: task\n本文'), null)
  assert.equal(frontmatterBlock('---\ntype: task\n...\n本文'), null)
  assert.equal(frontmatterBlock('---\ntype: task\n...\n---\n'), '---\ntype: task\n...\n---')
  assert.equal(frontmatterBlock(' ---\ntype: task\n---'), null)
  assert.equal(frontmatterBlock('---x\ntype: task\n---'), null)
  assert.equal(frontmatterBlock('---\ntype: task\n---x\n'), null)
  assert.equal(frontmatterBlock('---'), null)
  assert.equal(frontmatterBlock(''), null)
  assert.equal(frontmatterBlock(undefined), null)
  // 閉じは最初の --- の行
  assert.equal(frontmatterBlock('---\na: 1\n---\n---\n'), '---\na: 1\n---')
  // 閉じの --- の行末に空白があっても、タスクのノートとして読める
  assert.equal(isTaskNote('---\ntitle: a\ntype: task\n--- \n本文'), true)
  assert.equal(isTaskNote('--- \ntype: task\n---\n'), true)
  assert.equal(isTaskNote('---\ntype: task\n...\n'), false)
  assert.deepEqual(readTaskProps('---\ntitle: "a"\ntype: task\nstatus: 進行中\ndue: 2026-06-04\ngoal: "[[g]]"\n---  \n本文'), { title: 'a', status: '進行中', start: '', due: '2026-06-04', goal: '[[g]]', parent: '' })
  assert.equal(readTaskProps('---\ntype: task\n'), null)
})
