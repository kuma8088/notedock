import { expect, test } from 'claude-code/testing'

import type { HostInfo } from './platform'
import { createWatcher, findRunning, HELD_RETRY_MS, probe, readServerInfo, requestShutdown, startServer, vaultDirOf, vaultIdOf, type Running, type Started } from './server'

const mac: HostInfo = { os: 'darwin', home: '/Users/yamada', stateDir: '/S/NoteDock', target: 'aarch64-apple-darwin', systemRoot: null }
const VID = '0123456789abcdef'
const OTHER = 'fedcba9876543210'
const BIN = '/S/NoteDock/bin/0.1.0-dev/notedock-server'
const ROOT = '/V/notes'
const JSON_PATH = `/S/NoteDock/vaults/${VID}/server.json`

// テストの `$` には http・process・fs・clock が無いので、使う分だけの代役を作る。
// 時計は仮想で、タイマーを待つと自動で進む。サーバーは「何ミリ秒後に立ち上がる」と決めておく。
type Spawn = { chunks?: string[]; code?: number; hang?: boolean; upAfterMs?: number; port?: number; throws?: boolean }
type Opt = { hangFetch?: boolean; files?: Record<string, string>; listening?: Record<number, string>; versions?: Record<number, string>; shutdownStatus?: number; spawns?: Spawn[]; run?: { exitCode: number; stdout: string } }
function fake(o: Opt = {}) {
  const files = new Map<string, string>(Object.entries(o.files ?? {}))
  const listening = new Map<number, string>(Object.entries(o.listening ?? {}).map(([k, v]) => [Number(k), v]))
  const versions = new Map<number, string>(Object.entries(o.versions ?? {}).map(([k, v]) => [Number(k), v]))
  const spawned: any[] = []
  const fetched: string[] = []
  const requests: { url: string; init: any }[] = []
  const returned: number[] = []
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
      if (!live.length || ++steps > 5000) return
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
  const up = (port: number, vid = VID) => {
    files.set(JSON_PATH, JSON.stringify({ port, root: ROOT, token: 'secret', ticket: 'tk', pid: 4242, nonce: 'n' }))
    listening.set(port, vid)
  }
  const $ = {
    process: {
      run: async (argv: string[]) => {
        if (o.run) return { ...o.run, stderr: '' }
        return { exitCode: 1, stdout: '', stderr: '' }
      },
      spawn: (req: { argv: string[] }) => {
        const n = spawned.length
        spawned.push(req)
        const s = o.spawns?.[n] ?? {}
        if (s.upAfterMs !== undefined) addTimer(s.upAfterMs, () => up(s.port ?? 8800), false)
        async function* gen() {
          if (s.throws) throw new Error('起動できません')
          for (const c of s.chunks ?? []) yield { stream: 'stderr', text: c }
          if (s.hang) await new Promise(() => {})
          return { code: s.code ?? 0, signal: null }
        }
        const inner: any = gen()
        let finish: (r: any) => void = () => {}
        const result = new Promise<any>(res => { finish = res })
        return {
          [Symbol.asyncIterator]() { return this },
          next: async () => {
            const r = await inner.next()
            if (r.done) finish(r.value)
            return r
          },
          return: async (v: any) => { returned.push(n); return { done: true, value: v } },
          result,
        }
      },
    },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error('ENOENT')
        return files.get(p)!
      },
      exists: async (p: string) => files.has(p),
    },
    http: {
      fetch: async (url: string, init?: any) => {
        fetched.push(url)
        requests.push({ url, init })
        if (o.hangFetch) await new Promise(() => {})
        const port = Number(new URL(url).port)
        const vid = listening.get(port)
        if (vid === undefined) throw new Error('ECONNREFUSED')
        const headers: Record<string, string> = { 'x-notedock-vault': vid }
        if (versions.has(port)) headers['x-notedock-version'] = versions.get(port)!
        if (new URL(url).pathname === '/api/shutdown') {
          const status = o.shutdownStatus ?? 204
          return { status, ok: status >= 200 && status < 300, headers, text: '' }
        }
        return { status: 401, ok: false, headers, text: '' }
      },
    },
    clock: {
      now: async () => t,
      after: (ms: number, fn: () => void) => addTimer(ms, fn, false),
      every: (ms: number, fn: () => void) => addTimer(ms, fn, true),
      sleep: async () => { throw new Error('sleep は使わない') },
    },
  }
  return { $, files, listening, versions, spawned, fetched, requests, returned, up, now: () => t }
}

