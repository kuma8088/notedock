import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { Facet, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

import { alphaItemsIn } from './alpha-list.mjs'
import { isExternal, normalizeKey, resolveHref, wikiLinkOf } from './links.mjs'
import {
  BulletWidget,
  CalloutTitleWidget,
  CheckboxWidget,
  FrontmatterWidget,
  HiddenBlockWidget,
  ImageWidget,
  LineBreakWidget,
  MathWidget,
  MermaidWidget,
  TableWidget,
  WikiLinkWidget,
} from './widgets.mjs'

// 表示のしかた。ノートの表示は 'live'（編集の表示）と 'source'（ソースの表示）の2つ。
// 'reading' はノートの表示には使わず、リンクに乗せたときの小窓とチャット欄の返事（書き換えない、のぞくだけの表示）でだけ使う。
export const setMode = StateEffect.define()

// ノートの表示として受け付ける値に直す。'source' 以外（前の版の 'reading'、空、知らない値）は、編集の表示にする。
export function noteMode(value) {
  return value === 'source' ? 'source' : 'live'
}
export const setComposing = StateEffect.define()
// 開いた直後の印（quiet）。本人がエディターをクリックするかキーを押すまでは、カーソルが触れていても記号を出さない。
// 開いた直後はカーソルが本文の先頭にあるので、印がないと先頭の # や **、[[ ]] が文字のまま見えてしまう。
// true で付け、false で外す。選択を変える変更（クリック、文字の入力、タスク機能などからの選択の変更）でも外れる。
export const setCursorQuiet = StateEffect.define()

// 1つの変更のあとの印。印を付け外しする効果があればそれに従い、なければ選択を変える変更で外す。
// 外からの書き換えや一時保存の戻し（選択を変えない文字の変更）、チェックボックスの切り替えでは外さない。
export function quietAfter(quiet, tr) {
  const asked = tr.effects.filter((effect) => effect.is(setCursorQuiet)).at(-1)
  if (asked) return asked.value === true
  return quiet && tr.selection === undefined
}

// 印を外すキーか。Cmd・Ctrl・Shift・Alt だけを押したとき（リンクに乗せた小窓、Cmd+クリック）と、
// Cmd・Ctrl と組み合わせたショートカット（ノートを探す Cmd+O など）では外さない。文字を変えるショートカットは、選択も変えるのでそこで外れる。
// 日本語の変換を始めるキーでも外さない（変換の始まりで表示を変えないため。変換した文字が入ると選択が変わって外れる）。
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'OS'])
export function keyEndsQuiet(event) {
  if (!event || MODIFIER_KEYS.has(event.key)) return false
  if (event.metaKey || event.ctrlKey) return false
  if (event.isComposing || event.key === 'Process' || event.keyCode === 229) return false
  return true
}

// ノートを開いたときに、最初のカーソルを置く位置。pos（本文の最初の行の頭）が行頭の記号で始まるなら、その記号のすぐあと。
// 見出しの「# 」、箇条書きの「- 」、チェックボックスの「- [ ] 」、引用の「> 」、番号の「1. 」など（入れ子の「> - [ ] 」も）。
// 開いた直後は印（quiet）で記号を隠すので、カーソルは記号のあとに描かれる。実際の位置もそこにそろえ、打った文字が見た目どおりに入るようにする。
// 記号でないもの（先頭の [[ ]] のリンクや太字の ** など）の前では止まる（リンクの中にカーソルを入れない）。
// コールアウトの1行目（「> [!note]」）は1行まるごと部品で出すので、次の行（コールアウトの中身）で同じように決める。
const LINE_MARKS = new Set(['QuoteMark', 'HeaderMark', 'ListMark', 'TaskMarker', 'AlphaMark'])
export function typingStart(state, pos) {
  const doc = state.doc
  const line = doc.lineAt(pos)
  // 行の途中（frontmatter の終わりの行など）では動かさない。
  if (pos !== line.from) return pos
  const tree = ensureSyntaxTree(state, line.to, 200) ?? syntaxTree(state)
  const callout = findCallouts(state).find((c) => c.from === line.from)
  if (callout) return line.to < callout.to && line.number < doc.lines ? typingStart(state, line.to + 1) : line.to
  let at = line.from
  for (;;) {
    let next = at
    while (next < line.to && /[ \t]/.test(doc.sliceString(next, next + 1))) next += 1
    const node = tree.resolveInner(next, 1)
    if (!LINE_MARKS.has(node.name) || node.from !== next || node.to > line.to) break
    at = node.to
    if (doc.sliceString(at, at + 1) === ' ') at += 1
  }
  return at
}

