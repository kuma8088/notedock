import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  TASK_SECTION_DEFAULT_OPEN,
  TASK_SOON_DAYS,
  addDays,
  isSoonDays,
  soonDaysOf,
  bucketTasks,
  dailyDateOf,
  dueView,
  monthRange,
  plainTitle,
  sectionOpenState,
  statusView,
  taskLabel,
  taskSpan,
  weekRange,
  checkNewTask,
  sideTaskModel,
} from '../src/task-buckets.mjs'

const t = (path, props = {}) => ({ path: `Tasks/${path}.md`, title: path, status: '未着手', start: '', due: '', ...props })
const names = (list) => list.map((task) => task.title)
const where = (buckets, title) => Object.keys(buckets).filter((key) => buckets[key].some((task) => task.title === title))

test('週は月曜〜日曜、月は1日〜末日', () => {
  assert.deepEqual(weekRange('2026-11-24'), { start: '2026-11-23', end: '2026-11-29' })
  assert.deepEqual(weekRange('2026-11-29'), { start: '2026-11-23', end: '2026-11-29' })
  assert.deepEqual(weekRange('2026-11-30'), { start: '2026-11-30', end: '2026-12-06' })
  assert.deepEqual(monthRange('2026-02-10'), { start: '2026-02-01', end: '2026-02-28' })
  assert.deepEqual(monthRange('2028-02-10'), { start: '2028-02-01', end: '2028-02-29' })
  assert.equal(addDays('2026-12-30', 3), '2027-01-02')
})

test('明日が期日のタスクは、直近・今週・今月の全部に出る', () => {
  const b = bucketTasks([t('明日', { due: '2026-11-25' })], '2026-11-24')
  assert.deepEqual(where(b, '明日'), ['soon', 'week', 'month'])
})

test('直近は基準日から3日先まで。4日先は入らない', () => {
  const b = bucketTasks([t('今日', { due: '2026-11-24' }), t('3日後', { due: '2026-11-27' }), t('4日後', { due: '2026-11-28' })], '2026-11-24')
  assert.deepEqual(names(b.soon), ['今日', '3日後'])
  assert.deepEqual(names(b.week), ['今日', '3日後', '4日後'])
})

test('直近の日数を変えられる', () => {
  const tasks = [t('3日後', { due: '2026-11-27' }), t('6日後', { due: '2026-11-30' })]
  assert.deepEqual(names(bucketTasks(tasks, '2026-11-24', { soonDays: 0 }).soon), [])
  assert.deepEqual(names(bucketTasks(tasks, '2026-11-24', { soonDays: 7 }).soon), ['3日後', '6日後'])
})

test('直近の日数の境目：その日数ちょうどの日は入り、次の日は入らない（月・年をまたいでも）', () => {
  const tasks = [t('5日後', { due: '2026-12-29' }), t('6日後', { due: '2026-12-30' }), t('31日後', { due: '2027-01-24' }), t('32日後', { due: '2027-01-25' })]
  assert.deepEqual(names(bucketTasks(tasks, '2026-12-24', { soonDays: 5 }).soon), ['5日後'])
  assert.deepEqual(names(bucketTasks(tasks, '2026-12-24', { soonDays: 6 }).soon), ['5日後', '6日後'])
  assert.deepEqual(names(bucketTasks(tasks, '2026-12-24', { soonDays: 31 }).soon), ['5日後', '6日後', '31日後'])
})

test('直近の日数が使えない値なら3日として分ける', () => {
  const tasks = [t('3日後', { due: '2026-11-27' }), t('4日後', { due: '2026-11-28' })]
  for (const bad of [undefined, null, -1, 32, 2.5, '5', NaN, true]) {
    assert.deepEqual(names(bucketTasks(tasks, '2026-11-24', { soonDays: bad }).soon), ['3日後'], String(bad))
  }
  assert.deepEqual(names(bucketTasks(tasks, '2026-11-24').soon), ['3日後'])
})

test('soonDaysOf と isSoonDays：0から31までの整数だけを受け付ける', () => {
  for (const ok of [0, 3, 31]) {
    assert.equal(isSoonDays(ok), true)
    assert.equal(soonDaysOf(ok), ok)
  }
  for (const bad of [-1, 32, 1.5, '3', null, undefined, NaN, Infinity]) {
    assert.equal(isSoonDays(bad), false, String(bad))
    assert.equal(soonDaysOf(bad), 3, String(bad))
  }
  assert.equal(TASK_SOON_DAYS, 3)
})

