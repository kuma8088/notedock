import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeText, minimalChange } from '../src/merge.mjs'
import { createSaver, SAVE_DELAY_MS } from '../src/save.mjs'

test('別々の行の変更は両方残る', () => {
  const base = 'a\nb\nc\nd\ne\n'
  const mine = 'A\nb\nc\nd\ne\n'
  const theirs = 'a\nb\nc\nd\nE\n'
  assert.deepEqual(mergeText(base, mine, theirs), { conflict: false, text: 'A\nb\nc\nd\nE\n' })
})

test('隣の行の変更も両方残る', () => {
  assert.deepEqual(mergeText('a\nb\nc\n', 'A\nb\nc\n', 'a\nB\nc\n'), { conflict: false, text: 'A\nB\nc\n' })
  assert.deepEqual(mergeText('a\nb\n', 'x\na\nb\n', 'a\nb\ny\n'), { conflict: false, text: 'x\na\nb\ny\n' })
})

test('同じ場所への別々の追加は止める', () => {
  assert.equal(mergeText('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n').conflict, true)
  assert.equal(mergeText('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n').conflict, true)
})

test('末尾の改行の有無を保つ', () => {
  assert.equal(mergeText('a\nb', 'A\nb', 'a\nB').text, 'A\nB')
})

test('同じ行の変更は止める', () => {
  assert.equal(mergeText('a\nb\n', 'x\nb\n', 'y\nb\n').conflict, true)
})

test('同じ変更はぶつからない', () => {
  assert.deepEqual(mergeText('a\n', 'b\n', 'b\n'), { conflict: false, text: 'b\n' })
})

test('差し替えは変わった部分だけ', () => {
  assert.deepEqual(minimalChange('abcdef', 'abXdef'), { from: 2, to: 3, insert: 'X' })
  assert.equal(minimalChange('a', 'a'), null)
})

function harness(initial = 'one\n') {
  const timers = []
  const events = []
  const writes = []
  const backups = []
  const draftStore = new Map()
  const state = { text: initial, composing: false, fail: false, conflict: null, hash: 'h0' }
  const doc = {
    get: () => state.text,
    set: (text) => { state.text = text },
    composing: () => state.composing,
    // 実際の変換中だけ保存を待つ。表のマスの編集中は、確定した本文なら保存してよい。
    holdSave: () => (state.holdSave === undefined ? state.composing : state.holdSave),
  }
  const api = {
    write: async (path, text, hash) => {
      writes.push({ text, hash })
      if (state.failStatus) throw Object.assign(new Error('save failed'), { status: state.failStatus })
      if (state.fail) throw new Error('down')
      if (state.conflict) {
        const value = state.conflict
        state.conflict = null
        return { conflict: true, current: value.text, hash: value.hash }
      }
      return { conflict: false, hash: `h${writes.length}` }
    },
    backup: async (path, text) => { backups.push(text) },
  }
  const drafts = {
    set: (path, draft) => draftStore.set(path, draft),
    remove: (path) => draftStore.delete(path),
    get: (path) => draftStore.get(path),
  }
  const saver = createSaver({
    doc, api, path: 'a.md', baseText: initial, baseHash: 'h0', drafts,
    onStatus: (e) => events.push(e),
    schedule: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    cancel: (t) => {
      const i = timers.indexOf(t)
      if (i >= 0) timers.splice(i, 1)
    },
  })
  const tick = async () => {
    const t = timers.shift()
    if (t) t.fn()
    await new Promise((r) => setImmediate(r))
  }
  return { saver, state, timers, events, writes, backups, tick, draftStore, setWrite: (fn) => { api.write = fn } }
}

const lastState = (events) => events.at(-1)?.state

test('入力してから2秒で保存する', async () => {
  const h = harness()
  h.state.text = 'two\n'
  h.saver.changed()
  assert.equal(h.timers[0].ms, SAVE_DELAY_MS)
  assert.equal(SAVE_DELAY_MS, 2000)
  await h.tick()
  assert.deepEqual(h.writes, [{ text: 'two\n', hash: 'h0' }])
  assert.equal(lastState(h.events), 'saved')
  assert.equal(h.draftStore.size, 0)
})

test('保存の最中に届いた自分の保存の知らせで、取り消した内容が戻らない', async () => {
  const h = harness('one\n')
  let finish
  h.setWrite(() => new Promise((resolve) => { finish = resolve }))
  h.state.text = 'one\ntable\n'
  h.saver.changed()
  await h.tick()
  // Cmd+Zで戻したあとに、書いている途中の内容の知らせが届く。
  h.state.text = 'one\n'
  h.saver.changed()
  h.saver.applyExternal('one\ntable\n', 'h1')
  assert.equal(h.state.text, 'one\n')
  assert.deepEqual(h.backups, [])
  finish({ conflict: false, hash: 'h1' })
  await new Promise((r) => setImmediate(r))
  assert.equal(h.state.text, 'one\n')
  h.setWrite(async () => ({ conflict: false, hash: 'h2' }))
  while (h.timers.length) await h.tick()
  assert.equal(lastState(h.events), 'saved')
})

