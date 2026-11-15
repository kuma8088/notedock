import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createApp } from '../server/app.mjs'
import { buildNote } from '../src/periodic.mjs'

const NOW = '2026-11-08T07:30'

async function setup({ settings, files = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'periodic-root-')))
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'periodic-aux-'))
  const put = (rel, content) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  for (const [rel, content] of Object.entries(files)) put(rel, content)
  const vaultDir = path.join(aux, 'vault')
  fs.mkdirSync(vaultDir, { recursive: true })
  if (settings !== undefined) fs.writeFileSync(path.join(vaultDir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings))
  const app = createApp({ root, port: 0, backupDir: aux, stateDir: aux, vaultDir, noToken: true })
  const server = await app.listen(0)
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (body) => {
    const res = await fetch(`${base}/api/periodic/open`, { method: 'POST', headers: { 'x-note-editor': '1' }, body: JSON.stringify(body) })
    return { status: res.status, json: await res.json() }
  }
  const get = async (month) => {
    const res = await fetch(`${base}/api/periodic?month=${month}`)
    return { status: res.status, json: await res.json() }
  }
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r) })
  return { root, vaultDir, post, get, close, put }
}

function listAll(dir, prefix = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listAll(path.join(dir, e.name), `${prefix}${e.name}/`))
    else out.push(`${prefix}${e.name}`)
  }
  return out.sort()
}

const daily = { period: 'daily', date: '2026-11-08', now: NOW }

const P = { periodic: { root: '90_Periodic' } }

test('置き場を決めたVaultでは、年のフォルダーごと作り、ひな形なしでノートを作る', async () => {
  const t = await setup({ settings: P, files: { 'a.md': 'x' } })
  try {
    const r = await t.post(daily)
    assert.equal(r.status, 201)
    assert.deepEqual(r.json, { path: '90_Periodic/2026/Daily/2026-11-08.md', created: true })
    assert.equal(fs.readFileSync(path.join(t.root, r.json.path), 'utf8'), buildNote({ ...daily, template: '' }))
    const again = await t.post(daily)
    assert.deepEqual(again.json, { path: '90_Periodic/2026/Daily/2026-11-08.md', created: false })
  } finally { await t.close() }
})

test('決まった名前のひな形が置いてあっても、設定に書かなければ使わない', async () => {
  const t = await setup({ settings: P, files: { 'templates/daily-note.md': '# {{title}}\nSECRET\n' } })
  try {
    const r = await t.post(daily)
    assert.equal(fs.readFileSync(path.join(t.root, r.json.path), 'utf8'), buildNote({ ...daily, template: '' }))
  } finally { await t.close() }
})

test('ノートを作るとき、その年のQuarterly・Monthly・Weekly・Dailyのフォルダーをまとめて作る', async () => {
  const t = await setup({ settings: P, files: { 'a.md': 'x' } })
  try {
    const probe = await t.post({ ...daily, dryRun: true })
    assert.deepEqual(probe.json, { path: null, exists: false })
    assert.equal(fs.existsSync(path.join(t.root, '90_Periodic')), false)
    await t.post(daily)
    for (const sub of ['Quarterly', 'Monthly', 'Weekly', 'Daily']) {
      assert.equal(fs.statSync(path.join(t.root, '90_Periodic/2026', sub)).isDirectory(), true, sub)
    }
    // 週は、その週が入る年（ISO）のフォルダーに作る。2027-01-01は2026-W53。
    await t.post({ period: 'weekly', date: '2027-01-01', now: NOW })
    assert.equal(fs.existsSync(path.join(t.root, '90_Periodic/2026/Weekly/2026-W53.md')), true)
    assert.equal(fs.existsSync(path.join(t.root, '90_Periodic/2027')), false)
    await t.post({ period: 'yearly', date: '2027-01-01', now: NOW })
    for (const sub of ['Quarterly', 'Monthly', 'Weekly', 'Daily']) {
      assert.equal(fs.statSync(path.join(t.root, '90_Periodic/2027', sub)).isDirectory(), true, sub)
    }
    // ノートがもうあっても、足りないフォルダーは作る。
    fs.rmSync(path.join(t.root, '90_Periodic/2026/Monthly'), { recursive: true })
    const again = await t.post(daily)
    assert.equal(again.json.created, false)
    assert.equal(fs.statSync(path.join(t.root, '90_Periodic/2026/Monthly')).isDirectory(), true)
  } finally { await t.close() }
})

