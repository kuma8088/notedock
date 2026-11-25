// 左（親のページ）で、ノートを表示している部分を左右に分ける。右の枠は同じページを /?pane=right で開いた iframe。
// main.mjs を読み込まない（main.mjs のほうから createSplit で作る）。

import { MSG, createReplyWaiters, isPaneMessage } from './pane.mjs'

export const SPLIT_LEFT_MIN = 320
export const SPLIT_RIGHT_MIN = 420
const READY_WAIT_MS = 10_000
const SAVE_WAIT_MS = 5_000

// 境目の位置（左の枠の幅の割合）を決める。total は左右の枠を合わせた幅、left はつかんで動かした左の枠の幅。
// 右は420px、左は320pxより狭くしない。両方を満たせない幅のときは半分ずつにする。
export function clampSplit(total, left) {
  if (!(total >= SPLIT_LEFT_MIN + SPLIT_RIGHT_MIN)) return 0.5
  const width = Math.max(SPLIT_LEFT_MIN, Math.min(total - SPLIT_RIGHT_MIN, Number(left) || 0))
  return width / total
}

// 右の枠の SAVED の返事を、保存の結果にする。dirty: false と書いてあるときだけ、保存しきれたとみなす。
export function savedResult(data) {
  return { dirty: data?.dirty !== false }
}

// 合図を待つ。合図が来るか、決めた時間がたったら終わる。時間切れのときは timeoutValue で終わる。
function waiter(list, ms, timeoutValue) {
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer)
      const index = list.indexOf(done)
      if (index >= 0) list.splice(index, 1)
      resolve(value)
    }
    const timer = setTimeout(() => done(timeoutValue), ms)
    list.push(done)
  })
}

function release(list, value) {
  for (const done of [...list]) done(value)
}

export function createSplit({ layout, editor, onMessage, onActiveChange }) {
  let frame = null
  let divider = null
  let ready = false
  let queue = []
  let current = 'left'
  // つかんで決めた割合。画面の幅が変わったときは、これを元に決め直す。
  let fraction = 0.5
  let opening = null
  let closing = null
  let observer = null
  const readyWaiters = []
  // 保存の頼みごと（pane:save）に id を付け、返事（pane:saved）は同じ id の待ちだけを解く。
  // 切れたあとに遅れて来た前の返事で、次の待ちを「保存できた」と解かないように（pane.mjs の createReplyWaiters）。
  const saveReplies = createReplyWaiters()

  editor.classList.add('pane-active')

  const send = (message) => frame?.contentWindow?.postMessage(message, location.origin)

  const panesWidth = () => editor.getBoundingClientRect().width + (frame?.getBoundingClientRect().width ?? 0)

  function applyFraction() {
    if (!frame) return
    layout.style.setProperty('--split', String(clampSplit(panesWidth(), fraction * panesWidth())))
  }

  // 書式のボタンとお知らせは #layout の外にあるので、左の枠と同じ幅にする。
  function syncLeftWidth() {
    document.body.style.setProperty('--split-left-width', `${editor.getBoundingClientRect().width}px`)
  }

  function markActive() {
    editor.classList.toggle('pane-active', current === 'left')
    frame?.classList.toggle('pane-active', current === 'right')
  }

  window.addEventListener('message', (event) => {
    if (!frame || !isPaneMessage(event, { origin: location.origin, source: frame.contentWindow })) return
    const data = event.data
    if (data.type === MSG.READY) {
      ready = true
      // 先に、開くノートなどを main.mjs に送り直してもらう。そのあとで、待たせていた連絡を送る（こちらのほうが新しい）。
      onMessage(data)
      const pending = queue
      queue = []
      for (const message of pending) send(message)
      release(readyWaiters)
      return
    }
    if (data.type === MSG.SAVED) saveReplies.answer(data.id, savedResult(data))
    onMessage(data)
  })

  function setupDivider() {
    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      divider.setPointerCapture(event.pointerId)
      document.body.classList.add('split-resizing')
      const left = editor.getBoundingClientRect().left
      const move = (e) => {
        const total = panesWidth()
        fraction = clampSplit(total, e.clientX - left)
        layout.style.setProperty('--split', String(fraction))
      }
      const end = () => {
        divider.removeEventListener('pointermove', move)
        divider.removeEventListener('pointerup', end)
        divider.removeEventListener('pointercancel', end)
        document.body.classList.remove('split-resizing')
      }
      divider.addEventListener('pointermove', move)
      divider.addEventListener('pointerup', end)
      divider.addEventListener('pointercancel', end)
    })
  }

  function isOpen() {
    return Boolean(frame)
  }

  function open() {
    if (opening) return opening
    if (frame) return Promise.resolve()
    ready = false
    queue = []
    fraction = 0.5
    divider = document.createElement('div')
    divider.id = 'split-divider'
    divider.setAttribute('role', 'separator')
    divider.setAttribute('aria-orientation', 'vertical')
    divider.setAttribute('aria-label', '左右の枠の境目')
    divider.title = 'ドラッグで左右の幅を変える'
    frame = document.createElement('iframe')
    frame.id = 'split-right'
    frame.title = '右の枠'
    frame.src = '/?pane=right'
    layout.style.setProperty('--split', '0.5')
    editor.after(divider, frame)
    document.body.classList.add('split-open')
    setupDivider()
    markActive()
    observer = new ResizeObserver(syncLeftWidth)
    observer.observe(editor)
    syncLeftWidth()
    window.addEventListener('resize', applyFraction)
    // 合言葉が無効などで「準備ができた」が来なくても、10秒で待つのをやめる。右の枠はそのまま残し、そこで合言葉を入れられるようにする。
    opening = waiter(readyWaiters, READY_WAIT_MS).then(() => {
      opening = null
    })
    return opening
  }

  // { dirty } を返す。dirty が true なら、右の枠に保存しきれていない書きかけがある（か、確かめられなかった）。
  function save() {
    // 準備ができていない右の枠や閉じた枠には、開いたノートがないので、保存するものもない。
    if (!frame || !ready) return Promise.resolve({ dirty: false })
    // 5秒たっても返事がなければ、保存できたとは言えないので dirty として扱う。
    const { id, promise } = saveReplies.wait(SAVE_WAIT_MS, { dirty: true })
    send({ type: MSG.SAVE, id })
    return promise
  }

  function close() {
    if (closing) return closing
    if (!frame) return Promise.resolve()
    closing = (async () => {
      await save()
      window.removeEventListener('resize', applyFraction)
      observer?.disconnect()
      observer = null
      frame.remove()
      divider.remove()
      frame = null
      divider = null
      ready = false
      queue = []
      release(readyWaiters)
      // 閉じたので返事は来ない。保存できたとは言えないので dirty として扱う。
      saveReplies.answerAll({ dirty: true })
      document.body.classList.remove('split-open')
      document.body.style.removeProperty('--split-left-width')
      layout.style.removeProperty('--split')
      setActive('left')
      markActive()
    })().finally(() => {
      closing = null
    })
    return closing
  }

  function post(message) {
    if (!frame) return
    if (ready) send(message)
    else queue.push(message)
  }

  function active() {
    return current
  }

  // 操作中の枠が変わったときだけ動く。同じ枠のままなら、打つたびに連絡が走らないよう何もしない。
  function setActive(pane) {
    const next = pane === 'right' && frame ? 'right' : 'left'
    if (next === current) return
    current = next
    markActive()
    post({ type: MSG.ACTIVE, active: next === 'right' })
    onActiveChange(next)
  }

  return { isOpen, open, save, close, post, active, setActive }
}
