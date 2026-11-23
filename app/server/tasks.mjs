// タスクのノートを集めて返す（デイリーノートの上のパネルが使う）。読み取りだけ。
// 一覧を求められたときに Tasks/ の下をたどり、ファイルごとの i-node・大きさ・更新日時を前回と比べて、
// 変わったものだけ読み直す（フォルダーの監視はしない。見積もりの設計1の案b）。
import fs from 'node:fs'
import path from 'node:path'

import { TASK_FOLDER, readTaskProps } from '../src/tasks.mjs'
import { readNote } from './notes.mjs'
import { isListable, resolveFolderPath } from './paths.mjs'
import { fingerprint } from './watch.mjs'

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

export function createTaskIndex(root, { isHidden = () => false, maxEntries = 5000, maxDepth = 16, folder = TASK_FOLDER } = {}) {
  // rel → { fp, task }。task が null なら type: task でないノート。
  const cache = new Map()
  let reads = 0

  function walk() {
    let base
    try {
      base = resolveFolderPath(root, folder)
      if (!fs.lstatSync(base).isDirectory()) return { files: [], truncated: false }
    } catch {
      return { files: [], truncated: false }
    }
    const files = []
    let truncated = false
    const queue = [{ dir: base, prefix: `${folder}/`, depth: 1 }]
    for (let head = 0; head < queue.length; head++) {
      const { dir, prefix, depth } = queue[head]
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!isListable(entry.name) || entry.isSymbolicLink()) continue
        const full = path.join(dir, entry.name)
        if (isHidden(full)) continue
        if (entry.isDirectory()) {
          if (depth < maxDepth) queue.push({ dir: full, prefix: `${prefix}${entry.name}/`, depth: depth + 1 })
          else truncated = true
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          if (files.length >= maxEntries) {
            truncated = true
            continue
          }
          files.push({ rel: `${prefix}${entry.name}`, full })
        }
      }
    }
    return { files, truncated }
  }

  function load(rel) {
    reads++
    let note
    try {
      note = readNote(root, rel)
    } catch {
      return null
    }
    const props = propsOf(note.text)
    if (!props) return null
    return { path: rel, ...props, editable: note.editable, reason: note.reason }
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
      cache.set(rel, { fp, task: load(rel) })
    }
    for (const rel of [...cache.keys()]) if (!seen.has(rel)) cache.delete(rel)
    const tasks = [...cache.values()].map((entry) => entry.task).filter(Boolean)
    const byPath = new Map(tasks.map((task) => [task.path.replace(/\.md$/i, '').toLowerCase(), task]))
    const byName = new Map()
    for (const task of tasks) {
      const name = task.path.split('/').at(-1).replace(/\.md$/i, '').toLowerCase()
      byName.set(name, byName.has(name) ? null : task)
    }
    const out = tasks.map((task) => {
      if (!task.parent) return { ...task, parentPath: null, parentTitle: '' }
      const target = linkTarget(task.parent)
      const key = target.toLowerCase()
      const parent = byPath.get(key) ?? (key.includes('/') ? null : byName.get(key)) ?? null
      const title = parent ? parent.title || parent.path.split('/').at(-1).replace(/\.md$/i, '') : target.split('/').at(-1)
      return { ...task, parentPath: parent?.path ?? null, parentTitle: title }
    })
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { tasks: out, truncated }
  }

  return { list, reads: () => reads }
}