test('保存の最中でも、別の内容の知らせは外からの変更として取り込む', async () => {
  const h = harness('a\nb\nc\nd\n')
  let finish
  h.setWrite(() => new Promise((resolve) => { finish = resolve }))
  h.state.text = 'A\nb\nc\nd\n'
  h.saver.changed()
  await h.tick()
  h.saver.applyExternal('a\nb\nc\nD\n', 'x1')
  assert.equal(h.state.text, 'A\nb\nc\nD\n')
  finish({ conflict: false, hash: 'h1' })
  await new Promise((r) => setImmediate(r))
})

test('開いただけでは保存しない', async () => {
  const h = harness()
  await h.saver.save()
  assert.equal(h.writes.length, 0)
})

test('外部の変更で消える内容はバックアップに残す', async () => {
  const h = harness('saved\n')
  h.saver.applyExternal('override\n', 'h9')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.backups, ['saved\n'])
  assert.equal(h.state.text, 'override\n')
})

test('バックアップの内容に戻すと保存され、戻す前の内容も残る', async () => {
  const h = harness('now\n')
  await h.saver.restore('old\n')
  assert.equal(h.state.text, 'old\n')
  assert.deepEqual(h.backups, ['now\n'])
  while (h.timers.length) await h.tick()
  assert.equal(h.writes.at(-1).text, 'old\n')
})

test('ノートを切り替える前に保存しきる', async () => {
  const h = harness('a\n')
  h.state.text = 'b\n'
  h.saver.changed()
  await h.saver.flush()
  assert.equal(h.writes.at(-1).text, 'b\n')
  assert.equal(h.draftStore.size, 0)
})

test('keepDraft は書きかけがあるときだけ、今の内容ですぐ下書きを書き直す', () => {
  const h = harness('a\n')
  h.saver.keepDraft()
  assert.equal(h.draftStore.size, 0)
  h.state.text = 'b\n'
  h.saver.changed()
  h.state.text = 'bc\n'
  h.saver.keepDraft()
  assert.equal(h.draftStore.get('a.md').text, 'bc\n')
  assert.equal(h.draftStore.get('a.md').baseText, 'a\n')
})

test('保存の途中でノートを切り替えても、別のノートの内容を下書きにしない', async () => {
  const h = harness('a\n')
  h.state.text = 'b\n'
  h.saver.changed()
  const pending = h.saver.save()
  h.saver.close()
  h.state.text = 'OTHER NOTE'
  await pending
  assert.equal(h.draftStore.size, 0)
  assert.equal(h.timers.length, 0)
})

test('保存が断られたら再試行せず止める', async () => {
  const h = harness('a\n')
  h.state.text = 'b\n'
  const write = async () => { throw Object.assign(new Error('not editable'), { status: 403 }) }
  h.setWrite(write)
  h.saver.changed()
  await h.tick()
  assert.equal(lastState(h.events), 'blocked')
  assert.equal(h.timers.length, 0)
  assert.equal(h.draftStore.get('a.md').text, 'b\n')
})

test('編集していないときの外部の変更はそのまま画面に出す', () => {
  const h = harness('a\n')
  h.saver.applyExternal('b\n', 'h9')
  assert.equal(h.state.text, 'b\n')
  assert.equal(h.timers.length, 0, '受け取っただけでは書き戻さない')
})

test('編集中に別の行が変わると合わせて保存する', async () => {
  const h = harness('a\nb\nc\nd\ne\n')
  h.state.text = 'A\nb\nc\nd\ne\n'
  h.saver.changed()
  h.saver.applyExternal('a\nb\nc\nd\nE\n', 'h9')
  assert.equal(h.state.text, 'A\nb\nc\nd\nE\n')
  while (h.timers.length) await h.tick()
  assert.deepEqual(h.writes, [{ text: 'A\nb\nc\nd\nE\n', hash: 'h9' }])
})

