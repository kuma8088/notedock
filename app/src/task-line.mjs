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

// 1行だけを見た形。先頭のプロパティとコードブロックの中かどうかは見ない（それは analyzeLines が決める）。
// kind：'blank'・'heading'・'rule'・'list'・'text'。list なら mark（記号と後ろの空白）・checkbox・body も付ける。
// fence：コードの囲みを始められる記号（```・~~~ など。なければ null）。restRaw：引用の > と字下げを除いた残り（末尾の空白も残す）。
export function lineShape(line) {
  const [, quotePart, indent, restRaw] = LINE.exec(line)
  const quote = (quotePart.match(/>/g) ?? []).length
  const rest = restRaw.replace(/\s+$/, '')
  const shape = { quote, indent: widthOf(indent), rest, restRaw, fence: FENCE.exec(restRaw)?.[1] ?? null }
  if (rest === '') return { ...shape, kind: 'blank' }
  if (HEADING.test(rest) && shape.indent < 4) return { ...shape, kind: 'heading' }
  if (RULE.test(rest) && shape.indent < 4) return { ...shape, kind: 'rule' }
  const mark = LIST_MARK.exec(rest)
  if (mark) {
    let body = rest.slice(mark[0].length)
    const box = CHECKBOX.exec(body)
    if (box) body = body.slice(box[0].length)
    return { ...shape, kind: 'list', mark: mark[0], checkbox: Boolean(box), body: body.trim() }
  }
  return { ...shape, kind: 'text' }
}

// fence（開いたときの記号）で始まったコードブロックを、この行（lineShape の restRaw）で閉じるか。
export function closesFence(restRaw, fence) {
  const match = FENCE.exec(restRaw)
  return Boolean(match) && match[1][0] === fence[0] && match[1].length >= fence.length && restRaw.slice(match[1].length).trim() === ''
}

// ノート全体を行に分けて、行ごとの種類を決める。lines[i] は 0 から数える。
// kind: 'front'（先頭のプロパティ）・'code'（コードブロックの中と、その囲みの行）・'heading'・'rule'（区切り線）・'list'・'text'・'blank'。
export function analyzeLines(text) {
  const raw = String(text ?? '').split('\n')
  const out = []
  let offset = 0
  // 先頭のプロパティの囲み（--- と ...）は、行末の空白（CR を含む）を外して比べる。エディターの frontmatterEnd と同じく、「--- 」も囲みにする。
  // '...' を閉じにすることと、閉じがなければ最後まで全部プロパティにすることは、エディターと違うが、段階1-C の動きのまま残す。
  const bareOf = (line) => line.trimEnd()
  let front = bareOf(raw[0]) === '---' ? 'open' : 'none'
  let fence = null
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]
    const from = offset
    offset += line.length + 1
    const shape = lineShape(line)
    const base = { index: i, from, to: from + line.length, text: line, quote: shape.quote, indent: shape.indent, rest: shape.rest }
    if (front === 'open') {
      if (i > 0 && (bareOf(line) === '---' || bareOf(line) === '...')) front = 'done'
      out.push({ ...base, kind: 'front' })
      continue
    }
    if (fence) {
      if (closesFence(shape.restRaw, fence)) fence = null
      out.push({ ...base, kind: 'code' })
      continue
    }
    if (shape.fence) {
      fence = shape.fence
      out.push({ ...base, kind: 'code' })
      continue
    }
    if (shape.kind === 'list') out.push({ ...base, kind: 'list', checkbox: shape.checkbox, body: shape.body })
    else out.push({ ...base, kind: shape.kind })
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
// 項目の下に字下げして書いた引用の中の行（「- [[2026-W10]]」の次の「  > - 目標」）は、引用の外の、引用の &gt; より浅い
// 字下げの箇条書きも親にする（lezer も、字下げした引用をその項目の中身として読む）。字下げのない引用（「> - 目標」）は今までどおり止まる。
export function ancestorsOf(rows, index) {
  const self = rows[index]
  const out = []
  let limit = self.indent
  let quote = self.quote
  // 引用の最初の &gt; の前の字下げの幅。引用の外へ出たら、これを limit にする。
  const outer = quote > 0 ? widthOf(/^[\t ]*/.exec(self.text)[0]) : 0
  for (let i = index - 1; i >= 0 && (limit > 0 || (quote > 0 && outer > 0)); i--) {
    const row = rows[i]
    if (row.kind === 'blank' || row.kind === 'code') continue
    if (row.kind === 'heading' || row.kind === 'rule' || row.kind === 'front') break
    if (row.quote !== quote) {
      if (!(quote > 0 && outer > 0 && row.quote === 0)) break
      quote = 0
      limit = outer
    }
    if (row.indent >= limit || row.kind !== 'list') continue
    out.push(row)
    limit = row.indent
  }
  return out
}

