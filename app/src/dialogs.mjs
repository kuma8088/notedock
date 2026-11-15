// ブラウザパネルでは標準の入力ダイアログが使えない場合があるので、自前の小さな画面で聞く。

function open(build) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'note-ask'
    const finish = (value) => {
      dialog.close()
      dialog.remove()
      resolve(value)
    }
    build(dialog, finish)
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      finish(null)
    })
    document.body.append(dialog)
    dialog.showModal()
  })
}

function button(label, run, primary = false) {
  const node = document.createElement('button')
  node.type = 'button'
  node.textContent = label
  if (primary) node.className = 'primary'
  node.addEventListener('click', run)
  return node
}

function actions(...buttons) {
  const box = document.createElement('div')
  box.className = 'dialog-actions'
  box.append(...buttons)
  return box
}

export function askText(message, initial = '') {
  return open((dialog, finish) => {
    const label = document.createElement('p')
    label.textContent = message
    const input = document.createElement('input')
    input.type = 'text'
    input.value = initial
    setTimeout(() => input.select(), 0)
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        finish(input.value)
      }
    })
    dialog.append(label, input, actions(button('やめる', () => finish(null)), button('決定', () => finish(input.value), true)))
  })
}

export function askConfirm(message, yes = 'はい') {
  return open((dialog, finish) => {
    const label = document.createElement('p')
    label.textContent = message
    dialog.append(label, actions(button('やめる', () => finish(false)), button(yes, () => finish(true), true)))
  }).then(Boolean)
}

// 置き場所を選ぶ部品。今いる場所、1つ下の階層のフォルダー、名前で探す欄、最近使った場所を出す。
// folders は '' を除いた全部のフォルダー。onChange は場所が変わるたびに呼ぶ。
function placePicker({ folders, start, topLabel, recent = [], onChange, childFolders, searchFolders, exclude = () => false }) {
  let dir = start
  const box = document.createElement('div')
  box.className = 'place-picker'
  const crumbs = document.createElement('div')
  crumbs.className = 'place-crumbs'
  const search = document.createElement('input')
  search.type = 'search'
  search.placeholder = 'フォルダーを名前で探す'
  search.autocomplete = 'off'
  const list = document.createElement('div')
  list.className = 'place-list'
  const item = (label, title, run, kind = '') => {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = `place-item ${kind}`.trim()
    node.textContent = label
    node.title = title
    node.addEventListener('click', run)
    return node
  }
  const go = (next) => {
    dir = next
    search.value = ''
    draw()
    onChange?.(dir)
  }
  const draw = () => {
    const parts = dir ? dir.split('/') : []
    crumbs.replaceChildren(
      item(topLabel, '一番上', () => go(''), 'place-crumb'),
      ...parts.flatMap((part, index) => {
        const sep = document.createElement('span')
        sep.className = 'place-sep'
        sep.textContent = '›'
        const target = parts.slice(0, index + 1).join('/')
        return [sep, item(part, target, () => go(target), 'place-crumb')]
      }),
    )
    const query = search.value.trim()
    const rows = []
    if (query) {
      const hits = searchFolders(folders, query).filter((folder) => !exclude(folder))
      if (!hits.length) rows.push(note('この名前のフォルダーは見つかりません。'))
      for (const folder of hits) rows.push(item(`${folder}/`, folder, () => go(folder)))
    } else {
      const places = recent.filter((place) => place !== dir && (place === '' || folders.includes(place)) && !exclude(place))
      if (places.length) {
        rows.push(note('最近ノートを作った場所', 'place-head'))
        for (const place of places) rows.push(item(place ? `${place}/` : `${topLabel}（一番上）`, place, () => go(place), 'place-recent'))
        rows.push(note('この中のフォルダー', 'place-head'))
      }
      const children = childFolders(folders, dir).filter((folder) => !exclude(folder))
      if (!children.length) rows.push(note('この下にフォルダーはありません。'))
      for (const child of children) rows.push(item(`${child.slice(child.lastIndexOf('/') + 1)} ›`, child, () => go(child)))
    }
    list.replaceChildren(...rows)
  }
  const note = (text, kind = 'place-empty') => {
    const node = document.createElement('p')
    node.className = kind
    node.textContent = text
    return node
  }
  // 探す欄のEnterでは、何も作らない。
  search.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') event.preventDefault()
  })
  search.addEventListener('input', draw)
  box.append(crumbs, search, list)
  draw()
  return { element: box, value: () => dir }
}

