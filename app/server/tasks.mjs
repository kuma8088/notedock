// タスクのノートを集めて返す（デイリーノートの上のパネルが使う）。読み取りだけ。
// 一覧を求められたときに Tasks/ の下をたどり、ファイルごとの i-node・大きさ・更新日時を前回と比べて、
// 変わったものだけ読み直す（フォルダーの監視はしない。見積もりの設計1の案b）。
import fs from 'node:fs'
import path from 'node:path'

import { TASK_DEFAULT_STATUS, TASK_FOLDER, TASK_STATUSES, buildTaskNote, readTaskProps } from '../src/tasks.mjs'
import { taskFileName } from '../src/task-line.mjs'
import { isValidDate } from '../src/periodic.mjs'
import { createNote, readNote } from './notes.mjs'
import { isListable, resolveFolderPath, resolveNotePath } from './paths.mjs'
import { fingerprint } from './watch.mjs'
import { normalizeKey } from '../src/links.mjs'
import { linkRefsIn, unlinkedMap } from '../src/task-unlinked.mjs'
import { pathKey } from '../src/task-delete.mjs'

const BOM = String.fromCharCode(0xfeff)

// 編集できないノート（BOM つき・改行が混ざったもの）も、読み取りでは出せるようにそろえてから読む。
function propsOf(text) {
  let normal = String(text)
  if (normal.startsWith(BOM)) normal = normal.slice(1)
  return readTaskProps(normal.replace(/\r\n?/g, '\n'))
}

// [[Tasks/a|表示名]]・[[a]]・Tasks/a.md のどれからでも、リンク先の文字（.md と表示名・見出しを外したもの）を取り出す。
export function linkTarget(value) {
  let text = String(value ?? '').trim()
  const wiki = text.match(/^\[\[([^\[\]]+)\]\]$/)
  if (wiki) text = wiki[1]
  text = text.split('|')[0].split('#')[0].trim()
  return text.replace(/\.md$/i, '')
}

