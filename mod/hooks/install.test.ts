import { expect, test } from 'claude-code/testing'

import { binDir, compareVersions, ensureBinary, installedBinary, onlyNewerInstalled, removeOldVersions, resetVerifiedForTest, type Stage } from './install'
import type { HostInfo } from './platform'

const SHA = 'a'.repeat(64)
const BAD = 'b'.repeat(64)
const RELEASE = {
  VERSION: '0.1.0-dev',
  BASE_URL: 'https://example.test/rel/',
  ASSETS: { 'aarch64-apple-darwin': { file: 'notedock-server-aarch64-apple-darwin', size: 5, sha256: SHA } },
} as any

const mac: HostInfo = { os: 'darwin', home: '/Users/yamada', stateDir: '/S/NoteDock', target: 'aarch64-apple-darwin', systemRoot: null }
const intel: HostInfo = { ...mac, target: 'x86_64-apple-darwin' }
const BIN_ROOT = '/S/NoteDock/bin'
const DIR = '/S/NoteDock/bin/0.1.0-dev'
const BIN = DIR + '/notedock-server'
const LOCK = BIN_ROOT + '/.download-lock'
const BEAT = LOCK + '/beat.json'

// テストの `$` には process・fs・clock が無いので、使う分だけの代役を作る。
// 呼ばれたコマンドは、実行も spawn も log に順番どおり入る。時計は仮想で、タイマーを待つと自動で進む。
type Dl = { size?: number; sha?: string; code?: number | null; throws?: boolean }
type Opt = {
  files?: Record<string, { size?: number; sha?: string; text?: string; mtimeMs?: number }>
  dirs?: Record<string, number>
  download?: Dl
  lockFails?: boolean
  makeDirsFails?: boolean
  shaFails?: boolean // 指紋のコマンドが失敗する（時間切れ、起動できない）
}
function fake(o: Opt = {}) {
  const files = new Map<string, any>(Object.entries(o.files ?? {}).map(([k, v]) => [k, { size: 0, mtimeMs: 0, ...v }]))
  const dirs = new Map<string, number>(Object.entries(o.dirs ?? {}))
  const log: string[] = []
  const spawned: string[][] = []
  const ran: string[][] = []
  let t = 1_000_000
  const timers: { at: number; ms: number; fn: () => void; repeat: boolean; dead: boolean }[] = []
  let pumping = false
  let steps = 0
  const pump = () => {
    if (pumping) return
    pumping = true
    setTimeout(() => {
      pumping = false
      const live = timers.filter(x => !x.dead)
      if (!live.length || ++steps > 3000) return
      live.sort((a, b) => a.at - b.at)
      const x = live[0]
      t = Math.max(t, x.at)
      if (x.repeat) x.at = t + x.ms
      else x.dead = true
      x.fn()
      pump()
    }, 0)
  }
  const addTimer = (ms: number, fn: () => void, repeat: boolean) => {
    const x = { at: t + ms, ms, fn, repeat, dead: false }
    timers.push(x)
    pump()
    return { cancel: () => { x.dead = true } }
  }
  const events: { at: number; what: string }[] = []
  const removeTree = (p: string) => {
    for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k)
    for (const k of [...dirs.keys()]) if (k === p || k.startsWith(p + '/')) dirs.delete(k)
  }
  const $ = {
    process: {
      run: async (argv: string[]) => {
        ran.push(argv)
        log.push(argv.join(' '))
        const [cmd, ...a] = argv
        const ok = { stdout: '', stderr: '', exitCode: 0 }
        if (cmd === '/bin/mkdir' && a[0] === '-p') {
          if (o.makeDirsFails) return { ...ok, exitCode: 1 }
          dirs.set(a[1], t)
        } else if (cmd === '/bin/mkdir') {
          if (o.lockFails || dirs.has(a[0])) return { ...ok, exitCode: 1 }
          dirs.set(a[0], t)
        } else if (cmd === '/usr/bin/shasum') {
          if (o.shaFails) return { ...ok, exitCode: -1 }
          const f = files.get(a[2])
          if (!f) return { ...ok, exitCode: 1 }
          return { ...ok, stdout: `${f.sha}  ${a[2]}\n` }
        } else if (cmd === '/bin/mv') {
          files.set(a[2], files.get(a[1]))
          files.delete(a[1])
        } else if (cmd === '/bin/rm') {
          events.push({ at: t, what: 'rm ' + a[1] })
          removeTree(a[1])
        }
        return ok
      },
      spawn: (req: { argv: string[] }) => {
        spawned.push(req.argv)
        log.push('spawn ' + req.argv.join(' '))
        const out = req.argv[req.argv.indexOf('-o') + 1]
        const dl = o.download ?? { size: 5, sha: SHA }
        async function* gen() {
          events.push({ at: t, what: 'spawn beat=' + files.has(BEAT) })
          if (dl.throws) throw new Error('起動できません')
          if ((dl.code ?? 0) === 0) files.set(out, { size: dl.size ?? 5, sha: dl.sha ?? SHA, mtimeMs: t })
          yield { stream: 'stderr', text: '' }
          return { code: dl.code === undefined ? 0 : dl.code, signal: null }
        }
        const inner: any = gen()
        // 読み終わってから結果が決まる、本物と同じ形（生成器そのものには書き足せないので、包む）
        let finish: (r: any) => void = () => {}
        const result = new Promise<any>(res => { finish = res })
        return {
          [Symbol.asyncIterator]() { return this },
          next: async () => {
            const r = await inner.next()
            if (r.done) finish(r.value)
            return r
          },
          return: async (v: any) => ({ done: true, value: v }),
          result,
        }
      },
    },
    fs: {
      exists: async (p: string) => files.has(p) || dirs.has(p),
      stat: async (p: string) => {
        if (files.has(p)) { const f = files.get(p); return { kind: 'file', size: f.size, mtimeMs: f.mtimeMs, isLink: false } }
        if (dirs.has(p)) return { kind: 'dir', size: 0, mtimeMs: dirs.get(p), isLink: false }
        throw new Error('ENOENT')
      },
      read: async (p: string) => {
        if (!files.has(p)) throw new Error('ENOENT')
        return files.get(p).text ?? ''
      },
      write: async (p: string, text: string) => { files.set(p, { size: text.length, text, mtimeMs: t }) },
      list: async (p: string) => {
        const out: any[] = []
        for (const k of dirs.keys()) if (k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')) out.push({ name: k.slice(p.length + 1), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
        for (const k of files.keys()) if (k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')) out.push({ name: k.slice(p.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })
        return out
      },
    },
    clock: {
      now: async () => t,
      after: (ms: number, fn: () => void) => addTimer(ms, fn, false),
      every: (ms: number, fn: () => void) => addTimer(ms, fn, true),
      sleep: async () => { throw new Error('sleep は使わない') },
    },
  }
  return { $, files, dirs, log, spawned, ran, events, now: () => t }
}

const stages = () => {
  const s: Stage[] = []
  return { s, on: (x: Stage) => s.push(x) }
}

test('一覧にない種類なら、ダウンロードせずに対応していないと返す', async () => {
  resetVerifiedForTest()
  const f = fake()
  const r = await ensureBinary(f.$, intel, () => {}, RELEASE)
  expect(r).toEqual({ problem: 'このOSにはまだ対応していません。' })
  expect(f.spawned.length).toBe(0)
  expect(f.ran.some(a => a[0].endsWith('curl'))).toBe(false)
  expect(f.log.length).toBe(0)
})

test('保存フォルダーも bin/ もない初回でも、作ってからダウンロードする', async () => {
  resetVerifiedForTest()
  const f = fake()
  const r = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r).toEqual({ bin: BIN })
  const idx = (needle: string) => f.log.findIndex(l => l.includes(needle))
  const order = [
    idx('/bin/mkdir -p ' + DIR), idx('/bin/mkdir ' + LOCK), idx('spawn /usr/bin/curl'),
    idx('/usr/bin/shasum'), idx('/bin/chmod 755'), idx('/bin/mv'), f.log.lastIndexOf('/bin/rm -rf ' + LOCK),
  ]
  expect(order.every(i => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(f.log.find(l => l.startsWith('spawn'))).toContain('https://example.test/rel/notedock-server-aarch64-apple-darwin')
})

test('ダウンロードして指紋が合えば、置き場に移して bin を返す', async () => {
  resetVerifiedForTest()
  const f = fake()
  const r = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r).toEqual({ bin: BIN })
  expect(f.files.get(BIN)?.sha).toBe(SHA)
  expect([...f.files.keys()].some(k => k.includes('.part-'))).toBe(false)
  expect(f.dirs.has(LOCK)).toBe(false)
  const part = f.spawned[0][f.spawned[0].indexOf('-o') + 1]
  expect(part.startsWith(DIR + '/.part-')).toBe(true)
  // 同じ Mod の中の2回目は、指紋を確かめ直さない
  const n = f.log.length
  expect(await installedBinary(f.$, mac, RELEASE)).toBe(BIN)
  expect(f.log.length).toBe(n)
})

test('指紋が合わなければ、一時ファイルとロックを消し、置き場には何も置かない', async () => {
  resetVerifiedForTest()
  const f = fake({ download: { size: 5, sha: BAD } })
  const r: any = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r.problem).toContain('もう一度「ノートを開く」を押してください')
  expect(r.problem).toContain('指紋')
  expect(f.files.has(BIN)).toBe(false)
  expect([...f.files.keys()].some(k => k.includes('.part-'))).toBe(false)
  expect(f.dirs.has(LOCK)).toBe(false)
  expect(f.log.some(l => l.startsWith('/bin/chmod'))).toBe(false)
})

