import assert from 'node:assert/strict'
import { test } from 'node:test'

import { syntaxTree } from '@codemirror/language'
import { EditorState, EditorSelection } from '@codemirror/state'

import { headingsOf, linkCompletion } from '../src/complete.mjs'
import { relativeHref, resolveHref, slugify } from '../src/links.mjs'
import { noteMarkdown } from '../src/markdown-ext.mjs'
import { findCallouts, hiddenRanges, noteContext, previewField, setComposing, setMode } from '../src/preview.mjs'
import { addColumn, addRow, deleteRow, parseTable, replaceCell, setAlign, sortRows, splitRow } from '../src/table-model.mjs'
import { CheckboxWidget, TableWidget, cleanCss, hasExternalRef, imagePlan, isExternalHref, keepHref } from '../src/widgets.mjs'
import { deleteProperty, inferType, parseFrontmatter, renameProperty, setProperty } from '../src/yaml-lite.mjs'

function make(doc, cursor = doc.length) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [noteMarkdown(), noteContext.of({ path: 'a/b.md', known: new Set(['a/c.md']) }), previewField],
  })
}

test('太字の記号はふだん隠れ、カーソルが入ると見える', () => {
  const text = '前の文\n\n**太字** です'
  const away = make(text, 0)
  assert.deepEqual(hiddenRanges(away), ['**', '**'])
  const inside = make(text, text.indexOf('太字') + 1)
  assert.deepEqual(hiddenRanges(inside), [])
})

test('見出しの記号はカーソルの行だけ見える', () => {
  const text = '# 見出し\n\n本文'
  assert.deepEqual(hiddenRanges(make(text, text.length)), ['# '])
  assert.deepEqual(hiddenRanges(make(text, 2)), [])
})

test('変換中は隠す範囲を更新しない', () => {
  const text = '**太字** です\n\n次の行'
  let state = make(text, text.length)
  const before = hiddenRanges(state)
  state = state.update({ effects: setComposing.of(true) }).state
  state = state.update({ selection: { anchor: 3 } }).state
  assert.deepEqual(hiddenRanges(state), before, '変換中はカーソルが動いても変えない')
  state = state.update({ effects: setComposing.of(false) }).state
  assert.deepEqual(hiddenRanges(state), [], '変換が終わると直す')
})

test('Obsidianのハイライトは記号を隠し、コメントとタグは編集中はそのまま見せる', () => {
  const text = '==b== %%c%% #tag ^id\n\n次'
  assert.deepEqual(hiddenRanges(make(text, text.length)), ['==', '=='])
})

test('コールアウトは5種類と小文字だけ見つける', () => {
  const doc = (line) => findCallouts(make(`${line}\n> 本文\n\n次`))
  for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION', 'note']) {
    assert.equal(doc(`> [!${kind}]`).length, 1, kind)
  }
  assert.equal(doc('> [!INFO]').length, 0)
  assert.equal(doc('> [!NOTE] 題名').length, 0)
  assert.equal(doc('> [!NOTE]-').length, 0)
  assert.equal(findCallouts(make('```\n> [!NOTE]\n```\n')).length, 0)
})

test('どの表示でも文書の文字は変わらない', () => {
  const text = '---\na: 1\n---\n# 見出し\n\n- [ ] 項目\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
  let state = make(text)
  for (const mode of ['reading', 'source', 'live']) {
    state = state.update({ effects: setMode.of(mode) }).state
    assert.equal(state.doc.toString(), text)
  }
  assert.equal(state.field(previewField).mode, 'live')
})

test('ソース表示では何も隠さない', () => {
  let state = make('# 見出し\n\n**太字**\n', 0)
  state = state.update({ effects: setMode.of('source') }).state
  assert.equal(state.field(previewField).deco.size, 0)
})