// 印が付いているか（previewField のない状態では false）。
export function cursorQuiet(state) {
  return state.field(previewField, false)?.quiet === true
}
export const togglePropsPanel = StateEffect.define()
// ノートを動かしている間など、プロパティ欄をすべて止めるとき true。false に戻すと表示を作り直す。
export const setNoteBusy = StateEffect.define()
export const noteContext = Facet.define({
  combine: (values) => values[0] ?? { path: 'note.md', known: null, api: null },
})

export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution']
const CALLOUT_LINE = /^\s*>\s*\[!(note|tip|important|warning|caution)\]\s*$/i
const INLINE_HTML = { u: 'cm-html-u', s: 'cm-strike', kbd: 'cm-html-kbd', sub: 'cm-html-sub', sup: 'cm-html-sup', mark: 'cm-html-mark' }
const HIDE = Decoration.replace({})

// Obsidianのハイライトの6色。
const HIGHLIGHT_COLORS = [['🔴', 'red'], ['🟠', 'orange'], ['🟡', 'yellow'], ['🟢', 'green'], ['🔵', 'blue'], ['🟣', 'purple']]

// 書き換えられない表示（のぞくだけの表示と、編集できないノート）では、カーソルが見えないので、カーソルの行でも記号を出さない。
// 開いた直後の印（quiet）があるときも、まだ本人が触っていないので出さない。
function selectionToucher(state, mode, quiet = false) {
  if (mode === 'reading' || state.readOnly || quiet) return { touches: () => false, lineTouched: () => false }
  const ranges = state.selection.ranges
  return {
    touches: (from, to) => ranges.some((r) => r.from <= to && r.to >= from),
    lineTouched: (from, to = from) => {
      const start = state.doc.lineAt(from).from
      const end = state.doc.lineAt(to).to
      return ranges.some((r) => r.from <= end && r.to >= start)
    },
  }
}

export function findCallouts(state) {
  const found = []
  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state)
  tree.iterate({
    enter(node) {
      if (node.name === 'Frontmatter' || node.name === 'FencedCode') return false
      if (node.name !== 'Blockquote') return undefined
      if (node.node.parent?.name === 'Document') {
        const match = state.doc.lineAt(node.from).text.match(CALLOUT_LINE)
        if (match) found.push({ from: node.from, to: node.to, kind: match[1].toLowerCase() })
      }
      return undefined
    },
  })
  return found
}

function hideRange(add, from, to) {
  if (to > from) add(from, to, HIDE)
}

function eachLine(state, from, to, fn) {
  let line = state.doc.lineAt(from)
  for (;;) {
    fn(line)
    if (line.to >= to || line.number >= state.doc.lines) break
    line = state.doc.line(line.number + 1)
  }
}

