// ノートの情報を1階層だけ読む。入れ子や複数行の値は simple:false を返し、文字のまま扱う。書き換えるのは変えた項目の行だけ。

const KEY = /^([^\s:#][^:]*?):(?:\s+(.*)|\s*)$/
const LIST_ITEM = /^\s*-\s+(.*)$/
const COMPLEX = /^[|>{[]|^&|^\*/

// 二重引用符のときだけ、書くときに付けた \" と \\ を戻す（quoteIfNeeded と往復させる）。単引用符はそのまま。
function unquote(value) {
  const match = value.match(/^(["'])(.*)\1$/)
  if (!match) return value
  return match[1] === '"' ? match[2].replace(/\\(["\\])/g, '$1') : match[2]
}

// 引用符なしで書かれたリンク（goal: [[…]]）を、リストではなくリンクとして読む項目。
const LINK_KEYS = new Set(['goal', 'parent'])
const BARE_LINK = /^\[\[[^\[\]]+\]\]$/

export function inferType(key, value) {
  if (Array.isArray(value)) return key.toLowerCase() === 'tags' ? 'tags' : 'list'
  if (value === 'true' || value === 'false') return 'checkbox'
  if (/^-?\d+(\.\d+)?$/.test(value)) return 'number'
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date'
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(value)) return 'datetime'
  return 'text'
}

export function parseFrontmatter(source) {
  const lines = source.split('\n')
  if (lines[0]?.trimEnd() !== '---' || lines.at(-1)?.trimEnd() !== '---' || lines.length < 2) {
    return { simple: false, items: [], lines }
  }
  const items = []
  let simple = true
  for (let i = 1; i < lines.length - 1; ) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i += 1
      continue
    }
    const match = line.match(KEY)
    if (!match) {
      simple = false
      i += 1
      continue
    }
    const key = match[1].trim()
    const raw = (match[2] ?? '').trim()
    if (raw === '') {
      let end = i + 1
      const values = []
      while (end < lines.length - 1) {
        const item = lines[end].match(LIST_ITEM)
        if (!item) break
        values.push(unquote(item[1].trim()))
        end += 1
      }
      if (end < lines.length - 1 && /^\s+\S/.test(lines[end])) simple = false
      const value = values.length > 0 ? values : ''
      items.push({ key, value, type: inferType(key, value), start: i, end })
      i = end
      continue
    }
    if (LINK_KEYS.has(key.toLowerCase()) && BARE_LINK.test(raw)) {
      items.push({ key, value: raw, type: 'text', start: i, end: i + 1, quoted: false })
      i += 1
      if (i < lines.length - 1 && /^\s+\S/.test(lines[i]) && !LIST_ITEM.test(lines[i])) simple = false
      continue
    }
    if (COMPLEX.test(raw)) {
      if (raw.startsWith('[') && raw.endsWith(']')) {
        const value = raw.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean)
        items.push({ key, value, type: inferType(key, value), start: i, end: i + 1, flow: true })
        i += 1
        continue
      }
      simple = false
    }
    const value = unquote(raw)
    items.push({ key, value, type: inferType(key, value), start: i, end: i + 1, quoted: raw !== value })
    i += 1
    if (i < lines.length - 1 && /^\s+\S/.test(lines[i]) && !LIST_ITEM.test(lines[i])) simple = false
  }
  return { simple, items, lines }
}

function quoteIfNeeded(value) {
  const text = String(value)
  if (text === '') return ''
  if (/^[\s>|{[&*!%@`#]|: |\s#|\s$|^["']/.test(text)) return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return text
}

function renderItem(key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}:`]
    return [`${key}:`, ...value.map((item) => `  - ${quoteIfNeeded(item)}`)]
  }
  const text = quoteIfNeeded(value)
  return [text === '' ? `${key}:` : `${key}: ${text}`]
}

export function setProperty(source, key, value) {
  const { items, lines } = parseFrontmatter(source)
  const item = items.find((candidate) => candidate.key === key)
  const rendered = renderItem(key, value)
  if (item) lines.splice(item.start, item.end - item.start, ...rendered)
  else lines.splice(lines.length - 1, 0, ...rendered)
  return lines.join('\n')
}

export function deleteProperty(source, key) {
  const { items, lines } = parseFrontmatter(source)
  const item = items.find((candidate) => candidate.key === key)
  if (item) lines.splice(item.start, item.end - item.start)
  return lines.join('\n')
}

export function renameProperty(source, key, nextKey) {
  const { items, lines } = parseFrontmatter(source)
  const item = items.find((candidate) => candidate.key === key)
  if (item && nextKey.trim()) lines[item.start] = lines[item.start].replace(key, nextKey.trim())
  return lines.join('\n')
}
