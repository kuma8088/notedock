// 日付のノート（デイリー・週・月・四半期・年）の置き場所・名前・上の期間を決める。
// DOMにもNodeにも頼らない。日付はDate.UTCとgetUTC…だけで計算する。

export const PERIODS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly']

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86400000

const pad = (n, w = 2) => String(n).padStart(w, '0')
const toMs = (y, m, d) => Date.UTC(y, m - 1, d)
const fmt = (ms) => {
  const t = new Date(ms)
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}
const parse = (date) => {
  const m = DATE_RE.exec(date)
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

export function isValidDate(date) {
  if (typeof date !== 'string') return false
  const m = DATE_RE.exec(date)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = new Date(toMs(y, mo, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

function mustBeDate(date) {
  if (!isValidDate(date)) throw new Error(`日付の形が正しくありません：${date}`)
}

// 月曜が先頭の曜日番号（月0〜日6）
const weekdayIndex = (ms) => (new Date(ms).getUTCDay() + 6) % 7

export function isoWeek(date) {
  mustBeDate(date)
  const { y, m, d } = parse(date)
  const ms = toMs(y, m, d)
  const thursday = ms + (3 - weekdayIndex(ms)) * DAY_MS
  const year = new Date(thursday).getUTCFullYear()
  const dayOfYear = Math.round((thursday - toMs(year, 1, 1)) / DAY_MS) + 1
  return { year, week: Math.floor((dayOfYear - 1) / 7) + 1 }
}

const quarterOf = (month) => Math.floor((month - 1) / 3) + 1
const weekName = ({ year, week }) => `${pad(year, 4)}-W${pad(week)}`

export function periodInfo(period, date) {
  mustBeDate(date)
  const { y, m, d } = parse(date)
  const ms = toMs(y, m, d)
  const Y = pad(y, 4)
  const monthName = `${Y}-${pad(m)}`
  const quarterName = `${Y}-Q${quarterOf(m)}`
  if (period === 'daily') {
    return { name: date, folder: `${Y}/Daily`, start: date, parents: [weekName(isoWeek(date)), monthName, quarterName, Y] }
  }
  if (period === 'weekly') {
    const wk = isoWeek(date)
    const monday = ms - weekdayIndex(ms) * DAY_MS
    const th = new Date(monday + 3 * DAY_MS)
    const ty = pad(th.getUTCFullYear(), 4)
    const tm = th.getUTCMonth() + 1
    return {
      name: weekName(wk),
      folder: `${pad(wk.year, 4)}/Weekly`,
      start: fmt(monday),
      parents: [`${ty}-${pad(tm)}`, `${ty}-Q${quarterOf(tm)}`, ty],
    }
  }
  if (period === 'monthly') {
    return { name: monthName, folder: `${Y}/Monthly`, start: `${monthName}-01`, parents: [quarterName, Y] }
  }
  if (period === 'quarterly') {
    return { name: quarterName, folder: `${Y}/Quarterly`, start: `${Y}-${pad((quarterOf(m) - 1) * 3 + 1)}-01`, parents: [Y] }
  }
  if (period === 'yearly') {
    return { name: Y, folder: Y, start: `${Y}-01-01`, parents: [] }
  }
  throw new Error(`期間の種類が正しくありません：${period}`)
}

// 今日のノートのボタンを隠すか。置き場が決まっていない・まだ分からないときは隠す（決まったと分かってから出す）。
export function todayButtonHidden(state) {
  return !state || state.disabled === true
}

export function notePath(periodicRoot, period, date) {
  const { name, folder } = periodInfo(period, date)
  return `${periodicRoot}/${folder}/${name}.md`
}

export function monthGrid(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month) || !isValidDate(`${month}-01`)) {
    throw new Error(`月の形が正しくありません：${month}`)
  }
  const first = toMs(Number(month.slice(0, 4)), Number(month.slice(5)), 1)
  const start = first - weekdayIndex(first) * DAY_MS
  const days = []
  for (let i = 0; i < 42; i++) days.push(fmt(start + i * DAY_MS))
  const weeks = []
  for (let w = 0; w < 6; w++) weeks.push({ name: weekName(isoWeek(days[w * 7])), start: days[w * 7] })
  return { days, weeks }
}

// ---- ひな形 ----

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// 長い並びを先に並べる（左から順に最初に当たったものを使う）
const TOKENS = ['YYYY', 'GGGG', 'MMMM', 'dddd', 'YY', 'MMM', 'ddd', 'MM', 'WW', 'DD', 'HH', 'mm', 'ss', 'M', 'D', 'W', 'Q']

export function formatDate(date, time, format) {
  mustBeDate(date)
  const { y, m, d } = parse(date)
  const [hh, mm] = String(time).split(':')
  const iso = isoWeek(date)
  const dayName = DAY_NAMES[weekdayIndex(toMs(y, m, d))]
  const monthName = MONTH_NAMES[m - 1]
  const value = {
    YYYY: pad(y, 4),
    YY: pad(y % 100),
    MMMM: monthName,
    MMM: monthName.slice(0, 3),
    MM: pad(m),
    M: String(m),
    dddd: dayName,
    ddd: dayName.slice(0, 3),
    GGGG: pad(iso.year, 4),
    WW: pad(iso.week),
    W: String(iso.week),
    DD: pad(d),
    D: String(d),
    HH: pad(Number(hh)),
    mm: pad(Number(mm)),
    ss: '00',
    Q: String(quarterOf(m)),
  }
  let out = ''
  let i = 0
  while (i < format.length) {
    if (format[i] === '[') {
      const close = format.indexOf(']', i + 1)
      if (close !== -1) {
        out += format.slice(i + 1, close)
        i = close + 1
        continue
      }
    }
    const token = TOKENS.find((t) => format.startsWith(t, i))
    if (token) {
      out += value[token]
      i += token.length
    } else {
      out += format[i]
      i += 1
    }
  }
  return out
}

// {{time}}に使う日付はtimeDate（なければdate）。ほかの{{ }}は残す。
export function renderTemplate(text, { date, time, title, timeDate = date }) {
  return text.replace(/\{\{(date|time)(?::([^}]*))?\}\}|\{\{title\}\}/g, (all, kind, fmtStr) => {
    if (kind === 'date') return fmtStr === undefined ? date : formatDate(date, time, fmtStr)
    if (kind === 'time') return fmtStr === undefined ? time : formatDate(timeDate, time, fmtStr)
    return title
  })
}

export function insertParentLinks(text, parents) {
  if (!parents || parents.length === 0) return text
  const line = parents.map((p) => `[[${p}]]`).join(' ')
  if (text.startsWith('---\n')) {
    let pos = 4
    while (pos <= text.length) {
      let end = text.indexOf('\n', pos)
      if (end === -1) end = text.length
      if (text.slice(pos, end) === '---') {
        const head = text.slice(0, end)
        const rest = text.slice(end + 1)
        return `${head}\n${line}\n\n${rest}`
      }
      pos = end + 1
    }
  }
  return `${line}\n\n${text}`
}

export function buildNote({ period, date, now, template }) {
  const info = periodInfo(period, date)
  const time = now.slice(11, 16)
  const nowDate = now.slice(0, 10)
  const text = renderTemplate(template || '', { date: info.start, time, title: info.name, timeDate: nowDate })
  return insertParentLinks(text, info.parents)
}


// ---- 期間の終わりの日と、名前からの期間（タスクの期日の初期値で使う） ----

// その日を含む期間の最終日。週は ISO の週（月曜〜日曜）の日曜、月は月末、四半期は最後の月の月末、年は12月31日。
export function periodEnd(period, date) {
  mustBeDate(date)
  const { y, m, d } = parse(date)
  const ms = toMs(y, m, d)
  if (period === 'daily') return date
  if (period === 'weekly') return fmt(ms + (6 - weekdayIndex(ms)) * DAY_MS)
  if (period === 'monthly') return fmt(toMs(y, m + 1, 0))
  if (period === 'quarterly') return fmt(toMs(y, quarterOf(m) * 3 + 1, 0))
  if (period === 'yearly') return `${pad(y, 4)}-12-31`
  throw new Error(`期間の種類が正しくありません：${period}`)
}

// 週の名前（2026-W10）から、その週の月曜と日曜。その年にない週（W54、52週の年の W53）や形の違う名前は null。
export function weekRange(name) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(name ?? ''))
  if (!match) return null
  const year = Number(match[1])
  const week = Number(match[2])
  if (week < 1) return null
  // 1月4日を含む週が第1週。
  const jan4 = toMs(year, 1, 4)
  const monday = jan4 - weekdayIndex(jan4) * DAY_MS + (week - 1) * 7 * DAY_MS
  const start = fmt(monday)
  const back = isoWeek(start)
  if (back.year !== year || back.week !== week) return null
  return { start, end: fmt(monday + 6 * DAY_MS) }
}

