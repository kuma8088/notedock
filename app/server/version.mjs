// サーバーが知らせる自分のバージョン。作業場所では 0.0.0-dev のまま。ビルドのとき scripts/set-version.mjs が書き換える。
export const SERVER_VERSION = '0.0.0-dev'

// 新しいバージョンに譲って終わるときの終了コード。
export const HANDOVER_EXIT = 76

// 譲った記録（handover.json）を有効と見る時間。使う人が古いバージョンに戻したとき、ずっと起動できなくならないようにする。
export const HANDOVER_MS = 10 * 60 * 1000

// mod/notedock/hooks/target.ts の VERSION_RE、app/scripts/write-release.mjs と同じにする。
export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/

// 2つのバージョンを比べる（semver の順。-dev などの付いたバージョンは、付いていない同じ番号より古い）。
// mod/notedock/hooks/install.ts の compareVersions と同じ決まり。Modは別の実行環境（TypeScript）なので、写して持つ。
export function compareVersions(a, b) {
  const split = (v) => {
    const i = v.indexOf('-')
    return { core: (i < 0 ? v : v.slice(0, i)).split('.').map(Number), pre: i < 0 ? [] : v.slice(i + 1).split('.') }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}
