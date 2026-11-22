// フォルダーの一覧と、貼り付けたパスの解釈。画面には触らない。

const compareNames = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true })

// folders には、中身のないフォルダーも含めて渡せる。
// 動かす計画が断られたときの理由。list-truncated は、一覧が途中までで、リンクを全部は確かめられないとき。
export function planFailure(status, data) {
  if (status === 409 && data?.error === 'list-truncated') return 'truncated'
  if (status === 409) return 'exists'
  return 'other'
}

export function buildTree(paths, folders = []) {
  const root = { name: '', path: '', folders: new Map(), files: [] }
  const folderOf = (parts) => {
    let current = root
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part
      if (!current.folders.has(part)) current.folders.set(part, { name: part, path: prefix, folders: new Map(), files: [] })
      current = current.folders.get(part)
    }
    return current
  }
  for (const folder of folders) folderOf(folder.split('/'))
  for (const note of paths) {
    const parts = note.split('/')
    const fileName = parts.pop()
    folderOf(parts).files.push({ name: fileName, path: note })
  }
  const finish = (folder) => ({
    name: folder.name,
    path: folder.path,
    folders: [...folder.folders.values()].map(finish).sort(compareNames),
    files: folder.files.sort(compareNames),
  })
  return finish(root)
}

export function ancestorsOf(note) {
  const parts = note.split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

// Macのファイル名は大文字と小文字、濁点の持ち方を区別しないので、同じノートとして比べる。
const sameNote = (note) => note.normalize('NFC').toLowerCase()

// 新しいノートの名前と場所を確かめる。作れるなら { path }、作れないなら { error }。
// dir は '' なら一番上のフォルダー。
export function checkNewNote(name, dir, notes = []) {
  const fresh = name.trim()
  if (fresh.includes('/')) return { error: '名前に「/」は使えません。場所は下で選んでください。' }
  const base = fresh.replace(/[\\:]/g, '-').replace(/\.md$/i, '')
  if (!base) return { error: '名前を入れてください。' }
  if (base.startsWith('.')) return { error: '点で始まる名前は使えません。' }
  const path = dir ? `${dir}/${base}.md` : `${base}.md`
  if (notes.some((note) => sameNote(note) === sameNote(path))) return { error: 'この場所には同じ名前のノートがあります。' }
  return { path }
}

// 「探す」に入力した名前から、新しいノートの場所を作る。作れない名前なら null。
export function newNotePath(query, dir, notes = []) {
  return checkNewNote(query, dir, notes).path ?? null
}

// 新しいノートを置けるフォルダー。ノートのあるフォルダーと、その上のフォルダー。'' は一番上。
// ノートのないフォルダーは一覧から分からないので出さない。新しいフォルダーもここでは作らない。
export function noteFolders(notes) {
  const folders = new Set([''])
  for (const note of notes) for (const folder of ancestorsOf(note)) folders.add(folder)
  return [...folders].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }))
}

// 置き場所を選ぶ画面で、ある場所の1つ下の階層のフォルダー。'' は一番上。
export function childFolders(folders, dir) {
  const prefix = dir ? `${dir}/` : ''
  return folders.filter((folder) => folder && folder.startsWith(prefix) && !folder.slice(prefix.length).includes('/'))
}

// フォルダーを名前で探す。打った文字を含むフォルダーを、どの階層にあっても出す。名前に含むものを先に並べる。
export function searchFolders(folders, query, limit = 50) {
  const needle = query.trim().normalize('NFC').toLowerCase()
  if (!needle) return []
  const name = (folder) => folder.slice(folder.lastIndexOf('/') + 1).normalize('NFC').toLowerCase()
  const hits = folders.filter((folder) => folder && folder.normalize('NFC').toLowerCase().includes(needle))
  return hits.sort((a, b) => Number(!name(a).includes(needle)) - Number(!name(b).includes(needle))).slice(0, limit)
}

// 最近ノートを作った場所。新しいものを先にして、5つまで覚える。
export function rememberPlace(list, dir, limit = 5) {
  return [dir, ...list.filter((item) => item !== dir)].slice(0, limit)
}

// 最初に選んでおく場所。いま開いているノートと同じフォルダー。選べないときは一番上。
export function defaultNoteDir(currentPath, folders) {
  if (!currentPath) return ''
  const dir = currentPath.split('/').slice(0, -1).join('/').normalize('NFC')
  // 一覧の書き方で返す。濁点の持ち方が違っても同じフォルダーとして探す。
  return folders.find((folder) => folder.normalize('NFC') === dir) ?? ''
}

// ノートの絶対パス。Vaultの外のノートや、場所が分からないときは null。
// Windowsでは区切りを「\」にそろえる（「/」と混ざったパスを人に見せないため）。
export function absolutePath(rootPaths, rel, platform = 'darwin') {
  if (!rootPaths?.[0] || typeof rel !== 'string' || rel.startsWith('__outside__/')) return null
  if (platform === 'win32') return `${rootPaths[0]}/${rel}`.replace(/[\\/]+/g, '\\')
  return `${rootPaths[0]}/${rel}`
}

// ファイルパネルなどからコピーしたパスを、Vaultの中のノートに直す。パスでなければ null。
export function resolvePasted(text, rootPaths, notes, platform = 'darwin') {
  let value = text.trim().replace(/^["']|["']$/g, '')
  if (value.includes('\n')) return null
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(value.slice('file://'.length))
    } catch {
      return null
    }
    // file:///C:/... は先頭の「/」を外してドライブ名から始める。
    if (platform === 'win32') value = value.replace(/^\/(?=[A-Za-z]:)/, '')
  }
  if (platform === 'win32') value = value.replace(/\\/g, '/')
  // Macのファイル名は濁点を分けて持つことがあるので、形をそろえて比べ、一覧の表記のまま返す。
  value = value.replace(/:\d+(?::\d+)?$/, '').normalize('NFC').replace(/^\.\//, '')
  // セッションのフォルダーから見たパスは「../」で始まることがある。上へ戻った先は分からないので、後ろの部分で探す。
  const climbed = /^(\.\.\/)+/.test(value)
  value = value.replace(/^(\.\.\/)+/, '')
  if (!value.toLowerCase().endsWith('.md') || value.split('/').includes('..')) return null
  const same = (note) => note.normalize('NFC')
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    // Windowsは区切りを「/」にそろえ、大文字と小文字を区別せずに比べる。残りは元の大文字小文字のまま返す。
    const win = platform === 'win32'
    const fold = (item) => (win ? item.toLowerCase() : item)
    const slashed = (item) => (win ? item.replace(/\\/g, '/') : item).normalize('NFC').replace(/\/+$/, '')
    const target = fold(value)
    const root = rootPaths.map(slashed).find((item) => target.startsWith(`${fold(item)}/`))
    if (!root) return null
    value = value.slice(root.length + 1)
    return notes.find((note) => same(note) === value) ?? null
  }
  const exact = notes.find((note) => same(note) === value)
  if (exact && !climbed) return exact
  const candidates = notes.filter((note) => same(note) === value || same(note).endsWith(`/${value}`))
  return candidates.length === 1 ? candidates[0] : null
}
