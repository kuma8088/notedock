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
