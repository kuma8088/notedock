// 週・月・四半期のノートと、タスクのノートの行から、タスクを作るための部品（段階1-C）。DOM に頼らない。
// 画面（C2）は、行を選んだら taskFromLine で「作れるか」と中身（title・due・goal・parent）を受け取り、
// POST /api/tasks に created（画面の今日）と一緒に送る。ファイル名はサーバーが taskFileName で決める。
import { parseWikiLink, resolveHref, resolveWikiTarget, isExternal } from './links.mjs'
import { isValidDate, periodRange, periodicNoteOf, weekRange } from './periodic.mjs'
import { TASK_FOLDER, readTaskProps } from './tasks.mjs'

// ---- 行を読む ----

// 引用の > の並び・字下げ・残り。alpha-list.mjs と同じ分け方。
// 残りは [\s\S] で取る（U+2028・U+2029・CR を含む行でも合うように）。
const LINE = /^((?:[\t ]*>[\t ]?)*)([\t ]*)([\s\S]*)$/
const LIST_MARK = /^(?:[-*+]|\d{1,9}[.)])(?:[\t ]+|$)/
// チェックボックスは1文字の記号（空白・x・X・/・-）だけ。
const CHECKBOX = /^\[[ xX\/-]\](?:[\t ]+|$)/
// 区切り線（* * *・- - -・___ など）。箇条書きの記号と見分ける。
const RULE = /^(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/
const HEADING = /^#{1,6}(?:[\t ]|$)/
const FENCE = /^(\x60{3,}|~{3,})/
const WIKI = /!?\[\[([^\[\]\n]+)\]\]/g
const MD_LINK = /\[[^\]\n]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g
const WEEK_NAME = /^(\d{4})-W(\d{2})$/
const TAB = 4

// 字下げの幅（タブは4つ目ごとの位置まで進める）。2026-03 はタブ、2026-05 は2スペースで字下げしている。
function widthOf(indent) {
  let col = 0
  for (const ch of indent) col = ch === '\t' ? col + TAB - (col % TAB) : col + 1
  return col
}

// ノート全体を行に分けて、行ごとの種類を決める。lines[i] は 0 から数える。
// kind: 'front'（先頭のプロパティ）・'code'（コードブロックの中と、その囲みの行）・'heading'・'rule'（区切り線）・'list'・'text'・'blank'。
export function analyzeLines(text) {
  const raw = String(text ?? '').split('\n')
  const out = []
  let offset = 0
  // 先頭のプロパティの囲み（--- と ...）は、行末の CR を外して比べる。
  const bareOf = (line) => line.replace(/\r$/, '')
  let front = bareOf(raw[0]) === '---' ? 'open' : 'none'
  let fence = null
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]
    const from = offset
    offset += line.length + 1
    const [, quotePart, indent, restRaw] = LINE.exec(line)
    const quote = (quotePart.match(/>/g) ?? []).length
    const rest = restRaw.replace(/\s+$/, '')
    const base = { index: i, from, to: from + line.length, text: line, quote, indent: widthOf(indent), rest }
    if (front === 'open') {
      if (i > 0 && (bareOf(line) === '---' || bareOf(line) === '...')) front = 'done'
      out.push({ ...base, kind: 'front' })
      continue
    }
    const fenceMatch = FENCE.exec(restRaw)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && restRaw.slice(fenceMatch[1].length).trim() === '') fence = null
      out.push({ ...base, kind: 'code' })
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      out.push({ ...base, kind: 'code' })
      continue
    }
    if (rest === '') {
      out.push({ ...base, kind: 'blank' })
      continue
    }
    if (HEADING.test(rest) && widthOf(indent) < 4) {
      out.push({ ...base, kind: 'heading' })
      continue
    }
    if (RULE.test(rest) && widthOf(indent) < 4) {
      out.push({ ...base, kind: 'rule' })
      continue
    }
    const mark = LIST_MARK.exec(rest)
    if (mark) {
      let body = rest.slice(mark[0].length)
      const box = CHECKBOX.exec(body)
      if (box) body = body.slice(box[0].length)
      out.push({ ...base, kind: 'list', checkbox: Boolean(box), body: body.trim() })
      continue
    }
    out.push({ ...base, kind: 'text' })
  }
  return out
}

