import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFrontmatter, setProperty } from '../src/yaml-lite.mjs'

const valueOf = (source, key) => parseFrontmatter(source).items.find((item) => item.key === key)?.value

test('二重引用符とバックスラッシュを含む値が、書いて読んでも変わらない', () => {
  for (const text of ['He said "hi": ok \\ x', 'a\\"b', '末尾が \\', '"先頭が引用符', 'C:\\Users\\x # メモ']) {
    const source = setProperty('---\n---', 'title', text)
    assert.equal(valueOf(source, 'title'), text, source)
    // もう一度書いても増えない。
    assert.equal(setProperty(source, 'title', valueOf(source, 'title')), source)
  }
})

test('二重引用符の中の \\" と \\\\ だけを戻し、ほかの書き方は今までどおり読む', () => {
  assert.equal(valueOf('---\na: "x \\"y\\" \\\\ z"\n---', 'a'), 'x "y" \\ z')
  assert.equal(valueOf('---\na: "x \\n y"\n---', 'a'), 'x \\n y')
  // 単引用符は戻さない。
  assert.equal(valueOf("---\na: 'x \\\\ y'\n---", 'a'), 'x \\\\ y')
  assert.equal(valueOf('---\na: plain \\ text\n---', 'a'), 'plain \\ text')
  assert.equal(valueOf('---\na: "題名"\n---', 'a'), '題名')
})

test('goal と parent は、引用符があってもなくてもリンクとして読む', () => {
  const quoted = '---\ntype: task\ngoal: "[[90_Periodic/2026/Monthly/2026-11]]"\nparent: "[[Tasks/2026-11-24-親]]"\n---'
  const bare = '---\ntype: task\ngoal: [[90_Periodic/2026/Monthly/2026-11]]\nparent: [[Tasks/2026-11-24-親]]\n---'
  for (const source of [quoted, bare]) {
    const { items, simple } = parseFrontmatter(source)
    assert.equal(simple, true)
    assert.equal(valueOf(source, 'goal'), '[[90_Periodic/2026/Monthly/2026-11]]')
    assert.equal(valueOf(source, 'parent'), '[[Tasks/2026-11-24-親]]')
    assert.deepEqual(items.map((item) => item.type), ['text', 'text', 'text'])
  }
  // 引用符なしのリンクの行は、ほかの項目を書き換えても触らない。
  assert.equal(setProperty(bare, 'type', 'task'), bare)
  // 書き直すと引用符で囲む。
  assert.match(setProperty(bare, 'goal', '[[x]]'), /^goal: "\[\[x\]\]"$/m)
})

test('goal・parent は小文字の名前だけをリンクとして読む', () => {
  assert.deepEqual(valueOf('---\nGoal: [[a]]\n---', 'Goal'), ['[a]'])
  assert.deepEqual(valueOf('---\nPARENT: [[a]]\n---', 'PARENT'), ['[a]'])
  assert.equal(valueOf('---\ngoal: [[a]]\n---', 'goal'), '[[a]]')
})

test('quote: true のときは、いつも二重引用符で書く', () => {
  assert.equal(setProperty('---\n---', 'title', 'x', { quote: true }), '---\ntitle: "x"\n---')
  assert.equal(setProperty('---\n---', 'title', '', { quote: true }), '---\ntitle: ""\n---')
  assert.equal(setProperty('---\n---', 'title', 'a"b\\c', { quote: true }), '---\ntitle: "a\\"b\\\\c"\n---')
  // 指定しなければ今までどおり。
  assert.equal(setProperty('---\n---', 'title', 'x'), '---\ntitle: x\n---')
})

test('goal・parent 以外の項目と、リンクでない角かっこの読み方は変えない', () => {
  assert.deepEqual(valueOf('---\nrelated: [[a]]\n---', 'related'), ['[a]'])
  assert.deepEqual(valueOf('---\ngoal: [a, b]\n---', 'goal'), ['a', 'b'])
  assert.deepEqual(valueOf('---\ngoal: [[a, b], [c]]\n---', 'goal'), ['[a', 'b]', '[c]'])
  assert.deepEqual(valueOf('---\ntags: [x, "y"]\n---', 'tags'), ['x', 'y'])
})

test('行末のコメントは値に含めたまま読む（今までどおり）', () => {
  assert.equal(valueOf('---\nstatus: 未着手 # メモ\n---', 'status'), '未着手 # メモ')
  assert.equal(valueOf('---\ndue: 2026-11-30 # 仮\n---', 'due'), '2026-11-30 # 仮')
  assert.equal(parseFrontmatter('---\ndue: 2026-11-30 # 仮\n---').items[0].type, 'text')
  // コメントだけの行は読み飛ばす。
  assert.deepEqual(parseFrontmatter('---\n# メモ\na: 1\n---').items.map((item) => item.key), ['a'])
})