test('閲覧表示ではカーソルがあっても隠す', () => {
  const text = '**太字** です'
  let state = make(text, 3)
  assert.deepEqual(hiddenRanges(state), [])
  state = state.update({ effects: setMode.of('reading') }).state
  assert.deepEqual(hiddenRanges(state), ['**', '**'])
})

test('先頭のYAMLは見出しや水平線にしない', () => {
  const state = make('---\ntitle: x\n---\n本文\n', 20)
  let replaced = 0
  state.field(previewField).deco.between(0, 5, (from, to, deco) => {
    if (deco.spec.block) replaced += 1
  })
  assert.equal(replaced, 1)
})

test('金額は数式にしない', () => {
  const names = (doc) => {
    const found = []
    syntaxTree(make(doc)).iterate({ enter: (node) => { found.push(node.name) } })
    return found
  }
  assert.ok(!names('$100と$200です').includes('InlineMath'))
  assert.ok(!names('$ a $').includes('InlineMath'))
  assert.ok(names('式 $e^{i\\pi}=1$ です').includes('InlineMath'))
  assert.ok(names('$$\na\n$$\n').includes('MathBlock'))
})

test('リンクの行き先を解決する', () => {
  assert.equal(resolveHref('a/b.md', 'c.md').path, 'a/c.md')
  assert.equal(resolveHref('a/b.md', '../d.md').path, 'd.md')
  assert.equal(resolveHref('a/b.md', '/x/y.md').path, 'x/y.md')
  assert.equal(resolveHref('a/b.md', 'my%20note.md#見出し').path, 'a/my note.md')
  assert.equal(resolveHref('a/b.md', 'my%20note.md#見出し').anchor, '見出し')
  assert.equal(resolveHref('a/b.md', '#x').path, 'a/b.md')
  assert.equal(resolveHref('a.md', '../../x.md'), null)
  assert.equal(relativeHref('a/b.md', 'a/c d.md'), 'c%20d.md')
  assert.equal(relativeHref('a/b/c.md', 'x/日本語(1).md'), '../../x/日本語%281%29.md')
  assert.equal(relativeHref('n.md', 'n2.md'), 'n2.md')
  assert.equal(slugify('Hello World! 日本語'), 'hello-world-日本語')
})

test('表のマスを1つ直しても、ほかは変わらない', () => {
  const source = '| a  |   b |\n|:--|--:|\n| 1 | 2 |\n| 3 |  |'
  assert.equal(replaceCell(source, 2, 1, '９'), '| a  |   b |\n|:--|--:|\n| 1 | ９ |\n| 3 |  |')
  assert.equal(replaceCell(source, 3, 1, 'x'), '| a  |   b |\n|:--|--:|\n| 1 | 2 |\n| 3 | x |')
  assert.equal(replaceCell(source, 2, 0, 'p|q'), '| a  |   b |\n|:--|--:|\n| p\\|q | 2 |\n| 3 |  |')
})

test('表の縦線の打ち消しとコードの中の縦線で列がずれない', () => {
  assert.equal(splitRow('| [[a\\|b]] | `x|y` | c |').length, 3)
  assert.equal(splitRow('a | b').length, 2)
  assert.deepEqual(parseTable('a|b\n:--|--:\n1|2').align, ['left', 'right'])
})

test('表の行と列を操作する', () => {
  const source = '| a | b |\n| --- | --- |\n| 2 | x |\n| 1 | y |'
  assert.equal(addRow(source, 1, true).split('\n').length, 5)
  assert.equal(deleteRow(source, 1).split('\n').length, 3)
  assert.equal(parseTable(addColumn(source, 0, true)).columns, 3)
  assert.deepEqual(parseTable(setAlign(source, 1, 'right')).align, [null, 'right'])
  assert.equal(sortRows(source, 0).split('\n')[2], '| 1 | y |')
})

