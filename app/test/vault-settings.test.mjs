import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createApp } from '../server/app.mjs'
import { checkVaultSettings, readVaultSettings } from '../server/vault-settings.mjs'

const NOW = '2026-11-08T07:30'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

async function setup({ settings, files = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-root-')))
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-aux-'))
  const vaultDir = path.join(aux, 'vault')
  fs.mkdirSync(vaultDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }
  const write = (value) => fs.writeFileSync(path.join(vaultDir, 'settings.json'), typeof value === 'string' ? value : JSON.stringify(value))
  if (settings !== undefined) write(settings)
  const app = createApp({ root, port: 0, backupDir: aux, stateDir: aux, vaultDir, noToken: true })
  const server = await app.listen(0)
  const base = `http://127.0.0.1:${server.address().port}`
  const api = async (url, init = {}) => {
    const res = await fetch(base + url, { ...init, headers: { 'x-note-editor': '1' } })
    return { status: res.status, json: await res.json() }
  }
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r) })
  return { root, vaultDir, write, api, close }
}

test('設定ファイルがなければ、すべて既定でエラーなし', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-none-'))
  const s = readVaultSettings(dir, dir)
  assert.deepEqual(s, { attachmentDir: null, periodic: null, unlisted: new Set(), taskSoonDays: 3, errors: [] })
})

test('すべての項目を読む。知らない項目は無視する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-full-'))
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    attachmentDir: 'img', periodic: { root: 'Days/', templates: { daily: 'templates/daily.md' } }, unlisted: ['archives'], other: 1,
  }))
  const s = readVaultSettings(dir, dir)
  assert.equal(s.attachmentDir, 'img')
  assert.deepEqual(s.periodic, { root: 'Days', templates: { daily: 'templates/daily.md' } })
  assert.deepEqual([...s.unlisted], ['archives'])
  assert.deepEqual(s.errors, [])
})

test('使えない項目は null になり、errors に1件ずつ入る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-bad-'))
  const put = (v) => fs.writeFileSync(path.join(dir, 'settings.json'), typeof v === 'string' ? v : JSON.stringify(v))
  put({ attachmentDir: '../x' })
  let s = readVaultSettings(dir, dir)
  assert.equal(s.attachmentDir, null)
  assert.equal(s.errors.length, 1)
  put({ periodic: { root: '../x' } })
  s = readVaultSettings(dir, dir)
  assert.equal(s.periodic, null)
  assert.equal(s.errors.length, 1)
  put('{oops')
  s = readVaultSettings(dir, dir)
  assert.equal(s.attachmentDir, null)
  assert.equal(s.errors.length, 1)
})

test('設定がないVaultでは、今日のノートは使えず、画像はattachmentsに入る', async () => {
  const t = await setup({ files: { 'a.md': 'x' } })
  try {
    assert.deepEqual((await t.api('/api/periodic?month=2026-11')).json, { disabled: true })
    const open = await t.api('/api/periodic/open', { method: 'POST', body: JSON.stringify({ period: 'daily', date: '2026-11-08', now: NOW }) })
    assert.equal(open.status, 409)
    assert.deepEqual(open.json, { error: 'no-periodic-root' })
    assert.equal(fs.existsSync(path.join(t.root, 'attachments')), false)
    const up = await t.api('/api/attachment?name=a.png', { method: 'POST', body: PNG })
    assert.equal(up.status, 201)
    assert.match(up.json.path, /^attachments\/a-\d{14}\.png$/)
    assert.deepEqual(fs.readFileSync(path.join(t.root, up.json.path)), PNG)
    assert.deepEqual((await t.api('/api/health')).json.settingsErrors, [])
  } finally { await t.close() }
})

test('設定があれば、画像・今日のノート・一覧に出さないフォルダーに効く', async () => {
  const t = await setup({
    settings: { attachmentDir: 'img', periodic: { root: 'Days' }, unlisted: ['archives'] },
    files: { 'a.md': 'x', 'Archives/old.md': 'o' },
  })
  try {
    const up = await t.api('/api/attachment?name=a.png', { method: 'POST', body: PNG })
    assert.match(up.json.path, /^img\/a-\d{14}\.png$/)
    assert.equal(fs.existsSync(path.join(t.root, 'attachments')), false)
    const open = await t.api('/api/periodic/open', { method: 'POST', body: JSON.stringify({ period: 'daily', date: '2026-11-08', now: NOW }) })
    assert.equal(open.status, 201)
    assert.equal(open.json.path, 'Days/2026/Daily/2026-11-08.md')
    const notes = (await t.api('/api/notes')).json
    assert.equal(notes.notes.some((n) => (n.path ?? n).toString().startsWith('Archives/')), false)
    assert.equal(notes.notes.length >= 2, true)
  } finally { await t.close() }
})