test('大きさが違えば、指紋は見ずに消す', async () => {
  resetVerifiedForTest()
  const f = fake({ download: { size: 9, sha: SHA } })
  const r: any = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect('problem' in r).toBe(true)
  expect(f.log.some(l => l.startsWith('/usr/bin/shasum'))).toBe(false)
  expect(f.dirs.has(LOCK)).toBe(false)
  expect([...f.files.keys()].some(k => k.includes('.part-'))).toBe(false)
})

test('curl が 0 以外で終われば、理由に終了コードを入れ、ロックを消す', async () => {
  resetVerifiedForTest()
  const f = fake({ download: { code: 22 } })
  const r: any = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r.problem).toContain('22')
  expect(r.problem).toContain('もう一度「ノートを開く」を押してください')
  expect(f.dirs.has(LOCK)).toBe(false)
  expect(f.files.has(BIN)).toBe(false)
})

test('curl が起動できなくても、ロックを消して problem を返す', async () => {
  resetVerifiedForTest()
  const f = fake({ download: { throws: true } })
  const r: any = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect('problem' in r).toBe(true)
  expect(f.dirs.has(LOCK)).toBe(false)
})

test('置き場を作れなければ「置き場に書けませんでした」', async () => {
  resetVerifiedForTest()
  const f = fake({ makeDirsFails: true })
  const r: any = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r.problem).toContain('置き場に書けませんでした')
  expect(f.spawned.length).toBe(0)
})