test('ひな形を書いていない種類は、上の期間へのリンクだけのノートを作る', async () => {
  const t = await setup({ settings: P, files: { 'a.md': 'x' } })
  try {
    const r = await t.post({ period: 'weekly', date: '2026-11-04', now: NOW })
    assert.equal(r.status, 201)
    assert.equal(r.json.path, '90_Periodic/2026/Weekly/2026-W45.md')
    assert.equal(fs.readFileSync(path.join(t.root, r.json.path), 'utf8'), buildNote({ period: 'weekly', date: '2026-11-04', now: NOW, template: '' }))
  } finally { await t.close() }
})

test('設定がない・おかしいときは、置き場なしとして作らない', async () => {
  const cases = [
    ['ファイルなし', {}],
    ['JSON壊れ', { settings: '{oops' }],
    ['root: ..', { settings: { periodic: { root: '../out' } } }],
    ['root: 隠し', { settings: { periodic: { root: '.hidden' } } }],
    ['rootなし', { settings: { periodic: {} } }],
  ]
  for (const [label, opts] of cases) {
    const t = await setup({ files: { 'a.md': 'x' }, ...opts })
    try {
      const r = await t.post(daily)
      assert.equal(r.status, 409, label)
      assert.deepEqual(r.json, { error: 'no-periodic-root' }, label)
      assert.deepEqual((await t.get('2026-11')).json, { disabled: true }, label)
      assert.deepEqual(listAll(t.root), ['a.md'], label)
    } finally { await t.close() }
  }
})

test('Vaultの中の古い設定ファイル（.note-editor/periodic.json）は読まない', async () => {
  const t = await setup({ files: { '.note-editor/periodic.json': JSON.stringify({ root: 'Periodic' }) } })
  try {
    assert.deepEqual((await t.get('2026-11')).json, { disabled: true })
    assert.equal((await t.post(daily)).status, 409)
  } finally { await t.close() }
})

test('ひな形からデイリーノートを作り、もう一度押すと開くだけ', async () => {
  const template = '---\ntags: [daily]\n---\n# {{title}}\n{{date}} {{time}}\n'
  const t = await setup({ settings: { periodic: { root: 'Periodic/', templates: { daily: 'Templates/daily.md' } } }, files: { 'Templates/daily.md': template } })
  try {
    const first = await t.post(daily)
    assert.equal(first.status, 201)
    assert.equal(first.json.created, true)
    assert.equal(first.json.path, 'Periodic/2026/Daily/2026-11-08.md')
    const file = path.join(t.root, first.json.path)
    const text = fs.readFileSync(file, 'utf8')
    assert.equal(text, buildNote({ ...daily, template }))
    fs.appendFileSync(file, '追記\n')
    const second = await t.post(daily)
    assert.equal(second.status, 200)
    assert.equal(second.json.created, false)
    assert.equal(fs.readFileSync(file, 'utf8'), text + '追記\n')
  } finally { await t.close() }
})

test('同時に2回押しても1つしか作らない', async () => {
  const t = await setup({ settings: { periodic: { root: 'Periodic' } } })
  try {
    const [a, b] = await Promise.all([t.post(daily), t.post(daily)])
    assert.equal(a.json.path, b.json.path)
    assert.deepEqual([a.json.created, b.json.created].sort(), [false, true])
    assert.deepEqual(listAll(t.root).filter((f) => f.startsWith('Periodic')), ['Periodic/2026/Daily/2026-11-08.md'])
  } finally { await t.close() }
})

