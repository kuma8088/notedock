// エディターを開くリンクと、Claudeに頼む文。
// 鍵（一度しか使えないリンク用の文字列）は、頼む文と /note の返事にだけ入る。合言葉は入れない。
// link は、このチャットのModが作った番号（推測できない文字列）。エディターのチャット欄の送り先を、このチャットに結び付ける。

export function editorUrl(o: { port: number; today: boolean; note?: string; ticket?: string | null; link?: string | null }): string {
  const query = o.today ? '?today=1' : o.note ? `?note=${encodeURIComponent(o.note)}` : ''
  const parts = [o.ticket ? `c=${o.ticket}` : '', o.link ? `s=${o.link}` : ''].filter(Boolean)
  const hash = parts.length ? `#${parts.join('&')}` : ''
  return `http://localhost:${o.port}/${query}${hash}`
}

// いつも鍵付きで頼む（2026-11-15 本人の決定）。
export function openPrompt(o: { port: number; ticket: string | null; today: boolean; note?: string; link?: string | null }): string {
  const url = editorUrl({ port: o.port, today: o.today, note: o.note, ticket: o.ticket, link: o.link })
  const label = o.today ? '今日のノート' : 'ノートを開く'
  return `NoteDockを開いてください。ブラウザパネルで、preview_start に http://localhost:${o.port} を渡して開き、続けて navigate で ${url} へ移ってください。ほかの作業はしないでください。（入力欄の上の「${label}」から送っています）`
}

// 開けなかったときに1回だけ送る。そのときの鍵を読んで付ける。
export function retryPrompt(o: { port: number; ticket: string; today: boolean; note?: string; link?: string | null }): string {
  const url = editorUrl({ port: o.port, today: o.today, note: o.note, ticket: o.ticket, link: o.link })
  return `NoteDockが開けなかったので、navigate で ${url} へ移ってください。ほかの作業はしないでください。`
}