test('ロックが作れず、ロックも無ければ、待たずに「書けませんでした」を返す', async () => {
  resetVerifiedForTest()
  const f = fake({ lockFails: true })
  const t0 = f.now()
  const r: any = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r.problem).toContain('置き場に書けませんでした')
  expect(f.now()).toBe(t0)
  expect(f.spawned.length).toBe(0)
})

test('ほかのチャットのロックがあるあいだは待ち、置き場に現れたファイルを使う', async () => {
  resetVerifiedForTest()
  const f = fake({ dirs: { [LOCK]: 1_000_000 }, files: { [BEAT]: { text: JSON.stringify({ t: 1_000_000 }) } } })
  // ほかのチャットが、10秒後に置き場へファイルを置き、その beat.json も書き直し続けているものとする
  f.$.clock.every(4000, () => { f.files.set(BEAT, { size: 1, text: JSON.stringify({ t: f.now() }), mtimeMs: f.now() }) })
  f.$.clock.after(10_000, () => { f.files.set(BIN, { size: 5, sha: SHA, mtimeMs: f.now() }) })
  const r = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r).toEqual({ bin: BIN })
  expect(f.spawned.length).toBe(0)
  expect(f.log.some(l => l.startsWith('/bin/rm'))).toBe(false)
})

test('beat.json が30秒書き直されていないロックは消して作り直す', async () => {
  resetVerifiedForTest()
  const f = fake({ dirs: { [LOCK]: 1_000_000 }, files: { [BEAT]: { text: JSON.stringify({ t: 1_000_000 }) } } })
  const r = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r).toEqual({ bin: BIN })
  const rm = f.events.find(e => e.what === 'rm ' + LOCK)!
  expect(rm.at - 1_000_000).toBeGreaterThanOrEqual(30_000)
  expect(rm.at - 1_000_000).toBeLessThan(40_000)
  expect(f.spawned.length).toBe(1)
})