// notes()：Vault のノート一覧（{ known, truncated }。app.mjs の notes() と同じもの）。「リンクが外れたか」の判定でリンクを解決するのに使う。
// 渡さなければ判定はせず、unlinked はいつも false。
export function createTaskIndex(root, { isHidden = () => false, maxEntries = 5000, maxDepth = 16, folder = TASK_FOLDER, notes = null } = {}) {
  // rel → { fp, task, refs }。task が null なら type: task でないノート。refs はそのノートのリンク（判定に使う）。
  const cache = new Map()
  // goal・parent のノート（Tasks/ の外）の、rel → { fp, refs }。判定の答えではなく、ファイルから取り出したものだけを覚える。
  const sources = new Map()
  let reads = 0
  let sourceReads = 0
  // notes() が同じものを返す間は、同じ Set を使う（リンクの解決の表を作り直さないため）。
  let knownFrom = null
  let knownSet = null
  let actualOf = new Map()

  // Vault 直下の、folder と大文字小文字だけ違う名前のフォルダーも使う。返すパスは実際の名前にする。
  // 同じ名前（大文字小文字だけ違う）が2つあるとき（大文字小文字を区別するディスク）は、決めた名前どおりのものを選ぶ。
  function actualFolder() {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return null
    }
    const want = folder.toLowerCase()
    const found = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.toLowerCase() === want)
    return (found.find((entry) => entry.name === folder) ?? found.sort((a, b) => (a.name < b.name ? -1 : 1))[0])?.name ?? null
  }

  function walk() {
    const name = actualFolder()
    if (!name) return { files: [], truncated: false }
    let base
    try {
      base = resolveFolderPath(root, name)
      if (!fs.lstatSync(base).isDirectory()) return { files: [], truncated: false }
    } catch {
      return { files: [], truncated: false }
    }
    const files = []
    let truncated = false
    // 調べる項目の数の上限（フォルダーが極端に多いときに止めるため）。ファイルの件数の上限とは別。
    let scanned = 0
    const scanLimit = maxEntries * 4
    const queue = [{ dir: base, prefix: `${name}/`, depth: 1 }]
    for (let head = 0; head < queue.length; head++) {
      const { dir, prefix, depth } = queue[head]
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (scanned >= scanLimit) {
          truncated = true
          break
        }
        scanned++
        if (!isListable(entry.name) || entry.isSymbolicLink()) continue
        const full = path.join(dir, entry.name)
        if (isHidden(full)) continue
        if (entry.isDirectory()) {
          if (depth < maxDepth) queue.push({ dir: full, prefix: `${prefix}${entry.name}/`, depth: depth + 1 })
          else truncated = true
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          files.push({ rel: `${prefix}${entry.name}`, full })
        }
      }
    }
    // 多すぎるときは、パスの名前順で先頭から maxEntries 件を使う（読み直すたびに同じものが残るように）。
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    if (files.length > maxEntries) {
      files.length = maxEntries
      truncated = true
    }
    return { files, truncated }
  }

  function load(rel) {
    reads++
    let note
    try {
      note = readNote(root, rel)
    } catch {
      return { task: null, refs: [] }
    }
    const props = propsOf(note.text)
    return { task: props ? { path: rel, ...props, editable: note.editable, reason: note.reason } : null, refs: linkRefsIn(note.text) }
  }

  function knownNow() {
    if (!notes) return null
    let listed
    try {
      listed = notes()
    } catch {
      return null
    }
    if (listed !== knownFrom) {
      knownFrom = listed
      knownSet = new Set((listed?.known ?? []).map(normalizeKey))
      // 照合のキー（NFC）から、ディスクの上の実際の名前へ（NFD の名前のノートも読めるように）。
      actualOf = new Map((listed?.known ?? []).map((rel) => [normalizeKey(rel), rel]))
    }
    return { set: knownSet, truncated: listed?.truncated === true }
  }

  // goal・parent のノートのリンク。読めない・隠しファイルなら null。変わっていなければ読み直さない。
  function sourceRefs(rel, used) {
    const actual = actualOf.get(normalizeKey(rel)) ?? rel
    used.add(actual)
    let full
    try {
      full = resolveNotePath(root, actual)
    } catch {
      return null
    }
    if (isHidden(full)) return null
    const fp = fingerprint(full)
    if (fp === 'missing') {
      sources.delete(actual)
      return null
    }
    const hit = sources.get(actual)
    if (hit && hit.fp === fp) return hit.refs
    sourceReads++
    let refs = null
    try {
      refs = linkRefsIn(readNote(root, actual).text)
    } catch {
      refs = null
    }
    sources.set(actual, { fp, refs })
    return refs
  }

  // 今のタスクの一覧。親の名前（parentTitle）と、親のノートの場所（parentPath）も付ける。
  function list() {
    const { files, truncated } = walk()
    const seen = new Set()
    for (const { rel, full } of files) {
      seen.add(rel)
      const fp = fingerprint(full)
      const hit = cache.get(rel)
      if (hit && hit.fp === fp) continue
      // 読む前に取った印で覚える。読んでいる間に変わっても、次の一覧で読み直される。
      cache.set(rel, { fp, ...load(rel) })
    }
    for (const rel of [...cache.keys()]) if (!seen.has(rel)) cache.delete(rel)
    const tasks = [...cache.values()].map((entry) => entry.task).filter(Boolean)
    const unlinked = judge(tasks, truncated)
    // 照合のキーは、濁点などの持ち方の違い（NFC と NFD）と大文字小文字をそろえる。
    const keyOf = (text) => text.normalize('NFC').toLowerCase()
    const byPath = new Map(tasks.map((task) => [keyOf(task.path.replace(/\.md$/i, '')), task]))
    const byName = new Map()
    for (const task of tasks) {
      const name = keyOf(task.path.split('/').at(-1).replace(/\.md$/i, ''))
      byName.set(name, byName.has(name) ? null : task)
    }
    const out = tasks.map((task) => {
      const flag = unlinked?.get(pathKey(task.path)) === true
      if (!task.parent) return { ...task, parentPath: null, parentTitle: '', unlinked: flag }
      const target = linkTarget(task.parent)
      const key = keyOf(target)
      const parent = byPath.get(key) ?? (key.includes('/') ? null : byName.get(key)) ?? null
      const title = parent ? parent.title || parent.path.split('/').at(-1).replace(/\.md$/i, '') : target.split('/').at(-1)
      return { ...task, parentPath: parent?.path ?? null, parentTitle: title, unlinked: flag }
    })
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { tasks: out, truncated }
  }

  // 「リンクが外れたか」を毎回決め直す（答えはほかのファイルと known で変わるので覚えない）。
  // 一覧が途中まで（多すぎる）ときは、Tasks/ からのリンクを全部は見られないので、どれも外れたとしない。
  function judge(tasks, truncated) {
    const known = knownNow()
    if (!known || truncated) return null
    const used = new Set()
    const taskNotes = [...cache.entries()].map(([rel, entry]) => ({ path: rel, refs: entry.refs ?? [] }))
    const map = unlinkedMap(tasks, { known: known.set, refsOf: (rel) => sourceRefs(rel, used), taskNotes, complete: !known.truncated })
    // 使わなくなった goal・parent のノートは覚えておかない。
    for (const rel of [...sources.keys()]) if (!used.has(rel)) sources.delete(rel)
    return map
  }

  return { list, reads: () => reads, sourceReads: () => sourceReads, folderName: actualFolder }
}

