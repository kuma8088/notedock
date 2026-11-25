import test from 'node:test'
import assert from 'node:assert/strict'

import { collectDescendants, confirmedChildren, deleteChoices, deleteQuestion, deletedText, findTask, isUnderTaskFolder, linkRows, planUnlinkInNote, relocateLink, sourceLinkNote, sourceNoteOf, taskLinksIn, trashFailedNotice, trashFailedText, unlinkedTrashCheck, unlinkRange, unsavedBlockText } from '../src/task-delete.mjs'
import { linkRefsIn } from '../src/task-unlinked.mjs'

const T = (path, parentPath = null, title = '') => ({ path, parentPath, title })

test('子孫を集める：子・孫・深い・別の親', () => {
  const tasks = [
    T('Tasks/root.md'),
    T('Tasks/a.md', 'Tasks/root.md'),
    T('Tasks/b.md', 'Tasks/root.md'),
    T('Tasks/a1.md', 'Tasks/a.md'),
    T('Tasks/a1x.md', 'Tasks/a1.md'),
    T('Tasks/other.md'),
    T('Tasks/other-child.md', 'Tasks/other.md'),
  ]
  assert.deepEqual(collectDescendants(tasks, 'Tasks/root.md').map((t) => t.path), ['Tasks/a.md', 'Tasks/b.md', 'Tasks/a1.md', 'Tasks/a1x.md'])
  assert.deepEqual(collectDescendants(tasks, 'Tasks/other.md').map((t) => t.path), ['Tasks/other-child.md'])
  assert.deepEqual(collectDescendants(tasks, 'Tasks/b.md'), [])
})

test('子孫を集める：深い階層でも全部たどる', () => {
  const tasks = [T('Tasks/0.md')]
  for (let i = 1; i <= 50; i++) tasks.push(T('Tasks/' + i + '.md', 'Tasks/' + (i - 1) + '.md'))
  assert.equal(collectDescendants(tasks, 'Tasks/0.md').length, 50)
})

test('子孫を集める：輪になっていても止まり、自分は入れない', () => {
  const tasks = [T('Tasks/x.md', 'Tasks/z.md'), T('Tasks/y.md', 'Tasks/x.md'), T('Tasks/z.md', 'Tasks/y.md'), T('Tasks/self.md', 'Tasks/self.md')]
  assert.deepEqual(collectDescendants(tasks, 'Tasks/x.md').map((t) => t.path), ['Tasks/y.md', 'Tasks/z.md'])
  assert.deepEqual(collectDescendants(tasks, 'Tasks/self.md'), [])
})

test('子孫を集める：大文字小文字・濁点の持ち方・.md の有無をそろえて比べる', () => {
  const nfd = 'Tasks/ダイ.md'.normalize('NFD')
  const tasks = [T('Tasks/ダイ.md'), T('Tasks/c.md', nfd), T('Tasks/d.md', 'tasks/C')]
  assert.deepEqual(collectDescendants(tasks, 'Tasks/ダイ.md').map((t) => t.path), ['Tasks/c.md', 'Tasks/d.md'])
  assert.equal(findTask(tasks, 'TASKS/c').path, 'Tasks/c.md')
  assert.equal(findTask(tasks, 'Tasks/none.md'), null)
})

test('Tasks の下か', () => {
  assert.equal(isUnderTaskFolder('Tasks/a.md'), true)
  assert.equal(isUnderTaskFolder('tasks/sub/a.md'), true)
  assert.equal(isUnderTaskFolder('MyTasks/a.md'), false)
  assert.equal(isUnderTaskFolder('Tasks.md'), false)
})

// 行の中のリンクを外した結果。
const cut = (line, linkText, nth = 0) => {
  let at = -1
  for (let i = 0; i <= nth; i++) at = line.indexOf(linkText, at + 1)
  const r = unlinkRange(line, 100, 100 + at, 100 + at + linkText.length)
  return line.slice(0, r.from - 100) + line.slice(r.to - 100)
}
const L = '[[Tasks/a|→タスク]]'

