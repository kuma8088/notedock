import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { buildNote, formatDate, insertParentLinks, isValidDate, monthGrid, notePath, periodEnd, periodInfo, periodRange, periodicNoteOf, renderTemplate, weekRange } from '../src/periodic.mjs'

const cases = JSON.parse(readFileSync(new URL('./fixtures/cases.json', import.meta.url), 'utf8'))

test('答え合わせの一覧のとおりに場所と名前を決める', () => {
  for (const c of cases.paths) {
    const label = `${c.period} ${c.date}`
    assert.equal(notePath(cases.root, c.period, c.date), c.path, label)
    const info = periodInfo(c.period, c.date)
    assert.equal(info.start, c.start, label)
    assert.deepEqual(info.parents, c.parents, label)
  }
})

test('答え合わせの一覧のとおりに月の表を作る', () => {
  for (const g of cases.grids) {
    const grid = monthGrid(g.month)
    assert.equal(grid.days.length, 42, g.month)
    assert.equal(grid.weeks.length, 6, g.month)
    assert.equal(grid.days[0], g.first, g.month)
    assert.equal(grid.days[41], g.last, g.month)
    assert.equal(grid.weeks[0].name, g.firstWeek, g.month)
    assert.equal(grid.weeks[0].start, g.first, g.month)
  }
})

test('日付の形を確かめる', () => {
  assert.equal(isValidDate('2024-02-29'), true)
  for (const bad of ['2026-02-29', '2026-13-01', '2026-1-1', '2026-11-08T00:00', '', 'x']) assert.equal(isValidDate(bad), false)
})

test('形の一覧のとおりに日付を書く', () => {
  for (const c of cases.formats) {
    assert.equal(formatDate(c.date, c.time, c.format), c.expected, `${c.date} ${c.format}`)
  }
})

test('ひな形の一覧のとおりにノートを作る', () => {
  for (const c of cases.templates) {
    const note = buildNote({ period: c.period, date: c.date, now: c.now, template: c.template })
    assert.equal(note, c.expected, `${c.period} ${c.date}`)
  }
})

test('ひな形の置き換えと上の期間へのリンク', () => {
  assert.equal(renderTemplate('{{date}} {{time:HH}} {{title}} {{x}}', { date: '2026-11-08', time: '07:30', title: 'T' }), '2026-11-08 07 T {{x}}')
  assert.equal(insertParentLinks('abc', []), 'abc')
  assert.equal(insertParentLinks('---\na: 1\n---\nbody', ['A', 'B']), '---\na: 1\n---\n[[A]] [[B]]\n\nbody')
  assert.equal(insertParentLinks('---\na: 1\nbody', ['A']), '[[A]]\n\n---\na: 1\nbody')
})

import { todayButtonHidden } from '../src/periodic.mjs'
test('今日のノートのボタンは、置き場が決まったと分かるまで隠す', () => {
  assert.equal(todayButtonHidden(null), true)
  assert.equal(todayButtonHidden({ disabled: true }), true)
  assert.equal(todayButtonHidden({ periodicRoot: 'Days', days: [] }), false)
})


test('期間の最終日（週は日曜、月は月末、四半期は最後の日、年は12月31日）', () => {
  assert.equal(periodEnd('daily', '2026-05-04'), '2026-05-04')
  assert.equal(periodEnd('weekly', '2026-05-04'), '2026-05-10')
  assert.equal(periodEnd('weekly', '2026-05-10'), '2026-05-10')
  assert.equal(periodEnd('weekly', '2026-12-30'), '2027-01-03')
  assert.equal(periodEnd('monthly', '2026-02-10'), '2026-02-28')
  assert.equal(periodEnd('monthly', '2028-02-01'), '2028-02-29')
  assert.equal(periodEnd('monthly', '2026-12-31'), '2026-12-31')
  assert.equal(periodEnd('quarterly', '2026-01-15'), '2026-03-31')
  assert.equal(periodEnd('quarterly', '2026-05-15'), '2026-06-30')
  assert.equal(periodEnd('quarterly', '2026-08-01'), '2026-09-30')
  assert.equal(periodEnd('quarterly', '2026-11-24'), '2026-12-31')
  assert.equal(periodEnd('yearly', '2026-03-01'), '2026-12-31')
  assert.throws(() => periodEnd('weekly', '2026-02-30'))
  assert.throws(() => periodEnd('decade', '2026-02-01'))
})

