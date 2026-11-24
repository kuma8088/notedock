import assert from 'node:assert/strict'
import test from 'node:test'

import {
  analyzeLines,
  ancestorsOf,
  cutBytes,
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
