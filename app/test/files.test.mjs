import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ancestorsOf, buildTree, checkNewNote, defaultNoteDir, newNotePath, noteFolders, planFailure, resolvePasted } from '../src/files.mjs'

test('フォルダーを先に、名前の順に並べる', () => {
  const tree = buildTree(['b.md', 'z/2.md', 'a/x.md', 'z/10.md', 'a/sub/y.md'])
  assert.deepEqual(tree.folders.map((f) => f.name), ['a', 'z'])
  assert.deepEqual(tree.files.map((f) => f.name), ['b.md'])
  assert.deepEqual(tree.folders[0].folders[0].files, [{ name: 'y.md', path: 'a/sub/y.md' }])
  assert.equal(tree.folders[0].folders[0].path, 'a/sub')
  assert.deepEqual(tree.folders[1].files.map((f) => f.name), ['2.md', '10.md'], '数字は数の順')
})

test('ノートの上のフォルダーを順に返す', () => {
  assert.deepEqual(ancestorsOf('a/b/c.md'), ['a', 'a/b'])
  assert.deepEqual(ancestorsOf('c.md'), [])
})

test('貼り付けたパスをVaultの中のノートへ直す', () => {
  const root = ['/Users/x/Vault']
  const notes = ['projects/a/README.md', 'projects/b/README.md', 'Home.md', 'docs/日本語 メモ.md']
  assert.equal(resolvePasted('projects/a/README.md', root, notes), 'projects/a/README.md')
  assert.equal(resolvePasted('/Users/x/Vault/projects/b/README.md', root, notes), 'projects/b/README.md')
  assert.equal(resolvePasted(' "/Users/x/Vault/Home.md" ', root, notes), 'Home.md')
  assert.equal(resolvePasted('file:///Users/x/Vault/docs/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%A1%E3%83%A2.md', root, notes), 'docs/日本語 メモ.md')
  assert.equal(resolvePasted('/Users/x/Vault/Home.md:12', root, notes), 'Home.md', '行番号が付いていてもよい')
  assert.equal(resolvePasted('a/README.md', root, notes), 'projects/a/README.md', '途中からでも1つに決まれば開く')
  assert.equal(resolvePasted('README.md', root, notes), null, '1つに決まらなければ開かない')
  assert.equal(resolvePasted('/etc/passwd', root, notes), null)
  assert.equal(resolvePasted('メモ', root, notes), null, 'パスでなければ何もしない')
  assert.equal(resolvePasted('Home.md\nprojects/a/README.md', root, notes), null, '何行もある文字はパスとして扱わない')
  assert.equal(resolvePasted('Home.md\n', root, notes), 'Home.md', '末尾の改行はかまわない')
  assert.equal(resolvePasted('docs/日本語 メモ.md'.normalize('NFD'), root, notes), 'docs/日本語 メモ.md', '濁点の持ち方が違っても開く')
  assert.equal(resolvePasted('/Users/x/Vault/docs/日本語 メモ.md'.normalize('NFD'), root, ['docs/日本語 メモ.md'.normalize('NFD')]), 'docs/日本語 メモ.md'.normalize('NFD'), 'ファイル名の側が分解された形でも開く')
  // テスト用のコピーでは、元のVaultのパスを貼っても同じ場所のノートを開く。
  assert.equal(resolvePasted('/Users/x/Vault/Home.md', ['/tmp/copy', '/Users/x/Vault'], notes), 'Home.md')
  assert.equal(resolvePasted('/tmp/copy/Home.md', ['/tmp/copy', '/Users/x/Vault'], notes), 'Home.md')
  assert.equal(resolvePasted('/tmp/other/Home.md', ['/tmp/copy', '/Users/x/Vault'], notes), null)
  // セッションのフォルダーから見た相対パス。
  assert.equal(resolvePasted('../a/README.md', root, notes), 'projects/a/README.md')
  assert.equal(resolvePasted('./projects/b/README.md', root, notes), 'projects/b/README.md')
  assert.equal(resolvePasted('../README.md', root, notes), null, '1つに決まらなければ開かない')
  assert.equal(resolvePasted('../Home.md', root, ['Home.md', 'a/Home.md']), null, '上へ戻るパスは、一番上のノートも候補に入れて1つに決まるときだけ開く')
  assert.equal(resolvePasted('../../x/z.md', root, ['x/z.md']), 'x/z.md')
  assert.equal(resolvePasted('/Users/x/Vault/../secret.md', root, notes), null)
})

test('Windowsの書き方の場所も、Vaultの中のノートに直す', () => {
  const root = ['C:\\Users\\a\\Notes']
  const notes = ['Daily/x.md', 'Home.md']
  assert.equal(resolvePasted('c:\\users\\a\\notes\\Daily\\x.md', root, notes, 'win32'), 'Daily/x.md', '大文字と小文字、区切りの違いを問わない')
  assert.equal(resolvePasted('C:/Users/a/Notes/Home.md', root, notes, 'win32'), 'Home.md')
  assert.equal(resolvePasted('"C:\\Users\\a\\Notes\\Daily\\x.md"', root, notes, 'win32'), 'Daily/x.md')
  assert.equal(resolvePasted('file:///C:/Users/a/Notes/Daily/x.md', root, notes, 'win32'), 'Daily/x.md')
  assert.equal(resolvePasted('C:\\Users\\a\\Other\\x.md', root, notes, 'win32'), null, 'Vaultの外')
  assert.equal(resolvePasted('C:\\Users\\a\\Notes2\\Home.md', root, ['Home.md', '2/Home.md'], 'win32'), null, '名前が前だけ同じ別フォルダー')
  assert.equal(resolvePasted('C:\\Users\\a\\Notes\\..\\x.md', root, notes, 'win32'), null)
  assert.equal(resolvePasted('Daily\\x.md', root, notes, 'win32'), 'Daily/x.md', '相対パスも区切りをそろえる')
  assert.equal(resolvePasted('C:\\Users\\a\\Notes\\Daily\\x.md', root, notes), null, 'Macでは使わない')
  assert.equal(resolvePasted('/Users/x/Vault/Home.md', ['/Users/x/Vault'], notes, 'darwin'), 'Home.md')
  assert.equal(resolvePasted('/users/x/vault/Home.md', ['/Users/x/Vault'], notes, 'darwin'), null, 'Macでは大文字と小文字を区別する')
})

