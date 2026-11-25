// 「タスクを削除」（段階1-E1）のうち、DOM に頼らない部分。
// 子孫の集め方、リンクを外す位置、goal・parent のノートの中のリンクの数え方、知らせの文を決める。
import { parser as markdownParser } from '@lezer/markdown'

import { isExternal, parseWikiLink, resolveHref, resolveWikiTarget } from './links.mjs'
import { noteSyntaxExtensions } from './markdown-syntax.mjs'
import { TASK_FOLDER } from './tasks.mjs'

// パスを比べるときのキー。濁点の持ち方（NFC と NFD）と大文字小文字、.md の有無をそろえる。
export const pathKey = (path) => String(path ?? '').normalize('NFC').toLowerCase().replace(/\.md$/i, '')

// Vault の直下の Tasks（大文字小文字は問わない）の下か。
export function isUnderTaskFolder(path, folder = TASK_FOLDER) {
  return typeof path === 'string' && path.normalize('NFC').toLowerCase().startsWith(folder.toLowerCase() + '/')
}

// サーバーの一覧（GET /api/tasks の tasks）から、そのパスのタスクを探す。なければ null（type: task でない、など）。
export function findTask(tasks, path) {
  const key = pathKey(path)
  return (tasks ?? []).find((task) => pathKey(task?.path) === key) ?? null
}

// root の子・孫…を、parentPath（サーバーが parent を解決したもの）でたどって集める。root 自身は入れない。
// parent が輪になっていても、たどったノートを覚えて止める。近い順（子 → 孫）に返す。
export function collectDescendants(tasks, rootPath) {
  const children = new Map()
  for (const task of tasks ?? []) {
    if (!task?.path || !task.parentPath) continue
    const key = pathKey(task.parentPath)
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(task)
  }
  const seen = new Set([pathKey(rootPath)])
  const out = []
  const queue = [rootPath]
  for (let head = 0; head < queue.length; head++) {
    for (const child of children.get(pathKey(queue[head])) ?? []) {
      const key = pathKey(child.path)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(child)
      queue.push(child.path)
    }
  }
  return out
}

// 行頭の、引用の > ・字下げ・箇条書きの記号・チェックボックス（task-line.mjs と同じ分け方）。
const PREFIX = /^((?:[\t ]*>[\t ]?)*)([\t ]*)((?:[-*+]|\d{1,9}[.)])[\t ]+(?:\[[ xX\/-]\][\t ]+)?)?/
const SPACE = /[\t ]/

// 行の中のリンク（from〜to。文書の位置）を外すときに消す範囲。
// - リンクの前に空白があり、リンクのあとが行末か空白なら、前の空白も一緒に外す（「文 [[…]]」→「文」、「文 [[…]] 続き」→「文 続き」）。
// - リンクが行の最初の中身（箇条書きの記号やチェックボックスのすぐ後ろ）なら、記号の後ろの空白は残し、リンクのあとの空白を外す。
// - それ以外（前の文字にくっついている）は、リンクだけを外す。
export function unlinkRange(lineText, lineFrom, from, to) {
  const text = String(lineText ?? '')
  const a = from - lineFrom
  const b = to - lineFrom
  if (!(a >= 0 && b <= text.length && a < b)) return null
  const head = PREFIX.exec(text)[0].length
  const atEnd = b === text.length || SPACE.test(text[b])
  let start = a
  while (start > head && SPACE.test(text[start - 1])) start--
  if (start < a && atEnd) return { from: lineFrom + start, to }
  if (a <= head) {
    let end = b
    while (end < text.length && SPACE.test(text[end])) end++
    return { from, to: lineFrom + end }
  }
  return { from, to }
}

const WIKI = /!?\[\[([^\[\]\n]+)\]\]/g
const MD_LINK = /!?\[[^\]\n]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g

// リンクを探す行。中のリンクがプレビューでリンクにならない部分（HTML のコメント・コードの囲み・字下げのコード・行内コード・
// 先頭のプロパティ・HTML のかたまり）を空白に置き換えた scan を付ける（長さは変えないので、見つけた位置はそのまま文書の位置に使える）。
// どこがその部分かは、プレビューと同じ Markdown の読み取り（@lezer/markdown と markdown-syntax.mjs の広げ方）で決める。
// リンクが外れたかの判定（task-unlinked.mjs）と、外すリンクを探すとき（taskLinksIn）で同じものを使う。
// 返り値：[{ from, text, scan }]（1行ずつ。from は文書の中の行の頭の位置）。
const linkParser = markdownParser.configure(noteSyntaxExtensions)
const HIDDEN = new Set(['Comment', 'CommentBlock', 'CodeBlock', 'FencedCode', 'InlineCode', 'CodeText', 'Frontmatter', 'HTMLBlock'])

