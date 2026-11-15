import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/pack-mod.sh', import.meta.url))

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pack-mod-'))
}

function makeMod(version = '0.2.0') {
  const mod = tmpDir()
  fs.mkdirSync(path.join(mod, '.claude-plugin'))
  fs.mkdirSync(path.join(mod, 'hooks'))
  fs.mkdirSync(path.join(mod, 'types'))
  fs.writeFileSync(path.join(mod, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'notedock', version }, null, 2))
  fs.writeFileSync(path.join(mod, 'hooks', 'a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(mod, 'hooks', 'a.test.ts'), 'テスト\n')
  fs.writeFileSync(path.join(mod, 'hooks', 'hooks.json'), '{}\n')
  fs.writeFileSync(path.join(mod, 'types', 'index.d.ts'), 'export {}\n')
  fs.writeFileSync(path.join(mod, 'README.md'), '入れない\n')
  return mod
}

function pack(mod, out, args = []) {
  const r = spawnSync('sh', [script, ...args], { encoding: 'utf8', env: { ...process.env, NOTEDOCK_MOD_DIR: mod, NOTEDOCK_OUT_DIR: out } })
  return { status: r.status, stderr: r.stderr }
}

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const list = zip => spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)

test('pack-mod は同じ中身から同じ指紋のzipを作り、.claude-plugin/plugin.json を入れ、テストのファイルを入れない', async () => {
  const mod = makeMod('0.2.0')
  const out1 = tmpDir()
  const r1 = pack(mod, out1)
  assert.equal(r1.status, 0, r1.stderr)
  const zip1 = path.join(out1, 'notedock-mod-0.2.0.zip')
  assert.ok(fs.existsSync(zip1))
  const names = list(zip1)
  assert.deepEqual(names, ['.claude-plugin/plugin.json', 'hooks/a.ts', 'hooks/hooks.json', 'types/index.d.ts'])

  // 時間と、作る場所を変えても同じ指紋になる
  await new Promise(resolve => setTimeout(resolve, 2100))
  fs.utimesSync(path.join(mod, 'hooks', 'a.ts'), new Date(), new Date())
  const out2 = tmpDir()
  pack(mod, out2)
  assert.equal(sha(path.join(out2, 'notedock-mod-0.2.0.zip')), sha(zip1))

  // 中身を変えれば指紋も変わる
  fs.writeFileSync(path.join(mod, 'hooks', 'a.ts'), 'export const a = 2\n')
  const out3 = tmpDir()
  pack(mod, out3)
  assert.notEqual(sha(path.join(out3, 'notedock-mod-0.2.0.zip')), sha(zip1))

  // バージョンは引数でも決められる
  const out4 = tmpDir()
  assert.equal(pack(mod, out4, ['0.9.9-rc.1']).status, 0)
  assert.ok(fs.existsSync(path.join(out4, 'notedock-mod-0.9.9-rc.1.zip')))

  // plugin.json がなければ失敗する
  fs.rmSync(path.join(mod, '.claude-plugin'), { recursive: true })
  assert.notEqual(pack(mod, tmpDir()).status, 0)
})

test('pack-mod は公開用の並び（app/scripts と mod が兄弟で、Mod が mod 直下）でも、場所を指定せずにModを見つける', () => {
  const top = tmpDir()
  fs.mkdirSync(path.join(top, 'app', 'scripts'), { recursive: true })
  fs.copyFileSync(script, path.join(top, 'app', 'scripts', 'pack-mod.sh'))
  const mod = makeMod('0.3.0')
  fs.cpSync(mod, path.join(top, 'mod'), { recursive: true })
  const out = tmpDir()
  const env = { ...process.env, NOTEDOCK_OUT_DIR: out }
  delete env.NOTEDOCK_MOD_DIR
  const r = spawnSync('sh', [path.join(top, 'app', 'scripts', 'pack-mod.sh')], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(list(path.join(out, 'notedock-mod-0.3.0.zip')), ['.claude-plugin/plugin.json', 'hooks/a.ts', 'hooks/hooks.json', 'types/index.d.ts'])
})
