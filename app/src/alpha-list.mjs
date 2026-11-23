import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, foldNodeProp, syntaxTree } from '@codemirror/language'

// 「a. 」「b. 」…（小文字1字＋ピリオド＋空白）で始まる行を、順序付きの項目として扱う。
// Markdown の標準（CommonMark）には英字の番号付きリストがないので、ファイルには書いたとおり「a. 」が残り、
// ほかのアプリ（Obsidian・GitHub など）ではただの文として表示される。この扱いはエディターの中だけ。
//
// 作り：Markdown の読み取り（lezer）を広げて、「a. 」を項目（AlphaItem、記号は AlphaMark）として木に入れる。
// 前は木はそのままにして、行の文字を見て記号に色を付けるだけだった（飾りの方法）。それだと「a. 」の行は段落のままで、
// 下に Tab で入れた「- 」「1. 」も同じ段落の続きと読まれ、子が箇条書き・番号付きにならなかった。
// 木に入れると、子は普通の箇条書き・番号付きとして読まれ、記号・開閉・Enter の続き・ぶら下げ字下げが、
// 今までの箇条書きの仕組みのままで効く。「a. 」の項目自体も、左の三角や記号の押下でたためる。
// 番号付きの項目（ListItem）と同じく、子は記号のあとの本文の位置より右に字下げした行。
//
// 誤って拾わないための決まり：
// - 行頭（引用の「>」と字下げのあと）だけ。文の途中の「a. 」は対象外。
// - 小文字1字だけ。ひな形の「Q. 」や「A. 」などの大文字、「aa. 」は対象外。ピリオドの後に空白が要る。
// - コード・数式・ノートの先頭のプロパティ・HTML・コメントの中は、ほかの読み取りが先に取るので対象外。
//   表は対象外にならない：表のすぐ下の行が「a. 」で始まると、「|」を含んでいても、そこで表が終わり項目になる
//   （「1. 」で始まる行と同じ扱い）。
// - 「a. 」以外の文字は、すぐ上（深い段の行と空行は飛ばす）に同じ段の英字の項目が「a. 」から続いているか、
//   1つ浅い段が箇条書き・番号・英字の項目のときだけ。
//   これで、本文の行のすぐ下（空行をはさんでも）の「e. g. 」「i. e. 」のような行は拾わない。

const ALPHA_MARK = /^([a-z])\.([\t ]+)/
const LIST_MARK = /^(?:[-*+]|\d{1,9}[.)]|[a-z]\.)(?:[\t ]|$)/

const LINE = /^((?:[\t ]*>[\t ]?)*)([\t ]*)(.*)$/

function columnsOf(text, tabSize = 4) {
  let col = 0
  for (const ch of text) col = ch === '\t' ? col + tabSize - (col % tabSize) : col + 1
  return col
}

function parseLine(text) {
  const [, quote, indent, rest] = text.match(LINE)
  return { quote: quote.replace(/[\t ]/g, ''), cols: columnsOf(indent), rest }
}

// 上の行を見て、「a. 」以外の文字の項目が続きかどうかを決める。
// 読み取りの途中の記録ではなく、上の行の文字で決める。読み取りは書き換えた所の近くだけを読み直し、
// 離れた所は前の結果を使うので、途中の記録に頼ると、上の「a. 」が読み直されないときに食い違う。
// さかのぼる長さに上限は付けない。止まるのは、同じ段か浅い段の行、引用の深さが変わる行、文書の先頭に着いたとき。
// 空行（空白だけの行も）は飛ばす。番号付きの「1. / 空行 / 2. 」が1つのリストなのと同じにする
// （標準の Enter は、2つ目の子のあとの空の子で Enter すると、空白だけの行を入れてから項目を作る）。

// 今の行より上の行を、近い順に返す。
function* linesAbove(cx) {
  if (cx.lineStart === 0) return
  let pos = cx.lineStart - 1
  let carry = ''
  for (;;) {
    const from = Math.max(0, pos - 4096)
    const parts = (cx.input.read(from, pos) + carry).split('\n')
    carry = parts.shift()
    for (let i = parts.length - 1; i >= 0; i--) yield parts[i]
    if (from === 0) {
      yield carry
      return
    }
    pos = from
  }
}

// 同じ段の英字の行は、25行までさかのぼる（a〜z は26個なので、z からでも a に届く）。
// 上限がないと、「e. g. 」で始まる行が大量に続く形で、行ごとに上まで戻り、開くときの読み取りが行数の2乗で重くなる。
const SAME_LEVEL_LIMIT = 25
function mayContinue(cx, line) {
  const me = parseLine(line.text)
  let sameLevel = 0
  for (const text of linesAbove(cx)) {
    const other = parseLine(text)
    if (other.rest.trim() === '') continue
    if (other.quote !== me.quote) return false
    if (other.cols > me.cols) continue
    if (other.cols === me.cols) {
      const mark = other.rest.match(ALPHA_MARK)
      if (!mark) return false
      if (mark[1] === 'a') return true
      if (++sameLevel >= SAME_LEVEL_LIMIT) return false
      continue
    }
    return LIST_MARK.test(other.rest)
  }
  return false
}

