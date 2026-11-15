import fs from 'node:fs'

function fingerprint(file) {
  try {
    const stat = fs.statSync(file)
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

// 書き込みの途中を読まないよう、大きさと更新日時が settleMs の間変わらなくなってから知らせる。
export function watchFile(file, onChange, { settleMs = 300, pollMs = 100 } = {}) {
  let known = fingerprint(file)
  let candidate = known
  let since = Date.now()
  const timer = setInterval(() => {
    const seen = fingerprint(file)
    if (seen !== candidate) {
      candidate = seen
      since = Date.now()
      return
    }
    if (candidate !== known && Date.now() - since >= settleMs) {
      known = candidate
      onChange({ exists: candidate !== 'missing' })
    }
  }, pollMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