export function linkRows(text) {
  const source = String(text ?? '')
  let scan = source
  // リンクの形（[[ か ](）がなければ、何も見つからないので読み取りを省く（多くのノートはこちら）。
  if (source.includes('[[') || source.includes('](')) {
    const parts = []
    let at = 0
    linkParser.parse(source).iterate({
      enter(node) {
        if (!HIDDEN.has(node.name)) return undefined
        if (node.to > at) {
          parts.push(source.slice(at, Math.max(at, node.from)), source.slice(Math.max(at, node.from), node.to).replace(/[^\n]/g, ' '))
          at = node.to
        }
        return false
      },
    })
    parts.push(source.slice(at))
    scan = parts.join('')
  }
  const rows = []
  for (let from = 0; ; ) {
    const end = source.indexOf('\n', from)
    const to = end < 0 ? source.length : end
    rows.push({ from, text: source.slice(from, to), scan: scan.slice(from, to) })
    if (end < 0) return rows
    from = end + 1
  }
}

// ノートの本文から、taskPath を指すリンクを全部探す（先頭のプロパティとコード・行内コード・HTML のコメントと HTML のかたまりの中は見ない。画像などの埋め込み ![[…]] も数えない）。
// 返り値：[{ from, to, text, lineFrom, lineText }]（from・to は text の中の位置）。
export function taskLinksIn(text, notePath, taskPath, known) {
  const want = pathKey(taskPath)
  const found = []
  for (const row of linkRows(text)) {
    for (const match of row.scan.matchAll(WIKI)) {
      if (match[0].startsWith('!')) continue
      const parsed = parseWikiLink(match[1])
      if (!parsed?.file) continue
      const target = resolveWikiTarget(notePath, parsed.file, known)
      if (target && pathKey(target.path) === want) found.push(hit(row, match))
    }
    for (const match of row.scan.matchAll(MD_LINK)) {
      if (match[0].startsWith('!') || isExternal(match[1])) continue
      const target = resolveHref(notePath, match[1])
      if (target && pathKey(target.path) === want) found.push(hit(row, match))
    }
  }
  return found.sort((x, y) => x.from - y.from)
}

// text は元の文書の文字（scan では、表示名の中の行内コードが空白になっているため）。
function hit(row, match) {
  const from = row.from + match.index
  const to = from + match[0].length
  return { from, to, text: row.text.slice(match.index, match.index + match[0].length), lineFrom: row.from, lineText: row.text }
}

// goal・parent のノートの中のリンクを外す計画。ちょうど1つなら { count: 1, change }、0 か 2つ以上なら { count, change: null }。
export function planUnlinkInNote(text, notePath, taskPath, known) {
  const links = taskLinksIn(text, notePath, taskPath, known)
  if (links.length !== 1) return { count: links.length, change: null }
  const [link] = links
  const range = unlinkRange(link.lineText, link.lineFrom, link.from, link.to)
  return { count: 1, change: { ...range, insert: '' } }
}

// 確認のあいだに文書が変わっていても、外すリンクを見つけ直す。同じ場所に同じ文字があればそこ。
// なければ、同じ文字で taskPath を指すリンクがちょうど1つあるときだけそこ。見つからない・2つ以上なら null。
export function relocateLink(text, { from, to, linkText }, { notePath, taskPath, known }) {
  if (text.slice(from, to) === linkText) {
    const lineFrom = text.lastIndexOf('\n', from - 1) + 1
    const end = text.indexOf('\n', to)
    return { from, to, lineFrom, lineText: text.slice(lineFrom, end < 0 ? text.length : end) }
  }
  const same = taskLinksIn(text, notePath, taskPath, known).filter((link) => link.text === linkText)
  return same.length === 1 ? same[0] : null
}

// タスクのノートの goal・parent から、リンクを外しに行くノートを決める。parent があれば親のノート、なければ goal のノート。
// 返り値：{ kind: 'parent' | 'goal', path, exists } か null。
export function sourceNoteOf({ path, goal, parent }, known) {
  for (const [kind, value] of [['parent', parent], ['goal', goal]]) {
    const target = propTarget(path, value, known)
    if (target) return { kind, path: target.path, exists: target.exists !== false }
  }
  return null
}

