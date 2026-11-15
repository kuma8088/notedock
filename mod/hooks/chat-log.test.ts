import { expect, test } from 'claude-code/testing'

import { summarizeTranscript } from './chat-log'

test('会話の表示は、隠す差し込みを外し、続いた道具の使用を1行にまとめる', async () => {
  const items = summarizeTranscript([
    { role: 'user', text: '<system-reminder>見せない</system-reminder>表を足して' },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Read' }, { tool: 'mcp__ccd_turn__update_plan' }] },
    { role: 'user', text: '' },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Read' }, { tool: 'Bash' }] },
    { role: 'assistant', text: '足しました。' },
  ])
  expect(items).toEqual([
    { kind: 'user', text: '表を足して' },
    { kind: 'tools', text: 'ファイルを読む 2回・コマンド' },
    { kind: 'assistant', text: '足しました。' },
  ])
})

test('画面の注釈の説明は隠し、貼り付けた画像は「（画像）」と出す', async () => {
  const items = summarizeTranscript([
    { role: 'user', text: '<preview-annotation-context>説明</preview-annotation-context>\n\nここを直して\n[Image: source: /tmp/a.png]' },
  ])
  expect(items).toEqual([{ kind: 'user', text: 'ここを直して\n（画像）' }])
})
