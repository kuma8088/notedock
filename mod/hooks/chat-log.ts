// チャットの会話を、エディターのチャット欄に並べる形にまとめる。今のModの register.ts から写した。

const LOG_ITEMS = 20
const LOG_TEXT = 6000

export type LogItem = { kind: 'user' | 'assistant' | 'tools'; text: string }
type Said = { role: 'user' | 'assistant'; text: string; toolUses?: readonly { tool: string }[] }

// 本人に見せない差し込み（システムからの注意書きなど）は、会話の表示から外す。
const HIDDEN_BLOCK = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|task-notification|pasted_content|preview-annotation-context|ide_selection|ide_opened_file|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g
// 貼り付けた画像は、ファイルの場所ではなく「（画像）」と出す。
const IMAGE_NOTE = /\[Image: source: [^\]]*\]/g

const TOOL_KIND: [RegExp, string][] = [
  [/^mcp__ccd_turn__|^ToolSearch$|^mcp__ccd_view__/, ''],
  [/^Read$/, 'ファイルを読む'],
  [/^(Edit|Write|NotebookEdit)$/, 'ファイルを書く'],
  [/^Bash$/, 'コマンド'],
  [/^(Grep|Glob)$/, '探す'],
  [/^mcp__(Claude_Browser|claude-in-chrome)__/, 'ブラウザ'],
  [/^Agent$/, '別のAIに頼む'],
  [/^(WebFetch|WebSearch)$/, 'ウェブを調べる'],
  [/^Skill$/, 'スキル'],
]

function toolKind(tool: string): string {
  for (const [pattern, kind] of TOOL_KIND) if (pattern.test(tool)) return kind
  return 'ツール'
}

function countText(counts: Map<string, number>): string {
  return [...counts].map(([kind, n]) => (n > 1 ? `${kind} ${n}回` : kind)).join('・')
}

// 会話を、エディターの枠に並べる形にまとめる。続いた道具の使用は1行に数でまとめる。
export function summarizeTranscript(messages: readonly Said[], limit = LOG_ITEMS): LogItem[] {
  const items: LogItem[] = []
  let tools: Map<string, number> | null = null
  const flush = () => {
    if (tools && tools.size) items.push({ kind: 'tools', text: countText(tools) })
    tools = null
  }
  for (const message of messages) {
    const text = (message.text ?? '').replace(HIDDEN_BLOCK, '').replace(IMAGE_NOTE, '（画像）').trim()
    if (text) {
      flush()
      items.push({ kind: message.role, text: text.length > LOG_TEXT ? `${text.slice(0, LOG_TEXT)}…` : text })
    }
    for (const use of message.toolUses ?? []) {
      const kind = toolKind(use.tool)
      if (!kind) continue
      tools ??= new Map()
      tools.set(kind, (tools.get(kind) ?? 0) + 1)
    }
  }
  flush()
  return items.slice(-limit)
}
