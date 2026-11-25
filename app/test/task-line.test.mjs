import assert from 'node:assert/strict'
import test from 'node:test'

import {
  analyzeLines,
  ancestorsOf,
  childRange,
  childrenOf,
  cutBytes,
  dedentChildren,
  goalTextOf,
  hasTaskLink,
  isStruck,
  isWeekLinkOnly,
  taskFileName,
  taskFromLine,
  taskNameSlug,
  taskSourceOf,
  weekDue,
  weekLinksOf,
} from '../src/task-line.mjs'
import { buildTaskNote, readTaskProps } from '../src/tasks.mjs'
import { compareNesting, markdown } from './nesting-lezer.mjs'
import { frontmatterEnd } from '../src/modes.mjs'
import { Text } from '@codemirror/state'

const ROOT = '90_Periodic'
const lineOf = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle)) + 1
const at = (path, text, needle, extra = {}) => {
  const line = lineOf(text, needle)
  assert.ok(line > 0, '見つからない行：' + needle)
  return taskFromLine({ path, text, line, periodicRoot: ROOT, ...extra })
}

// 実物（2026-05 の月のノート）の書き方をまねた例。中身は架空の文に置き換えた。
const MAY = [
  '---',
  'month: 2026-05',
  'period: 2026-05-01 (Fri) - 2026-05-31 (Sun)',
  'tags:',
  '  - monthly-plan',
  '---',
  '',
  '## Target',
  '',
  '> 5月は「**練習の習慣化**」が大きなテーマ。',
  '',
  '> [!収益目標]',
  '> - **¥10,000**（教室¥6K + 物販¥4K）',
  '> - ',
  '',
  '### 1. 🎨 絵の練習（最優先）',
  '',
  '- [ ] 週3回 × 4週 = **12回描く**',
  '- [ ] 全作品に **下描き3段階** を当てる（[[下描きは3段階に分けると早い]]）',
  '  - Phase 1: 構図（0:00-0:15）',
  '- [ ] 6/4 作品展へ出す。',
  '',
  '**主軸メッセージ**: 「描くのは毎日。」',
  '',
  '\x60\x60\x60text',
  '- [ ] コードの中の行',
  '\x60\x60\x60',
  '',
  '## Reverse Planning',
  '',
  '- [[2026-W18]] (5/4-5/10)',
  '\t- 絵',
  '\t\t- [ ] 4枚描く',
  '- [[2026-W19]] (5/11-5/17)',
  '  - [ ] 2スペースの字下げの行',
  '- [[2026-W20]]',
  '  - [ ] 期間を書いていない週の下',
  '- ',
  '- [ ] ~~ギャラリーの下見~~ → 火曜に移動',
  '- [ ] 文の途中の ~~取り消し~~ は選べる',
  '- [ ] 画材を買う [[Tasks/2026-05-01-画材を買う|→タスク]]',
  '- [ ] 表示名を変えたリンク [[tasks/2026-05-01-額縁|済]]',
  '- [ ] 名前だけのリンク [[2026-05-02-下見]]',
  '- [ ] ほかのノートへのリンクだけ [[Notes/画材の一覧|→タスク]]',
  '1. 番号つきの行',
  '* 星の記号の行',
].join('\n')
const MAY_PATH = '90_Periodic/2026/Monthly/2026-05.md'

test('週・月・四半期のノートの箇条書きと引用の中の箇条書きは、タスクにできる', () => {
  const quoted = at(MAY_PATH, MAY, '¥10,000')
  assert.equal(quoted.ok, true)
  assert.equal(quoted.title, '**¥10,000**（教室¥6K + 物販¥4K）')
  assert.equal(quoted.due, '2026-05-31')
  assert.equal(quoted.goal, '[[90_Periodic/2026/Monthly/2026-05]]')
  assert.equal(quoted.parent, '')
  assert.equal(quoted.source, 'periodic')
  const box = at(MAY_PATH, MAY, '12回描く')
  assert.equal(box.title, '週3回 × 4週 = **12回描く**')
  const link = at(MAY_PATH, MAY, '下描き3段階')
  assert.equal(link.title, '全作品に **下描き3段階** を当てる（[[下描きは3段階に分けると早い]]）')
  // チェックボックスのない入れ子の行もできる。
  assert.equal(at(MAY_PATH, MAY, 'Phase 1').title, 'Phase 1: 構図（0:00-0:15）')
  assert.equal(at(MAY_PATH, MAY, '番号つきの行').title, '番号つきの行')
  assert.equal(at(MAY_PATH, MAY, '星の記号の行').title, '星の記号の行')
  assert.equal(at(MAY_PATH, MAY, '途中の').ok, true)
})

test('行の位置と文字を返す（画面は書き換える前に同じか確かめる）', () => {
  const result = at(MAY_PATH, MAY, '4枚描く')
  assert.equal(result.lineText, '\t\t- [ ] 4枚描く')
  assert.equal(MAY.slice(result.from, result.to), result.lineText)
  assert.equal(result.line, lineOf(MAY, '4枚描く'))
})

test('タスクにできない行', () => {
  const reason = (needle) => at(MAY_PATH, MAY, needle).reason
  assert.equal(reason('month: 2026-05'), 'front')
  assert.equal(reason('  - monthly-plan'), 'front')
  assert.equal(reason('## Target'), 'heading')
  assert.equal(reason('### 1. 🎨'), 'heading')
  assert.equal(reason('[!収益目標]'), 'callout')
  assert.equal(reason('練習の習慣化'), 'not-list')
  assert.equal(reason('主軸メッセージ'), 'not-list')
  assert.equal(reason('コードの中の行'), 'code')
  assert.equal(reason('\x60\x60\x60text'), 'code')
  assert.equal(reason('[[2026-W18]] (5/4-5/10)'), 'week-link')
  assert.equal(reason('[[2026-W20]]'), 'week-link')
  assert.equal(reason('ギャラリーの下見'), 'struck')
  assert.equal(reason('画材を買う'), 'has-task-link')
  assert.equal(reason('表示名を変えた'), 'has-task-link')
  // 中身のない行（テンプレートの「- 」だけ、引用の中の「> - 」だけ）
  const lines = MAY.split('\n')
  assert.equal(taskFromLine({ path: MAY_PATH, text: MAY, line: lines.indexOf('- ') + 1, periodicRoot: ROOT }).reason, 'empty')
  assert.equal(taskFromLine({ path: MAY_PATH, text: MAY, line: lines.indexOf('> - ') + 1, periodicRoot: ROOT }).reason, 'empty')
  assert.equal(taskFromLine({ path: MAY_PATH, text: MAY, line: lines.indexOf('') + 1, periodicRoot: ROOT }).reason, 'not-list')
  assert.equal(taskFromLine({ path: MAY_PATH, text: MAY, line: 999, periodicRoot: ROOT }).reason, 'no-line')
  assert.equal(taskFromLine({ path: MAY_PATH, text: MAY, line: 0, periodicRoot: ROOT }).reason, 'no-line')
})

test('すでにタスクへのリンクがあるかは、表示名ではなくリンク先で判定する', () => {
  const known = new Set(['Tasks/2026-05-02-下見.md', 'Notes/画材の一覧.md', MAY_PATH])
  assert.equal(at(MAY_PATH, MAY, '名前だけのリンク', { known }).reason, 'has-task-link')
  // known がないと、名前だけのリンクは Vault の一番上を指すとみなす。
  assert.equal(at(MAY_PATH, MAY, '名前だけのリンク').ok, true)
  // 表示名が「→タスク」でも、リンク先が Tasks/ の外なら選べる。
  assert.equal(at(MAY_PATH, MAY, 'ほかのノートへのリンクだけ', { known }).ok, true)
  assert.equal(hasTaskLink('[x](../../../Tasks/a.md)', MAY_PATH), true)
  assert.equal(hasTaskLink('[x](https://example.com/Tasks/a.md)', MAY_PATH), false)
  assert.equal(hasTaskLink('![[Tasks/a]]', MAY_PATH), true)
  assert.equal(hasTaskLink('[[TasksX/a]]', MAY_PATH), false)
  // タスクのノートの中では、名前だけのリンクは同じフォルダー（Tasks/）を先に探す。
  assert.equal(hasTaskLink('[[b]]', 'Tasks/a.md', new Set(['Tasks/a.md', 'Tasks/b.md'])), true)
})

