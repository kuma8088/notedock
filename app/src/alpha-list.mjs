import { syntaxTree } from '@codemirror/language'

// 「a. 」「b. 」…（小文字1字＋ピリオド＋空白）で始まる行を、順序付きの項目として扱う。
// Markdown の標準（CommonMark）には英字の番号付きリストがないので、ファイルには書いたとおり「a. 」が残り、
// ほかのアプリ（Obsidian・GitHub など）ではただの文として表示される。この扱いはエディターの中だけ。
// 誤って拾わないための決まり：
// - 行頭（引用の「>」と字下げのあと）だけ。文の途中の「a. 」は対象外。
// - 小文字1字だけ。ひな形の「Q. 」や「A. 」などの大文字、「aa. 」は対象外。ピリオドの後に空白が要る。
// - コード・数式・ノートの先頭のプロパティ・HTML・コメント・表の中は対象外。
// - 「a. 」以外の文字は、すぐ上（深い段の行は飛ばす）に同じ段の項目が続いているか、1つ浅い段が箇条書き・番号・英字の項目のときだけ。
//   これで、本文の行のすぐ下の「e. g. 」「i. e. 」のような行は拾わない。空行をはさむと続きとみなさない。

const LINE = /^((?:[\t ]*>[\t ]?)*)([\t ]*)(.*)$/
const ALPHA_MARK = /^([a-z])\.([\t ]+)/
const LIST_MARK = /^(?:[-*+]|\d{1,9}[.)])(?:[\t ]|$)/
const QUICK = /^(?:[\t ]*>[\t ]?)*[\t ]*[a-z]\.[\t ]/
const EXCLUDED = new Set(['FencedCode', 'CodeBlock', 'Frontmatter', 'MathBlock', 'HTMLBlock', 'CommentBlock', 'ObsidianCommentBlock', 'Table'])

function columns(indent, tabSize) {
  let col = 0
  for (const ch of indent) col = ch === '\t' ? col + tabSize - (col % tabSize) : col + 1
  return col
}

function parseLine(text, tabSize) {
  const [, quote, indent, rest] = text.match(LINE)
  return { quote: quote.replace(/[\t ]/g, ''), quoteText: quote, indent, cols: columns(indent, tabSize), rest }
}

function excluded(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (EXCLUDED.has(node.name)) return true
  }
  return false
}

// 上の行を見て、「a. 」以外の文字の項目が続きかどうかを決める。
function continuesRun(state, lineNumber, me) {
  for (let n = lineNumber - 1; n >= 1; n--) {
    const other = parseLine(state.doc.line(n).text, state.tabSize)
    if (other.quote !== me.quote || other.rest.trim() === '') return false
    if (other.cols > me.cols) continue
    if (other.cols === me.cols) {
      const mark = other.rest.match(ALPHA_MARK)
      if (!mark) return false
      if (mark[1] === 'a') return true
      continue
    }
    return LIST_MARK.test(other.rest) || ALPHA_MARK.test(other.rest)
  }
  return false
}

// その行が英字の項目なら、記号と本文の位置を返す。そうでなければ null。
export function alphaItemAt(state, lineNumber) {
  const line = state.doc.line(lineNumber)
  if (!QUICK.test(line.text)) return null
  const parsed = parseLine(line.text, state.tabSize)
  const mark = parsed.rest.match(ALPHA_MARK)
  if (!mark) return null
  const markFrom = line.from + parsed.quoteText.length + parsed.indent.length
  if (excluded(state, markFrom)) return null
  const letter = mark[1]
  if (letter !== 'a' && !continuesRun(state, lineNumber, parsed)) return null
  return {
    line,
    quote: parsed.quoteText,
    indent: parsed.indent,
    cols: parsed.cols,
    letter,
    markFrom,
    markTo: markFrom + 2,
    textFrom: markFrom + mark[0].length,
    empty: parsed.rest.slice(mark[0].length).trim() === '',
  }
}

const nextLetter = (letter) => String.fromCharCode(letter.charCodeAt(0) + 1)

// Enter：本文の中なら次の文字の項目を続け、後ろの項目の文字を振り直す。空の項目なら記号を消して項目を終える。
// 英字の項目でないとき、選択中、記号より前にカーソルがあるときは false を返し、今までの Enter に任せる。
export function alphaListEnter({ state, dispatch }) {
  const { ranges, main } = state.selection
  if (ranges.length !== 1 || !main.empty) return false
  const head = main.head
  const line = state.doc.lineAt(head)
  const item = alphaItemAt(state, line.number)
  if (!item || head < item.textFrom) return false
  if (item.empty) {
    dispatch(state.update({ changes: { from: item.markFrom, to: line.to }, selection: { anchor: item.markFrom }, scrollIntoView: true, userEvent: 'input' }))
    return true
  }
  const prefix = item.quote + item.indent
  // z の次は続けず、同じ字下げの普通の改行にする。
  const insert = item.letter === 'z' ? `\n${prefix}` : `\n${prefix}${nextLetter(item.letter)}. `
  const changes = [{ from: head, insert }]
  if (item.letter !== 'z') changes.push(...renumberAfter(state, item, nextLetter(nextLetter(item.letter))))
  dispatch(state.update({ changes, selection: { anchor: head + insert.length }, scrollIntoView: true, userEvent: 'input' }))
  return true
}

// 同じ段の後ろの項目（深い段の行は飛ばす）の文字を、expected から順に振り直す。
function renumberAfter(state, item, expected) {
  const changes = []
  const me = parseLine(item.line.text, state.tabSize)
  for (let n = item.line.number + 1; n <= state.doc.lines && expected <= 'z'; n++) {
    const line = state.doc.line(n)
    const other = parseLine(line.text, state.tabSize)
    if (other.quote !== me.quote || other.rest.trim() === '') break
    if (other.cols > me.cols) continue
    const mark = other.cols === me.cols ? other.rest.match(ALPHA_MARK) : null
    if (!mark) break
    const at = line.from + other.quoteText.length + other.indent.length
    if (mark[1] !== expected) changes.push({ from: at, to: at + 1, insert: expected })
    expected = nextLetter(expected)
  }
  return changes
}

// 範囲の中の英字の項目（見た目とぶら下げ字下げに使う）。
export function alphaItemsIn(state, from = 0, to = state.doc.length) {
  const out = []
  if (state.doc.lines > 20000) return out
  const last = state.doc.lineAt(to).number
  for (let n = state.doc.lineAt(from).number; n <= last; n++) {
    const item = alphaItemAt(state, n)
    if (item) out.push(item)
  }
  return out
}
