// 選んでいる行（1から数える）。Claudeの入力欄の @ の候補「選んでいる行」に使う。
// 何も選んでいなければ null。選択が次の行の頭で終わるとき（行ごと選んだとき）は、その次の行を含めない。
export function selectedLines(state) {
  const sel = state.selection.main
  if (sel.empty) return null
  const from = state.doc.lineAt(sel.from).number
  const end = state.doc.lineAt(sel.to)
  const to = end.from === sel.to && end.number > from ? end.number - 1 : end.number
  return { from, to }
}

// 右の枠から届いた行の値を確かめる。正しくなければ null。
export function linesFrom(value) {
  if (!value || typeof value !== 'object') return null
  const { from, to } = value
  return Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from ? { from, to } : null
}