test('ノートの情報を読み、変えた項目の行だけ直す', () => {
  const source = '---\ntitle: 題名\n# メモ\ndone: true\ncount: 3\nday: 2026-11-03\ntags:\n  - a\n  - b\n---'
  const { items, simple } = parseFrontmatter(source)
  assert.equal(simple, true)
  assert.deepEqual(items.map((i) => i.type), ['text', 'checkbox', 'number', 'date', 'tags'])
  assert.deepEqual(items.at(-1).value, ['a', 'b'])
  assert.equal(setProperty(source, 'count', '4'), source.replace('count: 3', 'count: 4'))
  assert.equal(setProperty(source, 'tags', ['c']), source.replace('  - a\n  - b', '  - c'))
  assert.ok(setProperty(source, 'new', 'v').endsWith('new: v\n---'))
  assert.equal(deleteProperty(source, 'done'), source.replace('done: true\n', ''))
  assert.equal(renameProperty(source, 'day', 'date'), source.replace('day:', 'date:'))
  assert.equal(parseFrontmatter('---\na:\n  b: 1\n---').simple, false)
  assert.equal(inferType('x', '2026-11-03 10:00'), 'datetime')
  assert.equal(setProperty('---\na: 1\n---', 'a', 'x: y'), '---\na: "x: y"\n---')
})

function completionAt(doc, notes, path = 'a/b.md') {
  const state = make(doc)
  const source = linkCompletion({ notes: () => notes, currentPath: () => path })
  return source({
    matchBefore(re) {
      const text = doc.slice(0, state.selection.main.head)
      const line = text.slice(text.lastIndexOf('\n') + 1)
      const match = new RegExp(`(?:${re.source})$`).exec(line)
      return match ? { from: text.length - match[0].length, to: text.length, text: match[0] } : null
    },
    state,
  })
}

test('リンクの行き先を打つとノート名の候補が出る', () => {
  const result = completionAt('[x](oth', ['a/other.md', 'c/日本語 ノート.md'])
  assert.equal(result.from, 4)
  assert.deepEqual(result.options.map((o) => o.label), ['other.md', '../c/日本語%20ノート.md'])
  assert.equal(result.options[0].displayLabel, 'other')
})

test('リンクの外や外部のURLでは候補を出さない', () => {
  assert.equal(completionAt('普通の文', ['a.md']), null)
  assert.equal(completionAt('[x](https://exa', ['a.md']), null)
})

test('見出しの候補を出す', () => {
  const result = completionAt('# 最初 の見出し\n\n[x](#', [])
  assert.deepEqual(result.options.map((o) => o.label), ['#最初-の見出し'])
  assert.equal(headingsOf(make('---\n# 違う\n---\n## 本物\n'))[0].text, '本物')
})

function widgetsOf(state, type) {
  const found = []
  state.field(previewField).deco.between(0, state.doc.length, (from, to, value) => {
    if (value.spec.widget instanceof type) found.push(value.spec.widget)
  })
  return found
}

test('引用や箇条書きの中の表は、部品にせず文字のまま見せる', () => {
  const quoted = '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n\n次の行'
  assert.equal(widgetsOf(make(quoted), TableWidget).length, 0)
  const listed = '- 項目\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |\n\n次の行'
  assert.equal(widgetsOf(make(listed), TableWidget).length, 0)
  const plain = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n次の行'
  assert.equal(widgetsOf(make(plain), TableWidget).length, 1)
})

test('編集できないノートでは、表とチェックを変えられないようにする', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] 項目\n\n次の行'
  const locked = EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(text.length),
    extensions: [noteMarkdown(), noteContext.of({ path: 'a/b.md', known: new Set(), editable: false }), previewField, EditorState.readOnly.of(true)],
  })
  assert.equal(widgetsOf(locked, TableWidget)[0].readOnly, true)
  assert.equal(widgetsOf(locked, CheckboxWidget)[0].readOnly, true)
  // 閲覧表示は設計どおり、チェックだけ押せる。
  const reading = make(text).update({ effects: setMode.of('reading') }).state
  assert.equal(widgetsOf(reading, TableWidget)[0].readOnly, true)
  assert.equal(widgetsOf(reading, CheckboxWidget)[0].readOnly, false)
  const free = make(text)
  assert.equal(widgetsOf(free, TableWidget)[0].readOnly, false)
  assert.equal(widgetsOf(free, CheckboxWidget)[0].readOnly, false)
})