test('vaultIdOf は 16 文字の16進だけを受け取る', async () => {
  expect(await vaultIdOf(fake({ run: { exitCode: 0, stdout: VID + '\n' } }).$, BIN, ROOT)).toBe(VID)
  expect(await vaultIdOf(fake({ run: { exitCode: 0, stdout: 'oops' } }).$, BIN, ROOT)).toBe(null)
  expect(await vaultIdOf(fake({ run: { exitCode: 2, stdout: VID } }).$, BIN, ROOT)).toBe(null)
})

test('vaultDirOf は <保存フォルダー>/vaults/<vaultId>', () => {
  expect(vaultDirOf(mac, VID)).toBe('/S/NoteDock/vaults/' + VID)
})

test('server.json を読む。壊れていれば null', async () => {
  const f = fake()
  f.up(8800)
  expect(await readServerInfo(f.$, mac, VID)).toEqual({ port: 8800, pid: 4242, root: ROOT, token: 'secret', ticket: 'tk' })
  f.files.set(JSON_PATH, '{ぼろぼろ')
  expect(await readServerInfo(f.$, mac, VID)).toBe(null)
  f.files.delete(JSON_PATH)
  expect(await readServerInfo(f.$, mac, VID)).toBe(null)
})

test('server.json の ticket が [A-Za-z0-9_-] 以外を含む、または port が 1〜65535 でなければ、読めないものとして扱う', async () => {
  const f = fake()
  const put = (over: Record<string, unknown>) =>
    f.files.set(JSON_PATH, JSON.stringify({ port: 8800, root: ROOT, token: 'secret', ticket: 'tk', pid: 4242, nonce: 'n', ...over }))
  put({})
  expect((await readServerInfo(f.$, mac, VID))?.ticket).toBe('tk')
  put({ ticket: 'Ab_-9' })
  expect((await readServerInfo(f.$, mac, VID))?.ticket).toBe('Ab_-9')
  for (const bad of ['a b', 'a&b=1', 'a"b', 'a/b', 'あ', 'a\nb', 'a%20b']) {
    put({ ticket: bad })
    expect(await readServerInfo(f.$, mac, VID)).toBe(null)
  }
  put({ port: 65535 })
  expect((await readServerInfo(f.$, mac, VID))?.port).toBe(65535)
  for (const bad of [0, -1, 65536, 99999, 80.5, '8800']) {
    put({ port: bad })
    expect(await readServerInfo(f.$, mac, VID)).toBe(null)
  }
})

test('2つのチャットの見張りが同時に起動しても、使うサーバーは1つ', async () => {
  // 1つ目の起動が動き出し、2つ目は「もう動いている」（75）で終わって1つ目を使う。
  const f = fake({ spawns: [{ hang: true, upAfterMs: 1500 }, { code: 75, chunks: ['already running\n'] }] })
  const mk = () => createWatcher({ find: () => findRunning(f.$, mac, VID), start: () => startServer(f.$, mac, BIN, ROOT, VID), now: () => f.now() })
  const a = mk()
  const b = mk()
  const [x, y] = await Promise.all([a.tick(f.now()), b.tick(f.now())])
  expect(x.kind).toBe('running')
  expect(y.kind).toBe('running')
  expect((x as any).running.port).toBe((y as any).running.port)
  expect((x as any).running.pid).toBe((y as any).running.pid)
  expect(f.spawned.length).toBe(2)
  // 動いているのは1つだけ（待ち受けの番号が1つ）
  expect(f.listening.size).toBe(1)
  // 次の回も、どちらも同じサーバーを見つけ、起動し直さない
  const [x2, y2] = await Promise.all([a.tick(f.now() + 5000), b.tick(f.now() + 5000)])
  expect(x2.kind).toBe('running')
  expect(y2.kind).toBe('running')
  expect(f.spawned.length).toBe(2)
})

test('server.json があっても、返事の印が違えば動いていないとみなす', async () => {
  const f = fake()
  f.up(8800, OTHER)
  expect(await findRunning(f.$, mac, VID)).toBe(null)
})