test('週の名前から月曜と日曜。その年にない週は null', () => {
  assert.deepEqual(weekRange('2026-W18'), { start: '2026-04-27', end: '2026-05-03' })
  assert.deepEqual(weekRange('2026-W01'), { start: '2025-12-29', end: '2026-01-04' })
  assert.deepEqual(weekRange('2026-W53'), { start: '2026-12-28', end: '2027-01-03' })
  assert.deepEqual(weekRange('2020-W53'), { start: '2020-12-28', end: '2021-01-03' })
  assert.equal(weekRange('2025-W53'), null)
  assert.equal(weekRange('2026-W54'), null)
  assert.equal(weekRange('2026-W00'), null)
  assert.equal(weekRange('2026-W1'), null)
  assert.equal(weekRange(undefined), null)
})

test('名前から期間の始まりと終わり', () => {
  assert.deepEqual(periodRange('daily', '2026-11-24'), { start: '2026-11-24', end: '2026-11-24' })
  assert.equal(periodRange('daily', '2026-02-30'), null)
  assert.deepEqual(periodRange('weekly', '2026-W48'), { start: '2026-11-23', end: '2026-11-29' })
  assert.deepEqual(periodRange('monthly', '2026-11'), { start: '2026-11-01', end: '2026-11-30' })
  assert.equal(periodRange('monthly', '2026-13'), null)
  assert.deepEqual(periodRange('quarterly', '2026-Q4'), { start: '2026-10-01', end: '2026-12-31' })
  assert.equal(periodRange('quarterly', '2026-Q5'), null)
  assert.deepEqual(periodRange('yearly', '2026'), { start: '2026-01-01', end: '2026-12-31' })
  assert.equal(periodRange('yearly', '26'), null)
  assert.equal(periodRange('other', '2026'), null)
})

test('ノートの場所から、日付のノートの種類と期間', () => {
  assert.deepEqual(periodicNoteOf('90_Periodic', '90_Periodic/2026/Monthly/2026-05.md'), { period: 'monthly', name: '2026-05', start: '2026-05-01', end: '2026-05-31' })
  assert.deepEqual(periodicNoteOf('90_Periodic', '90_Periodic/2026/Weekly/2026-W53.md'), { period: 'weekly', name: '2026-W53', start: '2026-12-28', end: '2027-01-03' })
  assert.equal(periodicNoteOf('90_Periodic', '90_Periodic/2026/Quarterly/2026-Q2.md').end, '2026-06-30')
  assert.equal(periodicNoteOf('90_Periodic', '90_Periodic/2026/Daily/2026-05-04.md').period, 'daily')
  assert.equal(periodicNoteOf('90_Periodic', '90_Periodic/2026/2026.md').period, 'yearly')
  // フォルダーの大文字小文字は問わない。入れ子の置き場も使える。
  assert.equal(periodicNoteOf('90_Periodic', '90_periodic/2026/MONTHLY/2026-05.md').period, 'monthly')
  assert.equal(periodicNoteOf('a/b', 'a/b/2026/Monthly/2026-05.md').period, 'monthly')
  // 年のフォルダーと名前の年が違う、期間として成り立たない、置き場の外、形が違う
  assert.equal(periodicNoteOf('90_Periodic', '90_Periodic/2026/Monthly/2027-01.md'), null)
  assert.equal(periodicNoteOf('90_Periodic', '90_Periodic/2025/Weekly/2025-W53.md'), null)
  assert.equal(periodicNoteOf('90_Periodic', '90_Periodic/2026/Monthly/2026-13.md'), null)
  assert.equal(periodicNoteOf('90_Periodic', 'Other/2026/Monthly/2026-05.md'), null)
  assert.equal(periodicNoteOf('90_Periodic', '90_Periodic/2026/Notes/2026-05.md'), null)
  assert.equal(periodicNoteOf('90_Periodic', '90_Periodic/2026/Monthly/x/2026-05.md'), null)
  assert.equal(periodicNoteOf('90_Periodic', '90_Periodic/2026/Monthly/2026-05.txt'), null)
  assert.equal(periodicNoteOf('90_Periodic', '90_Periodic/2026/2025.md'), null)
  assert.equal(periodicNoteOf('', '2026/Monthly/2026-05.md'), null)
  assert.equal(periodicNoteOf(null, '90_Periodic/2026/Monthly/2026-05.md'), null)
})
