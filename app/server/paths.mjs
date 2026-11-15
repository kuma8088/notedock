import fs from 'node:fs'
import path from 'node:path'

export const BLOCKED = new Set(['node_modules'])
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'])

const WIN_BAD_CHARS = /[:<>"|?*]/
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[0-9\u00b9\u00b2\u00b3])$/i

// 名前1つぶんを確かめる。受け付けないときは Error('path not allowed')。
// Windowsだけで受け付けない名前は、Macでは今までどおり開けるよう、platform で切り替える。
export function checkSegment(name, platform = process.platform) {
  const bad = () => new Error('path not allowed')
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name.startsWith('.')) throw bad()
  if (BLOCKED.has(name.toLowerCase())) throw bad()
  // eslint-disable-next-line no-control-regex
  if (name.includes('\\') || /[\x00-\x1f]/.test(name)) throw bad()
  if (platform === 'win32') {
    if (WIN_BAD_CHARS.test(name)) throw bad()
    if (/[. ]$/.test(name)) throw bad()
    const base = name.split('.')[0].replace(/ +$/, '')
    if (WIN_RESERVED.test(base)) throw bad()
  }
}

// 一覧に出してよい名前か。
export function isListable(name, platform = process.platform) {
  try {
    checkSegment(name, platform)
    return true
  } catch {
    return false
  }
}

// 実際の場所（realDeep）が、Vaultの実際の場所（realRoot）の中で、指定した道筋（parts）と同じか。大文字と小文字は区別しない。
export function realPathMatches(realRoot, realDeep, parts) {
  const rel = path.win32.relative(realRoot, realDeep)
  if (rel === '') return parts.length === 0
  if (path.win32.isAbsolute(rel) || rel === '..' || rel.startsWith('..\\')) return false
  return rel.split('\\').join('/').toLowerCase() === parts.join('/').toLowerCase()
}

export function resolveInside(root, rel, { platform = process.platform } = {}) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.includes('\0')) {
    throw new Error('path not allowed')
  }
  const parts = rel.split('/')
  for (const part of parts) checkSegment(part, platform)
  let current = root
  const existing = []
  let result = null
  for (const part of parts) {
    current = path.join(current, part)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (error.code === 'ENOENT') {
        result = path.join(root, ...parts)
        break
      }
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('path not allowed')
    existing.push(part)
  }
  if (result === null) result = current
  // Windowsの短い名前（PROGRA~1）やジャンクションは、lstatでは普通のフォルダーに見える。
  // 実際にあるいちばん奥の場所を調べ、Vaultの中で指定どおりの道筋か確かめる。
  if (platform === 'win32') {
    const deepest = path.join(root, ...existing)
    if (!realPathMatches(fs.realpathSync.native(root), fs.realpathSync.native(deepest), existing)) {
      throw new Error('path not allowed')
    }
  }
  return result
}

export function resolveNotePath(root, rel) {
  if (typeof rel !== 'string' || !rel.toLowerCase().endsWith('.md')) throw new Error('path not allowed')
  return resolveInside(root, rel)
}

// フォルダーの場所。名前に点を付けた隠しフォルダーや、Vaultの外は断る。
export function resolveFolderPath(root, rel) {
  if (typeof rel !== 'string' || /\.md$/i.test(rel)) throw new Error('path not allowed')
  return resolveInside(root, rel)
}

export function resolveAssetPath(root, rel) {
  if (typeof rel !== 'string' || !ASSET_EXT.has(path.extname(rel).toLowerCase())) {
    throw new Error('path not allowed')
  }
  return resolveInside(root, rel)
}

// Vaultをたどる処理の本体。上の階層から一段ずつ調べる（深い1か所だけで上限を使い切らないため）。
// 深さは、パスの段数で数える。Vault直下のノートは1段、a/b.md は2段。maxDepth を超える段のノートは出さず、そのフォルダーも調べない。
// 件数は、ノート（.md）と調べたフォルダーの合計。non-note のファイルは数えない。
// unlisted のフォルダー（名前は大文字小文字を区別しない）は、notes と folders には出さず、中のノートだけ known に入れる。
// isHidden(フルパス) が true のものは、どこにも出さない。
export function scanVault(root, { unlisted = new Set(), isHidden = () => false, maxEntries = 20000, maxDepth = 32 } = {}) {
  const skip = new Set([...unlisted].map((name) => name.toLowerCase()))
  const notes = []
  const known = []
  const folders = []
  const unreadable = []
  let count = 0
  let truncated = false
  const queue = [{ dir: root, prefix: '', depth: 0, hiddenFromList: false }]
  for (let head = 0; head < queue.length; head++) {
    const { dir, prefix, depth, hiddenFromList } = queue[head]
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (dir === root) throw error
      unreadable.push(prefix.slice(0, -1))
      continue
    }
    // 深さの上限にいるフォルダーは、中にノートかフォルダーがあるときだけ、途中までと数える。
    if (depth >= maxDepth) {
      if (entries.some((entry) => isListable(entry.name) && !entry.isSymbolicLink() && !isHidden(path.join(dir, entry.name)) && (entry.isDirectory() || entry.name.toLowerCase().endsWith('.md')))) truncated = true
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (!isListable(entry.name) || entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isHidden(full)) continue
        if (count >= maxEntries) {
          truncated = true
          continue
        }
        count++
        const rel = `${prefix}${entry.name}`
        const quiet = hiddenFromList || skip.has(entry.name.toLowerCase())
        if (!quiet) folders.push(rel)
        queue.push({ dir: full, prefix: `${rel}/`, depth: depth + 1, hiddenFromList: quiet })
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        if (isHidden(full)) continue
        if (count >= maxEntries) {
          truncated = true
          continue
        }
        count++
        known.push(`${prefix}${entry.name}`)
        if (!hiddenFromList) notes.push(`${prefix}${entry.name}`)
      }
    }
  }
  const plain = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  return { notes: notes.sort(plain), known: known.sort(plain), folders: folders.sort(plain), unreadable: unreadable.sort(plain), truncated }
}

// 一覧に出さないフォルダーも含めた全部のノート。
// 途中までしかたどれないときは、ノートが抜けたまま使わないよう、エラーにする。
export function listNotes(root, options) {
  const { known, truncated } = scanVault(root, options)
  if (truncated) throw new Error('list-truncated')
  return known
}