test('同じ行がぶつかると止まり、どちらも失わない', async () => {
  const h = harness('a\n')
  h.state.text = 'mine\n'
  h.saver.changed()
  h.saver.applyExternal('theirs\n', 'h9')
  assert.equal(lastState(h.events), 'conflict')
  assert.equal(h.state.text, 'mine\n', '画面の内容は消えない')
  assert.equal(h.timers.length, 0, '自動保存は止まる')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.backups, ['mine\n'])
  h.state.text = 'mine2\n'
  h.saver.changed()
  assert.equal(h.timers.length, 0, '止まっている間は保存しない')
  await h.saver.resolve('mine')
  assert.ok(h.backups.includes('theirs\n'), '選ばなかった方を残す')
  while (h.timers.length) await h.tick()
  assert.deepEqual(h.writes.at(-1), { text: 'mine2\n', hash: 'h9' })
})

test('ファイルの内容を選ぶと自分の内容はバックアップに残る', async () => {
  const h = harness('a\n')
  h.state.text = 'mine\n'
  h.saver.changed()
  h.saver.applyExternal('theirs\n', 'h9')
  await h.saver.resolve('theirs')
  assert.equal(h.state.text, 'theirs\n')
  assert.ok(h.backups.includes('mine\n'))
  assert.equal(h.writes.length, 0)
})

test('保存時に先を越されていたら合わせ直す', async () => {
  const h = harness('a\nb\nc\nd\ne\n')
  h.state.text = 'A\nb\nc\nd\ne\n'
  h.state.conflict = { text: 'a\nb\nc\nd\nE\n', hash: 'h9' }
  h.saver.changed()
  while (h.timers.length) await h.tick()
  assert.equal(h.state.text, 'A\nb\nc\nd\nE\n')
  assert.equal(h.writes.at(-1).text, 'A\nb\nc\nd\nE\n')
})

test('自分の保存の知らせでは何も変えない', async () => {
  const h = harness('a\n')
  h.state.text = 'b\n'
  h.saver.changed()
  await h.tick()
  h.saver.applyExternal('b\n', 'h1')
  assert.equal(h.state.text, 'b\n')
  assert.equal(h.timers.length, 0)
})

test('サーバーが止まると下書きを残して再試行する', async () => {
  const h = harness('a\n')
  h.state.fail = true
  h.state.text = 'b\n'
  h.saver.changed()
  await h.tick()
  assert.equal(lastState(h.events), 'offline')
  assert.equal(h.draftStore.get('a.md').text, 'b\n')
  assert.equal(h.timers.length, 1)
  h.state.fail = false
  await h.tick()
  assert.equal(lastState(h.events), 'saved')
  assert.equal(h.draftStore.size, 0)
})

test('変換中は保存も外部の反映も待つ', async () => {
  const h = harness('a\nb\nc\n')
  h.state.composing = true
  h.state.text = 'aあ\nb\nc\n'
  h.saver.changed()
  await h.tick()
  assert.equal(h.writes.length, 0)
  h.saver.applyExternal('a\nb\nC\n', 'h9')
  assert.equal(h.state.text, 'aあ\nb\nc\n')
  h.state.composing = false
  h.saver.compositionEnded()
  assert.equal(h.state.text, 'aあ\nb\nC\n')
})

test('ノートが消えたら止めて内容を残す', async () => {
  const h = harness('a\n')
  h.state.text = 'b\n'
  h.saver.changed()
  h.saver.removed()
  await new Promise((r) => setImmediate(r))
  assert.equal(lastState(h.events), 'removed')
  assert.deepEqual(h.backups, ['b\n'])
  assert.equal(h.timers.length, 0)
})

test('残っていた下書きを今のファイルと合わせて戻す', () => {
  const h = harness('a\nb\nc\nd\nE\n')
  const restored = h.saver.restoreDraft({ text: 'A\nb\nc\nd\ne\n', baseText: 'a\nb\nc\nd\ne\n' })
  assert.equal(restored, true)
  assert.equal(h.state.text, 'A\nb\nc\nd\nE\n')
})

test('下書きがぶつかるときは止めて両方残す', () => {
  const h = harness('theirs\n')
  h.saver.restoreDraft({ text: 'mine\n', baseText: 'old\n' })
  assert.equal(h.state.text, 'mine\n')
  assert.equal(lastState(h.events), 'conflict')
  assert.equal(h.saver.isStopped(), 'conflict')
})

test('消えたあとに戻ったら、保存を再開する', async () => {
  const h = harness('one\n')
  h.saver.removed()
  assert.equal(h.saver.isStopped(), 'removed')
  h.state.text = 'one\nmine\n'
  h.saver.changed()
  h.saver.applyExternal('one\n', 'h0')
  assert.equal(h.saver.isStopped(), null)
  assert.equal(lastState(h.events), 'dirty')
  await h.tick()
  await h.tick()
  assert.equal(h.writes.at(-1).text, 'one\nmine\n')
})

