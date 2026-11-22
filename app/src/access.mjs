const SECRET_RE = /^[A-Za-z0-9_-]{43}$/
let fileKey = ''

// アドレスの # のあとは、t=（合言葉）・c=（一度だけのリンクの鍵）・s=（このエディターを開いたチャットの、一度だけ使える結び付けの合図）を & でつなぐ。
// t・c・s 以外の名前が入っていれば、見出しへの移動など別の使い方とみなして、どれも読まない。
function hashParts(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#') || hash.length < 2) return null
  const parts = {}
  for (const part of hash.slice(1).split('&')) {
    const m = /^([tcs])=([A-Za-z0-9_-]{43})$/.exec(part)
    if (!m || parts[m[1]]) return null
    parts[m[1]] = m[2]
  }
  return parts
}

export function tokenFromHash(hash) {
  return hashParts(hash)?.t ?? null
}

export function ticketFromHash(hash) {
  return hashParts(hash)?.c ?? null
}

export function chatLinkFromHash(hash) {
  return hashParts(hash)?.s ?? null
}

// このタブだけの、チャット欄の鍵（結び付けの合図と引き換えたもの）。タブの中（sessionStorage）だけに覚える。読み込み直しても同じタブなら残り、
// ほかのタブとは分けておく（別のチャットから開いたタブが、互いの送り先を使わないため）。
const CHAT_LINK_KEY = 'notedock-chat-link'

export function rememberChatLink(store, link) {
  try {
    if (link && SECRET_RE.test(link)) store?.setItem(CHAT_LINK_KEY, link)
  } catch {
    // 保存領域が使えなければ、このページを開いているあいだだけ使う。
  }
}

export function recalledChatLink(store) {
  try {
    const link = store?.getItem(CHAT_LINK_KEY) ?? ''
    return SECRET_RE.test(link) ? link : ''
  } catch {
    return ''
  }
}

export function setFileKey(key) {
  fileKey = key ?? ''
}

export function chatImageUrl(name) {
  return `/api/chat-image?file=${encodeURIComponent(name)}${fileKey ? `&k=${fileKey}` : ''}`
}

export function fileUrl(path) {
  return `/api/file?path=${encodeURIComponent(path)}${fileKey ? `&k=${fileKey}` : ''}`
}

// 開けない画面が、Modへ「鍵のリンクがほしい」と知らせる宛先。
// hadKey は「鍵付きの場所で開かれ、その鍵を断られた」とき true。アドレスに鍵が無かっただけなら false。
// Modは true のときだけClaudeに頼み直す（鍵の無い場所を読むのは、ふつうの開き方の途中でも起きるため）。
export function needTicketUrl(hadKey) {
  return `/api/need-ticket?hadKey=${hadKey ? 1 : 0}`
}

// 鍵を断られたあとに読み込み直すとき、そのことをタブの中で1回だけ引き継ぐ印。鍵そのものは書かない。
const KEY_REFUSED = 'notedock-key-refused'

export function markKeyRefused(store) {
  try {
    store?.setItem(KEY_REFUSED, '1')
  } catch {
    // 保存領域が使えなければ、引き継がない（鍵が無かったときと同じ扱いになる）。
  }
}

export function takeKeyRefused(store) {
  try {
    const marked = store?.getItem(KEY_REFUSED) === '1'
    if (marked) store.removeItem(KEY_REFUSED)
    return marked
  } catch {
    return false
  }
}

// 結び付けの合図は、引き換えが済むまでタブの中（sessionStorage）に退避する。アドレスから消したあとや、
// 合言葉がまだ無くて引き換えられなかったあと（読み込み直しても）、もう一度引き換えられるようにするため。
const CHAT_BIND_KEY = 'notedock-chat-bind'

export function stashBindCode(store, code) {
  try {
    if (code && SECRET_RE.test(code)) store?.setItem(CHAT_BIND_KEY, code)
  } catch {
    // 保存領域が使えなければ、このページを開いているあいだだけ使う。
  }
}

export function stashedBindCode(store) {
  try {
    const code = store?.getItem(CHAT_BIND_KEY) ?? ''
    return SECRET_RE.test(code) ? code : ''
  } catch {
    return ''
  }
}

// 送った合図と同じものが退避されているときだけ消す（待つあいだに新しい合図が来ていれば残す）。
function dropBindCode(store, code) {
  try {
    if (store?.getItem(CHAT_BIND_KEY) === code) store.removeItem(CHAT_BIND_KEY)
  } catch {
    // 消せなくても、次の引き換えで断られて消える。
  }
}

// 合図を、このタブだけの鍵と引き換える。開けない画面のあいだも送れるよう、問い合わせの共通の口を通さずに fetch で直接送る。
// 引き換えられたら鍵を覚えて返す。合図が使えない（使用済み・期限切れ・形が違う。400・404）ときは合図を捨てる。
// 合言葉がまだ無い（401）・つながらないなどのときは、合図を残して null を返す（あとでもう一度引き換える）。
export async function bindChatCode({ store, fetchImpl, token, code = stashedBindCode(store) }) {
  if (!code) return null
  let response
  try {
    response = await fetchImpl('/api/chat-bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-note-editor': '1', ...(token ? { 'x-note-token': token } : {}) },
      body: JSON.stringify({ bind: code }),
    })
  } catch {
    return null
  }
  if (response.status === 400 || response.status === 404) {
    dropBindCode(store, code)
    return null
  }
  if (!response.ok) return null
  let cred = null
  try {
    cred = (await response.json())?.cred
  } catch {
    return null
  }
  if (typeof cred !== 'string' || !SECRET_RE.test(cred)) return null
  rememberChatLink(store, cred)
  dropBindCode(store, code)
  return cred
}

// チャット欄の案内。none は、このタブがどのチャットとも結び付いていないとき。gone は、結び付いたチャットがもう無いとき。
export const CHAT_PARTNER_TEXT = {
  none: 'このエディターは、Claudeのチャットとつながっていません。Claudeアプリで送りたいチャットを開き、「ノートを開く」を押すか /note のリンクから開き直すと送れます。',
  gone: 'つながっていたチャットが見つかりません（チャットを閉じたか、/clear やアプリの開き直しのあとかもしれません）。Claudeアプリで送りたいチャットを開き、「ノートを開く」を押し直してください。',
}

// 送れなかったときに出す文。サーバーが断った理由（409 の error）と、今の相手の様子（partner）で出し分ける。
export function sendFailText(result, partner) {
  const error = result?.data?.error
  if (error === 'chat-gone') return CHAT_PARTNER_TEXT.gone
  if (error === 'no-chat') return CHAT_PARTNER_TEXT.none
  if (result?.status === 409 || partner === 'gone') return CHAT_PARTNER_TEXT.gone
  if (partner === 'none') return CHAT_PARTNER_TEXT.none
  return '送れませんでした。エディターを読み込み直して確かめてください。'
}