test('リンクを外す位置：行末なら前の空白も外す', () => {
  assert.equal(cut('- 目標の文 ' + L, L), '- 目標の文')
  assert.equal(cut('- 目標の文\t ' + L, L), '- 目標の文')
  assert.equal(cut('> - [ ] 引用の中 ' + L, L), '> - [ ] 引用の中')
})

test('リンクを外す位置：行の途中なら前の空白とリンクだけ', () => {
  assert.equal(cut('- 目標 ' + L + ' 続き', L), '- 目標 続き')
  // リンクのあとに空白が2つ（改行の印）があっても、そのまま残す。
  assert.equal(cut('- 目標 ' + L + '  ', L), '- 目標  ')
})

test('リンクを外す位置：箇条書きの記号やチェックボックスのすぐ後ろなら、記号の空白を残す', () => {
  assert.equal(cut('- ' + L, L), '- ')
  assert.equal(cut('- [ ] ' + L + ' 続き', L), '- [ ] 続き')
  assert.equal(cut('\t- ' + L, L), '\t- ')
  assert.equal(cut(L + ' 文', L), '文')
})

test('リンクを外す位置：前の文字にくっついていれば、リンクだけ', () => {
  assert.equal(cut('- 目標' + L, L), '- 目標')
  assert.equal(cut('- 目標 ' + L + '。', L), '- 目標 。')
})

test('リンクを外す位置：同じ行に2つあれば、指したほうだけ', () => {
  const two = '- A ' + L + ' B ' + L
  assert.equal(cut(two, L, 0), '- A B ' + L)
  assert.equal(cut(two, L, 1), '- A ' + L + ' B')
})

test('リンクを外す位置：範囲が行の外なら null', () => {
  assert.equal(unlinkRange('- a', 0, 5, 9), null)
  assert.equal(unlinkRange('- a', 0, 2, 2), null)
})

const known = new Set(['Tasks/a.md', 'Tasks/b.md', '90_Periodic/2026/Monthly/2026-11.md', 'a.md'])
const MONTH = '90_Periodic/2026/Monthly/2026-11.md'

test('goal・parent のノートの中のリンク：ちょうど1つなら外す変更', () => {
  const text = ['---', 'type: monthly', '---', '## ターゲット', '- 目標 [[Tasks/a|→タスク]]', '- 別 [[Tasks/b|→タスク]]'].join('\n')
  const plan = planUnlinkInNote(text, MONTH, 'Tasks/a.md', known)
  assert.equal(plan.count, 1)
  const after = text.slice(0, plan.change.from) + text.slice(plan.change.to)
  assert.equal(after.split('\n')[4], '- 目標')
  assert.equal(after.split('\n')[5], '- 別 [[Tasks/b|→タスク]]')
})

test('goal・parent のノートの中のリンク：0 か 2つ以上なら外さない', () => {
  assert.deepEqual(planUnlinkInNote('- なし', MONTH, 'Tasks/a.md', known), { count: 0, change: null })
  const two = '- 1 [[Tasks/a|→タスク]]\n- 2 [[Tasks/a]]'
  assert.deepEqual(planUnlinkInNote(two, MONTH, 'Tasks/a.md', known), { count: 2, change: null })
})

test('goal・parent のノートの中のリンク：プロパティ・コード・埋め込みは数えない。Markdown のリンクは数える', () => {
  const text = ['---', 'parent: "[[Tasks/a]]"', '---', '\x60\x60\x60', '[[Tasks/a]]', '\x60\x60\x60', '![[Tasks/a]]', '- [リンク](../../../Tasks/a.md)'].join('\n')
  const links = taskLinksIn(text, MONTH, 'Tasks/a.md', known)
  assert.equal(links.length, 1)
  assert.equal(links[0].text, '[リンク](../../../Tasks/a.md)')
})

