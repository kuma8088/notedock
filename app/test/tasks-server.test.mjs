import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { createApp } from '../server/app.mjs'
import { createTaskIndex, linkTarget } from '../server/tasks.mjs'
import { readTaskProps } from '../src/tasks.mjs'

const task = (props, body = '') => `---\n${Object.entries(props).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-root-')))
}
function put(root, rel, content) {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

let root
let server
let base
let stateDir

before(async () => {
  root = makeRoot()
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-state-'))
  put(root, 'Tasks/a.md', task({ title: 'A', type: 'task', status: '未着手', due: '2026-11-25', goal: '"[[90_Periodic/2026/Monthly/2026-11]]"' }))
  put(root, 'Tasks/sub/b.md', task({ title: 'B', type: 'task', status: '進行中', parent: '"[[Tasks/a]]"' }))
  put(root, 'Tasks/not-task.md', task({ type: 'memo' }))
  put(root, 'Tasks/plain.md', '本文だけ\n')
  put(root, 'Other/c.md', task({ title: 'C', type: 'task' }))
  const app = createApp({ root, port: 0, backupDir: stateDir, stateDir, vaultDir: path.join(stateDir, 'vault'), noToken: true })
  server = await app.listen(0)
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => {
    server.closeAllConnections()
    server.close(r)
  })
})

const titles = (data) => data.tasks.map((t) => t.title)

test('GET /api/tasks は Tasks/ の下（サブフォルダーを含む）の type: task だけを返す', async () => {
  const response = await fetch(`${base}/api/tasks`)
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.deepEqual(titles(data), ['A', 'B'])
  const a = data.tasks[0]
  assert.equal(a.path, 'Tasks/a.md')
  assert.equal(a.due, '2026-11-25')
  assert.equal(a.goal, '[[90_Periodic/2026/Monthly/2026-11]]')
  assert.equal(a.editable, true)
  const b = data.tasks[1]
  assert.equal(b.path, 'Tasks/sub/b.md')
  assert.equal(b.parentPath, 'Tasks/a.md')
  assert.equal(b.parentTitle, 'A')
  assert.equal(data.truncated, false)
})

test('足す・書き換える・消すと次の一覧に出る。変わっていないファイルは読み直さない', () => {
  const dir = makeRoot()
  const index = createTaskIndex(dir)
  put(dir, 'Tasks/one.md', task({ title: '一', type: 'task', due: '2026-11-25' }))
  put(dir, 'Tasks/two.md', task({ title: '二', type: 'task' }))
  assert.deepEqual(index.list().tasks.map((t) => t.title), ['一', '二'])
  assert.equal(index.reads(), 2)
  // 変えていなければ読まない
  index.list()
  assert.equal(index.reads(), 2)
  // 足す
  put(dir, 'Tasks/three.md', task({ title: '三', type: 'task' }))
  assert.deepEqual(index.list().tasks.map((t) => t.title), ['一', '三', '二'])
  assert.equal(index.reads(), 3)
  // 書き換える（大きさが変わる）
  put(dir, 'Tasks/one.md', task({ title: '一の2', type: 'task', due: '2026-12-01' }))
  const after1 = index.list().tasks
  assert.equal(after1.find((t) => t.path === 'Tasks/one.md').title, '一の2')
  assert.equal(index.reads(), 4)
  // 消す
  fs.rmSync(path.join(dir, 'Tasks/two.md'))
  assert.deepEqual(index.list().tasks.map((t) => t.title), ['一の2', '三'])
  assert.equal(index.reads(), 4)
})

test('同じ大きさで書き換えても、更新日時が変われば読み直す', () => {
  const dir = makeRoot()
  const index = createTaskIndex(dir)
  const full = put(dir, 'Tasks/x.md', task({ title: 'AAAA', type: 'task' }))
  const before = fs.statSync(full)
  assert.equal(index.list().tasks[0].title, 'AAAA')
  fs.writeFileSync(full, task({ title: 'BBBB', type: 'task' }))
  assert.equal(fs.statSync(full).size, before.size)
  const later = new Date(before.mtimeMs + 5000)
  fs.utimesSync(full, later, later)
  assert.equal(index.list().tasks[0].title, 'BBBB')
  assert.equal(index.reads(), 2)
})

test('type: task でなくなったノートは一覧から外れ、type: task になれば出る', () => {
  const dir = makeRoot()
  const index = createTaskIndex(dir)
  const full = put(dir, 'Tasks/x.md', task({ title: 'X', type: 'task' }))
  assert.equal(index.list().tasks.length, 1)
  fs.writeFileSync(full, task({ title: 'X', type: 'memo', extra: 'longer' }))
  assert.equal(index.list().tasks.length, 0)
  fs.writeFileSync(full, task({ title: 'X', type: 'task', extra: 'longer-again' }))
  assert.equal(index.list().tasks.length, 1)
})

test('編集できないノート（改行の混在・BOM・CRLF・UTF-8 でない）も読み取りで出す', () => {
  const dir = makeRoot()
  put(dir, 'Tasks/mixed.md', '---\r\ntitle: 混在\ntype: task\r\ndue: 2026-11-25\r\n---\r\n')
  put(dir, 'Tasks/bom.md', String.fromCharCode(0xfeff) + task({ title: 'BOM', type: 'task' }))
  put(dir, 'Tasks/crlf.md', task({ title: 'CRLF', type: 'task' }).replace(/\n/g, '\r\n'))
  fs.writeFileSync(path.join(dir, 'Tasks/latin.md'), Buffer.concat([Buffer.from(task({ title: 'Latin', type: 'task' })), Buffer.from([0xff, 0x0a])]))
  const list = createTaskIndex(dir).list().tasks
  const by = Object.fromEntries(list.map((t) => [t.path, t]))
  assert.equal(by['Tasks/mixed.md'].title, '混在')
  assert.equal(by['Tasks/mixed.md'].due, '2026-11-25')
  assert.equal(by['Tasks/mixed.md'].editable, false)
  assert.equal(by['Tasks/mixed.md'].reason, 'mixed-eol')
  assert.equal(by['Tasks/bom.md'].title, 'BOM')
  assert.equal(by['Tasks/bom.md'].editable, false)
  assert.equal(by['Tasks/crlf.md'].title, 'CRLF')
  assert.equal(by['Tasks/crlf.md'].editable, true)
  assert.equal(by['Tasks/latin.md'].title, 'Latin')
  assert.equal(by['Tasks/latin.md'].editable, false)
})

test('Tasks/ がない・ファイルである・シンボリックリンクのときは空の一覧', () => {
  const none = makeRoot()
  assert.deepEqual(createTaskIndex(none).list(), { tasks: [], truncated: false })
  const asFile = makeRoot()
  put(asFile, 'Tasks', 'x')
  assert.deepEqual(createTaskIndex(asFile).list(), { tasks: [], truncated: false })
  const linked = makeRoot()
  const other = makeRoot()
  put(other, 'x.md', task({ title: '外', type: 'task' }))
  fs.symlinkSync(other, path.join(linked, 'Tasks'))
  assert.deepEqual(createTaskIndex(linked).list(), { tasks: [], truncated: false })
})

test('中のシンボリックリンクと隠しファイルは読まない。読めない1件があっても一覧は返る', () => {
  const dir = makeRoot()
  const other = makeRoot()
  put(other, 'x.md', task({ title: '外', type: 'task' }))
  put(dir, 'Tasks/ok.md', task({ title: 'OK', type: 'task' }))
  put(dir, 'Tasks/.hidden.md', task({ title: '隠し', type: 'task' }))
  fs.symlinkSync(path.join(other, 'x.md'), path.join(dir, 'Tasks/link.md'))
  const locked = put(dir, 'Tasks/locked.md', task({ title: '読めない', type: 'task' }))
  fs.chmodSync(locked, 0o000)
  try {
    assert.deepEqual(createTaskIndex(dir).list().tasks.map((t) => t.title), ['OK'])
  } finally {
    fs.chmodSync(locked, 0o644)
  }
})

test('親の名前：フォルダーつき・名前だけ・表示名つき・見つからない', () => {
  const dir = makeRoot()
  put(dir, 'Tasks/p.md', task({ title: '親', type: 'task' }))
  put(dir, 'Tasks/c1.md', task({ title: '子1', type: 'task', parent: '"[[Tasks/p]]"' }))
  put(dir, 'Tasks/c2.md', task({ title: '子2', type: 'task', parent: '"[[p|親のほう]]"' }))
  put(dir, 'Tasks/c3.md', task({ title: '子3', type: 'task', parent: '[[Tasks/p]]' }))
  put(dir, 'Tasks/c4.md', task({ title: '子4', type: 'task', parent: '"[[Tasks/なくなった親]]"' }))
  const by = Object.fromEntries(createTaskIndex(dir).list().tasks.map((t) => [t.title, t]))
  assert.equal(by['子1'].parentTitle, '親')
  assert.equal(by['子2'].parentTitle, '親')
  assert.equal(by['子2'].parentPath, 'Tasks/p.md')
  assert.equal(by['子3'].parentTitle, '親')
  assert.equal(by['子4'].parentTitle, 'なくなった親')
  assert.equal(by['子4'].parentPath, null)
  assert.equal(by['親'].parentTitle, '')
})

test('件数の上限を超えたら途中までと知らせる', () => {
  const dir = makeRoot()
  for (let i = 0; i < 4; i++) put(dir, `Tasks/t${i}.md`, task({ title: `T${i}`, type: 'task' }))
  put(dir, 'Tasks/a/t9.md', task({ title: 'T9', type: 'task' }))
  const { tasks, truncated } = createTaskIndex(dir, { maxEntries: 3 }).list()
  // 切る順はパスの名前順（Tasks/a/t9.md → Tasks/t0.md → Tasks/t1.md）。
  assert.deepEqual(tasks.map((t) => t.path), ['Tasks/a/t9.md', 'Tasks/t0.md', 'Tasks/t1.md'])
  assert.equal(truncated, true)
})

test('親の照合は、濁点の持ち方（NFC と NFD）の違いをそろえる', () => {
  const dir = makeRoot()
  const nfd = 'ガイド'.normalize('NFD')
  put(dir, `Tasks/${nfd}.md`, task({ title: '親（NFD の名前）', type: 'task' }))
  put(dir, 'Tasks/c.md', task({ title: '子', type: 'task', parent: `"[[Tasks/${'ガイド'.normalize('NFC')}]]"` }))
  put(dir, 'Tasks/d.md', task({ title: '子2', type: 'task', parent: `"[[${'ガイド'.normalize('NFC')}]]"` }))
  const by = Object.fromEntries(createTaskIndex(dir).list().tasks.map((t) => [t.title, t]))
  assert.equal(by['子'].parentTitle, '親（NFD の名前）')
  assert.ok(by['子'].parentPath)
  assert.equal(by['子2'].parentTitle, '親（NFD の名前）')
})

test('Tasks と大文字小文字だけ違う名前のフォルダーも読み、実際の名前でパスを返す', () => {
  const dir = makeRoot()
  put(dir, 'tasks/x.md', task({ title: 'X', type: 'task' }))
  const list = createTaskIndex(dir).list().tasks
  assert.deepEqual(list.map((t) => t.path), ['tasks/x.md'])
})

test('linkTarget', () => {
  assert.equal(linkTarget('[[Tasks/a|x]]'), 'Tasks/a')
  assert.equal(linkTarget('[[a#見出し]]'), 'a')
  assert.equal(linkTarget('Tasks/a.md'), 'Tasks/a')
})


// ---- POST /api/tasks ----

async function withApp(setup, run) {
  const dir = makeRoot()
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-state-'))
  setup?.(dir)
  const app = createApp({ root: dir, port: 0, backupDir: state, stateDir: state, vaultDir: path.join(state, 'vault'), noToken: true })
  const srv = await app.listen(0)
  const url = 'http://127.0.0.1:' + srv.address().port
  const post = async (body) => {
    const response = await fetch(url + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-note-editor': '1' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { status: response.status, data: await response.json().catch(() => null) }
  }
  try {
    await run({ dir, url, post })
  } finally {
    await new Promise((r) => {
      srv.closeAllConnections()
      srv.close(r)
    })
  }
}

const sample = { title: '**4枚描く** [[下描き]]', created: '2026-05-03', due: '2026-05-10', goal: '[[90_Periodic/2026/Monthly/2026-05]]' }

test('POST /api/tasks は Tasks/ にタスクのノートを作り、作ったパスを返す。作成日は受け取ったものを使う', async () => {
  await withApp(null, async ({ dir, url, post }) => {
    const { status, data } = await post(sample)
    assert.equal(status, 201)
    assert.equal(data.path, 'Tasks/2026-05-03-4枚描く 下描き.md')
    assert.equal(data.due, '2026-05-10')
    const text = fs.readFileSync(path.join(dir, data.path), 'utf8')
    assert.equal(text, '---\ntitle: "**4枚描く** [[下描き]]"\ntype: task\nstatus: 未着手\nstart:\ndue: 2026-05-10\ngoal: "[[90_Periodic/2026/Monthly/2026-05]]"\n---\n')
    // 一覧とノートの一覧にすぐ出る
    const tasks = await (await fetch(url + '/api/tasks')).json()
    assert.deepEqual(tasks.tasks.map((t) => t.path), [data.path])
    assert.equal(tasks.tasks[0].title, sample.title)
    const notes = await (await fetch(url + '/api/notes')).json()
    assert.ok(notes.notes.includes(data.path))
  })
})

test('POST /api/tasks：同じ名前が続いたら -2、-3 を付ける。Tasks/ がなければ作る', async () => {
  await withApp(null, async ({ dir, post }) => {
    assert.equal(fs.existsSync(path.join(dir, 'Tasks')), false)
    const paths = []
    for (let i = 0; i < 3; i++) paths.push((await post({ title: '6/4 作品展へ出す。', created: '2026-05-03' })).data.path)
    assert.deepEqual(paths, ['Tasks/2026-05-03-6-4 作品展へ出す。.md', 'Tasks/2026-05-03-6-4 作品展へ出す。-2.md', 'Tasks/2026-05-03-6-4 作品展へ出す。-3.md'])
    // 作成日が違えば番号は付かない
    assert.equal((await post({ title: '6/4 作品展へ出す。', created: '2026-06-01' })).data.path, 'Tasks/2026-06-01-6-4 作品展へ出す。.md')
    // 長い名前でも、番号を付けて 255 バイトに収める
    const long = 'あ'.repeat(120)
    const first = (await post({ title: long, created: '2026-05-03' })).data.path
    const second = (await post({ title: long, created: '2026-05-03' })).data.path
    assert.ok(second.endsWith('-2.md'))
    for (const rel of [first, second]) {
      assert.ok(Buffer.byteLength(rel.split('/').at(-1)) <= 255)
      assert.ok(fs.existsSync(path.join(dir, rel)))
    }
  })
})

test('POST /api/tasks：大文字小文字だけ違う Tasks のフォルダーがあれば、その名前を使う', async () => {
  await withApp((dir) => fs.mkdirSync(path.join(dir, 'tasks')), async ({ dir, post }) => {
    const { status, data } = await post({ title: '小文字', created: '2026-05-03' })
    assert.equal(status, 201)
    assert.equal(data.path, 'tasks/2026-05-03-小文字.md')
    assert.deepEqual(fs.readdirSync(dir), ['tasks'])
  })
})

test('POST /api/tasks：Tasks がファイルのときは、名前の重なりと分けて tasks-folder を返す', async () => {
  await withApp((dir) => fs.writeFileSync(path.join(dir, 'Tasks'), 'x'), async ({ dir, post }) => {
    const { status, data } = await post({ title: 'ファイル', created: '2026-05-03' })
    assert.equal(status, 400)
    assert.deepEqual(data, { error: 'tasks-folder' })
    assert.equal(fs.readFileSync(path.join(dir, 'Tasks'), 'utf8'), 'x')
  })
  // Vault の外を指すシンボリックリンクも同じ知らせ
  const outside = makeRoot()
  await withApp((dir) => fs.symlinkSync(outside, path.join(dir, 'Tasks')), async ({ post }) => {
    assert.deepEqual((await post({ title: '外へ', created: '2026-05-03' })).data, { error: 'tasks-folder' })
  })
  // 名前の重なりは今までどおり番号を付けて作る
  await withApp((dir) => {
    fs.mkdirSync(path.join(dir, 'Tasks'))
    fs.writeFileSync(path.join(dir, 'Tasks', '2026-05-03-重なり.md'), 'x')
  }, async ({ post }) => {
    const { status, data } = await post({ title: '重なり', created: '2026-05-03' })
    assert.equal(status, 201)
    assert.equal(data.path, 'Tasks/2026-05-03-重なり-2.md')
  })
})

test('POST /api/tasks：Vault の外へ逃げない', async () => {
  const outside = makeRoot()
  await withApp((dir) => fs.symlinkSync(outside, path.join(dir, 'Tasks')), async ({ dir, post }) => {
    const { status } = await post({ title: '外へ', created: '2026-05-03' })
    assert.equal(status, 400)
    assert.deepEqual(fs.readdirSync(outside), [])
    assert.deepEqual(fs.readdirSync(dir), ['Tasks'])
  })
  await withApp(null, async ({ dir, post }) => {
    const { status, data } = await post({ title: '../../../etc/passwd', created: '2026-05-03' })
    assert.equal(status, 201)
    assert.equal(data.path, 'Tasks/2026-05-03-etc-passwd.md')
    assert.ok(fs.existsSync(path.join(dir, data.path)))
    // 作成日はパスの一部になるので、日付でなければ断る
    assert.equal((await post({ title: 'x', created: '../../x' })).status, 400)
    assert.equal((await post({ title: 'x', created: '2026-02-30' })).status, 400)
    assert.equal((await post({ title: 'x' })).status, 400)
  })
})

test('POST /api/tasks：受け取る中身を確かめる', async () => {
  await withApp(null, async ({ dir, post }) => {
    const bad = [
      { ...sample, title: '' },
      { ...sample, title: '   ' },
      { ...sample, title: 3 },
      { ...sample, title: 'a\ntype: memo' },
      { ...sample, status: 'done' },
      { ...sample, due: '2026-5-1' },
      { ...sample, start: 'あした' },
      { ...sample, goal: '[[a]]\nx: 1' },
      { ...sample, goal: '[[a]] [[b]]' },
      { ...sample, parent: 5 },
      [],
    ]
    for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body))
    assert.equal((await post('{')).status, 400)
    assert.equal(fs.existsSync(path.join(dir, 'Tasks')), false)
    // 引用符やバックスラッシュ、タブを含む題名、ステータス・開始日・親
    const { status, data } = await post({ title: 'He said "hi":\tok \\ x', created: '2026-05-03', status: '進行中', start: '2026-05-04', due: '', parent: '[[Tasks/2026-05-01-親]]', goal: '90_Periodic/2026/Monthly/2026-05' })
    assert.equal(status, 201)
    const props = readTaskProps(fs.readFileSync(path.join(dir, data.path), 'utf8'))
    assert.deepEqual(props, { title: 'He said "hi": ok \\ x', status: '進行中', start: '2026-05-04', due: '', goal: '[[90_Periodic/2026/Monthly/2026-05]]', parent: '[[Tasks/2026-05-01-親]]' })
    assert.equal(data.path, 'Tasks/2026-05-03-He said hi- ok x.md')
  })
})

test('POST /api/tasks：本文（移した子の行）があれば、プロパティのあとにそのまま書く', async () => {
  await withApp(null, async ({ dir, url, post }) => {
    const body = '- [ ] 下書き\n\t- [x] 構図 [[90_Periodic/2026/Monthly/same]]\n\n> 引用\n'
    const { status, data } = await post({ ...sample, title: '本文つき', body })
    assert.equal(status, 201)
    const text = fs.readFileSync(path.join(dir, data.path), 'utf8')
    assert.equal(text, '---\ntitle: "本文つき"\ntype: task\nstatus: 未着手\nstart:\ndue: 2026-05-10\ngoal: "[[90_Periodic/2026/Monthly/2026-05]]"\n---\n' + body)
    // 末尾に改行がなければ1つ足す
    const bare = await post({ ...sample, title: '改行なし', body: '- a\n  - b' })
    assert.ok(fs.readFileSync(path.join(dir, bare.data.path), 'utf8').endsWith('---\n- a\n  - b\n'))
    // 本文が空・null なら、今までと同じ（プロパティだけ）
    for (const empty of ['', null]) {
      const plain = await post({ ...sample, title: '本文なし', body: empty })
      assert.equal(plain.status, 201)
      assert.ok(fs.readFileSync(path.join(dir, plain.data.path), 'utf8').endsWith('goal: "[[90_Periodic/2026/Monthly/2026-05]]"\n---\n'))
    }
    // 一覧には本文つきのノートも出る
    const tasks = await (await fetch(url + '/api/tasks')).json()
    assert.ok(tasks.tasks.some((t) => t.title === '本文つき'))
  })
})

test('POST /api/tasks：本文が文字でない・CR か NUL を含む・長すぎるときは断り、ノートを作らない', async () => {
  await withApp(null, async ({ dir, post }) => {
    const bad = [5, ['- a'], { a: 1 }, true, '- a\r\n- b', '- a\r', 'a\x00b', 'a'.repeat(1000001)]
    for (const body of bad) {
      const result = await post({ ...sample, body })
      assert.equal(result.status, 400, JSON.stringify(body).slice(0, 40))
      assert.deepEqual(result.data, { error: 'body' })
    }
    assert.equal(fs.existsSync(path.join(dir, 'Tasks')), false)
    // ちょうど上限の長さは作れる
    assert.equal((await post({ ...sample, body: 'a'.repeat(1000000) })).status, 201)
  })
})

test('GET /api/tasks：閉じの --- の行末に空白があるタスクのノートも一覧に出る', async () => {
  await withApp((dir) => {
    fs.mkdirSync(path.join(dir, 'Tasks'))
    fs.writeFileSync(path.join(dir, 'Tasks', '2026-05-01-親.md'), '---\ntitle: "親"\ntype: task\nstatus: 未着手\ndue: 2026-06-04\n--- \n- [ ] 下の行\n')
    fs.writeFileSync(path.join(dir, 'Tasks', '2026-05-02-子.md'), '--- \ntitle: "子"\ntype: task\nstatus: 進行中\nparent: "[[Tasks/2026-05-01-親]]"\n---\t\n')
  }, async ({ url }) => {
    const data = await (await fetch(url + '/api/tasks')).json()
    assert.deepEqual(data.tasks.map((t) => [t.title, t.status, t.due, t.parentTitle]), [['親', '未着手', '2026-06-04', ''], ['子', '進行中', '', '親']])
  })
})

// ---- リンクが外れたか（段階1-E2）とキャッシュ ----

test('GET /api/tasks の unlinked：goal のノートのリンクを消して保存すると外れた、戻すと外れていない。読み直しは変わったものだけ', async () => {
  const r = makeRoot()
  const MONTH = '90_Periodic/2026/Monthly/2026-11.md'
  put(r, MONTH, '- 目標 [[Tasks/a|→タスク]]\n')
  put(r, 'Tasks/a.md', task({ title: 'A', type: 'task', goal: '"[[90_Periodic/2026/Monthly/2026-11]]"' }))
  put(r, 'Tasks/free.md', task({ title: 'F', type: 'task' }))
  let scans = 0
  const index = createTaskIndex(r, { notes: () => { scans++; return { known: ['Tasks/a.md', 'Tasks/free.md', MONTH], truncated: false } } })
  const flags = () => Object.fromEntries(index.list().tasks.map((t) => [t.title, t.unlinked]))
  assert.deepEqual(flags(), { A: false, F: false })
  assert.equal(index.sourceReads(), 1)
  const reads = index.reads()
  // 変わっていなければ、タスクのノートも goal のノートも読み直さない（答えは毎回決め直す）
  assert.deepEqual(flags(), { A: false, F: false })
  assert.equal(index.reads(), reads)
  assert.equal(index.sourceReads(), 1)
  // リンクを手で消す（大きさが変わる）
  put(r, MONTH, '- 目標\n')
  assert.deepEqual(flags(), { A: true, F: false })
  assert.equal(index.sourceReads(), 2)
  assert.equal(index.reads(), reads)
  // 別のタスクのノートへリンクの行を移す
  put(r, 'Tasks/free.md', task({ title: 'F', type: 'task' }, '- [ ] A [[Tasks/a|→タスク]]\n'))
  assert.deepEqual(flags(), { A: false, F: false })
  assert.equal(index.reads(), reads + 1)
  // goal のノートが消えた
  put(r, 'Tasks/free.md', task({ title: 'F', type: 'task' }))
  fs.rmSync(path.join(r, MONTH))
  const gone = createTaskIndex(r, { notes: () => ({ known: ['Tasks/a.md', 'Tasks/free.md'], truncated: false }) })
  assert.equal(gone.list().tasks.find((t) => t.title === 'A').unlinked, true)
  // Vault の一覧が途中までなら、見つからないことを理由にしない
  const partial = createTaskIndex(r, { notes: () => ({ known: ['Tasks/a.md'], truncated: true }) })
  assert.equal(partial.list().tasks.find((t) => t.title === 'A').unlinked, false)
  // notes を渡さなければ判定しない
  assert.equal(createTaskIndex(r).list().tasks.every((t) => t.unlinked === false), true)
  assert.ok(scans >= 1)
})

test('GET /api/tasks の unlinked：サーバー全体で、リンクを消すと外れたに変わる', async () => {
  const r = makeRoot()
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-state-'))
  put(r, '90_Periodic/2026/Monthly/2026-11.md', '- 目標 [[Tasks/a|→タスク]]\n')
  put(r, 'Tasks/a.md', task({ title: 'A', type: 'task', goal: '"[[90_Periodic/2026/Monthly/2026-11]]"' }))
  const app = createApp({ root: r, port: 0, backupDir: st, stateDir: st, vaultDir: path.join(st, 'vault'), noToken: true })
  const srv = await app.listen(0)
  const url = `http://127.0.0.1:${srv.address().port}`
  try {
    const first = await (await fetch(`${url}/api/tasks`)).json()
    assert.equal(first.tasks[0].unlinked, false)
    const note = await (await fetch(`${url}/api/note?path=${encodeURIComponent('90_Periodic/2026/Monthly/2026-11.md')}`)).json()
    const put2 = await fetch(`${url}/api/note?path=${encodeURIComponent('90_Periodic/2026/Monthly/2026-11.md')}`, { method: 'PUT', headers: { 'x-note-editor': '1', 'content-type': 'application/json' }, body: JSON.stringify({ text: '- 目標\n', baseHash: note.hash }) })
    assert.equal(put2.status, 200)
    const second = await (await fetch(`${url}/api/tasks`)).json()
    assert.equal(second.tasks[0].unlinked, true)
  } finally {
    await new Promise((done) => {
      srv.closeAllConnections()
      srv.close(done)
    })
  }
})

