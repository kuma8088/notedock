// タスクのノート（1つのタスクを1つのノートにしたもの）の決まりごと。DOM に頼らない。
import { parseFrontmatter, setProperty } from './yaml-lite.mjs'

// ステータスの値。並びはプルダウンの順。値を変えるときはここだけを直す。
export const TASK_STATUSES = Object.freeze(['未着手', '進行中', '完了', '保留'])
export const TASK_DEFAULT_STATUS = TASK_STATUSES[0]
export const TASK_TYPE = 'task'
export const TASK_DATE_KEYS = Object.freeze(['start', 'due'])
// 閲覧の表示のままでも直せる項目。
export const TASK_QUICK_KEYS = Object.freeze(['status', ...TASK_DATE_KEYS])
// プロパティの並び順。
const TASK_KEYS = ['title', 'type', 'status', 'start', 'due', 'goal', 'parent']

const DATE = /^\d{4}-\d{2}-\d{2}$/

// parseFrontmatter の items から、type: task のノートかを見分ける。
export function isTaskItems(items) {
  const type = items?.find((item) => item.key === 'type')
  return typeof type?.value === 'string' && type.value.trim() === TASK_TYPE
}

// ノート全体（またはプロパティの部分だけ）の文字から見分ける。
export function isTaskNote(text) {
  const front = String(text ?? '').match(/^---\n[\s\S]*?\n---(?=\n|$)/)
  return front ? isTaskItems(parseFrontmatter(front[0]).items) : false
}

// タスクのノートで、その項目をどの欄で出すか。null なら、ほかのノートと同じ決め方にする。
export function taskFieldKind(key, value) {
  if (Array.isArray(value)) return null
  if (key === 'title') return 'text'
  if (key === 'status') return 'status'
  // 値が空か日付のときだけ日付の欄にする。それ以外（行末のコメントつきなど）は文字のまま見せて、隠さない。
  if (TASK_DATE_KEYS.includes(key) && (value === '' || DATE.test(value))) return 'date'
  return null
}

// プルダウンの選択肢。今の値が4つのどれでもなければ（空も含む）、先頭にそのまま足す。
export function statusOptions(current) {
  const value = typeof current === 'string' ? current : ''
  return TASK_STATUSES.includes(value) ? [...TASK_STATUSES] : [value, ...TASK_STATUSES]
}

// 終わっていないものとして扱うか。知らない値は終わっていないとみなす。
export function isTaskDone(status) {
  return status === '完了'
}

function wikiOf(target) {
  if (!target) return ''
  const text = String(target).trim()
  if (/^\[\[[^\[\]]+\]\]$/.test(text)) return text
  return `[[${text.replace(/\.md$/i, '')}]]`
}

// タスクのノートのプロパティ（先頭の --- から --- まで）を組み立てる。
// goal・parent はリンクにして、引用符で囲む（setProperty が [ で始まる値を囲む）。
export function buildTaskFrontmatter({ title = '', status = TASK_DEFAULT_STATUS, start = '', due = '', goal = '', parent = '' } = {}) {
  const values = { title, type: TASK_TYPE, status, start, due, goal: wikiOf(goal), parent: wikiOf(parent) }
  let source = '---\n---'
  for (const key of TASK_KEYS) {
    // 親がないときは parent を書かない。ほかは空でも欄を残し、あとから日付を入れられるようにする。
    if (key === 'parent' && !values.parent) continue
    if (key === 'goal' && !values.goal) continue
    source = setProperty(source, key, values[key])
  }
  return source
}

// タスクのノートを1つ作るときの中身。本文は空、または渡されたもの。
export function buildTaskNote(props = {}, body = '') {
  const text = buildTaskFrontmatter(props) + '\n'
  return body ? text + body.replace(/^\n+/, '') : text
}

// タスクのノートのプロパティを読む。type: task でなければ null。
export function readTaskProps(text) {
  const front = String(text ?? '').match(/^---\n[\s\S]*?\n---(?=\n|$)/)
  if (!front) return null
  const { items } = parseFrontmatter(front[0])
  if (!isTaskItems(items)) return null
  const get = (key) => {
    const value = items.find((item) => item.key === key)?.value
    return typeof value === 'string' ? value : ''
  }
  return { title: get('title'), status: get('status'), start: get('start'), due: get('due'), goal: get('goal'), parent: get('parent') }
}