test('ロックを作ったらすぐ beat.json を書く。beat.json が無いロックは、フォルダーの更新時刻で数える', async () => {
  resetVerifiedForTest()
  const f = fake()
  await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(f.events.find(e => e.what.startsWith('spawn'))!.what).toBe('spawn beat=true')

  // beat.json の無いロック：更新時刻から30秒で、残りとみなす
  resetVerifiedForTest()
  const g = fake({ dirs: { [LOCK]: 1_000_000 } })
  const r = await ensureBinary(g.$, mac, () => {}, RELEASE)
  expect(r).toEqual({ bin: BIN })
  const rm = g.events.find(e => e.what === 'rm ' + LOCK)!
  expect(rm.at - 1_000_000).toBeGreaterThanOrEqual(30_000)
  expect(rm.at - 1_000_000).toBeLessThan(40_000)

  // 更新時刻が新しければ、まだ待つ（29秒の時点では消さない）
  resetVerifiedForTest()
  const h = fake({ dirs: { [LOCK]: 1_000_000 } })
  h.$.clock.after(29_000, () => { h.files.set(BIN, { size: 5, sha: SHA, mtimeMs: h.now() }) })
  expect(await ensureBinary(h.$, mac, () => {}, RELEASE)).toEqual({ bin: BIN })
  expect(h.events.some(e => e.what === 'rm ' + LOCK)).toBe(false)
})

test('beat.json はダウンロード中、5秒ごとに書き直され、終わったら止まる', async () => {
  resetVerifiedForTest()
  const f = fake()
  let writes = 0
  const orig = f.$.fs.write
  f.$.fs.write = async (p: string, x: string) => { if (p === BEAT) writes++; return orig(p, x) }
  await ensureBinary(f.$, mac, () => {}, RELEASE)
  const w = writes
  expect(w).toBeGreaterThanOrEqual(1)
  await new Promise(r => setTimeout(r, 30))
  expect(writes).toBe(w)
})

test('installedBinary：置き場にファイルがなければ null', async () => {
  resetVerifiedForTest()
  const f = fake()
  expect(await installedBinary(f.$, mac, RELEASE)).toBe(null)
})

test('installedBinary：置き場のファイルの指紋が合わなければ、消して problem を返し、ダウンロードしない', async () => {
  resetVerifiedForTest()
  const f = fake({ files: { [BIN]: { size: 5, sha: BAD } } })
  const r: any = await installedBinary(f.$, mac, RELEASE)
  expect(r.problem).toBe('サーバーのファイルが壊れているか、差し替えられていたので消しました。「ノートを開く」を押すと、ダウンロードし直します。')
  expect(f.files.has(BIN)).toBe(false)
  expect(f.spawned.length).toBe(0)
})

test('installedBinary：大きさが違えば、指紋を見ずに消す。合えば場所を返す', async () => {
  resetVerifiedForTest()
  const f = fake({ files: { [BIN]: { size: 4, sha: SHA } } })
  expect('problem' in ((await installedBinary(f.$, mac, RELEASE)) as any)).toBe(true)
  expect(f.log.some(l => l.startsWith('/usr/bin/shasum'))).toBe(false)
  resetVerifiedForTest()
  const g = fake({ files: { [BIN]: { size: 5, sha: SHA } } })
  expect(await installedBinary(g.$, mac, RELEASE)).toBe(BIN)
})

test('installedBinary：一覧にない種類は null', async () => {
  resetVerifiedForTest()
  const f = fake({ files: { [BIN]: { size: 5, sha: SHA } } })
  expect(await installedBinary(f.$, intel, RELEASE)).toBe(null)
})

