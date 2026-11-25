const IS_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')

// MacならCmd、それ以外ならCtrlを押しているか。MacのCtrl+Eなどはカーソルの移動なので、含めない。
export function isCommandKey(event, mac = IS_MAC) {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

// 「本文へ移る」キー（MacはCmd+E、WindowsはCtrl+E）か。MacのCtrl+Eは行の終わりへの移動なので含めない。
export function isBodyKey(event, mac = IS_MAC) {
  if (!isCommandKey(event, mac) || event.altKey || event.shiftKey || event.isComposing) return false
  return event.key?.toLowerCase() === 'e'
}

// 取り消しとやり直しのキーなら、その名前を返す。
export function historyKey(event, mac = IS_MAC) {
  if (!isCommandKey(event, mac) || event.altKey) return null
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && !event.shiftKey) return 'redo'
  return null
}

// 画面に出すキーの案内。Macは「Cmd」、それ以外（Windows）は「Ctrl」にする。
export function keyLabel(text, mac = IS_MAC) {
  return mac ? text : text.replace(/\bCmd\+/g, 'Ctrl+')
}

// index.html に書いた案内（ボタンの title、入力欄の placeholder、kbd の文字）を、Mac以外ではCtrlに書き換える。
export function localizeKeyHints(root, mac = IS_MAC) {
  if (mac) return
  for (const name of ['title', 'placeholder']) {
    for (const el of root.querySelectorAll(`[${name}]`)) {
      const v = el.getAttribute(name)
      if (v && v.includes('Cmd+')) el.setAttribute(name, keyLabel(v, false))
    }
  }
  for (const el of root.querySelectorAll('kbd')) {
    if (el.textContent.includes('Cmd+')) el.textContent = keyLabel(el.textContent, false)
  }
}