test('attachmentDirが使えなければ attachments に入り、health に出る', async () => {
  const t = await setup({ settings: { attachmentDir: '../x' } })
  try {
    const health = (await t.api('/api/health')).json
    assert.equal(health.settingsErrors.length, 1)
    const up = await t.api('/api/attachment?name=a.png', { method: 'POST', body: PNG })
    assert.match(up.json.path, /^attachments\//)
  } finally { await t.close() }
})

test('設定を書き換えると、再起動なしで次の問い合わせから効く', async () => {
  const t = await setup({ files: { 'a.md': 'x', 'Archives/old.md': 'o' } })
  try {
    const listed = async () => JSON.stringify((await t.api('/api/notes')).json.notes).includes('Archives/old.md')
    assert.equal(await listed(), true)
    t.write({ unlisted: ['archives'] })
    assert.equal(await listed(), false)
    t.write({ periodic: { root: 'Days' }, attachmentDir: 'pics' })
    assert.equal(await listed(), true)
    assert.equal((await t.api('/api/periodic?month=2026-11')).json.periodicRoot, 'Days')
    const up = await t.api('/api/attachment?name=a.png', { method: 'POST', body: PNG })
    assert.match(up.json.path, /^pics\//)
    fs.rmSync(path.join(t.vaultDir, 'settings.json'))
    assert.deepEqual((await t.api('/api/periodic?month=2026-11')).json, { disabled: true })
  } finally { await t.close() }
})

test('使えないunlistedの項目と、使えないひな形は、1件ずつエラーになる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-items-'))
  const put = (v) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(v))
  put({ unlisted: ['ok', '.', '..', '.git2', 5, 'a/b'] })
  let s = readVaultSettings(dir, dir)
  assert.deepEqual([...s.unlisted], ['ok'])
  assert.equal(s.errors.length, 5)
  put({ periodic: { root: 'Days', templates: { daily: '../x.md', weekly: 'ok.md', monthly: '.hidden/t.md' } } })
  s = readVaultSettings(dir, dir)
  assert.deepEqual(s.periodic.templates, { daily: '../x.md', weekly: 'ok.md', monthly: '.hidden/t.md' })
  assert.equal(s.errors.length, 2)
})

test('ドットで始まるattachmentDirは使えない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-dot-'))
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ attachmentDir: '.img' }))
  const s = readVaultSettings(dir, dir)
  assert.equal(s.attachmentDir, null)
  assert.equal(s.errors.length, 1)
})

test('ひな形の場所がVaultの外を指すと、ノートを作らない', async () => {
  const t = await setup({ settings: { periodic: { root: 'Days', templates: { daily: '../secret.md' } } } })
  try {
    assert.equal((await t.api('/api/health')).json.settingsErrors.length, 1)
    const open = await t.api('/api/periodic/open', { method: 'POST', body: JSON.stringify({ period: 'daily', date: '2026-11-08', now: NOW }) })
    assert.equal(open.status, 409)
    assert.equal(open.json.error, 'bad-settings')
    assert.equal(fs.existsSync(path.join(t.root, 'Days/2026/Daily/2026-11-08.md')), false)
    // ほかの種類のノートは作れる。
    const weekly = await t.api('/api/periodic/open', { method: 'POST', body: JSON.stringify({ period: 'weekly', date: '2026-11-08', now: NOW }) })
    assert.equal(weekly.status, 201)
  } finally { await t.close() }
})

test('checkVaultSettings はファイルを読まずに同じ確認をする', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-check-'))
  const ok = checkVaultSettings({ attachmentDir: 'img', unlisted: ['archives'], periodic: { root: 'Days' } }, dir)
  assert.equal(ok.attachmentDir, 'img')
  assert.deepEqual(ok.periodic, { root: 'Days', templates: {} })
  assert.deepEqual([...ok.unlisted], ['archives'])
  assert.deepEqual(ok.errors, [])
  assert.equal(checkVaultSettings({ attachmentDir: '../x' }, dir).errors.length, 1)
  assert.equal(checkVaultSettings([], dir).errors.length, 1)
  assert.equal(checkVaultSettings(null, dir).errors.length, 1)
})

// ---- タスクのパネルの「直近」の日数（tasks.soonDays。段階1-F） ----

test('tasks.soonDays：0から31までの整数を読む。ない・使えないときは3で、使えないときはエラー1件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-soon-'))
  assert.equal(checkVaultSettings({}, dir).taskSoonDays, 3)
  assert.deepEqual(checkVaultSettings({ tasks: {} }, dir).errors, [])
  assert.equal(checkVaultSettings({ tasks: {} }, dir).taskSoonDays, 3)
  for (const ok of [0, 1, 7, 31]) {
    const s = checkVaultSettings({ tasks: { soonDays: ok } }, dir)
    assert.equal(s.taskSoonDays, ok)
    assert.deepEqual(s.errors, [])
  }
  for (const bad of [-1, 32, 2.5, '5', null, true, [3], { n: 3 }]) {
    const s = checkVaultSettings({ tasks: { soonDays: bad } }, dir)
    assert.equal(s.taskSoonDays, 3, JSON.stringify(bad))
    assert.equal(s.errors.length, 1, JSON.stringify(bad))
  }
  for (const bad of ['x', 3, [], null]) {
    const s = checkVaultSettings({ tasks: bad }, dir)
    assert.equal(s.taskSoonDays, 3, JSON.stringify(bad))
    assert.deepEqual(s.errors, ['tasksがオブジェクトではありません'])
  }
  // ほかの項目と一緒でも、ほかの項目の読み方は変わらない。
  const all = checkVaultSettings({ attachmentDir: 'img', periodic: { root: 'Days' }, unlisted: ['a'], tasks: { soonDays: 5 } }, dir)
  assert.equal(all.attachmentDir, 'img')
  assert.equal(all.periodic.root, 'Days')
  assert.deepEqual([...all.unlisted], ['a'])
  assert.equal(all.taskSoonDays, 5)
  assert.deepEqual(all.errors, [])
})