test('401 でも印が合えば動いているとみなす', async () => {
  const f = fake()
  f.up(8800)
  expect((await probe(f.$, 8800, VID)).ours).toBe(true)
  expect(await findRunning(f.$, mac, VID)).toEqual({ port: 8800, vaultId: VID, ticket: 'tk', version: null, pid: 4242 })
  expect(f.fetched[0]).toBe('http://127.0.0.1:8800/api/health')
})

test('つながらなければ動いていないとみなす', async () => {
  const f = fake()
  f.up(8800)
  f.listening.clear()
  expect(await probe(f.$, 8800, VID)).toEqual({ ours: false, version: null })
  expect(await findRunning(f.$, mac, VID)).toBe(null)
})

test('起動して、server.json と返事の印がそろえば running を返す。起動は裏で動き続ける', async () => {
  const f = fake({ spawns: [{ hang: true, upAfterMs: 1500 }] })
  const r = await startServer(f.$, mac, BIN, ROOT, VID)
  expect(r).toEqual({ running: { port: 8800, vaultId: VID, ticket: 'tk', version: null, pid: 4242 }, own: true })
  expect(f.spawned.length).toBe(1)
})

test('75 で終わったら、ほかのサーバーが答えるまで待ってそれを使う', async () => {
  const f = fake({ spawns: [{ code: 75, chunks: ['already running\n'] }] })
  f.$.clock.after(7000, () => f.up(8801))
  const r = await startServer(f.$, mac, BIN, ROOT, VID)
  expect(r).toEqual({ running: { port: 8801, vaultId: VID, ticket: 'tk', version: null, pid: 4242 }, own: false })
})

test('2 で終わったら、サーバーの1行を添えて problem を返す', async () => {
  const f = fake({ spawns: [{ code: 2, chunks: ['古い行\n', 'bad root: /V/notes\n'] }] })
  const r: any = await startServer(f.$, mac, BIN, ROOT, VID)
  expect(r.problem).toContain('NoteDockのサーバーを起動できませんでした')
  expect(r.problem).toContain('bad root: /V/notes')
  expect(r.problem).toBe(r.problem.replace('古い行', ''))
})

test('1 など、ほかの終わり方でも problem を返す', async () => {
  const f = fake({ spawns: [{ code: 1, chunks: ['boom\n'] }] })
  const r: any = await startServer(f.$, mac, BIN, ROOT, VID)
  expect(r.problem).toContain('boom')
  const g = fake({ spawns: [{ throws: true }] })
  const r2: any = await startServer(g.$, mac, BIN, ROOT, VID)
  expect('problem' in r2).toBe(true)
})

test('2分たっても答えなければ problem を返す', async () => {
  const f = fake({ spawns: [{ hang: true }] })
  const t0 = f.now()
  const r: any = await startServer(f.$, mac, BIN, ROOT, VID)
  expect(r.problem).toContain('NoteDockのサーバーを起動できませんでした')
  expect(f.now() - t0 >= 120_000).toBe(true)
  expect(f.now() - t0 < 125_000).toBe(true)
  expect(f.returned).toEqual([0]) // 自分の子プロセスは止める
})

test('つながるのに答えないサーバーでも、2分で problem を返す', async () => {
  const f = fake({ spawns: [{ hang: true, upAfterMs: 600 }], hangFetch: true })
  const t0 = f.now()
  const r: any = await startServer(f.$, mac, BIN, ROOT, VID)
  expect(r.problem).toContain('2分')
  expect(f.now() - t0 >= 120_000).toBe(true)
  expect(f.now() - t0 < 125_000).toBe(true)
})

// ---- 見張り ----
const R: Running = { port: 8800, vaultId: VID, ticket: null, version: null, pid: 1 }
function watch(script: { find: (now: number) => Running | null; start: (now: number) => Started }) {
  let now = 0
  const calls = { find: 0, start: 0 }
  const w = createWatcher({
    find: async () => { calls.find++; return script.find(now) },
    start: async () => { calls.start++; return script.start(now) },
  })
  return { tick: (t: number) => { now = t; return w.tick(t) }, reset: w.reset, calls }
}

