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
    this.value = ''
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
    document.activeElement = this
  }
  fire(type) {
    for (const fn of this.listeners[type] ?? []) fn({})
  }
  contains(node) {
    return node === this || [...this.walk()].includes(node)
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

globalThis.document = { createElement: (tag) => new FakeElement(tag), activeElement: null }

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
  document.activeElement = null
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

// ---- 「直近」の日数の欄（段階1-F） ----

const SOON = [task('3日後', { due: '2026-11-27' }), task('5日後', { due: '2026-11-29' }), task('6日後', { due: '2026-11-30' })]
const soonNames = () => box.querySelector('.task-section-soon').querySelectorAll('.task-open').map((n) => n.textContent)
const field = () => head('soon-days')
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
// Enter で確定したときと同じ（欄にフォーカスがあるまま change が来る）。
const commit = (value) => {
  field().focus()
  field().value = value
  field().fire('change')
}

function panelWith(onSoonDays) {
  return createTaskPanel({ box, store, keyOf: (name) => `${name}:v`, onOpen: () => {}, onSoonDays })
}

test('日数は一覧に添えて届いた値で区分ける。ない・使えないときは3', () => {
  panel.show({ tasks: SOON, date: '2026-11-24' })
  assert.equal(field().value, '3')
  assert.deepEqual(soonNames(), ['3日後'])
  panel.show({ tasks: SOON, date: '2026-11-24', soonDays: 5 })
  assert.equal(field().value, '5')
  assert.deepEqual(soonNames(), ['3日後', '5日後'])
  // 値を持たない返事では、今の日数のまま。
  panel.show({ tasks: SOON, date: '2026-11-24' })
  assert.deepEqual(soonNames(), ['3日後', '5日後'])
  panel.show({ tasks: SOON, date: '2026-11-24', soonDays: 99 })
  assert.equal(field().value, '3')
  assert.deepEqual(soonNames(), ['3日後'])
})

test('欄の数を変えると、すぐ区分けし直し、保存を頼み、欄にフォーカスを戻す', async () => {
  const saved = []
  panel = panelWith(async (days) => saved.push(days) > 0)
  panel.show({ tasks: SOON, date: '2026-11-24' })
  commit('6')
  assert.deepEqual(soonNames(), ['3日後', '5日後', '6日後'])
  assert.equal(field().value, '6')
  assert.equal(field().focused, true)
  await tick()
  assert.deepEqual(saved, [6])
  assert.equal(panel.soonDays(), 6)
  assert.equal(box.querySelector('.task-soon-note'), null)
  // 同じ数のままなら頼まない。
  commit('6')
  await tick()
  assert.deepEqual(saved, [6])
})

test('保存できなければ元の日数に戻し、知らせを出す。パネルは消えない', async () => {
  for (const fail of [async () => false, async () => { throw new Error('net') }]) {
    box = new FakeElement('section')
    panel = panelWith(fail)
    panel.show({ tasks: SOON, date: '2026-11-24', soonDays: 3 })
    commit('5')
    assert.deepEqual(soonNames(), ['3日後', '5日後'])
    await tick()
    assert.equal(field().value, '3')
    assert.deepEqual(soonNames(), ['3日後'])
    assert.equal(box.querySelector('.task-soon-note').textContent, '日数を保存できませんでした。元の日数に戻しました')
    assert.equal(box.hidden, false)
  }
})

test('使えない数（範囲の外・小数・空）は頼まずに元に戻し、知らせを出す', async () => {
  const saved = []
  panel = panelWith(async (days) => saved.push(days) > 0)
  panel.show({ tasks: SOON, date: '2026-11-24', soonDays: 4 })
  for (const bad of ['32', '-1', '2.5', '', 'abc']) {
    commit(bad)
    assert.equal(field().value, '4', bad)
    assert.match(box.querySelector('.task-soon-note').textContent, /0から31までの数で入れてください/)
  }
  await tick()
  assert.deepEqual(saved, [])
  // 使える数に直すと、知らせは消える。
  commit('0')
  assert.equal(box.querySelector('.task-soon-note'), null)
  assert.deepEqual(soonNames(), [])
})

test('保存より前に頼んだ一覧の返事が遅れて来ても、変えた日数は戻らない', async () => {
  let finishSave
  panel = panelWith(() => new Promise((resolve) => { finishSave = resolve }))
  panel.show({ tasks: SOON, date: '2026-11-24', soonDays: 3 })
  let answer
  const pending = panel.refresh({ date: '2026-11-24', load: () => new Promise((resolve) => { answer = resolve }) })
  commit('6')
  answer({ tasks: SOON, soonDays: 3 })
  assert.equal(await pending, 'shown')
  assert.equal(field().value, '6')
  finishSave(true)
  await tick()
  // 保存を待つ間に頼んだ返事も、日数は使わない。保存のあとに頼んだ返事は使う。
  assert.equal(await panel.refresh({ date: '2026-11-24', load: async () => ({ tasks: SOON, soonDays: 6 }) }), 'shown')
  assert.deepEqual(soonNames(), ['3日後', '5日後', '6日後'])
  assert.equal(await panel.refresh({ date: '2026-11-24', load: async () => ({ tasks: SOON, soonDays: 2 }) }), 'shown')
  assert.equal(field().value, '2')
  // 確定したあとフォーカスが欄に残っていても、届いた日数を見せる（フォーカスはそのまま）。
  assert.equal(field().focused, true)
})

test('欄に打っている途中に読み直しが来ても、打った数とフォーカスは残る', async () => {
  panel = panelWith(async () => true)
  panel.show({ tasks: SOON, date: '2026-11-24', soonDays: 3 })
  field().focus()
  field().value = '1'
  assert.equal(await panel.refresh({ date: '2026-11-24', load: async () => ({ tasks: SOON, soonDays: 3 }) }), 'shown')
  assert.equal(field().value, '1')
  assert.equal(field().focused, true)
  assert.equal(document.activeElement, field())
})

test('パネルをたたんでも欄は出て、件数も日数で数える。欄は開閉のボタンの中にない', () => {
  panel.show({ tasks: SOON, date: '2026-11-24', soonDays: 6 })
  head('panel').click()
  assert.ok(field())
  assert.equal(head('panel').querySelector('[data-key="soon-days"]'), null)
  assert.match(box.querySelector('.task-panel-summary').textContent, /直近 3・/)
  // 別の日のデイリーノートへ移っても、日数は残る。
  panel.show({ ...panel.last(), date: '2026-11-25' })
  assert.equal(field().value, '6')
})

test('欄の外へ出て確定したとき（ほかを押した・Tab）は、フォーカスを欄に戻さず、移り終えてから描き直す', async () => {
  const saved = []
  panel = panelWith(async (days) => saved.push(days) > 0)
  panel.show({ tasks: SOON, date: '2026-11-24', soonDays: 3 })
  // 本文を押した：フォーカスはパネルの外へ。
  const outside = new FakeElement('div')
  field().value = '5'
  outside.focus()
  field().fire('change')
  await tick()
  assert.deepEqual(soonNames(), ['3日後', '5日後'])
  assert.equal(document.activeElement, outside)
  assert.equal(field().focused, false)
  assert.deepEqual(saved, [5])
  // Tab で中見出しへ移った：描き直したあとも、その中見出しにフォーカスを戻す。
  field().value = '6'
  head('week').focus()
  field().fire('change')
  await tick()
  assert.deepEqual(soonNames(), ['3日後', '5日後', '6日後'])
  assert.equal(document.activeElement, head('week'))
})

test('パネルの中でボタンを押している間は描き直さず、離したあとに描き直す（クリックが消えないように）', async () => {
  panel = panelWith(async () => true)
  panel.show({ tasks: SOON, date: '2026-11-24', soonDays: 3 })
  const weekHead = head('week')
  field().value = '6'
  box.fire('pointerdown')
  weekHead.focus()
  field().fire('change')
  await tick()
  // まだ押している：中見出しは入れ替わっていない。
  assert.equal(head('week'), weekHead)
  // 押したボタンのクリックで描き直す（新しい日数で区分ける）。
  weekHead.click()
  assert.equal(head('week').getAttribute('aria-expanded'), 'true')
  assert.deepEqual(soonNames(), ['3日後', '5日後', '6日後'])
})