// あるかどうかは決まった場所だけで見る。ほかの場所の同じ名前は探さない（2026-11-08、本人の指定）。
test('ほかの場所に同じ名前のノートがあっても、決まった場所だけを見て作る', async () => {
  const files = { 'archives/a/2026-W23.md': 'a', 'archives/b/2026-W23.md': 'b', 'notes/2026-W23.md': 'c', 'test-copies/x/2026-W23.md': 'copy' }
  const t = await setup({ settings: { periodic: { root: 'Periodic' } }, files })
  try {
    const r = await t.post({ period: 'weekly', date: '2026-06-03', now: NOW })
    assert.equal(r.status, 201)
    assert.deepEqual(r.json, { path: 'Periodic/2026/Weekly/2026-W23.md', created: true })
    for (const [rel, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(t.root, rel), 'utf8'), text)
  } finally { await t.close() }
})

test('ひな形が見つからなければ作らない', async () => {
  const t = await setup({ settings: { periodic: { root: 'Periodic', templates: { daily: 'Templates/none.md' } } } })
  try {
    const r = await t.post(daily)
    assert.equal(r.status, 409)
    assert.equal(r.json.error, 'bad-settings')
    assert.deepEqual(listAll(t.root).filter((f) => f.startsWith('Periodic')), [])
  } finally { await t.close() }
})

test('書き方がおかしい依頼は受け付けない', async () => {
  const t = await setup({ settings: { periodic: { root: 'Periodic' } } })
  try {
    for (const body of [
      { ...daily, period: 'daily2' },
      { ...daily, date: '2026-02-30' },
      { ...daily, now: '2026-11-08 07:30' },
      { ...daily, now: '2026-11-08T25:30' },
    ]) {
      assert.equal((await t.post(body)).status, 400, JSON.stringify(body))
    }
    assert.equal((await t.get('2026-1')).status, 400)
    assert.equal((await t.get('2026-13')).status, 400)
    assert.deepEqual(listAll(t.root).filter((f) => f.startsWith('Periodic')), [])
  } finally { await t.close() }
})

test('月のカレンダーにノートの有無を知らせ、何も書き込まない', async () => {
  const t = await setup({ settings: { periodic: { root: 'Periodic' } }, files: { 'archives/2026-11-03.md': 'other' } })
  try {
    await t.post(daily)
    await t.post({ period: 'weekly', date: '2026-11-04', now: NOW })
    await t.post({ period: 'monthly', date: '2026-11-01', now: NOW })
    const before = listAll(t.root)
    const r = await t.get('2026-11')
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { periodicRoot: 'Periodic', days: ['2026-11-08'], weeks: ['2026-W45'], month: true, quarter: false, year: false })
    assert.deepEqual(listAll(t.root), before)
  } finally { await t.close() }
})

test('dryRunは何も書かずに、あるかどうかだけ答える', async () => {
  const t = await setup({ settings: { periodic: { root: 'Periodic' } }, files: { 'Periodic/2026/Daily/2026-11-08.md': 'x', 'archives/2026-W23.md': 'old' } })
  try {
    const before = listAll(t.root)
    const own = await t.post({ ...daily, dryRun: true })
    assert.equal(own.status, 200)
    assert.deepEqual(own.json, { path: 'Periodic/2026/Daily/2026-11-08.md', exists: true })
    const same = await t.post({ period: 'weekly', date: '2026-06-03', now: NOW, dryRun: true })
    assert.equal(same.status, 200)
    assert.deepEqual(same.json, { path: null, exists: false })
    const none = await t.post({ period: 'daily', date: '2026-11-09', now: NOW, dryRun: true })
    assert.equal(none.status, 200)
    assert.deepEqual(none.json, { path: null, exists: false })
    assert.deepEqual(listAll(t.root), before)
  } finally { await t.close() }
})

test('置き場だけ決めたVaultでもdryRunは何も書かずに答える', async () => {
  const t = await setup({ settings: P, files: { 'a.md': 'x' } })
  try {
    const r = await t.post({ ...daily, dryRun: true })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { path: null, exists: false })
    assert.deepEqual(listAll(t.root), ['a.md'])
  } finally { await t.close() }
})