// ---- E2 のレビューの指摘（中1・小2・小10） ----

test('GET /api/tasks の unlinked：外から作ったノート（Vault の一覧の控えにまだない）でも、すぐ正しく決める', async () => {
  const r = makeRoot()
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-state-'))
  const M = '90_Periodic/2026/Monthly/2026-11.md'
  const G = '"[[90_Periodic/2026/Monthly/2026-11]]"'
  put(r, M, '- 目標 [[Tasks/a|→タスク]]\n')
  put(r, 'Tasks/a.md', task({ title: 'A', type: 'task', goal: G }))
  const app = createApp({ root: r, port: 0, backupDir: st, stateDir: st, vaultDir: path.join(st, 'vault'), noToken: true })
  const srv = await app.listen(0)
  const url = `http://127.0.0.1:${srv.address().port}`
  const flags = async () => Object.fromEntries((await (await fetch(`${url}/api/tasks`)).json()).tasks.map((t) => [t.title, t.unlinked]))
  try {
    // 1回読んで、Vault の一覧を控えさせる（10秒覚える）
    assert.deepEqual(await flags(), { A: false })
    // 新しい月のノートと、それを goal にしたタスク
    put(r, '90_Periodic/2026/Monthly/2026-12.md', '- 12月 [[Tasks/b|→タスク]]\n')
    put(r, 'Tasks/b.md', task({ title: 'B', type: 'task', goal: '"[[90_Periodic/2026/Monthly/2026-12]]"' }))
    // 今の月のノートに、名前だけのリンクで足したタスク
    put(r, M, '- 目標 [[Tasks/a|→タスク]]\n- 追加 [[c]]\n')
    put(r, 'Tasks/c.md', task({ title: 'C', type: 'task', goal: G }))
    // 新しい親のタスクと子（親の本文のリンクは名前だけ）
    put(r, 'Tasks/p2.md', task({ title: 'P2', type: 'task' }, '- [ ] 子 [[d|→タスク]]\n'))
    put(r, 'Tasks/d.md', task({ title: 'D', type: 'task', parent: '"[[Tasks/p2]]"' }))
    // 新しい親で、親にリンクがない子は外れた
    put(r, 'Tasks/p3.md', task({ title: 'P3', type: 'task' }, '本文にリンクなし\n'))
    put(r, 'Tasks/e.md', task({ title: 'E', type: 'task', parent: '"[[Tasks/p3]]"' }))
    // goal のノートがどこにもないタスクも外れた
    put(r, 'Tasks/f.md', task({ title: 'F', type: 'task', goal: '"[[90_Periodic/2026/Monthly/2027-01]]"' }))
    assert.deepEqual(await flags(), { A: false, B: false, C: false, D: false, E: true, F: true, P2: false, P3: false })
  } finally {
    await new Promise((done) => {
      srv.closeAllConnections()
      srv.close(done)
    })
  }
})