// ---- 入れ子の行（子の行） ----

// 引用の > を quote 個まで外す正規表現（> の後ろの空白かタブ1つも > の一部。LINE と同じ分け方）。exact なら、ちょうど quote 個。
const quoteMarks = (quote, exact = false) => new RegExp('^(?:[\\t ]*>[\\t ]?){' + (exact ? '' : '0,') + Math.max(0, Number(quote) || 0) + '}')

// 選んだ行の引用の深さ（quote）から見て、空白だけの行か。選んだ行と同じ数の > を外すと空白だけになる行（引用の「>」だけの行も）。
// kind は問わない（コードの囲みの中の空の行は 'code' になるため）。選んだ行より深い引用の「>」だけの行は、空ではない（引用の中身の一部）。
const isBlankIn = (text, quote) => text.replace(quoteMarks(quote), '').trim() === ''

// コードの囲み。開きの行の番号 → 閉じの行の番号（閉じがなければ -1）。analyzeLines が 'code' にした行を、同じ決まりで分ける。
const fenceCache = new WeakMap()
function fencesOf(rows) {
  let spans = fenceCache.get(rows)
  if (spans) return spans
  spans = new Map()
  let open = -1
  let fence = null
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== 'code') continue
    const shape = lineShape(rows[i].text)
    if (fence) {
      if (closesFence(shape.restRaw, fence)) {
        spans.set(open, i)
        fence = null
      }
      continue
    }
    fence = shape.fence
    open = i
    spans.set(open, -1)
  }
  fenceCache.set(rows, spans)
  return spans
}

// rows[index] の子の行の範囲。字下げで決める（lezer の ListItem は使わない。字下げのない「怠惰な続きの行」まで
// 項目の一部になってしまうため）。index の次の行から順に見て、
//   空白だけの行（選んだ行と同じ深さの引用の > だけの行も）は、とりあえず飛ばす（あとに深い行が来れば範囲に入る）、
//   先頭のプロパティの行・選んだ行より引用が浅い行で止まる、
//   選んだ行と同じ数の > を外したあとの字下げが rows[index] 以下の行で止まる、
//   それ以外（字下げが深い行）は種類を問わず子。字下げしたあとに > がある行（項目の下に字下げして書いた引用）も子。
//   子の行がコードの囲みを開くなら、閉じの行まで囲みごと子にする（中の行の字下げや > は見ない）。
// 返り値: { first, last }（rows の番号。末尾の空白だけの行は含めない）。子がなければ null。
export function childRange(rows, index) {
  const self = rows?.[index]
  if (!self) return null
  const marks = quoteMarks(self.quote, true)
  const fences = fencesOf(rows)
  let last = -1
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i]
    if (isBlankIn(row.text, self.quote)) continue
    if (row.kind === 'front') break
    const mark = marks.exec(row.text)
    if (!mark || widthOf(/^[\t ]*/.exec(row.text.slice(mark[0].length))[0]) <= self.indent) break
    last = i
    const close = fences.get(i)
    if (close !== undefined && close > i) {
      last = close
      i = close
    }
  }
  return last < 0 ? null : { first: index + 1, last }
}

