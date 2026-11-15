import fs from 'node:fs'
import path from 'node:path'

const FONT_RE = /^[\p{L}\p{N} ,'"_.-]{1,300}$/u
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const COLOR_KEYS = new Set(['bg', 'surface', 'text', 'muted', 'line', 'accent', 'link', 'hover', 'codeBg', 'quote'])
const FONT_KEYS = ['bodyFont', 'uiFont', 'codeFont']

function sanitizeColors(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const colors = Object.entries(raw).filter(([key, value]) => COLOR_KEYS.has(key) && COLOR_RE.test(value))
  return colors.length > 0 ? Object.fromEntries(colors) : null
}

// チャットからClaudeが書くファイルなので、画面へ渡す前に形を確かめる。使えない値だけを捨てる。
export function sanitizeAppearance(raw) {
  const look = {}
  for (const key of FONT_KEYS) {
    if (typeof raw[key] === 'string' && FONT_RE.test(raw[key])) look[key] = raw[key]
  }
  if (Number.isFinite(raw.fontSize) && raw.fontSize >= 10 && raw.fontSize <= 32) look.fontSize = raw.fontSize
  if (Number.isFinite(raw.codeSize) && raw.codeSize >= 10 && raw.codeSize <= 32) look.codeSize = raw.codeSize
  if (Number.isFinite(raw.listSize) && raw.listSize >= 10 && raw.listSize <= 32) look.listSize = raw.listSize
  if (Number.isFinite(raw.contentWidth) && raw.contentWidth >= 480 && raw.contentWidth <= 1600) look.contentWidth = raw.contentWidth
  for (const scheme of ['light', 'dark']) {
    const colors = sanitizeColors(raw[scheme])
    if (colors) look[scheme] = colors
  }
  return look
}

export function readAppearance(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'appearance.json'), 'utf8'))
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? sanitizeAppearance(raw) : {}
  } catch {
    return {}
  }
}
