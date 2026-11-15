import assert from 'node:assert/strict'
import test from 'node:test'

import { createConnectionWatch, createVersionWatch } from '../src/connection.mjs'

const settle = () => new Promise((resolve) => setImmediate(resolve))

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const calls = { answers: [], checks: 0, changes: [] }
  const watch = createConnectionWatch({
    check: async () => {
      calls.checks += 1
      return calls.answers.length ? calls.answers.shift() : calls.fallback
    },
    onChange: (state) => calls.changes.push(state),
  })
  const tick = async (ms) => {
    t.mock.timers.tick(ms)
    await settle()
  }
  return { calls, watch, tick }
}

test('downが1回だけでは何も知らせない', async (t) => {
  const { calls, watch, tick } = setup(t)
  calls.fallback = 'up'
  calls.answers.push('down')
  watch.start()
  await tick(5000)
  await tick(5000)
  assert.deepEqual(calls.changes, [])
  watch.stop()
})

test('downが2回続くとoffline、30秒続くとgone、upでonlineを知らせる', async (t) => {
  const { calls, watch, tick } = setup(t)
  calls.fallback = 'down'
  watch.start()
  await tick(5000)
  assert.deepEqual(calls.changes, [])
  await tick(5000)
  assert.deepEqual(calls.changes, ['offline'])
  for (let i = 0; i < 3; i += 1) await tick(5000)
  assert.deepEqual(calls.changes, ['offline'])
  await tick(5000)
  assert.deepEqual(calls.changes, ['offline', 'gone'])
  calls.fallback = 'up'
  await tick(5000)
  assert.deepEqual(calls.changes, ['offline', 'gone', 'online'])
  watch.stop()
})

test('同じ状態を続けて2回は知らせない', async (t) => {
  const { calls, watch, tick } = setup(t)
  calls.fallback = 'down'
  watch.start()
  await tick(10000)
  await tick(5000)
  await tick(5000)
  assert.deepEqual(calls.changes, ['offline'])
  calls.fallback = 'up'
  await tick(5000)
  await tick(5000)
  assert.deepEqual(calls.changes, ['offline', 'online'])
  watch.stop()
})

test('pokeはすぐに1回確かめ、stopのあとは確かめない', async (t) => {
  const { calls, watch, tick } = setup(t)
  calls.fallback = 'down'
  watch.start()
  watch.poke()
  await settle()
  assert.equal(calls.checks, 1)
  watch.poke()
  await settle()
  assert.deepEqual(calls.changes, ['offline'])
  watch.stop()
  const before = calls.checks
  await tick(60000)
  assert.equal(calls.checks, before)
})

test('skipは状態も回数も変えず、goneの時計にも影響しない', async (t) => {
  const { calls, watch, tick } = setup(t)
  calls.answers.push('down', 'down')
  calls.fallback = 'skip'
  watch.start()
  await tick(5000)
  await tick(5000)
  assert.deepEqual(calls.changes, ['offline'])
  for (let i = 0; i < 6; i += 1) await tick(5000)
  assert.deepEqual(calls.changes, ['offline'])
  calls.fallback = 'down'
  await tick(5000)
  assert.deepEqual(calls.changes, ['offline', 'gone'])
  assert.equal(watch.state(), 'gone')
  watch.stop()
})

test('skipのあとの1回目のdownではofflineにならない', async (t) => {
  const { calls, watch, tick } = setup(t)
  calls.answers.push('down', 'skip', 'skip')
  calls.fallback = 'down'
  watch.start()
  await tick(5000)
  await tick(5000)
  await tick(5000)
  assert.deepEqual(calls.changes, [])
  await tick(5000)
  assert.deepEqual(calls.changes, ['offline'])
  watch.stop()
})