// 字下げ indent（文字）から、幅 width の列ぶんを外した残り。
// タブが境目をまたぐときや、外したあとにタブの止まる位置がずれるときは、残りの幅を空白で書く（見た目の字下げの幅を保つ）。
// 字下げが width より浅い行（コードの囲みの中の行）は、字下げを全部外す。
function stripIndent(indent, width) {
  const want = widthOf(indent) - width
  if (want <= 0) return ''
  let col = 0
  let i = 0
  while (i < indent.length && col < width) {
    col = indent[i] === '\t' ? col + TAB - (col % TAB) : col + 1
    i++
  }
  const rest = indent.slice(i)
  return col === width && widthOf(rest) === want ? rest : ' '.repeat(want)
}

// 子の行を、タスクのノートの本文に置く形にする。行の配列を返す。
//   行頭の引用の >（quote の数。> の後ろの空白かタブ1つも > の一部）を外し、
//   空でない行のうちいちばん浅い字下げの幅（列）を、どの行からも外す（1段ではなく、いちばん浅い行が字下げなしになるまで）。
//   loose（行の番号の Set。コードの囲みの中の行と閉じの行）は、いちばん浅い幅を決めるのに使わない（浅ければ字下げを全部外す）。
//   空白だけの行（quote の数の > を外すと空白だけの行）は空にする。それより深い引用の「>」だけの行は残す。
export function dedentChildren(lines, quote = 0, loose = new Set()) {
  const marks = quoteMarks(quote)
  const parts = lines.map((line, i) => {
    const [, indent, rest] = /^([\t ]*)([\s\S]*)$/.exec(line.replace(marks, ''))
    return { indent, rest, blank: rest.trim() === '', loose: loose.has(i) }
  })
  const widths = parts.filter((part) => !part.blank && !part.loose).map((part) => widthOf(part.indent))
  const width = widths.length ? Math.min(...widths) : 0
  return parts.map((part) => (part.blank ? '' : stripIndent(part.indent, width) + part.rest))
}

// text の rows[index] の子の行。子がなければ null。
//   from: rows[index] の行の終わり、to: 最後の子の行の終わり。text: text.slice(from, to)（先頭の改行を含む。元のノートから消す文字）。
//   lines: 本文に置く形（dedentChildren）。count: 空でない子の行の数。
export function childrenOf(text, index, rows = analyzeLines(text)) {
  const range = childRange(rows, index)
  if (!range) return null
  const quote = rows[index].quote
  const kids = rows.slice(range.first, range.last + 1)
  // コードの囲みの中の行と閉じの行（いちばん浅い字下げの幅を決めるのに使わない）。
  const loose = new Set()
  for (const [open, close] of fencesOf(rows)) {
    if (open < range.first || open > range.last || close < 0) continue
    for (let i = open + 1; i <= close; i++) loose.add(i - range.first)
  }
  const from = rows[index].to
  const to = rows[range.last].to
  return {
    from,
    to,
    text: String(text).slice(from, to),
    lines: dedentChildren(kids.map((row) => row.text), quote, loose),
    count: kids.filter((row) => !isBlankIn(row.text, quote)).length,
  }
}

// ---- まとめ ----

// 行（1 から数える）からタスクを作れるか。作れれば中身、作れなければ reason を返す。
// reason: 'no-source'（週・月・四半期・タスクのノートでない）・'no-line'・'front'・'code'・'heading'・'not-list'・
//         'empty'・'week-link'・'struck'・'has-task-link'・'callout'
// 作れるとき: { ok: true, line, from, to, lineText, title, due, goal, parent, source, children }
//   from・to は行の位置（text の中の文字の位置。改行は含まない）。画面は、書き換える前に lineText と同じか確かめる。
//   children: その行の子の行（childrenOf の結果）。子がなければ null。
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
  return { ok: true, line: row.index + 1, from: row.from, to: row.to, lineText: row.text, title: goalTextOf(row.text), due, goal, parent, source: source.kind, children: childrenOf(text, row.index, rows) }
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
