import { syntaxTree } from '@codemirror/language'
import { StateEffect } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'

import { alphaItemsIn } from './alpha-list.mjs'

// 箇条書きの項目が折り返したとき、2行目からを記号のあとの本文の先頭に揃える（ぶら下げ字下げ）。
// 記号・字下げ・チェックボックスの幅は字体や表示の切り替えで変わるので、画面で測った幅を使う。

// 1つ目のかっこは行頭の引用の記号（> の重なり）、2つ目は字下げ。本文のない項目（「- 」だけ）も含める。
const ITEM_START = /^((?:[\t ]*>[\t ]?)*)([\t ]*)(?:[-*+]|\d{1,9}[.)])(?:[\t ]+(?:\[[ xX]\][\t ]+)?|$)/

// 範囲の中にある箇条書きの項目の1行目と、行頭の引用の記号・字下げの終わり、本文が始まる位置。
// 引用・コールアウトの中の項目も含める。コードの中は除く。
export function listItemStarts(state, from = 0, to = state.doc.length) {
  const out = alphaItemsIn(state, from, to).map((item) => {
    const indent = item.line.from + item.quote.length
    return { line: item.line.from, indent, lead: indent + item.indent.length, text: item.textFrom }
  })
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false
      if (node.name !== 'ListItem') return undefined
      const line = state.doc.lineAt(node.from)
      if (line.from < from || line.from > to) return undefined
      const match = line.text.match(ITEM_START)
      if (match) {
        const indent = line.from + match[1].length
        out.push({ line: line.from, indent, lead: indent + match[2].length, text: line.from + match[0].length })
      }
      return undefined
    },
  })
  // 英字の項目（alpha-list.mjs）も含める。行の順に並べる。
  return out.sort((a, b) => a.line - b.line)
}

const hangsMeasured = StateEffect.define()

// 行頭の引用の記号と字下げを inline-block にする。タブの幅が行の左端からの位置で決まらず、ぶら下げ字下げを付けても変わらないようにする。
const leadMark = Decoration.mark({ class: 'cm-hang-lead' })

const measureContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')

// 空白と '0' の幅。font のまとめた値は空になるブラウザがあるので、個別の値から組み立てる。同じ字体なら測り直さない。
const widthCache = new Map()
function fontWidths(style) {
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  let widths = widthCache.get(font)
  if (!widths) {
    measureContext.font = font
    widths = { space: measureContext.measureText(' ').width, zero: measureContext.measureText('0').width }
    widthCache.set(font, widths)
  }
  return widths
}

function sameMeasure(a, b) {
  return a?.hang === b.hang && a.guides.length === b.guides.length && a.guides.every((x, i) => x === b.guides[i])
}

function lineStyle({ hang, guides }) {
  let style = `--hang: ${hang}px;`
  if (guides.length) {
    style += ` background-image: ${guides.map(() => 'linear-gradient(var(--indent-guide), var(--indent-guide))').join(', ')};`
    style += ` background-size: ${guides.map(() => '1px 100%').join(', ')};`
    style += ` background-position: ${guides.map((x) => `${x}px 0`).join(', ')};`
    style += ' background-repeat: no-repeat;'
  }
  return style
}

function lineElement(view, pos) {
  const { node } = view.domAtPos(pos)
  const element = node.nodeType === 1 ? node : node.parentElement
  return element?.closest?.('.cm-line') ?? null
}

class HangingIndent {
  constructor(view) {
    this.view = view
    this.hangs = new Map()
    this.decorations = Decoration.none
    this.measure = { key: this, read: () => this.read(), write: (hangs) => this.write(hangs) }
    view.requestMeasure(this.measure)
    // 字体の読み込みが遅れると、文字の幅だけが変わって行の高さは変わらないことがある。読み込みが終わったら測り直す。
    this.onFonts = () => {
      widthCache.clear()
      if (!this.destroyed && this.view.dom.isConnected) this.view.requestMeasure(this.measure)
    }
    document.fonts?.ready.then(this.onFonts)
    document.fonts?.addEventListener?.('loadingdone', this.onFonts)
  }

  destroy() {
    this.destroyed = true
    document.fonts?.removeEventListener?.('loadingdone', this.onFonts)
  }

