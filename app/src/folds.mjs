import { foldEffect, foldedRanges, unfoldEffect } from '@codemirror/language'

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