test('goneにも2回続けてのdownが要る', async (t) => {
  const { calls, watch, tick } = setup(t)
  calls.answers.push('skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'down')
  calls.fallback = 'down'
  watch.start()
  for (let i = 0; i < 7; i += 1) await tick(5000)
  assert.deepEqual(calls.changes, [])
  await tick(5000)
  assert.deepEqual(calls.changes, ['gone'])
  watch.stop()
})

test('確かめている最中のpokeは重ねて確かめない', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let checks = 0
  let release
  const watch = createConnectionWatch({
    check: () => {
      checks += 1
      return new Promise((resolve) => { release = resolve })
    },
    onChange: () => {},
  })
  watch.start()
  watch.poke()
  watch.poke()
  assert.equal(checks, 1)
  release('up')
  await settle()
  watch.poke()
  assert.equal(checks, 2)
  watch.stop()
})

test('onChangeが例外を投げても見張りは続く', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const changes = []
  let answer = 'down'
  const watch = createConnectionWatch({
    check: async () => answer,
    onChange: (state) => {
      changes.push(state)
      throw new Error('boom')
    },
  })
  watch.start()
  t.mock.timers.tick(5000)
  await settle()
  t.mock.timers.tick(5000)
  await settle()
  assert.deepEqual(changes, ['offline'])
  answer = 'up'
  t.mock.timers.tick(5000)
  await settle()
  assert.deepEqual(changes, ['offline', 'online'])
  watch.stop()
})

test('エディターの画面は、つながり直したときにサーバーのバージョンが変わっていたら、下書きの保存が成功してから読み込み直す。保存がぶつかったら読み込み直さない', async () => {
  const log = []
  let finishSave
  let answer = 'saved'
  const watch = createVersionWatch({
    loaded: '0.1.0',
    save: () => {
      log.push('save')
      return new Promise((resolve) => { finishSave = () => resolve(answer) })
    },
    reload: () => log.push('reload'),
    notify: () => log.push('notify'),
  })
  // 同じバージョン、または見出しがない応答では、何もしない。
  assert.equal(await watch.seen('0.1.0'), 'same')
  assert.equal(await watch.seen(null), 'same')
  assert.deepEqual(log, [])

  // 変わった：まず保存し、保存が終わるまでは読み込み直さない。
  const first = watch.seen('0.2.0')
  await settle()
  assert.deepEqual(log, ['save'])
  // 保存の最中に次の確かめが来ても、重ねて保存しない。
  assert.equal(await watch.seen('0.2.0'), 'busy')
  assert.deepEqual(log, ['save'])
  finishSave()
  assert.equal(await first, 'reloaded')
  assert.deepEqual(log, ['save', 'reload'])
  // 読み込み直したあとは、もう何もしない。
  assert.equal(await watch.seen('0.2.0'), 'same')
  assert.deepEqual(log, ['save', 'reload'])

  // 保存がぶつかったら、読み込み直さず、お知らせを1回だけ出す。
  log.length = 0
  answer = 'conflict'
  const other = createVersionWatch({
    loaded: '0.1.0',
    save: async () => { log.push('save'); return answer },
    reload: () => log.push('reload'),
    notify: () => log.push('notify'),
  })
  assert.equal(await other.seen('0.2.0'), 'conflict')
  assert.equal(await other.seen('0.2.0'), 'conflict')
  assert.deepEqual(log, ['save', 'notify', 'save'])
  // まだ保存できない（つながらない、など）ときも、読み込み直さない。次の確かめでやり直す。
  answer = 'failed'
  assert.equal(await other.seen('0.2.0'), 'failed')
  assert.ok(!log.includes('reload'))
  // ぶつかりを選び終えて保存できたら、読み込み直す。
  answer = 'saved'
  assert.equal(await other.seen('0.2.0'), 'reloaded')
  assert.equal(log.at(-1), 'reload')

  // 保存の処理が例外を投げても、読み込み直さない。
  const broken = createVersionWatch({ loaded: '0.1.0', save: async () => { throw new Error('boom') }, reload: () => log.push('reload!'), notify: () => {} })
  assert.equal(await broken.seen('0.2.0'), 'failed')
  assert.ok(!log.includes('reload!'))
  // 画面を読み込んだときのサーバーに見出しがなく（古い開発用）、今は付いているなら、変わったとみなす。
  const legacy = createVersionWatch({ loaded: null, save: async () => 'saved', reload: () => log.push('reload-legacy'), notify: () => {} })
  assert.equal(await legacy.seen('0.2.0'), 'reloaded')
})
