// ファイル欄の操作（フォルダーを作る、名前を変える、動かす、ゴミ箱に入れる）。
// どの操作も、Vaultの中で、隠しフォルダーでない場所だけを扱う。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { planRelink } from '../src/relink.mjs'
import { renameWithRetry, replaceFile } from './durable.mjs'
import { hashText, readNote, toDisk } from './notes.mjs'
import { moveToTrash } from './platform.mjs'
import { resolveFolderPath, resolveNotePath, scanVault } from './paths.mjs'

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

// ファイル欄に出すフォルダー。中身のないフォルダーも、画像などノート以外のファイルだけが入ったフォルダー（例：図）も出す
// （2026-11-08の本人の指定「画像だけのフォルダーも出す」。2026-11-07の「出さなくて良い」を変えた）。
export function listFolders(root, options) {
  return scanVault(root, options).folders
}

// ノートかフォルダーかを見分けて、本当の場所を返す。
function resolveItem(root, rel) {
  if (typeof rel === 'string' && rel.toLowerCase().endsWith('.md')) {
    const file = resolveNotePath(root, rel)
    if (fs.existsSync(file) && fs.lstatSync(file).isFile()) return { file, kind: 'note' }
    throw fail('not found', 404)
  }
  const dir = resolveFolderPath(root, rel)
  if (fs.existsSync(dir) && fs.lstatSync(dir).isDirectory()) return { file: dir, kind: 'folder' }
  throw fail('not found', 404)
}

function parentMustExist(file) {
  const parent = path.dirname(file)
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory()) throw fail('no parent folder', 409)
}

export function createFolder(root, rel) {
  const dir = resolveFolderPath(root, rel)
  if (fs.existsSync(dir)) throw fail('exists', 409)
  parentMustExist(dir)
  fs.mkdirSync(dir)
  return { path: rel }
}

export function trashItem(root, rel, { run = execFileSync } = {}) {
  const { file, kind } = resolveItem(root, rel)
  moveToTrash(file, { root, run })
  if (fs.existsSync(file)) throw fail('still there', 500)
  return { path: rel, kind }
}

// 動かす前に、どこを書き換えるかを計算する。
function checkMove(root, from, to) {
  const { file, kind } = resolveItem(root, from)
  if (from === to) throw fail('same place')
  if (kind === 'note' && !to.toLowerCase().endsWith('.md')) throw fail('note needs .md')
  // Macのファイル名は大文字と小文字、濁点の持ち方を区別しないので、比べるときはそろえる。
  const fold = (text) => text.normalize('NFC').toLowerCase()
  if (kind === 'folder' && fold(to).startsWith(`${fold(from)}/`)) throw fail('into itself')
  const dest = kind === 'note' ? resolveNotePath(root, to) : resolveFolderPath(root, to)
  // 行き先にもう何かあるときは断る。大文字と小文字だけを変える場合で、通し番号が0でなく同じとき（同じファイル）だけ通す。
  // Windowsでは通し番号が取れず0になることがあり、別のノートを同じファイルと見なして上書きしないため。
  if (fs.existsSync(dest)) {
    const a = fs.statSync(file)
    const b = fs.statSync(dest)
    const caseOnly = from !== to && fold(from) === fold(to)
    if (!caseOnly || !a.ino || a.ino !== b.ino || a.dev !== b.dev) throw fail('exists', 409)
  }
  parentMustExist(dest)
  return { file, dest, kind }
}

function readNoteText(root, rel) {
  try {
    return readNote(root, rel)
  } catch {
    return null
  }
}

// 書き換えの計画。編集できない形のノート（改行がCRLFなど）は書き換えないので、blocked として別に返す。
export function planMove(root, from, to, scanOptions) {
  checkMove(root, from, to)
  const { known, truncated, unreadable: unreadableFolders } = scanVault(root, scanOptions)
  // 途中までの一覧で計画すると、残りのノートのリンクが知らせもなく古いまま残る。
  if (truncated) throw fail('list-truncated', 409)
  const notes = []
  const locked = new Set()
  // 読めないノート（権限がないなど）は、リンクがあるかも分からないので、別に知らせる。
  const unreadable = [...unreadableFolders]
  for (const rel of known) {
    const note = readNoteText(root, rel)
    if (!note) {
      unreadable.push(rel)
      continue
    }
    notes.push({ path: rel, text: note.text, hash: note.hash, eol: note.eol })
    if (!note.editable) locked.add(rel)
  }
  const hashes = new Map(notes.map((note) => [note.path, note.hash]))
  const eols = new Map(notes.map((note) => [note.path, note.eol]))
  const all = planRelink(notes, { from, to }, known).map((change) => ({ ...change, hash: hashes.get(change.from), eol: eols.get(change.from) }))
  return { changes: all.filter((change) => !locked.has(change.from)), blocked: all.filter((change) => locked.has(change.from)), unreadable }
}

// 一時ファイルに書いてから置き換える。置き換える直前に、計画したときと同じ中身かをもう一度確かめる。
function rewriteNote(file, text, hash) {
  const mode = fs.statSync(file).mode & 0o777
  return replaceFile(file, text, { mode, check: () => hashText(fs.readFileSync(file, 'utf8')) === hash })
}

// 動かしてから、確かめた書き換えだけを入れる。書き換える前のノートはバックアップに残す。
// 動かしたあとで書き換えに失敗しても、動かしたことは取り消さず、失敗したノートを返す。
export function moveItem(root, from, to, { relink = false, backups, scanOptions } = {}) {
  const { file, dest, kind } = checkMove(root, from, to)
  const plan = relink ? planMove(root, from, to, scanOptions) : { changes: [], blocked: [] }
  const movedNotes = kind === 'note' ? [[from, to]] : scanVault(root, scanOptions).known.filter((rel) => rel.startsWith(`${from}/`)).map((rel) => [rel, `${to}${rel.slice(from.length)}`])
  renameWithRetry(file, dest)
  for (const [old, next] of movedNotes) {
    try {
      backups?.rename(old, next)
    } catch {
      // 履歴を移せなくても、ノートは動いている。
    }
  }
  const rewritten = []
  const skipped = []
  const failed = []
  for (const change of plan.changes) {
    try {
      const target = resolveNotePath(root, change.path)
      const current = fs.readFileSync(target, 'utf8')
      // 計算してから動かすまでの間に変わったノートは、書き換えない。
      if (hashText(current) !== change.hash) {
        skipped.push(change.path)
        continue
      }
      backups?.firstOfDay(change.path, toDisk(current, 'lf'))
      backups?.save(change.path, toDisk(current, 'lf'), 'previous')
      if (rewriteNote(target, toDisk(change.text, change.eol), change.hash)) rewritten.push({ path: change.path, count: change.count })
      else skipped.push(change.path)
    } catch {
      failed.push(change.path)
    }
  }
  return { from, to, rewritten, skipped: [...skipped, ...plan.blocked.map((change) => change.path)], failed }
}
