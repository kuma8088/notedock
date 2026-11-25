import fs from 'node:fs'
import path from 'node:path'

import { PERIODS } from '../src/periodic.mjs'
import { TASK_SOON_DAYS, TASK_SOON_DAYS_MAX, TASK_SOON_DAYS_MIN, isSoonDays } from '../src/task-buckets.mjs'
import { checkSegment, resolveFolderPath, resolveNotePath } from './paths.mjs'

// Vault別フォルダーの settings.json を読む。画面から問い合わせが来るたびに呼ぶ（書き換えがすぐ効くように）。
// ファイルがなければ、すべて既定（エラーなし）。JSONが壊れていれば既定でエラー1件。知らない項目は無視する。
export function readVaultSettings(vaultDir, root) {
  const result = { attachmentDir: null, periodic: null, unlisted: new Set(), taskSoonDays: TASK_SOON_DAYS, errors: [] }
  let text
  try {
    text = fs.readFileSync(path.join(vaultDir, 'settings.json'), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') result.errors.push(`settings.jsonを読めません：${error.message}`)
    return result
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    result.errors.push('settings.jsonのJSONが壊れています')
    return result
  }
  return checkVaultSettings(json, root)
}

// 読み込んだ中身（JSON）だけを確かめる。ファイルは読まない。書く前の確認にも使う。
export function checkVaultSettings(json, root) {
  const result = { attachmentDir: null, periodic: null, unlisted: new Set(), taskSoonDays: TASK_SOON_DAYS, errors: [] }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    result.errors.push('settings.jsonの中身がオブジェクトではありません')
    return result
  }
  const templateOk = (value) => {
    try {
      resolveNotePath(root, value)
      return true
    } catch {
      return false
    }
  }
  const segmentOk = (name) => {
    if (typeof name !== 'string' || name.includes('/')) return false
    try {
      checkSegment(name)
      return true
    } catch {
      return false
    }
  }
  const folder = (value) => {
    if (typeof value !== 'string') return null
    const rel = value.replace(/\/+$/, '')
    if (!rel) return null
    try {
      resolveFolderPath(root, rel)
    } catch {
      return null
    }
    return rel
  }
  if (json.attachmentDir !== undefined) {
    const rel = folder(json.attachmentDir)
    if (rel) result.attachmentDir = rel
    else result.errors.push(`attachmentDirの場所が使えません：${String(json.attachmentDir)}`)
  }
  if (json.periodic !== undefined) {
    const p = json.periodic
    const rel = p && typeof p === 'object' && !Array.isArray(p) ? folder(p.root) : null
    if (!rel) {
      result.errors.push('periodic.rootの場所が使えません')
    } else {
      const templates = {}
      const t = p.templates
      if (t !== undefined) {
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
          result.errors.push('periodic.templatesがオブジェクトではありません')
        } else {
          for (const [key, value] of Object.entries(t)) {
            if (PERIODS.includes(key) && typeof value === 'string' && value) {
              // 使えない場所のひな形も残す。ノートを作るときに読めず、止める（ひな形なしでは作らない）。
              templates[key] = value
              if (!templateOk(value)) result.errors.push(`periodic.templatesの${key}の場所が使えません：${value}`)
            } else result.errors.push(`periodic.templatesの${key}が正しくありません`)
          }
        }
      }
      result.periodic = { root: rel, templates }
    }
  }
  if (json.unlisted !== undefined) {
    if (!Array.isArray(json.unlisted)) {
      result.errors.push('unlistedが配列ではありません')
    } else {
      for (const name of json.unlisted) {
        if (segmentOk(name)) result.unlisted.add(name)
        else result.errors.push(`unlistedに使えない名前があります：${String(name)}`)
      }
    }
  }
  // タスクのパネルの「直近」の日数（tasks.soonDays）。ない・使えないときは初期値の3のまま。
  if (json.tasks !== undefined) {
    const t = json.tasks
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      result.errors.push('tasksがオブジェクトではありません')
    } else if (t.soonDays !== undefined) {
      if (isSoonDays(t.soonDays)) result.taskSoonDays = t.soonDays
      else result.errors.push(`tasks.soonDaysは${TASK_SOON_DAYS_MIN}から${TASK_SOON_DAYS_MAX}までの整数にしてください：${String(t.soonDays)}`)
    }
  }
  return result
}