test('期日：親の箇条書きの週のリンクの横の (M/D-M/D) の終わりの日', () => {
  // 2026-05 の [[2026-W18]] (5/4-5/10)。ISO の W18 は 4/27〜5/3 だが、書いてある終わりの日を使う。
  assert.equal(at(MAY_PATH, MAY, '4枚描く').due, '2026-05-10')
  assert.equal(at(MAY_PATH, MAY, '\t- 絵').due, '2026-05-10')
  assert.equal(at(MAY_PATH, MAY, '2スペースの字下げの行').due, '2026-05-17')
  // (M/D-M/D) がなければ、週の名前の ISO の日曜。
  assert.equal(at(MAY_PATH, MAY, '期間を書いていない週の下').due, '2026-05-17')
  // 週のリンクの下にない行は、そのノートの期間の最終日（月末）。
  assert.equal(at(MAY_PATH, MAY, '6/4 作品展').due, '2026-05-31')
  assert.equal(at(MAY_PATH, MAY, '途中の').due, '2026-05-31')
})

// 2026-03 の月のノートの書き方（タブの字下げ、引用の見出しの下のチェックボックス、注記つきの週の行）。
const MARCH = [
  '---',
  'month:',
  '---',
  '## Target',
  '',
  '> [!Q. いちばん大事なものを1つ書いてください。]',
  '> - [ ] 💰**収益目標：1万円(教室: $50)**',
  '',
  '- 【最優先】練習の流れを作る',
  '\t- [ ] 作品を3枚仕上げる',
  '\t\t- [x] 小さい絵 x 1',
  '\t※ 流れが回っていることが前提。',
  '',
  '## Reverse Planning',
  '',
  '> [!Q. 達成した未来から、さかのぼって短期の目標を決めてください。]',
  '',
  '- [[2026-W13]] (3/23-3/31) ※9日間',
  '\t- 絵',
  '\t\t- [x] 下描き・色塗り',
  '- [[2026-W14]]',
  '\t- [ ] 来週の準備',
  '- [[90_Periodic/2026/Weekly/2026-W12|第12週]] (3/16-3/22)',
  '\t- [ ] パスと表示名つきの週のリンク',
].join('\n')
const MARCH_PATH = '90_Periodic/2026/Monthly/2026-03.md'

test('2026-03 の書き方：引用の見出し・タブの字下げ・注記つきの週の行', () => {
  assert.equal(at(MARCH_PATH, MARCH, '[!Q. いちばん').reason, 'callout')
  const money = at(MARCH_PATH, MARCH, '収益目標')
  assert.equal(money.ok, true)
  assert.equal(money.title, '💰**収益目標：1万円(教室: $50)**')
  assert.equal(money.due, '2026-03-31')
  assert.equal(at(MARCH_PATH, MARCH, '小さい絵').title, '小さい絵 x 1')
  assert.equal(at(MARCH_PATH, MARCH, '※ 流れ').reason, 'not-list')
  assert.equal(at(MARCH_PATH, MARCH, '[[2026-W13]]').reason, 'week-link')
  // 週の行が2段上。(3/23-3/31) は ISO の日曜（3/29）とずれているが、書いてある日を使う。
  assert.equal(at(MARCH_PATH, MARCH, '下描き・色塗り').due, '2026-03-31')
  assert.equal(at(MARCH_PATH, MARCH, '来週の準備').due, '2026-04-05')
  assert.equal(at(MARCH_PATH, MARCH, '第12週').reason, 'week-link')
  assert.equal(at(MARCH_PATH, MARCH, 'パスと表示名つき').due, '2026-03-22')
})

test('期日：年またぎ・成り立たない日付・成り立たない週', () => {
  const dec = [
    '- [[2026-W53]] (12/28-1/3)',
    '\t- [ ] 年をまたぐ週',
    '- [[2026-W01]] (12/29-1/4)',
    '\t- [ ] 前の年から始まる週',
    '- [[2026-W09]] (2/23-2/30)',
    '\t- [ ] 成り立たない日付',
    '- [[2025-W53]] (12/29-1/4)',
    '\t- [ ] 成り立たない週',
    '- [[2026-W52]] (12/21-12/27)',
    '\t- [[2025-W53]]',
    '\t\t- [ ] 成り立たない週の上の週',
  ].join('\n')
  const decPath = '90_Periodic/2026/Monthly/2026-12.md'
  assert.equal(at(decPath, dec, '年をまたぐ週').due, '2027-01-03')
  assert.equal(at(decPath, dec, '前の年から始まる週').due, '2026-01-04')
  assert.equal(at(decPath, dec, '成り立たない日付').due, '2026-03-01')
  // 週として成り立たない名前は、期日には使わない（ノートの期間の最終日になる）。行そのものは週の行として選べない。
  assert.equal(at(decPath, dec, '成り立たない週').due, '2026-12-31')
  assert.equal(at(decPath, dec, '[[2025-W53]] (12/29-1/4)').reason, 'week-link')
  assert.equal(at(decPath, dec, '成り立たない週の上の週').due, '2026-12-27')
  // 翌年のノートに書いた同じ週
  assert.equal(at('90_Periodic/2027/Monthly/2027-01.md', dec, '年をまたぐ週').due, '2027-01-03')
  assert.equal(weekDue('2026-W53', null), '2027-01-03')
  assert.equal(weekDue('2026-W53', { month: 1, day: 3 }), '2027-01-03')
  assert.equal(weekDue('2027-W01', { month: 1, day: 10 }), '2027-01-10')
  assert.equal(weekDue('2027-W09', { month: 2, day: 29 }), '2027-03-07')
  assert.equal(weekDue('2028-W09', { month: 2, day: 29 }), '2028-02-29')
  assert.equal(weekDue('2026-W10', { month: 13, day: 1 }), '2026-03-08')
  assert.equal(weekDue('2025-W53', { month: 1, day: 4 }), null)
})

test('期日：週のリンクがなければノートの期間の最終日（週末・月末・四半期末）', () => {
  const text = '- [ ] 行'
  const due = (path) => taskFromLine({ path, text, line: 1, periodicRoot: ROOT }).due
  assert.equal(due('90_Periodic/2026/Weekly/2026-W14.md'), '2026-04-05')
  assert.equal(due('90_Periodic/2026/Weekly/2026-W53.md'), '2027-01-03')
  assert.equal(due('90_Periodic/2026/Monthly/2026-02.md'), '2026-02-28')
  assert.equal(due('90_Periodic/2028/Monthly/2028-02.md'), '2028-02-29')
  assert.equal(due('90_Periodic/2026/Monthly/2026-04.md'), '2026-04-30')
  assert.equal(due('90_Periodic/2026/Quarterly/2026-Q1.md'), '2026-03-31')
  assert.equal(due('90_Periodic/2026/Quarterly/2026-Q2.md'), '2026-06-30')
  assert.equal(due('90_Periodic/2026/Quarterly/2026-Q4.md'), '2026-12-31')
  // フォルダーの大文字小文字は問わない
  assert.equal(due('90_periodic/2026/monthly/2026-04.md'), '2026-04-30')
})