function alphaStart(cx, line) {
  if (line.indent - line.baseIndent >= 4) return null
  const mark = ALPHA_MARK.exec(line.text.slice(line.pos))
  if (!mark) return null
  if (mark[1] !== 'a' && !mayContinue(cx, line)) return null
  return mark
}

export const AlphaList = {
  defineNodes: [
    {
      name: 'AlphaItem',
      block: true,
      // 続きの行かどうか。番号付きの項目と同じく、本文の位置より左の行（空行を除く）で終わる。
      composite(cx, line, value) {
        if (line.indent < line.baseIndent + value && line.next > -1) return false
        line.moveBaseColumn(line.baseIndent + value)
        return true
      },
    },
    { name: 'AlphaMark' },
  ],
  parseBlock: [
    {
      name: 'AlphaItem',
      after: 'OrderedList',
      parse(cx, line) {
        const mark = alphaStart(cx, line)
        if (!mark) return false
        const start = cx.lineStart + line.pos
        const markCol = line.indent
        // 本文の位置。記号のあとの空白が5つ以上か、本文がないときは、記号＋空白1つの位置（番号付きと同じ決まり）。
        const spaceCols = columnsOf(line.text.slice(0, line.pos) + line.text.slice(line.pos, line.pos + mark[0].length)) - (markCol + 2)
        const empty = line.pos + mark[0].length >= line.text.length
        const base = empty || spaceCols > 4 ? markCol + 3 : markCol + 2 + spaceCols
        cx.startComposite('AlphaItem', line.pos, base - line.baseIndent)
        cx.addElement(cx.elt('AlphaMark', start, start + 2))
        line.moveBaseColumn(base)
        return null
      },
      // 段落のすぐ下の行でも項目を始める（番号付きの「1. 」と同じ）。
      endLeaf: (cx, line) => Boolean(alphaStart(cx, line)),
    },
  ],
  // 番号付きの項目と同じく、1行目の終わりから項目の終わりまでをたためる。
  props: [foldNodeProp.add({ AlphaItem: (tree, state) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }) })],
}

function itemFromMark(state, mark) {
  const line = state.doc.lineAt(mark.from)
  const before = line.text.slice(0, mark.from - line.from)
  const quote = before.match(/^(?:[\t ]*>[\t ]?)*/)[0]
  const indent = before.slice(quote.length)
  const space = line.text.slice(mark.to - line.from).match(/^[\t ]*/)[0]
  return {
    line,
    quote,
    indent,
    cols: columnsOf(indent, state.tabSize),
    letter: state.doc.sliceString(mark.from, mark.from + 1),
    markFrom: mark.from,
    markTo: mark.to,
    textFrom: mark.to + space.length,
    empty: line.text.slice(mark.to - line.from).trim() === '',
    node: mark.parent,
  }
}

// その行が英字の項目なら、記号と本文の位置を返す。そうでなければ null。
// tree を渡すと、その木で見る（読み進めたばかりで、まだ状態に入っていない木）。
export function alphaItemAt(state, lineNumber, tree = syntaxTree(state)) {
  const line = state.doc.line(lineNumber)
  if (!/[a-z]\./.test(line.text)) return null
  let mark = null
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (mark) return false
      if (node.name === 'AlphaMark' && node.from >= line.from) mark = node.node
      return undefined
    },
  })
  return mark ? itemFromMark(state, mark) : null
}

const nextLetter = (letter) => String.fromCharCode(letter.charCodeAt(0) + 1)

// Enter：本文の中なら次の文字の項目を続け、後ろの項目の文字を振り直す。空の項目なら記号を消して項目を終える。
// 英字の項目でないとき、選択中、記号より前にカーソルがあるときは false を返し、今までの Enter に任せる。
export function alphaListEnter({ state, dispatch }) {
  const { ranges, main } = state.selection
  if (state.readOnly || ranges.length !== 1 || !main.empty) return false
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
  if (item.letter !== 'z') changes.push(...renumberAfter(state, item.node, nextLetter(nextLetter(item.letter))))
  dispatch(state.update({ changes, selection: { anchor: head + insert.length }, scrollIntoView: true, userEvent: 'input' }))
  return true
}

// 同じ段の後ろの英字の項目の文字を、expected から順に振り直す。
function renumberAfter(state, node, expected) {
  const changes = []
  for (let next = node.nextSibling; next && next.name === 'AlphaItem' && expected <= 'z'; next = next.nextSibling) {
    const mark = next.getChild('AlphaMark')
    if (!mark) break
    if (state.doc.sliceString(mark.from, mark.from + 1) !== expected) changes.push({ from: mark.from, to: mark.from + 1, insert: expected })
    expected = nextLetter(expected)
  }
  return changes
}

