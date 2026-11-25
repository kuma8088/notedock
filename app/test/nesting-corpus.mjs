// 実物のノートで、入れ子の行の範囲（字下げで決める childRange）と lezer の ListItem の範囲を比べる。npm test には入れない。
// 使い方: node test/nesting-corpus.mjs <フォルダー> [--all] [--verbose]
//   ふつうは週・月・四半期のノート（名前が 2026-W10・2026-03・2026-Q1 の形）だけを見る。--all ならすべての .md。
//   --verbose なら、違いのある行の文字も出す（ノートの中身が画面に出るので、記録に貼るときは気をつける）。
// 違いの分け方は nesting-lezer.mjs の compareNesting。'lazy'（怠惰な続きの行）と 'blank'（空の行だけ）以外があれば、終わりのコードを 1 にする。
import fs from 'node:fs'
import path from 'node:path'

import { compareNesting } from './nesting-lezer.mjs'

const args = process.argv.slice(2)
const root = args.find((arg) => !arg.startsWith('--'))
if (!root) {
  console.error('使い方: node test/nesting-corpus.mjs <フォルダー> [--all] [--verbose]')
  process.exit(2)
}
const all = args.includes('--all')
const verbose = args.includes('--verbose')
const PERIODIC = /^\d{4}-(?:W\d{2}|\d{2}|Q[1-4])\.md$/

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.md') && (all || PERIODIC.test(entry.name))) out.push(full)
  }
  return out.sort()
}

const total = { notes: 0, lists: 0, withChildren: 0, diffs: 0, kinds: {} }
for (const file of walk(root)) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n')
  const result = compareNesting(text)
  total.notes++
  total.lists += result.lists
  total.withChildren += result.withChildren
  total.diffs += result.diffs.length
  for (const diff of result.diffs) total.kinds[diff.kind] = (total.kinds[diff.kind] ?? 0) + 1
  const summary = result.diffs.map((diff) => diff.kind + ':' + diff.line).join(' ')
  console.log([path.relative(root, file), '箇条書き ' + result.lists, '子あり ' + result.withChildren, '違い ' + result.diffs.length, summary].join('\t').trimEnd())
  if (verbose) for (const diff of result.diffs) console.log('  ', JSON.stringify(diff))
}
console.log(JSON.stringify(total))
const unexpected = Object.keys(total.kinds).filter((kind) => kind !== 'lazy' && kind !== 'blank')
process.exit(unexpected.length ? 1 : 0)
