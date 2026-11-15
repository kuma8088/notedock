import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { replaceFile } from './durable.mjs'
import { resolveNotePath } from './paths.mjs'

const SOURCE_ONLY_BYTES = 1_000_000
const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/

export function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

export function hashText(text) {
  return hashBytes(Buffer.from(text, 'utf8'))
}

// ディスクに書く形へ直す。どんな改行が混ざっていても、まずLFにそろえてから、crlf なら CRLF にする。
export function toDisk(text, eol) {
  const lf = text.replace(/\r\n?/g, '\n')
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
}

// eol は、改行がすべてCRLFのときだけ 'crlf'。混ざったノート（編集できない）は 'lf' のまま。
function classify(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let text
  try {
    text = decoder.decode(bytes)
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), reason: 'not-utf8', eol: 'lf' }
  }
  if (text.startsWith('﻿')) return { text, reason: 'bom', eol: 'lf' }
  const crlf = (text.match(/\r\n/g) ?? []).length
  const loneCr = (text.replace(/\r\n/g, '').match(/\r/g) ?? []).length
  const lf = (text.replace(/\r\n/g, '').match(/\n/g) ?? []).length
  if (loneCr > 0 || (crlf > 0 && lf > 0)) return { text, reason: 'mixed-eol', eol: 'lf' }
  const eol = crlf > 0 ? 'crlf' : 'lf'
  const normal = eol === 'crlf' ? text.replace(/\r\n/g, '\n') : text
  const front = normal.match(FRONTMATTER)
  if (front && /^excalidraw-plugin:/m.test(front[1])) return { text: normal, reason: 'excalidraw', eol }
  return { text: normal, reason: null, eol }
}

export function readNote(root, rel) {
  const file = resolveNotePath(root, rel)
  const bytes = fs.readFileSync(file)
  const { text, reason, eol } = classify(bytes)
  return {
    path: rel,
    text,
    hash: hashBytes(bytes),
    editable: reason === null,
    reason,
    eol,
    sourceOnly: bytes.length > SOURCE_ONLY_BYTES,
  }
}

export function writeNote(root, rel, text, baseHash, backups) {
  const file = resolveNotePath(root, rel)
  const current = readNote(root, rel)
  if (!current.editable) throw new Error('not editable')
  if (current.hash !== baseHash) {
    return { conflict: true, current: current.text, hash: current.hash }
  }
  if (typeof text !== 'string') throw new Error('text required')
  backups.firstOfDay(rel, current.text)
  backups.save(rel, current.text, 'previous')
  backups.snapshot(rel, current.text)
  const mode = fs.statSync(file).mode & 0o777
  // 一時ファイルを書いている間の変更に気づくため、置き換える直前にもう一度比べる。
  const data = toDisk(text, current.eol)
  const replaced = replaceFile(file, data, { mode, check: () => hashBytes(fs.readFileSync(file)) === baseHash })
  if (!replaced) {
    const latest = readNote(root, rel)
    return { conflict: true, current: latest.text, hash: latest.hash }
  }
  return { conflict: false, hash: hashText(data) }
}

export function createNote(root, rel, text) {
  const file = resolveNotePath(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { flag: 'wx' })
  return readNote(root, rel)
}