test('goal・parent のノートの中のリンク：名前だけのリンクも、今のエディターと同じ規則で解決する', () => {
  // Tasks/a と、一番上の a.md がある。月のノートからの [[a]] は一番上の a.md を指すので、Tasks/a へのリンクではない。
  assert.equal(taskLinksIn('- [[a]]', MONTH, 'Tasks/a.md', known).length, 0)
  assert.equal(taskLinksIn('- [[a]]', 'Tasks/parent.md', 'Tasks/a.md', known).length, 1)
})

test('確認のあいだに文書が変わったら、リンクを見つけ直す', () => {
  const ctx = { notePath: MONTH, taskPath: 'Tasks/a.md', known }
  const text = '- 目標 [[Tasks/a|→タスク]]'
  const at = { from: 5, to: text.length, linkText: '[[Tasks/a|→タスク]]' }
  assert.equal(relocateLink(text, at, ctx).from, 5)
  const shifted = '- 追加\n' + text
  assert.equal(relocateLink(shifted, at, ctx).from, 5 + 5)
  assert.equal(relocateLink('- 目標', at, ctx), null)
  assert.equal(relocateLink(text + '\n' + text, { ...at, from: 0 }, ctx), null)
})

test('リンクを外しに行くノート：parent があれば親、なければ goal', () => {
  assert.deepEqual(sourceNoteOf({ path: 'Tasks/x.md', goal: '[[90_Periodic/2026/Monthly/2026-11]]', parent: '[[Tasks/a]]' }, known), { kind: 'parent', path: 'Tasks/a.md', exists: true })
  assert.deepEqual(sourceNoteOf({ path: 'Tasks/x.md', goal: '[[90_Periodic/2026/Monthly/2026-11]]', parent: '' }, known), { kind: 'goal', path: MONTH, exists: true })
  assert.equal(sourceNoteOf({ path: 'Tasks/x.md', goal: '', parent: '' }, known), null)
  assert.equal(sourceNoteOf({ path: 'Tasks/x.md', goal: '[[消えたノート]]' }, known).exists, false)
})

test('知らせの文', () => {
  assert.match(deleteQuestion({ title: 'T' }), /タスク「T」をゴミ箱へ移します。\n行のリンクも外します。/)
  assert.match(deleteQuestion({ title: 'T', childCount: 2 }), /サブタスクが2件あります/)
  assert.match(deleteQuestion({ title: 'T', unlink: 'none-count', sourceName: '2026-11', linkCount: 2 }), /2つある/)
  assert.match(deleteQuestion({ title: 'T', unlink: 'none-source' }), /goal も parent もない/)
  assert.deepEqual(deleteChoices(0).map((c) => c.value), ['root'])
  assert.deepEqual(deleteChoices(3).map((c) => c.value), ['all', 'root'])
  assert.ok(deleteChoices(3).every((c) => c.label.length <= 5))
  assert.match(deletedText({ title: 'T', movedChildren: 1 }), /とサブタスク1件をゴミ箱へ移しました。.*ノートはゴミ箱にあります/)
  assert.match(deletedText({ title: 'T', undo: false, unlinked: true }), /リンクも外しました。ノートはゴミ箱にあります。$/)
  assert.doesNotMatch(deletedText({ title: 'T', undo: false, unlinked: false }), /元に戻す|リンクも/)
  assert.match(trashFailedText(['Tasks/a.md']), /1件/)
})

// ---- E1 のレビューの小1〜小5 ----

test('確認の文：参照のリンクから消すときは、行のリンクとリンク元の扱いの両方を書く', () => {
  const both = deleteQuestion({ title: 'T', unlink: 'line', also: { unlink: 'source', sourceName: '2026-11' } })
  assert.match(both, /行のリンクも外します。\nリンク元の「2026-11」の中のリンクも外します。/)
  assert.match(deleteQuestion({ title: 'T', unlink: 'line', also: { unlink: 'none-count', sourceName: '2026-11', linkCount: 2 } }), /行のリンクも外します。\n「2026-11」の中にこのタスクへのリンクが2つある/)
  assert.match(deleteQuestion({ title: 'T', unlink: 'line', also: { unlink: 'none-missing' } }), /リンク元のノートが見つからない/)
  // also がなければ、今までどおり行のリンクだけ
  assert.equal(deleteQuestion({ title: 'T' }), 'タスク「T」をゴミ箱へ移します。\n行のリンクも外します。')
})

