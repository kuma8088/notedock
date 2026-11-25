// 「a. 」「b. 」…の英字の項目を、Markdown の読み取り（lezer）で項目として木に入れる部分（alpha-list.mjs から分けた）。
// CodeMirror を読み込まないので、サーバー（リンクの数え方、task-delete.mjs の linkRows）でも使える。
// 決まりと限界の説明は alpha-list.mjs の先頭にある。

const ALPHA_MARK = /^([a-z])\.([\t ]+)/
const LIST_MARK = /^(?:[-*+]|\d{1,9}[.)]|[a-z]\.)(?:[\t ]|$)/

const LINE = /^((?:[\t ]*>[\t ]?)*)([\t ]*)(.*)$/

export function columnsOf(text, tabSize = 4) {
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
// さかのぼる長さは、同じ段の英字の行を25行まで（下の SAME_LEVEL_LIMIT）。深い段の行と空行は数えずに飛ばす。
// 止まるのは、同じ段の「a. 」（項目の続き）、同じ段の英字以外の行、浅い段の行、引用の深さが変わる行、文書の先頭に着いたとき。
// 同じ段に「a. 」以外の英字の行が26行以上続くと、26行目からは項目にならない（「a. 」まで25行では届かないため）。
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

// 読み取り（lezer）の広げ方だけ。たたむ範囲（foldNodeProp）は alpha-list.mjs の AlphaList で足す。
export const AlphaListSyntax = {
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
}