// プロパティ（goal・parent）の "[[…]]" が指すノート。書いていない・読めないときは null。
function propTarget(path, value, known) {
  const inner = /^\[\[([^\[\]]+)\]\]$/.exec(String(value ?? '').trim())?.[1] ?? String(value ?? '').trim()
  if (!inner) return null
  const parsed = parseWikiLink(inner)
  if (!parsed?.file) return null
  return resolveWikiTarget(path, parsed.file, known)
}

// 確認の文で数えた子（confirmed）のうち、読み直した一覧でもまだ子孫のもの（now の中のもの）だけを返す。
// 確認の間に増えたサブタスクは移さない（件数を超えて移さないように）。ほかの親へ移した・消えたものも移さない。
export function confirmedChildren(confirmed, now) {
  const keys = new Set((confirmed ?? []).map((task) => pathKey(task?.path)))
  return (now ?? []).filter((task) => task?.path && keys.has(pathKey(task.path)))
}

// 一覧の「ゴミ箱へ」を、開いているノートの保存が止まっているために止めるか。
// stuck：保存しきれなかった開いているノート [{ pane: 'left' | 'right', path }]。
// 止めるのは、判定に関わるノート（paths：移すタスクとサブタスク、と task の goal・parent のノート）のときだけ。
// split：右の枠が開いているか（開いていなければ、どちらの枠かは書かない）。
// 返り値：止めるときは知らせの文、止めないときは ''。
export function unsavedBlockText(stuck, { paths = [], task = null, known, split = false }) {
  const related = new Set(paths.map(pathKey))
  for (const value of [task?.parent, task?.goal]) {
    const target = task?.path ? propTarget(task.path, value, known) : null
    if (target?.path) related.add(pathKey(target.path))
  }
  const hits = (stuck ?? []).filter((note) => note?.path && related.has(pathKey(note.path)))
  if (!hits.length) return ''
  const nameOf = (path) => '「' + path.split('/').at(-1).replace(/\.md$/i, '') + '」'
  const where = hits.map((note) => (split ? (note.pane === 'right' ? '右の枠の' : '左の枠の') : '開いている') + nameOf(note.path)).join('と、')
  return where + 'に、まだ保存できていない変更があります。このタスクをゴミ箱へ移すのに関わるノートなので、保存できてから、もう一度選んでください。'
}

// ---- 知らせの文 ----

const nameOf = (path) => String(path ?? '').split('/').at(-1).replace(/\.md$/i, '')
export const taskTitleOf = (task) => (task?.title || nameOf(task?.path)).replace(/\*\*|__/g, '')

// リンク元のノート（parent か goal）について、外すか・外さない理由の1文。
function sourceSentence(unlink, sourceName, linkCount) {
  if (unlink === 'source') return '「' + sourceName + '」の中のリンクも外します。'
  if (unlink === 'none-source') return 'goal も parent もないタスクなので、外すリンクはありません。'
  if (unlink === 'none-missing') return 'リンク元のノートが見つからないので、リンクは外しません。'
  if (unlink === 'none-editable') return '「' + sourceName + '」は編集できないノートなので、その中のリンクは外しません。'
  if (unlink === 'none-count') return linkCount === 0
    ? '「' + sourceName + '」の中にこのタスクへのリンクが見つからないので、リンクは外しません。'
    : '「' + sourceName + '」の中にこのタスクへのリンクが' + linkCount + 'つあるので、どれを外すか決められません。リンクは外しません。'
  return ''
}

// 確認の文。unlink：'line'（右クリックした行のリンク）か、リンク元のノートの扱い（sourceSentence の種類）。
// also：unlink が 'line' で、開いているノートがリンク元（parent か goal）でないときの、リンク元の扱い { unlink, sourceName, linkCount }。
export function deleteQuestion({ title, childCount = 0, unlink = 'line', sourceName = '', linkCount = 1, also = null }) {
  const lines = ['タスク「' + title + '」をゴミ箱へ移します。']
  if (unlink === 'line') {
    lines.push('行のリンクも外します。')
    if (also) {
      const extra = sourceSentence(also.unlink, also.sourceName ?? '', also.linkCount ?? 1)
      if (extra) lines.push(also.unlink === 'source' ? 'リンク元の' + extra : extra)
    }
  } else {
    const sentence = sourceSentence(unlink, sourceName, linkCount)
    if (sentence) lines.push(sentence)
  }
  if (childCount > 0) lines.push('', 'サブタスクが' + childCount + '件あります。一緒にゴミ箱へ移すか、残すかを選んでください。残したサブタスクは、親のないタスクになります。')
  return lines.join('\n')
}

