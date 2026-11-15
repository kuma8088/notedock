import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { createApp } from '../server/app.mjs'
import { readAppearance, sanitizeAppearance } from '../server/appearance.mjs'
import { appearanceVars } from '../src/appearance.mjs'

let server
let base
let stateDir

before(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'look-root-')))
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-state-'))
  server = await createApp({ root, port: 0, backupDir: stateDir, stateDir, vaultDir: path.join(stateDir, 'vault'), noToken: true }).listen(0)
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  })
})

test('フォント、大きさ、色を受け取る', () => {
  const input = {
    bodyFont: "'Hiragino Mincho ProN', serif",
    uiFont: 'Meiryo, sans-serif',
    codeFont: 'Menlo, monospace',
    fontSize: 17,
    codeSize: 14,
    contentWidth: 700,
    light: { bg: '#FFFFFF', text: '#111111' },
    dark: { accent: '#d97757' },
  }
  assert.deepEqual(sanitizeAppearance(input), input)
})

test('使えない値は捨て、残りは生かす', () => {
  assert.deepEqual(
    sanitizeAppearance({
      bodyFont: 'x; background: url(https://evil.example/a.png)',
      uiFont: 'a{color:red}',
      codeFont: 123,
      fontSize: 99,
      light: { bg: 'red', text: '#111111', other: '#222222' },
      dark: 'x',
      unknown: 'x',
    }),
    { light: { text: '#111111' } },
  )
})

test('コードの大きさと本文の幅の範囲を守る', () => {
  assert.deepEqual(sanitizeAppearance({ codeSize: 9, contentWidth: 479, listSize: 9 }), {})
  assert.deepEqual(sanitizeAppearance({ codeSize: 33, contentWidth: 1601, listSize: 33 }), {})
  assert.deepEqual(sanitizeAppearance({ listSize: 16 }), { listSize: 16 })
  assert.deepEqual(sanitizeAppearance({ codeSize: 13, contentWidth: 768 }), { codeSize: 13, contentWidth: 768 })
})

test('文字の大きさの範囲を守る', () => {
  assert.deepEqual(sanitizeAppearance({ fontSize: 10 }), { fontSize: 10 })
  assert.deepEqual(sanitizeAppearance({ fontSize: 32 }), { fontSize: 32 })
  for (const bad of [9, 33, '15', Number.NaN]) assert.deepEqual(sanitizeAppearance({ fontSize: bad }), {}, String(bad))
})

test('設定ファイルがない、壊れているときは初期設定のまま', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-file-'))
  assert.deepEqual(readAppearance(dir), {})
  fs.writeFileSync(path.join(dir, 'appearance.json'), '{broken')
  assert.deepEqual(readAppearance(dir), {})
  fs.writeFileSync(path.join(dir, 'appearance.json'), '[1]')
  assert.deepEqual(readAppearance(dir), {})
})

test('サーバーは設定ファイルを確かめてから返す', async () => {
  fs.writeFileSync(path.join(stateDir, 'appearance.json'), JSON.stringify({ fontSize: 18, bodyFont: 'a;b' }))
  const response = await fetch(`${base}/api/appearance`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { fontSize: 18 })
})

test('明るいときと暗いときで、画面へ渡す値を分ける', () => {
  const look = { bodyFont: 'Serif', uiFont: 'Ui', codeFont: 'Code', fontSize: 18, light: { bg: '#ffffff' }, dark: { bg: '#000000', codeBg: '#111111' } }
  assert.deepEqual(appearanceVars(look, false), { '--body': 'Serif', '--ui': 'Ui', '--mono': 'Code', '--note-size': '18px', '--bg': '#ffffff' })
  assert.deepEqual(appearanceVars(look, true), { '--body': 'Serif', '--ui': 'Ui', '--mono': 'Code', '--note-size': '18px', '--bg': '#000000', '--code-bg': '#111111' })
  assert.deepEqual(appearanceVars({}, false), {})
  assert.deepEqual(appearanceVars({ codeSize: 13, contentWidth: 768 }, false), { '--code-size': '13px', '--note-width': '768px' })
  assert.deepEqual(appearanceVars({ listSize: 16 }, false), { '--list-size': '16px' })
})
