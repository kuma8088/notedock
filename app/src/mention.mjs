// 窓のチャット欄の @ の候補。打っている語を見つけ、候補を並べ、選んだら入れる文（@場所#L12-18）を作る。
// 場所は Vault から見た場所。Mod が送るときに、その行を保存したファイルから読んで文に添える
// （Mod が送る文では、エンジンは @ のファイルを読まないため）。

export const SELECTION_WORD = '選んでいる行'
const MAX_NOTES = 30
const MAX_HEADINGS = 30

// カーソルの前の語が @ で始まっていれば、その語の始まりと、@ のあとに打った文字を返す。
// @ の前が文の頭か空白のときだけ（メールアドレスなどで出さない）。
export function mentionQuery(value, caret) {
  let start = caret
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1
  if (value[start] !== '@') return null
  let end = caret
  while (end < value.length && !/\s/.test(value[end])) end += 1
  return { from: start, to: end, query: value.slice(start + 1, caret) }
}

// 空白や # のある場所は、@ の続きとして1語に書けない（# は行の指定と紛れる）ので候補に出さない。
export function writablePath(path) {
  return typeof path === 'string' && path !== '' && !/[\s#]/.test(path)
}

export function lineToken(path, from, to) {
  return `@${path}#L${from === to ? from : `${from}-${to}`}`
}

function rangeText(from, to) {
  return from === to ? `${from}行` : `${from}〜${to}行`
}

// 保存した本文から見出しを拾う（# で始まる見出しだけ。コードの囲みと先頭の YAML は除く）。
// 返す line は1から数えた行。to は次の同じか上の段の見出しの前の行（空行は除く）か、最後の行。
export function sectionsOf(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  if (lines.length && lines.at(-1) === '') lines.pop()
  const found = []
  let fence = null
  let i = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) i = end + 1
  }
  for (; i < lines.length; i += 1) {
    const line = lines[i]
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null
      continue
    }
    if (open) {
      fence = open[1]
      continue
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line)
    if (!heading) continue
    const text = (heading[2] ?? '').replace(/[ \t]+#+$/, '').trim()
    if (text) found.push({ level: heading[1].length, text, line: i + 1 })
  }
  return found.map((heading, index) => {
    const next = found.slice(index + 1).find((other) => other.level <= heading.level)
    let to = next ? next.line - 1 : lines.length
    while (to > heading.line && lines[to - 1].trim() === '') to -= 1
    return { ...heading, to }
  })
}

const lower = (text) => text.toLowerCase()
const nameOf = (path) => path.split('/').at(-1).replace(/\.md$/i, '')

// 打った文字で、ノートを絞る。名前の頭が合うものを先に、場所のどこかに合うものをあとに。
function matchNotes(notes, query) {
  const q = lower(query)
  if (!q) return notes
  const head = []
  const part = []
  for (const note of notes) {
    if (lower(nameOf(note)).startsWith(q)) head.push(note)
    else if (lower(note).includes(q)) part.push(note)
  }
  return [...head, ...part]
}

// 「ノート名#見出し」の、ノート名の部分に当たるノート。場所そのもの・拡張子なし・名前の順に探す。
export function noteForName(notes, name) {
  if (!name) return null
  const n = lower(name)
  return (
    notes.find((note) => lower(note) === n) ??
    notes.find((note) => lower(note.replace(/\.md$/i, '')) === n) ??
    notes.find((note) => lower(nameOf(note)) === n) ??
    null
  )
}

// 候補を並べる。順番は (a) 選んでいる行 (b) 開いているノート (c) ほかのノート (d) 見出し。
// editor: { path, lines: {from,to}|null, dirty }（開いていなければ path は null）
// headings: 見出しを出すノートの { path, sections, dirty }（まだ読めていなければ null）
export function mentionCandidates({ query, editor, notes, headings }) {
  const out = []
  const dirtyNote = '保存していない変更があるので、行がずれることがあります'
  const hash = query.indexOf('#')
  const namePart = hash < 0 ? query : query.slice(0, hash)
  const headPart = hash < 0 ? '' : query.slice(hash + 1)
  const current = editor?.path && writablePath(editor.path) ? editor.path : null

  if (hash < 0) {
    const lines = editor?.lines
    if (current && lines) {
      const token = lineToken(current, lines.from, lines.to)
      const q = lower(query)
      if (!q || lower(SELECTION_WORD).startsWith(q) || lower(token.slice(1)).startsWith(q) || lower(nameOf(current)).startsWith(q)) {
        out.push({
          kind: 'selection',
          label: `${SELECTION_WORD}：${current} の${rangeText(lines.from, lines.to)}`,
          detail: editor.dirty ? dirtyNote : '',
          warn: Boolean(editor.dirty),
          insert: token,
        })
      }
    }
    const matched = matchNotes(notes, query)
    if (current && matched.includes(current)) {
      out.push({ kind: 'current', label: nameOf(current), detail: `開いているノート · ${current}`, insert: `@${current}` })
    }
    let count = 0
    for (const note of matched) {
      if (note === current || !writablePath(note)) continue
      if (count >= MAX_NOTES) break
      count += 1
      out.push({ kind: 'note', label: nameOf(note), detail: note, insert: `@${note}` })
    }
  }

  // 見出し。# を打ったらそのノートの見出し、打っていなければ開いているノートの見出しを、打った文字で絞って出す。
  if (headings && writablePath(headings.path)) {
    const q = lower(hash < 0 ? query : headPart)
    let count = 0
    for (const section of headings.sections) {
      if (q && !lower(section.text).includes(q)) continue
      if (count >= MAX_HEADINGS) break
      count += 1
      out.push({
        kind: 'heading',
        label: `${nameOf(headings.path)}#${section.text}`,
        // 見出しの行は保存した中身から数えるので、ずれない。入らないのは保存していない変更のほう。
        detail: [`${headings.path} の${rangeText(section.line, section.to)}`, headings.dirty ? '保存した中身の行です（保存していない変更は入りません）' : ''].filter(Boolean).join(' · '),
        warn: Boolean(headings.dirty),
        insert: lineToken(headings.path, section.line, section.to),
      })
    }
  }
  return out
}

// 打った文字に合うのに、場所に空白か # があって出さなかったノートの数（一覧の下に理由を添える）。
export function unwritableCount(query, notes) {
  if (query.includes('#')) return 0
  return matchNotes(notes, query).filter((note) => !writablePath(note)).length
}

// 見出しを出すノート。# を打ったときはその前の名前のノート、打っていなければ開いているノート。
export function headingTarget({ query, editor, notes }) {
  const hash = query.indexOf('#')
  if (hash < 0) return editor?.path ?? null
  return noteForName(notes, query.slice(0, hash))
}

// 候補を選んだあとの入力欄。打っていた語を入れる文に替え、後ろに空白を1つ置く。
export function applyMention(value, at, insert) {
  const before = value.slice(0, at.from)
  const after = value.slice(at.to)
  const spaced = after.startsWith(' ') || after.startsWith('\n') ? '' : ' '
  return { value: `${before}${insert}${spaced}${after}`, caret: before.length + insert.length + 1 }
}
