import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

// 閲覧の表示をなくした（2026-11-25）。画面のボタンとキー操作に、閲覧が戻っていないことを確かめる。
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

test('表示の切り替えのボタンは「編集」と「ソース」の2つだけ', () => {
  const html = read('../public/index.html')
  const group = html.match(/<div id="modes"[\s\S]*?<\/div>/)
  assert.ok(group, 'modes の欄がある')
  const modes = [...group[0].matchAll(/data-mode="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]])
  assert.deepEqual(modes, [['live', '編集'], ['source', 'ソース']])
  assert.equal(html.includes('閲覧'), false)
  assert.equal(/Cmd\+E(?!nter)/.test(html), false)
})

test('ノートは編集の表示で開き、閲覧へ切り替えるキー（Cmd+E）はない', () => {
  const main = read('../src/main.mjs')
  assert.match(main, /^let mode = 'live'$/m)
  assert.equal(/startMode = 'reading'/.test(main), false)
  assert.equal(/'Mod-e'/.test(main), false)
  assert.equal(/applyMode\('reading'\)/.test(main), false)
  assert.equal(/mode === 'reading'/.test(main), false)
})