// 英字の項目の下の子（箇条書き・番号付き）での Enter。
// Markdown の標準の Enter（insertNewlineContinueMarkup）は、親の項目の字下げを、箇条書き・番号付きの項目だけから組み立てる。
// 英字の項目は知らないので、そのまま使うと字下げが消える。そこで、上にある英字の記号を同じ長さの「1.」に置き換えた
// 写しで標準の Enter を動かし、出てきた変更を本物に当てる。2文字どうしなので位置はずれない。
// 空の子で Enter して英字の項目と同じ段に出たときは、「2. 」を次の文字にして、後ろの英字の項目を振り直す。
export function alphaChildEnter({ state, dispatch }) {
  const { ranges, main } = state.selection
  if (state.readOnly || ranges.length !== 1 || !main.empty) return false
  const tree = syntaxTree(state)
  let inner = null
  const marks = []
  for (let node = tree.resolveInner(main.head, -1); node; node = node.parent) {
    if (!inner && (node.name === 'ListItem' || node.name === 'AlphaItem')) inner = node
    if (node.name === 'AlphaItem') {
      const mark = node.getChild('AlphaMark')
      if (mark) marks.push(mark)
    }
  }
  if (!inner || inner.name !== 'ListItem' || !marks.length) return false
  let swap = state.update({ changes: marks.map((mark) => ({ from: mark.from, to: mark.to, insert: '1.' })) }).state
  // 写しを読み切れないとき（時間切れ）は、標準の Enter に任せる（字下げが崩れることはあっても、項目を書き換えはしない）。
  if (!ensureSyntaxTree(swap, Math.min(swap.doc.length, swap.doc.lineAt(main.head).to + 2000), 200)) return false
  // 読み進めた木を状態に入れる（標準の Enter は状態の木を見る）。
  swap = swap.update({}).state
  let result = null
  if (!insertNewlineContinueMarkup({ state: swap, dispatch: (tr) => { result = tr } }) || !result) return false
  let overlaps = false
  result.changes.iterChangedRanges((from, to) => {
    if (marks.some((mark) => from < mark.to && to > mark.from)) overlaps = true
  })
  if (overlaps) return false
  const tr = state.update({ changes: result.changes, selection: result.selection, scrollIntoView: true, userEvent: 'input' })
  const fixed = asAlphaSibling(tr.state, result.changes, marks)
  dispatch(fixed ? state.update({ changes: result.changes.compose(fixed.changes), selection: fixed.selection, scrollIntoView: true, userEvent: 'input' }) : tr)
  return true
}

// 空の子で Enter して、英字の項目と同じ段に「2. 」が入ったときの直し。直すものがなければ null。
function asAlphaSibling(state, changes, marks) {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const text = line.text
  for (const old of marks) {
    const from = changes.mapPos(old.from)
    const oldLine = state.doc.lineAt(from)
    const prefix = oldLine.text.slice(0, from - oldLine.from)
    const match = text.slice(prefix.length).match(/^(\d+)\.([\t ]+)/)
    if (!text.startsWith(prefix) || !match || line.number <= oldLine.number) continue
    // 同じ段かどうかは、すぐ上に同じ段の項目があるか（前の英字の項目の次）で見る。
    if (columnsOf(text.slice(0, prefix.length), state.tabSize) !== columnsOf(prefix, state.tabSize)) continue
    const letter = state.doc.sliceString(from, from + 1)
    const at = line.from + prefix.length
    // z の次は続けず、記号を消して同じ字下げの普通の行にする（英字の項目の Enter と同じ）。
    if (letter === 'z') {
      const cut = match[0].length
      return { changes: state.changes([{ from: at, to: at + cut }]), selection: { anchor: head - cut } }
    }
    const next = nextLetter(letter)
    const insert = `${next}.`
    const fix = [{ from: at, to: at + match[1].length + 1, insert }]
    const delta = insert.length - (match[1].length + 1)
    // 後ろの英字の項目（同じ段）の文字を振り直す。直したあとの文書で読み直して数える。
    // 読み切れないとき（時間切れ）は、文字の付け替えだけにして振り直さない。
    const after = state.update({ changes: fix }).state
    const tree = ensureSyntaxTree(after, Math.min(after.doc.length, line.to + 2000), 200)
    const item = tree ? alphaItemAt(after, line.number, tree) : null
    const more = item ? renumberAfter(after, item.node, nextLetter(next)) : []
    const first = state.changes(fix)
    const rest = after.changes(more)
    return { changes: first.compose(rest), selection: { anchor: head + delta } }
  }
  return null
}

// 範囲の中の英字の項目（見た目とぶら下げ字下げに使う）。
export function alphaItemsIn(state, from = 0, to = state.doc.length) {
  const out = []
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'AlphaMark') out.push(itemFromMark(state, node.node))
      return undefined
    },
  })
  return out
}