// ---- タスクのノートを作る（POST /api/tasks） ----

const bad = (message) => Object.assign(new Error(message), { status: 400 })
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/
const LINK = /^\[\[[^\[\]]+\]\]$/
const BARE = /^[^\[\]"]+$/

function linkField(value, name) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || CONTROL.test(value)) throw bad(name)
  const text = value.trim()
  if (!LINK.test(text) && !BARE.test(text)) throw bad(name)
  return text
}

function dateField(value, name) {
  if (value === undefined || value === null || value === '') return ''
  if (!isValidDate(value)) throw bad(name)
  return value
}

// 画面から受け取った中身を確かめる。作成日（created）は画面の今日で、サーバーでは決めない。
export function checkTaskInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('body')
  const { created, status = TASK_DEFAULT_STATUS } = input
  // タブは空白にする。改行などの制御文字は、プロパティの行が増えてしまうので断る。
  const title = typeof input.title === 'string' ? input.title.replace(/\t/g, ' ') : input.title
  if (typeof title !== 'string' || title.trim() === '' || CONTROL.test(title)) throw bad('title')
  if (!isValidDate(created)) throw bad('created')
  if (!TASK_STATUSES.includes(status)) throw bad('status')
  return {
    title: title.trim(),
    created,
    status,
    start: dateField(input.start, 'start'),
    due: dateField(input.due, 'due'),
    goal: linkField(input.goal, 'goal'),
    parent: linkField(input.parent, 'parent'),
  }
}

// Tasks のフォルダーを用意する。作れない（Tasks がファイル・シンボリックリンク・Vault の外など）ときは、
// 名前の重なりとは別の知らせ（400 { error: 'tasks-folder' }）にする。
function ensureTaskFolder(root, folder) {
  try {
    const dir = resolveFolderPath(root, folder)
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('not a folder')
  } catch {
    throw bad('tasks-folder')
  }
}

// Tasks/ にタスクのノートを1つ作る。名前が重なったら -2、-3 … を付けて作り直す（wx で作るので、大文字小文字や
// 濁点の持ち方だけが違う名前も、OS が重なりとして断る）。folder は実際のフォルダーの名前（なければ Tasks）。
export function createTaskNote(root, input, { folder = TASK_FOLDER, maxTries = 100 } = {}) {
  const props = checkTaskInput(input)
  const text = buildTaskNote(props)
  ensureTaskFolder(root, folder)
  for (let n = 1; n <= maxTries; n++) {
    const rel = `${folder}/${taskFileName(props.title, props.created, n)}`
    try {
      const created = createNote(root, rel, text)
      return { path: rel, hash: created.hash, title: props.title, due: props.due }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw Object.assign(new Error('同じ名前のタスクが多すぎます'), { status: 409 })
}
