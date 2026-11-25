import assert from 'node:assert/strict'
import test from 'node:test'

import { historyKey, isBodyKey, isCommandKey, keyLabel, localizeKeyHints } from '../src/keys.mjs'

const press = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })

test('MacではCmdだけをコマンドのキーとして扱う', () => {
  assert.equal(isCommandKey(press('e', { metaKey: true }), true), true)
  assert.equal(isCommandKey(press('e', { ctrlKey: true }), true), false)
  assert.equal(isCommandKey(press('e', { metaKey: true, ctrlKey: true }), true), false)
})

test('Mac以外ではCtrlだけをコマンドのキーとして扱う', () => {
  assert.equal(isCommandKey(press('e', { ctrlKey: true }), false), true)
  assert.equal(isCommandKey(press('e', { metaKey: true }), false), false)
})

test('本文へ移るキーは、MacではCmd+E、それ以外ではCtrl+Eだけ', () => {
  assert.equal(isBodyKey(press('e', { metaKey: true }), true), true)
  assert.equal(isBodyKey(press('E', { metaKey: true }), true), true)
  // MacのCtrl+Eは行の終わりへの移動なので使わない。
  assert.equal(isBodyKey(press('e', { ctrlKey: true }), true), false)
  assert.equal(isBodyKey(press('e', { ctrlKey: true }), false), true)
  assert.equal(isBodyKey(press('e', { metaKey: true }), false), false)
  // Shift・Alt付き、日本語の変換中、ほかの文字、修飾キーなしは使わない。
  assert.equal(isBodyKey(press('e', { metaKey: true, shiftKey: true }), true), false)
  assert.equal(isBodyKey(press('e', { metaKey: true, altKey: true }), true), false)
  assert.equal(isBodyKey(press('e', { metaKey: true, isComposing: true }), true), false)
  assert.equal(isBodyKey(press('o', { metaKey: true }), true), false)
  assert.equal(isBodyKey(press('e'), true), false)
})

test('取り消しとやり直しのキーを見分ける', () => {
  assert.equal(historyKey(press('z', { metaKey: true }), true), 'undo')
  assert.equal(historyKey(press('Z', { metaKey: true, shiftKey: true }), true), 'redo')
  assert.equal(historyKey(press('y', { metaKey: true }), true), 'redo')
  assert.equal(historyKey(press('z', { ctrlKey: true }), false), 'undo')
})

test('取り消しとやり直しではないキーには何も返さない', () => {
  assert.equal(historyKey(press('z'), true), null)
  assert.equal(historyKey(press('z', { ctrlKey: true }), true), null)
  assert.equal(historyKey(press('z', { metaKey: true, altKey: true }), true), null)
  assert.equal(historyKey(press('s', { metaKey: true }), true), null)
})

test('キーの案内は、MacではCmdのまま、Mac以外ではCtrlにする', () => {
  assert.equal(keyLabel('Claudeに送る（Cmd+Enterで送信）', true), 'Claudeに送る（Cmd+Enterで送信）')
  assert.equal(keyLabel('Claudeに送る（Cmd+Enterで送信）', false), 'Claudeに送る（Ctrl+Enterで送信）')
  assert.equal(keyLabel('表を入れる（Cmd+Shift+T）', false), '表を入れる（Ctrl+Shift+T）')
  assert.equal(keyLabel('CmdShiftではない文字', false), 'CmdShiftではない文字')
})

test('画面の title・placeholder・kbd の案内を、Mac以外ではCtrlに書き換える', () => {
  const el = (attrs, text = '') => ({
    attrs: { ...attrs },
    textContent: text,
    getAttribute(n) { return this.attrs[n] ?? null },
    setAttribute(n, v) { this.attrs[n] = v },
  })
  const button = el({ title: '太字（Cmd+B）' })
  const input = el({ placeholder: 'Claudeに送る（Cmd+Enterで送信）' })
  const kbd = el({}, 'Cmd+V')
  const plain = el({ title: '閉じる' })
  const root = {
    querySelectorAll(sel) {
      if (sel === '[title]') return [button, plain]
      if (sel === '[placeholder]') return [input]
      if (sel === 'kbd') return [kbd]
      return []
    },
  }
  localizeKeyHints(root, true)
  assert.equal(button.attrs.title, '太字（Cmd+B）')
  localizeKeyHints(root, false)
  assert.equal(button.attrs.title, '太字（Ctrl+B）')
  assert.equal(input.attrs.placeholder, 'Claudeに送る（Ctrl+Enterで送信）')
  assert.equal(kbd.textContent, 'Ctrl+V')
  assert.equal(plain.attrs.title, '閉じる')
})
