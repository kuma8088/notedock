import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { markKeyRefused, needTicketUrl, takeKeyRefused } from '../src/access.mjs'

// 開けない画面が need-ticket に付ける印。鍵を断られたときだけ hadKey=1。
test('need-ticket の宛先は、鍵を断られたかどうかを hadKey=1 / hadKey=0 で付ける', () => {
  assert.equal(needTicketUrl(true), '/api/need-ticket?hadKey=1')
  assert.equal(needTicketUrl(false), '/api/need-ticket?hadKey=0')
})

function fakeStore() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

// 読み込み直したあとも「鍵を断られた」ことを覚えておくための印（タブの中だけ・1回だけ）。鍵そのものは書かない。
test('鍵を断られた印は、読み込み直しのあと1回だけ読め、読んだら消える', () => {
  const store = fakeStore()
  assert.equal(takeKeyRefused(store), false)
  markKeyRefused(store)
  assert.equal([...store.map.values()].join(''), '1')
  assert.equal(takeKeyRefused(store), true)
  assert.equal(takeKeyRefused(store), false)
  assert.equal(store.map.size, 0)
})

test('保存領域が使えなくても、印の読み書きで止まらない', () => {
  const broken = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  assert.doesNotThrow(() => markKeyRefused(broken))
  assert.equal(takeKeyRefused(broken), false)
  assert.doesNotThrow(() => markKeyRefused(undefined))
  assert.equal(takeKeyRefused(undefined), false)
})

// 画面（main.mjs）は DOM と結び付いていて単体で呼べないので、つなぎ方だけを確かめる。
test('開けない画面は、鍵を断られたかどうかを need-ticket に付けて送り、読み込み直しのあとも引き継ぐ', () => {
  const src = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  assert.match(src, /needTicketUrl\(keyRefused\)/)
  assert.match(src, /takeKeyRefused\(/)
  assert.match(src, /markKeyRefused\(/)
  assert.doesNotMatch(src, /fetch\('\/api\/need-ticket'/)
})

// 一度断られたタブでも、あとで鍵を引き換えられたら「断られた」を忘れる（古い true を送らない）。
test('鍵を引き換えられたら、断られた印を消す', () => {
  const src = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('async function takeTicket()'), src.indexOf('const tokenHeader'))
  assert.match(body, /if \(!response\.ok\) return false\s*\n\s*keyRefused = false/)
})