test('確認の文：リンク元が編集できないときの種類（none-editable）', () => {
  assert.match(deleteQuestion({ title: 'T', unlink: 'none-editable', sourceName: '2026-11' }), /「2026-11」は編集できないノートなので、その中のリンクは外しません。/)
  assert.match(deleteQuestion({ title: 'T', unlink: 'line', also: { unlink: 'none-editable', sourceName: 'P' } }), /行のリンクも外します。\n「P」は編集できない/)
})

test('知らせ：Cmd+Z は keyLabel を通す。リンク元のリンクも外したら書き添える', () => {
  const ctrl = (text) => text.replace(/\bCmd\+/g, 'Ctrl+')
  assert.match(deletedText({ title: 'T', keyLabel: ctrl }), /Ctrl\+Z/)
  assert.doesNotMatch(deletedText({ title: 'T', keyLabel: ctrl }), /Cmd/)
  assert.match(deletedText({ title: 'T', sourceName: '2026-11' }), /「2026-11」の中のリンクも外しました（こちらは「元に戻す」では戻りません）/)
  assert.match(deletedText({ title: 'T', undo: false, unlinked: true, sourceName: 'P' }), /リンクも外しました。「P」の中のリンクも外しました/)
})

test('ゴミ箱へ移せなかったとき：行のリンクを外していれば「元に戻す」で戻せることを添える', () => {
  const ctrl = (text) => text.replace(/\bCmd\+/g, 'Ctrl+')
  const lineFailed = trashFailedNotice({ failed: ['Tasks/a.md'], rootMoved: false, unlinked: true, undo: true, keyLabel: ctrl })
  assert.match(lineFailed, /^リンクは外しましたが、ゴミ箱へ移せなかった/)
  assert.match(lineFailed, /「元に戻す」（Ctrl\+Z）で、外したリンクを戻せます。$/)
  // ノートのほうから消したとき（履歴にない）は、戻し方を書かない
  assert.doesNotMatch(trashFailedNotice({ failed: ['Tasks/a.md'], rootMoved: false, unlinked: true, undo: false }), /元に戻す/)
  // 子だけ失敗したとき（タスク自身は移せた）は、失敗したものだけ
  assert.equal(trashFailedNotice({ failed: ['Tasks/b.md'], rootMoved: true, unlinked: true, undo: true }), trashFailedText(['Tasks/b.md']))
})

// ---- E2 のレビューの指摘（中2・小5・小6・小9） ----

test('リンクを探す：行内コードと HTML のコメントの中は数えない。位置は元の文書のまま', () => {
  const text = '- `[[Tasks/a]]` と <!-- [[Tasks/a]] --> と [[Tasks/a|→タスク]]\n<!--\n[[Tasks/a]]\n-->'
  const links = taskLinksIn(text, MONTH, 'Tasks/a.md', known)
  assert.equal(links.length, 1)
  assert.equal(text.slice(links[0].from, links[0].to), '[[Tasks/a|→タスク]]')
  assert.equal(links[0].lineText, text.split('\n')[0])
  assert.equal(linkRows('a `b` <!-- c --> d')[0].scan.length, 'a `b` <!-- c --> d'.length)
})

test('ゴミ箱へ移せなかったとき：リンク元のリンクも外していれば、タスク自身を移せなかったときだけ書き添える', () => {
  const failed = trashFailedNotice({ failed: ['Tasks/a.md'], rootMoved: false, unlinked: true, undo: true, sourceName: '2026-11' })
  assert.match(failed, /「元に戻す」（Cmd\+Z）で、外したリンクを戻せます。\n「2026-11」の中のリンクは外しました（「元に戻す」では戻りません）。$/)
  assert.doesNotMatch(trashFailedNotice({ failed: ['Tasks/b.md'], rootMoved: true, unlinked: true, undo: true, sourceName: '2026-11' }), /2026-11/)
  assert.equal(sourceLinkNote(''), '')
  assert.match(sourceLinkNote('P'), /^\n「P」の中のリンクは外しました/)
})