// 行から目標の文を取り出す。引用の >・箇条書きの記号・チェックボックスを外す。太字や [[…]] は残す。
export function goalTextOf(lineText) {
  const [, , , restRaw] = LINE.exec(String(lineText ?? '').split('\n')[0])
  let rest = restRaw.trim()
  const mark = LIST_MARK.exec(rest)
  if (mark) rest = rest.slice(mark[0].length)
  const box = CHECKBOX.exec(rest)
  if (box) rest = rest.slice(box[0].length)
  return rest.trim()
}

// 行の中の週のリンク（[[2026-W10]]・[[…/2026-W10]]・[[2026-W10|表示名]]）と、そのすぐ右の (M/D-M/D)。
// valid: 週として成り立つ名前か（W54、52週の年の W53 は false）。期日には成り立つものだけを使う。
const RANGE = /^(?:\*\*|__)?[\t ]*[(（][\t ]*(\d{1,2})[\t ]*\/[\t ]*(\d{1,2})[\t ]*[-–—~〜～][\t ]*(\d{1,2})[\t ]*\/[\t ]*(\d{1,2})[\t ]*[)）]/
export function weekLinksOf(text) {
  const found = []
  for (const match of String(text ?? '').matchAll(WIKI)) {
    const parsed = parseWikiLink(match[1])
    const name = parsed?.file.split('/').at(-1)
    if (!name || !WEEK_NAME.test(name)) continue
    const after = text.slice(match.index + match[0].length)
    const range = RANGE.exec(after)
    found.push({ name, valid: weekRange(name) !== null, start: match.index, end: match.index + match[0].length + (range ? range[0].length : 0), range: range ? { month: Number(range[3]), day: Number(range[4]) } : null })
  }
  return found
}

// 週のリンクだけの行か（[[2026-W10]] (3/2-3/8) や、[[2026-W13]] (3/23-3/31) ※9日間 のように横に注記があるもの）。
export function isWeekLinkOnly(body) {
  const links = weekLinksOf(body)
  if (links.length === 0) return false
  let rest = body
  for (const link of [...links].reverse()) rest = rest.slice(0, link.start) + rest.slice(link.end)
  rest = rest.replace(/※[\s\S]*$/, '').replace(/\*\*|__/g, '')
  return rest.trim() === ''
}

// 取り消し線の行。行の頭から取り消し線が引かれているもの（~~Q1振り返り~~ → 火曜に移動）は、移した・やめた予定なので選べない。
// 文の途中の語だけに引いた行は選べる。
export function isStruck(body) {
  return /^~~[^~](?:[\s\S]*?[^~])?~~/.test(String(body ?? '').trim())
}

const foldCase = (text) => text.normalize('NFC').toLowerCase()
const underFolder = (path, folder = TASK_FOLDER) => typeof path === 'string' && foldCase(path).startsWith(foldCase(folder) + '/')

// 行に、Tasks/ の下のノートへのリンクがあるか。表示名ではなくリンク先で判定する。
// known（Vault のノートの Set）を渡すと、名前だけのリンクも今のエディターと同じ規則で解決する。
export function hasTaskLink(text, notePath, known, folder = TASK_FOLDER) {
  const under = (path) => underFolder(path, folder)
  for (const match of String(text ?? '').matchAll(WIKI)) {
    const parsed = parseWikiLink(match[1])
    if (!parsed?.file) continue
    if (under(resolveWikiTarget(notePath, parsed.file, known)?.path)) return true
  }
  for (const match of String(text ?? '').matchAll(MD_LINK)) {
    const href = match[1]
    if (isExternal(href)) continue
    if (under(resolveHref(notePath, href)?.path)) return true
  }
  return false
}

// ---- どのノートから作るか ----

const linkOfPath = (path) => '[[' + path.replace(/\.md$/i, '') + ']]'

// 開いているノートが、タスクを作れるノートか。週・月・四半期のノートなら kind: 'periodic'、
// Tasks/ の下（フォルダー名の大文字小文字は問わない）の type: task のノートなら kind: 'task'。ほかは null。
export function taskSourceOf({ path, text, periodicRoot }) {
  if (typeof path !== 'string') return null
  const periodic = periodicRoot ? periodicNoteOf(periodicRoot, path) : null
  if (periodic && ['weekly', 'monthly', 'quarterly'].includes(periodic.period)) {
    return { kind: 'periodic', period: periodic.period, name: periodic.name, start: periodic.start, end: periodic.end, goal: linkOfPath(path) }
  }
  const props = underFolder(path) ? readTaskProps(text) : null
  if (props) return { kind: 'task', goal: props.goal, parent: linkOfPath(path), due: isValidDate(props.due) ? props.due : '' }
  return null
}

