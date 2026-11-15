// エディターの見た目（フォント・大きさ・色）を変える値の確認と、保存する設定の組み立て。今のModの register.ts から写した。

const FONT_RE = /^[\p{L}\p{N} ,'"_.-]{1,300}$/u
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
export const COLOR_KEYS = ['bg', 'surface', 'text', 'muted', 'line', 'accent', 'link', 'hover', 'codeBg', 'quote']
export const FONT_KEYS = ['bodyFont', 'uiFont', 'codeFont']

// 使えない値は、書く前に理由を返す。サーバーも読むときに同じ確認をする。
export function appearanceProblem(input: Record<string, any>): string | null {
  for (const key of FONT_KEYS) {
    if (input[key] !== undefined && !(typeof input[key] === 'string' && FONT_RE.test(input[key]))) {
      return `${key}に使えない文字があります。文字、数字、空白、カンマ、引用符、ハイフンだけが使えます。`
    }
  }
  if (input.fontSize !== undefined && !(Number.isFinite(input.fontSize) && input.fontSize >= 10 && input.fontSize <= 32)) {
    return 'fontSizeは10から32までの数字にしてください。'
  }
  if (input.codeSize !== undefined && !(Number.isFinite(input.codeSize) && input.codeSize >= 10 && input.codeSize <= 32)) {
    return 'codeSizeは10から32までの数字にしてください。'
  }
  if (input.listSize !== undefined && !(Number.isFinite(input.listSize) && input.listSize >= 10 && input.listSize <= 32)) {
    return 'listSizeは10から32までの数字にしてください。'
  }
  if (input.contentWidth !== undefined && !(Number.isFinite(input.contentWidth) && input.contentWidth >= 480 && input.contentWidth <= 1600)) {
    return 'contentWidthは480から1600までの数字にしてください。'
  }
  for (const scheme of ['light', 'dark']) {
    for (const [key, value] of Object.entries(input[scheme] ?? {})) {
      if (!COLOR_KEYS.includes(key)) return `${scheme}.${key}は変えられません。使える色は${COLOR_KEYS.join('、')}です。`
      if (!COLOR_RE.test(String(value))) return `${scheme}.${key}は#ffffffの形で書いてください。`
    }
  }
  return null
}

export function mergeLook(saved: Record<string, any>, input: Record<string, any>): Record<string, any> {
  const next = { ...saved }
  for (const key of [...FONT_KEYS, 'fontSize', 'codeSize', 'listSize', 'contentWidth']) {
    if (input[key] !== undefined) next[key] = input[key]
  }
  for (const scheme of ['light', 'dark']) {
    if (input[scheme] !== undefined) next[scheme] = { ...next[scheme], ...input[scheme] }
  }
  return next
}