test('閉じていないYAMLや数式の枠があっても、その先の文書を読める', () => {
  const headingAfter = (text) => {
    const names = []
    syntaxTree(make(text)).iterate({ enter: (node) => { names.push(node.name) } })
    return names
  }
  for (const text of ['---\ntitle: x\n# 見出し\n\n本文\n', '$$\na+b\n\n# 見出し\n\n本文\n']) {
    const names = headingAfter(text)
    assert.ok(names.includes('ATXHeading1'), text)
    assert.ok(!names.includes('Frontmatter') && !names.includes('MathBlock'), text)
  }
  assert.ok(headingAfter('---\ntitle: x\n---\n# 見出し\n').includes('Frontmatter'))
  assert.ok(headingAfter('$$\na+b\n$$\n\n# 見出し\n').includes('MathBlock'))
})

test('Obsidianの記法を読む：色付きハイライト、複数行のコメント、タグ', async () => {
  const { parser } = await import('@lezer/markdown')
  const { noteMarkdownExtensions } = await import('../src/markdown-ext.mjs')
  const p = parser.configure(noteMarkdownExtensions)
  const names = (text) => {
    const found = []
    p.parse(text).iterate({ enter: (n) => { if (['Highlight', 'ObsidianComment', 'ObsidianCommentBlock', 'Tag'].includes(n.name)) found.push(`${n.name}:${text.slice(n.from, n.to)}`) } })
    return found
  }
  assert.deepEqual(names('==🔴赤== と a == b == c'), ['Highlight:==🔴赤=='])
  assert.deepEqual(names('%%\n中\n%%\n本文'), ['ObsidianCommentBlock:%%\n中\n%%'])
  assert.deepEqual(names('#仕事 #a/b-c #123 x#no `#code` https://x.y/#frag'), ['Tag:#仕事', 'Tag:#a/b-c'])
  assert.deepEqual(names('# 見出し'), [])
})

test('Obsidianの記法：段落のすぐ下のコメント、全角空白の後のタグ、絵文字の修飾', async () => {
  const { parser } = await import('@lezer/markdown')
  const { noteMarkdownExtensions } = await import('../src/markdown-ext.mjs')
  const p = parser.configure(noteMarkdownExtensions)
  const names = (text) => {
    const found = []
    p.parse(text).iterate({ enter: (n) => { if (['ObsidianCommentBlock', 'Tag'].includes(n.name)) found.push(`${n.name}:${text.slice(n.from, n.to)}`) } })
    return found
  }
  assert.deepEqual(names('a\n%%\nc\n%%'), ['ObsidianCommentBlock:%%\nc\n%%'])
  assert.deepEqual(names('メモ　#仕事 #👍🏽 #_x #2026'), ['Tag:#仕事', 'Tag:#👍🏽', 'Tag:#_x'])
})

test('imagePlan: ネット上の画像はボタンを押すまで ask、許可済みなら show', () => {
  assert.deepEqual(imagePlan(null, {}), { kind: 'missing' })
  assert.deepEqual(imagePlan('https://x/a.png', {}), { kind: 'ask', url: 'https://x/a.png' })
  assert.deepEqual(imagePlan('http://x/a.png', { allowed: new Set() }), { kind: 'ask', url: 'http://x/a.png' })
  assert.deepEqual(imagePlan('https://x/a.png', { allowed: new Set(['https://x/a.png']) }), { kind: 'show', url: 'https://x/a.png' })
  assert.deepEqual(imagePlan('https://x/a.png', { localImagesOnly: true }), { kind: 'blocked' })
  assert.deepEqual(imagePlan('/files/a.png', {}), { kind: 'show', url: '/files/a.png' })
  assert.deepEqual(imagePlan('data:image/png;base64,AA', { localImagesOnly: true }), { kind: 'show', url: 'data:image/png;base64,AA' })
})

