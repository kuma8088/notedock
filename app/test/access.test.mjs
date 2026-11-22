import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { CHAT_PARTNER_TEXT, markKeyRefused, needTicketUrl, sendFailText, takeKeyRefused } from '../src/access.mjs'

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

// 実機（2026-11-22、VM）：起動で401になって開けない画面のあいだに #c=…&s=… の移動が来ても、合図を捨てずに引き換える。
test('画面のつなぎ：合図はアドレスから消す前に退避し、開けない画面でも送れる口で引き換え、起動時と移動のときに引き換える', () => {
  const src = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const fn = (name) => {
    const at = src.indexOf(name)
    assert.ok(at >= 0, name)
    return src.slice(at, src.indexOf('\n}\n', at))
  }
  const take = fn('function takeChatBindCode()')
  assert.ok(take.indexOf('stashBindCode(') >= 0 && take.indexOf('stashBindCode(') < take.indexOf('replaceState'), '退避してから消す')
  const bind = fn('async function bindChat()')
  assert.ok(bind.includes('bindChatCode('))
  assert.ok(!bind.includes('request('), '開けない画面のあいだ何も送らない request を通さない')
  const start = fn('async function start()')
  assert.ok(start.indexOf('await bindChat()') > start.indexOf('await takeTicket()'), '起動時は合言葉を取ってから引き換える')
  const change = src.slice(src.indexOf("window.addEventListener('hashchange'"))
  assert.ok(change.indexOf('takeChatBindCode()') < change.indexOf('takeTicket()'), '移動のときも、鍵でアドレスを消す前に退避する')
  assert.ok(change.includes('await bindChat()'))
  assert.ok(/changed \|\| !view \|\| linkChanged/.test(change), '開けなかったタブは読み込み直し、起動時にもう一度引き換える')
})

// 実機（2026-11-22、VM）：結び付けた会話が無くなったあとに送ると「読み込み直して」と出ていた。サーバーの理由で出し分ける。
test('送れなかったときの案内は、サーバーが断った理由（409 の error）と相手の様子で出し分ける', () => {
  assert.equal(sendFailText({ status: 409, ok: false, data: { error: 'chat-gone' } }, 'live'), CHAT_PARTNER_TEXT.gone)
  assert.equal(sendFailText({ status: 409, ok: false, data: { error: 'no-chat' } }, 'live'), CHAT_PARTNER_TEXT.none)
  assert.equal(sendFailText({ status: 409, ok: false, data: null }, 'live'), CHAT_PARTNER_TEXT.gone)
  assert.equal(sendFailText(null, 'gone'), CHAT_PARTNER_TEXT.gone)
  assert.equal(sendFailText(null, 'none'), CHAT_PARTNER_TEXT.none)
  assert.equal(sendFailText({ status: 500, ok: false, data: null }, 'live'), '送れませんでした。エディターを読み込み直して確かめてください。')
  assert.match(CHAT_PARTNER_TEXT.gone, /\/clear やアプリの開き直し/)
  assert.match(CHAT_PARTNER_TEXT.gone, /「ノートを開く」を押し直してください/)
  const src = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes("say(noPartner ? '送れませんでした。' : sendFailText(sent, partner))"))
})
