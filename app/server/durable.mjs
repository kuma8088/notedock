import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { PRODUCT } from './config.mjs'

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRIES = 5
const RETRY_WAIT_MS = 200
// 一時ファイルの印。ディスク上では今までどおり「.notedock-」になる（製品名は英字だけなので、そのまま正規表現に入れられる）。
const TEMP_MARK = PRODUCT.toLowerCase()
const TEMP_PATTERN = new RegExp(`^\\..+\\.${TEMP_MARK}-\\d+-[0-9a-z]+\\.tmp$`, 'i')
const MAX_DEPTH = 32
const MAX_ENTRIES = 20000

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Windowsでは、ウイルス対策ソフトなどがファイルを使っている間、差し替えが一時的に失敗することがある。
export function renameWithRetry(from, to, platform = process.platform) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      if (platform !== 'win32' || !RETRY_CODES.has(error.code) || attempt >= RETRIES) throw error
      sleep(RETRY_WAIT_MS)
    }
  }
}

// 一時ファイルに書いてディスクへ確定させ、書き終わってから差し替える。途中で落ちても元のファイルは壊れない。
export function replaceFile(file, data, { mode, check, platform = process.platform } = {}) {
  const dir = path.dirname(file)
  const temp = path.join(dir, `.${path.basename(file)}.${TEMP_MARK}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    const fd = fs.openSync(temp, 'wx', mode ?? 0o666)
    try {
      const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      let offset = 0
      while (offset < buffer.length) {
        const written = fs.writeSync(fd, buffer, offset, buffer.length - offset)
        if (!(written > 0)) throw new Error('write stalled')
        offset += written
      }
      if (mode !== undefined && platform !== 'win32') fs.fchmodSync(fd, mode)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (check && !check()) {
      fs.rmSync(temp, { force: true })
      return false
    }
    renameWithRetry(temp, file, platform)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
  if (platform !== 'win32') {
    try {
      const dirFd = fs.openSync(dir, 'r')
      try {
        fs.fsyncSync(dirFd)
      } finally {
        fs.closeSync(dirFd)
      }
    } catch {
      // フォルダーの確定ができないOSやディスクもある。差し替え自体は済んでいる。
    }
  }
  return true
}

// 強制終了で残った一時ファイルを、起動したときに片づける。
export function removeStaleTemps(root, { olderThanMs = 60 * 60 * 1000 } = {}) {
  let removed = 0
  let visited = 0
  const cutoff = Date.now() - olderThanMs
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= MAX_ENTRIES) return
      visited += 1
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'node_modules') continue
        walk(full, depth + 1)
      } else if (entry.isFile() && TEMP_PATTERN.test(entry.name)) {
        try {
          if (fs.statSync(full).mtimeMs < cutoff) {
            fs.rmSync(full, { force: true })
            removed += 1
          }
        } catch {
          // 消せなくても起動は続ける。
        }
      }
    }
  }
  walk(root, 0)
  return removed
}