test('installedBinary：指紋のコマンドが失敗したら、消さずに「確かめられなかった」を返す', async () => {
  resetVerifiedForTest()
  const f = fake({ files: { [BIN]: { size: 5, sha: SHA } }, shaFails: true })
  const r: any = await installedBinary(f.$, mac, RELEASE)
  expect(r.problem).toBe('サーバーのファイルを確かめられませんでした。もう一度「ノートを開く」を押してください。')
  expect(f.files.has(BIN)).toBe(true)
})

test('ensureBinary：指紋のコマンドが失敗したら、消さず、ダウンロードもしない', async () => {
  resetVerifiedForTest()
  const f = fake({ files: { [BIN]: { size: 5, sha: SHA } }, shaFails: true })
  const r: any = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r.problem).toBe('サーバーのファイルを確かめられませんでした。もう一度「ノートを開く」を押してください。')
  expect(f.files.has(BIN)).toBe(true)
  expect(f.spawned.length).toBe(0)
})

test('ダウンロードのロックを取ったら、置き場に残っている .part- で始まるファイルを消してから始める', async () => {
  resetVerifiedForTest()
  const f = fake({ files: { [DIR + '/.part-old1']: { size: 3, sha: BAD }, [DIR + '/.part-old2']: { size: 4, sha: BAD }, [DIR + '/keep.txt']: { size: 1, sha: BAD } } })
  const r = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r).toEqual({ bin: BIN })
  expect(f.files.has(DIR + '/.part-old1')).toBe(false)
  expect(f.files.has(DIR + '/.part-old2')).toBe(false)
  expect(f.files.has(DIR + '/keep.txt')).toBe(true) // .part- で始まらないものは消さない
  const spawnAt = f.log.findIndex(l => l.startsWith('spawn'))
  const rmAt = f.log.findIndex(l => l === '/bin/rm -rf ' + DIR + '/.part-old1')
  const lockAt = f.log.findIndex(l => l === '/bin/mkdir ' + LOCK)
  expect(rmAt).toBeGreaterThan(lockAt)
  expect(rmAt).toBeLessThan(spawnAt)
})

