import { historyField, isolateHistory, redo, undo } from '@codemirror/commands'
import { runScopeHandlers, WidgetType } from '@codemirror/view'

import { fileUrl } from './access.mjs'
import { askText, showMessage } from './dialogs.mjs'
import { historyKey, isCommandKey } from './keys.mjs'
import { isExternal, resolveHref, wikiLinkOf } from './links.mjs'
import {
  addColumn,
  addRow,
  deleteColumn,
  deleteRow,
  moveColumn,
  moveRow,
  nextCell,
  parseTable,
  replaceCell,
  setAlign,
  sortRows,
} from './table-model.mjs'
import { DATE_FIELD_IDLE, dateFieldStep, isTaskItems, propsRowAccess, statusOptions, taskFieldKind } from './tasks.mjs'
import { deleteProperty, parseFrontmatter, renameProperty, setProperty } from './yaml-lite.mjs'

const CALLOUT_LABEL = {
  note: ['ℹ', 'Note'],
  tip: ['💡', 'Tip'],
  important: ['❗', 'Important'],
  warning: ['⚠', 'Warning'],
  caution: ['🛑', 'Caution'],
}
const INLINE_RULES = [
  { re: /`([^`]+)`/, make: (m) => element('code', {}, [m[1]]) },
  { re: /\*\*([^*]+)\*\*|__([^_]+)__/, make: (m, r) => element('strong', {}, r(m[1] ?? m[2])) },
  { re: /\*([^*]+)\*|(?<![\w])_([^_]+)_(?![\w])/, make: (m, r) => element('em', {}, r(m[1] ?? m[2])) },
  { re: /~~([^~]+)~~/, make: (m, r) => element('s', {}, r(m[1])) },
  { re: /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/, make: (m, r, ctx) => imageElement(m[2], m[1], ctx) },
  {
    re: /(?<![!\\])\[\[([^[\]\n]+)\]\](?!\()/,
    make: (m, r, ctx) => {
      const link = wikiLinkOf(m[1], ctx)
      return link ? wikiElement(link) : m[0]
    },
  },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)[^)]*\)/,
    make: (m, r) => element('a', { class: 'cm-link', 'data-href': m[2] }, r(m[1])),
  },
  {
    re: /https?:\/\/[^\s<>)]+/,
    make: (m) => element('a', { class: 'cm-link cm-link-external', 'data-href': m[0] }, [m[0]]),
  },
]

function element(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  for (const child of children) node.append(child)
  return node
}

export function assetUrl(ctx, href) {
  if (isExternal(href)) return /^https?:/i.test(href) ? href : null
  const target = resolveHref(ctx.path, href)
  return target ? fileUrl(target.path) : null
}

function wikiElement({ label, href, missing }) {
  const missingClass = missing ? ' cm-link-missing' : ''
  if (href === null) return element('span', { class: `cm-link${missingClass}`, title: 'このファイルはエディターでは開けません' }, [label])
  return element('a', { class: `cm-link${missingClass}`, 'data-href': href }, [label])
}

// ボタンを押して読み込みを許したネット上の画像のURL。このタブを開いている間だけ覚える（モジュール内で全ウィジェット共通）。
// 編集で表示が作り直されても、ボタンに戻らないようにするため。テストでは ctx.allowed で差し替えられる。
export const allowedImages = new Set()

// 画面には触らず、画像をどう出すかだけを決める。
export function imagePlan(url, ctx) {
  if (!url) return { kind: 'missing' }
  const external = /^https?:/i.test(url)
  // チャット枠の返事に書かれた外部の画像は読みに行かない。会話の中身をURLに載せて外へ出せてしまうため。
  if (ctx.localImagesOnly && /^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('data:')) return { kind: 'blocked' }
  if (external && !(ctx.allowed ?? allowedImages).has(url)) return { kind: 'ask', url }
  return { kind: 'show', url }
}

function loadedImage(url, alt, href, onLoad) {
  const image = element('img', { src: url, alt, class: 'cm-image', loading: 'lazy', referrerpolicy: 'no-referrer' })
  if (onLoad) image.addEventListener('load', onLoad)
  image.addEventListener('error', () => {
    image.replaceWith(element('span', { class: 'cm-image-missing' }, [`画像を開けません: ${alt || href}`]))
  })
  return image
}

// 外側の要素は変えない。CodeMirrorは部品が最初に返した要素を覚えていて、差し替えられると
// 次の描き直しで元の要素（ボタン）を戻してしまうため。中身だけを入れ替える。
function imageElement(href, alt, ctx, onLoad) {
  const box = element('span', { class: 'cm-image-box' })
  const plan = imagePlan(assetUrl(ctx, href), ctx)
  if (plan.kind === 'missing') box.append(element('span', { class: 'cm-image-missing' }, [alt || href]))
  else if (plan.kind === 'blocked') box.append(element('span', { class: 'cm-image-missing' }, [`外部の画像は表示しません: ${alt || href}`]))
  else if (plan.kind === 'ask') {
    const button = askButton(`外部の画像を表示：${alt || plan.url}`, () => {
      ;(ctx.allowed ?? allowedImages).add(plan.url)
      box.replaceChildren(loadedImage(plan.url, alt, href, onLoad))
    })
    box.append(button)
  } else box.append(loadedImage(plan.url, alt, href, onLoad))
  return box
}

// ボタンを押す前にエディターが選択範囲を動かすと、部品が作り直されて押せなくなる。押す前の操作を止める。
function askButton(label, onPress) {
  const button = element('button', { type: 'button', class: 'cm-image-ask' }, [label])
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onPress()
  })
  return button
}

const onAskButton = (event) => event.target instanceof Element && event.target.closest('.cm-image-ask') !== null

// Mermaidの図のソースが、外のURLを読みに行きそうかを描く前に調べる。描くときに画像や @import が読まれるため、
// 描いたあとの掃除では間に合わない。疑わしければ描かず、ボタンを押すまで待つ。
export function hasExternalRef(source) {
  // タブや改行はURLの解釈で無視されるので、先に制御文字を取り除いてから調べる（"ht<TAB>tps:" 対策）。
  const text = source.replace(/[\u0000-\u001f\u007f]/g, '')
  return /https?:|\/\/|\\|img|\bimage\s*:|url\(|@import|image-set|themecss/i.test(text)
}

// href の行き先が、このページと別の場所（または読み取れない値）なら true。'#' で始まる図の中の参照は内側なので false。
export function isExternalHref(value, base, origin) {
  const v = value.replace(/[\u0000-\u0020\u007f]/g, '')
  if (v.startsWith('#')) return false
  if (v.includes('\\')) return true
  try {
    const url = new URL(v, base)
    if (url.protocol === 'data:') return false
    return url.origin !== origin
  } catch {
    return true
  }
}

// 要素の href を残してよいか。外を指すものは消す。ただし、ユーザーがボタンで許した図の <image> の
// http(s) の画像だけは残す。リンク（<a>）や他の要素、http(s) 以外は許さない。
export function keepHref(tag, value, base, origin, allowExternalImages) {
  if (!isExternalHref(value, base, origin)) return true
  if (!allowExternalImages || tag.toLowerCase() !== 'image') return false
  return /^https?:\/\/[^\\]*$/i.test(value.replace(/[\u0000-\u0020\u007f]/g, ''))
}

const CSS_FUNCTIONS = /(?:-webkit-)?(?:url|image-set|image|cross-fade|element|src)\(/gi

// CSSの中の @import と、外を指すかもしれない url() / image-set() などを取り除く。
// CSSのエスケープ（u\72l など）で関数名を隠せるので、先にエスケープを展開してから調べる。
export function cleanCss(text) {
  let css = text
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_, hex) => {
      const code = parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/\\(.)/gs, '$1')
  css = css.replace(/@import[^;{}]*;?/gi, '')
  let out = ''
  let last = 0
  CSS_FUNCTIONS.lastIndex = 0
  let m
  while ((m = CSS_FUNCTIONS.exec(css))) {
    let depth = 1
    let i = CSS_FUNCTIONS.lastIndex
    let quote = ''
    for (; i < css.length && depth > 0; i++) {
      const c = css[i]
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '(') depth++
      else if (c === ')') depth--
    }
    const inner = css.slice(CSS_FUNCTIONS.lastIndex, depth === 0 ? i - 1 : i).trim().replace(/^["']\s*/, '')
    const internal = /^url\(/i.test(m[0]) && inner.startsWith('#')
    out += css.slice(last, m.index) + (internal ? css.slice(m.index, i) : 'none')
    last = i
    CSS_FUNCTIONS.lastIndex = i
  }
  return out + css.slice(last)
}

// 描いたSVGを走査して、外のURLを読む属性とCSSを取り除く。
function stripExternalFromDom(root, allowExternalImages) {
  const origin = location.origin
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name === 'href' || name === 'xlink:href' || name.endsWith(':href')) {
        if (!keepHref(el.localName, attr.value, location.href, origin, allowExternalImages)) el.removeAttribute(attr.name)
      } else if (name === 'style') el.setAttribute(attr.name, cleanCss(attr.value))
    }
    if (el.localName === 'style') el.textContent = cleanCss(el.textContent)
  }
}

export function renderInline(text, ctx) {
  const render = (value) => {
    let best = null
    for (const rule of INLINE_RULES) {
      const match = rule.re.exec(value)
      if (match && (!best || match.index < best.match.index)) best = { match, rule }
    }
    if (!best) return [value.replace(/\\\|/g, '|')]
    const { match, rule } = best
    const before = value.slice(0, match.index)
    const after = value.slice(match.index + match[0].length)
    return [
      ...(before ? render(before) : []),
      rule.make(match, render, ctx),
      ...(after ? render(after) : []),
    ]
  }
  return render(text)
}

export class WikiLinkWidget extends WidgetType {
  constructor(link) {
    super()
    this.link = link
  }
  eq(other) {
    return other.link.label === this.link.label && other.link.href === this.link.href && other.link.missing === this.link.missing
  }
  toDOM() {
    return wikiElement(this.link)
  }
  // Alt+クリックでカーソルを入れられるよう、エディターにも渡す。リンクを開く処理は先に動く。
  ignoreEvent() {
    return false
  }
}

// 箇条書きの記号。段（level、いちばん外が1）ごとに「• → ◦ → ▪」を繰り返す。見せ方だけで、ファイルの「-」は変えない。
const BULLET_SYMBOLS = ['•', '◦', '▪']

export class BulletWidget extends WidgetType {
  constructor(level = 1) {
    super()
    this.level = level
    this.symbol = BULLET_SYMBOLS[(Math.max(level, 1) - 1) % BULLET_SYMBOLS.length]
  }
  eq(other) {
    return other.symbol === this.symbol
  }
  toDOM() {
    return element('span', { class: `cm-bullet cm-bullet-${BULLET_SYMBOLS.indexOf(this.symbol) + 1}`, 'aria-hidden': 'true' }, [this.symbol])
  }
  // 押したときに子を開閉できるよう、押した操作だけはエディターにも渡す（main.mjs の mousedown）。
  ignoreEvent(event) {
    return event.type !== 'mousedown'
  }
}

export class LineBreakWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    return element('br')
  }
}

export class HiddenBlockWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    return element('div', { class: 'cm-hidden-block' })
  }
  get estimatedHeight() {
    return 0
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(checked, pos, readOnly = false) {
    super()
    this.checked = checked
    this.pos = pos
    this.readOnly = readOnly
  }
  eq(other) {
    return other.checked === this.checked && other.readOnly === this.readOnly
  }
  toDOM(view) {
    const box = element('input', { type: 'checkbox', class: 'cm-task-box', 'aria-label': 'チェック項目' })
    box.checked = this.checked
    box.disabled = this.readOnly
    box.addEventListener('mousedown', (event) => event.preventDefault())
    box.addEventListener('click', (event) => {
      event.preventDefault()
      const pos = view.posAtDOM(box)
      const text = view.state.doc.sliceString(pos, pos + 3)
      if (!/^\[[ xX]\]$/.test(text)) return
      view.dispatch({ changes: { from: pos, to: pos + 3, insert: /x/i.test(text) ? '[ ]' : '[x]' } })
    })
    return box
  }
  ignoreEvent() {
    return true
  }
}

export class CalloutTitleWidget extends WidgetType {
  constructor(kind) {
    super()
    this.kind = kind
  }
  eq(other) {
    return other.kind === this.kind
  }
  toDOM() {
    const [icon, label] = CALLOUT_LABEL[this.kind]
    return element('span', { class: 'cm-callout-title' }, [`${icon} ${label}`])
  }
}

export class ImageWidget extends WidgetType {
  constructor(href, alt, ctx) {
    super()
    this.href = href
    this.alt = alt
    this.ctx = ctx
  }
  eq(other) {
    return other.href === this.href && other.alt === this.alt && other.ctx.path === this.ctx.path
  }
  toDOM(view) {
    return imageElement(this.href, this.alt, this.ctx, () => view.requestMeasure())
  }
  get estimatedHeight() {
    return 120
  }
  ignoreEvent(event) {
    return onAskButton(event) || event.type !== 'mousedown'
  }
}

export class MathWidget extends WidgetType {
  constructor(source, block) {
    super()
    this.source = source
    this.block = block
  }
  eq(other) {
    return other.source === this.source && other.block === this.block
  }
  toDOM(view) {
    const node = element(this.block ? 'div' : 'span', { class: this.block ? 'cm-math-block' : 'cm-math' }, [this.source])
    import('katex')
      .then(({ default: katex }) => {
        katex.render(this.source, node, { displayMode: this.block, throwOnError: false, trust: false, strict: 'ignore' })
        view.requestMeasure()
      })
      .catch(() => {})
    return node
  }
  ignoreEvent() {
    return false
  }
}

let mermaidCounter = 0
const mermaidCache = new Map()

// エディターで明るい・暗いを選んでいれば、それに合わせる。選んでいなければアプリの設定に従う。
function darkNow() {
  const chosen = document.documentElement.dataset.theme
  return chosen ? chosen === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
}

async function renderMermaid(source, dark, allowExternalImages = false) {
  const key = `${dark ? 'dark' : 'light'}:${allowExternalImages ? 'ext:' : ''}${source}`
  if (mermaidCache.has(key)) return mermaidCache.get(key)
  const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([import('mermaid'), import('dompurify')])
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', htmlLabels: false, flowchart: { htmlLabels: false } })
  mermaidCounter += 1
  const { svg } = await mermaid.render(`note-mermaid-${mermaidCounter}`, source)
  const fragment = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'], RETURN_DOM_FRAGMENT: true })
  stripExternalFromDom(fragment, allowExternalImages)
  const holder = document.createElement('div')
  holder.append(fragment)
  const clean = holder.innerHTML
  mermaidCache.set(key, clean)
  return clean
}

export class MermaidWidget extends WidgetType {
  constructor(source) {
    super()
    this.source = source
    // 明暗が変わったら描き直すよう、作ったときの明暗も覚えて比べる。
    this.dark = darkNow()
  }
  eq(other) {
    return other.source === this.source && other.dark === this.dark
  }
  toDOM(view) {
    const node = element('div', { class: 'cm-mermaid' }, ['図を描いています…'])
    const draw = () => {
      node.replaceChildren('図を描いています…')
      renderMermaid(this.source, this.dark, allowedImages.has(`mermaid:${this.source}`))
        .then((svg) => {
          node.innerHTML = svg
          view.requestMeasure()
        })
        .catch((error) => {
          node.replaceChildren(element('pre', { class: 'cm-mermaid-error' }, [`図を描けません: ${error.message}\n\n${this.source}`]))
          view.requestMeasure()
        })
    }
    // 外のURLを読みそうな図は、描く前にボタンで確かめる。許した図は、この先も描き直しで確認を求めない。
    const key = `mermaid:${this.source}`
    if (hasExternalRef(this.source) && !allowedImages.has(key)) {
      node.replaceChildren(askButton('外部の画像などを読み込む：図', () => {
        allowedImages.add(key)
        draw()
        view.requestMeasure()
      }))
    } else draw()
    return node
  }
  get estimatedHeight() {
    return 200
  }
  ignoreEvent(event) {
    return onAskButton(event) ? true : false
  }
}

// 置き換える前に、その場所の文字が部品を作ったときのままか確かめる。違えば書き換えない。
function replaceAt(view, from, source, next, annotations = []) {
  if (view.state.doc.sliceString(from, from + source.length) !== source) {
    showMessage('内容が変わったので、この操作は行いませんでした。もう一度やり直してください。')
    return false
  }
  if (source !== next) view.dispatch({ changes: { from, to: from + source.length, insert: next }, annotations })
  return true
}

function replaceBlock(view, node, source, next, annotations = []) {
  if (!view.contentDOM.contains(node)) {
    showMessage('内容が変わったので、この操作は行いませんでした。もう一度やり直してください。')
    return false
  }
  return replaceAt(view, view.posAtDOM(node), source, next, annotations)
}

// readOnly を見ずに、履歴を1つ戻す（進める）。@codemirror/commands の undo/redo は readOnly のとき何もしないため、
// 同じ中身（historyField の pop を取り出して dispatch する）を、ここだけで行う。
export function historyStep(view, side) {
  const history = view.state.field(historyField, false)
  if (typeof history?.pop !== 'function') return false
  const tr = history.pop(side, view.state, false)
  if (!tr) return false
  view.dispatch(tr)
  return true
}

// プロパティ欄で値を直したときの、新しいプロパティの文字。タスクのノートの title は、いつも二重引用符で書く。
export function propsValueSource(source, key, value, task = false) {
  return setProperty(source, key, value, { quote: task && key === 'title' })
}

// 作り直した欄に、同じ項目のフォーカスを戻す（続けて Cmd+Z を押せるように）。
function focusPropsField(view, key) {
  for (const field of view.dom.querySelectorAll('.cm-props .cm-props-value')) {
    if (field.getAttribute('aria-label') === key && !field.disabled) {
      field.focus()
      return
    }
  }
}

const menuHost = { current: null }

function closeMenu() {
  menuHost.current?.remove()
  menuHost.current = null
  document.removeEventListener('keydown', closeOnEscape, true)
}

function closeOnEscape(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closeMenu()
}

export function showMenu(event, items) {
  closeMenu()
  const menu = element('div', { class: 'note-menu', role: 'menu' })
  // 押してもエディターのカーソルと選択を保つ。
  menu.addEventListener('mousedown', (e) => e.preventDefault())
  for (const item of items) {
    if (item === '-') {
      menu.append(element('hr'))
      continue
    }
    const button = element('button', { type: 'button', role: 'menuitem' }, [item.label])
    button.addEventListener('click', () => {
      closeMenu()
      item.run()
    })
    menu.append(button)
  }
  menu.style.left = `${event.clientX}px`
  menu.style.top = `${event.clientY}px`
  document.body.append(menu)
  menuHost.current = menu
  document.addEventListener('keydown', closeOnEscape, true)
  const rect = menu.getBoundingClientRect()
  if (rect.bottom > innerHeight) menu.style.top = `${Math.max(4, innerHeight - rect.height - 4)}px`
  if (rect.right > innerWidth) menu.style.left = `${Math.max(4, innerWidth - rect.width - 4)}px`
  setTimeout(() => document.addEventListener('mousedown', function onDown(e) {
    if (!menu.contains(e.target)) {
      closeMenu()
      document.removeEventListener('mousedown', onDown)
    }
  }), 0)
}

// マスと欄で、打った文字をブラウザーの取り消しで戻した状態を覚えておく。
const typingUndone = new WeakSet()

function watchTyping(field) {
  field.addEventListener('input', (event) => {
    if (!event.inputType?.startsWith('history')) typingUndone.delete(field)
  })
}

// マスと欄の取り消し。打った文字があるうちはブラウザーに任せ、なくなったらエディター本体の履歴を戻す。
function runFieldHistory(event, view, field, changed, close) {
  const kind = historyKey(event)
  if (!kind) return false
  if (changed || (kind === 'redo' && typingUndone.has(field))) {
    if (kind === 'undo') typingUndone.add(field)
    return true
  }
  event.preventDefault()
  close()
  view.focus()
  if (kind === 'undo') undo(view)
  else redo(view)
  return true
}

function caretOffset(cell) {
  // 書き戻すと「|」が「\|」になって文字数が変わるので、そのときは末尾に置く。
  if (cell.textContent.includes('|')) return Infinity
  const selection = getSelection()
  if (!selection.rangeCount || !cell.contains(selection.focusNode)) return cell.textContent.length
  const before = document.createRange()
  before.selectNodeContents(cell)
  before.setEnd(selection.focusNode, selection.focusOffset)
  return before.toString().length
}

function setCaretOffset(cell, offset) {
  const text = cell?.firstChild
  if (text?.nodeType !== Node.TEXT_NODE) return
  getSelection().collapse(text, Math.min(offset, text.length))
}

function isSearchKey(event) {
  return event.key.toLowerCase() === 'f'
}

function isSaveKey(event) {
  return event.key.toLowerCase() === 's' && !event.altKey && !event.shiftKey
}

function tableWrapAt(view, from) {
  for (const wrap of view.contentDOM.querySelectorAll('.cm-table-wrap')) {
    if (view.posAtDOM(wrap) === from) return wrap
  }
  return null
}

// 位置を手がかりにマスを探して編集を始める。書き戻すと表が作り直されるので、前の要素は使えない。
export function beginTableCell(view, from, row, col) {
  const cell = tableWrapAt(view, from)?.querySelector(`[data-row="${row}"][data-col="${col}"]`)
  if (!cell) return false
  cell.dispatchEvent(new CustomEvent('note-cell-begin'))
  return true
}

// 「＋」を押したとき。編集中のマスを書き戻してから、今の表に行や列を足して、新しいマスを開く。
function growTable(view, wrap, grow) {
  if (!view.contentDOM.contains(wrap)) return
  const from = view.posAtDOM(wrap)
  document.activeElement?.closest?.('.cm-cell-editing')?.blur()
  const current = tableWrapAt(view, from)
  if (!current) return
  const { next, row, col } = grow(current.noteSource)
  if (replaceAt(view, from, current.noteSource, next)) beginTableCell(view, from, row, col)
}

function growButton(view, wrap, className, label, grow) {
  const button = element('button', { type: 'button', class: `cm-table-add ${className}`, title: label, 'aria-label': label, tabindex: '-1' }, ['＋'])
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', () => growTable(view, wrap, grow))
  return button
}

export class TableWidget extends WidgetType {
  constructor(source, ctx, readOnly) {
    super()
    this.source = source
    this.ctx = ctx
    this.readOnly = readOnly
  }
  eq(other) {
    return other.source === this.source && other.readOnly === this.readOnly && other.ctx.path === this.ctx.path
  }
  toDOM(view) {
    const { rows, align } = parseTable(this.source)
    const wrap = element('div', { class: this.readOnly ? 'cm-table-wrap cm-table-readonly' : 'cm-table-wrap' })
    wrap.noteSource = this.source
    const table = element('table', { class: 'cm-table' })
    const make = (row, rowIndex, tag) => {
      const tr = element('tr')
      const count = Math.max(align.length, row.cells.length)
      for (let col = 0; col < count; col++) {
        const raw = row.cells[col]?.text ?? ''
        const cell = element(tag, { 'data-row': String(rowIndex), 'data-col': String(col), ...(align[col] ? { style: `text-align:${align[col]}` } : {}) })
        cell.append(...renderInline(raw, this.ctx))
        if (!this.readOnly) this.bindCell(view, wrap, cell, rowIndex, col, raw)
        tr.append(cell)
      }
      return tr
    }
    const head = element('thead')
    if (rows[0]) head.append(make(rows[0], 0, 'th'))
    const body = element('tbody')
    rows.slice(2).forEach((row, index) => body.append(make(row, index + 2, 'td')))
    table.append(head, body)
    const scroller = element('div', { class: 'cm-table-scroll' })
    scroller.append(table)
    wrap.append(scroller)
    if (!this.readOnly) {
      wrap.append(
        growButton(view, wrap, 'cm-table-add-col', '右に列を追加', (source) => {
          const parsed = parseTable(source)
          const count = Math.max(parsed.align.length, parsed.rows[0]?.cells.length ?? 0)
          return { next: addColumn(source, count - 1, true), row: 0, col: count }
        }),
        growButton(view, wrap, 'cm-table-add-row', '下に行を追加', (source) => {
          const { rows } = parseTable(source)
          return { next: addRow(source, rows.length - 2, true), row: rows.length, col: 0 }
        }),
      )
    }
    return wrap
  }
  bindCell(view, wrap, cell, rowIndex, col, raw) {
    cell.setAttribute('tabindex', '0')
    const begin = () => {
      if (cell.isContentEditable) return
      cell.contentEditable = 'plaintext-only'
      cell.textContent = raw
      cell.classList.add('cm-cell-editing')
      cell.focus()
      const range = document.createRange()
      range.selectNodeContents(cell)
      range.collapse(false)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    }
    // 変更して書き戻したら、書き戻したあとの表の文字を返す。
    const commit = (cancel = false) => {
      if (!cell.isContentEditable) return null
      const text = cell.textContent
      cell.contentEditable = 'false'
      cell.classList.remove('cm-cell-editing')
      if (cancel || text.trim() === raw.trim()) {
        cell.replaceChildren(...renderInline(raw, this.ctx))
        return null
      }
      const next = replaceCell(this.source, rowIndex, col, text)
      return replaceBlock(view, wrap, this.source, next) ? next : false
    }
    cell.addEventListener('note-cell-begin', begin)
    // 今のマスを書き戻してから、次のマスの編集を始める。
    const moveTo = (delta) => {
      if (!view.contentDOM.contains(wrap)) return
      const from = view.posAtDOM(wrap)
      let source = this.source
      const changed = commit()
      if (changed === false) return
      if (changed !== null) source = changed
      const target = delta === 'down'
        ? { row: rowIndex === 0 ? 2 : rowIndex + 1, col }
        : nextCell(source, rowIndex, col, delta)
      if (target.add) {
        const next = addRow(source, rowIndex - 1, true)
        if (!replaceAt(view, from, source, next)) return
      }
      if (!beginTableCell(view, from, target.row, target.col)) {
        // 下に行がないときは、表のすぐ後ろへカーソルを出す。
        const after = Math.min(view.state.doc.length, from + source.length + 1)
        view.dispatch({ selection: { anchor: after }, scrollIntoView: true })
        view.focus()
      }
    }
    let composing = false
    cell.addEventListener('compositionstart', () => { composing = true })
    cell.addEventListener('compositionend', () => { composing = false })
    cell.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      if (event.target.closest?.('a[data-href]') && !cell.isContentEditable) return
      event.stopPropagation()
      if (!cell.isContentEditable) {
        event.preventDefault()
        // 編集中のマスを書き戻すと、同じ表は作り直される。そのときは新しい表の同じマスを開く。
        const from = view.posAtDOM(wrap)
        const open = document.activeElement?.closest?.('.cm-cell-editing')
        open?.blur()
        if (view.contentDOM.contains(wrap)) begin()
        else beginTableCell(view, from, rowIndex, col)
      }
    })
    cell.addEventListener('blur', () => commit())
    watchTyping(cell)
    cell.addEventListener('keydown', (event) => {
      // Cmd+Oは画面全体で受けるので止めない。部品の中のキーをエディター本体は受け取らない。
      const command = isCommandKey(event)
      if (!command || composing || event.isComposing) event.stopPropagation()
      if (composing || event.isComposing) return
      if (command) {
        const typed = cell.isContentEditable && cell.textContent.trim() !== raw.trim()
        if (runFieldHistory(event, view, cell, typed, () => commit(true))) return
        if (event.key.toLowerCase() === 'a' && !event.shiftKey && !event.altKey) {
          // ブラウザーに任せると、マスを飛び出してノート全体を選んでしまう。
          if (cell.isContentEditable) {
            event.preventDefault()
            getSelection().selectAllChildren(cell)
          }
        } else if (isSaveKey(event)) {
          event.preventDefault()
          if (!view.contentDOM.contains(wrap)) return
          const wasEditing = cell.isContentEditable
          const caret = wasEditing ? caretOffset(cell) : 0
          const from = view.posAtDOM(wrap)
          if (commit() === false) return
          runScopeHandlers(view, event, 'editor')
          if (wasEditing && beginTableCell(view, from, rowIndex, col)) setCaretOffset(document.activeElement, caret)
        } else if (isSearchKey(event)) {
          event.preventDefault()
          if (commit() === false) return
          view.focus()
          runScopeHandlers(view, event, 'editor')
        }
        return
      }
      if (!cell.isContentEditable) {
        if (event.key === 'Enter') {
          event.preventDefault()
          begin()
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        commit(true)
        view.focus()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        moveTo('down')
      } else if (event.key === 'Tab') {
        event.preventDefault()
        moveTo(event.shiftKey ? -1 : 1)
      }
    })
    cell.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      if (!view.contentDOM.contains(wrap)) return
      // 書き戻すと部品が作り直されるので、メニューの操作は場所と文字で確かめて行う。
      const from = view.posAtDOM(wrap)
      const changed = commit()
      if (changed === false) return
      const s = changed ?? this.source
      const run = (fn) => () => replaceAt(view, from, s, fn())
      const isBody = rowIndex >= 2
      const bodyIndex = isBody ? rowIndex - 1 : 0
      showMenu(event, [
        { label: '上に行を追加', run: run(() => addRow(s, Math.max(bodyIndex, 1), false)) },
        { label: '下に行を追加', run: run(() => addRow(s, bodyIndex, true)) },
        ...(isBody
          ? [
              { label: 'この行を上へ', run: run(() => moveRow(s, bodyIndex, -1)) },
              { label: 'この行を下へ', run: run(() => moveRow(s, bodyIndex, 1)) },
              { label: 'この行を削除', run: run(() => deleteRow(s, bodyIndex)) },
            ]
          : []),
        '-',
        { label: '左に列を追加', run: run(() => addColumn(s, col, false)) },
        { label: '右に列を追加', run: run(() => addColumn(s, col, true)) },
        { label: 'この列を左へ', run: run(() => moveColumn(s, col, -1)) },
        { label: 'この列を右へ', run: run(() => moveColumn(s, col, 1)) },
        { label: 'この列を削除', run: run(() => deleteColumn(s, col)) },
        '-',
        { label: '左寄せ', run: run(() => setAlign(s, col, 'left')) },
        { label: '中央寄せ', run: run(() => setAlign(s, col, 'center')) },
        { label: '右寄せ', run: run(() => setAlign(s, col, 'right')) },
        { label: 'この列で昇順に並べ替え', run: run(() => sortRows(s, col, false)) },
        { label: 'この列で降順に並べ替え', run: run(() => sortRows(s, col, true)) },
      ])
    })
  }
  get estimatedHeight() {
    return 28 * (this.source.split('\n').length - 1)
  }
  ignoreEvent() {
    return true
  }
  ignoreMutation() {
    return true
  }
}

export class FrontmatterWidget extends WidgetType {
  // noteEditable: ノートそのものが編集できるか（「このタスクを削除」を出すか）。
  // viewEditable: 画面が編集できるか（EditorView.editable）。busy: ノートを動かしている間など、欄をすべて止めるとき。
  constructor(source, open, pos, { noteEditable = false, viewEditable = false, busy = false } = {}) {
    super()
    this.source = source
    this.open = open
    this.pos = pos
    this.noteEditable = noteEditable
    this.viewEditable = viewEditable
    this.busy = busy
  }
  eq(other) {
    return (
      other.source === this.source &&
      other.open === this.open &&
      other.noteEditable === this.noteEditable &&
      other.viewEditable === this.viewEditable &&
      other.busy === this.busy
    )
  }
  // その行の名前と値を直せるか。
  access(simple) {
    return propsRowAccess({ simple, viewEditable: this.viewEditable, busy: this.busy })
  }
  toDOM(view) {
    const { items, simple } = parseFrontmatter(this.source)
    const wrap = element('div', { class: 'cm-props' })
    const head = element('button', { type: 'button', class: 'cm-props-head' }, [
      `${this.open ? '▾' : '▸'} ノートの情報（${items.length}）`,
    ])
    head.addEventListener('click', () => view.dom.dispatchEvent(new CustomEvent('note-toggle-props', { bubbles: true })))
    wrap.append(head)
    if (!this.open) return wrap
    // 欄からの変更は、1つずつ取り消せるように履歴を区切る。
    // refocus: 作り直した欄で、同じ項目にフォーカスを戻す（ステータスを選んだあと、続けて Cmd+Z を押せるように）。
    const apply = (next, refocus) => {
      const before = view.state.doc
      const ok = replaceBlock(view, wrap, this.source, next, [isolateHistory.of('full')])
      if (ok && view.state.doc !== before && refocus) focusPropsField(view, refocus)
      return ok
    }
    const task = isTaskItems(items)
    const editable = simple && this.viewEditable && !this.busy
    if (!simple) {
      wrap.append(element('p', { class: 'cm-props-note' }, ['入れ子などがあるので、文字のまま編集します。']))
    }
    for (const item of items) {
      const { full, value } = this.access(simple)
      wrap.append(this.row(view, item, full, apply, { task, valueEditable: value }))
    }
    if (editable) {
      const add = element('button', { type: 'button', class: 'cm-props-add' }, ['＋ 項目を追加'])
      add.addEventListener('click', async () => {
        const name = await askText('追加する項目の名前')
        if (name?.trim()) apply(setProperty(this.source, name.trim(), ''))
      })
      wrap.append(add)
    }
    const source = element('button', { type: 'button', class: 'cm-props-source' }, ['文字で編集'])
    source.addEventListener('click', () => {
      const pos = view.posAtDOM(wrap)
      view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, pos + 4) } })
      view.focus()
    })
    wrap.append(source)
    // タスクのノートは、ここにも「このタスクを削除」を置く（ノートの情報を見ながら消せるように）。
    if (task && this.noteEditable && !this.busy) {
      const trash = element('button', { type: 'button', class: 'cm-props-trash' }, ['このタスクを削除'])
      trash.addEventListener('click', () => view.dom.dispatchEvent(new CustomEvent('note-trash-task', { bubbles: true })))
      wrap.append(trash)
    }
    return wrap
  }
  row(view, item, editable, apply, { task = false, valueEditable = editable } = {}) {
    const row = element('div', { class: 'cm-props-row' })
    const name = element('input', { class: 'cm-props-key', value: item.key, 'aria-label': '項目の名前' })
    name.disabled = !editable
    name.addEventListener('change', () => apply(renameProperty(this.source, item.key, name.value)))
    row.append(name, this.valueInput(item, valueEditable, apply, task))
    if (editable) {
      const remove = element('button', { type: 'button', class: 'cm-props-del', 'aria-label': '項目を削除' }, ['×'])
      remove.addEventListener('click', () => apply(deleteProperty(this.source, item.key)))
      row.append(remove)
    }
    for (const input of row.querySelectorAll('input, select')) {
      watchTyping(input)
      // ブラウザーが補正した値もあるので、属性ではなく今の値と比べる。
      const initial = input.value
      input.addEventListener('keydown', (event) => {
        if (!isCommandKey(event) || event.isComposing) {
          event.stopPropagation()
          return
        }
        if (runFieldHistory(event, view, input, input.value !== initial, () => {})) return
        if (isSaveKey(event)) {
          event.preventDefault()
          // 欄の中身は、フォーカスが外れたときに本文へ書き戻される。
          input.blur()
          runScopeHandlers(view, event, 'editor')
        } else if (isSearchKey(event)) {
          event.preventDefault()
          view.focus()
          runScopeHandlers(view, event, 'editor')
        }
      })
    }
    return row
  }
  valueInput(item, editable, apply, task = false) {
    let input
    const commit = (value, refocus = false) => {
      if (JSON.stringify(value) !== JSON.stringify(item.value)) apply(propsValueSource(this.source, item.key, value, task), refocus ? item.key : null)
    }
    const kind = task ? taskFieldKind(item.key, item.value) : null
    if (kind === 'status') {
      input = element('select', { class: 'cm-props-value cm-props-select', 'aria-label': item.key })
      for (const value of statusOptions(item.value)) {
        const option = element('option', { value }, [value === '' ? '（未設定）' : value])
        if (value === item.value) option.selected = true
        input.append(option)
      }
      input.addEventListener('change', () => commit(input.value, true))
    } else if (kind === 'date') {
      input = element('input', { type: 'date', class: 'cm-props-value', value: item.value, 'aria-label': item.key })
      // 確定のしかたは tasks.mjs の dateFieldStep にまとめてある（キーで打ったら欄を離れるか Enter、選んだらすぐ）。
      let state = DATE_FIELD_IDLE
      const step = (event) => {
        const next = dateFieldStep(state, event)
        state = { typed: next.typed, pending: next.pending }
        // Enter やカレンダーで確定したときは、作り直した欄にフォーカスを戻す（続けて Cmd+Z で戻せるように）。
        // 欄を離れた（blur）ときは、行き先からフォーカスを奪わない。
        if (next.commit) commit(input.value, event.type !== 'blur')
      }
      input.addEventListener('keydown', (event) => step({ type: 'keydown', key: event.key, composing: event.isComposing }))
      input.addEventListener('change', () => step({ type: 'change', focused: input.matches(':focus') }))
      input.addEventListener('blur', () => step({ type: 'blur' }))
    } else if (kind === 'text') {
      input = element('input', { type: 'text', class: 'cm-props-value', value: item.value, 'aria-label': item.key })
      input.addEventListener('change', () => commit(input.value))
    } else if (item.type === 'checkbox') {
      input = element('input', { type: 'checkbox', class: 'cm-props-value', 'aria-label': item.key })
      input.checked = item.value === 'true'
      input.addEventListener('change', () => commit(String(input.checked)))
    } else if (item.type === 'list' || item.type === 'tags') {
      input = element('input', { class: 'cm-props-value', value: item.value.join(', '), 'aria-label': item.key, title: 'カンマで区切ります' })
      input.addEventListener('change', () => commit(input.value.split(',').map((v) => v.trim()).filter(Boolean)))
    } else {
      const type = { number: 'number', date: 'date', datetime: 'datetime-local' }[item.type] ?? 'text'
      const value = item.type === 'datetime' ? item.value.replace(' ', 'T') : item.value
      input = element('input', { type, class: 'cm-props-value', value, 'aria-label': item.key })
      if (type === 'number') input.setAttribute('step', 'any')
      input.addEventListener('change', () => commit(input.value))
    }
    input.disabled = !editable
    return input
  }
  get estimatedHeight() {
    return this.open ? 200 : 30
  }
  ignoreEvent() {
    return true
  }
  ignoreMutation() {
    return true
  }
}