function placeText(dir, topLabel) {
  return dir ? `${dir}/` : `${topLabel}（一番上）`
}

// 新しいノートの名前と場所を聞く。作るノートのパスか、やめたら null を返す。
// check(name, dir) は { path } か { error } を返す。作れないときは画面を閉じずに理由を出す。
export function askNewNote({ folders, selected, topLabel, check, recent, childFolders, searchFolders }) {
  return open((dialog, finish) => {
    dialog.classList.add('note-ask-wide')
    const title = document.createElement('p')
    title.className = 'dialog-title'
    title.textContent = '新しいノート'
    const nameLabel = document.createElement('label')
    nameLabel.textContent = '名前'
    const input = document.createElement('input')
    input.type = 'text'
    input.autocomplete = 'off'
    nameLabel.append(input)
    const placeLabel = document.createElement('p')
    placeLabel.className = 'place-label'
    placeLabel.textContent = '場所'
    const where = document.createElement('p')
    where.className = 'place-where'
    const error = document.createElement('p')
    error.className = 'dialog-error'
    error.setAttribute('role', 'alert')
    error.hidden = true
    const showWhere = () => {
      const result = check(input.value || '（名前）', picker.value())
      where.textContent = `作る場所：${result.path ?? `${placeText(picker.value(), topLabel)}`}`
    }
    const picker = placePicker({
      folders,
      start: selected,
      topLabel,
      recent,
      childFolders,
      searchFolders,
      onChange: () => {
        error.hidden = true
        showWhere()
      },
    })
    const submit = () => {
      const result = check(input.value, picker.value())
      if (result.path) return finish(result.path)
      error.textContent = result.error
      error.hidden = false
      input.focus()
    }
    // Enterで作るのは名前の欄だけ。日本語入力の変換を確定するEnterでは作らない。
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        submit()
      }
    })
    input.addEventListener('input', () => {
      error.hidden = true
      showWhere()
    })
    showWhere()
    dialog.append(title, nameLabel, placeLabel, picker.element, where, error, actions(button('やめる', () => finish(null)), button('作る', submit, true)))
    setTimeout(() => input.focus(), 0)
  })
}

// ノートやフォルダーを動かす先を聞く。選んだフォルダー（'' は一番上）か、やめたら null を返す。
export function askPlace({ title: heading, folders, start, topLabel, recent, childFolders, searchFolders, exclude, confirm = 'ここへ動かす' }) {
  return open((dialog, finish) => {
    dialog.classList.add('note-ask-wide')
    const title = document.createElement('p')
    title.className = 'dialog-title'
    title.textContent = heading
    const where = document.createElement('p')
    where.className = 'place-where'
    const picker = placePicker({
      folders,
      start,
      topLabel,
      recent,
      childFolders,
      searchFolders,
      exclude,
      onChange: (dir) => {
        where.textContent = `動かす先：${placeText(dir, topLabel)}`
      },
    })
    where.textContent = `動かす先：${placeText(start, topLabel)}`
    dialog.append(title, picker.element, where, actions(button('やめる', () => finish(null)), button(confirm, () => finish(picker.value()), true)))
  })
}

// 3つから選ぶ。選んだ値か、やめたら null を返す。
export function askChoice(message, choices) {
  return open((dialog, finish) => {
    const label = document.createElement('p')
    label.textContent = message
    label.style.whiteSpace = 'pre-wrap'
    dialog.append(label, actions(button('やめる', () => finish(null)), ...choices.map(({ label: text, value, primary }) => button(text, () => finish(value), primary))))
  })
}

export function showMessage(message) {
  return open((dialog, finish) => {
    const label = document.createElement('p')
    label.textContent = message
    dialog.append(label, actions(button('閉じる', () => finish(true), true)))
  })
}