test('Windowsで移動に失敗しても、置き場に正しいファイルがあれば、それを使う', async () => {
  resetVerifiedForTest()
  const win: HostInfo = { os: 'win32', home: 'C:\\Users\\u', stateDir: 'C:\\S\\NoteDock', target: 'x86_64-pc-windows-msvc', systemRoot: 'C:\\Windows' }
  const WREL = { VERSION: '0.1.0-dev', BASE_URL: 'https://example.test/rel/', ASSETS: { 'x86_64-pc-windows-msvc': { file: 'notedock-server-x86_64-pc-windows-msvc.exe', size: 5, sha256: SHA } } } as any
  const wbin = binDir(win, '0.1.0-dev') + '\\notedock-server.exe'
  for (const placed of [{ size: 5, sha: SHA }, { size: 5, sha: BAD }]) {
    resetVerifiedForTest()
    const f = fake()
    const base = f.$.process.run
    f.$.process.run = async (argv: string[], init?: any) => {
      const env = init?.env ?? {}
      f.log.push(argv[0].split('\\').pop() + ' ' + (env.ND_FROM ? 'move' : env.ND_DIR ? 'dir' : ''))
      if (argv[0].endsWith('certutil.exe')) {
        const x = f.files.get(argv[2])
        return x ? { stdout: x.sha + '\r\n', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 1 }
      }
      if (argv[0].endsWith('powershell.exe')) {
        const script = argv[argv.length - 1]
        if (script.includes('Move-Item')) {
          f.files.set(wbin, { size: placed.size, sha: placed.sha, mtimeMs: 0 }) // 別のチャットや走査がさきに置いた
          return { stdout: '', stderr: 'access denied', exitCode: 1 }
        }
        if (script.includes('Remove-Item')) {
          for (const k of [...f.files.keys()]) if (k === env.ND_DIR) f.files.delete(k)
          for (const k of [...f.dirs.keys()]) if (k === env.ND_DIR) f.dirs.delete(k)
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        if (script.includes('New-Item')) {
          if (f.dirs.has(env.ND_DIR) && script.includes('-ErrorAction')) return { stdout: '', stderr: '', exitCode: 1 }
          f.dirs.set(env.ND_DIR, 0)
          return { stdout: '', stderr: '', exitCode: 0 }
        }
      }
      return base(argv)
    }
    const r: any = await ensureBinary(f.$, win, () => {}, WREL)
    if (placed.sha === SHA) {
      expect(r).toEqual({ bin: wbin })
    } else {
      expect('problem' in r).toBe(true) // 指紋が違うファイルは使わない
    }
  }
})

test('指紋を調べる処理が続けて3回失敗したら、帯の文を「このパソコンでファイルの指紋を調べられません。READMEの「困ったとき」を見てください」に変える', async () => {
  resetVerifiedForTest()
  const MSG1 = 'サーバーのファイルを確かめられませんでした。もう一度「ノートを開く」を押してください。'
  const MSG3 = 'このパソコンでファイルの指紋を調べられません。READMEの「困ったとき」を見てください'
  const f = fake({ files: { [BIN]: { size: 5, sha: SHA } }, shaFails: true })
  expect(((await installedBinary(f.$, mac, RELEASE)) as any).problem).toBe(MSG1)
  expect(((await ensureBinary(f.$, mac, () => {}, RELEASE)) as any).problem).toBe(MSG1)
  expect(((await ensureBinary(f.$, mac, () => {}, RELEASE)) as any).problem).toBe(MSG3)
  expect(((await installedBinary(f.$, mac, RELEASE)) as any).problem).toBe(MSG3)
  expect(f.files.has(BIN)).toBe(true) // 消さない
  expect(f.spawned.length).toBe(0)
  // 1回でも指紋が調べられれば、数え直す
  const g = fake({ files: { [BIN]: { size: 5, sha: SHA } }, shaFails: true })
  resetVerifiedForTest()
  await installedBinary(g.$, mac, RELEASE)
  await installedBinary(g.$, mac, RELEASE)
  const h = fake({ files: { [BIN]: { size: 5, sha: SHA } } })
  expect(await installedBinary(h.$, mac, RELEASE)).toBe(BIN)
  resetVerifiedForTest()
  expect(((await installedBinary(g.$, mac, RELEASE)) as any).problem).toBe(MSG1)
})

test('初回（置き場にファイルなし）でも、指紋を調べる処理が3回続けて失敗したら READMEの案内に変わり、一時ファイルは毎回消す', async () => {
  resetVerifiedForTest()
  const MSG1 = 'サーバーのファイルを確かめられませんでした。もう一度「ノートを開く」を押してください。'
  const MSG3 = 'このパソコンでファイルの指紋を調べられません。READMEの「困ったとき」を見てください'
  const f = fake({ shaFails: true })
  for (const want of [MSG1, MSG1, MSG3]) {
    const r: any = await ensureBinary(f.$, mac, () => {}, RELEASE)
    expect(r.problem).toBe(want)
    expect([...f.files.keys()].some(k => k.includes('.part-'))).toBe(false)
    expect(f.files.has(BIN)).toBe(false)
    expect(f.dirs.has(LOCK)).toBe(false)
  }
})

test('ensureBinary：置き場に正しいファイルがあればそのまま使い、ダウンロードしない', async () => {
  resetVerifiedForTest()
  const f = fake({ files: { [BIN]: { size: 5, sha: SHA } } })
  expect(await ensureBinary(f.$, mac, () => {}, RELEASE)).toEqual({ bin: BIN })
  expect(f.spawned.length).toBe(0)
})

test('ensureBinary：置き場のファイルが壊れていれば、消してダウンロードし直す', async () => {
  resetVerifiedForTest()
  const f = fake({ files: { [BIN]: { size: 5, sha: BAD } } })
  expect(await ensureBinary(f.$, mac, () => {}, RELEASE)).toEqual({ bin: BIN })
  expect(f.spawned.length).toBe(1)
  expect(f.files.get(BIN)?.sha).toBe(SHA)
})

test('古いバージョンのフォルダーだけを消す。新しいバージョンは消さない', async () => {
  const f = fake({
    dirs: {
      [BIN_ROOT + '/0.0.9']: 0, [DIR]: 0, [LOCK]: 0, [BIN_ROOT + '/notes']: 0, [BIN_ROOT + '/1.2.3-rc.1']: 0,
      [BIN_ROOT + '/0.1.0-alpha']: 0, [BIN_ROOT + '/0.1.0']: 0, [BIN_ROOT + '/0.1.0-dev.4']: 0,
    },
    files: { [BIN_ROOT + '/0.0.1']: { size: 1 } },
  })
  expect(await removeOldVersions(f.$, mac, RELEASE)).toBe(true) // 今の版は 0.1.0-dev
  expect(f.dirs.has(BIN_ROOT + '/0.0.9')).toBe(false)
  expect(f.dirs.has(BIN_ROOT + '/0.1.0-alpha')).toBe(false) // alpha < dev
  expect(f.dirs.has(BIN_ROOT + '/1.2.3-rc.1')).toBe(true)
  expect(f.dirs.has(BIN_ROOT + '/0.1.0')).toBe(true) // 正式版は dev より新しい
  expect(f.dirs.has(BIN_ROOT + '/0.1.0-dev.4')).toBe(true) // 項目が多いほうが新しい
  expect(f.dirs.has(DIR)).toBe(true)
  expect(f.dirs.has(LOCK)).toBe(true)
  expect(f.dirs.has(BIN_ROOT + '/notes')).toBe(true)
  expect(f.files.has(BIN_ROOT + '/0.0.1')).toBe(true)
})

test('bin/ が無くても removeOldVersions は何も起こさない', async () => {
  const f = fake()
  f.$.fs.list = async () => { throw new Error('ENOENT') }
  await removeOldVersions(f.$, mac, RELEASE)
  expect(f.log.length).toBe(0)
})

test('onStage は checking → downloading → verifying の順に呼ばれる', async () => {
  resetVerifiedForTest()
  const f = fake()
  const st = stages()
  await ensureBinary(f.$, mac, st.on, RELEASE)
  expect(st.s).toEqual(['checking', 'downloading', 'verifying'])
})

test('binDir は <保存フォルダー>/bin/<VERSION>', async () => {
  expect(binDir(mac)).toMatch(/^\/S\/NoteDock\/bin\/\d+\.\d+\.\d+/)
  expect(binDir({ ...mac, os: 'win32', stateDir: 'C:\\S\\NoteDock' }, '1.2.3')).toBe('C:\\S\\NoteDock\\bin\\1.2.3')
})

test('ロックが作れず、ロックも無ければ、mkdir をもう1回やり直してから「書けませんでした」', async () => {
  resetVerifiedForTest()
  const f = fake({ lockFails: true })
  const r: any = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r.problem).toContain('置き場に書けませんでした')
  expect(f.log.filter(l => l === '/bin/mkdir ' + LOCK).length).toBe(2)
})

