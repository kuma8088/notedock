// サイドバーの「タスク」（段階1-E2）。並べ方は task-buckets.mjs の sideTaskModel、ここは描くだけ。
// 中身：未完了のタスク（期日順の1列）、完了（たたんで件数）、リンクが外れたタスク（たたんで件数。開くと「ゴミ箱へ」）、新しいタスクのボタン。
import { dueView, sideTaskModel, statusView, taskLabel } from './task-buckets.mjs'

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const button = (className, text, title) => {
  const node = el('button', className, text)
  node.type = 'button'
  if (title) node.title = title
  return node
}

// box: 置き場の要素。store: { get(key, fallback), set(key, value) }。keyOf(name): 覚える名前（Vault ごと）。
// today(): 今日（期日を過ぎたかの判定）。onOpen(path, event)・onTrash(path)・onCreate()：押したとき。
export function createTaskSide({ box, store, keyOf, today, onOpen, onTrash, onCreate }) {
  let data = null
  let failed = false
  let drawn = ''
  const folds = () => {
    const saved = store.get(keyOf('task-side-folds'), null)
    return { done: saved?.done === true, unlinked: saved?.unlinked === true }
  }

  function item(task, date, { trash = false } = {}) {
    const status = statusView(task.status)
    const due = dueView(task, date)
    const li = el('li', `task-item task-${status.kind}`)
    const open = button('task-open', taskLabel(task), task.path)
    open.addEventListener('click', (event) => onOpen(task.path, event))
    li.append(open)
    const meta = el('span', 'task-meta')
    if (due.text) meta.append(el('span', due.overdue ? 'task-due task-overdue' : 'task-due', due.text))
    if (status.label) meta.append(el('span', `task-status task-status-${status.kind}`, status.label))
    if (trash) {
      const bin = button('task-trash', 'ゴミ箱へ', 'このタスクのノートをゴミ箱へ移す')
      bin.addEventListener('click', () => onTrash(task.path))
      meta.append(bin)
    }
    if (meta.childNodes.length) li.append(meta)
    if (task.parentTitle) li.append(el('span', 'task-parent', `親：${taskLabel({ title: task.parentTitle, path: task.parentPath ?? '' })}`))
    return li
  }

  function fold(key, label, list, render) {
    const state = folds()
    const section = el('section', `task-side-fold task-side-${key}`)
    const head = button('task-section-head', undefined)
    head.dataset.key = key
    head.setAttribute('aria-expanded', String(state[key]))
    head.append(el('span', 'task-caret', state[key] ? '▾' : '▸'), el('span', 'task-section-label', label), el('span', 'task-count', String(list.length)))
    head.addEventListener('click', () => {
      store.set(keyOf('task-side-folds'), { ...folds(), [key]: !state[key] })
      draw({ force: true, focus: key })
    })
    section.append(head)
    if (state[key]) {
      if (list.length === 0) section.append(el('p', 'task-empty', 'ありません'))
      else {
        const ul = el('ul', 'task-list')
        for (const task of list) ul.append(render(task))
        section.append(ul)
      }
    }
    return section
  }

  // 中身が変わっていなければ描き直さない（60秒ごとの読み直しで、フォーカスやスクロールが外れないように）。
  function draw({ force = false, focus = null } = {}) {
    if (box.hidden) return
    const date = today()
    const key = JSON.stringify([data, failed, date, folds()])
    if (!force && key === drawn) return
    drawn = key
    const scroll = box.scrollTop
    const head = el('div', 'task-side-head')
    head.append(el('span', 'task-side-title', 'タスク'))
    const create = button('task-side-new', '＋ 新しいタスク', '題名と期日を入れて、Tasks にタスクのノートを作る')
    create.dataset.key = 'new'
    create.addEventListener('click', () => onCreate())
    head.append(create)
    const parts = [head]
    if (!data) {
      parts.push(el('p', 'task-empty', failed ? 'タスクの一覧を読めませんでした' : '読み込んでいます'))
    } else {
      const model = sideTaskModel(data.tasks)
      if (data.truncated) parts.push(el('p', 'task-panel-note', 'タスクのノートが多いため、名前順で先頭の一部だけを出しています'))
      if (model.open.length === 0) parts.push(el('p', 'task-empty', '未完了のタスクはありません'))
      else {
        const ul = el('ul', 'task-list task-side-list')
        for (const task of model.open) ul.append(item(task, date))
        parts.push(ul)
      }
      if (model.done.length) parts.push(fold('done', '完了', model.done, (task) => item(task, date)))
      parts.push(fold('unlinked', 'リンクが外れたタスク', model.unlinked, (task) => item(task, date, { trash: true })))
    }
    box.replaceChildren(...parts)
    box.scrollTop = scroll
    if (focus) box.querySelector(`[data-key="${focus}"]`)?.focus()
  }

  // load：一覧（{ tasks, truncated }）を返す関数。読めなければ、前の一覧があればそのまま残す。
  let request = 0
  async function refresh(load) {
    if (box.hidden) return
    const mine = ++request
    try {
      const next = await load()
      if (mine !== request) return
      if (!next || !Array.isArray(next.tasks)) throw new Error('tasks')
      data = { tasks: next.tasks, truncated: next.truncated === true }
      failed = false
    } catch {
      if (mine !== request) return
      failed = !data
    }
    draw()
  }

  return { refresh, draw, data: () => data }
}