test('見張り：動いていれば何もしない。落ちたら次の tick で起動し直す', async () => {
  let up = true
  const w = watch({ find: () => (up ? R : null), start: () => { up = true; return { running: R } } })
  expect(await w.tick(0)).toEqual({ kind: 'running', running: R })
  expect((await w.tick(60_000)).kind).toBe('running')
  expect(w.calls.start).toBe(0)
  up = false
  expect(await w.tick(65_000)).toEqual({ kind: 'running', running: R })
  expect(w.calls.start).toBe(1)
})

test('見張り：起動してすぐ落ちるのが続くと、30秒・2分とあけ、3回で stopped になる', async () => {
  const w = watch({ find: () => null, start: () => ({ problem: '起動できません' }) })
  expect(await w.tick(0)).toEqual({ kind: 'waiting', until: 30_000 })
  expect(await w.tick(10_000)).toEqual({ kind: 'waiting', until: 30_000 })
  expect(w.calls.start).toBe(1)
  expect(await w.tick(30_000)).toEqual({ kind: 'waiting', until: 150_000 })
  expect(await w.tick(149_000)).toEqual({ kind: 'waiting', until: 150_000 })
  const s: any = await w.tick(150_000)
  expect(s.kind).toBe('stopped')
  expect(s.problem).toContain('起動できません')
  expect(w.calls.start).toBe(3)
  expect((await w.tick(1_000_000)).kind).toBe('stopped')
  expect(w.calls.start).toBe(3)
  w.reset()
  expect((await w.tick(1_000_005)).kind).toBe('waiting')
  expect(w.calls.start).toBe(4)
})

test('見張り：起動できても60秒もたたずに止まれば失敗に数える', async () => {
  let up = false
  const w = watch({ find: () => (up ? R : null), start: () => { up = true; return { running: R } } })
  expect((await w.tick(0)).kind).toBe('running')
  up = false
  expect(await w.tick(20_000)).toEqual({ kind: 'waiting', until: 50_000 }) // 失敗1
  expect((await w.tick(50_000)).kind).toBe('running')
  up = false
  expect(await w.tick(60_000)).toEqual({ kind: 'waiting', until: 180_000 }) // 失敗2
  expect((await w.tick(180_000)).kind).toBe('running')
  up = false
  expect((await w.tick(190_000)).kind).toBe('stopped') // 失敗3
})

test('見張り：60秒続けて動いたら、失敗の数を0に戻す', async () => {
  let up = false
  const w = watch({ find: () => (up ? R : null), start: () => { up = true; return { running: R } } })
  await w.tick(0) // 起動
  up = false
  expect((await w.tick(5_000)).kind).toBe('waiting') // 失敗1、30秒あける
  await w.tick(35_000) // 起動
  expect((await w.tick(95_000)).kind).toBe('running') // 60秒続いた
  up = false
  expect(await w.tick(100_000)).toEqual({ kind: 'running', running: R }) // 失敗は0に戻っているので、すぐ起動し直す
  expect(w.calls.start).toBe(3)
})

test('見張り：70秒かかって起動し、すぐ落ちたら失敗に数える（起動後の時刻で数える）', async () => {
  let t = 0
  let up = false
  const w = createWatcher({ find: async () => (up ? R : null), start: async () => { t = 70_000; up = true; return { running: R } }, now: () => t })
  expect((await w.tick(0)).kind).toBe('running')
  up = false
  expect((await w.tick(75_000)).kind).toBe('waiting') // 5秒しか動いていない
})

test('見張り：2分かかった起動の失敗は、終わった時刻から30秒あける', async () => {
  let t = 0
  const w = createWatcher({ find: async () => null, start: async () => { t = 120_000; return { problem: '起動できません' } }, now: () => t })
  expect(await w.tick(0)).toEqual({ kind: 'waiting', until: 150_000 })
})

test('見張り：ほかのチャットのサーバーが消えても、失敗には数えない', async () => {
  let up = true
  let starts = 0
  const w = createWatcher({ find: async () => (up ? R : null), start: async () => { starts++; up = true; return { running: R } } })
  await w.tick(0)
  up = false
  expect((await w.tick(5000)).kind).toBe('running') // すぐ起動し直す（待たない）
  expect(starts).toBe(1)
})

