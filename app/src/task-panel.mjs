// デイリーノートの上に出すタスクのパネル（読み取りだけ）。区分けは task-buckets.mjs、ここは描くだけ。
import { TASK_SECTIONS, TASK_SECTION_LABELS, bucketTasks, dueView, sectionOpenState, statusView, taskLabel } from './task-buckets.mjs'

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const shortDate = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`

// box: パネルの要素。store: { get(key, fallback), set(key, value) }。keyOf(name): 覚える名前（Vault ごと）。
// onOpen(path, event): タスクの名前をクリックしたとき。
export function createTaskPanel({ box, store, keyOf, onOpen }) {
  let last = null
  // 問い合わせの番号。あとから頼んだものがあれば、前の返事は捨てる。
  let request = 0

  const panelOpen = () => store.get(keyOf('task-panel-open'), true) !== false
  const sections = () => sectionOpenState(store.get(keyOf('task-sections'), null))

  function hide() {
    request++
    last = null
    box.hidden = true
    box.replaceChildren()
  }

  function item(task, date) {
    const status = statusView(task.status)
    const due = dueView(task, date)
    const li = el('li', `task-item task-${status.kind}`)
    const open = el('button', 'task-open', taskLabel(task))
    open.type = 'button'
    open.title = task.path
    open.addEventListener('click', (event) => onOpen(task.path, event))
    li.append(open)
    const meta = el('span', 'task-meta')
    if (due.text) meta.append(el('span', due.overdue ? 'task-due task-overdue' : 'task-due', due.overdue ? `${due.text} 期日超過` : due.text))
    if (status.label) meta.append(el('span', `task-status task-status-${status.kind}`, status.label))
    if (meta.childNodes.length) li.append(meta)
    if (task.parentTitle) li.append(el('span', 'task-parent', `親：${taskLabel({ title: task.parentTitle, path: task.parentPath ?? '' })}`))
    return li
  }

  // focusKey: 押したボタンを描き直したあとも、キーで続けて操作できるようにフォーカスを戻す。
  function draw(focusKey = null) {
    if (!last) return
    const { tasks, date, truncated } = last
    const buckets = bucketTasks(tasks, date)
    const open = panelOpen()
    const state = sections()
    const head = el('div', 'task-panel-head')
    const toggle = el('button', 'task-panel-toggle')
    toggle.type = 'button'
    toggle.setAttribute('aria-expanded', String(open))
    toggle.append(el('span', 'task-caret', open ? '▾' : '▸'), el('span', 'task-panel-title', 'タスク'), el('span', 'task-panel-date', `${shortDate(date)} から`))
    toggle.dataset.key = 'panel'
    toggle.addEventListener('click', () => {
      store.set(keyOf('task-panel-open'), !open)
      draw('panel')
    })
    head.append(toggle)
    if (truncated) head.append(el('span', 'task-panel-note', 'タスクのノートが多いため、名前順で先頭の一部だけを数えています'))
    if (!open) {
      const counts = ['soon', 'week', 'month', 'none'].map((key) => `${TASK_SECTION_LABELS[key].replace('のタスク', '')} ${buckets[key].length}`).join('・')
      head.append(el('span', 'task-panel-summary', counts))
    }
    const parts = [head]
    if (open) {
      const body = el('div', 'task-panel-body')
      for (const key of TASK_SECTIONS) {
        const list = buckets[key]
        // 完了は、数えるものがあるときだけ出す。
        if (key === 'done' && list.length === 0) continue
        const section = el('section', `task-section task-section-${key}`)
        const sectionHead = el('button', 'task-section-head')
        sectionHead.type = 'button'
        sectionHead.setAttribute('aria-expanded', String(state[key]))
        sectionHead.append(el('span', 'task-caret', state[key] ? '▾' : '▸'), el('span', 'task-section-label', TASK_SECTION_LABELS[key]), el('span', 'task-count', String(list.length)))
        sectionHead.dataset.key = key
        sectionHead.addEventListener('click', () => {
          store.set(keyOf('task-sections'), { ...sections(), [key]: !state[key] })
          draw(key)
        })
        section.append(sectionHead)
        if (state[key]) {
          if (list.length === 0) section.append(el('p', 'task-empty', 'ありません'))
          else {
            const ul = el('ul', 'task-list')
            for (const task of list) ul.append(item(task, date))
            section.append(ul)
          }
        }
        body.append(section)
      }
      parts.push(body)
    }
    const inner = el('div', 'task-panel-inner')
    inner.append(...parts)
    box.replaceChildren(inner)
    box.classList.toggle('task-panel-closed', !open)
    box.hidden = false
    if (focusKey) box.querySelector(`[data-key="${focusKey}"]`)?.focus()
  }

  // tasks: サーバーの一覧。date: 開いているデイリーノートの日付。truncated: 一覧が途中までか。
  // タスクのノートが1つもなければ出さない。
  function show({ tasks, date, truncated = false }) {
    if (!Array.isArray(tasks) || tasks.length === 0) return hide()
    last = { tasks, date, truncated: truncated === true }
    draw()
  }

  // date（デイリーノートでなければ null）に合わせて、一覧を問い合わせて描く。
  // load: 一覧（{ tasks, truncated }）を返す関数。isCurrent: 返事が来たとき、まだ同じノートを開いているか。
  // 返り値：'hidden'・'shown'・'stale'（古い返事を捨てた）・'failed'（今の見た目のまま）。
  async function refresh({ date, load, isCurrent = () => true }) {
    if (!date) {
      hide()
      return 'hidden'
    }
    const mine = ++request
    // 別のデイリーノートへ移ったときは、まず手元の一覧でその日から数え直して出す。
    if (last && last.date !== date) show({ ...last, date })
    let data
    try {
      data = await load()
    } catch {
      return mine === request ? 'failed' : 'stale'
    }
    if (mine !== request || !isCurrent()) return 'stale'
    if (!data || !Array.isArray(data.tasks)) return 'failed'
    show({ tasks: data.tasks, date, truncated: data.truncated })
    return 'shown'
  }

  return { show, hide, refresh, shown: () => last !== null, last: () => last }
}
