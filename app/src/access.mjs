const HASH_TOKEN = /^#t=([A-Za-z0-9_-]{43})$/
const HASH_TICKET = /^#c=([A-Za-z0-9_-]{43})$/
let fileKey = ''

export function tokenFromHash(hash) {
  return HASH_TOKEN.exec(hash)?.[1] ?? null
}

export function ticketFromHash(hash) {
  return HASH_TICKET.exec(hash)?.[1] ?? null
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