export function buildDecorations(state, { mode = 'live', propsOpen = false, busy = false, quiet = false } = {}) {
  if (mode === 'source') return Decoration.none
  const ctx = state.facet(noteContext)
  const { touches, lineTouched } = selectionToucher(state, mode, quiet)
  const reading = mode === 'reading'
  const locked = reading || state.readOnly
  const checksLocked = ctx.editable === false
  const ranges = []
  const add = (from, to, deco) => ranges.push(deco.range(from, to))
  const addLine = (pos, cls) => {
    const at = state.doc.lineAt(pos).from
    ranges.push(Decoration.line({ class: cls }).range(at))
  }
  const doc = state.doc
  const tree = ensureSyntaxTree(state, doc.length, 500) ?? syntaxTree(state)
  const calloutFor = new Map(findCallouts(state).map((c) => [c.from, c]))

  const blockSpan = (from, to) => ({ from: doc.lineAt(from).from, to: doc.lineAt(to).to })
  const linkClass = (href) => {
    if (isExternal(href)) return 'cm-link cm-link-external'
    const target = resolveHref(ctx.path, href)
    const missing = !target || (ctx.known && !/\.[a-z0-9]+$/i.test(target.path) ? true : ctx.known && target.path.endsWith('.md') && !ctx.known.has(normalizeKey(target.path)))
    return missing && target?.path !== ctx.path ? 'cm-link cm-link-missing' : 'cm-link'
  }

  tree.iterate({
    enter(node) {
      const { name, from, to } = node
      switch (name) {
        case 'Frontmatter': {
          if (touches(from, to)) {
            eachLine(state, from, to, (line) => addLine(line.from, 'cm-frontmatter-line'))
            return false
          }
          const text = doc.sliceString(from, to)
          add(from, to, Decoration.replace({ widget: new FrontmatterWidget(text, propsOpen, from, { noteEditable: ctx.editable === true, viewEditable: state.facet(EditorView.editable), busy }), block: true }))
          return false
        }
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6':
          addLine(from, `cm-heading cm-h${name.slice(-1)}${headingPlace(state, from)}`)
          return undefined
        case 'SetextHeading1':
        case 'SetextHeading2':
          eachLine(state, from, to, (line) => addLine(line.from, `cm-heading cm-h${name.slice(-1)}${line.from === from ? headingPlace(state, from) : ''}`))
          return undefined
        case 'HeaderMark': {
          if (lineTouched(from)) return undefined
          const next = doc.sliceString(to, to + 1)
          hideRange(add, from, next === ' ' ? to + 1 : to)
          return undefined
        }
        case 'Emphasis':
          add(from, to, Decoration.mark({ class: 'cm-em' }))
          return undefined
        case 'StrongEmphasis':
          add(from, to, Decoration.mark({ class: 'cm-strong' }))
          return undefined
        case 'Strikethrough':
          add(from, to, Decoration.mark({ class: 'cm-strike' }))
          return undefined
        case 'Highlight': {
          // 「==🔴文字==」のように最初に色の絵文字があれば、その色にする。絵文字は書いている行でだけ見せる。
          const inner = doc.sliceString(from + 2, Math.min(to - 2, from + 6))
          const color = HIGHLIGHT_COLORS.find(([emoji]) => inner.startsWith(emoji))
          add(from, to, Decoration.mark({ class: color ? `cm-highlight cm-highlight-${color[1]}` : 'cm-highlight' }))
          if (color && !touches(from, to)) hideRange(add, from + 2, from + 2 + color[0].length)
          return undefined
        }
        case 'Tag':
          // リンクの文字の中の # は、Obsidianと同じくタグとして見せない。
          if (node.node.parent?.name !== 'Link') add(from, to, Decoration.mark({ class: 'cm-tag', attributes: { title: doc.sliceString(from, to) } }))
          return false
        case 'ObsidianComment':
          // のぞくだけの表示では、Obsidianの閲覧と同じく見せない。ノートの表示では薄く見せる。
          if (reading) hideRange(add, from, to)
          else add(from, to, Decoration.mark({ class: 'cm-comment' }))
          return false
        case 'ObsidianCommentBlock': {
          const span = blockSpan(from, to)
          if (reading) add(span.from, span.to, Decoration.replace({ widget: new HiddenBlockWidget(), block: true }))
          else eachLine(state, span.from, span.to, (line) => addLine(line.from, 'cm-comment-line'))
          return false
        }
        case 'InlineCode':
          add(from, to, Decoration.mark({ class: 'cm-inline-code' }))
          return undefined
        case 'EmphasisMark':
        case 'HighlightMark':
        case 'StrikethroughMark': {
          const parent = node.node.parent
          if (!touches(parent.from, parent.to)) hideRange(add, from, to)
          else add(from, to, Decoration.mark({ class: 'cm-mark' }))
          return undefined
        }
        case 'CodeMark': {
          const parent = node.node.parent
          if (parent.name === 'InlineCode') {
            if (!touches(parent.from, parent.to)) hideRange(add, from, to)
            else add(from, to, Decoration.mark({ class: 'cm-mark' }))
          }
          return undefined
        }
        case 'Escape':
          if (!touches(from, to)) hideRange(add, from, from + 1)
          return undefined
        case 'Link': {
          const marks = node.node.getChildren('LinkMark')
          const url = node.node.getChild('URL')
          if (!url || marks.length < 2) return undefined
          const href = doc.sliceString(url.from, url.to)
          const textFrom = marks[0].to
          const textTo = marks[1].from
          if (touches(from, to)) {
            add(url.from, url.to, Decoration.mark({ class: 'cm-url' }))
            return undefined
          }
          hideRange(add, from, textFrom)
          hideRange(add, textTo, to)
          if (textTo > textFrom) {
            add(textFrom, textTo, Decoration.mark({ class: linkClass(href), attributes: { 'data-href': href } }))
          }
          return undefined
        }
        case 'WikiLink': {
          if (touches(from, to)) {
            add(from, to, Decoration.mark({ class: 'cm-url' }))
            return false
          }
          add(from, to, Decoration.replace({ widget: new WikiLinkWidget(wikiLinkOf(doc.sliceString(from + 2, to - 2), ctx)) }))
          return false
        }
        case 'Image': {
          const url = node.node.getChild('URL')
          if (!url || touches(from, to)) return false
          const href = doc.sliceString(url.from, url.to)
          const marks = node.node.getChildren('LinkMark')
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : ''
          add(from, to, Decoration.replace({ widget: new ImageWidget(href, alt, ctx) }))
          return false
        }
        case 'Autolink': {
          const url = node.node.getChild('URL')
          if (!url) return undefined
          const href = doc.sliceString(url.from, url.to)
          if (!touches(from, to)) {
            hideRange(add, from, url.from)
            hideRange(add, url.to, to)
          }
          add(url.from, url.to, Decoration.mark({ class: 'cm-link cm-link-external', attributes: { 'data-href': href } }))
          return false
        }
        case 'URL': {
          const parent = node.node.parent?.name
          if (parent === 'Link' || parent === 'Image' || parent === 'Autolink' || parent === 'LinkReference') return undefined
          const href = doc.sliceString(from, to)
          add(from, to, Decoration.mark({ class: 'cm-link cm-link-external', attributes: { 'data-href': href } }))
          return undefined
        }
        case 'Blockquote': {
          const callout = calloutFor.get(from)
          eachLine(state, from, to, (line) => {
            if (!callout) {
              addLine(line.from, 'cm-quote')
              return
            }
            const first = line.from === doc.lineAt(from).from
            const last = line.to >= to
            addLine(
              line.from,
              `cm-callout cm-callout-${callout.kind}${first ? ' cm-callout-first' : ''}${last ? ' cm-callout-last' : ''}`,
            )
          })
          if (callout && !lineTouched(from)) {
            const line = doc.lineAt(from)
            add(line.from, line.to, Decoration.replace({ widget: new CalloutTitleWidget(callout.kind) }))
          }
          return undefined
        }
        case 'QuoteMark': {
          if (lineTouched(from)) return undefined
          const line = doc.lineAt(from)
          const callout = [...calloutFor.values()].find((c) => c.from === line.from)
          if (callout) return undefined
          hideRange(add, from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to)
          return undefined
        }
        case 'ListMark': {
          const item = node.node.parent
          const task = item?.getChild('Task')
          const marker = task?.getChild('TaskMarker')
          if (marker) {
            if (!touches(from, marker.to)) hideRange(add, from, marker.from)
            return undefined
          }
          if (item?.parent?.name === 'BulletList') {
            if (!lineTouched(from)) add(from, to, Decoration.replace({ widget: new BulletWidget(listDepth(item)) }))
          } else {
            add(from, to, Decoration.mark({ class: 'cm-list-number' }))
          }
          return undefined
        }
        case 'TaskMarker': {
          const checked = /x/i.test(doc.sliceString(from, to))
          const parent = node.node.parent
          if (checked && parent) {
            const textFrom = Math.min(to + 1, parent.to)
            if (parent.to > textFrom) add(textFrom, parent.to, Decoration.mark({ class: 'cm-task-done' }))
          }
          if (!touches(from, to)) {
            add(from, to, Decoration.replace({ widget: new CheckboxWidget(checked, from, checksLocked) }))
          }
          return undefined
        }
        case 'HorizontalRule':
          if (!lineTouched(from)) {
            addLine(from, 'cm-hr')
            hideRange(add, from, to)
          }
          return false
        case 'FencedCode': {
          const span = blockSpan(from, to)
          const info = node.node.getChild('CodeInfo')
          const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : ''
          if (lang === 'mermaid' && !touches(span.from, span.to) && !ctx.isTooltip) {
            const text = node.node.getChild('CodeText')
            const source = text ? doc.sliceString(text.from, text.to) : ''
            add(span.from, span.to, Decoration.replace({ widget: new MermaidWidget(source), block: true }))
            return false
          }
          const open = touches(span.from, span.to)
          const firstLine = doc.lineAt(span.from).number
          const lastLine = doc.lineAt(span.to).number
          eachLine(state, span.from, span.to, (line) => {
            let cls = 'cm-codeblock'
            if (line.number === firstLine) cls += ' cm-codeblock-first'
            if (line.number === lastLine) cls += ' cm-codeblock-last'
            addLine(line.from, cls)
            if (!open && (line.number === firstLine || (line.number === lastLine && lastLine !== firstLine))) {
              hideRange(add, line.from, line.to)
            }
          })
          return false
        }
        case 'CodeBlock':
          eachLine(state, from, to, (line) => addLine(line.from, 'cm-codeblock'))
          return false
        case 'Table': {
          const span = blockSpan(from, to)
          if (touches(span.from, span.to)) {
            eachLine(state, span.from, span.to, (line) => addLine(line.from, 'cm-table-source'))
            return false
          }
          // 引用や箇条書きの中の表は、行頭の記号を表の操作で壊さないよう文字のまま見せる。
          if (node.node.parent?.name !== 'Document') {
            eachLine(state, span.from, span.to, (line) => addLine(line.from, 'cm-table-source'))
            return undefined
          }
          const widget = new TableWidget(doc.sliceString(span.from, span.to), ctx, locked)
          add(span.from, span.to, Decoration.replace({ widget, block: true }))
          return false
        }
        case 'MathBlock': {
          const span = blockSpan(from, to)
          if (touches(span.from, span.to)) return false
          const source = doc.sliceString(from, to).trim().replace(/^\$\$/, '').replace(/\$\$$/, '')
          add(span.from, span.to, Decoration.replace({ widget: new MathWidget(source, true), block: true }))
          return false
        }
        case 'InlineMath': {
          if (touches(from, to)) return false
          add(from, to, Decoration.replace({ widget: new MathWidget(doc.sliceString(from + 1, to - 1), false) }))
          return false
        }
        case 'Comment':
          if (reading) hideRange(add, from, to)
          else add(from, to, Decoration.mark({ class: 'cm-comment' }))
          return false
        case 'CommentBlock': {
          const span = blockSpan(from, to)
          if (reading) add(span.from, span.to, Decoration.replace({ widget: new HiddenBlockWidget(), block: true }))
          else eachLine(state, span.from, span.to, (line) => addLine(line.from, 'cm-comment-line'))
          return false
        }
        case 'HTMLTag':
          decorateInlineHtml(node, doc, touches, add)
          return false
        case 'HTMLBlock':
          eachLine(state, from, to, (line) => addLine(line.from, 'cm-html-block'))
          return false
        default:
          return undefined
      }
    },
  })

  addIndentGuides(state, add)
  // 「a. 」「b. 」の英字の項目（alpha-list.mjs）。記号を番号と同じ色にし、字下げの線を付ける。
  for (const item of alphaItemsIn(state)) {
    add(item.markFrom, item.markTo, Decoration.mark({ class: 'cm-list-number' }))
    if (item.indent) add(item.line.from + item.quote.length, item.markFrom, Decoration.mark({ class: 'cm-indent-guide' }))
  }
  return Decoration.set(ranges, true)
}

