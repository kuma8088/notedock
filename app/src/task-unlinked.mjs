// 「リンクが外れたタスク」（段階1-E2）の判定。DOM にもファイルにも頼らない（読むのはサーバーが渡す）。
// 出すのは、goal や parent があるのに、そのノート（parent があれば親、なければ goal）からのリンクがないものだけ。
// Tasks/ のどれかのノート（自分は除く）からリンクされていれば、外れていないとする（入れ子ごと移したタスクのため）。
// goal も parent もないタスク（サイドバーの「新しいタスク」から作ったもの）は出さない。
// リンクの数え方は task-delete.mjs の taskLinksIn と同じ（先頭のプロパティ・コード・行内コード・HTML のコメントの中と、
// 埋め込みの ![[…]] は数えない。どちらも linkRows を使う）。
import { isExternal, parseWikiLink, resolveHref, resolveWikiTarget } from './links.mjs'
import { linkRows, pathKey, sourceNoteOf } from './task-delete.mjs'

const BOM = String.fromCharCode(0xfeff)

const WIKI = /!?\[\[([^\[\]\n]+)\]\]/g
const MD_LINK = /!?\[[^\]\n]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g

// ノートの本文から、リンクの行き先の書き方だけを取り出す（まだ解決しない。サーバーはファイルが変わったときだけ作り直す）。
// 返り値：[{ wiki: 'Tasks/a' } | { href: '../Tasks/a.md' }]
export function linkRefsIn(text) {
  const refs = []
  // BOM つきのノートでも、先頭のプロパティ（parent: や goal: のリンク）を本文と取り違えないよう、先に外す。
  let normal = String(text ?? '')
  if (normal.startsWith(BOM)) normal = normal.slice(1)
  for (const row of linkRows(normal.replace(/\r\n?/g, '\n'))) {
    for (const match of row.scan.matchAll(WIKI)) {
      if (match[0].startsWith('!')) continue
      const parsed = parseWikiLink(match[1])
      if (parsed?.file) refs.push({ wiki: parsed.file })
    }
    for (const match of row.scan.matchAll(MD_LINK)) {
      if (match[0].startsWith('!') || isExternal(match[1])) continue
      refs.push({ href: match[1] })
    }
  }
  return refs
}

// 取り出したリンクを、notePath から見た行き先のキー（pathKey）の集まりにする。
export function linkedKeys(refs, notePath, known) {
  const out = new Set()
  for (const ref of refs ?? []) {
    const target = ref.wiki !== undefined ? resolveWikiTarget(notePath, ref.wiki, known) : resolveHref(notePath, ref.href)
    if (target?.path) out.add(pathKey(target.path))
  }
  return out
}

// tasks：一覧のタスク（path・goal・parent）。known：Vault のノートの集まり（リンクの解決に使う）。
// refsOf(path)：そのノートのリンク（linkRefsIn の形）。読めない・見つからないときは null。
// taskNotes：Tasks/ の下の全部のノート [{ path, refs }]（type: task でないものも含む）。
// complete：known と Tasks/ の一覧が途中まででないか。途中までのときは、名前だけのリンクを正しく解決できないので、どれも外れたとしない。
// existsOnDisk(path)：known にない元のノートが、ディスクにはあるか（known は少し前の一覧なので、外から作ったばかりのノートのため）。
// 返り値：Map（pathKey(タスクのパス) → 外れているか）。
export function unlinkedMap(tasks, { known, refsOf, taskNotes = [], complete = true, existsOnDisk = () => false }) {
  if (!complete) return new Map((tasks ?? []).filter((task) => task?.path).map((task) => [pathKey(task.path), false]))
  // Tasks/ のノートから、どこへリンクしているか（自分へのリンクは数えないので、出どころも覚える）。
  const fromTasks = new Map()
  for (const note of taskNotes) {
    const from = pathKey(note.path)
    for (const key of linkedKeys(note.refs, note.path, known)) {
      if (key === from) continue
      if (!fromTasks.has(key)) fromTasks.set(key, new Set())
      fromTasks.get(key).add(from)
    }
  }
  const out = new Map()
  for (const task of tasks ?? []) {
    if (!task?.path) continue
    const key = pathKey(task.path)
    out.set(key, isUnlinked(task, key, { known, refsOf, fromTasks, existsOnDisk }))
  }
  return out
}

function isUnlinked(task, key, { known, refsOf, fromTasks, existsOnDisk }) {
  const hasGoal = String(task.goal ?? '').trim() !== ''
  const hasParent = String(task.parent ?? '').trim() !== ''
  if (!hasGoal && !hasParent) return false
  if (fromTasks.has(key)) return false
  const source = sourceNoteOf(task, known)
  if (!source) return true
  if (!source.exists && !existsOnDisk(source.path)) return true
  const refs = refsOf(source.path)
  // あるはずのノートを読めないときは、「外れた」と決めない（一覧からゴミ箱へ移せてしまうため）。
  if (!refs) return false
  return !linkedKeys(refs, source.path, known).has(key)
}