// ---- 期日の初期値 ----

const DAY_MS = 86400000
const pad = (n) => String(n).padStart(2, '0')

// 週の名前と、横に書いた終わりの日（M/D）から期日を決める。
// 年は、週の名前から出した ISO の日曜にいちばん近い年。その年で日付として成り立たないときと、
// ISO の日曜から14日より離れているとき（書き間違いとみなす）は ISO の日曜。
export function weekDue(name, range) {
  const week = weekRange(name)
  if (!week) return null
  if (!range) return week.end
  const sunday = Date.parse(week.end + 'T00:00:00Z')
  const y = Number(week.end.slice(0, 4))
  let best = null
  for (const year of [y - 1, y, y + 1]) {
    // 成り立たない日（2/30 など）も Date.UTC で近い日として比べ、年を決めてから成り立つか確かめる。
    const distance = Math.abs(Date.UTC(year, range.month - 1, range.day) - sunday)
    if (!best || distance < best.distance) best = { year, distance }
  }
  const date = best.year + '-' + pad(range.month) + '-' + pad(range.day)
  if (!isValidDate(date)) return week.end
  return Math.abs(Date.parse(date + 'T00:00:00Z') - sunday) > 14 * DAY_MS ? week.end : date
}

// 行の親にあたる箇条書きを、近いものから順に返す（何段上でも）。見出し・区切り線・先頭のプロパティ・引用の深さが違う行で止まる。
// 箇条書きでない行（注記の ※ … など）は飛ばして続ける。
export function ancestorsOf(rows, index) {
  const self = rows[index]
  const out = []
  let limit = self.indent
  for (let i = index - 1; i >= 0 && limit > 0; i--) {
    const row = rows[i]
    if (row.kind === 'blank' || row.kind === 'code') continue
    if (row.kind === 'heading' || row.kind === 'rule' || row.kind === 'front' || row.quote !== self.quote) break
    if (row.indent >= limit || row.kind !== 'list') continue
    out.push(row)
    limit = row.indent
  }
  return out
}

// ---- まとめ ----

// 行（1 から数える）からタスクを作れるか。作れれば中身、作れなければ reason を返す。
// reason: 'no-source'（週・月・四半期・タスクのノートでない）・'no-line'・'front'・'code'・'heading'・'not-list'・
//         'empty'・'week-link'・'struck'・'has-task-link'・'callout'
// 作れるとき: { ok: true, line, from, to, lineText, title, due, goal, parent, source }
//   from・to は行の位置（text の中の文字の位置。改行は含まない）。画面は、書き換える前に lineText と同じか確かめる。
export function taskFromLine({ path, text, line, periodicRoot, known }) {
  const source = taskSourceOf({ path, text, periodicRoot })
  if (!source) return { ok: false, reason: 'no-source' }
  const rows = analyzeLines(text)
  const row = rows[Number(line) - 1]
  if (!Number.isInteger(Number(line)) || !row) return { ok: false, reason: 'no-line' }
  const no = (reason) => ({ ok: false, reason })
  if (row.kind === 'front') return no('front')
  if (row.kind === 'code') return no('code')
  if (row.kind === 'heading') return no('heading')
  if (row.kind !== 'list') return no(row.quote > 0 && /^\[!/.test(row.rest) ? 'callout' : 'not-list')
  if (row.body === '') return no('empty')
  if (isWeekLinkOnly(row.body)) return no('week-link')
  if (isStruck(row.body)) return no('struck')
  if (hasTaskLink(row.body, path, known)) return no('has-task-link')
  let due = ''
  let parent = ''
  let goal = source.goal
  if (source.kind === 'periodic') {
    // 親の週のリンクを先に見る。親になければ、その行自身の週のリンク。どちらもなければノートの期間の最終日。
    const week = [...ancestorsOf(rows, row.index), row].map((r) => weekLinksOf(r.body).find((link) => link.valid)).find(Boolean)
    due = week ? weekDue(week.name, week.range) : source.end
  } else {
    due = source.due
    parent = source.parent
  }
  return { ok: true, line: row.index + 1, from: row.from, to: row.to, lineText: row.text, title: goalTextOf(row.text), due, goal, parent, source: source.kind }
}

// ---- ファイル名 ----

const WIN_RESERVED = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[0-9¹²³])$/i
const encoder = new TextEncoder()
const bytesOf = (text) => encoder.encode(text).length
const FALLBACK_NAME = 'タスク'
export const TASK_NAME_MAX_BYTES = 255
export const TASK_NAME_MAX_GRAPHEMES = 60