test('一覧の「ゴミ箱へ」：読み直した一覧で、まだ外れているときだけ移す', () => {
  const list = [{ path: 'Tasks/a.md', unlinked: true }, { path: 'Tasks/b.md', unlinked: false }]
  assert.equal(unlinkedTrashCheck(list, 'tasks/A.md').ok, true)
  assert.equal(unlinkedTrashCheck(list, 'Tasks/a.md').task.path, 'Tasks/a.md')
  assert.match(unlinkedTrashCheck(list, 'Tasks/b.md').message, /もうリンクが外れたタスクではない/)
  assert.match(unlinkedTrashCheck(list, 'Tasks/x.md').message, /もうリンクが外れたタスクではない/)
  assert.match(unlinkedTrashCheck(null, 'Tasks/a.md').message, /一覧を読めなかった/)
})

test('閉じていない <!-- のあとのリンク：行の途中なら数え、行頭なら（CommonMark の HTML のかたまり）数えない。表示名に行内コードがあっても、見つけたリンクの文字は元のまま', () => {
  assert.equal(taskLinksIn('文中に <!-- 閉じない\n- [[Tasks/a]]\n', MONTH, 'Tasks/a.md', known).length, 1)
  assert.equal(taskLinksIn('<!-- 閉じない\n- [[Tasks/a]]\n', MONTH, 'Tasks/a.md', known).length, 0)
  const text = '- [[Tasks/a|`x` の作業]]'
  const [link] = taskLinksIn(text, MONTH, 'Tasks/a.md', known)
  assert.equal(link.text, '[[Tasks/a|`x` の作業]]')
  // 位置がずれた文書でも、同じ文字で見つけ直せる
  assert.ok(relocateLink('先頭\n' + text, { from: link.from, to: link.to, linkText: link.text }, { notePath: MONTH, taskPath: 'Tasks/a.md', known }))
})

// ---- E2 の再レビューの指摘（小1）：HTML のコメントを CommonMark（プレビュー）と同じに見分ける ----

