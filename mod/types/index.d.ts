// 入力欄の上の帯に出すもの。null なら帯を出さない。
export type Band =
  | { kind: 'button'; today: boolean } // 「ノートを開く」（と「今日のノート」）
  | { kind: 'preparing' } // 準備しています…（初めてのときは、約80MBをダウンロードします）
  | { kind: 'starting' } // NoteDockを起動しています…
  | { kind: 'opening' } // 開いています…（Claudeの作業が終わると開きます）
  | { kind: 'replacing' } // 新しいバージョンに入れ替えています…
  | { kind: 'problem'; text: string; button: boolean } // 理由。button が true なら「ノートを開く」も出す
  | null

declare module 'claude-code' {
  interface PluginState {
    notedock: { band: Band }
  }
}
