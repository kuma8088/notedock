// Mod が指すサーバーの Releases が、main に入れてよい状態かを確かめる（CI から使う）。
// 使い方: node scripts/check-release-ref.mjs   （リポジトリの中で。mod/ を読み、BASE_URL の SHA256SUMS を curl で取る）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc']

// 見つけた問題を日本語の文の配列で返す（なければ空）。sums は SHA256SUMS の中身、取れなければ null
export function checkReleaseRef({ pluginVersion, releaseTs, sums }) {
  const problems = []
  const version = releaseTs.match(/^export const VERSION = "([^"]*)"$/m)?.[1]
  const baseUrl = releaseTs.match(/^export const BASE_URL = "([^"]*)"$/m)?.[1]
  if (!version) problems.push('release.ts の VERSION が読めません')
  if (!baseUrl) problems.push('release.ts の BASE_URL が読めません')
  if (version && pluginVersion !== version) {
    problems.push(`plugin.json の version（${pluginVersion}）と release.ts の VERSION（${version}）が違います`)
  }
  if (version && baseUrl && !baseUrl.endsWith(`/server-v${version}/`)) {
    problems.push(`release.ts の BASE_URL が server-v${version}/ で終わっていません: ${baseUrl}`)
  }
  if (sums === null) {
    problems.push('サーバーの Releases の SHA256SUMS を取れません（Releases が下書き、またはまだありません）。サーバーの Releases を公開してから main に入れてください')
    return problems
  }
  const listed = new Map()
  for (const line of sums.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/)
    if (m) listed.set(m[2], m[1])
  }
  for (const target of TARGETS) {
    const line = releaseTs.split('\n').find((l) => l.includes(`"${target}":`))
    const file = line?.match(/file: "([^"]*)"/)?.[1]
    const sha256 = line?.match(/sha256: "([^"]*)"/)?.[1]
    if (!file || !sha256) {
      problems.push(`release.ts に ${target} のファイル名かハッシュ値がありません`)
    } else if (listed.get(file) !== sha256) {
      problems.push(`release.ts の ${target}（${file}）のハッシュ値が、Releases の SHA256SUMS と合いません`)
    }
  }
  return problems
}

// 直接動かされたときだけ（import されたときは動かさない）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plugin = JSON.parse(fs.readFileSync('mod/.claude-plugin/plugin.json', 'utf8'))
  const releaseTs = fs.readFileSync('mod/hooks/release.ts', 'utf8')
  const baseUrl = releaseTs.match(/^export const BASE_URL = "([^"]*)"$/m)?.[1]
  let sums = null
  if (baseUrl?.startsWith('https://')) {
    try {
      sums = execFileSync('curl', ['-fsSL', '--retry', '2', `${baseUrl}SHA256SUMS`], { encoding: 'utf8' })
    } catch {
      sums = null
    }
  }
  const problems = checkReleaseRef({ pluginVersion: plugin.version, releaseTs, sums })
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`)
    process.exit(1)
  }
  console.log(`OK release.ts ${releaseTs.match(/VERSION = "([^"]*)"/)?.[1]} は Releases と合っています`)
}
