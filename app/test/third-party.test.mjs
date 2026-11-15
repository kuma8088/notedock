import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/third-party.mjs', import.meta.url))

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'third-party-'))
}

// 作り物の node_modules と meta.json を用意する
function fixture(packages, inputs) {
  const root = tmpDir()
  for (const [name, { license, files }] of Object.entries(packages)) {
    const dir = path.join(root, 'node_modules', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', license }))
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text)
  }
  fs.mkdirSync(path.join(root, 'dist'))
  const meta = { inputs: Object.fromEntries(inputs.map(i => [i, { bytes: 1, imports: [] }])), outputs: {} }
  fs.writeFileSync(path.join(root, 'dist', 'meta.json'), JSON.stringify(meta))
  const deno = path.join(root, 'deno.txt')
  fs.writeFileSync(deno, '# コメント行\nMIT License\n\nCopyright (c) 2018-2025 the Deno authors\n')
  return { root, deno, out: path.join(root, 'THIRD_PARTY_LICENSES') }
}

function run({ root, deno, out }) {
  const r = spawnSync(process.execPath, [script, '--root', root, '--meta', path.join(root, 'dist', 'meta.json'), '--deno', deno, '--out', out], { encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr, text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null }
}

test('third-party は meta.json に出てくる部品をすべて並べ、文章のない部品があれば 1 で終わる', () => {
  const ok = fixture(
    {
      alpha: { license: 'MIT', files: { LICENSE: 'ALPHA-LICENSE-TEXT' } },
      '@scope/beta': { license: 'ISC', files: { 'LICENSE.md': 'BETA-LICENSE-TEXT' } },
      gamma: { license: 'Apache-2.0', files: { LICENCE: 'GAMMA-LICENSE-TEXT' } },
      unused: { license: 'MIT', files: { LICENSE: 'UNUSED-TEXT' } },
    },
    ['node_modules/alpha/index.js', 'node_modules/alpha/lib/a.js', 'node_modules/@scope/beta/dist/b.js', 'node_modules/gamma/g.js', 'src/main.mjs'],
  )
  const good = run(ok)
  assert.equal(good.status, 0, good.stderr)
  for (const word of ['alpha', '@scope/beta', 'gamma', 'MIT', 'ISC', 'Apache-2.0', 'ALPHA-LICENSE-TEXT', 'BETA-LICENSE-TEXT', 'GAMMA-LICENSE-TEXT']) {
    assert.ok(good.text.includes(word), word)
  }
  assert.ok(!good.text.includes('UNUSED-TEXT'), 'meta.json に出ない部品は載せない')
  assert.equal((good.text.match(/ALPHA-LICENSE-TEXT/g) ?? []).length, 1, '同じ部品は1回だけ')
  assert.match(good.text, /Deno/)
  assert.match(good.text, /Copyright \(c\) 2018-2025 the Deno authors/)
  assert.ok(!good.text.includes('コメント行'), '# で始まるコメント行は入れない')
  assert.ok(good.text.indexOf('alpha') < good.text.indexOf('gamma'), '名前順')

  const bad = fixture({ alpha: { license: 'MIT', files: { LICENSE: 'A' } }, nolicense: { license: 'MIT', files: { 'README.md': 'x' } } }, ['node_modules/alpha/i.js', 'node_modules/nolicense/i.js'])
  const failed = run(bad)
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /nolicense/)
  assert.equal(failed.text, null, '失敗のときは書き出さない')
})