test('2026-W14・2026-Q2 の書き方（優先度の見出しの下、曜日の見出しの下、取り消し線）', () => {
  const week = [
    '## ターゲット',
    '[[2026-04]]',
    '',
    '### 🔴 MUST',
    '- 練習（毎日 🔥）',
    '\t- [ ] 絵を7枚（1日1枚）',
    '',
    '---',
    '### 月（3/30 Mon）',
    '#### 仕事',
    '- [x] #絵 1枚目 — 公開済み',
    '- [ ] ~~月の振り返り~~ → 火曜に移動',
  ].join('\n')
  const path = '90_Periodic/2026/Weekly/2026-W14.md'
  assert.equal(at(path, week, '練習（毎日').title, '練習（毎日 🔥）')
  assert.equal(at(path, week, '絵を7枚').due, '2026-04-05')
  assert.equal(at(path, week, '1枚目').title, '#絵 1枚目 — 公開済み')
  assert.equal(at(path, week, '月の振り返り').reason, 'struck')
  assert.equal(at(path, week, '[[2026-04]]').reason, 'not-list')
  const quarter = ['## Target', '> - [ ] 📊**品質：毎週3枚以上**', '### 1. 🎬 絵', '- [ ] 週3枚の維持（Q2で36枚）', '  - 構図の型を3つ'].join('\n')
  const qPath = '90_Periodic/2026/Quarterly/2026-Q2.md'
  assert.equal(at(qPath, quarter, '品質').due, '2026-06-30')
  assert.equal(at(qPath, quarter, '構図の型').due, '2026-06-30')
  assert.equal(at(qPath, quarter, '構図の型').goal, '[[90_Periodic/2026/Quarterly/2026-Q2]]')
})

test('タスクのノートの行：goal を引き継ぎ、parent にそのノート、期日は親の due', () => {
  const parent = buildTaskNote({ title: '作品展へ出す', status: '未着手', due: '2026-06-04', goal: '[[90_Periodic/2026/Monthly/2026-05]]' }) + '\n- [ ] 額縁を選ぶ\n- [ ] [[Tasks/2026-05-03-搬入|→タスク]]\n'
  const result = at('Tasks/2026-05-01-作品展へ出す.md', parent, '額縁を選ぶ')
  assert.equal(result.ok, true)
  assert.equal(result.source, 'task')
  assert.equal(result.goal, '[[90_Periodic/2026/Monthly/2026-05]]')
  assert.equal(result.parent, '[[Tasks/2026-05-01-作品展へ出す]]')
  assert.equal(result.due, '2026-06-04')
  assert.equal(at('Tasks/2026-05-01-作品展へ出す.md', parent, '搬入').reason, 'has-task-link')
  assert.equal(at('Tasks/2026-05-01-作品展へ出す.md', parent, 'title:').reason, 'front')
  // 親の due がなければ空。goal がなければ空。
  const bare = buildTaskNote({ title: 'メモ' }) + '\n- 下の行\n'
  const sub = at('Tasks/memo.md', bare, '下の行')
  assert.equal(sub.due, '')
  assert.equal(sub.goal, '')
  assert.equal(sub.parent, '[[Tasks/memo]]')
  // タスクのノートとして扱うのは Tasks/ の下だけ（フォルダー名の大文字小文字は問わない）。
  assert.equal(at('Other/t.md', bare, '下の行').reason, 'no-source')
  assert.equal(at('TasksX/t.md', bare, '下の行').reason, 'no-source')
  assert.equal(at('tasks/sub/t.md', bare, '下の行').ok, true)
  assert.equal(at('TASKS/t.md', bare, '下の行').parent, '[[TASKS/t]]')
})

test('サブタスクの作成：parent が自分を指す・輪になった親・親の due がない／日付でない・親の goal がない', () => {
  // parent が自分を指すタスクのノート：goal は写すだけで、parent はたどらない（止まらない）
  const self = buildTaskNote({ title: '自分', due: '2026-06-04', goal: '[[90_Periodic/2026/Monthly/2026-05]]', parent: '[[Tasks/self]]' }) + '- [ ] 下の行\n  - 孫\n'
  const fromSelf = at('Tasks/self.md', self, '下の行')
  assert.equal(fromSelf.ok, true)
  assert.equal(fromSelf.parent, '[[Tasks/self]]')
  assert.equal(fromSelf.goal, '[[90_Periodic/2026/Monthly/2026-05]]')
  assert.equal(fromSelf.due, '2026-06-04')
  assert.deepEqual(fromSelf.children.lines, ['- 孫'])
  // A.parent=B・B.parent=A の輪：A の行から作れる。goal は A の値をそのまま
  const a = buildTaskNote({ title: 'A', goal: '[[g]]', parent: '[[Tasks/B]]' }) + '- [ ] Aの行\n'
  assert.deepEqual([at('Tasks/A.md', a, 'Aの行').parent, at('Tasks/A.md', a, 'Aの行').goal], ['[[Tasks/A]]', '[[g]]'])
  // 親の due が日付でなければ空（期日なし）
  const odd = '---\ntitle: "親"\ntype: task\nstatus: 未着手\ndue: あした\n---\n- [ ] 下の行\n'
  assert.equal(at('Tasks/odd.md', odd, '下の行').due, '')
  assert.equal(at('Tasks/odd.md', '---\ntitle: "親"\ntype: task\ndue: 2026-02-30\n---\n- [ ] 下の行\n', '下の行').due, '')
  // 親の goal がなければ parent だけで作る
  const noGoal = at('Tasks/odd.md', odd, '下の行')
  assert.equal(noGoal.goal, '')
  assert.equal(noGoal.parent, '[[Tasks/odd]]')
})

test('週・月・四半期・タスクのノート以外では作れない', () => {
  const text = '- [ ] 行'
  const reason = (path, periodicRoot = ROOT) => taskFromLine({ path, text, line: 1, periodicRoot }).reason
  assert.equal(reason('90_Periodic/2026/Daily/2026-05-01.md'), 'no-source')
  assert.equal(reason('90_Periodic/2026/2026.md'), 'no-source')
  assert.equal(reason('Notes/a.md'), 'no-source')
  assert.equal(reason('90_Periodic/2026/Monthly/2026-13.md'), 'no-source')
  assert.equal(reason('90_Periodic/2026/Monthly/2027-01.md'), 'no-source')
  assert.equal(reason('90_Periodic/2026/Monthly/2026-05.md', null), 'no-source')
  assert.equal(taskSourceOf({ path: '90_Periodic/2026/Monthly/2026-05.md', text, periodicRoot: ROOT }).kind, 'periodic')
  assert.equal(taskSourceOf({ path: 'Notes/a.md', text: '---\ntype: memo\n---\n', periodicRoot: ROOT }), null)
})

test('行の種類の読み分け', () => {
  const rows = analyzeLines('~~~\n- a\n~~~\n> \x60\x60\x60\n> - b\n> \x60\x60\x60\n    # 字下げの中の#\n- c')
  assert.deepEqual(rows.map((row) => row.kind), ['code', 'code', 'code', 'code', 'code', 'code', 'text', 'list'])
  const list = analyzeLines('- a\n\t- b\n    - c\n  - d')
  assert.deepEqual(ancestorsOf(list, 2).map((row) => row.body), ['a'])
  assert.deepEqual(ancestorsOf(list, 3).map((row) => row.body), ['a'])
  assert.deepEqual(analyzeLines('- a\n\t- b\n\t\t- c').map((row) => row.indent), [0, 4, 8])
  // 見出しで止まる
  assert.deepEqual(ancestorsOf(analyzeLines('- [[2026-W10]]\n## 見出し\n\t- x'), 2), [])
})