// 選択肢。サブタスクがなければ「ゴミ箱へ移す」だけ。
export function deleteChoices(childCount) {
  if (childCount > 0) {
    return [
      // 件数は確認の文に書いてあるので、ボタンは短くする（幅420でも1行に収まるように）。
      { label: '一緒に移す', value: 'all', primary: true },
      { label: '残す', value: 'root' },
    ]
  }
  return [{ label: 'ゴミ箱へ移す', value: 'root', primary: true }]
}

// 移したあとの知らせ。undo：外したリンクがエディターの履歴にあり、「元に戻す」で戻せるか。
// unlinked：リンクを外したか（開いていないノートのリンクを外したときは、履歴には積まれない）。
// sourceName：開いていないリンク元のノートの中のリンクも外したとき、そのノートの名前（「元に戻す」では戻らない）。
// keyLabel：キーの案内を Windows では Ctrl にする関数（keys.mjs の keyLabel）。
export function deletedText({ title, movedChildren = 0, undo = true, unlinked = true, sourceName = '', keyLabel = (text) => text }) {
  const head = 'タスク「' + title + '」' + (movedChildren > 0 ? 'とサブタスク' + movedChildren + '件' : '') + 'をゴミ箱へ移しました。'
  const source = sourceName ? '「' + sourceName + '」の中のリンクも外しました（こちらは「元に戻す」では戻りません）。' : ''
  if (undo) return head + keyLabel('「元に戻す」（Cmd+Z）で行のリンクは戻りますが、ノートはゴミ箱にあります。') + source
  return head + (unlinked ? 'リンクも外しました。' : '') + source + 'ノートはゴミ箱にあります。'
}

// ゴミ箱へ移せなかったものがあるときの知らせ。rootMoved：消すタスク自身は移せたか。
// unlinked・undo：行のリンクを外したか、それを「元に戻す」で戻せるか（タスク自身を移せなかったときは、戻し方を添える）。
// sourceName：リンク元のノートの中のリンクも外したとき、その名前（「元に戻す」では戻らないので、タスク自身を移せなかったときは書き添える）。
export function trashFailedNotice({ failed, rootMoved, unlinked = false, undo = false, sourceName = '', keyLabel = (text) => text }) {
  const head = rootMoved ? '' : unlinked ? 'リンクは外しましたが、' : ''
  const tail = !rootMoved && unlinked && undo ? keyLabel('\n「元に戻す」（Cmd+Z）で、外したリンクを戻せます。') : ''
  return head + trashFailedText(failed) + tail + (rootMoved ? '' : sourceLinkNote(sourceName))
}

// リンク元のノートの中のリンクも外したことを知らせる1文（行の頭に改行をつける）。なければ空。
export function sourceLinkNote(sourceName) {
  return sourceName ? '\n「' + sourceName + '」の中のリンクは外しました（「元に戻す」では戻りません）。' : ''
}

// サイドバーの「リンクが外れたタスク」の「ゴミ箱へ」で、読み直した一覧（list。読めなければ null）から、まだ移してよいかを決める。
// 返り値：{ ok: true, task } か { ok: false, message }（一覧を読めない・タスクがない・もう外れていない）。
export function unlinkedTrashCheck(list, path) {
  if (!list) return { ok: false, message: 'タスクの一覧を読めなかったので、移せません。' }
  const task = findTask(list, path)
  if (!task || task.unlinked !== true) return { ok: false, message: 'このタスクは、もうリンクが外れたタスクではない（またはなくなった）ので、移しませんでした。' }
  return { ok: true, task }
}

// 子を続けて移す途中で失敗したときの知らせ。
export function trashFailedText(failed) {
  const list = failed.slice(0, 8).map((path) => '・' + path).join('\n')
  const more = failed.length > 8 ? '\nほか' + (failed.length - 8) + '件' : ''
  return 'ゴミ箱へ移せなかったノートがあります（' + failed.length + '件）。\n' + list + more
}