test('見張り：stopped のあいだも探し、見つかれば running を返す（起動はしない）', async () => {
  let up = false
  let starts = 0
  const w = createWatcher({ find: async () => (up ? R : null), start: async () => { starts++; return { problem: 'だめ' } } })
  await w.tick(0); await w.tick(30_000); await w.tick(150_000)
  expect(starts).toBe(3)
  up = true
  expect((await w.tick(200_000)).kind).toBe('running')
  up = false
  expect((await w.tick(210_000)).kind).toBe('stopped')
  expect(starts).toBe(3)
})

test('見張り：返ってこない find / start は打ち切って失敗にする', async () => {
  const timers: { at: number; fn: () => void }[] = []
  const after = (ms: number, fn: () => void) => { const x = { at: ms, fn }; timers.push(x); setTimeout(fn, 0); return { cancel: () => { x.fn = () => {} } } }
  const w = createWatcher({ find: () => new Promise<Running | null>(() => {}), start: () => new Promise<Started>(() => {}), after })
  const s: any = await w.tick(0)
  expect(s.kind).toBe('waiting')
})

test('見張り：find の最中に tick が来たら、前回の状態を返す', async () => {
  let release: (r: Running | null) => void = () => {}
  let first = true
  const w = createWatcher({ find: () => (first ? (first = false, Promise.resolve(R)) : new Promise<Running | null>(r => { release = r })), start: async () => ({ running: R }) })
  expect((await w.tick(0)).kind).toBe('running')
  const p = w.tick(5000)
  expect(await w.tick(6000)).toEqual({ kind: 'running', running: R })
  release(R)
  await p
})

test('見張り：起動の最中に tick が来たら starting を返し、start は重ねて呼ばない', async () => {
  let release: (s: Started) => void = () => {}
  let n = 0
  const w = createWatcher({ find: async () => null, start: () => { n++; return new Promise<Started>(r => { release = r }) } })
  const first = w.tick(0)
  await new Promise(r => setTimeout(r, 5))
  expect(await w.tick(5000)).toEqual({ kind: 'starting' })
  release({ running: R })
  expect(await first).toEqual({ kind: 'running', running: R })
  expect(n).toBe(1)
})

// ---- 新しいバージョンが古いサーバーを入れ替える ----

test('probe は x-notedock-vault が合えば ours、x-notedock-version を version として返す（無ければ null）', async () => {
  const f = fake({ listening: { 8800: VID, 8801: VID, 8802: OTHER, 8803: VID }, versions: { 8800: '0.2.0', 8802: '0.2.0', 8803: 'だめな版' } })
  expect(await probe(f.$, 8800, VID)).toEqual({ ours: true, version: '0.2.0' })
  expect(await probe(f.$, 8801, VID)).toEqual({ ours: true, version: null }) // 見出しのない、古い開発用のビルドのサーバー
  expect(await probe(f.$, 8802, VID)).toEqual({ ours: false, version: '0.2.0' }) // 別のVault
  expect(await probe(f.$, 8803, VID)).toEqual({ ours: true, version: null }) // バージョンの形でなければ無いとみなす
  expect(await probe(f.$, 8899, VID)).toEqual({ ours: false, version: null }) // つながらない
  expect(f.fetched[0]).toBe('http://127.0.0.1:8800/api/health')
  // findRunning も、見えたバージョンを返す。
  f.up(8800)
  expect(await findRunning(f.$, mac, VID)).toEqual({ port: 8800, vaultId: VID, ticket: 'tk', version: '0.2.0', pid: 4242 })
})

test('requestShutdown は合言葉・x-note-editor: 1・自分のバージョンを付けて送り、204・409・それ以外を stopping・refused・failed にする', async () => {
  const send = async (status: number | 'down' | 'nojson') => {
    const f = fake({ shutdownStatus: typeof status === 'number' ? status : 204 })
    if (status !== 'nojson') f.up(8800)
    if (status === 'down') f.listening.clear()
    const r = await requestShutdown(f.$, mac, VID, '0.3.0')
    return { r, f }
  }
  const { r, f } = await send(204)
  expect(r).toBe('stopping')
  const req = f.requests.find(q => q.url.endsWith('/api/shutdown'))!
  expect(req.url).toBe('http://127.0.0.1:8800/api/shutdown')
  expect(req.init.method).toBe('POST')
  expect(req.init.headers).toEqual({ 'x-note-token': 'secret', 'x-note-editor': '1', 'x-notedock-version': '0.3.0' })
  expect((await send(503)).r).toBe('stopping') // もう止まりかけている
  expect((await send(409)).r).toBe('refused') // 自分のほうが新しくない
  expect((await send(400)).r).toBe('failed')
  expect((await send(401)).r).toBe('failed')
  expect((await send(403)).r).toBe('failed')
  expect((await send('down')).r).toBe('failed') // つながらない
  const none = await send('nojson') // server.json が無い（合言葉が分からない）
  expect(none.r).toBe('failed')
  expect(none.f.requests.length).toBe(0)
  // 合言葉が無い server.json でも送らない。
  const g = fake()
  g.files.set(JSON_PATH, JSON.stringify({ port: 8800, pid: 1, root: ROOT, ticket: 'tk' }))
  g.listening.set(8800, VID)
  expect(await requestShutdown(g.$, mac, VID, '0.3.0')).toBe('failed')
  expect(g.requests.length).toBe(0)
})