test('期日：項目の下に字下げして書いた引用の中の行も、引用の外の親の週のリンクを使う', () => {
  const path = '90_Periodic/2026/Monthly/2026-03.md'
  const text = [
    '- [[2026-W10]] (3/2-3/8)',
    '  > - [ ] 引用の中の目標',
    '  >   - [ ] 引用の中の子',
    '\t> - [ ] タブの字下げの引用',
    '- [[2026-W11]] (3/9-3/15)',
    '  > メモ',
    '  >',
    '  > - [ ] 引用の中で間に行がある',
    '- 週のない項目',
    '  > - [ ] 引用の外の親に週のリンクがない',
    '> - [ ] 字下げのない引用',
    '',
    '- [[2026-W12]] (3/16-3/22)',
    '    > - [ ] 引用の外の親より4つ深い',
  ].join('\n')
  const due = (needle) => at(path, text, needle).due
  assert.equal(due('引用の中の目標'), '2026-03-08')
  assert.equal(due('引用の中の子'), '2026-03-08')
  assert.equal(due('タブの字下げの引用'), '2026-03-08')
  assert.equal(due('引用の中で間に行がある'), '2026-03-15')
  assert.equal(due('引用の外の親に週のリンクがない'), '2026-03-31')
  // 字下げのない引用は、前の項目の中身ではない（今までどおり、ノートの期間の最終日）
  assert.equal(due('字下げのない引用'), '2026-03-31')
  assert.equal(due('引用の外の親より4つ深い'), '2026-03-22')
  const rows = analyzeLines(text)
  assert.deepEqual(ancestorsOf(rows, 2).map((row) => row.body), ['引用の中の目標', '[[2026-W10]] (3/2-3/8)'])
  assert.deepEqual(ancestorsOf(rows, 10), [])
})

test('目標の文の取り出し', () => {
  assert.equal(goalTextOf('> - [ ] **太字** [[リンク]] 🎨 ¥1,000 6/4 公開。'), '**太字** [[リンク]] 🎨 ¥1,000 6/4 公開。')
  assert.equal(goalTextOf('\t\t- [x] 済んだ'), '済んだ')
  assert.equal(goalTextOf('>> 1. 番号'), '番号')
  assert.equal(goalTextOf('- [ ]'), '')
})

test('週のリンクだけの行と、取り消し線の行', () => {
  assert.equal(isWeekLinkOnly('[[2026-W10]] (3/2-3/8)'), true)
  assert.equal(isWeekLinkOnly('[[2026-W10]]（3/2〜3/8）'), true)
  assert.equal(isWeekLinkOnly('**[[2026-W10]]** (3/2-3/8)'), true)
  assert.deepEqual(weekLinksOf('**[[2026-W10]]** (3/2-3/8)')[0].range, { month: 3, day: 8 })
  assert.equal(isWeekLinkOnly('[[2026-W13]] (3/23-3/31) ※9日間'), true)
  assert.equal(isWeekLinkOnly('[[2026-W10]] までに動画を出す'), false)
  assert.equal(isWeekLinkOnly('[[2026-05]]'), false)
  assert.deepEqual(weekLinksOf('[[2026-W10]] (3/2 - 3/8)')[0].range, { month: 3, day: 8 })
  assert.equal(weekLinksOf('[[2026-W10]] 3/2-3/8')[0].range, null)
  assert.equal(isStruck('~~下見~~ → 火曜に移動'), true)
  assert.equal(isStruck('~~全部消した~~'), true)
  assert.equal(isStruck('途中の ~~語~~ だけ'), false)
  assert.equal(isStruck('~~閉じていない'), false)
})

test('ファイル名：取り除く文字・太字の記号・リンクの括弧', () => {
  assert.equal(taskNameSlug('a/b#c|d[e]f:g\\h<i>j"k?l*m'), 'a-bcdef-ghijklm')
  assert.equal(taskNameSlug('3/9 19:00 公開'), '3-9 19-00 公開')
  assert.equal(taskNameSlug('~~消す~~ \x60コード\x60 ^脚注'), '消す コード 脚注')
  assert.equal(taskNameSlug('[資料](https://example.com/a?b=1)を読む'), '資料を読む')
  assert.equal(taskNameSlug('![図](img/a.png) と [[Notes/b|リンク]]'), '図 と リンク')
  assert.equal(taskNameSlug('**太字**と__下線の太字__'), '太字と下線の太字')
  assert.equal(taskNameSlug('[[下描きは早い]]を読む'), '下描きは早いを読む')
  assert.equal(taskNameSlug('[[Notes/画材の一覧|画材]]を買う'), '画材を買う')
  assert.equal(taskNameSlug('[[Notes/画材の一覧#赤]]'), '画材の一覧')
  assert.equal(taskNameSlug('6/4 作品展へ出す。'), '6-4 作品展へ出す。')
  assert.equal(taskNameSlug('💰**収益目標：1万円(教室: $50)**'), '💰収益目標：1万円(教室- $50)')
  assert.equal(taskNameSlug('タブ\tと  空白'), 'タブ と 空白')
  assert.equal(taskNameSlug('改行\nの文'), '改行 の文')
  assert.equal(taskNameSlug('a / b'), 'a - b')
  assert.equal(taskFileName('**12回描く**', '2026-05-03'), '2026-05-03-12回描く.md')
  assert.equal(taskFileName('同じ', '2026-05-03', 2), '2026-05-03-同じ-2.md')
  assert.throws(() => taskFileName('x', '2026-02-30'))
  assert.throws(() => taskFileName('x', '../../x'))
})

test('ファイル名：先頭の . と、末尾の . と空白・何も残らないとき・予約名', () => {
  assert.equal(taskNameSlug('...隠し.'), '隠し')
  assert.equal(taskNameSlug('  前後の空白 . . '), '前後の空白')
  assert.equal(taskNameSlug('///'), 'タスク')
  assert.equal(taskNameSlug('- / -'), 'タスク')
  assert.equal(taskNameSlug('/x'), 'x')
  assert.equal(taskNameSlug(''), 'タスク')
  assert.equal(taskNameSlug('CON'), 'CON_')
  assert.equal(taskNameSlug('nul.txt'), 'nul_.txt')
  assert.equal(taskNameSlug('com1'), 'com1_')
  assert.equal(taskNameSlug('LPT9 .md'), 'LPT9_.md')
  assert.equal(taskNameSlug('CONCERT'), 'CONCERT')
  assert.equal(taskFileName('.', '2026-05-03'), '2026-05-03-タスク.md')
})

const bytes = (text) => new TextEncoder().encode(text).length
const graphemes = (text) => [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)

test('ファイル名：長さは60文字（書記素）で切り、拡張子と番号を含めて255バイト。絵文字や結合文字を割らない', () => {
  const long = 'あ'.repeat(100)
  const name = taskFileName(long, '2026-05-03')
  assert.ok(bytes(name) <= 255)
  assert.equal(name, '2026-05-03-' + 'あ'.repeat(60) + '.md')
  assert.equal(taskFileName('a'.repeat(100), '2026-05-03', 3), '2026-05-03-' + 'a'.repeat(60) + '-3.md')
  // 60文字でも 255 バイトを超えるとき（家族の絵文字は1文字で25バイト）は、バイト数で切る
  const families = taskFileName('👨‍👩‍👧‍👦'.repeat(60), '2026-05-03')
  assert.ok(bytes(families) <= 255)
  assert.equal(graphemes(families.slice(11, -3)).length, 9)
  for (let n = 2; n <= 120; n += 9) assert.ok(bytes(taskFileName(long, '2026-05-03', n)) <= 255, String(n))
  // 家族の絵文字（ZWJ でつないだもの）と国旗、濁点を結合文字で書いたもの
  const family = '👨‍👩‍👧‍👦'
  const pieces = [family, '🇯🇵', 'が']
  for (const piece of pieces) {
    for (let pad = 0; pad < 12; pad++) {
      const title = 'x'.repeat(pad) + piece.repeat(40)
      const cut = taskFileName(title, '2026-05-03').slice(11, -3)
      assert.ok(bytes(taskFileName(title, '2026-05-03')) <= 255)
      const want = graphemes(title.normalize('NFC'))
      const got = graphemes(cut)
      assert.deepEqual(got, want.slice(0, got.length), piece + ' ' + pad)
    }
  }
  // 切ったあとの末尾の空白と . も外す
  const spaced = 'あ'.repeat(58) + ' .いいい'
  assert.equal(taskFileName(spaced, '2026-05-03'), '2026-05-03-' + 'あ'.repeat(58) + '.md')
  assert.equal(cutBytes('🇯🇵🇯🇵', 9), '🇯🇵')
  assert.equal(cutBytes('🇯🇵', 7), '')
})