test('HTML のコメント：行の途中の <!-- は、同じ段落の中で閉じるときだけ。行頭の <!-- は --> のある行まで', () => {
  const count = (text) => taskLinksIn(text, MONTH, 'Tasks/a.md', known).length
  const cases = [
    // 行の途中の <!-- が、空行のあと（別の段落）の --> で閉じたことにならない
    ['文中に <!-- と書いた\n\n- [[Tasks/a]]\n\nA --> B\n', 1],
    // 同じ段落の中なら、行をまたいで閉じる
    ['a <!-- b\n[[Tasks/a]] -->\n', 0],
    ['a <!--\nx\n--> [[Tasks/a]]\n', 1],
    // 段落は、見出し・箇条書きの次の項目で終わる。見出しの中のコメントはその行だけ
    ['a <!-- b\n- [[Tasks/a]] -->\n', 1],
    ['# 見出し <!-- x\n[[Tasks/a]] -->\n', 1],
    ['- [ ] <!-- x\n- [[Tasks/a]]\n-->\n', 1],
    // > を省いて続けた行も、引用の中の同じ段落
    ['> a <!-- x\n[[Tasks/a]] -->\n', 0],
    // 行頭の <!-- は、空行をまたいで --> のある行（その行は全部）まで。閉じなければ文書の終わりまで
    ['<!--\n\n- [[Tasks/a]]\n\n-->\n', 0],
    ['<!-- x --> [[Tasks/a]]\n', 0],
    ['<!--\nx\n--> [[Tasks/a]]\n', 0],
    ['a\n<!-- c -->\n- [[Tasks/a]]\n', 1],
    // 入っている引用・箇条書きの項目が終われば、そこで終わる
    ['> <!-- x\n[[Tasks/a]]\n-->\n', 1],
    ['- <!-- x\n- [[Tasks/a]]\n-->\n', 1],
    ['- a\n  <!-- x\n- [[Tasks/a]]\n-->\n', 1],
    ['  <!-- x\n[[Tasks/a]]\n-->\n', 0],
    // > や字下げを省いて続けた行なら、箇条書きの項目は続いている（項目の中の <!-- は、項目が終わるまで）
    ['- a\n-->\n  <!-- w\n  [[Tasks/a]]\n[[Tasks/a]]\n', 1],
    // HTML のかたまりの中の ``` はコードの囲みにならない。かたまりのあとの ``` は囲み
    ['<!--\n```\n-->\n- [[Tasks/a]]\n', 1],
    ['<!-- x\n```\n-->\n```\n- [[Tasks/a]]\n', 0],
    // 行内コードが先なら、その中の <!-- はコメントにならない。<!--> と <!---> は、それだけで閉じたコメント
    ['`<!--` [[Tasks/a]] -->\n', 1],
    ['a <!--> [[Tasks/a]]\n', 1],
    ['a <!---> [[Tasks/a]]\n', 1],
    // 行末が CRLF でも同じ
    ['a\r\n<!-- c -->\r\n- [[Tasks/a]]\r\n', 1],
  ]
  for (const [text, want] of cases) {
    assert.equal(count(text), want, JSON.stringify(text))
    // 判定（linkRefsIn）も同じ数え方
    assert.equal(linkRefsIn(text).filter((ref) => ref.wiki === 'Tasks/a').length, want, JSON.stringify(text))
  }
  // scan の長さは行のまま（見つけた位置をそのまま文書の位置に使う）
  for (const row of linkRows('a <!-- b\nc --> d\n<!--\ne\n-->')) assert.equal(row.scan.length, row.text.length)
})

// ---- E2 の再レビューの指摘（小3・小4） ----

test('一覧の「ゴミ箱へ」の「すべて」：確認の文で数えた子だけを移す（確認の間に増えた子・ほかへ移った子は移さない）', () => {
  const before = [T('Tasks/root.md'), T('Tasks/a.md', 'Tasks/root.md'), T('Tasks/b.md', 'Tasks/root.md')]
  const confirmed = collectDescendants(before, 'Tasks/root.md')
  assert.equal(confirmed.length, 2)
  // 確認の間に c が増え、b はほかの親へ移った
  const after = [T('Tasks/root.md'), T('Tasks/A.md', 'Tasks/root.md'), T('Tasks/b.md', 'Tasks/other.md'), T('Tasks/c.md', 'Tasks/root.md'), T('Tasks/other.md')]
  assert.deepEqual(confirmedChildren(confirmed, collectDescendants(after, 'Tasks/root.md')).map((task) => task.path), ['Tasks/A.md'])
  assert.deepEqual(confirmedChildren([], collectDescendants(after, 'Tasks/root.md')), [])
})

test('一覧の「ゴミ箱へ」：止めるのは、判定に関わるノートの保存が止まっているときだけ。どの枠のどのノートかを書く', () => {
  const task = { path: 'Tasks/a.md', goal: '[[90_Periodic/2026/Monthly/2026-11]]', parent: '[[Tasks/p]]' }
  const knownHere = new Set([MONTH, 'Tasks/a.md', 'Tasks/p.md', 'Notes/x.md'])
  const check = (stuck, opts = {}) => unsavedBlockText(stuck, { paths: ['Tasks/a.md'], task, known: knownHere, split: true, ...opts })
  // 関係のないノートなら止めない
  assert.equal(check([{ pane: 'right', path: 'Notes/x.md' }]), '')
  assert.equal(check([]), '')
  // 移すタスク・goal・parent のノートなら止める
  assert.match(check([{ pane: 'right', path: 'tasks/A.md' }]), /^右の枠の「A」に、まだ保存できていない変更があります。/)
  assert.match(check([{ pane: 'left', path: MONTH }]), /^左の枠の「2026-11」に、/)
  assert.match(check([{ pane: 'left', path: 'Tasks/p.md' }, { pane: 'right', path: 'Notes/x.md' }]), /^左の枠の「p」に、/)
  // 移すサブタスク（paths に入れたもの）も
  assert.match(check([{ pane: 'right', path: 'Tasks/c.md' }], { paths: ['Tasks/a.md', 'Tasks/c.md'] }), /^右の枠の「c」に、/)
  // 両方なら両方。右の枠が開いていなければ、枠は書かない
  assert.match(check([{ pane: 'left', path: MONTH }, { pane: 'right', path: 'Tasks/a.md' }]), /^左の枠の「2026-11」と、右の枠の「a」に、/)
  assert.match(check([{ pane: 'left', path: MONTH }], { split: false }), /^開いている「2026-11」に、/)
})