test('beat の書きかけがあるうちにダウンロードが終わっても、ロックを消したあとに beat.json は書かれない', async () => {
  resetVerifiedForTest()
  const f = fake()
  let n = 0
  let release: () => void = () => {}
  const orig = f.$.fs.write
  f.$.fs.write = async (p: string, x: string) => {
    if (p === BEAT && ++n === 2) await new Promise<void>(r => { release = r })
    if (p === BEAT) f.log.push('write-beat')
    return orig(p, x)
  }
  const sp = f.$.process.spawn
  f.$.process.spawn = (req: any) => {
    const s: any = sp(req)
    return { ...s, next: async () => { await new Promise<void>(r => f.$.clock.after(5500, () => r())); setTimeout(() => release(), 20); return s.next() } }
  }
  const r = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r).toEqual({ bin: BIN })
  expect(n).toBe(2)
  expect(f.log.lastIndexOf('write-beat')).toBeLessThan(f.log.lastIndexOf('/bin/rm -rf ' + LOCK))
  expect(f.dirs.has(LOCK)).toBe(false)
})

test('beat.json が読めない形でも、フォルダーではなく beat.json の更新時刻で数える', async () => {
  resetVerifiedForTest()
  // フォルダーは古い（0）が、beat.json は今書かれたばかり。29秒の時点では消さない。
  const f = fake({ dirs: { [LOCK]: 0 }, files: { [BEAT]: { text: 'ここは JSON ではない', mtimeMs: 1_000_000 } } })
  f.$.clock.after(29_000, () => { f.files.set(BIN, { size: 5, sha: SHA, mtimeMs: f.now() }) })
  expect(await ensureBinary(f.$, mac, () => {}, RELEASE)).toEqual({ bin: BIN })
  expect(f.events.some(e => e.what === 'rm ' + LOCK)).toBe(false)
})