// 名前（2026-11-24・2026-W48・2026-11・2026-Q4・2026）から、その期間の始まりと終わり。形が違えば null。
export function periodRange(period, name) {
  const text = String(name ?? '')
  if (period === 'daily') return isValidDate(text) ? { start: text, end: text } : null
  if (period === 'weekly') return weekRange(text)
  if (period === 'monthly') {
    if (!/^\d{4}-\d{2}$/.test(text) || !isValidDate(`${text}-01`)) return null
    return { start: `${text}-01`, end: periodEnd('monthly', `${text}-01`) }
  }
  if (period === 'quarterly') {
    const match = /^(\d{4})-Q([1-4])$/.exec(text)
    if (!match) return null
    const start = `${match[1]}-${pad((Number(match[2]) - 1) * 3 + 1)}-01`
    return { start, end: periodEnd('quarterly', start) }
  }
  if (period === 'yearly') return /^\d{4}$/.test(text) ? { start: `${text}-01-01`, end: `${text}-12-31` } : null
  return null
}

const PERIOD_FOLDERS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly' }

// ノートの場所が、日付のノートの置き場（<periodicRoot>/<年>/Weekly/2026-W10.md など）のどれかなら、その種類と期間。
// 年のフォルダーと名前の年がそろっていて、名前が期間として成り立つときだけ。フォルダーの名前の大文字小文字は問わない。
// 年のノートは <periodicRoot>/<年>/<年>.md。ほかは null。
export function periodicNoteOf(periodicRoot, rel) {
  if (typeof periodicRoot !== 'string' || periodicRoot === '' || typeof rel !== 'string') return null
  const rootParts = periodicRoot.split('/').filter(Boolean)
  const parts = rel.split('/')
  const fold = (text) => text.normalize('NFC').toLowerCase()
  if (parts.length < rootParts.length + 2) return null
  for (let i = 0; i < rootParts.length; i++) if (fold(parts[i]) !== fold(rootParts[i])) return null
  const rest = parts.slice(rootParts.length)
  const year = rest[0]
  if (!/^\d{4}$/.test(year)) return null
  const file = rest.at(-1)
  if (!/\.md$/i.test(file)) return null
  const name = file.slice(0, -3)
  let period = null
  if (rest.length === 2) period = name === year ? 'yearly' : null
  else if (rest.length === 3) period = Object.keys(PERIOD_FOLDERS).find((key) => fold(PERIOD_FOLDERS[key]) === fold(rest[1])) ?? null
  if (!period || !name.startsWith(year)) return null
  const range = periodRange(period, name)
  return range ? { period, name, ...range } : null
}
