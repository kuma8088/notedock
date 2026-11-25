import assert from 'node:assert/strict'
import test from 'node:test'

import { MSG } from '../src/pane.mjs'
import { SPLIT_LEFT_MIN, SPLIT_RIGHT_MIN, clampSplit, createSplit, savedResult } from '../src/split.mjs'

test('境目は、右を420px、左を320pxより狭くしない', () => {
  assert.equal(SPLIT_LEFT_MIN, 320)
  assert.equal(SPLIT_RIGHT_MIN, 420)
  assert.equal(clampSplit(1000, 500), 0.5)
  assert.equal(clampSplit(1000, 100), 0.32)
  assert.equal(clampSplit(1000, 900), 0.58)
  assert.equal(clampSplit(1000, 600), 0.58)
  assert.equal(clampSplit(1000, 560), 0.56)
})

test('両方を満たせない幅のときは半分ずつ', () => {
  assert.equal(clampSplit(739, 300), 0.5)
  assert.equal(clampSplit(0, 0), 0.5)
  assert.equal(clampSplit(Number.NaN, 300), 0.5)
  assert.equal(clampSplit(740, 0), 320 / 740)
  assert.equal(clampSplit(740, 740), 320 / 740)
})

test('右の枠の SAVED は、dirty: false のときだけ保存しきれたとみなす', () => {
  assert.deepEqual(savedResult({ type: 'pane:saved', dirty: false }), { dirty: false })
  assert.deepEqual(savedResult({ type: 'pane:saved', dirty: true }), { dirty: true })
  assert.deepEqual(savedResult({ type: 'pane:saved' }), { dirty: true })
  assert.deepEqual(savedResult(null), { dirty: true })
})

// ---- E2 の再レビュー（split.mjs の SAVE と SAVED）：保存の頼みごとに id を付け、遅れて来た前の返事で次の待ちを解かない ----

// createSplit が触る DOM だけの偽物（右の枠の iframe に送った連絡を sent に、受け取る連絡は deliver で渡す）。
function fakeSplit() {
  const sent = []
  const listeners = []
  const el = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    style: { setProperty() {}, removeProperty() {} },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ width: 500, left: 0 }),
    after() {},
    remove() {},
    contentWindow: { postMessage: (message) => sent.push(message) },
  })
  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location, ResizeObserver: globalThis.ResizeObserver }
  let frame = null
  globalThis.window = { addEventListener: (type, fn) => type === 'message' && listeners.push(fn), removeEventListener() {} }
  globalThis.document = { body: el(), createElement: (tag) => (tag === 'iframe' ? (frame = el()) : el()) }
  globalThis.location = { origin: 'http://127.0.0.1:1' }
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  const restore = () => Object.assign(globalThis, saved)
  const deliver = (data) => listeners.forEach((fn) => fn({ origin: 'http://127.0.0.1:1', source: frame.contentWindow, data }))
  return { sent, deliver, restore, el }
}

test('右の枠の保存：返事は同じ id の頼みごとだけを解く。切れたあとに遅れて来た前の返事・id のない返事では解けない', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fake = fakeSplit()
  try {
    const split = createSplit({ layout: fake.el(), editor: fake.el(), onMessage() {}, onActiveChange() {} })
    split.open()
    fake.deliver({ type: MSG.READY })
    const first = split.save()
    const firstId = fake.sent.at(-1).id
    assert.equal(fake.sent.at(-1).type, MSG.SAVE)
    assert.equal(typeof firstId, 'string')
    // 5秒たっても返事がないので、保存できたとは言えない
    t.mock.timers.tick(5000)
    assert.deepEqual(await first, { dirty: true })
    let done = null
    split.save().then((result) => (done = result))
    const secondId = fake.sent.at(-1).id
    assert.notEqual(secondId, firstId)
    // 前の頼みごとへの遅れた返事（保存できた）と、id のない返事では、2つ目の待ちを解かない
    fake.deliver({ type: MSG.SAVED, id: firstId, dirty: false })
    fake.deliver({ type: MSG.SAVED, dirty: false })
    await Promise.resolve()
    assert.equal(done, null)
    // 同じ id の返事で解ける
    fake.deliver({ type: MSG.SAVED, id: secondId, dirty: true })
    await Promise.resolve()
    assert.deepEqual(done, { dirty: true })
  } finally {
    fake.restore()
  }
})