test('編集できない形に変わってから戻ったら、合成して保存を再開する', async () => {
  const h = harness('a\nb\nc\n')
  h.saver.blocked()
  h.state.text = 'A\nb\nc\n'
  h.saver.changed()
  h.saver.applyExternal('a\nb\nC\n', 'h9')
  assert.equal(h.saver.isStopped(), null)
  assert.equal(h.state.text, 'A\nb\nC\n')
  await h.tick()
  assert.deepEqual(h.writes.at(-1), { text: 'A\nb\nC\n', hash: 'h9' })
})

test('保存中に閉じても、最後の入力が下書きに残る', async () => {
  const h = harness('one\n')
  let finish
  h.setWrite(() => new Promise((resolve) => { finish = resolve }))
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  h.state.text = 'three\n'
  h.saver.close()
  assert.equal(h.draftStore.get('a.md').text, 'three\n')
  finish({ conflict: false, hash: 'h1' })
  await new Promise((r) => setImmediate(r))
  assert.equal(h.draftStore.get('a.md').text, 'three\n', '保存したものと違う下書きは消さない')
})

test('保存中に閉じて保存が失敗しても、最後の入力を上書きしない', async () => {
  const h = harness('one\n')
  let fail
  h.setWrite(() => new Promise((_, reject) => { fail = reject }))
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  h.state.text = 'three\n'
  h.saver.close()
  fail(new Error('down'))
  await new Promise((r) => setImmediate(r))
  assert.equal(h.draftStore.get('a.md').text, 'three\n')
})

test('保存中に閉じて同じ内容が保存できたら、下書きを消す', async () => {
  const h = harness('one\n')
  let finish
  h.setWrite(() => new Promise((resolve) => { finish = resolve }))
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  h.saver.close()
  finish({ conflict: false, hash: 'h1' })
  await new Promise((r) => setImmediate(r))
  assert.equal(h.draftStore.size, 0)
})

test('サーバーが別のVaultに変わったら止まり、外の変更でも再開しない', async () => {
  const h = harness('one\n')
  h.setWrite(async () => {
    throw Object.assign(new Error('other vault'), { status: 412 })
  })
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  assert.equal(h.saver.isStopped(), 'elsewhere')
  assert.equal(lastState(h.events), 'elsewhere')
  assert.equal(h.timers.length, 0, '書き込みを繰り返さない')
  h.saver.applyExternal('other\n', 'h9')
  assert.equal(h.saver.isStopped(), 'elsewhere')
  assert.equal(h.state.text, 'two\n')
  assert.equal(h.draftStore.get('a.md').text, 'two\n')
})

test('別のVaultの知らせが何度来ても、知らせ直さない', () => {
  const h = harness('one\n')
  h.saver.elsewhere()
  h.saver.elsewhere()
  assert.equal(h.events.filter((e) => e.state === 'elsewhere').length, 1)
})

test('今の内容と同じ下書きは、戻さずに消す', () => {
  const h = harness('one\n')
  h.draftStore.set('a.md', { text: 'one\n', baseText: 'zero\n' })
  assert.equal(h.saver.restoreDraft(h.draftStore.get('a.md')), false)
  assert.equal(h.draftStore.size, 0)
})

test('表のマスの編集中も保存は進め、外部の変更だけ待つ', async () => {
  const h = harness('one\n')
  h.state.composing = true
  h.state.holdSave = false
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  assert.equal(h.writes.at(-1)?.text, 'two\n')
  assert.equal(lastState(h.events), 'saved')
  h.saver.applyExternal('other\n', 'h9')
  assert.equal(h.state.text, 'two\n', '編集中は画面を変えない')
  h.state.composing = false
  h.saver.compositionEnded()
  assert.equal(h.state.text, 'other\n', '保存済みなので、編集が終われば外部の内容を取り込む')
  assert.equal(h.saver.isStopped(), null)
})

test('合言葉を断られたら止まり、下書きを残して書き込みを繰り返さない', async () => {
  const h = harness('one\n')
  h.setWrite(async () => {
    throw Object.assign(new Error('token'), { status: 401 })
  })
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  assert.equal(h.saver.isStopped(), 'elsewhere')
  assert.equal(h.timers.length, 0)
  assert.equal(h.draftStore.get('a.md').text, 'two\n')
})

test('サーバーが答えたのに保存できないときは、つながらない扱いにせず保存できなかったと出す', async () => {
  const h = harness('a\n')
  h.state.failStatus = 500
  h.state.text = 'b\n'
  h.saver.changed()
  await h.tick()
  assert.equal(lastState(h.events), 'save-failed')
  assert.equal(h.draftStore.get('a.md').text, 'b\n')
  assert.equal(h.timers.length, 1)
})
