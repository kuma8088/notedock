import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { VERSION_RE, compareVersions } from '../server/version.mjs'

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// Modの hooks/install.test.ts「版の順」と同じ表。
test('版の順：番号、付いていない版が新しい、数字は数で、数字は文字より古い、項目が多いほうが新しい', () => {
  const order = ['0.0.9', '0.1.0-alpha', '0.1.0-dev', '0.1.0-dev.1', '0.1.0-dev.4', '0.1.0-dev.10', '0.1.0-dev.a', '0.1.0', '0.2.0', '1.0.0']
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      assert.equal(Math.sign(compareVersions(order[i], order[j])), Math.sign(i - j), `${order[i]} vs ${order[j]}`)
    }
  }
})

test('VERSION_RE は 0.0.0-dev・X.Y.Z・X.Y.Z-rc.N を受け付け、ほかを断る', () => {
  for (const ok of ['0.0.0-dev', '0.1.0', '0.1.0-rc.2']) assert.ok(VERSION_RE.test(ok), ok)
  for (const bad of ['', '1', '1.2', 'v1.2.3', '1.2.3-', '1.2.3 ', '1.2.3\n', 'a.b.c']) assert.ok(!VERSION_RE.test(bad), JSON.stringify(bad))
})

test('set-version はバージョンを書き換え、形が違えば 2 で終わって書き換えない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setver-'))
  fs.mkdirSync(path.join(dir, 'server'))
  const file = path.join(dir, 'server', 'version.mjs')
  const original = fs.readFileSync(path.join(APP, 'server', 'version.mjs'), 'utf8')
  fs.writeFileSync(file, original)
  const run = (...args) => spawnSync(process.execPath, [path.join(APP, 'scripts', 'set-version.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, NOTEDOCK_APP_DIR: dir } })
  const ok = run('0.3.1-rc.2')
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(fs.readFileSync(file, 'utf8'), /export const SERVER_VERSION = '0\.3\.1-rc\.2'/)
  const after = fs.readFileSync(file, 'utf8')
  for (const bad of ['v1.0.0', '1.0', '', "1.0.0'; process.exit()"]) {
    const r = run(bad)
    assert.equal(r.status, 2, JSON.stringify(bad))
    assert.equal(fs.readFileSync(file, 'utf8'), after, '書き換えない')
  }
  assert.equal(run().status, 2)
  assert.equal(run('0.1.0', '0.2.0').status, 2)
  // 作業場所の version.mjs は 0.0.0-dev のまま
  assert.match(original, /SERVER_VERSION = '0\.0\.0-dev'/)
})