test('third-party は入れ子の node_modules にある別バージョンを、それぞれの場所から読んで並べる', () => {
  const f = fixture({ alpha: { license: 'MIT', files: { LICENSE: 'ALPHA-TOP-TEXT' } } }, ['node_modules/alpha/i.js'])
  // 入れ子の別バージョン（版も文章も違う）
  const nested = path.join(f.root, 'node_modules', 'alpha', 'node_modules', 'inner')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'inner', version: '2.0.0', license: 'ISC' }))
  fs.writeFileSync(path.join(nested, 'LICENSE'), 'INNER-NESTED-TEXT')
  const topInner = path.join(f.root, 'node_modules', 'inner')
  fs.mkdirSync(topInner, { recursive: true })
  fs.writeFileSync(path.join(topInner, 'package.json'), JSON.stringify({ name: 'inner', version: '1.0.0', license: 'MIT' }))
  fs.writeFileSync(path.join(topInner, 'LICENSE'), 'INNER-TOP-TEXT')
  const meta = { inputs: { 'node_modules/alpha/i.js': {}, 'node_modules/alpha/node_modules/inner/x.js': {}, 'node_modules/inner/y.js': {} } }
  fs.writeFileSync(path.join(f.root, 'dist', 'meta.json'), JSON.stringify(meta))
  const r = run(f)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.text.includes('inner 2.0.0') && r.text.includes('INNER-NESTED-TEXT'), '入れ子の版')
  assert.ok(r.text.includes('inner 1.0.0') && r.text.includes('INNER-TOP-TEXT'), '上の階層の版')
})

// いちばん上の説明（最初の区切り線より前）
function header(text) {
  return text.slice(0, text.indexOf('='.repeat(72)))
}

test('third-party はいちばん上に、何の一覧か（部品の数と Deno を含むこと）を書く', () => {
  const f = fixture(
    { alpha: { license: 'MIT', files: { LICENSE: 'A' } }, beta: { license: 'ISC', files: { LICENSE: 'B' } } },
    ['node_modules/alpha/i.js', 'node_modules/beta/i.js'],
  )
  const r = run(f)
  assert.equal(r.status, 0, r.stderr)
  const top = header(r.text)
  assert.match(top, /NoteDock/)
  assert.match(top, /2 個/)
  assert.match(top, /Deno/)
  assert.ok(!/license の欄がない/.test(top), '欄のない部品がなければ、その行は出さない')
})

test('third-party は license の欄がない部品を UNKNOWN で通さず、いちばん上と見出しに目立つ形で出し、知らせる', () => {
  const f = fixture(
    { alpha: { license: 'MIT', files: { LICENSE: 'A' } }, nofield: { license: undefined, files: { license: 'NOFIELD-MIT-TEXT' } } },
    ['node_modules/alpha/i.js', 'node_modules/nofield/i.js'],
  )
  const r = run(f)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.text.includes('UNKNOWN'), 'UNKNOWN と書かない')
  assert.match(header(r.text), /license の欄がない外部ライブラリが、1 個あります（nofield 1\.2\.3）。このライブラリのライセンスは、/)
  assert.match(r.text, /nofield 1\.2\.3 {2}\(package\.json に license の欄なし。下のライセンス文を見てください\)/)
  assert.ok(r.text.includes('NOFIELD-MIT-TEXT'))
  assert.match(r.stderr, /nofield 1\.2\.3/)
})

test('third-party は値のない --out と、読めない meta.json で、何も書かずに 2 で止まる', () => {
  const f = fixture({ alpha: { license: 'MIT', files: { LICENSE: 'A' } } }, ['node_modules/alpha/i.js'])
  const defaultOut = path.join(f.root, 'THIRD_PARTY_LICENSES')
  const r = spawnSync(process.execPath, [script, '--root', f.root, '--meta', path.join(f.root, 'dist', 'meta.json'), '--deno', f.deno, '--out'], { encoding: 'utf8' })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /--out/)
  assert.ok(!fs.existsSync(defaultOut), '既定の場所に書かない')

  const unknown = spawnSync(process.execPath, [script, '--root', f.root, '--outt', f.out], { encoding: 'utf8' })
  assert.equal(unknown.status, 2, unknown.stderr)
  assert.match(unknown.stderr, /--outt/)

  const noMeta = spawnSync(process.execPath, [script, '--root', f.root, '--meta', path.join(f.root, 'nai.json'), '--deno', f.deno, '--out', f.out], { encoding: 'utf8' })
  assert.equal(noMeta.status, 2, noMeta.stderr)
  assert.match(noMeta.stderr, /meta\.json|nai\.json/)
  assert.match(noMeta.stderr, /npm run build/)
  assert.ok(!/\n\s+at .+[:(]/.test(noMeta.stderr), noMeta.stderr)
  assert.ok(!fs.existsSync(f.out))
})
