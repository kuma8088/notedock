import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkReleaseRef } from '../scripts/check-release-ref.mjs'

// server-v0.1.0 のときの release.ts と SHA256SUMS の写し（いまの mod/hooks/release.ts は読まない）
const read = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/release-ref/${name}`, import.meta.url)), 'utf8')
const releaseTs = read('release.ts')
const sums = read('SHA256SUMS')

test('すべて合っていれば空の配列', () => {
  assert.deepEqual(checkReleaseRef({ pluginVersion: '0.1.0', releaseTs, sums }), [])
})

test('plugin.json と release.ts のバージョンが違えば問題として返す', () => {
  const problems = checkReleaseRef({ pluginVersion: '0.1.1', releaseTs, sums })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /0\.1\.1/)
})

test('SHA256SUMS を取れなければ（サーバーの Releases が下書き・ない）問題として返す', () => {
  const problems = checkReleaseRef({ pluginVersion: '0.1.0', releaseTs, sums: null })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /SHA256SUMS.*(下書き・未公開|ネットワーク)/)
})

test('release.ts の4種類のハッシュ値が SHA256SUMS と1つでも違えば問題として返す', () => {
  const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc']
  for (const target of targets) {
    const line = releaseTs.split('\n').find((l) => l.includes(`"${target}"`))
    const hash = line.match(/sha256: "([0-9a-f]{64})"/)[1]
    const broken = releaseTs.replace(line, line.replace(hash, hash.replace(/^./, (c) => (c === '0' ? '1' : '0'))))
    const problems = checkReleaseRef({ pluginVersion: '0.1.0', releaseTs: broken, sums })
    assert.equal(problems.length, 1, target)
    assert.ok(problems[0].includes(target), target)
  }
})

test('BASE_URL が server-v<VERSION>/ で終わらなければ問題として返す', () => {
  const broken = releaseTs.replace('server-v0.1.0/', 'server-v0.0.9/')
  const problems = checkReleaseRef({ pluginVersion: '0.1.0', releaseTs: broken, sums })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /BASE_URL/)
})