test('期日を過ぎた未完了は直近に出る。完了したものは出ない', () => {
  const b = bucketTasks([t('遅れ', { due: '2026-11-10' }), t('済み', { due: '2026-11-10', status: '完了' })], '2026-11-24')
  assert.deepEqual(where(b, '遅れ'), ['soon', 'month'])
  assert.deepEqual(where(b, '済み'), ['done'])
  assert.equal(dueView(b.soon[0], '2026-11-24').overdue, true)
  assert.equal(dueView(t('x', { due: '2026-11-10', status: '完了' }), '2026-11-24').overdue, false)
})

test('前の月に期日が過ぎた未完了は、直近にだけ出る', () => {
  const b = bucketTasks([t('先月', { due: '2026-10-31' })], '2026-11-24')
  assert.deepEqual(where(b, '先月'), ['soon'])
})

test('開始日〜期日の期間が週・月にかかれば出る', () => {
  const b = bucketTasks([t('長い', { start: '2026-11-01', due: '2026-12-20' })], '2026-11-24')
  assert.deepEqual(where(b, '長い'), ['week', 'month'])
})

test('週をまたぐ：基準日が日曜なら、翌日の月曜が期日のものは今週に入らない', () => {
  const b = bucketTasks([t('月曜', { due: '2026-11-30' })], '2026-11-29')
  assert.deepEqual(where(b, '月曜'), ['soon', 'month'])
})

test('月をまたぐ：週の残りが翌月でも今週には入り、今月には入らない', () => {
  // 2026-11-30（月）の週は 11-30〜12-06。
  const b = bucketTasks([t('12月', { due: '2026-12-02' })], '2026-11-30')
  assert.deepEqual(where(b, '12月'), ['soon', 'week'])
})

test('年をまたぐ：12月末の週は翌年1月の期日も今週に入る', () => {
  // 2026-12-28（月）〜2027-01-03（日）は 2026-W53。
  const b = bucketTasks([t('年明け', { due: '2027-01-03' }), t('年明け後', { due: '2027-01-04' })], '2026-12-31')
  assert.deepEqual(where(b, '年明け'), ['soon', 'week'])
  assert.deepEqual(where(b, '年明け後'), [])
})

test('開始日だけのタスクは期日なしに入る', () => {
  const b = bucketTasks([t('開始日だけ', { start: '2026-11-24' })], '2026-11-24')
  assert.deepEqual(where(b, '開始日だけ'), ['none'])
})

test('期日なし・日付として読めない期日は期日なし。完了の期日なしは数えない', () => {
  const b = bucketTasks([t('空'), t('読めない', { due: '来週' }), t('済み', { status: '完了' })], '2026-11-24')
  assert.deepEqual(names(b.none), ['空', '読めない'])
  assert.deepEqual(b.done, [])
})

test('開始日が期日より後なら期日の1日として扱う', () => {
  assert.deepEqual(taskSpan({ start: '2026-12-10', due: '2026-11-25' }), { start: '2026-11-25', end: '2026-11-25' })
  assert.equal(taskSpan({ start: '2026-11-01', due: '' }), null)
})

test('完了は期日が直近・今週・今月にかかるものだけを数える', () => {
  const b = bucketTasks([t('今月済み', { due: '2026-11-03', status: '完了' }), t('去年済み', { due: '2025-11-03', status: '完了' })], '2026-11-24')
  assert.deepEqual(names(b.done), ['今月済み'])
})

test('保留と知らない値は未完了として区分に入る', () => {
  const b = bucketTasks([t('保留', { due: '2026-11-25', status: '保留' }), t('done', { due: '2026-11-25', status: 'done' })], '2026-11-24')
  assert.deepEqual(names(b.soon), ['done', '保留'])
  assert.deepEqual(statusView('保留'), { kind: 'hold', label: '保留' })
  assert.deepEqual(statusView('done'), { kind: 'other', label: 'done' })
  assert.deepEqual(statusView('未着手'), { kind: 'todo', label: '' })
  assert.deepEqual(statusView(''), { kind: 'todo', label: '' })
  assert.deepEqual(statusView('完了'), { kind: 'done', label: '完了' })
})

test('並びは期日の早い順、同じなら題名順', () => {
  const b = bucketTasks([t('b', { due: '2026-11-26' }), t('a', { due: '2026-11-26' }), t('c', { due: '2026-11-25' })], '2026-11-24')
  assert.deepEqual(names(b.soon), ['c', 'a', 'b'])
})

