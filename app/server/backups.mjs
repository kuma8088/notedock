import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DAY = 24 * 60 * 60 * 1000
const KEEP = { previous: DAY, snapshot: 7 * DAY, conflict: 7 * DAY, daily: 30 * DAY }
const SNAPSHOT_GAP = 5 * 60 * 1000
const MAX_PREVIOUS = 200
const BACKUP_NAME = /^(previous|snapshot|conflict|daily)-(\d+)-\d+\.md$/

const VAULT_FOLDER = /^[0-9a-f]{16}$/

// パソコンに設定されたタイムゾーンで見た日付（YYYY-MM-DD）。
export function localDay(ms) {
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function createBackups(dir, { vaultId, now = Date.now, dayOf = localDay } = {}) {
  if (typeof vaultId !== 'string' || !VAULT_FOLDER.test(vaultId)) throw new Error('vaultId is required (16 hex chars)')
  let counter = 0
  const folder = (rel) => path.join(dir, vaultId, crypto.createHash('sha1').update(rel).digest('hex').slice(0, 20))

  function entries(rel) {
    let names
    try {
      names = fs.readdirSync(folder(rel))
    } catch {
      return []
    }
    return names
      .flatMap((name) => {
        const match = name.match(BACKUP_NAME)
        return match ? [{ name, kind: match[1], time: Number(match[2]) }] : []
      })
      .sort((a, b) => b.time - a.time)
  }

  function save(rel, text, kind) {
    const target = folder(rel)
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(target, '_path.txt'), rel)
    const latest = entries(rel).find((entry) => entry.kind === kind)
    if (latest && fs.readFileSync(path.join(target, latest.name), 'utf8') === text) return
    counter += 1
    fs.writeFileSync(path.join(target, `${kind}-${now()}-${counter}.md`), text, { mode: 0o600 })
    if (kind === 'previous') {
      for (const old of entries(rel).filter((entry) => entry.kind === 'previous').slice(MAX_PREVIOUS)) {
        fs.rmSync(path.join(target, old.name), { force: true })
      }
    }
  }

  function snapshot(rel, text) {
    const latest = entries(rel).find((entry) => entry.kind === 'snapshot')
    if (latest && now() - latest.time < SNAPSHOT_GAP) return false
    save(rel, text, 'snapshot')
    return true
  }

  // その日最初に書き換える直前の中身を残す。前の日と同じ中身でも比べずに書く。
  function firstOfDay(rel, text) {
    const today = dayOf(now())
    if (entries(rel).some((entry) => entry.kind === 'daily' && dayOf(entry.time) === today)) return false
    const target = folder(rel)
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(target, '_path.txt'), rel)
    counter += 1
    fs.writeFileSync(path.join(target, `daily-${now()}-${counter}.md`), text, { mode: 0o600 })
    return true
  }

  function list(rel) {
    return entries(rel).map((entry) => ({
      id: entry.name,
      kind: entry.kind,
      time: entry.time,
    }))
  }

  function read(rel, id) {
    if (!entries(rel).some((entry) => entry.name === id)) return null
    return fs.readFileSync(path.join(folder(rel), id), 'utf8')
  }

  function prune() {
    let folders
    try {
      folders = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of folders) {
      if (!item.isDirectory() || !VAULT_FOLDER.test(item.name)) continue
      const vaultBase = path.join(dir, item.name)
      let noteFolders
      try {
        noteFolders = fs.readdirSync(vaultBase, { withFileTypes: true })
      } catch {
        continue
      }
      for (const noteFolder of noteFolders) {
        if (!noteFolder.isDirectory()) continue
        const base = path.join(vaultBase, noteFolder.name)
        let names
        try {
          names = fs.readdirSync(base)
        } catch {
          continue
        }
        for (const name of names) {
          const match = name.match(BACKUP_NAME)
          if (!match || now() - Number(match[2]) <= KEEP[match[1]]) continue
          try {
            fs.rmSync(path.join(base, name), { force: true })
          } catch {
            // 同時に消えたり使用中だったりしたら、次の回に任せる。
          }
        }
      }
    }
  }

  // ノートを動かしたり名前を変えたりしたときに、履歴も新しい場所へ移す。
  function rename(from, to) {
    const source = folder(from)
    const target = folder(to)
    if (source === target || !fs.existsSync(source)) return
    if (!fs.existsSync(target)) {
      fs.renameSync(source, target)
      return
    }
    for (const name of fs.readdirSync(source)) fs.renameSync(path.join(source, name), path.join(target, name))
    fs.rmSync(source, { recursive: true, force: true })
  }

  return { save, snapshot, firstOfDay, list, read, prune, rename }
}
