// サーバーにつながっているかを、文字を打つ前から定期的に確かめる。DOMには触らない。
// check は 'up'（応答あり）、'down'（応答なし）、'skip'（今は確かめない）のどれかを返す。
export function createConnectionWatch({
  check,
  onChange,
  intervalMs = 5000,
  goneAfterMs = 30000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let state = 'online'
  let downCount = 0
  let lastUpAt = now()
  let timer = null
  let running = false
  let busy = false

  const change = (next) => {
    if (next === state) return
    state = next
    onChange(next)
  }

  async function run() {
    if (busy) return
    busy = true
    let answer
    try {
      answer = await check()
    } catch {
      answer = 'down'
    } finally {
      busy = false
    }
    if (!running || answer === 'skip') return
    if (answer === 'up') {
      downCount = 0
      lastUpAt = now()
      change('online')
      return
    }
    downCount += 1
    if (downCount < 2) return
    change(now() - lastUpAt >= goneAfterMs ? 'gone' : state === 'gone' ? 'gone' : 'offline')
  }

  function schedule() {
    clearTimer(timer)
    if (!running) return
    timer = setTimer(async () => {
      try {
        await run()
      } catch {
        // 画面側の失敗で見張りを止めない。
      }
      schedule()
    }, intervalMs)
  }

  return {
    start() {
      if (running) return
      running = true
      downCount = 0
      lastUpAt = now()
      schedule()
    },
    stop() {
      running = false
      clearTimer(timer)
      timer = null
    },
    poke() {
      if (running) run().catch(() => {})
    },
    state: () => state,
  }
}

// サーバーのバージョンが、画面を読み込んだときと変わったら（新しいバージョンに入れ替わったら）、読み込み直す。
// 先に save で書きかけを保存しきる。save は 'saved'（保存しきった）・'conflict'（ほかの変更とぶつかった）・
// 'failed'（まだ保存できない）のどれかを返す。saved のときだけ読み込み直す。
// conflict のときは、今の画面のまま notify でお知らせを1回だけ出す。conflict・failed のあとも、次の確かめでやり直す
// （ぶつかりを選び終えて保存できたら、読み込み直す）。
// loaded が null（読み込んだときのサーバーに見出しがなかった）でも、今のサーバーにバージョンがあれば、変わったとみなす。
export function createVersionWatch({ loaded, save, reload, notify }) {
  let busy = false
  let done = false
  let told = false
  return {
    async seen(version) {
      if (done || !version || version === loaded) return 'same'
      if (busy) return 'busy'
      busy = true
      try {
        let result
        try {
          result = await save()
        } catch {
          result = 'failed'
        }
        if (result === 'saved') {
          done = true
          reload()
          return 'reloaded'
        }
        if (result === 'conflict') {
          if (!told) {
            told = true
            try {
              notify()
            } catch {
              // お知らせを出せなくても、画面はそのまま。
            }
          }
          return 'conflict'
        }
        return 'failed'
      } finally {
        busy = false
      }
    },
  }
}
