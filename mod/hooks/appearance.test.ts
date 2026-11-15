import { expect, test } from 'claude-code/testing'

import { appearanceProblem, COLOR_KEYS, FONT_KEYS, mergeLook } from './appearance'

test('見た目の変更は、指定した項目だけを書き換えて残りを保つ', async () => {
  const next = mergeLook({ fontSize: 16, bodyFont: 'Meiryo' }, { bodyFont: "'Hiragino Mincho ProN', serif", light: { bg: '#ffffff' } })
  expect(next).toEqual({ fontSize: 16, bodyFont: "'Hiragino Mincho ProN', serif", light: { bg: '#ffffff' } })
})

test('見た目の変更は、コードの大きさと本文の幅も変えられる', async () => {
  expect(mergeLook({ fontSize: 16 }, { codeSize: 14, contentWidth: 768, listSize: 17 })).toEqual({ fontSize: 16, codeSize: 14, contentWidth: 768, listSize: 17 })
})

test('使えない値は、理由を返す', async () => {
  for (const bad of [{ bodyFont: 'x; background: url(a)' }, { fontSize: 99 }, { codeSize: 1 }, { contentWidth: 100 }, { listSize: 99 }, { light: { bg: 'red' } }, { dark: { other: '#111111' } }]) {
    expect(typeof appearanceProblem(bad)).toBe('string')
  }
})

test('使える値は、理由を返さない', async () => {
  expect(appearanceProblem({ bodyFont: "'Hiragino Mincho ProN', serif", fontSize: 16, light: { bg: '#ffffff' } })).toBeNull()
  expect(appearanceProblem({})).toBeNull()
})

test('変えられる色とフォントの名前', async () => {
  expect(COLOR_KEYS).toContain('accent')
  expect(FONT_KEYS).toEqual(['bodyFont', 'uiFont', 'codeFont'])
})
