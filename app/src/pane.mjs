// 右の枠（iframe）とのやり取りで使う、DOMに触れない判断の関数。

export const MSG = {
  READY: 'pane:ready',
  OPEN: 'pane:open',
  CLICKED: 'pane:clicked',
  OPENED: 'pane:opened',
  STATE: 'pane:state',
  ACTIVE: 'pane:active',
  JUMP: 'pane:jump',
  CHAT: 'pane:chat',
  HISTORY: 'pane:history',
  SEARCH: 'pane:search',
  THEME: 'pane:theme',
  SAVE: 'pane:save',
  // SAVED は { dirty }。保存を試したあと、まだ保存できていない書きかけがあれば true。
  SAVED: 'pane:saved',
  CLOSE: 'pane:close',
  // タスクのノートを保存した。反対の枠のタスクのパネルも読み直す。
  TASKS: 'pane:tasks',
  // タスクのノートでないノートを保存した（右の枠から左へ）。左はサイドバーのタスクの一覧だけを読み直す（リンクが外れたかが変わるため）。
  NOTE_SAVED: 'pane:note-saved',
  // 右の枠でタスクのノートをゴミ箱へ移した（右から左へ）。{ paths, open }。左でそのどれかを開いていれば、open（リンク元のノート。なければ null）を開き直す。
  TRASHED: 'pane:trashed',
  // 右の枠でタスクのノートをゴミ箱へ移す前に、左で同じノートを開いていれば保存してもらう（右から左へ）。{ paths }。
  SAVE_LEFT: 'pane:save-left',
  // SAVE_LEFT の返事（左から右へ）。{ dirty }。保存しきれなかった書きかけがあれば true。
  LEFT_SAVED: 'pane:left-saved',
}

// 同じアドレスから、pane: の連絡として来たものだけを受け付ける。source を渡したときは、その枠からのものだけ。
export function isPaneMessage(event, { origin, source = null }) {
  if (event.origin !== origin) return false
  if (source && event.source !== source) return false
  const type = event.data?.type
  return typeof type === 'string' && type.startsWith('pane:')
}

// 開く枠を決める。Cmdを押していれば、基準の枠の反対側。
export function targetPane({ meta, from, active }) {
  const base = from === 'sidebar' ? active : from
  if (!meta) return base
  return base === 'left' ? 'right' : 'left'
}

// 一時保存のキー。右の枠は左と分けて保存する。
export function draftKey(vault, path, pane) {
  const key = `draft:${vault}:${path}`
  return pane === 'right' ? `${key}:right` : key
}

// 開き直すときに戻す一時保存を選ぶ。右の枠が閉じていて左が空のときだけ、右の保存を左へ移す。
export function pickDraft({ pane, left, right, rightOpen }) {
  if (pane === 'right') return { draft: right, removeRight: false }
  if (left) return { draft: left, removeRight: false }
  if (!rightOpen && right) return { draft: right, removeRight: true }
  return { draft: null, removeRight: false }
}
