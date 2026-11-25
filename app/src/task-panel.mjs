// デイリーノートの上に出すタスクのパネル（読み取りだけ）。区分けは task-buckets.mjs、ここは描くだけ。
import {
  TASK_SECTIONS,
  TASK_SECTION_LABELS,
  TASK_SOON_DAYS,
  TASK_SOON_DAYS_MAX,
  TASK_SOON_DAYS_MIN,
  bucketTasks,
  dueView,
  isSoonDays,
  sectionOpenState,
  soonDaysOf,
  statusView,
  taskLabel,
} from './task-buckets.mjs'

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const shortDate = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`

// box: パネルの要素。store: { get(key, fallback), set(key, value) }。keyOf(name): 覚える名前（Vault ごと）。
// onOpen(path, event): タスクの名前をクリックしたとき。
// onSoonDays(days): 見出しの「直近 □ 日」を変えたとき。保存できたら true を返す（できなければ元の日数に戻す）。
export function createTaskPanel({ box, store, keyOf, onOpen, onSoonDays }) {
  let last = null
  // 問い合わせの番号。あとから頼んだものがあれば、前の返事は捨てる。
  let request = 0
  // 「直近」の日数。一覧の返事に添えて届く（届くまでは3）。隠しても覚えておく。
  let soonDays = TASK_SOON_DAYS
  // 日数を変えた回数と、保存を待っている数。保存の前に頼んだ一覧の返事は古い日数を持っているので、その日数は使わない。
  let soonEdit = 0
  let soonSaving = 0
  // 日数の欄の下に出す知らせ（入れた数が使えない・保存できなかった）。次に日数を変えるまで出す。
  let soonNote = ''

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

  // 見出しの「直近 □ 日」の欄。変えたら（Enter・欄の外へ出る・上下の矢印）すぐ区分けし直して、保存を頼む。
  function soonField() {
    const label = el('label', 'task-soon')
    const input = el('input', 'task-soon-input')
    input.type = 'number'
    input.min = String(TASK_SOON_DAYS_MIN)
    input.max = String(TASK_SOON_DAYS_MAX)
    input.step = '1'
    input.inputMode = 'numeric'
    input.value = String(soonDays)
    input.dataset.shown = input.value
    input.title = `期日がこの日から何日先までのタスクを「直近」に出すか（${TASK_SOON_DAYS_MIN}〜${TASK_SOON_DAYS_MAX}日）`
    input.setAttribute('aria-label', '直近に出す日数')
    input.dataset.key = 'soon-days'
    input.addEventListener('change', () => changeSoon(input))
    label.append(el('span', 'task-soon-word', '直近'), input, el('span', 'task-soon-word', '日'))
    return label
  }

  async function changeSoon(input) {
    const raw = String(input.value ?? '').trim()
    const value = raw === '' ? NaN : Number(raw)
    if (!isSoonDays(value)) {
      soonNote = `直近の日数は、${TASK_SOON_DAYS_MIN}から${TASK_SOON_DAYS_MAX}までの数で入れてください`
      draw('soon-days')
      return
    }
    if (value === soonDays) {
      if (soonNote) {
        soonNote = ''
        draw('soon-days')
      }
      return
    }
    const before = soonDays
    soonDays = value
    soonNote = ''
    const mine = ++soonEdit
    soonSaving++
    draw('soon-days')
    let ok = false
    try {
      ok = (await onSoonDays?.(value)) === true
    } catch {
      ok = false
    } finally {
      soonSaving--
    }
    // あとから別の日数に変えていれば、そちらの結果に任せる。
    if (ok || mine !== soonEdit) return
    soonDays = before
    soonNote = '日数を保存できませんでした。元の日数に戻しました'
    draw(isFocused(box.querySelector('[data-key="soon-days"]')) ? 'soon-days' : null)
  }

  const isFocused = (node) => Boolean(node) && typeof document !== 'undefined' && document.activeElement === node

  // focusKey: 押したボタンを描き直したあとも、キーで続けて操作できるようにフォーカスを戻す。
  // 日数の欄に打っている途中に描き直すとき（60秒ごとの読み直しなど）は、打った数とフォーカスを残す。
  function draw(focusKey = null) {
    if (!last) return
    const { tasks, date, truncated } = last
    // 打っている途中＝フォーカスがあり、描いたときの数から変えてまだ確定していない。
    const oldField = box.querySelector('[data-key="soon-days"]')
    const keepFocus = focusKey === null && isFocused(oldField)
    const typing = keepFocus && oldField.value !== oldField.dataset.shown ? oldField.value : null
    const buckets = bucketTasks(tasks, date, { soonDays })
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
    head.append(soonField())
    if (soonNote) head.append(el('span', 'task-panel-note task-soon-note', soonNote))
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
    if (keepFocus) {
      const input = box.querySelector('[data-key="soon-days"]')
      if (typing !== null) input.value = typing
      input.focus()
    } else if (focusKey) box.querySelector(`[data-key="${focusKey}"]`)?.focus()
  }

  // tasks: サーバーの一覧。date: 開いているデイリーノートの日付。truncated: 一覧が途中までか。
  // soonDays: 「直近」の日数（なければ今の日数のまま。使えない値なら3）。タスクのノートが1つもなければ出さない。
  function show({ tasks, date, truncated = false, soonDays: days }) {
    if (days !== undefined) soonDays = soonDaysOf(days)
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
    const editAtStart = soonEdit
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
    // 日数を変えて保存を待っている間と、変える前に頼んだ返事の日数は使わない（変えたばかりの日数が戻って見えないように）。
    const fresh = soonSaving === 0 && soonEdit === editAtStart
    show({ tasks: data.tasks, date, truncated: data.truncated, soonDays: fresh ? data.soonDays : undefined })
    return 'shown'
  }

  return { show, hide, refresh, shown: () => last !== null, last: () => last, soonDays: () => soonDays }
}
