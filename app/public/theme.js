// 明るい画面・暗い画面を、本文を描く前に決める。後から変えると一瞬ちらつくため、ページの頭で読む。
// 選んでいなければ何もせず、Claudeアプリの設定（prefers-color-scheme）に従う。
try {
  const theme = JSON.parse(localStorage.getItem('theme'))
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
} catch {
  // 保存領域が使えなくても、アプリの設定に従って表示する。
}
