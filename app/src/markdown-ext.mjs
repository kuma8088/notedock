import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'

import { AlphaList } from './alpha-list.mjs'
import { AlphaListSyntax } from './alpha-list-syntax.mjs'
import { noteSyntaxExtensions } from './markdown-syntax.mjs'

// 読み取りの広げ方は markdown-syntax.mjs（リンクの数え方と同じもの）。英字の項目だけ、たためるようにした AlphaList を使う。
export const noteMarkdownExtensions = noteSyntaxExtensions.map((ext) => (ext === AlphaListSyntax ? AlphaList : ext))

export function noteMarkdown(codeLanguages) {
  return markdown({
    base: commonmarkLanguage,
    extensions: noteMarkdownExtensions,
    addKeymap: false,
    ...(codeLanguages ? { codeLanguages } : {}),
  })
}