test('サーバーが 76 で終わったら、起動の失敗に数えない', async () => {
  // startServer は、76（新しいバージョンに譲った）を problem にせず、held で返す。
  const f = fake({ spawns: [{ code: 76, chunks: ['新しいバージョン（0.3.0）に譲ったので、起動しません\n'] }] })
  const t0 = f.now()
  const r = await startServer(f.$, mac, BIN, ROOT, VID)
  expect(r).toEqual({ held: true })
  expect(f.now() - t0 < 5_000).toBe(true) // 2分待たずに返る
  // 見張りは held を失敗に数えない（何度続いても waiting・stopped にならない）。
  const w = watch({ find: () => null, start: () => ({ held: true }) })
  for (let i = 0; i < 10; i++) {
    const s = await w.tick(i * 5000)
    expect(s.kind).toBe('replacing')
  }
  // そのあと新しいサーバーが答えれば、それを使う。
  const w2 = watch({ find: n => (n >= 20_000 ? R : null), start: () => ({ held: true }) })
  for (let n = 0; n < 20_000; n += 5000) await w2.tick(n)
  expect(await w2.tick(20_000)).toEqual({ kind: 'running', running: R })
})

// 見張りの頭脳の入れ替え。version と shutdown を渡したときだけ入れ替える。
function replaceWatch(o: { found: () => Running | null; start?: () => Started; shutdown?: () => 'stopping' | 'refused' | 'failed' }) {
  const events: any[] = []
  const calls = { shutdown: 0, start: 0 }
  const w = createWatcher({
    find: async () => o.found(),
    start: async () => { calls.start++; return o.start ? o.start() : { problem: 'だめ' } },
    version: '0.2.0',
    shutdown: async () => { calls.shutdown++; return o.shutdown ? o.shutdown() : 'stopping' },
    onReplace: e => events.push(e),
  })
  return { w, events, calls }
}

test('見張り：古いバージョンが答えれば止める指示を送り、答えなくなってから自分のバージョンを起動する', async () => {
  let cur: Running | null = { ...R, version: '0.1.0' }
  const mineR: Running = { ...R, version: '0.2.0', pid: 2 }
  const x = replaceWatch({ found: () => cur, start: () => { cur = mineR; return { running: mineR, own: true } } })
  expect(await x.w.tick(0)).toEqual({ kind: 'replacing' })
  expect(x.calls.shutdown).toBe(1)
  expect(x.events).toEqual([{ kind: 'stopping' }])
  expect(await x.w.tick(5000)).toEqual({ kind: 'replacing' }) // まだ答えている
  expect(x.calls.start).toBe(0)
  cur = null // 止まった
  expect(await x.w.tick(10_000)).toEqual({ kind: 'running', running: mineR })
  expect(x.calls.start).toBe(1)
  expect(x.calls.shutdown).toBe(1)
})

test('自分が起動したサーバーは、バージョンが古く見えても止めない', async () => {
  // 開発中に、サーバーのファイルのバージョンが Mod の VERSION より古いとき。
  let cur: Running | null = null
  const old: Running = { ...R, version: '0.0.0-dev', pid: 7 }
  const x = replaceWatch({ found: () => cur, start: () => { cur = old; return { running: old, own: true } } })
  expect(await x.w.tick(0)).toEqual({ kind: 'running', running: old })
  expect(await x.w.tick(5000)).toEqual({ kind: 'running', running: old })
  expect(x.calls.shutdown).toBe(0)
  // 75 で、ほかのチャットのサーバーを使ったときは、自分が起動したものではない。
  let cur2: Running | null = null
  const y = replaceWatch({ found: () => cur2, start: () => { cur2 = old; return { running: old, own: false } } })
  await y.w.tick(0)
  expect(await y.w.tick(5000)).toEqual({ kind: 'replacing' })
  expect(y.calls.shutdown).toBe(1)
})