test('hasExternalRef: 描く前に、外のURLを読みそうな図を見つける', () => {
  assert.equal(hasExternalRef('graph TD\n  A@{ img: "https://x/a.png", label: "a" }'), true)
  assert.equal(hasExternalRef('%%{init: {"themeCSS": "@import url(https://x/e.css);"}}%%\ngraph TD\n A-->B'), true)
  assert.equal(hasExternalRef('graph TD\n  A-->B\n  classDef c fill:#fff,background:url(https://x/c.png)\n  class A c'), true)
  assert.equal(hasExternalRef('graph TD\n  A-->B\n  click A "https://x/"'), true)
  assert.equal(hasExternalRef('graph TD\n  A-->B\n  A@{ IMG : "//x/a.png" }'), true)
  assert.equal(hasExternalRef('graph TD\n  A@{ "img": "ht\ttps:x.com/a.png", label: "a" }'), true)
  assert.equal(hasExternalRef("graph TD\n  A@{ 'img': 'x', label: 'a' }"), true)
  assert.equal(hasExternalRef('graph TD\n  A@{ ? img\n  : x }'), true)
  assert.equal(hasExternalRef('graph TD\n  A@{ i\x01mg: x }'), true)
  assert.equal(hasExternalRef('graph TD\n  A[開始] --> B[終わり]\n  style A fill:#f9f'), false)
})

test('isExternalHref: 回り道の書き方も外と判定する', () => {
  const ext = (v) => isExternalHref(v, 'http://localhost:8812/', 'http://localhost:8812')
  for (const v of ["https://x/a'b.png", '\\\\x.com/a.png', '/\\x.com/a.png', 'ht\ttps://x', '//x/a.png', 'http://x/', 'javascript:alert(1)', 'http://[bad']) assert.equal(ext(v), true, v)
  for (const v of ['#a', ' #a', 'data:image/png;base64,AA', '/files/a.png', 'http://localhost:8812/a.png']) assert.equal(ext(v), false, v)
})

test('cleanCss: @import と外を指す url() / image-set() を取り除く', () => {
  const bad = [
    '@import "https://x/e.css";.a{fill:red}',
    '@import url(http://x/e.css);',
    '.b{background:url(https://x/c.png)}',
    '.b{background:u\\72l(https://x/c.png)}',
    '.b{background:\\75 rl( //x/c.png )}',
    '.b{background:image-set("https://x/a.png" 1x, "https://x/b.png" 2x)}',
    '.b{background:image("https://x/a.png")}',
    '.b{background:URL( "//x/d.png" )}',
  ]
  for (const css of bad) assert.doesNotMatch(cleanCss(css), /https?:|\/\/x|@import|image-set|url\(/i, css)
  assert.match(cleanCss('.a{fill:url(#g);stroke:url( "#h" )}'), /url\(#g\).*url\( "#h" \)/)
  assert.equal(cleanCss('.a{fill:red}'), '.a{fill:red}')
})

test('keepHref: 許した図の <image> だけ、http(s) の画像を残す', () => {
  const keep = (tag, v, allow) => keepHref(tag, v, 'http://localhost:8812/', 'http://localhost:8812', allow)
  assert.equal(keep('image', 'https://x/a.jpg', true), true)
  assert.equal(keep('image', ' //x/a.jpg', true), false)
  assert.equal(keep('image', 'https://x/a.jpg', false), false)
  assert.equal(keep('a', 'https://x/', true), false)
  assert.equal(keep('use', 'https://x/s.svg#a', true), false)
  assert.equal(keep('image', 'javascript:alert(1)', true), false)
  assert.equal(keep('image', 'https://x\\@y/', true), false)
  assert.equal(keep('image', '#a', false), true)
})
