import { expect, test } from 'claude-code/testing'

import { editorUrl, openPrompt, retryPrompt } from './open'

test('editorUrl：何もなければ一番上のページ', () => {
  expect(editorUrl({ port: 8801, today: false })).toBe('http://localhost:8801/')
})

test('editorUrl：今日のノート、ノートの場所、鍵の付け方', () => {
  expect(editorUrl({ port: 8801, today: true, ticket: 'K1' })).toBe('http://localhost:8801/?today=1#c=K1')
  expect(editorUrl({ port: 8801, today: false, note: '日記/2026 11.md', ticket: 'K1' })).toBe(
    `http://localhost:8801/?note=${encodeURIComponent('日記/2026 11.md')}#c=K1`,
  )
  expect(editorUrl({ port: 8801, today: false, ticket: null })).toBe('http://localhost:8801/')
})

test('openPrompt：決めた文のとおりに、鍵付きのURLを入れる', () => {
  expect(openPrompt({ port: 8801, ticket: 'K1', today: false })).toBe(
    'NoteDockを開いてください。ブラウザパネルで、preview_start に http://localhost:8801 を渡して開き、続けて navigate で http://localhost:8801/#c=K1 へ移ってください。ほかの作業はしないでください。（入力欄の上の「ノートを開く」から送っています）',
  )
  const today = openPrompt({ port: 8801, ticket: 'K1', today: true })
  expect(today).toContain('navigate で http://localhost:8801/?today=1#c=K1 へ')
  expect(today).toContain('「今日のノート」から送っています')
})

test('openPrompt：鍵が無いときは #c= を付けない', () => {
  expect(openPrompt({ port: 8801, ticket: null, today: false })).not.toContain('#c=')
})

test('retryPrompt：決めた文のとおりに、鍵付きのURLを入れる', () => {
  expect(retryPrompt({ port: 8801, ticket: 'K2', today: false })).toBe(
    'NoteDockが開けなかったので、navigate で http://localhost:8801/#c=K2 へ移ってください。ほかの作業はしないでください。',
  )
})