  update(update) {
    if (update.docChanged) {
      const mapped = new Map()
      for (const [pos, hang] of this.hangs) mapped.set(update.changes.mapPos(pos), hang)
      this.hangs = mapped
    }
    const measured = update.transactions.some((tr) => tr.effects.some((e) => e.is(hangsMeasured)))
    if (measured || update.docChanged || update.viewportChanged) this.decorations = this.build()
    // カーソルの出入りや表示の切り替えで記号の見え方が変わると本文の位置も変わるので、更新のたびに測る（読むだけで、変わったときだけ反映する）。
    if (update.transactions.length || update.viewportChanged || update.geometryChanged || (this.stale && !update.view.composing)) update.view.requestMeasure(this.measure)
  }

  items() {
    const { state, visibleRanges } = this.view
    return visibleRanges.flatMap((range) => listItemStarts(state, range.from, range.to))
  }

  build() {
    const ranges = []
    for (const item of this.items()) {
      if (item.lead > item.line) ranges.push(leadMark.range(item.line, item.lead))
      const measured = this.hangs.get(item.line)
      ranges.push(Decoration.line({ attributes: measured ? { class: 'cm-list-line cm-hang', style: lineStyle(measured) } : { class: 'cm-list-line' } }).range(item.line))
    }
    return Decoration.set(ranges, true)
  }

  read() {
    const hangs = new Map()
    const tabSize = this.view.state.tabSize
    for (const item of this.items()) {
      const element = lineElement(this.view, item.line)
      const coords = this.view.coordsAtPos(item.text, 1) ?? this.view.coordsAtPos(item.text, -1)
      if (!element || !coords) continue
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const inner = rect.left + parseFloat(style.borderLeftWidth || '0')
      // 1行目の書き出しの位置。ぶら下げ字下げを付けたあとでも、padding と text-indent が打ち消し合うので同じ値になる。
      // 左の余白の基準（ふつうの行・引用・コールアウト）は style.css が決めるので、表示を切り替えてもここでは持ち越さない。
      const start = inner + parseFloat(style.paddingLeft || '0') + parseFloat(style.textIndent || '0')
      const hang = Math.round((coords.left - start) * 10) / 10
      if (!(hang > 0 && hang < rect.width / 2)) continue
      hangs.set(item.line, { hang, guides: this.guides(item, style, inner, tabSize) })
    }
    return hangs
  }

  // 入れ子の縦の線の位置（行の内側の左端から）。字下げの段ごとに1本、親の記号の真ん中に引く。
  // 段の幅はタブ1つ分（tabSize × 空白の幅）。線は行の背景に描くので、折り返した行にも続く。
  guides(item, style, inner, tabSize) {
    if (item.lead <= item.indent) return []
    const from = this.view.coordsAtPos(item.indent, 1)
    const to = this.view.coordsAtPos(item.lead, -1)
    if (!from || !to) return []
    const { space, zero } = fontWidths(style)
    const tab = space * tabSize
    const half = zero / 2
    if (!(tab > 0)) return []
    // タブ1つ（または空白 tabSize 個）を1段と数える。2つずつの空白で字下げしたノートは、段の数が丸められる。
    const levels = Math.round((to.left - from.left) / tab)
    const guides = []
    for (let level = 0; level < levels; level++) guides.push(Math.round((from.left - inner + level * tab + half) * 10) / 10)
    return guides
  }

  write(hangs) {
    const same = hangs.size === this.hangs.size && [...hangs].every(([pos, value]) => sameMeasure(this.hangs.get(pos), value))
    if (same && !this.stale) return
    // 変換中（日本語入力の途中）は付け直さない。変換が終わったら（compositionend と、変換が終わったあとの最初の更新で）測り直す。
    if (this.view.composing) {
      this.stale = true
      return
    }
    this.hangs = hangs
    // 測った結果は、測る処理が終わってから反映する（測っている最中は画面を更新できない）。
    queueMicrotask(() => {
      if (this.destroyed || !this.view.dom.isConnected) return
      // この間に変換が始まったときは付け直さず、変換が終わって測り直したときに付け直す。
      this.stale = this.view.composing
      if (!this.stale) this.view.dispatch({ effects: hangsMeasured.of(null) })
    })
  }
}

export const hangingIndent = ViewPlugin.fromClass(HangingIndent, {
  decorations: (plugin) => plugin.decorations,
  eventHandlers: {
    compositionend() {
      // 変換の確定は、CodeMirrorが文書を書き換える前に届くことがあるので、次の画面の更新で測る。
      this.view.requestMeasure(this.measure)
    },
  },
})
