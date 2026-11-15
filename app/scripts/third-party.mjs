// 画面のプログラムに取り込んだ外部の部品のライセンスを集めて THIRD_PARTY_LICENSES を書く。
// 使い方: node scripts/third-party.mjs [--root <app>] [--meta <dist/meta.json>] [--deno <文章>] [--out <書き出し先>]
// 文章が見つからない部品があれば、何も書かずに 1 で終わる。
// package.json に license の欄がない部品は、いちばん上と見出しに目立つ形で出し、知らせる（止めない）。
// 引数の誤りや meta.json が読めないときは、何も書かずに 2 で終わる。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const OPTIONS = ['--root', '--meta', '--deno', '--out']

function fail(message) {
  console.error(`third-party: ${message}`)
  process.exit(2)
}

// 引数を読む。知らない引数や、値のない引数は、既定の値に頼らずに止める。
const given = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const name = argv[i]
  if (!OPTIONS.includes(name)) fail(`知らない引数です: ${name}（使えるのは ${OPTIONS.join(' ')}）`)
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) fail(`${name} のあとに値がありません`)
  given[name] = value
  i++
}

const root = path.resolve(given['--root'] ?? path.join(here, '..'))
const metaFile = path.resolve(given['--meta'] ?? path.join(root, 'dist', 'meta.json'))
const denoFile = path.resolve(given['--deno'] ?? path.join(here, 'licenses', 'deno.txt'))
const outFile = path.resolve(given['--out'] ?? path.join(root, 'THIRD_PARTY_LICENSES'))

const LICENSE_FILE = /^(licen[sc]e|copying|unlicense)(\.(md|txt|markdown))?$/i

// 入力の道筋から、いちばん内側の node_modules の部品のフォルダー（root からの道筋）を取り出す
function packageDirOf(input) {
  const parts = input.split(/[\\/]/)
  const i = parts.lastIndexOf('node_modules')
  if (i < 0 || i + 1 >= parts.length) return null
  const end = parts[i + 1].startsWith('@') ? i + 3 : i + 2
  return parts.slice(0, end).join('/')
}

let meta
try {
  meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
} catch {
  fail(`${metaFile} が読めません。先に npm run build で dist/meta.json を作ってください`)
}
const dirs = [...new Set(Object.keys(meta.inputs ?? {}).map(packageDirOf).filter(Boolean))].sort()

// 入れ子の node_modules にある別バージョンも、それぞれ読む。同じ名前と版は1回だけ並べる。
const sections = new Map()
const missing = []
const noField = [] // package.json に license の欄がない部品の見出し
for (const rel of dirs) {
  const dir = path.resolve(root, rel)
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    missing.push(`${rel}（package.json が読めない）`)
    continue
  }
  const file = fs.readdirSync(dir).sort().find(f => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
  if (!file) {
    missing.push(`${rel}（ライセンスの文章がない）`)
    continue
  }
  const name = rel.split('node_modules/').pop()
  const title = `${name} ${pkg.version ?? ''}`.trim()
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type
  if (sections.has(title)) continue
  if (!license) noField.push(title)
  sections.set(title, { title, license: license ?? 'package.json に license の欄なし。下のライセンス文を見てください', text: fs.readFileSync(path.join(dir, file), 'utf8').trim() })
}

if (missing.length) {
  console.error('third-party: ライセンスの文章が見つからない部品があります:')
  for (const m of missing) console.error(`  ${m}`)
  process.exit(1)
}

let denoText
try {
  denoText = fs.readFileSync(denoFile, 'utf8')
} catch {
  fail(`Deno のライセンスの文章 ${denoFile} が読めません`)
}
const deno = denoText.split('\n').filter(l => !l.startsWith('#')).join('\n').trim()
const rule = '='.repeat(72)
const out = [
  'NoteDock が取り込んでいる外部ライブラリのライセンス',
  '',
  `この文書は、NoteDock の画面のプログラム（app/public/assets）に取り込んでいる外部ライブラリ ${sections.size} 個のライセンスと、サーバーの実行ファイルに入っている実行環境 Deno のライセンスをまとめたものです。`,
  'Deno の中に入っている外部ライブラリ（V8 など）のライセンスは、この文書には入っていません。',
  ...(noField.length ? ['', `package.json に license の欄がない外部ライブラリが、${noField.length} 個あります（${noField.join('、')}）。${noField.length === 1 ? 'このライブラリ' : 'これらのライブラリ'}のライセンスは、下に載せたライセンス文で確認してください。`] : []),
  '',
  ...[...sections.values()].sort((x, y) => (x.title < y.title ? -1 : 1)).flatMap(s => [rule, `${s.title}  (${s.license})`, rule, s.text, '']),
  rule,
  'Deno  (MIT)  サーバーの実行ファイルに入る実行環境',
  rule,
  deno,
  '',
].join('\n')
fs.writeFileSync(outFile, out)
if (noField.length) console.error(`third-party: package.json に license の欄がない部品があります（文章は載せました。目で確かめてください）: ${noField.join('、')}`)
console.log(`third-party: ${sections.size} 個の部品と Deno を ${outFile} に書きました`)