const putJson = (t, body) => t.api('/api/settings', { method: 'PUT', body: JSON.stringify(body) })
const readSettings = (t) => JSON.parse(fs.readFileSync(path.join(t.vaultDir, 'settings.json'), 'utf8'))
const FULL = { attachmentDir: 'img', periodic: { root: 'Days', templates: { daily: 'templates/daily.md' } }, unlisted: ['archives'], other: 1 }

test('日数を PUT しても、periodic・attachmentDir・unlisted・知らない項目は残る', async () => {
  const t = await setup({ settings: FULL })
  try {
    const res = await putJson(t, { taskSoonDays: 5 })
    assert.equal(res.status, 200)
    assert.deepEqual(readSettings(t), { ...FULL, tasks: { soonDays: 5 } })
    assert.deepEqual(res.json, { settings: { ...FULL, tasks: { soonDays: 5 } }, errors: [] })
    // tasks の中のほかの項目も残る。
    t.write({ ...FULL, tasks: { soonDays: 2, later: 'x' } })
    assert.equal((await putJson(t, { taskSoonDays: 0 })).status, 200)
    assert.deepEqual(readSettings(t).tasks, { soonDays: 0, later: 'x' })
  } finally { await t.close() }
})

test('Mod の set_vault_settings と同じ PUT（3項目だけ）で書いても、日数は消えない', async () => {
  const t = await setup({ settings: { ...FULL, tasks: { soonDays: 6 } } })
  try {
    for (const body of [{ attachmentDir: 'pics' }, { periodicRoot: 'Logs' }, { unlisted: ['old'] }, { attachmentDir: null }]) {
      assert.equal((await putJson(t, body)).status, 200, JSON.stringify(body))
      assert.deepEqual(readSettings(t).tasks, { soonDays: 6 }, JSON.stringify(body))
    }
    assert.deepEqual(readSettings(t), { periodic: { root: 'Logs', templates: { daily: 'templates/daily.md' } }, unlisted: ['old'], other: 1, tasks: { soonDays: 6 } })
    // 何も指定しない GET（Mod が今の設定を見るとき）にも出る。
    assert.deepEqual((await t.api('/api/settings')).json.settings.tasks, { soonDays: 6 })
  } finally { await t.close() }
})

test('日数の PUT：整数でない・範囲の外は400で、書かない。null で消す', async () => {
  const t = await setup({ settings: { periodic: { root: 'Days' }, tasks: { soonDays: 4 } } })
  try {
    for (const bad of ['5', 2.5, true, [3], { n: 3 }]) {
      const res = await putJson(t, { taskSoonDays: bad })
      assert.equal(res.status, 400, JSON.stringify(bad))
      assert.deepEqual(res.json.errors, ['taskSoonDaysが整数ではありません'])
    }
    for (const bad of [-1, 32, 1000]) {
      const res = await putJson(t, { taskSoonDays: bad })
      assert.equal(res.status, 400, String(bad))
      assert.equal(res.json.errors.length, 1)
    }
    assert.deepEqual(readSettings(t), { periodic: { root: 'Days' }, tasks: { soonDays: 4 } })
    // null で日数だけを消す。tasks がほかに何も持たなければ、tasks ごと消す。
    assert.equal((await putJson(t, { taskSoonDays: null })).status, 200)
    assert.deepEqual(readSettings(t), { periodic: { root: 'Days' } })
    t.write({ tasks: { soonDays: 4, later: 'x' } })
    await putJson(t, { taskSoonDays: null })
    assert.deepEqual(readSettings(t), { tasks: { later: 'x' } })
    // tasks がオブジェクトでなければ、新しく作り直す。
    t.write({ tasks: 'x' })
    assert.equal((await putJson(t, { taskSoonDays: 2 })).status, 200)
    assert.deepEqual(readSettings(t), { tasks: { soonDays: 2 } })
  } finally { await t.close() }
})

test('GET /api/tasks は日数を添える。ない・使えない・settings.json が壊れているときは3', async () => {
  const t = await setup()
  try {
    const soon = async () => (await t.api('/api/tasks')).json.soonDays
    assert.equal(await soon(), 3)
    t.write({ tasks: { soonDays: 9 } })
    assert.equal(await soon(), 9)
    t.write({ tasks: { soonDays: 99 } })
    assert.equal(await soon(), 3)
    t.write('{oops')
    assert.equal(await soon(), 3)
    t.write({ tasks: { soonDays: 0 } })
    assert.equal(await soon(), 0)
    assert.ok(Array.isArray((await t.api('/api/tasks')).json.tasks))
  } finally { await t.close() }
})