test('作る中身は、title が往復しても変わらない', () => {
  for (const title of ['He said "hi": ok \\ x', '**¥10,000**（教室）', '[[リンク]] # です', '2026', 'true']) {
    const text = buildTaskNote({ title, due: '2026-05-10', goal: '[[90_Periodic/2026/Monthly/2026-05]]', parent: '[[Tasks/a]]' })
    const props = readTaskProps(text)
    assert.equal(props.title, title)
    assert.equal(props.goal, '[[90_Periodic/2026/Monthly/2026-05]]')
    assert.equal(props.parent, '[[Tasks/a]]')
  }
})

test('U+2028・U+2029・CR を含む行でも落ちない', () => {
  const text = '- [[2026-W10]] (3/2-3/8)\r\n\t- [ ] 行の\u2028中で\u2029区切る\r\n- [ ] 終わり\r'
  const path = '90_Periodic/2026/Monthly/2026-03.md'
  const rows = analyzeLines(text)
  assert.deepEqual(rows.map((row) => row.kind), ['list', 'list', 'list'])
  const mid = taskFromLine({ path, text, line: 2, periodicRoot: ROOT })
  assert.equal(mid.ok, true)
  assert.equal(mid.title, '行の\u2028中で\u2029区切る')
  assert.equal(mid.due, '2026-03-08')
  assert.equal(taskFromLine({ path, text, line: 3, periodicRoot: ROOT }).title, '終わり')
  assert.equal(goalTextOf('> - [ ] a\u2028b'), 'a\u2028b')
  assert.equal(isWeekLinkOnly('[[2026-W10]] (3/2-3/8) ※注記\u2028続き'), true)
  assert.equal(taskNameSlug('a\u2028b\u2029c\rd'), 'a b c d')
  // CRLF のノートの先頭のプロパティ
  const front = analyzeLines('---\r\ntags:\r\n  - monthly-plan\r\n---\r\n- [ ] x\r')
  assert.deepEqual(front.map((row) => row.kind), ['front', 'front', 'front', 'front', 'list'])
  assert.equal(taskFromLine({ path, text: '---\r\ntags:\r\n  - a\r\n---\r\n- [ ] x', line: 3, periodicRoot: ROOT }).reason, 'front')
})

test('期日：横に書いた終わりの日が ISO の日曜から14日より離れていたら ISO の日曜', () => {
  // 2026-W10 の ISO の日曜は 3/8
  assert.equal(weekDue('2026-W10', { month: 3, day: 22 }), '2026-03-22')
  assert.equal(weekDue('2026-W10', { month: 2, day: 22 }), '2026-02-22')
  assert.equal(weekDue('2026-W10', { month: 3, day: 23 }), '2026-03-08')
  assert.equal(weekDue('2026-W10', { month: 2, day: 21 }), '2026-03-08')
  assert.equal(weekDue('2026-W10', { month: 8, day: 3 }), '2026-03-08')
  const text = '- [[2026-W10]] (3/2-4/8)\n\t- [ ] 書き間違えた週'
  assert.equal(taskFromLine({ path: '90_Periodic/2026/Monthly/2026-03.md', text, line: 2, periodicRoot: ROOT }).due, '2026-03-08')
})

test('期日：親に週のリンクがないときだけ、その行自身の週のリンクを使う', () => {
  const text = [
    '- [ ] [[2026-W11]] (3/9-3/15) までに出す',
    '- [[2026-W10]] (3/2-3/8)',
    '\t- [ ] [[2026-W12]] の準備',
    '- 絵',
    '\t- [ ] [[2026-W12]] に描く',
    '\t- [ ] [[2025-W53]] 成り立たない週',
  ].join('\n')
  const path = '90_Periodic/2026/Monthly/2026-03.md'
  const due = (needle) => at(path, text, needle).due
  assert.equal(due('までに出す'), '2026-03-15')
  assert.equal(due('の準備'), '2026-03-08')
  assert.equal(due('に描く'), '2026-03-22')
  assert.equal(due('成り立たない週'), '2026-03-31')
})

test('さかのぼる途中の箇条書きでない行は飛ばす。見出し・区切り線・引用の深さの違いでは止まる', () => {
  const text = [
    '- [[2026-W10]] (3/2-3/8)',
    '※ 注記の行',
    '\t- [ ] 注記の下の行',
    '- [[2026-W11]] (3/9-3/15)',
    '## 見出し',
    '\t- [ ] 見出しの下の行',
    '- [[2026-W12]] (3/16-3/22)',
    '* * *',
    '\t- [ ] 区切り線の下の行',
    '- [[2026-W13]] (3/23-3/29)',
    '> \t- [ ] 引用の中の行',
  ].join('\n')
  const path = '90_Periodic/2026/Monthly/2026-03.md'
  const due = (needle) => at(path, text, needle).due
  assert.equal(due('注記の下の行'), '2026-03-08')
  assert.equal(due('見出しの下の行'), '2026-03-31')
  assert.equal(due('区切り線の下の行'), '2026-03-31')
  assert.equal(due('引用の中の行'), '2026-03-31')
  assert.deepEqual(ancestorsOf(analyzeLines('- a\n\tメモ\n\t\t- b'), 2).map((row) => row.body), ['a'])
})

test('区切り線と、チェックボックスの記号', () => {
  const rows = analyzeLines('* * *\n- - -\n***\n> - - -\n- [ ] a\n- [x] b\n- [X] c\n- [/] d\n- [-] e\n- [?] f\n- [>] g\n-  -')
  assert.deepEqual(rows.map((row) => row.kind), ['rule', 'rule', 'rule', 'rule', 'list', 'list', 'list', 'list', 'list', 'list', 'list', 'list'])
  assert.deepEqual(rows.slice(4).map((row) => row.checkbox), [true, true, true, true, true, false, false, false])
  assert.deepEqual(rows.slice(4).map((row) => row.body), ['a', 'b', 'c', 'd', 'e', '[?] f', '[>] g', '-'])
  const path = '90_Periodic/2026/Monthly/2026-03.md'
  assert.equal(taskFromLine({ path, text: '- - -', line: 1, periodicRoot: ROOT }).reason, 'not-list')
  assert.equal(taskFromLine({ path, text: '* * *', line: 1, periodicRoot: ROOT }).reason, 'not-list')
  assert.equal(goalTextOf('- [?] 問い'), '[?] 問い')
})

// ---- 入れ子の行（段階1-D1） ----

// needle を含む行の子の行（文字の配列）。子がなければ null。
const kidsOf = (text, needle) => {
  const rows = analyzeLines(text)
  const index = rows.findIndex((row) => row.text.includes(needle))
  assert.ok(index >= 0, '見つからない行：' + needle)
  const range = childRange(rows, index)
  return range ? rows.slice(range.first, range.last + 1).map((row) => row.text) : null
}