test('unlinked：Vault の一覧が途中まで（truncated）なら、名前だけのリンクのタスクも外れたとしない', () => {
  const r = makeRoot()
  const M = '90_Periodic/2026/Monthly/2026-11.md'
  put(r, M, '- 目標 [[y]]\n')
  put(r, 'Tasks/y.md', task({ title: 'Y', type: 'task', goal: '"[[90_Periodic/2026/Monthly/2026-11]]"' }))
  put(r, 'Tasks/z.md', task({ title: 'Z', type: 'task', goal: '"[[90_Periodic/2026/Monthly/2026-11]]"' }))
  const index = createTaskIndex(r, { notes: () => ({ known: [M], truncated: true }) })
  assert.deepEqual(Object.fromEntries(index.list().tasks.map((t) => [t.title, t.unlinked])), { Y: false, Z: false })
})

test('unlinked：goal のノートを一時的に読めなかったことは覚えない（直ったら、ファイルが変わらなくても決め直す）', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const r = makeRoot()
  const M = '90_Periodic/2026/Monthly/2026-11.md'
  const full = put(r, M, '- 目標\n')
  put(r, 'Tasks/a.md', task({ title: 'A', type: 'task', goal: '"[[90_Periodic/2026/Monthly/2026-11]]"' }))
  const index = createTaskIndex(r, { notes: () => ({ known: [M, 'Tasks/a.md'], truncated: false }) })
  fs.chmodSync(full, 0o000)
  try {
    // 読めない間は、外れたとしない
    assert.equal(index.list().tasks[0].unlinked, false)
  } finally {
    fs.chmodSync(full, 0o644)
  }
  // 権限を戻しただけ（中身・大きさ・更新日時は同じ）でも、読み直して外れたと決める
  assert.equal(index.list().tasks[0].unlinked, true)
})
