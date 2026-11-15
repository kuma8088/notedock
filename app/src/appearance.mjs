const COLOR_VARS = {
  bg: '--bg',
  surface: '--surface',
  text: '--text',
  muted: '--muted',
  line: '--line',
  accent: '--accent',
  link: '--link',
  hover: '--hover',
  codeBg: '--code-bg',
  quote: '--quote',
}

export function appearanceVars(look, dark) {
  const vars = {}
  if (look.bodyFont) vars['--body'] = look.bodyFont
  if (look.uiFont) vars['--ui'] = look.uiFont
  if (look.codeFont) vars['--mono'] = look.codeFont
  if (look.fontSize) vars['--note-size'] = `${look.fontSize}px`
  if (look.codeSize) vars['--code-size'] = `${look.codeSize}px`
  if (look.listSize) vars['--list-size'] = `${look.listSize}px`
  if (look.contentWidth) vars['--note-width'] = `${look.contentWidth}px`
  for (const [key, value] of Object.entries(look[dark ? 'dark' : 'light'] ?? {})) {
    if (COLOR_VARS[key]) vars[COLOR_VARS[key]] = value
  }
  return vars
}