// ---- E2 の3回目のレビュー：リンクの数え方を、プレビューと同じ Markdown の読み取り（@lezer/markdown）に合わせる ----

test('リンクの数え方はプレビューの読み取りと同じ：引用・HTML のかたまり・下線の見出し・表・\\<!-- ・箇条書きの中の引用', () => {
  const count = (text) => taskLinksIn(text, MONTH, 'Tasks/a.md', known).length
  const refs = (text) => linkRefsIn(text).filter((ref) => ref.wiki === 'Tasks/a').length
  const cases = [
    // 1. 引用の中で始まったコメントのかたまりは、> のない空行で終わる（引用が終わる）
    ['> <!-- x\n\n> [[Tasks/a]]\n', 1],
    // 2. <div> などの HTML のかたまりの中の行頭の <!-- は、コメントの始まりではない（かたまりは空行で終わる）
    ['<div>\n<!-- x\n\n[[Tasks/a]]\n', 1],
    // HTML のかたまりの中のリンクは、プレビューでもリンクにならない（文字のまま）
    ['<div>\n[[Tasks/a]]\n</div>\n', 0],
    // 3. = の下線の見出しと、段落を切る <div> の行で段落が終わる（行の途中の <!-- は閉じない）
    ['a <!-- x\n===\n[[Tasks/a]] -->', 1],
    ['a <!-- x [[Tasks/a]]\n<div>\n-->', 1],
    // 4. 表は、セルごとに読む。セルをまたぐ <!-- はコメントにならない
    ['| <!-- x | [[Tasks/a]] |\n| --- | --- |\n| --> | y |\n', 1],
    ['| a | b |\n| --- | --- |\n| <!-- x | [[Tasks/a]] |\n| --> | y |\n', 1],
    // 区切りの行（| --- |）がなければ表ではなく段落。段落の中では、行をまたいで閉じたコメント
    ['| <!-- x | [[Tasks/a]] |\n| --> | y |', 0],
    // 5. \\ の付いた <!-- は、ただの文字
    ['\\<!-- x [[Tasks/a]] -->', 1],
    // 6. 箇条書きの中の引用で始まったコメントのかたまりは、次の行の引用に続く
    ['- > <!-- x\n  > [[Tasks/a]]', 0],
    // 字下げ4つのコードの中は数えない。箇条書きの中の字下げは、コードではない
    ['    [[Tasks/a]]\n', 0],
    ['- a\n    [[Tasks/a]]\n', 1],
  ]
  for (const [text, want] of cases) {
    assert.equal(count(text), want, JSON.stringify(text))
    assert.equal(refs(text), want, JSON.stringify(text))
  }
  // 6. 隠れたリンクは外さない（見えるリンクがなければ、外すものは0）
  assert.deepEqual(planUnlinkInNote('- > <!-- x\n  > [[Tasks/a]]', MONTH, 'Tasks/a.md', known), { count: 0, change: null })
  // 見えるリンクだけを外す（隠れたほうはそのまま）
  const text = '- > <!-- x\n  > [[Tasks/a]]\n  > -->\n- 見る [[Tasks/a]]\n'
  const plan = planUnlinkInNote(text, MONTH, 'Tasks/a.md', known)
  assert.equal(plan.count, 1)
  assert.equal(text.slice(0, plan.change.from) + text.slice(plan.change.to), '- > <!-- x\n  > [[Tasks/a]]\n  > -->\n- 見る\n')
  // scan の長さは行のまま
  for (const row of linkRows('> <!-- x\n\n> [[Tasks/a]]\n\x60\x60\x60\n[[Tasks/a]]\n\x60\x60\x60\n')) assert.equal(row.scan.length, row.text.length)
})

