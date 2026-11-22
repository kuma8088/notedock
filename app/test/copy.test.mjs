import assert from 'node:assert/strict'
import { test } from 'node:test'

import { copyText } from '../src/copy.mjs'
import { absolutePath } from '../src/files.mjs'

test('コピーはまずクリップボードの機能で行う', async () => {
  const written = []
  const ok = await copyText('/a/b.md', { clipboard: { writeText: async (text) => written.push(text) }, execCopy: () => assert.fail('使わない') })
  assert.equal(ok, true)
  assert.deepEqual(written, ['/a/b.md'])
})

test('クリップボードの機能が断られたら、選択してコピーする方法を試す', async () => {
  const copied = []
  const ok = await copyText('/a/b.md', {
    clipboard: { writeText: async () => { throw new Error('denied') } },
    execCopy: (text) => copied.push(text) > 0,
  })
  assert.equal(ok, true)
  assert.deepEqual(copied, ['/a/b.md'])
})

test('どちらもできなければ false を返し、画面で手でコピーしてもらう', async () => {
  assert.equal(await copyText('/a/b.md', { clipboard: undefined, execCopy: () => false }), false)
  assert.equal(await copyText('/a/b.md', { clipboard: undefined, execCopy: () => { throw new Error('no') } }), false)
})

test('ノートの絶対パスは、Vaultの場所とVaultからの相対パスをつなぐ', () => {
  assert.equal(absolutePath(['/v/Vault'], 'a/b.md'), '/v/Vault/a/b.md')
  assert.equal(absolutePath(['/v/Vault'], 'docs/日本語 メモ.md'), '/v/Vault/docs/日本語 メモ.md')
})

test('Windowsでは区切りを「\\」にそろえる', () => {
  assert.equal(absolutePath(['C:\\Users\\x\\Vault'], 'docs/a.md', 'win32'), 'C:\\Users\\x\\Vault\\docs\\a.md')
  assert.equal(absolutePath(['C:/Users/x/Vault'], 'a.md', 'win32'), 'C:\\Users\\x\\Vault\\a.md')
  assert.equal(absolutePath(['/v/Vault'], 'a/b.md', 'darwin'), '/v/Vault/a/b.md')
})

test('Vaultの外のノートや、場所が分からないときは null', () => {
  assert.equal(absolutePath(['/v/Vault'], '__outside__/x.md'), null)
  assert.equal(absolutePath([], 'a.md'), null)
  assert.equal(absolutePath(undefined, 'a.md'), null)
  assert.equal(absolutePath(['/v'], null), null)
})