function decorateInlineHtml(node, doc, touches, add) {
  const text = doc.sliceString(node.from, node.to)
  if (/^<br\s*\/?>$/i.test(text)) {
    if (!touches(node.from, node.to)) add(node.from, node.to, Decoration.replace({ widget: new LineBreakWidget() }))
    return
  }
  const open = text.match(/^<([a-z]+)(\s[^>]*)?>$/i)
  if (!open) return
  const cls = INLINE_HTML[open[1].toLowerCase()]
  if (!cls) return
  const closing = `</${open[1].toLowerCase()}>`
  const line = doc.lineAt(node.from)
  const rest = doc.sliceString(node.to, line.to)
  const at = rest.toLowerCase().indexOf(closing)
  if (at < 0) return
  const closeFrom = node.to + at
  const closeTo = closeFrom + closing.length
  if (touches(node.from, closeTo)) return
  hideRange(add, node.from, node.to)
  hideRange(add, closeFrom, closeTo)
  if (closeFrom > node.to) add(node.to, closeFrom, Decoration.mark({ class: cls }))
}

// ノートの先頭（前にあるのが空行と frontmatter だけ）かどうか。先頭の見出しには上の余白を付けない（Obsidianの閲覧の表示と同じ）。
export function atNoteStart(state, pos) {
  let start = 0
  const first = syntaxTree(state).topNode.firstChild
  if (first?.name === 'Frontmatter' && first.from === 0) start = first.to
  // 先頭から順に見て、空白以外が出たところで止める（長いノートで毎回全部を切り出さない）。
  for (const iter = state.doc.iterRange(start, pos); !iter.next().done; ) {
    if (iter.value.trim() !== '') return false
  }
  return true
}

