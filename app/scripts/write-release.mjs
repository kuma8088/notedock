// 配布の一覧（Modの hooks/release.ts）を書き出す。
// 使い方: node scripts/write-release.mjs --version <v> --base-url <url> --dist <dir> --out <file>
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

// mod/notedock/hooks/target.ts の Target と VERSION_RE と同じにする
const TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc']
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/

// 使い方が間違っていたら、何も書かずに 2 で終わる
function fail(message) {
  console.error(`write-release: ${message}`)
  process.exit(2)
}

// Windowsの種類だけ .exe が付く
function fileNameOf(target) {
  return `notedock-server-${target}${target.includes('windows') ? '.exe' : ''}`
}

// 知らない引数や余分な引数も、何も書かずに 2 で終わる
let values
try {
  ;({ values } = parseArgs({
    options: {
      version: { type: 'string' },
      'base-url': { type: 'string' },
      dist: { type: 'string' },
      out: { type: 'string' },
    },
  }))
} catch (e) {
  fail(e.message)
}
const { version, dist, out } = values
const baseUrl = values['base-url']

if (!version || !VERSION_RE.test(version)) fail('--version は 0.1.0 や 0.1.0-dev の形で指定してください')
if (!baseUrl || !/^(https|file):\/\//.test(baseUrl)) fail('--base-url は https:// か file:// で始めてください')
try {
  new URL(baseUrl)
} catch {
  fail('--base-url が URL として読めません')
}
if (!baseUrl.endsWith('/')) fail('--base-url は / で終えてください')
if (!dist || !fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) fail('--dist に存在するフォルダーを指定してください')
if (!out) fail('--out を指定してください')

// 見つかった種類だけを一覧に入れる
const lines = []
for (const target of TARGETS) {
  const file = fileNameOf(target)
  const full = path.join(dist, file)
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue
  const bytes = fs.readFileSync(full)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  lines.push(`  ${JSON.stringify(target)}: { file: ${JSON.stringify(file)}, size: ${bytes.length}, sha256: ${JSON.stringify(sha256)} },`)
}

const type = 'Partial<Record<Target, { file: string; size: number; sha256: string }>>'
const assets = lines.length === 0 ? `export const ASSETS: ${type} = {}` : `export const ASSETS: ${type} = {\n${lines.join('\n')}\n}`
const text = [
  '// このファイルは scripts/write-release.mjs が作る。手で直さない。',
  "import type { Target } from './target'",
  `export const VERSION = ${JSON.stringify(version)}`,
  `export const BASE_URL = ${JSON.stringify(baseUrl)}`,
  assets,
  '',
].join('\n')

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
fs.writeFileSync(out, text)
