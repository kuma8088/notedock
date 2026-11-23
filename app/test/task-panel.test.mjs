import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

import { createTaskPanel } from '../src/task-panel.mjs'

// task-panel.mjs が使う分だけの、小さな DOM のまね。
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.className = ''
    this.hidden = false
    this.dataset = {}
    this.attributes = {}
    this.listeners = {}
    this.text = ''
    this.focused = false
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join('')
  }
  set textContent(value) {
    this.text = String(value)
    this.children = []
  }
  get childNodes() {
    return this.children
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean)
    return {
      contains: (name) => names().includes(name),
      toggle: (name, on) => {
        const set = new Set(names())
        if (on ?? !set.has(name)) set.add(name)
        else set.delete(name)
        this.className = [...set].join(' ')
      },
    }
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }
  getAttribute(name) {
    return this.attributes[name] ?? null
  }
  append(...nodes) {
    this.children.push(...nodes)
  }
  replaceChildren(...nodes) {
    this.text = ''
    this.children = [...nodes]
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  click(extra = {}) {
    for (const fn of this.listeners.click ?? []) fn({ metaKey: false, ctrlKey: false, ...extra })
  }
  focus() {
    this.focused = true
  }
  *walk() {
    for (const child of this.children) {
      yield child
      yield* child.walk()
    }
  }
  matches(selector) {
    const data = selector.match(/^\[data-key="([^"]+)"\]$/)
    if (data) return this.dataset.key === data[1]
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    return false
  }
  querySelector(selector) {
    for (const node of this.walk()) if (node.matches(selector)) return node
    return null
  }
  querySelectorAll(selector) {
    return [...this.walk()].filter((node) => node.matches(selector))
  }
}

globalThis.document = { createElement: (tag) => new FakeElement(tag) }

function memoryStore() {
  const data = new Map()
  return {
    data,
    get: (key, fallback = null) => (data.has(key) ? JSON.parse(data.get(key)) : fallback),
    set: (key, value) => data.set(key, JSON.stringify(value)),
  }
}

const task = (title, props = {}) => ({ path: `Tasks/${title}.md`, title, status: '未着手', start: '', due: '', parentTitle: '', parentPath: null, ...props })
const TASKS = [task('明日', { due: '2026-11-25' }), task('いつか')]

let box
let store
let opened
let panel
beforeEach(() => {
  box = new FakeElement('section')
  box.hidden = true
  store = memoryStore()
  opened = []
  panel = createTaskPanel({ box, store, keyOf: (name) => `${name}:v`, onOpen: (path) => opened.push(path) })
})

const head = (key) => box.querySelector(`[data-key="${key}"]`)

test('始めは直近だけ開き、ほかは件数だけ', () => {
  panel.show({ tasks: TASKS, date: '2026-11-24' })
  assert.equal(box.hidden, false)
  assert.equal(head('soon').getAttribute('aria-expanded'), 'true')
  assert.equal(head('week').getAttribute('aria-expanded'), 'false')
  assert.equal(head('none').getAttribute('aria-expanded'), 'false')
  assert.equal(box.querySelectorAll('.task-item').length, 1)
  assert.match(head('none').textContent, /期日なし1/)
})

test('中見出しとパネル全体の開閉を覚え、作り直しても残る', () => {
  panel.show({ tasks: TASKS, date: '2026-11-24' })
  head('none').click()
  assert.deepEqual(store.get('task-sections:v'), { soon: true, week: false, month: false, none: true, done: false })
  assert.equal(head('none').focused, true)
  const box2 = new FakeElement('section')
  const panel2 = createTaskPanel({ box: box2, store, keyOf: (name) => `${name}:v`, onOpen: () => {} })
  panel2.show({ tasks: TASKS, date: '2026-11-24' })
  assert.equal(box2.querySelector('[data-key="none"]').getAttribute('aria-expanded'), 'true')
  // パネル全体をたたむと、件数の1行だけになる。
  head('panel').click()
  assert.equal(store.get('task-panel-open:v'), false)
  assert.equal(head('soon'), null)
  assert.match(box.querySelector('.task-panel-summary').textContent, /直近 1・今週 1・今月 1・期日なし 1/)
})

test('タスクの名前を押すと、そのノートを開く', () => {
  panel.show({ tasks: TASKS, date: '2026-11-24' })
  box.querySelector('.task-open').click()
  assert.deepEqual(opened, ['Tasks/明日.md'])
})

test('タスクのノートが1件もないときは隠す', async () => {
  panel.show({ tasks: TASKS, date: '2026-11-24' })
  panel.show({ tasks: [], date: '2026-11-24' })
  assert.equal(box.hidden, true)
  assert.equal(await panel.refresh({ date: '2026-11-24', load: async () => ({ tasks: [] }) }), 'shown')
  assert.equal(box.hidden, true)
})

test('デイリーノートでなければ隠す', async () => {
  panel.show({ tasks: TASKS, date: '2026-11-24' })
  assert.equal(await panel.refresh({ date: null, load: async () => ({ tasks: TASKS }) }), 'hidden')
  assert.equal(box.hidden, true)
})

test('古い返事は捨てる（あとから頼んだものを描く）', async () => {
  let releaseOld
  const old = panel.refresh({ date: '2026-11-02', load: () => new Promise((resolve) => (releaseOld = () => resolve({ tasks: [task('古い')] }))) })
  const fresh = await panel.refresh({ date: '2026-11-24', load: async () => ({ tasks: TASKS }) })
  releaseOld()
  assert.equal(fresh, 'shown')
  assert.equal(await old, 'stale')
  assert.equal(panel.last().date, '2026-11-24')
  assert.ok(box.querySelectorAll('.task-open').every((b) => b.textContent !== '古い'))
})

test('返事が来たときに別のノートへ移っていたら描かない', async () => {
  assert.equal(await panel.refresh({ date: '2026-11-24', load: async () => ({ tasks: TASKS }), isCurrent: () => false }), 'stale')
  assert.equal(box.hidden, true)
})

test('隠したあとに届いた返事でも出さない', async () => {
  let release
  const pending = panel.refresh({ date: '2026-11-24', load: () => new Promise((resolve) => (release = () => resolve({ tasks: TASKS }))) })
  panel.hide()
  release()
  assert.equal(await pending, 'stale')
  assert.equal(box.hidden, true)
})

test('別のデイリーノートへ移ったら、返事を待たずに手元の一覧で数え直す', async () => {
  panel.show({ tasks: TASKS, date: '2026-11-24' })
  let release
  const pending = panel.refresh({ date: '2026-11-02', load: () => new Promise((resolve) => (release = () => resolve({ tasks: TASKS }))) })
  assert.equal(panel.last().date, '2026-11-02')
  assert.match(box.querySelector('.task-panel-date').textContent, /11\/2/)
  release()
  assert.equal(await pending, 'shown')
})

test('一覧が途中までのときは、頭に一言出す', () => {
  panel.show({ tasks: TASKS, date: '2026-11-24', truncated: true })
  assert.ok(box.querySelector('.task-panel-note'))
  panel.show({ tasks: TASKS, date: '2026-11-24' })
  assert.equal(box.querySelector('.task-panel-note'), null)
})

test('読み込みに失敗したら今の見た目のまま', async () => {
  panel.show({ tasks: TASKS, date: '2026-11-24' })
  assert.equal(await panel.refresh({ date: '2026-11-24', load: async () => { throw new Error('x') } }), 'failed')
  assert.equal(box.hidden, false)
})
