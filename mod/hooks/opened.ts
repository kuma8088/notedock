// 開いたフォルダーの記録：<保存フォルダー>/opened.json。帯の「ノートを開く」を一度押したフォルダーを覚える。
// 書くのは時刻だけ。合言葉や鍵は書かない。
import { joinPath, moveCmd, runCmd, type HostInfo } from './platform'

type Host = any

export type OpenedEntry = { at: number }

function openedFile(host: HostInfo): string {
  return joinPath(host.os, host.stateDir, 'opened.json')
}

// 読めない・壊れているときは空。形の合わない項目は捨てる。
export async function readOpened($: Host, host: HostInfo): Promise<Record<string, OpenedEntry>> {
  try {
    const j = JSON.parse(await $.fs.read(openedFile(host)))
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {}
    const out: Record<string, OpenedEntry> = {}
    for (const [k, v] of Object.entries(j)) {
      const at = (v as any)?.at
      if (typeof at === 'number' && Number.isFinite(at)) out[k] = { at }
    }
    return out
  } catch {
    return {}
  }
}

// .tmp-<乱数> に書いてから差し替える。書けなくても例外にしない（開く処理は続ける）。
export async function markOpened($: Host, host: HostInfo, key: string, patch: Partial<OpenedEntry>): Promise<void> {
  const all = await readOpened($, host)
  const at = typeof patch.at === 'number' ? patch.at : all[key]?.at ?? (await $.clock.now())
  all[key] = { at }
  const file = openedFile(host)
  const tmp = joinPath(host.os, host.stateDir, `.tmp-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`)
  try {
    await $.fs.write(tmp, JSON.stringify(all))
    await runCmd($, moveCmd(host, tmp, file))
  } catch {
    // 記録できなくても、開く処理は続ける。次に押したときにまた書く。
  }
}

// フォルダーの差し替えの記録：<保存フォルダー>/refresh.json。
// 予備のチャット（~/.claude/spares/ で始まり、あとで選んだフォルダーへ移る）で、押したときにフォルダーを取り直して
// 差し替えたことを残す。修正が効いたかを、あとから本人の手を借りずに確かめるため。最新の REFRESH_KEEP 件だけ残す。
export type RefreshEntry = { at: number; from: string; to: string }
export const REFRESH_KEEP = 20

function refreshFile(host: HostInfo): string {
  return joinPath(host.os, host.stateDir, 'refresh.json')
}

// .tmp-<乱数> に書いてから差し替える。書けなくても例外にしない（押したあとの処理は続ける）。
export async function saveRefresh($: Host, host: HostInfo, entry: RefreshEntry): Promise<void> {
  let list: RefreshEntry[] = []
  try {
    const j = JSON.parse(await $.fs.read(refreshFile(host)))
    if (Array.isArray(j)) list = j.filter(e => e && typeof e.at === 'number' && typeof e.from === 'string' && typeof e.to === 'string')
  } catch {
    // 無い・壊れているときは、空から始める
  }
  list.push(entry)
  list = list.slice(-REFRESH_KEEP)
  const tmp = joinPath(host.os, host.stateDir, `.tmp-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`)
  try {
    await $.fs.write(tmp, JSON.stringify(list))
    await runCmd($, moveCmd(host, tmp, refreshFile(host)))
  } catch {
    // 記録できなくても、差し替えと押したあとの処理は続ける
  }
}