test('子の行の範囲：タブ・2スペース・混在・空の行・見出し', () => {
  assert.deepEqual(kidsOf('- a\n\t- b\n\t\t- c\n- d', '- a'), ['\t- b', '\t\t- c'])
  assert.deepEqual(kidsOf('- a\n\t- b\n\t\t- c\n- d', '- b'), ['\t\t- c'])
  assert.deepEqual(kidsOf('- a\n  - b\n    - c\n- d', '- a'), ['  - b', '    - c'])
  // タブ1つとスペース4つは同じ幅。タブのあとのスペースもそろえて数える
  assert.deepEqual(kidsOf('\t- a\n    - 兄弟\n\t\t- c\n  \t- d\n- e', '- a'), null)
  assert.deepEqual(kidsOf('\t- a\n    - 兄弟\n\t\t- c\n  \t\t- d\n- e', '兄弟'), ['\t\t- c', '  \t\t- d'])
  // 字下げした続きの文も子（目標の文は1行目だけ）
  assert.deepEqual(kidsOf('- a\n  続き\n  - b\n- c', '- a'), ['  続き', '  - b'])
  // 字下げのない続きの文（怠惰な続きの行）は子ではない
  assert.deepEqual(kidsOf('- a\n続き\n- c', '- a'), null)
  // あいだの空の行は含め、空の行のあとの浅い行で止まる。末尾の空の行は含めない
  assert.deepEqual(kidsOf('- a\n  - b\n\n  - c\n- d', '- a'), ['  - b', '', '  - c'])
  assert.deepEqual(kidsOf('- a\n  - b\n\n次の段落', '- a'), ['  - b'])
  assert.deepEqual(kidsOf('- a\n  - b\n\n\n## 見出し', '- a'), ['  - b'])
  assert.deepEqual(kidsOf('- a\n  - b\n  \n\t\n', '- a'), ['  - b'])
  // 見出しで止まる。字下げした見出しと「  ---」は子
  assert.deepEqual(kidsOf('- a\n  - b\n## 見出し\n  - c', '- a'), ['  - b'])
  assert.deepEqual(kidsOf('- a\n  ## 小見出し\n  - b\n  ---\n- c', '- a'), ['  ## 小見出し', '  - b', '  ---'])
  // ファイルの終わり（改行なし）
  assert.deepEqual(kidsOf('- a\n  - b', '- a'), ['  - b'])
  assert.equal(kidsOf('- a', '- a'), null)
  assert.equal(kidsOf('- a\n- b', '- a'), null)
})

test('子の行の範囲：注記・分野の行・取り消し行・番号の項目・英字の項目', () => {
  // 字下げした ※ の行は子。字下げが同じ ※ の行は兄弟（子ではない）。字下げなしの ※ の行も子ではない
  assert.deepEqual(kidsOf('- a\n\t- b\n\t\t※ 注記\n- c', '- b'), ['\t\t※ 注記'])
  assert.equal(kidsOf('- a\n\t- b\n\t※ 注記\n- c', '- b'), null)
  assert.deepEqual(kidsOf('- a\n\t- b\n\t※ 注記\n- c', '- a'), ['\t- b', '\t※ 注記'])
  assert.equal(kidsOf('- [ ] a\n※ 注記', '- [ ] a'), null)
  // チェックボックスのない分野の行の子
  assert.deepEqual(kidsOf('- 分野\n\t- [ ] x\n\t- [x] y\n- 次の分野', '分野'), ['\t- [ ] x', '\t- [x] y'])
  assert.deepEqual(kidsOf('- a\n\t~~- [ ] x~~\n- b', '- a'), ['\t~~- [ ] x~~'])
  // 番号の項目の下の2スペース（プレビューでは入れ子にならないが、見た目どおり子にする）・1スペース・6スペース
  assert.deepEqual(kidsOf('1. a\n  - b\n2. c', '1. a'), ['  - b'])
  assert.deepEqual(kidsOf('1. a\n   - b\n2. c', '1. a'), ['   - b'])
  assert.deepEqual(kidsOf('- a\n - b', '- a'), [' - b'])
  assert.deepEqual(kidsOf('- a\n      - b\n- c', '- a'), ['      - b'])
  assert.deepEqual(kidsOf('- a\n  a. x\n  b. y\n- b', '- a'), ['  a. x', '  b. y'])
})

test('子の行の範囲：引用の中', () => {
  assert.deepEqual(kidsOf('> - a\n> \t- b\n> \t\t- c\n> - d', '- a'), ['> \t- b', '> \t\t- c'])
  // 引用の「>」だけの行は空の行と同じ。末尾なら含めない
  assert.deepEqual(kidsOf('> - a\n>   - b\n>\n>   - c\n> - d', '- a'), ['>   - b', '>', '>   - c'])
  assert.deepEqual(kidsOf('> - a\n>   - b\n>\n> - d', '- a'), ['>   - b'])
  // 引用の深さが違う行で止まる
  assert.deepEqual(kidsOf('> - a\n>   - b\n- c', '- a'), ['>   - b'])
  assert.deepEqual(kidsOf('> - a\n>>   - b', '- a'), null)
  assert.deepEqual(kidsOf('- a\n>   - b', '- a'), null)
  assert.deepEqual(kidsOf('>\t- a\n>\t\t- b', '- a'), ['>\t\t- b'])
})

test('子の行の範囲：コードの囲み・数式・コメント・先頭のプロパティ', () => {
  const fence = '\x60\x60\x60'
  assert.deepEqual(kidsOf('- a\n  ' + fence + '\n  code\n  ' + fence + '\n- b', '- a'), ['  ' + fence, '  code', '  ' + fence])
  // 中に空の行があるコードの囲み（analyzeLines は空の行を 'code'・字下げ0にする）でも、囲みの途中で切れない
  assert.deepEqual(kidsOf('- a\n  ' + fence + '\n  x\n\n  y\n  ' + fence + '\n- b', '- a'), ['  ' + fence, '  x', '', '  y', '  ' + fence])
  // 字下げのないコードの囲みは子ではない
  assert.equal(kidsOf('- a\n' + fence + '\n- x\n' + fence + '\n- b', '- a'), null)
  assert.deepEqual(kidsOf('- a\n  $$\n  x\n  $$\n- b', '- a'), ['  $$', '  x', '  $$'])
  assert.deepEqual(kidsOf('- a\n  %% c\n  %%\n- b', '- a'), ['  %% c', '  %%'])
  // 先頭のプロパティの中には入らない（閉じのないプロパティは最後まで 'front'）
  const rows = analyzeLines('---\ntags:\n  - a\n---\n- x\n  - y')
  assert.deepEqual(childRange(rows, 4), { first: 5, last: 5 })
  assert.equal(childRange(rows, 99), null)
})

test('子の行の範囲：項目の下に字下げして書いた引用と、コードの囲みの中の > の行（lezer の読み方と同じ）', () => {
  const fence = '\x60\x60\x60'
  // 項目の下に字下げして書いた引用は子。中の「>」だけの行も引用の一部（空の行として扱わない）
  const quoted = '- a\n  > 引用\n  >\n  > 続き\n- b'
  assert.deepEqual(kidsOf(quoted, '- a'), ['  > 引用', '  >', '  > 続き'])
  assert.deepEqual(childrenOf(quoted, 0).lines, ['> 引用', '>', '> 続き'])
  assert.equal(childrenOf(quoted, 0).count, 3)
  assert.deepEqual(kidsOf('- a\n  > 引用\n  >\n- b', '- a'), ['  > 引用', '  >'])
  // コードの囲みの中に「  > x」の行があっても、囲みの途中で切れない
  const coded = '- a\n  ' + fence + '\n  > x\n\n  y\n  ' + fence + '\n- b'
  assert.deepEqual(kidsOf(coded, '- a'), ['  ' + fence, '  > x', '', '  y', '  ' + fence])
  assert.deepEqual(childrenOf(coded, 0).lines, [fence, '> x', '', 'y', fence])
  // 選んだ行が引用の中でも同じ
  const inQuote = '> - a\n>   > 引用\n>   >\n>   > 続き\n> - b'
  assert.deepEqual(childrenOf(inQuote, 0).lines, ['> 引用', '>', '> 続き'])
  const fenceInQuote = '> - a\n>   ' + fence + '\n>   > x\n>   ' + fence + '\n> - b'
  assert.deepEqual(childrenOf(fenceInQuote, 0).lines, [fence, '> x', fence])
  // 字下げのない引用・選んだ行と同じ字下げの引用は子ではない
  assert.equal(kidsOf('- a\n> 引用', '- a'), null)
  assert.equal(kidsOf('\t- a\n\t> 引用', '- a'), null)
  // 囲みの中の行が浅くても、囲みごと子にする。いちばん浅い幅は囲みの中の行と閉じの行では決めない
  const shallow = '\t- a\n\t\t- b\n\t\t' + fence + '\ncode\n\t' + fence + '\n- c'
  assert.deepEqual(kidsOf(shallow, '- a'), ['\t\t- b', '\t\t' + fence, 'code', '\t' + fence])
  assert.deepEqual(childrenOf(shallow, 0).lines, ['- b', fence, 'code', fence])
  // 閉じのない囲みは、囲みとして扱わず、ほかの行と同じく字下げで止める
  assert.deepEqual(kidsOf('- a\n  ' + fence + '\n  x\n- b\n  y', '- a'), ['  ' + fence, '  x'])
  // 隣り合う2つの囲み：2つ目が字下げなしなら、そこで止まる
  assert.deepEqual(kidsOf('- a\n  ' + fence + '\n  x\n  ' + fence + '\n' + fence + '\n- z\n' + fence, '- a'), ['  ' + fence, '  x', '  ' + fence])
  // lezer の ListItem と同じ範囲になる
  for (const text of [quoted, coded, inQuote, fenceInQuote]) assert.deepEqual(compareNesting(text).diffs, [], text)
})