// ---- 入れ替えを待つあいだと、失敗したあとのやり直し ----

test('start が held を返したら、HELD_RETRY_MS のあいだは start を呼ばず、状態は replacing のまま', async () => {
  const w = watch({ find: () => null, start: () => ({ held: true }) })
  expect(await w.tick(0)).toEqual({ kind: 'replacing' })
  expect(w.calls.start).toBe(1)
  for (let t = 5000; t < HELD_RETRY_MS; t += 5000) {
    expect(await w.tick(t)).toEqual({ kind: 'replacing' })
  }
  expect(w.calls.start).toBe(1)
  // 待っているあいだも探し続け、新しいバージョンが答えればそれを使う。
  expect(w.calls.find).toBe(HELD_RETRY_MS / 5000)
})

test('HELD_RETRY_MS を過ぎたら、もう一度 start を呼ぶ', async () => {
  let held = true
  const w = watch({ find: () => null, start: () => (held ? { held: true } : { running: R }) })
  await w.tick(0)
  await w.tick(HELD_RETRY_MS - 1)
  expect(w.calls.start).toBe(1)
  expect(await w.tick(HELD_RETRY_MS)).toEqual({ kind: 'replacing' })
  expect(w.calls.start).toBe(2)
  held = false
  await w.tick(HELD_RETRY_MS + 5000)
  expect(w.calls.start).toBe(2) // 2回目の held から、また30秒待つ
  expect(await w.tick(2 * HELD_RETRY_MS)).toEqual({ kind: 'running', running: R })
  expect(w.calls.start).toBe(3)
  // 押したとき（reset）は、待たずにすぐ start を呼ぶ。
  const w2 = watch({ find: () => null, start: () => ({ held: true }) })
  await w2.tick(0)
  w2.reset()
  await w2.tick(1000)
  expect(w2.calls.start).toBe(2)
})

test('入れ替えが failed（返事がない、読めない）なら、30秒後と、その120秒後にやり直し、合計3回で止める', async () => {
  const old: Running = { ...R, version: '0.1.0' }
  const x = replaceWatch({ found: () => old, shutdown: () => 'failed' })
  // やり直しを待つあいだは、古いサーバーをそのまま使う。
  expect(await x.w.tick(0)).toEqual({ kind: 'running', running: old })
  expect(x.calls.shutdown).toBe(1)
  for (let t = 5000; t < 30_000; t += 5000) await x.w.tick(t)
  expect(x.calls.shutdown).toBe(1)
  expect(await x.w.tick(30_000)).toEqual({ kind: 'running', running: old })
  expect(x.calls.shutdown).toBe(2)
  for (let t = 35_000; t < 150_000; t += 5000) await x.w.tick(t)
  expect(x.calls.shutdown).toBe(2)
  await x.w.tick(150_000)
  expect(x.calls.shutdown).toBe(3)
  for (let t = 155_000; t < 1_000_000; t += 5000) await x.w.tick(t)
  expect(x.calls.shutdown).toBe(3)
  expect(x.calls.start).toBe(0)
})

