// チャット欄の話し相手と、開いているノートを添える文。
// ファイルはすべて、そのチャットのVault別フォルダーに置く（current-note.json・chat-owner.json・chat-reply.json・chat-log.json・share-note.json）。
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
export function hideKeys(text: string): string {
  return text.replace(/#c=[A-Za-z0-9_-]*/g, '')
}

type Owner = { session?: string; at?: number }

async function readOwner($: Host, vaultDir: string, os: Os): Promise<Owner | null> {
  try {
    return JSON.parse(await $.fs.read(chatFile(os, vaultDir, 'chat-owner.json'))) as Owner
  } catch {
    return null
  }
}

// このチャットを話し相手にする（印の時刻も書き直す）。
// Vault別フォルダーは、サーバーが一度動いて本人だけの権限で作ってから使う。まだなければ何もしない。
// os は brief の形に足したもの（ファイルの場所の区切りを決めるため）。
// since は相手になったきっかけ（本人の発言か /note）の時刻。印の時刻を書き直すときは前の since を渡して残す。
export async function claimChat($: Host, vaultDir: string, sessionId: string, os: Os, since?: number): Promise<void> {
  try {
    if (!sessionId || !(await $.fs.exists(vaultDir))) return
    const at = await $.clock.now()
    await $.fs.write(chatFile(os, vaultDir, 'chat-owner.json'), JSON.stringify({ session: sessionId, at, since: since || at }))
  } catch {
    // 書けなければ、前の相手のまま。
  }
}

// このチャットが話し相手なら外す。ほかのチャットが相手なら触らない。
export async function releaseChat($: Host, vaultDir: string, sessionId: string, os: Os): Promise<void> {
  const owner = await readOwner($, vaultDir, os)
  if (!sessionId || owner?.session !== sessionId) return
  try {
    await $.fs.write(chatFile(os, vaultDir, 'chat-owner.json'), JSON.stringify({ session: '', at: 0 }))
  } catch {
    // 書けなければ、40秒たてばエディターは「相手なし」と出す。
  }
}

// 開いているノートを添えるのは、エディターの切り替えがオン（share-note.json が on: true）のときだけ。
export async function shareIsOn($: Host, vaultDir: string, os: Os): Promise<boolean> {
  try {
    return JSON.parse(await $.fs.read(chatFile(os, vaultDir, 'share-note.json')))?.on === true
  } catch {
    return false
  }
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