// ファイル名に使えない・使いにくい文字を外す。リンクは表示名（なければノートの名前）にする。
// / と : は - に置き換える（「6/4」→「6-4」、「19:00」→「19-00」）。Markdown のリンク [x](url) は表示の文字 x だけにする。
// 外すもの: # | [ ] \ < > " ? * ^ ` と制御文字、太字の記号（** と __）、取り消し線の ~~。空白は1つにまとめる。先頭の . と - と空白、末尾の . と空白も外す。
export function taskNameSlug(title) {
  let text = String(title ?? '').normalize('NFC')
  text = text.replace(/\[\[([^\[\]\n]*)\]\]/g, (all, inner) => {
    const parsed = parseWikiLink(inner)
    if (!parsed) return ''
    return parsed.alias || parsed.file.split('/').at(-1) || parsed.anchor
  })
  text = text.replace(/!?\[([^\[\]\n]*)\]\([^()\n]*\)/g, '$1')
  text = text.replace(/\*\*|__|~~/g, '')
  text = text.replace(/\s+/g, ' ')
  text = text.replace(/[\/:]/g, '-')
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[#|\[\]\\<>"?*^\x60\x00-\x1f\x7f]/g, '')
  text = text.replace(/ {2,}/g, ' ')
  text = trimName(text)
  if (text === '') return FALLBACK_NAME
  // Windows の予約名（CON・NUL・COM1 など。拡張子が付いても予約名）は、末尾に _ を付けてよける。
  const dot = text.indexOf('.')
  const base = dot < 0 ? text : text.slice(0, dot)
  if (WIN_RESERVED.test(base.trim())) text = base.trimEnd() + '_' + (dot < 0 ? '' : text.slice(dot))
  return text
}

function trimName(text) {
  // 先頭の - も外す（/ を置き換えた - で始まる名前や、コマンドのオプションと紛らわしい名前を避ける）。
  return text.replace(/^[-.\s]+/, '').replace(/[.\s]+$/, '')
}

// 絵文字や結合文字を割らずに、書記素（見た目の1文字）で max 個まで残す。
export function cutGraphemes(text, max) {
  const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })
  let out = ''
  let count = 0
  for (const { segment } of segmenter.segment(text)) {
    if (count >= max) break
    out += segment
    count++
  }
  return out
}

// 絵文字や結合文字を割らずに、バイト数（UTF-8）が max 以下になるまで後ろから切る。
export function cutBytes(text, max) {
  if (bytesOf(text) <= max) return text
  const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })
  let out = ''
  let size = 0
  for (const { segment } of segmenter.segment(text)) {
    const next = bytesOf(segment)
    if (size + next > max) break
    out += segment
    size += next
  }
  return out
}

// 作成日-目標の文を縮めた名前.md。n が 2 以上なら -n を付ける（同じ名前が重なったとき）。
// 目標の文の部分は60文字（書記素で数える）で切り、そのうえで拡張子と番号を含めて 255 バイトに収める。
export function taskFileName(title, created, n = 1, { maxBytes = TASK_NAME_MAX_BYTES, maxGraphemes = TASK_NAME_MAX_GRAPHEMES } = {}) {
  if (!isValidDate(created)) throw new Error('作成日の形が正しくありません：' + created)
  const suffix = n > 1 ? '-' + n : ''
  const head = created + '-'
  const room = maxBytes - bytesOf(head) - bytesOf(suffix) - bytesOf('.md')
  let slug = trimName(cutBytes(cutGraphemes(taskNameSlug(title), maxGraphemes), room))
  if (slug === '') slug = FALLBACK_NAME
  return head + slug + suffix + '.md'
}
