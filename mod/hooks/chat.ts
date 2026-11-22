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
  lines?: { from: number; to: number } | null // 選んでいる行（1から数える）。何も選んでいなければ無い
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

// 入力欄の @ の候補に出す「選んでいる行」の1行。text は候補を選んだときに入る文（@場所#L12-18）。
// 本文はエンジンが @ のファイルとして読む（行の指定付き）。Modは本文を読まない。
// 出さないとき（ノートが無い・古い・行を選んでいない・場所に空白がある・もう選んだあと）は null。
export type LineMention = { text: string; label: string; description: string }

const MENTION_WORD = '@選んでいる行'

export function lineMention(state: EditorState, now: number, root: string, os: Os, token: string): LineMention | null {
  const info = noteInfo(state, now, root, os)
  const lines = state.lines
  if (!info || !lines) return null
  const { from, to } = lines
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return null
  // 空白のある場所は1語にならず、# のある場所は行の指定（#L）と紛れるので、出さない。
  if (/[\s#]/.test(info.where)) return null
  const text = `@${info.where}#L${from === to ? from : `${from}-${to}`}`
  if (token === text) return null
  const fits = token === '@' || text.startsWith(token) || MENTION_WORD.startsWith(token) || token.startsWith(MENTION_WORD)
  if (!fits) return null
  const range = from === to ? `${from}行` : `${from}〜${to}行`
  return {
    text,
    label: `選んでいる行：${state.path} の${range}`,
    // エンジンが読むのは保存したファイル。保存前の変更があると、行がずれることがある。
    description: info.dirty ? 'NoteDock（保存前の変更があるので、行がずれることがある）' : 'NoteDock',
  }
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

// 窓のチャット欄で打った文の中の「@場所#L12-18」。Modが送る文では、エンジンは @ のファイルを読まないので、
// Modが保存したファイルからその行を読み、文の末尾に添える。場所は Vault から見た場所に限る（外へ出る .. や絶対パスは読まない）。
export const MENTION_HEAD = '（@ で指した行。保存したファイルから読んだもの）'
const MAX_MENTIONS = 5 // 1つの文で読む @ の数
const MAX_MENTION_LINES = 400 // 1つの @ で読む行の数
const MAX_MENTION_TEXT = 20000 // 添える行の文字の合計

export type LineRef = { path: string; from: number; to: number }

export function lineRefsIn(text: string): LineRef[] {
  const found: LineRef[] = []
  const seen = new Set<string>()
  // @ の前が英数字や . _ % + - のとき（メールアドレスなど）は拾わない。後ろは数字・英字・- 以外なら何が続いてもよい（「@a.md#L1を直して」）。
  const re = /(?<![0-9A-Za-z._%+-])@([^\s@#]+)#L(\d+)(?:-(\d+))?(?![0-9A-Za-z_-])/g
  for (const m of text.matchAll(re)) {
    const path = m[1]
    const from = Number(m[2])
    const to = m[3] === undefined ? from : Number(m[3])
    if (!safeVaultPath(path) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) continue
    const key = `${path}#${from}-${to}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ path, from, to })
    if (found.length >= MAX_MENTIONS) break
  }
  return found
}

// Vault の中の .md だけ。絶対パス・ドライブ名・\ ・ . で始まる段（.. や .git も）・空の段は読まない（サーバーが断る名前と合わせる）。
export function safeVaultPath(path: string): boolean {
  if (!/\.md$/i.test(path) || path.startsWith('/') || /[\\:]/.test(path)) return false
  return path.split('/').every(part => part !== '' && !part.startsWith('.'))
}

// 読んだ中身（読めなければ null）から、文に添える塊を作る。行には番号を付ける。
export function mentionBlock(read: { ref: LineRef; where: string; text: string | null }[]): string | null {
  if (!read.length) return null
  const parts: string[] = []
  let used = 0
  for (const { ref, where, text } of read) {
    const name = `@${where}#L${ref.from === ref.to ? ref.from : `${ref.from}-${ref.to}`}`
    if (text === null) {
      parts.push(`${name}: 読めませんでした`)
      continue
    }
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    if (ref.from > lines.length) {
      parts.push(`${name}: このファイルは${lines.length}行までです`)
      continue
    }
    const last = Math.min(ref.to, lines.length, ref.from + MAX_MENTION_LINES - 1)
    const body: string[] = []
    for (let n = ref.from; n <= last; n += 1) {
      const line = `${n}\t${lines[n - 1]}`
      if (used + line.length > MAX_MENTION_TEXT) break
      used += line.length + 1
      body.push(line)
    }
    if (!body.length) {
      parts.push(`${name}: 長すぎるので添えませんでした`)
      continue
    }
    const shown = ref.from + body.length - 1
    const cut = shown < Math.min(ref.to, lines.length) ? `（${shown}行目まで。長いのでここで切りました）` : shown < ref.to ? `（このファイルは${lines.length}行までです）` : ''
    const longest = Math.max(2, ...body.map(line => (line.match(/`+/g) ?? []).reduce((a, b) => Math.max(a, b.length), 0)))
    const fence = '`'.repeat(longest + 1)
    parts.push(`${name}${cut}\n${fence}\n${body.join('\n')}\n${fence}`)
  }
  return `${MENTION_HEAD}\n${parts.join('\n\n')}`
}

// 打った文の @ の行を読んで、添える塊を作る。read はファイルを読む関数（読めなければ throw）。
// 読むのはエディターの Vault（state.root、無ければ会話のフォルダー）の中。塊に書く場所は、会話のフォルダーと同じなら Vault から見た場所。
// real は、たどった先の場所を返す関数（読めなければ throw）。シンボリックリンクで Vault の外へ出る場所は読まない。
// 打った文が上限（MAX_TEXT）で切られていたら、末尾で切れたかもしれない指定は読まない（別の行を読まないため）。
export async function mentionsForSend(
  typed: string,
  state: EditorState,
  root: string,
  os: Os,
  read: (path: string) => Promise<string>,
  real: (path: string) => Promise<string>,
): Promise<string | null> {
  const refs = lineRefsIn(typed.length >= MAX_TEXT ? typed.replace(/\S*$/, '') : typed)
  if (!refs.length) return null
  const vault = typeof state.root === 'string' && state.root ? state.root : root
  const other = rootKey(vault, os) !== rootKey(root, os)
  const win = (p: string) => (os === 'win32' ? p.replace(/\//g, '\\') : p)
  const read2 = await Promise.all(
    refs.map(async ref => {
      const file = joinPath(os, win(vault), win(ref.path))
      const inside = await Promise.all([real(vault), real(file)]).then(
        ([v, f]) => rootKey(f, os).startsWith(`${rootKey(v, os).replace(/[\\/]+$/, '')}${os === 'win32' ? '\\' : '/'}`),
        () => false,
      )
      const text = inside
        ? await read(file).then(
            t => (typeof t === 'string' ? t : null),
            () => null,
          )
        : null
      return { ref, where: other ? file : ref.path, text }
    }),
  )
  return mentionBlock(read2)
}

// 番の文が、エディターから送った文かどうか。sent は送った文そのもの（案内付き）か、
// Modを読み込み直したあとならエディターが書いた送る文（案内なし）。後者は、末尾に案内か @ の行が続く形も同じ文とみなす。
export function isSentText(turnText: string, sent: string): boolean {
  const a = turnText.trim()
  const b = sent.trim()
  if (a === b) return true
  if (b === '' || !a.startsWith(b)) return false
  const rest = a.slice(b.length).trimStart()
  return rest.startsWith(SEND_NOTE_HEAD) || rest.startsWith(MENTION_HEAD)
}

export function quoteForPrompt(text: string): string {
  return `${text
    .slice(0, MAX_TEXT)
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')}\n`
}
