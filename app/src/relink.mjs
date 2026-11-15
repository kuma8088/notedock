// ノートやフォルダーを動かしたときに、ほかのノートのリンクをどう書き換えるかを計算する。
// ファイルには触らない。サーバーが結果を見て書き込む。

import { isExternal, relativeHref, resolveHref, resolveWikiTarget, splitHref } from './links.mjs'

const MD_LINK = /(!?\[(?:[^\]\\]|\\.)*\]\()(<[^>]*>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'))?\))/g
// 参照の書き方の定義の行（[名前]: 行き先.md）。
const REF_DEF = /^(\s{0,3}\[[^\]]+\]:\s*)(<[^>]*>|\S+)(.*)$/
const FILE_LIKE = /\.[A-Za-z0-9]{1,5}(?:#.*)?$/
const WIKI_LINK = /(!?\[\[)([^\]\n]+?)(\]\])/g
const FENCE = /^(\s*)(`{3,}|~{3,})/

// 動かす元と先。ノート1件なら { from: 'a/b.md', to: 'c/b.md' }、フォルダーなら { from: 'a', to: 'c/a' }。
// 濁点の持ち方の違い（Macのファイル名は分解した形のことがある）はそろえて比べる。
// まとめて動かすとき（日付のノートの移行など）は、compileMoves で作った対応表を move に渡す。
export function movedPath(path, move) {
  if (move.exact) {
    const here = path.normalize('NFC')
    const hit = move.exact.get(here)
    if (hit) return hit
    for (const folder of move.folders) {
      if (here.startsWith(`${folder.from}/`)) return `${folder.to}${here.slice(folder.from.length)}`
    }
    return null
  }
  const here = path.normalize('NFC')
  const from = move.from.normalize('NFC')
  if (here === from) return move.to.normalize('NFC')
  if (here.startsWith(`${from}/`)) return `${move.to.normalize('NFC')}${here.slice(from.length)}`
  return null
}

// moves: [{ from, to, folder? }]。ノートは名前ごと、フォルダーは中身ごと動かす。
export function compileMoves(moves) {
  const exact = new Map()
  const folders = []
  for (const move of moves) {
    const from = move.from.normalize('NFC')
    const to = move.to.normalize('NFC')
    if (move.folder) folders.push({ from, to })
    else exact.set(from, to)
  }
  // 深いフォルダーを先に見る。
  folders.sort((a, b) => b.from.length - a.from.length)
  return { exact, folders }
}

function sameHref(a, b) {
  const decode = (text) => {
    try {
      return decodeURI(text.replace(/^<|>$/g, '')).normalize('NFC')
    } catch {
      return text
    }
  }
  return decode(a) === decode(b)
}

function noExt(path) {
  return path.replace(/\.md$/i, '')
}

// 1行の中で、`コード` の部分を除いた範囲だけ置き換える。
function outsideCode(line, replace) {
  let out = ''
  let rest = line
  while (rest) {
    const start = rest.indexOf('`')
    if (start < 0) return out + replace(rest)
    const ticks = rest.slice(start).match(/^`+/)[0]
    const end = rest.indexOf(ticks, start + ticks.length)
    if (end < 0) return out + replace(rest)
    out += replace(rest.slice(0, start)) + rest.slice(start, end + ticks.length)
    rest = rest.slice(end + ticks.length)
  }
  return out
}

// note: 書き換えるノートの、動かす前の場所。after: 動かした後の場所。
// knownBefore / knownAfter: 動かす前と後の、Vaultの中のノートの一覧（[[名前]] を名前で探すため）。
// exists: 渡したときは、行き先が実在しない普通のリンク（もともと切れているもの、http の付かないURLなど）を書き換えない。
export function relinkText(text, { note, after, move, knownBefore, knownAfter, exists }) {
  let count = 0
  const fixMarkdown = (whole, open, href, close) => {
    const bare = href.replace(/^<|>$/g, '')
    if (!bare || bare.startsWith('#') || isExternal(bare)) return whole
    const target = resolveHref(note, bare)
    if (!target || !target.path) return whole
    const moved = movedPath(target.path, move)
    if (!moved && exists && !exists(target.path)) return whole
    const fromRoot = bare.startsWith('/')
    // 一番上から書いたリンクは、行き先が動いたときだけ直す。
    if (!moved && (fromRoot || after === note)) return whole
    const dest = moved ?? target.path
    const { anchor } = splitHref(bare)
    let next = fromRoot ? `/${relativeHref('_.md', dest)}` : relativeHref(after, dest)
    if (anchor) next += `#${anchor}`
    if (href.startsWith('<')) next = `<${decodeURI(next)}>`
    if (next === href || sameHref(next, href)) return whole
    count += 1
    return `${open}${next}${close}`
  }
  const fixWiki = (whole, open, inner, close) => {
    const escaped = inner.includes('\\|')
    const clean = inner.replace(/\\\|/g, '|')
    const bar = clean.indexOf('|')
    const dest = bar < 0 ? clean : clean.slice(0, bar)
    const tail = bar < 0 ? '' : clean.slice(bar)
    const hash = dest.indexOf('#')
    const file = (hash < 0 ? dest : dest.slice(0, hash)).trim()
    const anchor = hash < 0 ? '' : dest.slice(hash)
    if (!file || isExternal(file)) return whole
    const found = resolveWikiTarget(note, file, knownBefore)
    if (!found || !found.exists) return whole
    const moved = movedPath(found.path, move)
    const relative = /^\.{1,2}\//.test(file)
    // 名前だけのリンクは、ほかのノートが動いたせいで、別の同じ名前のノートを指すようになることがある。
    const drifted = !moved && !relative && resolveWikiTarget(after, file, knownAfter)?.path !== found.path
    if (!moved && !drifted && !(relative && after !== note)) return whole
    const target = moved ?? found.path
    const keepExt = /\.md$/i.test(file)
    const shape = (path) => (keepExt ? path : noExt(path))
    let nextFile
    if (relative) {
      nextFile = shape(relativeHref(after, target).split('/').map(decodeURIComponent).join('/'))
      if (!nextFile.startsWith('.')) nextFile = `./${nextFile}`
    } else if (!file.includes('/') && !drifted) {
      // 名前だけのリンクは、名前だけで同じノートに届くなら名前だけにする。
      const name = shape(target.slice(target.lastIndexOf('/') + 1))
      const check = resolveWikiTarget(after, name, knownAfter)
      nextFile = check && check.path === target ? name : shape(target)
    } else {
      nextFile = `${file.startsWith('/') ? '/' : ''}${shape(target)}`
    }
    if (nextFile === file) return whole
    count += 1
    let body = `${nextFile}${anchor}${tail}`
    if (escaped) body = body.replace(/\|/g, '\\|')
    return `${open}${body}${close}`
  }
  let fence = null
  const lines = text.split('\n').map((line) => {
    const mark = line.match(FENCE)
    if (fence) {
      if (mark && mark[2][0] === fence[0] && mark[2].length >= fence.length) fence = null
      return line
    }
    if (mark) {
      fence = mark[2]
      return line
    }
    // 脚注（[^1]: 説明）は除く。行き先がファイルの名前に見えるもの（拡張子がある）だけを書き換える。
    const def = line.match(REF_DEF)
    if (def && !/^\s*\[\^/.test(def[1]) && FILE_LIKE.test(def[2].replace(/^<|>$/g, ''))) {
      return `${def[1]}${fixMarkdown(def[2], '', def[2], '')}${def[3]}`
    }
    return outsideCode(line, (part) => part.replace(WIKI_LINK, fixWiki).replace(MD_LINK, fixMarkdown))
  })
  return { text: lines.join('\n'), count }
}

// notes: [{ path, text }]。動かす前の場所で渡す。書き換えが要るノートだけを返す。
export function planRelink(notes, move, known) {
  const knownBefore = [...known]
  const knownAfter = knownBefore.map((path) => movedPath(path, move) ?? path)
  const changes = []
  for (const { path, text } of notes) {
    const after = movedPath(path, move) ?? path
    const result = relinkText(text, { note: path, after, move, knownBefore, knownAfter })
    if (result.count > 0) changes.push({ from: path, path: after, text: result.text, count: result.count })
  }
  return changes
}
