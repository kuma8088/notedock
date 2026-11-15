import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/write-release.mjs', import.meta.url))
const BASE = 'https://github.com/OWNER/notedock/releases/download/server-v0.1.0-dev/'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'write-release-'))
}

// スクリプトを動かして、終了コードと書き出された中身を返す
function run(dist, { version = '0.1.0-dev', baseUrl = BASE } = {}) {
  const out = path.join(tmpDir(), 'release.ts')
  const r = spawnSync(process.execPath, [script, '--version', version, '--base-url', baseUrl, '--dist', dist, '--out', out], { encoding: 'utf8' })
  return { status: r.status, text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null, out }
}

test('distの中のファイルから、種類ごとの名前・大きさ・指紋を書く', () => {
  const dist = tmpDir()
  fs.writeFileSync(path.join(dist, 'notedock-server-aarch64-apple-darwin'), 'abc')
  const { status, text } = run(dist)
  assert.equal(status, 0)
  assert.match(text, /export const VERSION = "0\.1\.0-dev"/)
  assert.match(text, new RegExp(`export const BASE_URL = "${BASE}"`))
  assert.match(text, /"aarch64-apple-darwin": \{ file: "notedock-server-aarch64-apple-darwin", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" \}/)
  assert.doesNotMatch(text, /x86_64/)
})

test('Windowsのファイルは .exe 付きの名前で入れる', () => {
  const dist = tmpDir()
  fs.writeFileSync(path.join(dist, 'notedock-server-x86_64-pc-windows-msvc.exe'), 'abc')
  const { status, text } = run(dist)
  assert.equal(status, 0)
  assert.match(text, /"x86_64-pc-windows-msvc": \{ file: "notedock-server-x86_64-pc-windows-msvc\.exe", size: 3,/)
})

test('distが空なら ASSETS は空で、形は決まったとおり', () => {
  const { status, text } = run(tmpDir())
  assert.equal(status, 0)
  assert.equal(text, [
    '// このファイルは scripts/write-release.mjs が作る。手で直さない。',
    "import type { Target } from './target'",
    'export const VERSION = "0.1.0-dev"',
    `export const BASE_URL = "${BASE}"`,
    'export const ASSETS: Partial<Record<Target, { file: string; size: number; sha256: string }>> = {}',
    '',
  ].join('\n'))
})

test('ダウンロード元が http:// なら書かずに 2 で終わる', () => {
  const dist = tmpDir()
  const bad = run(dist, { baseUrl: 'http://example.com/' })
  assert.equal(bad.status, 2)
  assert.equal(bad.text, null)
  assert.equal(run(dist, { baseUrl: 'https://example.com/' }).status, 0)
  assert.equal(run(dist, { baseUrl: 'file:///tmp/dist/' }).status, 0)
})

test('ダウンロード元が / で終わらなければ書かずに 2 で終わる', () => {
  const r = run(tmpDir(), { baseUrl: 'https://example.com/x' })
  assert.equal(r.status, 2)
  assert.equal(r.text, null)
})

test('バージョンは VERSION_RE と同じ形だけを受け付ける', () => {
  const dist = tmpDir()
  for (const v of ['0.1.0', '0.1.0-dev', '0.1.0-dev.2']) assert.equal(run(dist, { version: v }).status, 0, v)
  for (const v of ['v0.1', '0.1', '0.1.0-', '']) assert.equal(run(dist, { version: v }).status, 2, v)
})

test('知らない名前のファイル（notedock-smoke-*）は入れない', () => {
  const dist = tmpDir()
  fs.writeFileSync(path.join(dist, 'notedock-smoke-aarch64-apple-darwin'), 'abc')
  fs.writeFileSync(path.join(dist, 'notedock-server-riscv64'), 'abc')
  const { status, text } = run(dist)
  assert.equal(status, 0)
  assert.match(text, /= \{\}\n$/)
})

test('知らない引数や、URLとして読めないダウンロード元は 2 で終わる', () => {
  const out = path.join(tmpDir(), 'release.ts')
  const base = ['--version', '0.1.0', '--base-url', BASE, '--dist', tmpDir(), '--out', out]
  assert.equal(spawnSync(process.execPath, [script, ...base, '--bogus', 'x'], { encoding: 'utf8' }).status, 2)
  assert.equal(spawnSync(process.execPath, [script, ...base, 'extra'], { encoding: 'utf8' }).status, 2)
  assert.equal(fs.existsSync(out), false)
  assert.equal(run(tmpDir(), { baseUrl: 'https://' }).status, 2)
})