test('基準日が日付でなければ止める', () => {
  assert.throws(() => bucketTasks([], '2026-13-01'))
})

test('題名から太字と [[…]] の記号を外す', () => {
  assert.equal(plainTitle('**6/4** 動画公開。'), '6/4 動画公開。')
  assert.equal(plainTitle('[[2026-W10]] のまとめ'), '2026-W10 のまとめ')
  assert.equal(plainTitle('[[Tasks/a|表示名]] と [[90_Periodic/2026/Monthly/2026-11]]'), '表示名 と 2026-11')
  assert.equal(plainTitle('¥30,000 を __目標__ に 🎯'), '¥30,000 を 目標 に 🎯')
  assert.equal(taskLabel({ title: '', path: 'Tasks/sub/2026-11-24-名前.md' }), '2026-11-24-名前')
})

test('期日の見せ方', () => {
  assert.equal(dueView({ due: '2026-11-05' }, '2026-11-01').text, '11/5')
  assert.equal(dueView({ start: '2026-11-01', due: '2026-12-20' }, '2026-11-01').text, '11/1〜12/20')
  assert.equal(dueView({ due: '' }, '2026-11-01').text, '')
})

test('デイリーノートの日付は、置き場の下の 年/Daily/日付.md の形だけ', () => {
  assert.equal(dailyDateOf('90_Periodic/2026/Daily/2026-11-24.md', '90_Periodic'), '2026-11-24')
  assert.equal(dailyDateOf('90_Periodic/2026/Daily/2025-11-24.md', '90_Periodic'), null)
  assert.equal(dailyDateOf('other/2026/Daily/2026-11-24.md', '90_Periodic'), null)
  assert.equal(dailyDateOf('90_Periodic/2026/Daily/2026-02-30.md', '90_Periodic'), null)
  assert.equal(dailyDateOf('90_Periodic/2026/Daily/2026-11-24.md', null), null)
})

test('開閉の記録は知っている区分だけ読み、始めは直近だけ開く', () => {
  assert.deepEqual(sectionOpenState(null), TASK_SECTION_DEFAULT_OPEN)
  assert.deepEqual(sectionOpenState({ week: true, soon: false, other: true, month: 'x' }), { soon: false, week: true, month: false, none: false, done: false })
})

// ---- サイドバーの並べ方（段階1-E2） ----

test('sideTaskModel：未完了は期日の早い順の1列（期日なしは最後、同じ期日は題名順）。完了は別。外れたものは unlinked にも', () => {
  const tasks = [
    { path: 'Tasks/n.md', title: '期日なし', status: '未着手' },
    { path: 'Tasks/b.md', title: 'い', due: '2026-11-30', status: '進行中', unlinked: true },
    { path: 'Tasks/a.md', title: 'あ', due: '2026-11-30' },
    { path: 'Tasks/e.md', title: '早い', due: '2026-11-02', status: '保留' },
    { path: 'Tasks/d.md', title: '済み', due: '2026-11-01', status: '完了', unlinked: true },
    { path: 'Tasks/s.md', title: '開始日だけ', start: '2026-11-01' },
    { path: 'Tasks/x.md', title: '知らない値', due: '2026-12-01', status: 'done' },
    { title: 'パスなし' },
  ]
  const model = sideTaskModel(tasks)
  assert.deepEqual(model.open.map((t) => t.title), ['早い', 'あ', 'い', '知らない値', '期日なし', '開始日だけ'])
  assert.deepEqual(model.done.map((t) => t.title), ['済み'])
  assert.deepEqual(model.unlinked.map((t) => t.title), ['済み', 'い'])
  assert.deepEqual(sideTaskModel(null), { open: [], done: [], unlinked: [] })
})

test('checkNewTask：題名は必須（前後の空白を外す）、期日は空か日付', () => {
  assert.deepEqual(checkNewTask({ title: '  見積もり\t送る ', due: '' }), { ok: true, title: '見積もり 送る', due: '' })
  assert.deepEqual(checkNewTask({ title: 'a', due: '2026-11-30' }), { ok: true, title: 'a', due: '2026-11-30' })
  assert.deepEqual(checkNewTask({ title: '   ', due: '' }), { ok: false, error: 'title' })
  assert.deepEqual(checkNewTask({ title: 'a\nb' }), { ok: false, error: 'title' })
  assert.deepEqual(checkNewTask({ title: 'a', due: '2026-02-30' }), { ok: false, error: 'due' })
  assert.deepEqual(checkNewTask({ title: 'a', due: '11/30' }), { ok: false, error: 'due' })
})