test('字下げの外し方：いちばん浅い行の幅をそろえて外す・引用の > を外す・空の行', () => {
  assert.deepEqual(dedentChildren(['\t- b', '\t\t- c']), ['- b', '\t- c'])
  assert.deepEqual(dedentChildren(['\t\t- [x] b', '\t\t- [x] c']), ['- [x] b', '- [x] c'])
  assert.deepEqual(dedentChildren(['  - b', '    - c', '  続き']), ['- b', '  - c', '続き'])
  // タブが境目をまたぐときは、はみ出した分を空白で書く。外したあとにタブの止まる位置がずれる行も、幅を空白で書く
  assert.deepEqual(dedentChildren(['  - b', '\t- c', '\t\t- d']), ['- b', '  - c', '      - d'])
  assert.deepEqual(dedentChildren(['  - b', '  \t- c']), ['- b', '  - c'])
  // 幅がタブの止まる位置（4の倍数）なら、残りのタブはそのまま
  assert.deepEqual(dedentChildren(['    - b', '    \t- c', '\t\t- d']), ['- b', '\t- c', '\t- d'])
  // 引用の >（> の後ろの空白かタブ1つも）を、選んだ行と同じ数だけ外す
  assert.deepEqual(dedentChildren(['> \t- b', '>', '> \t\t- c'], 1), ['- b', '', '\t- c'])
  assert.deepEqual(dedentChildren(['>> \t- b', '> > \t\t- c', '>>'], 2), ['- b', '\t- c', ''])
  assert.deepEqual(dedentChildren(['>\t\t- b'], 1), ['- b'])
  // 選んだ行より深い引用の「>」だけの行は空にしない（1つの引用が2つに分かれないように）
  assert.deepEqual(dedentChildren(['  > a', '  >', '  > b']), ['> a', '>', '> b'])
  assert.deepEqual(dedentChildren(['> \t> a', '> \t>', '>'], 1), ['> a', '>', ''])
  // loose の行（コードの囲みの中の行）は、いちばん浅い幅を決めるのに使わず、浅ければ字下げを全部外す
  assert.deepEqual(dedentChildren(['\t\t\x60\x60\x60', 'x', '  y', '\t\t\t z', '\t\t\x60\x60\x60'], 0, new Set([1, 2, 3, 4])), ['\x60\x60\x60', 'x', 'y', '\t z', '\x60\x60\x60'])
  // 空の行は空にする（空白だけの行も）
  assert.deepEqual(dedentChildren(['  - b', '   ', '', '  - c']), ['- b', '', '', '- c'])
  // 子の行の中身（コードの中の空白など）は変えない
  assert.deepEqual(dedentChildren(['  \x60\x60\x60', '    x\t= 1', '  \x60\x60\x60']), ['\x60\x60\x60', '  x\t= 1', '\x60\x60\x60'])
})

test('childrenOf と taskFromLine の children', () => {
  const text = '- [ ] 目標\n\t- [ ] 下書き\n\n\t\t- [x] 構図\n\n- [ ] 次'
  const kids = childrenOf(text, 0)
  assert.deepEqual(kids, { from: 8, to: 31, text: '\n\t- [ ] 下書き\n\n\t\t- [x] 構図', lines: ['- [ ] 下書き', '', '\t- [x] 構図'], count: 2 })
  assert.equal(text.slice(0, kids.from) + text.slice(kids.to), '- [ ] 目標\n\n- [ ] 次')
  assert.equal(childrenOf(text, 5), null)
  const path = '90_Periodic/2026/Monthly/2026-03.md'
  const found = taskFromLine({ path, text, line: 1, periodicRoot: ROOT })
  assert.deepEqual(found.children, kids)
  assert.equal(taskFromLine({ path, text, line: 6, periodicRoot: ROOT }).children, null)
  // 引用の中
  const quoted = '> - [ ] 目標\n> \t- 子\n>\n> - 兄弟'
  assert.deepEqual(taskFromLine({ path, text: quoted, line: 1, periodicRoot: ROOT }).children, { from: 10, to: 17, text: '\n> \t- 子', lines: ['- 子'], count: 1 })
  // タスクのノートの行でも子を返す
  const note = buildTaskNote({ title: '親', due: '2026-06-04' }) + '\n- [ ] 下の行\n  - 孫\n'
  const sub = at('Tasks/2026-05-01-親.md', note, '下の行')
  assert.equal(sub.parent, '[[Tasks/2026-05-01-親]]')
  assert.deepEqual(sub.children.lines, ['- 孫'])
})

// 実物（2026-03・2026-05・Q1・W10・W11）の書き方をまねた入れ子の例。中身は架空の文に置き換えた。
// 字下げで決めた範囲と lezer の違いが出る形（怠惰な続きの行・引用の > だけの行）を全部入れてある。
const NESTED = [
  '---',
  'month: 2026-03',
  'tags:',
  '  - monthly-plan',
  '---',
  '',
  '## Target',
  '',
  '> [!収益目標]',
  '> - [x] 💰**収益目標：1万円(教室: ¥6K)**',
  '> ',
  '',
  '### 1. 🎨 絵の練習',
  '',
  '- [[2026-W10]] (3/2-3/8)',
  '\t- [ ] 下描きを3枚',
  '\t\t- [x] 構図',
  '\t\t- [x] 線画',
  '\t- [ ] 画材の通販を調べる',
  '\t※ 練習が続いてから考える。',
  '- 教室',
  '\t- [x] 1本目の公開',
  '\t- [x] 2本目の公開',
  '- ~~画材の通販を調べる~~',
  '※ 今月は練習を優先する。',
  '',
  '### 2. 教室',
  '',
  '- [ ] 全作品に **下描き3段階** を当てる',
  '  - Phase 1: 構図（0:00-0:15）',
  '  - Phase 2: 線画（0:15-0:45）',
  '    - [ ] 道具をそろえる',
  '',
  '  - [ ] 空の行のあとの子',
  '- [ ] 6/4 作品展へ出す。',
  '  続きの文（字下げした行）',
  '',
  '> [!Result]',
  '> - 売上の活動',
  '> \t- 教室の活動',
  '> \t\t- [x] 体験会を1回追加',
  '> \t\t~~- [ ] 別の会も視野~~',
  '> \t\t- [x] 案内を2つ',
  '> \t\t~~- [ ] 案内を4つ~~',
  '> \t\t- [x] **月の成果: ¥5,000** > 結果: **¥8,000**',
  '> ~~- [ ] 作品20枚~~',
  '> \t\t~~- [ ] 動画の調査も視野~~',
  '',
  '## Weekly',
  '',
  '- [x] #絵 練習の流れを簡単にする',
  '3/2(mon): 終日外出',
  '- [ ] 4枚目を仕上げる',
  '\t- [ ] 構図',
  '※ 来週は夜の予定が多いので、週末にまとめて描く。',
  '',
  '\x60\x60\x60text',
  '- [ ] コードの中の行',
  '\x60\x60\x60',
].join('\n')