// ---- E2 の4回目のレビュー：処理命令 <?…?> と、%% のコメントの中のコードなど ----

test('リンクの数え方：処理命令 <?…?> の中は数えない。%% のコメントの中は数えるが、%% がなければコードやコメントになる部分は数えない', () => {
  const count = (text) => taskLinksIn(text, MONTH, 'Tasks/a.md', known).length
  const refs = (text) => linkRefsIn(text).filter((ref) => ref.wiki === 'Tasks/a').length
  const cases = [
    // 1. 行頭の <? は、?> がなければ文書の終わりまで処理命令（プレビューでは文字のまま）
    ['<?php\n[[Tasks/a]]', 0],
    ['<?php echo 1 ?>\n[[Tasks/a]]', 1],
    ['x <?pi [[Tasks/a]] ?> y', 0],
    // 2. 行頭の閉じない %% の中でも、コードの囲みと HTML のコメントの中は数えない（閉じた %% でも、行の中の %% でも同じ）
    ['%%\n\x60\x60\x60\n[[Tasks/a]]\n\x60\x60\x60', 0],
    ['%%\n<!--\n[[Tasks/a]]\n-->', 0],
    ['%%\n\x60\x60\x60\n[[Tasks/a]]\n\x60\x60\x60\n%%', 0],
    ['%%\x60[[Tasks/a]]\x60%%', 0],
    ['%% <!-- [[Tasks/a]] --> %%', 0],
    // 読み直すのはコメントの部分だけ。閉じた %% のあとは、コメントの中の \x60\x60\x60 に続かない（プレビューでもリンク）
    ['%%\n\x60\x60\x60\n%%\n[[Tasks/a]]', 1],
    // 今の方針のまま：%% のコメントと数式の中のリンクは数える
    ['%%\n[[Tasks/a]]', 1],
    ['%%[[Tasks/a]]%%', 1],
    ['$[[Tasks/a]]$', 1],
  ]
  for (const [text, want] of cases) {
    assert.equal(count(text), want, JSON.stringify(text))
    assert.equal(refs(text), want, JSON.stringify(text))
  }
  // 処理命令の中のリンクは外さない（見えるリンクだけを外す）
  assert.deepEqual(planUnlinkInNote('<?php\n[[Tasks/a]]', MONTH, 'Tasks/a.md', known), { count: 0, change: null })
  const text = '見る [[Tasks/a]]\n<?php\n[[Tasks/a]]'
  const plan = planUnlinkInNote(text, MONTH, 'Tasks/a.md', known)
  assert.equal(plan.count, 1)
  assert.equal(text.slice(0, plan.change.from) + text.slice(plan.change.to), '見る\n<?php\n[[Tasks/a]]')
  // %% のコメントの中のコードの囲みの中のリンクも外さない
  const pct = '%%\n\x60\x60\x60\n[[Tasks/a]]\n\x60\x60\x60\n%%\n見る [[Tasks/a]]\n'
  const plan2 = planUnlinkInNote(pct, MONTH, 'Tasks/a.md', known)
  assert.equal(plan2.count, 1)
  assert.equal(pct.slice(0, plan2.change.from) + pct.slice(plan2.change.to), '%%\n\x60\x60\x60\n[[Tasks/a]]\n\x60\x60\x60\n%%\n見る\n')
  for (const row of linkRows(pct)) assert.equal(row.scan.length, row.text.length)
})
