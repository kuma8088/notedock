import assert from 'node:assert/strict'
import test from 'node:test'

import { MSG, draftKey, isPaneMessage, pickDraft, targetPane } from '../src/pane.mjs'

test('同じアドレスから来た pane: の連絡だけを受け付ける', () => {
  const ok = { origin: 'http://localhost:8795', data: { type: 'pane:open', path: 'a.md' }, source: 'R' }
  assert.equal(isPaneMessage(ok, { origin: 'http://localhost:8795' }), true)
  assert.equal(isPaneMessage(ok, { origin: 'http://localhost:8795', source: 'R' }), true)
  assert.equal(isPaneMessage(ok, { origin: 'http://localhost:8795', source: 'X' }), false)
  assert.equal(isPaneMessage({ ...ok, origin: 'http://evil.test' }, { origin: 'http://localhost:8795' }), false)
  assert.equal(isPaneMessage({ ...ok, data: { type: 'other' } }, { origin: 'http://localhost:8795' }), false)
  assert.equal(isPaneMessage({ ...ok, data: 'pane:open' }, { origin: 'http://localhost:8795' }), false)
  assert.equal(isPaneMessage({ ...ok, data: null }, { origin: 'http://localhost:8795' }), false)
})

test('連絡の種類の名前は重ならない', () => {
  assert.equal(MSG.OPEN, 'pane:open')
  assert.equal(MSG.STATE, 'pane:state')
  assert.equal(MSG.CLOSE, 'pane:close')
  assert.equal(new Set(Object.values(MSG)).size, Object.values(MSG).length)
})

test('ふつうのクリックは操作中の枠、Cmd+クリックは反対側', () => {
  assert.equal(targetPane({ meta: false, from: 'sidebar', active: 'left' }), 'left')
  assert.equal(targetPane({ meta: false, from: 'sidebar', active: 'right' }), 'right')
  assert.equal(targetPane({ meta: true, from: 'sidebar', active: 'left' }), 'right')
  assert.equal(targetPane({ meta: true, from: 'sidebar', active: 'right' }), 'left')
  assert.equal(targetPane({ meta: false, from: 'right', active: 'left' }), 'right')
  assert.equal(targetPane({ meta: true, from: 'left', active: 'right' }), 'right')
  assert.equal(targetPane({ meta: true, from: 'right', active: 'right' }), 'left')
})

test('右の枠の一時保存は別のキー', () => {
  assert.equal(draftKey('v1', 'a/b.md', 'left'), 'draft:v1:a/b.md')
  assert.equal(draftKey('v1', 'a/b.md', 'right'), 'draft:v1:a/b.md:right')
})

test('どの一時保存を戻すかの選び方', () => {
  const L = { text: 'L' }
  const R = { text: 'R' }
  assert.deepEqual(pickDraft({ pane: 'right', left: L, right: R, rightOpen: true }), { draft: R, removeRight: false })
  assert.deepEqual(pickDraft({ pane: 'right', left: L, right: null, rightOpen: true }), { draft: null, removeRight: false })
  assert.deepEqual(pickDraft({ pane: 'left', left: L, right: R, rightOpen: false }), { draft: L, removeRight: false })
  assert.deepEqual(pickDraft({ pane: 'left', left: null, right: R, rightOpen: false }), { draft: R, removeRight: true })
  assert.deepEqual(pickDraft({ pane: 'left', left: null, right: R, rightOpen: true }), { draft: null, removeRight: false })
})
