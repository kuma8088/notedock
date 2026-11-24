// デイリーノートの上のタスクのパネルで使う、区分けと見せ方。DOM にもサーバーにも頼らない。
// 日付は 'YYYY-MM-DD' の文字だけで扱う（同じ形なら文字の大小がそのまま日付の前後になる）。
import { isValidDate, periodInfo } from './periodic.mjs'
import { isTaskDone } from './tasks.mjs'

// 「直近」の日数。段階1-F で設定にする。
export const TASK_SOON_DAYS = 3
export const TASK_HOLD_STATUS = '保留'
// パネルの中見出しの並び。done は完了したもの（件数だけ見せてたたむ）。
export const TASK_SECTIONS = Object.freeze(['soon', 'week', 'month', 'none', 'done'])
export const TASK_SECTION_LABELS = Object.freeze({ soon: '直近のタスク', week: '今週のタスク', month: '今月のタスク', none: '期日なし', done: '完了' })
// 始めの開閉。直近だけ開く。
export const TASK_SECTION_DEFAULT_OPEN = Object.freeze({ soon: true, week: false, month: false, none: false, done: false })

const DAY_MS = 86400000
const toMs = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
const pad = (n, w = 2) => String(n).padStart(w, '0')
const fmt = (ms) => {
  const t = new Date(ms)
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

export function addDays(date, days) {
  return fmt(toMs(date) + days * DAY_MS)
}

// 基準日の週（月曜〜日曜。週のノートと同じ ISO の区切り）と月の、最初と最後の日。
export function weekRange(date) {
  const start = periodInfo('weekly', date).start
  return { start, end: addDays(start, 6) }
}

export function monthRange(date) {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  return { start: `${date.slice(0, 7)}-01`, end: fmt(Date.UTC(y, m, 0)) }
}

// タスクの期間。due が日付でなければ null（期日なし）。start が日付で due より前なら start〜due、そうでなければ due の1日。
export function taskSpan(task) {
  const due = String(task?.due ?? '').trim()
  if (!isValidDate(due)) return null
  const start = String(task?.start ?? '').trim()
  return { start: isValidDate(start) && start <= due ? start : due, end: due }
}

const overlaps = (span, range) => span.start <= range.end && span.end >= range.start

// 開いているデイリーノートの日付（baseDate）から、タスクを区分に分ける。
// - 直近：期日が baseDate〜baseDate+soonDays に入るもの、または期日を過ぎた未完了
// - 今週・今月：期日がその週・月に入るか、開始日〜期日がその週・月にかかるもの
// - 期日なし：期日が日付として読めないもの（開始日だけのものも、ここに入る）
// 当てはまる区分すべてに入れる。完了したものは上の4つに入れず、done にまとめる（期日なしの完了は数えない）。
// 返すのは区分ごとのタスクの配列。並びは期日の早い順、同じなら題名順。
export function bucketTasks(tasks, baseDate, { soonDays = TASK_SOON_DAYS } = {}) {
  if (!isValidDate(baseDate)) throw new Error(`日付の形が正しくありません：${baseDate}`)
  const out = { soon: [], week: [], month: [], none: [], done: [] }
  const soonEnd = addDays(baseDate, Math.max(0, Math.floor(soonDays)))
  const week = weekRange(baseDate)
  const month = monthRange(baseDate)
  for (const task of tasks ?? []) {
    const span = taskSpan(task)
    const done = isTaskDone(String(task?.status ?? '').trim())
    if (!span) {
      if (!done) out.none.push(task)
      continue
    }
    const overdue = span.end < baseDate
    const inSoon = span.end >= baseDate && span.end <= soonEnd
    const inWeek = overlaps(span, week)
    const inMonth = overlaps(span, month)
    if (done) {
      if (inSoon || inWeek || inMonth) out.done.push(task)
      continue
    }
    if (inSoon || overdue) out.soon.push(task)
    if (inWeek) out.week.push(task)
    if (inMonth) out.month.push(task)
  }
  for (const key of TASK_SECTIONS) out[key].sort(compareTasks)
  return out
}

// サイドバーの「タスク」の並べ方（段階1-E2）。
// open：未完了を期日の早い順の1列（期日なしは最後。同じ期日なら題名順）。done：完了（件数だけ見せてたたむ）。
// unlinked：「リンクが外れたタスク」（サーバーの unlinked。完了したものも含む）。
export function sideTaskModel(tasks) {
  const out = { open: [], done: [], unlinked: [] }
  for (const task of tasks ?? []) {
    if (!task?.path) continue
    if (isTaskDone(String(task.status ?? '').trim())) out.done.push(task)
    else out.open.push(task)
    if (task.unlinked === true) out.unlinked.push(task)
  }
  for (const key of Object.keys(out)) out[key].sort(compareTasks)
  return out
}

// 「新しいタスク」の入力を確かめる。title は前後の空白を外す。due は空か YYYY-MM-DD。
// 返り値：{ ok: true, title, due } か { ok: false, error: 'title' | 'due' }。
export function checkNewTask({ title, due } = {}) {
  // eslint-disable-next-line no-control-regex
  const text = String(title ?? '').replace(/\t/g, ' ').trim()
  // eslint-disable-next-line no-control-regex
  if (!text || /[\x00-\x1f\x7f]/.test(text)) return { ok: false, error: 'title' }
  const date = String(due ?? '').trim()
  if (date && !isValidDate(date)) return { ok: false, error: 'due' }
  return { ok: true, title: text, due: date }
}

function compareTasks(a, b) {
  const da = taskSpan(a)?.end ?? '9999-99-99'
  const db = taskSpan(b)?.end ?? '9999-99-99'
  if (da !== db) return da < db ? -1 : 1
  const ta = taskLabel(a)
  const tb = taskLabel(b)
  if (ta !== tb) return ta < tb ? -1 : 1
  return String(a?.path ?? '') < String(b?.path ?? '') ? -1 : 1
}

// 題名の見せ方：**太字**・__太字__ の記号と、[[…]] の角かっこを外して文字だけにする。[[a|b]] は b を出す。
export function plainTitle(text) {
  return String(text ?? '')
    .replace(/\[\[([^\[\]|]*)\|([^\[\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\[\]]*)\]\]/g, (all, target) => target.split('#')[0].split('/').at(-1) || target)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

// パネルに出す名前。title が空ならファイル名（.md を外す）。
export function taskLabel(task) {
  const title = plainTitle(task?.title)
  if (title) return title
  return String(task?.path ?? '').split('/').at(-1).replace(/\.md$/i, '')
}

// ステータスの見せ方。kind は表示の種類：todo（未着手）・doing（進行中）・hold（保留）・done（完了）・other（知らない値。値をそのまま見せる）。
export function statusView(status) {
  const value = String(status ?? '').trim()
  if (value === '' || value === '未着手') return { kind: 'todo', label: '' }
  if (value === '進行中') return { kind: 'doing', label: '進行中' }
  if (value === TASK_HOLD_STATUS) return { kind: 'hold', label: '保留' }
  if (isTaskDone(value)) return { kind: 'done', label: '完了' }
  return { kind: 'other', label: value }
}

// 期日の見せ方（M/D）と、基準日より前で終わっていないか。
export function dueView(task, baseDate) {
  const span = taskSpan(task)
  if (!span) return { text: '', overdue: false }
  const short = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
  const text = span.start === span.end ? short(span.end) : `${short(span.start)}〜${short(span.end)}`
  return { text, overdue: span.end < baseDate && !isTaskDone(String(task?.status ?? '').trim()) }
}

// 開いているノートが <periodicRoot>/<年>/Daily/YYYY-MM-DD.md の形なら、その日付。
export function dailyDateOf(path, periodicRoot) {
  if (!periodicRoot || !path) return null
  const match = String(path).match(/^(.*)\/(\d{4})\/Daily\/(\d{4}-\d{2}-\d{2})\.md$/)
  return match && match[1] === periodicRoot && match[3].startsWith(match[2]) && isValidDate(match[3]) ? match[3] : null
}

// 覚えておいた開閉を、知っている区分だけ取り出す。
export function sectionOpenState(saved) {
  const out = { ...TASK_SECTION_DEFAULT_OPEN }
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const key of TASK_SECTIONS) if (typeof saved[key] === 'boolean') out[key] = saved[key]
  }
  return out
}
