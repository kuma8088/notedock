// サーバーのバージョンを書き換える。使い方: node scripts/set-version.mjs <バージョン>
// 形が違えば、何も書かずに 2 で終わる。NOTEDOCK_APP_DIR はテスト用（app の場所を差し替える）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { VERSION_RE } from '../server/version.mjs'

const args = process.argv.slice(2)
const version = args[0]
if (args.length !== 1 || !VERSION_RE.test(version)) {
  console.error('set-version: バージョンは 0.1.0 や 0.1.0-rc.1 の形で、1つだけ指定してください')
  process.exit(2)
}
const appDir = process.env.NOTEDOCK_APP_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(appDir, 'server', 'version.mjs')
const text = fs.readFileSync(file, 'utf8')
const next = text.replace(/^export const SERVER_VERSION = '[^']*'$/m, `export const SERVER_VERSION = '${version}'`)
if (next === text && !text.includes(`SERVER_VERSION = '${version}'`)) {
  console.error('set-version: version.mjs に SERVER_VERSION が見つかりません')
  process.exit(1)
}
fs.writeFileSync(file, next)
console.log(`SERVER_VERSION = ${version}`)
