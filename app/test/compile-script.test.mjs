import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
// 公開用の並び（mod/.claude-plugin/plugin.json があれば mod/）か、作業用の並び（mod/notedock/）か
const modDir = fs.existsSync(path.join(appDir, '..', 'mod', '.claude-plugin', 'plugin.json')) ? path.join(appDir, '..', 'mod') : path.join(appDir, '..', 'mod', 'notedock')
const modRelease = path.join(modDir, 'hooks', 'release.ts')
const MOD_VERSION = /^export const VERSION = "([^"]+)"$/m.exec(fs.readFileSync(modRelease, 'utf8'))[1]

// app と mod の最小の写しを一時フォルダーに作る（本物の version.mjs を触らない）。
// Deno は「何も作らず、引数を記録するだけ」の偽物にする。
function setup({ serverVersion = '0.0.0-dev', publicLayout = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-script-'))
  const app = path.join(root, 'app')
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(app, 'server'), { recursive: true })
  const modOut = publicLayout ? path.join(root, 'mod') : path.join(root, 'mod', 'notedock')
  fs.mkdirSync(path.join(modOut, 'hooks'), { recursive: true })
  if (publicLayout) {
    fs.mkdirSync(path.join(modOut, '.claude-plugin'), { recursive: true })
    fs.writeFileSync(path.join(modOut, '.claude-plugin', 'plugin.json'), '{}')
  }
  for (const f of ['compile.sh', 'set-version.mjs']) fs.copyFileSync(path.join(appDir, 'scripts', f), path.join(app, 'scripts', f))
  const real = fs.readFileSync(path.join(appDir, 'server', 'version.mjs'), 'utf8')
  fs.writeFileSync(path.join(app, 'server', 'version.mjs'), real.replace(/SERVER_VERSION = '[^']*'/, `SERVER_VERSION = '${serverVersion}'`))
  fs.copyFileSync(modRelease, path.join(modOut, 'hooks', 'release.ts'))
  const log = path.join(root, 'deno.log')
  const deno = path.join(root, 'fake-deno')
  fs.writeFileSync(
    deno,
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  --version) echo "deno 2.9.8 (stable)" ;;
  info) echo '{ "denoDir": "${root}/cache" }' ;;
  compile) cat server/version.mjs >> "${log}"; while [ $# -gt 0 ]; do [ "$1" = "--output" ] && : > "$2"; shift; done ;;
esac
`,
    { mode: 0o755 },
  )
  return { root, app, deno, log, versionFile: path.join(app, 'server', 'version.mjs') }
}

function run(ctx, args = [], env = {}) {
  const r = spawnSync('sh', [path.join(ctx.app, 'scripts', 'compile.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: ctx.root, DENO: ctx.deno, ...env },
  })
  return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
}

test('compile.sh --print-plan は既定で4種類を出し、Windowsは .exe で終わる', () => {
  const ctx = setup()
  const before = fs.readFileSync(ctx.versionFile, 'utf8')
  const r = run(ctx, ['--print-plan'])
  assert.equal(r.status, 0, r.all)
  for (const t of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc']) {
    assert.ok(r.out.includes(`target: ${t}\n`), `${t} がない\n${r.out}`)
  }
  assert.ok(r.out.includes('output: dist/notedock-server-x86_64-apple-darwin\n'))
  assert.ok(r.out.includes('output: dist/notedock-smoke-aarch64-apple-darwin\n'))
  for (const kind of ['server', 'smoke']) {
    for (const t of ['aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc']) {
      assert.ok(r.out.includes(`output: dist/notedock-${kind}-${t}.exe\n`), `${kind} ${t} が .exe でない\n${r.out}`)
    }
  }
  // 何も作らず、何も書かない
  assert.equal(fs.existsSync(path.join(ctx.app, 'dist')), false)
  assert.equal(fs.readFileSync(ctx.versionFile, 'utf8'), before)
  assert.equal(fs.existsSync(ctx.log), false, 'Deno を動かしてしまった')
})

test('DENO を指定すればそれを使い、本人の場所を含まない', () => {
  const ctx = setup()
  const r = run(ctx, ['--print-plan'])
  assert.ok(r.out.includes(`deno: ${ctx.deno}\n`), r.out)
  const script = fs.readFileSync(path.join(appDir, 'scripts', 'compile.sh'), 'utf8')
  assert.ok(!script.includes('/Users/'), 'スクリプトに本人の場所がある')
  assert.ok(!script.includes('Library/Caches'), 'キャッシュの場所を固定している')
  // 絞り込み
  const only = run(ctx, ['--print-plan'], { TARGETS: 'x86_64-apple-darwin' })
  assert.ok(only.out.includes('target: x86_64-apple-darwin\n'))
  assert.ok(!only.out.includes('windows'))
})

test('SERVER_VERSION が 0.0.0-dev のままなら、NOTEDOCK_DEV_BUILD がなければ止まる', () => {
  const ctx = setup()
  const r = run(ctx, [])
  assert.notEqual(r.status, 0)
  assert.match(r.err, /0\.0\.0-dev/)
  assert.equal(fs.existsSync(ctx.log), false, '止まる前に Deno を動かした')
  assert.equal(fs.existsSync(path.join(ctx.app, 'dist')), false)
  // --print-plan は使うバージョンを出す
  const plan = run(ctx, ['--print-plan'])
  assert.equal(plan.status, 0, plan.all)
  assert.ok(plan.out.includes('version: 0.0.0-dev\n'), plan.out)
})

test('NOTEDOCK_DEV_BUILD=1 なら、サーバーのバージョンを Mod の release.ts の VERSION にそろえてから作る', () => {
  const ctx = setup()
  const plan = run(ctx, ['--print-plan'], { NOTEDOCK_DEV_BUILD: '1' })
  assert.ok(plan.out.includes(`version: ${MOD_VERSION}\n`), plan.out)
  assert.ok(fs.readFileSync(ctx.versionFile, 'utf8').includes("'0.0.0-dev'"), '--print-plan が書き換えた')

  const r = run(ctx, [], { NOTEDOCK_DEV_BUILD: '1', NOTEDOCK_ALLOW_DOWNLOAD: '1', TARGETS: 'x86_64-apple-darwin' })
  assert.equal(r.status, 0, r.all)
  assert.ok(fs.readFileSync(ctx.log, 'utf8').includes(`SERVER_VERSION = '${MOD_VERSION}'`), 'compile 時の version.mjs')
  assert.ok(fs.readFileSync(ctx.versionFile, 'utf8').includes("SERVER_VERSION = '0.0.0-dev'"), '戻っていない')
  assert.ok(fs.existsSync(path.join(ctx.app, 'dist', 'notedock-server-x86_64-apple-darwin')))
})

test('すでにバージョンが書かれていれば、NOTEDOCK_DEV_BUILD なしでも作れる。denort がキャッシュになければ、ダウンロードの許可なしでは止まる', () => {
  const ctx = setup({ serverVersion: '0.2.0' })
  const r = run(ctx, [], { TARGETS: 'x86_64-apple-darwin' })
  assert.notEqual(r.status, 0)
  assert.match(r.err, /denort-x86_64-apple-darwin\.zip/)
  assert.ok(r.err.includes(`${ctx.root}/cache/dl/release/v2.9.8`), r.err)
  const ok = run(ctx, [], { TARGETS: 'x86_64-apple-darwin', NOTEDOCK_ALLOW_DOWNLOAD: '1' })
  assert.equal(ok.status, 0, ok.all)
  assert.ok(fs.readFileSync(ctx.versionFile, 'utf8').includes("'0.2.0'"))
})

test('開発ビルドで denort のキャッシュがなければ、止まり、version.mjs は変わらない', () => {
  const ctx = setup()
  const before = fs.readFileSync(ctx.versionFile, 'utf8')
  const r = run(ctx, [], { NOTEDOCK_DEV_BUILD: '1', TARGETS: 'x86_64-apple-darwin' })
  assert.notEqual(r.status, 0)
  assert.match(r.err, /denort-x86_64-apple-darwin\.zip/)
  assert.equal(fs.readFileSync(ctx.versionFile, 'utf8'), before)
})

test('開発ビルドの compile が失敗しても、version.mjs は元に戻る', () => {
  const ctx = setup()
  const before = fs.readFileSync(ctx.versionFile, 'utf8')
  fs.writeFileSync(ctx.deno, fs.readFileSync(ctx.deno, 'utf8').replace('compile) cat', 'compile) exit 1; cat'))
  const r = run(ctx, [], { NOTEDOCK_DEV_BUILD: '1', NOTEDOCK_ALLOW_DOWNLOAD: '1', TARGETS: 'x86_64-apple-darwin' })
  assert.notEqual(r.status, 0)
  assert.equal(fs.readFileSync(ctx.versionFile, 'utf8'), before)
})

test('公開用の並び（mod/hooks/release.ts）でも、NOTEDOCK_DEV_BUILD=1 の --print-plan は Mod のバージョンを出す', () => {
  const ctx = setup({ publicLayout: true })
  assert.ok(fs.existsSync(path.join(ctx.root, 'mod', 'hooks', 'release.ts')))
  assert.ok(!fs.existsSync(path.join(ctx.root, 'mod', 'notedock')))
  const r = run(ctx, ['--print-plan'], { NOTEDOCK_DEV_BUILD: '1' })
  assert.equal(r.status, 0, r.all)
  assert.ok(r.out.includes(`version: ${MOD_VERSION}\n`), r.out)
})