// 字下げと lezer の読み方がもともと違う形（あらかじめ挙げた例）。lezer に項目がない行や、入れ子にならない行。
const ODD = [
  '\t- 文書の頭のタブ',
  '\t\t- 子',
  '',
  '1. 番号の項目',
  '  - 2スペースの行',
  '2. 次',
  '',
  '- 1スペース',
  ' - 子',
  '',
  '- 6スペース',
  '      - 子',
  '- 兄弟',
  '',
  '>\t- 引用のすぐ後ろのタブ',
  '>\t\t- 子',
].join('\n')

// 行の番号（0 から）→ その行で始まる項目の入れ子の深さ（1 が いちばん外側）。
const itemDepths = (text) => {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  const lineOf = (pos) => starts.findLastIndex((start) => start <= pos)
  const out = new Map()
  let depth = 0
  const codes = []
  markdown.parse(text).iterate({
    enter(node) {
      if (node.name === 'CodeBlock') codes.push(lineOf(node.from))
      if (node.name !== 'ListItem' && node.name !== 'AlphaItem') return
      depth++
      if (!out.has(lineOf(node.from))) out.set(lineOf(node.from), depth)
    },
    leave(node) {
      if (node.name === 'ListItem' || node.name === 'AlphaItem') depth--
    },
  })
  return { depths: out, codes }
}

test('字下げで決めた範囲と lezer の ListItem の違いは、怠惰な続きの行と空の行だけ（実物の書き方をまねた例）', () => {
  const result = compareNesting(NESTED)
  assert.equal(result.lists, 24)
  assert.equal(result.withChildren, 9)
  const count = (kind) => result.diffs.filter((diff) => diff.kind === kind).length
  assert.equal(count('lazy'), 10)
  assert.equal(count('blank'), 1)
  assert.equal(result.diffs.length, 11, JSON.stringify(result.diffs.filter((diff) => diff.kind !== 'lazy' && diff.kind !== 'blank')))
  // 怠惰な続きの行で始まる違い：注記（字下げが同じ ※・字下げなしの ※）、日付の行、行頭が ~~ の行、引用の中の取り消し行
  const lazyNext = result.diffs.filter((diff) => diff.kind === 'lazy').map((diff) => diff.next)
  assert.ok(lazyNext.includes('3/2(mon): 終日外出'))
  assert.ok(lazyNext.includes('\t※ 練習が続いてから考える。'))
  assert.ok(lazyNext.includes('> ~~- [ ] 作品20枚~~'))
  // lezer の範囲がその先の深い行まで伸びる形（実物の Q1 の形）
  assert.deepEqual(result.diffs.find((diff) => diff.text === '> - 売上の活動'), { line: 39, kind: 'lazy', text: '> - 売上の活動', mine: 45, lezer: 47, next: '> ~~- [ ] 作品20枚~~' })
})

test('字下げと lezer の読み方がもともと違う形は、あらかじめ挙げた行だけが違う', () => {
  const result = compareNesting(ODD)
  assert.equal(result.lists, 12)
  assert.equal(result.withChildren, 5)
  assert.deepEqual(result.diffs.map((diff) => [diff.line, diff.mine, diff.lezer]), [
    [1, 2, null], // 文書の頭のタブ：lezer は字下げのコード
    [2, 2, null],
    [4, 5, 4], // 番号の項目の下の2スペース：lezer では入れ子にならない
    [5, 5, 6], // （その行の段落に「2. 次」が続きとして入る）
    [6, 6, null],
    [8, 9, 8], // 1スペース：lezer では兄弟
    [12, 12, null], // 6スペース：lezer では「- 子」は項目ではなく、上の行の文の続き
    [16, 16, null], // > のすぐ後ろのタブ：lezer では項目ではない
  ])
})

test('移したあとの形：字下げを外した子の行に字下げのコードがなく、入れ子の深さが元と同じ。元のノートからは子の行だけが消える', () => {
  for (const [name, text] of Object.entries({ NESTED, ODD })) {
    const rows = analyzeLines(text)
    const original = itemDepths(text)
    let checked = 0
    let compared = 0
    for (const row of rows) {
      if (row.kind !== 'list') continue
      const kids = childrenOf(text, row.index, rows)
      if (!kids) continue
      checked++
      const label = name + ' ' + (row.index + 1) + '行目'
      const body = kids.lines.join('\n') + '\n'
      const moved = itemDepths(body)
      assert.deepEqual(moved.codes, [], label)
      // 元で項目だった子の行は、移したあとも項目で、深さの差（いちばん浅い子との差）が同じ
      const range = childRange(rows, row.index)
      const pairs = []
      for (let i = range.first; i <= range.last; i++) {
        if (!original.depths.has(i)) continue
        pairs.push([original.depths.get(i), moved.depths.get(i - range.first)])
      }
      const base = Math.min(...pairs.map(([before]) => before))
      const baseAfter = Math.min(...pairs.map(([, after]) => after))
      for (const [before, after] of pairs) assert.equal(after - baseAfter, before - base, label)
      // 実物をまねた例では、子の行の深さは「元の深さ − 選んだ行の深さ」になる（いちばん外側が 1）
      if (name === 'NESTED') for (const [before, after] of pairs) assert.equal(after, before - original.depths.get(row.index), label)
      compared += pairs.length
      // 元のノートから from〜to を消すと、子の行だけがなくなる
      const rest = rows.filter((r) => r.index < range.first || r.index > range.last).map((r) => r.text).join('\n')
      assert.equal(text.slice(0, kids.from) + text.slice(kids.to), rest, label)
      assert.equal(kids.text, '\n' + rows.slice(range.first, range.last + 1).map((r) => r.text).join('\n'), label)
    }
    assert.equal(checked, name === 'NESTED' ? 9 : 5)
    assert.equal(compared, name === 'NESTED' ? 21 : 2)
  }
})

test('先頭のプロパティの閉じの --- の行末に空白があっても、エディターと同じ範囲をプロパティにする', () => {
  const frontRows = (text) => analyzeLines(text).filter((row) => row.kind === 'front')
  const editorEnd = (text) => frontmatterEnd(Text.of(text.split('\n')))
  for (const text of ['---\ntags:\n  - a\n--- \n- [ ] x', '--- \ntags: a\n---\t\n- [ ] x\n', '---\t\na: 1\n---  \n\n- x']) {
    const rows = frontRows(text)
    assert.equal(rows.at(-1).to, editorEnd(text), JSON.stringify(text))
    assert.equal(rows.length, text.slice(0, editorEnd(text)).split('\n').length)
  }
  // 行末に空白のある --- の後ろの行は、プロパティではなく選べる行
  const path = '90_Periodic/2026/Monthly/2026-03.md'
  assert.equal(taskFromLine({ path, text: '---\ntags: a\n--- \n- [ ] x', line: 4, periodicRoot: ROOT }).ok, true)
  assert.equal(taskFromLine({ path, text: '---\ntags: a\n--- \n- [ ] x', line: 2, periodicRoot: ROOT }).reason, 'front')
})

test('閉じの --- の行末に空白があるタスクのノートでも、行からサブタスクを作れる', () => {
  const text = '---\ntitle: "親"\ntype: task\nstatus: 未着手\ndue: 2026-06-04\ngoal: "[[90_Periodic/2026/Monthly/2026-05]]"\n--- \n- [ ] 下の行\n'
  const source = taskSourceOf({ path: 'Tasks/2026-05-01-親.md', text, periodicRoot: ROOT })
  assert.deepEqual(source, { kind: 'task', goal: '[[90_Periodic/2026/Monthly/2026-05]]', parent: '[[Tasks/2026-05-01-親]]', due: '2026-06-04' })
  const found = at('Tasks/2026-05-01-親.md', text, '下の行')
  assert.equal(found.ok, true)
  assert.equal(found.parent, '[[Tasks/2026-05-01-親]]')
  assert.equal(found.due, '2026-06-04')
})
