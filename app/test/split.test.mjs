import assert from 'node:assert/strict'
import test from 'node:test'

import { SPLIT_LEFT_MIN, SPLIT_RIGHT_MIN, clampSplit, savedResult } from '../src/split.mjs'

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
