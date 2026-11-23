import { foldEffect, foldable, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language'

// 覚え直すかどうか。操作（foldEffect・unfoldEffect）の有無ではなく、更新の前後でたたんだ行の番号を比べる。
// 操作のない開き方もあるため：カーソルがたたんだ範囲に入ると自動で開き、範囲にかかる削除でも消える。
// 上に行を足して番号がずれたときも違いが出るので、新しい番号で覚え直す。
// update は画面の更新（ViewUpdate）。startState と state と transactions だけを使う。
export function foldsChanged(update) {
  const touched = update.transactions.some((tr) => tr.docChanged || tr.selection || tr.effects.length || tr.reconfigured)
  if (!touched) return false
  const before = foldedLines(update.startState)
  const after = foldedLines(update.state)
  return before.length !== after.length || before.some((line, i) => line !== after[i])
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
