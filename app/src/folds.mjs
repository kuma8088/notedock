import { foldEffect, foldable, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language'

// たたんだ・開いたのどちらかがあったか。開いたこと（unfoldEffect）も見ないと、開いた項目を覚えず、開き直すとまたたたまれる。
export function foldsChanged(transactions) {
  return transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)))
}

// いまたたんでいる範囲の、始まりの行の番号。
export function foldedLines(state) {
  const lines = []
  foldedRanges(state).between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number)
  })
  return lines
}

// 箇条書き・番号の記号（pos はその記号の中の位置）を押したときの開閉。
// その項目がたためるなら（左の三角と同じ foldable の判定。子の項目や続きの行があるとき）たたむ、
// たたんであれば開く。記号でない所や、たためない項目では null を返し、今までどおりカーソルを置かせる。
export function listMarkerFold(state, pos) {
  const mark = syntaxTree(state).resolveInner(pos, 1)
  if (mark.name !== 'ListMark') return null
  const line = state.doc.lineAt(pos)
  let open = null
  foldedRanges(state).between(line.from, line.to, (from, to) => {
    if (!open && state.doc.lineAt(from).number === line.number) open = { from, to }
  })
  if (open) return unfoldEffect.of(open)
  const range = foldable(state, line.from, line.to)
  return range ? foldEffect.of(range) : null
}