test('onStage が例外を投げても、ダウンロードして bin を返し、一時ファイルを残さない', async () => {
  resetVerifiedForTest()
  const f = fake()
  const r = await ensureBinary(f.$, mac, () => { throw new Error('表示の失敗') }, RELEASE)
  expect(r).toEqual({ bin: BIN })
  expect([...f.files.keys()].some(k => k.includes('.part-'))).toBe(false)
  expect(f.dirs.has(LOCK)).toBe(false)
})

test('待っている間に exists が失敗し続けたら、10回であきらめて取り直す', async () => {
  resetVerifiedForTest()
  const f = fake({ dirs: { [LOCK]: 1_000_000 }, files: { [BEAT]: { text: JSON.stringify({ t: 1_000_000 }) } } })
  const ex = f.$.fs.exists
  let broken = false
  f.$.clock.after(1, () => { broken = true })
  f.$.fs.exists = async (p: string) => {
    if (broken && p === BIN) throw new Error('見られません')
    return ex(p)
  }
  // 10回（30秒）失敗したあと、ロックが消えたものとして、ダウンロードへ進む
  f.$.clock.after(31_000, () => { broken = false; f.dirs.delete(LOCK); f.files.delete(BEAT) })
  const r = await ensureBinary(f.$, mac, () => {}, RELEASE)
  expect(r).toEqual({ bin: BIN })
  expect(f.spawned.length).toBe(1)
})

test('版の順：番号、付いていない版が新しい、数字は数で、数字は文字より古い、項目が多いほうが新しい', () => {
  const order = ['0.0.9', '0.1.0-alpha', '0.1.0-dev', '0.1.0-dev.1', '0.1.0-dev.4', '0.1.0-dev.10', '0.1.0-dev.a', '0.1.0', '0.2.0', '1.0.0']
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      expect(Math.sign(compareVersions(order[i], order[j]))).toBe(Math.sign(i - j))
    }
  }
})

test('removeOldVersions は、消せないフォルダーがあれば false を返す（あとで消し直すため）', async () => {
  const f = fake({ dirs: { [BIN_ROOT + '/0.0.9']: 0, [BIN_ROOT + '/0.0.8']: 0, [DIR]: 0 } })
  const run = f.$.process.run
  f.$.process.run = async (argv: string[]) => (argv[0] === '/bin/rm' && argv[2].endsWith('0.0.9') ? { stdout: '', stderr: 'busy', exitCode: 1 } : run(argv))
  expect(await removeOldVersions(f.$, mac, RELEASE)).toBe(false)
  expect(f.dirs.has(BIN_ROOT + '/0.0.8')).toBe(false) // ほかは消す
  f.$.process.run = run
  expect(await removeOldVersions(f.$, mac, RELEASE)).toBe(true)
  expect(f.dirs.has(BIN_ROOT + '/0.0.9')).toBe(false)
})

test('onlyNewerInstalled は、自分のファイルが無く、自分より新しいバージョンのフォルダーがあるときだけ true', async () => {
  expect(await onlyNewerInstalled(fake({ dirs: { [BIN_ROOT + '/0.2.0']: 0 } }).$, mac, RELEASE)).toBe(true)
  expect(await onlyNewerInstalled(fake({ dirs: { [BIN_ROOT + '/0.0.9']: 0, [LOCK]: 0 } }).$, mac, RELEASE)).toBe(false)
  expect(await onlyNewerInstalled(fake({ dirs: { [BIN_ROOT + '/0.2.0']: 0 }, files: { [BIN]: { size: 5, sha: SHA } } }).$, mac, RELEASE)).toBe(false)
  const g = fake()
  g.$.fs.list = async () => { throw new Error('ENOENT') }
  expect(await onlyNewerInstalled(g.$, mac, RELEASE)).toBe(false)
})