// 見出しの上の余白を決めるための印。ノートの先頭なら cm-heading-first（余白なし）。
// 前のかたまりが段落・コード・表・箇条書きなら cm-heading-after-block（広く空ける。Obsidianの --heading-spacing）。
// Obsidianの :is(p,pre,table,ul,ol) + 見出し と同じで、見出し・引用・コールアウト・区切り線のあとには付けない。
const AFTER_BLOCK = new Set(['Paragraph', 'FencedCode', 'CodeBlock', 'Table', 'BulletList', 'OrderedList'])

export function headingPlace(state, pos) {
  if (atNoteStart(state, pos)) return ' cm-heading-first'
  let line = state.doc.lineAt(pos)
  while (line.number > 1) {
    line = state.doc.line(line.number - 1)
    if (line.text.trim() !== '') break
  }
  // 前の行を含む、いちばん外側のかたまり（Document の子）の種類で決める。
  let block = syntaxTree(state).resolveInner(line.from, 1)
  while (block.parent && block.parent.name !== 'Document') block = block.parent
  return AFTER_BLOCK.has(block.name) ? ' cm-heading-after-block' : ''
}

// 箇条書き・番号付きの入れ子の深さ（いちばん外が1）。番号付きの下の箇条書きも1段深く数える（HTML の ol の中の ul と同じ）。
// 英字の項目（「a. 」、alpha-list.mjs）は入れ物の木を持たないので、項目そのものを1段と数える。
function listDepth(item) {
  let depth = 0
  for (let node = item?.parent; node; node = node.parent) {
    if (node.name === 'BulletList' || node.name === 'OrderedList' || node.name === 'AlphaItem') depth += 1
  }
  return depth
}

