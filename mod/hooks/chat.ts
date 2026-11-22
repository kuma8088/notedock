// チャット欄の話し相手と、開いているノートを添える文。
// ファイルはすべて、そのチャットの結び付けのフォルダー（Vault別フォルダーの chats/<番号のハッシュ>）に置く。
// $ を受け取る関数は、register.ts の ioFor からだけ呼ぶ。判断は register.ts の createNotedock と、下の $ を使わない関数で行う。
import { joinPath, rootKey, type Os } from './platform'

type Host = any

// 本人が打ち込んだ発言の出どころ（入力欄、Remote Control、SDK）。通知や他のModからの発言は入れない。
export const TYPED_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

export type EditorState = {
  path?: string
  selection?: string
  dirty?: boolean
  updatedAt?: number
  root?: string
  askChat?: { text: string; at: number }
  sendChat?: { text: string; at: number }
}

export const MAX_TEXT = 4000 // 入力欄へ入れる文字、添える選択の文字、送る文の上限
const RECENT_MS = 30 * 60 * 1000 // これより古いエディターの状態は添えない

// Vault別フォルダーの中のファイル。区切りは、呼ぶ側が渡すOSで決める。
export function chatFile(os: Os, vaultDir: string, name: string): string {
  return joinPath(os, vaultDir, name)
}

// エディターを開く鍵（URLの #c=…）を消す。会話の記録など、ファイルに残すものに鍵を書かないため。
// 鍵は base64url（A-Z a-z 0-9 _ -）だけでできているので、#c= からその文字が続くところまでを消す（すぐあとに続く文は残す）。
// チャットの番号（s=、43文字）も同じく消す（# のすぐあとでも、& のあとでも）。
export function hideKeys(text: string): string {
  return text.replace(/#c=[A-Za-z0-9_-]*/g, '').replace(/[#&]s=[A-Za-z0-9_-]{43}/g, '')
}

// このチャットの結び付けのフォルダー（Vault別フォルダーの chats/<番号のハッシュ>）。番号そのものはファイルにも場所にも書かない。
// 中身: link.json（Modが書く。時刻と名前）、state.json と share.json（サーバーが書く）、reply.json と log.json（Modが書く）。
export function linkDir(os: Os, vaultDir: string, hash: string): string {
  return joinPath(os, vaultDir, 'chats', hash)
}

// 開いているノートを添えるのは、このチャットに結び付いたエディターの切り替えがオン（share.json が on: true）のときだけ。
export async function shareIsOn($: Host, dir: string, os: Os): Promise<boolean> {
  try {
    return JSON.parse(await $.fs.read(chatFile(os, dir, 'share.json')))?.on === true
  } catch {
    return false
  }
}

// 推測できない番号（32バイトの乱数を base64url にした43文字）と、そのハッシュ（SHA-256の16進）。
export function newLinkText(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function hexOf(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// 会話の名前の代わり（Modからは会話のタイトルを読めないため）。最初の本人の発言の初めの部分を使う。
// Modが送った「開いてください」の頼みは除く。
export function titleFrom(items: readonly { kind: string; text: string }[], project: string): string {
  const first = items.find(i => i.kind === 'user' && !/NoteDockを開いてください。ブラウザパネルで|NoteDockが開けなかったので、navigate で/.test(i.text))
  const head = first ? first.text.replace(/\s+/g, ' ').trim() : ''
  const short = head.length > 24 ? `${head.slice(0, 24)}…` : head
  return short ? `${project} ·「${short}」` : project
}

type NoteInfo = { where: string; dirty: boolean; selection: string }

// 添えるノートの中身（場所・保存していない変更・選んでいる文字）。添えないときは null。
function noteInfo(state: EditorState, now: number, root: string, os: Os): NoteInfo | null {
  if (!state.path || !state.updatedAt || now - state.updatedAt > RECENT_MS) return null
  // テスト用のコピーなど別のフォルダーのノートを、今のプロジェクトの同名ファイルと間違えないようにする。
  const other = state.root && rootKey(state.root, os) !== rootKey(root, os)
  // Windowsでは / を \ にそろえ、区切りが混ざらないようにする。
  const win = (p: string) => (os === 'win32' ? p.replace(/\//g, '\\') : p)
  const where = other ? joinPath(os, win(state.root as string), win(state.path)) : state.path
  return { where, dirty: !!state.dirty, selection: state.selection ? state.selection.slice(0, MAX_TEXT) : '' }
}

// 本人が打った発言に、prompt.submit のフックで context として添える文。
export function describeNote(state: EditorState, now: number, root: string, os: Os): string | null {
  const info = noteInfo(state, now, root, os)
  if (!info) return null
  const lines = [`エディターで開いているノート: ${info.where}`]
  if (info.dirty) lines.push('このノートにはまだ保存していない変更があります。')
  if (info.selection) lines.push(`選んでいる文字:\n${info.selection}`)
  return lines.join('\n')
}

// エディターのチャット欄から送る文の末尾に足す、短い案内。
// Modが $.prompt.submit で送る文には、Mod自身の prompt.submit フックが呼ばれず、context も渡せないため、文そのものに足す。
export const SEND_NOTE_HEAD = '（エディターで開いているノート: '

export function noteForSend(state: EditorState, now: number, root: string, os: Os): string | null {
  const info = noteInfo(state, now, root, os)
  if (!info) return null
  const head = `${SEND_NOTE_HEAD}${info.where}${info.dirty ? '。まだ保存していない変更があります' : ''}）`
  return info.selection ? `${head}\n選んでいる文字:\n${quoteForPrompt(info.selection).trimEnd()}` : head
}

// 送る文（打った文の上限を守ったもの）に案内を足す。案内が無ければそのまま。
export function withNote(text: string, note: string | null): string {
  return note ? `${text}\n\n${note}` : text
}

// 番の文が、エディターから送った文かどうか。sent は送った文そのもの（案内付き）か、
// Modを読み込み直したあとならエディターが書いた送る文（案内なし）。後者は、末尾に案内が続く形も同じ文とみなす。
export function isSentText(turnText: string, sent: string): boolean {
  const a = turnText.trim()
  const b = sent.trim()
  if (a === b) return true
  return b !== '' && a.startsWith(b) && a.slice(b.length).trimStart().startsWith(SEND_NOTE_HEAD)
}

export function quoteForPrompt(text: string): string {
  return `${text
    .slice(0, MAX_TEXT)
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')}\n`
}
