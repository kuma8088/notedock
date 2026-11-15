import fs from 'node:fs'

import { build } from 'esbuild'

// 名前にハッシュが付くので、消さないと前の版が残り続ける。
fs.rmSync('public/assets/chunks', { recursive: true, force: true })

const result = await build({
  entryPoints: { main: 'src/main.mjs', style: 'src/style.css' },
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  sourcemap: false,
  outdir: 'public/assets',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'fonts/[name]-[hash]',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  metafile: true,
  logLevel: 'warning',
})

// 取り込んだ外部の部品を調べるために、入力の一覧を書き出す（scripts/third-party.mjs が読む）。
fs.mkdirSync('dist', { recursive: true })
fs.writeFileSync('dist/meta.json', JSON.stringify(result.metafile))