function addIndentGuides(state, add) {
  const lines = state.doc.lines
  if (lines > 20000) return
  for (let n = 1; n <= lines; n++) {
    const line = state.doc.line(n)
    const match = line.text.match(/^([\t ]+)(?:[-*+]|\d+[.)])\s/)
    if (match) add(line.from, line.from + match[1].length, Decoration.mark({ class: 'cm-indent-guide' }))
  }
}

export const previewField = StateField.define({
  create(state) {
    // 印（quiet）は、ノートを開いたあとに setCursorQuiet で付ける。ここで付けると、カーソルの行を見せたい場面（小窓など）でも隠れるため。
    return { deco: buildDecorations(state, { mode: 'live' }), mode: 'live', composing: false, propsOpen: false, busy: false, quiet: false }
  },
  update(value, tr) {
    let { mode, composing, propsOpen, busy } = value
    const quiet = quietAfter(value.quiet, tr)
    let changed = quiet !== value.quiet
    for (const effect of tr.effects) {
      if (effect.is(setMode)) {
        mode = effect.value
        changed = true
      } else if (effect.is(setComposing)) {
        composing = effect.value
        changed = true
      } else if (effect.is(togglePropsPanel)) {
        propsOpen = effect.value ?? !propsOpen
        changed = true
      } else if (effect.is(setNoteBusy)) {
        busy = effect.value === true
        changed = true
      }
    }
    // 日本語の変換中は表示を切り替えない。変換が終わってからまとめて直す。
    // 印は変換中も覚えておく（開いてすぐ日本語を打ったときに、印が残ったままにならないように）。
    if (composing) return { ...value, composing, mode, propsOpen, busy, quiet, deco: value.deco.map(tr.changes) }
    if (changed || tr.docChanged || tr.selection) {
      return { deco: buildDecorations(tr.state, { mode, propsOpen, busy, quiet }), mode, composing, propsOpen, busy, quiet }
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
})

export function hiddenRanges(state) {
  const set = state.field(previewField).deco
  const hidden = []
  set.between(0, state.doc.length, (from, to, deco) => {
    if (deco.spec.widget === undefined && to > from && deco.point) hidden.push(state.doc.sliceString(from, to))
  })
  return hidden
}