test('入力した名前から新しいノートの場所を作る', () => {
  assert.equal(newNotePath('メモ', '日記'), '日記/メモ.md')
  assert.equal(newNotePath('  メモ.md ', '日記'), '日記/メモ.md', '前後の空白と拡張子は付け直す')
  assert.equal(newNotePath('a:b\\c', '日記'), '日記/a-b-c.md', 'ファイル名に使えない文字は置き換える')
  assert.equal(newNotePath('メモ', ''), 'メモ.md', '一番上なら先頭に「/」を付けない')
  assert.equal(newNotePath('', '日記'), null)
  assert.equal(newNotePath('.隠し', '日記'), null)
  assert.equal(newNotePath('a/b', '日記'), null, 'パスのように見える文字からは作らない')
  const notes = ['日記/Memo.md', '日記/がぎ.md'.normalize('NFD')]
  assert.equal(newNotePath('memo', '日記', notes), null, 'Macでは大文字と小文字を区別しない')
  assert.equal(newNotePath('がぎ', '日記', notes), null, '濁点の持ち方が違っても同じノート')
  assert.equal(newNotePath('memo', '', notes), 'memo.md', 'ほかのフォルダーの同じ名前は別のノート')
})

test('新しいノートを置ける場所は、ノートのあるフォルダーとその上のフォルダー', () => {
  const notes = ['top.md', '日記/2026/11/今日.md', '日記/まとめ.md', 'b/x.md']
  assert.deepEqual(noteFolders(notes), ['', 'b', '日記', '日記/2026', '日記/2026/11'])
  assert.deepEqual(noteFolders([]), [''])
})

test('最初に選んでおく場所は、いま開いているノートのフォルダー', () => {
  const folders = ['', '日記', '日記/2026']
  assert.equal(defaultNoteDir('日記/2026/今日.md', folders), '日記/2026')
  assert.equal(defaultNoteDir('top.md', folders), '')
  assert.equal(defaultNoteDir('データ/今日.md'.normalize('NFD'), ['', 'データ']), 'データ', '濁点の持ち方が違っても同じフォルダー')
  assert.equal(defaultNoteDir(null, folders), '')
  assert.equal(defaultNoteDir('archives/old.md', folders), '', '一覧にないフォルダーのノートなら一番上')
})

test('名前と場所を確かめて、作るノートか、作れない理由を返す', () => {
  const notes = ['日記/メモ.md']
  assert.deepEqual(checkNewNote(' 新しい ', '日記', notes), { path: '日記/新しい.md' })
  assert.deepEqual(checkNewNote('', '日記', notes), { error: '名前を入れてください。' })
  assert.deepEqual(checkNewNote('a/b', '日記', notes), { error: '名前に「/」は使えません。場所は下で選んでください。' })
  assert.deepEqual(checkNewNote('.隠し', '日記', notes), { error: '点で始まる名前は使えません。' })
  assert.deepEqual(checkNewNote('メモ', '日記', notes), { error: 'この場所には同じ名前のノートがあります。' })
})

test('置き場所を選ぶ画面：1つ下の階層、名前で探す、最近の場所、空のフォルダー', async () => {
  const { buildTree, childFolders, rememberPlace, searchFolders } = await import('../src/files.mjs')
  const folders = ['日記', '日記/2026', '日記/2026/11', 'プロジェクト', 'プロジェクト/2026', '空']
  assert.deepEqual(childFolders(folders, ''), ['日記', 'プロジェクト', '空'])
  assert.deepEqual(childFolders(folders, '日記'), ['日記/2026'])
  assert.deepEqual(childFolders(folders, '日記/2026/11'), [])
  // 名前に含むものを先に、場所だけに含むものを後に出す。
  assert.deepEqual(searchFolders(folders, '2026'), ['日記/2026', 'プロジェクト/2026', '日記/2026/11'])
  assert.deepEqual(searchFolders(folders, '  '), [])
  assert.deepEqual(rememberPlace(['a', 'b', 'c', 'd', 'e'], 'c'), ['c', 'a', 'b', 'd', 'e'])
  assert.deepEqual(rememberPlace(['a', 'b', 'c', 'd', 'e'], 'f'), ['f', 'a', 'b', 'c', 'd'])
  const tree = buildTree(['日記/a.md'], ['空', '日記/2026'])
  assert.deepEqual(tree.folders.map((f) => f.name).sort(), ['日記', '空'].sort())
  assert.deepEqual(tree.folders.find((f) => f.name === '日記').folders.map((f) => f.path), ['日記/2026'])
})

test('動かす計画が断られた理由を見分ける', () => {
  assert.equal(planFailure(409, { error: 'list-truncated' }), 'truncated')
  assert.equal(planFailure(409, { error: 'exists' }), 'exists')
  assert.equal(planFailure(409, undefined), 'exists')
  assert.equal(planFailure(500, { error: 'x' }), 'other')
})
