// 入れ子の行の範囲（task-line.mjs の childRange。字下げで決める）と、@lezer/markdown の ListItem の範囲を比べる部品。
// テスト（task-line.test.mjs）と、実物のノートで確かめるスクリプト（nesting-corpus.mjs）で同じものを使う。
import { parser } from '@lezer/markdown'

import { noteSyntaxExtensions } from '../src/markdown-syntax.mjs'
import { analyzeLines, childRange } from '../src/task-line.mjs'

export const markdown = parser.configure(noteSyntaxExtensions)

const isBlank = (row) => row.text.replace(/^(?:[\t ]*>[\t ]?)*/, '').trim() === ''

// 行の番号（0 から）→ その行で始まる ListItem（英字の項目 AlphaItem も）の最後の行の番号。
export function lezerItemEnds(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  const lineOf = (pos) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const out = new Map()
  markdown.parse(text).iterate({
    enter(node) {
      if (node.name !== 'ListItem' && node.name !== 'AlphaItem') return
      const first = lineOf(node.from)
      const end = node.to > 0 && text[node.to - 1] === '\n' ? node.to - 1 : node.to
      if (!out.has(first)) out.set(first, lineOf(end))
    },
  })
  return out
}

// 違いの分け方：
//   'blank'：lezer のほうが長く、増えた行が空白だけの行（引用の > だけの行も）だけ。
//   'lazy'：lezer のほうが長く、字下げで決めた範囲のすぐ次の空でない行が、引用の深さが同じで、箇条書きでなく、字下げが選んだ行以下
//           （CommonMark の「怠惰な続きの行」で始まる）。
//   'quote'：lezer のほうが長く、すぐ次の空でない行の引用の深さが違う（選んだ行より浅い引用の行や、選んだ行の字下げより深く字下げしていない > の行。字下げのあとに > がある行は子なので、ここには来ない）。
//   'other'：それ以外（lezer の項目がない・lezer のほうが短いなど）。
export function compareNesting(text) {
  const rows = analyzeLines(text)
  const ends = lezerItemEnds(text)
  const diffs = []
  let lists = 0
  let withChildren = 0
  for (const row of rows) {
    if (row.kind !== 'list') continue
    lists++
    const range = childRange(rows, row.index)
    const mine = range ? range.last : row.index
    if (range) withChildren++
    const theirs = ends.has(row.index) ? ends.get(row.index) : null
    if (theirs === mine) continue
    let kind = 'other'
    if (theirs !== null && theirs > mine) {
      const extra = rows.slice(mine + 1, theirs + 1)
      const next = rows.slice(mine + 1).find((r) => !isBlank(r))
      if (extra.every(isBlank)) kind = 'blank'
      else if (next && next.quote !== row.quote) kind = 'quote'
      else if (next && next.kind !== 'list' && next.indent <= row.indent) kind = 'lazy'
    }
    diffs.push({ line: row.index + 1, kind, text: row.text, mine: mine + 1, lezer: theirs === null ? null : theirs + 1, next: rows[mine + 1]?.text ?? null })
  }
  return { lists, withChildren, diffs }
}