test('停止リクエストのあと、古いサーバーが STOP_WAIT_MS のうちに止まらなければ（timeout）、failed と同じくやり直す', async () => {
  const old: Running = { ...R, version: '0.1.0' }
  const x = replaceWatch({ found: () => old, shutdown: () => 'stopping' })
  expect(await x.w.tick(0)).toEqual({ kind: 'replacing' })
  expect(await x.w.tick(15_000)).toEqual({ kind: 'replacing' })
  // 20秒たっても答えている。1回目の失敗。30秒後にやり直す。
  expect(await x.w.tick(20_000)).toEqual({ kind: 'running', running: old })
  expect(x.events.filter(e => e.kind === 'failed')).toEqual([])
  await x.w.tick(45_000)
  expect(x.calls.shutdown).toBe(1)
  expect(await x.w.tick(50_000)).toEqual({ kind: 'replacing' })
  expect(x.calls.shutdown).toBe(2)
  // 2回目の失敗（70秒）。その120秒後（190秒）に3回目。
  expect((await x.w.tick(70_000)).kind).toBe('running')
  await x.w.tick(185_000)
  expect(x.calls.shutdown).toBe(2)
  expect(await x.w.tick(190_000)).toEqual({ kind: 'replacing' })
  expect(x.calls.shutdown).toBe(3)
  expect(await x.w.tick(210_000)).toEqual({ kind: 'running', running: old })
  expect(x.events).toEqual([{ kind: 'stopping' }, { kind: 'stopping' }, { kind: 'stopping' }, { kind: 'failed', reason: 'timeout' }])
  for (let t = 215_000; t < 1_000_000; t += 5000) await x.w.tick(t)
  expect(x.calls.shutdown).toBe(3)
})

test('入れ替えに3回失敗したときだけ、onReplace に failed を1回渡す', async () => {
  const old: Running = { ...R, version: '0.1.0' }
  const x = replaceWatch({ found: () => old, shutdown: () => 'failed' })
  await x.w.tick(0)
  await x.w.tick(30_000)
  expect(x.events).toEqual([])
  await x.w.tick(150_000)
  expect(x.events).toEqual([{ kind: 'failed', reason: 'failed' }])
  for (let t = 155_000; t < 600_000; t += 5000) await x.w.tick(t)
  expect(x.events).toEqual([{ kind: 'failed', reason: 'failed' }])
  // 押しても（reset）、やり直しの数は戻さない。
  x.w.reset()
  await x.w.tick(600_000)
  expect(x.calls.shutdown).toBe(3)

  // やり直しのうちに入れ替われば、failed は出さない。
  let cur: Running | null = old
  const mineR: Running = { ...R, version: '0.2.0', pid: 2 }
  let n = 0
  const y = replaceWatch({ found: () => cur, shutdown: () => (++n < 2 ? 'failed' : 'stopping'), start: () => { cur = mineR; return { running: mineR, own: true } } })
  await y.w.tick(0)
  expect(await y.w.tick(30_000)).toEqual({ kind: 'replacing' })
  cur = null
  expect(await y.w.tick(35_000)).toEqual({ kind: 'running', running: mineR })
  for (let t = 40_000; t < 600_000; t += 5000) await y.w.tick(t)
  expect(y.events).toEqual([{ kind: 'stopping' }])
  expect(y.calls.shutdown).toBe(2)
})

test('入れ替えが refused（相手のほうが新しい）なら、もうやり直さない', async () => {
  const old: Running = { ...R, version: '0.1.0' }
  const x = replaceWatch({ found: () => old, shutdown: () => 'refused' })
  expect(await x.w.tick(0)).toEqual({ kind: 'running', running: old })
  expect(x.events).toEqual([{ kind: 'failed', reason: 'refused' }])
  for (let t = 5000; t < 1_000_000; t += 5000) await x.w.tick(t)
  expect(x.calls.shutdown).toBe(1)
  expect(x.events).toEqual([{ kind: 'failed', reason: 'refused' }])
})

test('停止リクエストの返事が届かず failed でも、サーバーが消えていれば、やり直しを待たずに自分のバージョンを起動し、failed は出さない', async () => {
  // 古いサーバーが、204 を返しきらないうちに終了した（予備のタイマーが先に動いた）。
  let cur: Running | null = { ...R, version: '0.1.0' }
  const mineR: Running = { ...R, version: '0.2.0', pid: 2 }
  const x = replaceWatch({
    found: () => cur,
    shutdown: () => { cur = null; return 'failed' },
    start: () => { cur = mineR; return { running: mineR, own: true } },
  })
  await x.w.tick(0)
  expect(x.calls.shutdown).toBe(1)
  // 次の見張りの回（5秒後）で、いないのを見つけて起動する。30秒は待たない。
  expect(await x.w.tick(5000)).toEqual({ kind: 'running', running: mineR })
  expect(x.calls.start).toBe(1)
  for (let t = 10_000; t < 600_000; t += 5000) await x.w.tick(t)
  expect(x.events).toEqual([])
  expect(x.calls.shutdown).toBe(1)
  expect(x.calls.start).toBe(1)
})
