import { expect, test } from 'claude-code/testing'

import { bandTree, createNotedock, ioFor, notePathFrom, wire } from './register'
import { readServerInfo, vaultDirOf } from './server'

// テストの `$` には env・process・fs が無いので、使う分だけの代役を作る。
// 時計は仮想で、advance で進めたぶんだけタイマーが動く。
const HOME = '/Users/u'
const STATE = `${HOME}/Library/Application Support/NoteDock`
const ROOT = '/V/notes'
const VID = '0123456789abcdef'
const VDIR = `${STATE}/vaults/${VID}`
const BIN = `${STATE}/bin/0.1.0-dev/notedock-server`
const TOKEN = 'TOKEN-secret-0000000000000000000000000000000'
const MIN = 60_000
const MINE = '0.2.0'
const OLD = '0.1.0'
const NEWER = '0.3.0'

type Opt = {
  surfaces?: string[]
  root?: string
  opened?: boolean
  installed?: boolean | 'problem'
  running?: boolean
  registerFails?: string[]
  registerAs?: Record<string, string> // 登録したときに返る名前（重なって置き換わった場合など）
  vaultDelayMs?: number
  realTools?: boolean // ツールの登録を代役にせず、本物（$.tool.register）を通す
  mine?: string // このModのバージョン（既定は MINE）
  serverVersion?: string | null // 動いているサーバーのバージョン（既定は mine。null は見出しのないサーバー）
  shutdown?: 'stopping' | 'refused' | 'failed' // requestShutdown の答え
  stopAfterMs?: number | null // stopping のあと、何ミリ秒で止まるか（null は止まらない）
  superseded?: boolean // 自分のファイルが無く、新しいバージョンのフォルダーがある
  removeFails?: number // removeOldVersions が、はじめの何回、消せないか
}

function world(o: Opt = {}) {
  let t = 1_000_000
  const files = new Map<string, string>()
  const dirs = new Set<string>([ROOT, '/V', HOME])
  const log: string[] = []
  const bands: any[] = []
  const toolSpecs: any[] = []
  const prompts: { text: string; rest: Record<string, unknown>; resolve: (r: any) => void; reject: (e: any) => void }[] = []
  const timers: { at: number; ms: number; fn: () => void; repeat: boolean; dead: boolean }[] = []
  const counts = { env: 0, sleep: 0, stat: 0, spawn: 0 }
  const mine = o.mine ?? MINE
  const srv = { running: !!o.running, ticket: 'KEY1', port: 8801, version: o.serverVersion === undefined ? mine : o.serverVersion, pid: 1 }
  const w = {
    findDelayMs: 0,
    findsInFlight: 0,
    installed: o.installed ?? false,
    surfaces: o.surfaces ?? ['desktop'],
    superseded: !!o.superseded,
    removeFails: o.removeFails ?? 0,
  }
  const writeServer = () =>
    files.set(`${VDIR}/server.json`, JSON.stringify({ port: srv.port, pid: srv.pid, root: ROOT, token: TOKEN, ticket: srv.ticket }))
  if (o.opened) files.set(`${STATE}/opened.json`, JSON.stringify({ [ROOT]: { at: 1 } }))
  if (srv.running) writeServer()

  const add = (ms: number, fn: () => void, repeat: boolean) => {
    const x = { at: t + ms, ms, fn, repeat, dead: false }
    timers.push(x)
    return { cancel: () => { x.dead = true } }
  }
  // 待っている処理を先に進める。タイマーの合間はマイクロタスクだけ、最後にイベントループも回す（速さのため）。
  const micro = async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve()
  }
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0))
  }
  const advance = async (ms: number) => {
    const end = t + ms
    await flush()
    for (;;) {
      await micro()
      const due = timers.filter(x => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      t = Math.max(t, due.at)
      if (due.repeat) due.at = t + due.ms
      else due.dead = true
      due.fn()
    }
    t = end
    await flush()
  }

  const ok = { exitCode: 0, stdout: '', stderr: '' }
  const $: any = {
    env: { get: async (n: string) => { counts.env++; return n === 'HOME' ? HOME : undefined } },
    session: {
      root: async () => o.root ?? ROOT,
      surfaces: async () => w.surfaces,
      id: async () => 'sess-1',
    },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error('ENOENT')
        return files.get(p)!
      },
      write: async (p: string, s: string) => {
        log.push(`write ${p}`)
        files.set(p, s)
      },
      exists: async (p: string) => files.has(p) || dirs.has(p),
      stat: async (p: string) => {
        counts.stat++
        if (dirs.has(p) || files.has(p)) return { realPath: p, size: 0, mtimeMs: 0 }
        throw new Error('ENOENT')
      },
      list: async () => [],
    },
    process: {
      run: async (argv: string[]) => {
        log.push(`run ${argv.join(' ')}`)
        if (argv[0] === '/usr/sbin/sysctl') return { ...ok, stdout: '1\n' }
        if (argv[0] === '/bin/mv') {
          files.set(argv[3], files.get(argv[2]) ?? '')
          files.delete(argv[2])
        }
        return ok
      },
      spawn: (req: { argv: string[] }) => {
        counts.spawn++
        log.push(`spawn ${req.argv[0]}`)
        throw new Error('テストでは起動しない')
      },
    },
    clock: {
      now: async () => t,
      after: (ms: number, fn: () => void) => add(ms, fn, false),
      every: (ms: number, fn: () => void) => add(ms, fn, true),
      sleep: async () => { counts.sleep++ },
    },
    command: {
      register: async (spec: { name: string }) => {
        if (o.registerFails?.includes(spec.name)) throw new Error('名前が重なっています')
        log.push(`command ${spec.name}`)
        return { command: o.registerAs?.[spec.name] ?? spec.name }
      },
    },
    tool: {
      register: async (spec: { name: string }) => {
        toolSpecs.push(spec)
        return { tool: `mcp__notedock__${spec.name}` }
      },
    },
    prompt: {
      submit: ({ text, ...rest }: { text: string }) => {
        log.push('submit')
        return new Promise((resolve, reject) => prompts.push({ text, rest, resolve, reject }))
      },
    },
  }

  // ダウンロード・起動・帯などは代役にする。それ以外（opened.json、場所、時計など）は本物の関数を代役の $ で動かす。
  const io = ioFor($, {
    installedBinary: async () => {
      log.push('installedBinary')
      return w.installed === true ? BIN : w.installed === 'problem' ? { problem: 'ファイルが壊れていました' } : null
    },
    ensureBinary: async () => {
      log.push('ensureBinary')
      w.installed = true
      return { bin: BIN }
    },
    removeOldVersions: async () => {
      log.push('removeOldVersions')
      if (w.removeFails > 0) {
        w.removeFails--
        return false
      }
      return true
    },
    superseded: async () => w.superseded,
    requestShutdown: async (_host, _id, version) => {
      log.push(`requestShutdown ${version}`)
      const r = o.shutdown ?? 'stopping'
      if (r === 'stopping' && o.stopAfterMs !== null) {
        add(o.stopAfterMs ?? 3000, () => {
          srv.running = false
          log.push('stopped')
          files.set(`${VDIR}/handover.json`, JSON.stringify({ to: version, at: t }))
        }, false)
      }
      return r
    },
    vaultIdOf: async () => {
      log.push('vaultIdOf')
      if (o.vaultDelayMs) await new Promise<void>(r => add(o.vaultDelayMs!, () => r(), false))
      return VID
    },
    findRunning: async () => {
      // 見たときの状態を、答えるまでの時間のあとに返す（古い答えを作るため）。
      const seen = srv.running ? { port: srv.port, vaultId: VID, ticket: srv.ticket, version: srv.version, pid: srv.pid } : null
      if (w.findDelayMs) {
        w.findsInFlight++
        await new Promise<void>(r => add(w.findDelayMs, () => r(), false))
        w.findsInFlight--
      }
      return seen
    },
    startServer: async () => {
      log.push('startServer')
      srv.running = true
      srv.version = mine
      srv.pid += 100
      writeServer()
      return { running: { port: srv.port, vaultId: VID, ticket: srv.ticket, version: srv.version, pid: srv.pid }, own: true }
    },
    readServerInfo: (host, id) => readServerInfo($, host, id),
    setBand: async b => { bands.push(b) },
    ...(o.realTools ? {} : { registerTools: async () => { log.push('registerTools') } }),
    claimChat: async dir => { log.push(`claimChat ${dir}`) },
  })
  const nd = createNotedock({ version: mine })

  return {
    $, nd, log, bands, toolSpecs, prompts, files, counts, srv, w, advance,
    band: () => (bands.length ? bands[bands.length - 1] : null),
    now: () => t,
    json: (p: string) => JSON.parse(files.get(p)!),
    setTicket: (k: string) => { srv.ticket = k; writeServer() },
    start: async () => { await nd.sessionStart(io); await advance(0) },
    io,
  }
}

// 押して、頼む文が届くところまで進める。
async function pressAndSend(x: ReturnType<typeof world>, today = false) {
  const before = x.prompts.length
  await x.nd.press(today)
  for (let i = 0; i < 20 && x.prompts.length === before; i++) await x.advance(500)
}

test('session.start はすぐ返り、その中で sleep しない', async () => {
  const x = world()
  await x.nd.sessionStart(x.io)
  // 裏の処理はまだ始まっていない（環境変数も読んでいない）。
  expect(x.counts.env).toBe(0)
  expect(x.counts.sleep).toBe(0)
  expect(x.log).toContain('command note')
  await x.advance(0)
  expect(x.counts.env).toBeGreaterThan(0)
  expect(x.counts.sleep).toBe(0)
})

test('画面のないチャットでは、帯もダウンロードも起動もしない', async () => {
  const x = world({ surfaces: [], opened: true, installed: true })
  await x.start()
  await x.advance(10_000)
  await x.advance(60_000)
  expect(x.band()).toBe(null)
  expect(x.counts.spawn).toBe(0)
  expect(x.log).not.toContain('ensureBinary')
  expect(x.log).not.toContain('startServer')
  expect(x.log).not.toContain('registerTools')
})

test('始まった直後は [] でも、session.attach で desktop が付けば帯を出す', async () => {
  const x = world({ surfaces: [] })
  await x.start()
  await x.advance(2000)
  expect(x.band()).toBe(null)
  x.w.surfaces = ['desktop']
  await x.nd.attach()
  await x.advance(0)
  expect(x.band()).toEqual({ kind: 'button', today: false })
})

test('10秒を過ぎてから session.attach で desktop が付いても、帯を出す', async () => {
  const x = world({ surfaces: [] })
  await x.start()
  await x.advance(12_000)
  expect(x.band()).toBe(null)
  x.w.surfaces = ['desktop']
  await x.nd.attach()
  await x.advance(0)
  expect(x.band()).toEqual({ kind: 'button', today: false })
})

test('押していないフォルダーでは、ボタンだけを出し、ダウンロードしない', async () => {
  const x = world({ installed: true })
  await x.start()
  await x.advance(60_000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  expect(x.log).not.toContain('ensureBinary')
  expect(x.log).not.toContain('startServer')
  expect(x.log).not.toContain('registerTools')
})

test('起動しないフォルダーでは何も出さない。ネットワーク上の場所では理由だけを出す', async () => {
  const home = world({ root: HOME })
  await home.start()
  await home.advance(15_000)
  expect(home.band()).toBe(null)
  expect(home.log.filter(l => l.startsWith('run ') && !l.includes('sysctl'))).toEqual([])

  const net = world({ root: '//server/share/notes' })
  await net.start()
  await net.advance(1000)
  expect(net.band()).toEqual({ kind: 'problem', text: 'ネットワーク上のフォルダーでは使えません', button: false })
})

test('\\\\ で始まる場所では、canonicalRoot を呼ばずに理由だけを出す', async () => {
  const x = world({ root: '\\\\server\\share\\notes' })
  await x.start()
  await x.advance(1000)
  expect(x.counts.stat).toBe(0)
  expect(x.band()).toEqual({ kind: 'problem', text: 'ネットワーク上のフォルダーでは使えません', button: false })
  expect(x.log).not.toContain('installedBinary')
})

test('opened.json にあっても、サーバーのファイルが無ければダウンロードせずにボタンを出す', async () => {
  const x = world({ opened: true, installed: false })
  await x.start()
  await x.advance(40_000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  expect(x.log).toContain('installedBinary')
  expect(x.log).not.toContain('ensureBinary')
  expect(x.log).not.toContain('startServer')
})

test('opened.json にあり、ファイルがあれば、チャットが始まると見張りを始める', async () => {
  const x = world({ opened: true, installed: true })
  await x.start()
  await x.advance(6000)
  expect(x.log).toContain('registerTools')
  expect(x.log).toContain('startServer')
  expect(x.log).toContain('removeOldVersions')
  expect(x.band()).toEqual({ kind: 'button', today: false })
  expect(x.log).not.toContain('ensureBinary')
})

test('押すとすぐ preparing になり、ボタンの処理は10秒以内に返る', async () => {
  const x = world()
  await x.start()
  const before = x.now()
  await x.nd.press(false)
  expect(x.now()).toBe(before)
  expect(x.band()).toEqual({ kind: 'preparing' })
  // ダウンロードは押した処理の外（裏の処理）で行う。
  expect(x.log).not.toContain('ensureBinary')
  await x.advance(1000)
  expect(x.log).toContain('ensureBinary')
})

test('押したあとのコマンドの順番は、保存フォルダー（700）→ opened.json → ダウンロード', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  const mkdir = x.log.indexOf(`run /bin/mkdir -p -m 700 ${STATE}`)
  const opened = x.log.findIndex(l => l.startsWith('run /bin/mv ') && l.endsWith(`${STATE}/opened.json`))
  const download = x.log.indexOf('ensureBinary')
  expect(mkdir).toBeGreaterThan(-1)
  expect(opened).toBeGreaterThan(mkdir)
  expect(download).toBeGreaterThan(opened)
  expect(Object.keys(x.json(`${STATE}/opened.json`))).toEqual([ROOT])
  // 書きかけのファイルは残らない。
  expect([...x.files.keys()].some(k => k.includes('.tmp-'))).toBe(false)
})

test('初めて押したチャットでも、押したあとにツールを登録する', async () => {
  const x = world()
  await x.start()
  expect(x.log).not.toContain('registerTools')
  await pressAndSend(x)
  expect(x.log.indexOf('registerTools')).toBeGreaterThan(x.log.indexOf('ensureBinary'))
  expect(x.log.filter(l => l === 'registerTools').length).toBe(1)
})

test('ほかのチャットで押されたら、30秒以内にこのチャットも見張りを始める', async () => {
  const x = world()
  await x.start()
  await x.advance(5000)
  expect(x.log).not.toContain('registerTools')
  // ほかのチャットが押して、ファイルも置いた。
  x.files.set(`${STATE}/opened.json`, JSON.stringify({ [ROOT]: { at: 2 } }))
  x.w.installed = true
  await x.advance(30_000)
  expect(x.log).toContain('registerTools')
  expect(x.log).toContain('startServer')
  expect(x.log).not.toContain('ensureBinary')
})

test('頼みが drop で返ったら、帯を problem に戻す', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  expect(x.band()).toEqual({ kind: 'opening' })
  x.prompts[0].resolve({ drop: '止められました' })
  await x.advance(0)
  expect(x.band()).toEqual({ kind: 'problem', text: 'Claudeに頼めませんでした（止められました）', button: true })
  // 頼めなかったので、ほかのチャットや画面が「開き直しています」と待たないよう、open-pending を0にする。
  expect(x.json(`${VDIR}/open-pending.json`)).toEqual({ until: 0 })
  // もう一度押せる。
  await pressAndSend(x)
  expect(x.prompts.length).toBe(2)
})

test('頼み直すときに鍵が読めなければ、頼まずに帯を案内に変える', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
  await x.advance(5000)
  x.setTicket('')
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now() }))
  await x.advance(1500)
  expect(x.prompts.length).toBe(1)
  expect(x.band()).toEqual({ kind: 'problem', text: 'エディターを開き直すには「ノートを開く」を押してください', button: true })
  expect(x.json(`${VDIR}/open-pending.json`)).toEqual({ until: 0 })
})

test('二度押しは、帯が button か problem に戻るまで受け付けない', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  await x.nd.press(false)
  await x.advance(2000)
  expect(x.prompts.length).toBe(1)
  expect(x.log.filter(l => l === 'ensureBinary').length).toBe(1)
})

test('毎回鍵付きで頼む（2回目も）', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  expect(x.prompts[0].text).toContain('#c=KEY1')
  expect(x.prompts[0].rest).toEqual({})
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
  await x.nd.turnComplete({ turnId: 't1' })
  await x.advance(0)
  x.setTicket('KEY2')
  await pressAndSend(x)
  expect(x.prompts.length).toBe(2)
  expect(x.prompts[1].text).toContain('#c=KEY2')
  expect(x.prompts[1].text).toContain('preview_start に http://localhost:8801 を渡して')
})

test('頼む前に open-pending.json を書き、取りかかったら期限を2分後に書き直す', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  const pending = `${VDIR}/open-pending.json`
  expect(x.log.lastIndexOf(`write ${pending}`)).toBeLessThan(x.log.indexOf('submit'))
  const sentAt = x.now()
  expect(x.json(pending).until).toBeGreaterThan(sentAt + 14 * MIN)
  expect(x.json(pending).until).toBeLessThanOrEqual(sentAt + 15 * MIN)
  await x.advance(20_000)
  const startedAt = x.now()
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.advance(0)
  expect(x.json(pending)).toEqual({ until: startedAt + 2 * MIN })
})

test('番が始まってから need-ticket が新しくなれば、鍵付きで1回だけ頼み直し、open-pending を0にする', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
  await x.advance(5000)
  x.setTicket('KEY9')
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now() }))
  await x.advance(1500)
  expect(x.prompts.length).toBe(2)
  expect(x.prompts[1].text).toBe('NoteDockが開けなかったので、navigate で http://localhost:8801/#c=KEY9 へ移ってください。ほかの作業はしないでください。')
  expect(x.json(`${VDIR}/open-pending.json`)).toEqual({ until: 0 })
  // 同じ窓の中で何度 need-ticket が来ても、もう頼まない。帯も案内に変えない。
  for (let i = 0; i < 3; i++) {
    x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now() }))
    await x.advance(3000)
  }
  expect(x.prompts.length).toBe(2)
  expect(x.band()?.kind).not.toBe('problem')
})

// 実機（Task 10 F1）：Claudeは preview_start で鍵の無い場所を読んでから、鍵付きの場所へ navigate する。
// 鍵の無い読み込み（hadKey: false）は開くのに失敗したのではないので、頼み直しに使わない。
test('番が始まってから hadKey: false の need-ticket が来ても頼み直さず、あとで hadKey: true が来たら1回だけ頼み直す', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
  await x.advance(2000)
  const pending = x.json(`${VDIR}/open-pending.json`)
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now(), hadKey: false }))
  await x.advance(3000)
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now(), hadKey: false }))
  await x.advance(3000)
  expect(x.prompts.length).toBe(1)
  expect(x.json(`${VDIR}/open-pending.json`)).toEqual(pending)
  expect(x.band()?.kind).not.toBe('problem')
  // 鍵を断られた知らせなら、頼み直しはまだ残っている。
  x.setTicket('KEY9')
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now(), hadKey: true }))
  await x.advance(1500)
  expect(x.prompts.length).toBe(2)
  expect(x.prompts[1].text).toContain('#c=KEY9')
  expect(x.json(`${VDIR}/open-pending.json`)).toEqual({ until: 0 })
})

test('頼んでいないときに hadKey: false の need-ticket が来ても、頼まず、帯も変えない', async () => {
  const x = world({ opened: true, installed: true, running: true })
  await x.start()
  await x.advance(6000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now(), hadKey: false }))
  await x.advance(2000)
  expect(x.prompts.length).toBe(0)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  // 頼み直しの窓が切れたあとでも同じ。
  await pressAndSend(x)
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
  await x.nd.turnComplete({ turnId: 't1', answer: '', reason: 'done' })
  await x.advance(3 * MIN)
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now(), hadKey: false }))
  await x.advance(2000)
  expect(x.prompts.length).toBe(1)
  expect(x.band()).toEqual({ kind: 'button', today: false })
})

test('頼んでいないときに hadKey: true の need-ticket が来たら、頼まず、帯を10分だけ案内に変える', async () => {
  const x = world({ opened: true, installed: true, running: true })
  await x.start()
  await x.advance(6000)
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now(), hadKey: true }))
  await x.advance(2000)
  expect(x.prompts.length).toBe(0)
  expect(x.band()).toEqual({ kind: 'problem', text: 'エディターを開き直すには「ノートを開く」を押してください', button: true })
})

// hadKey の無い need-ticket.json（前のサーバー）は、前と同じく「鍵を断られた」とみなす（下のテストや、上の頼み直しのテストはこの形）。
test('頼んでいないときに need-ticket が来ても、Claudeに頼まず、帯を10分だけ案内に変える', async () => {
  const x = world({ opened: true, installed: true, running: true })
  await x.start()
  await x.advance(6000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now() }))
  await x.advance(2000)
  expect(x.prompts.length).toBe(0)
  expect(x.band()).toEqual({ kind: 'problem', text: 'エディターを開き直すには「ノートを開く」を押してください', button: true })
  await x.advance(10 * MIN)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  expect(x.prompts.length).toBe(0)
})

test('Claudeの作業中に押して、番が始まるのが3分後でも、頼み直しは届く', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  await x.advance(3 * MIN)
  // まだ番は始まっていない。画面は「開き直しています…」のまま。
  expect(x.json(`${VDIR}/open-pending.json`).until).toBeGreaterThan(x.now())
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.advance(0)
  await x.advance(10_000)
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now() }))
  await x.advance(1500)
  expect(x.prompts.length).toBe(2)
  expect(x.prompts[1].text).toContain('#c=KEY1')
})

test('頼んだ番が終わると、帯は opening から button に戻る', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.nd.turnStart({ text: 'ほかの発言', turnId: 't0' })
  await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
  await x.nd.turnComplete({ turnId: 't0' })
  await x.advance(0)
  expect(x.band()).toEqual({ kind: 'opening' })
  await x.nd.turnComplete({ turnId: 't1' })
  await x.advance(0)
  expect(x.band()).toEqual({ kind: 'button', today: false })

  // 番が終わらなくても、15分たてば戻す。
  const y = world()
  await y.start()
  await pressAndSend(y)
  await y.advance(14 * MIN)
  expect(y.band()).toEqual({ kind: 'opening' })
  await y.advance(MIN + 1000)
  expect(y.band()).toEqual({ kind: 'button', today: false })
})

test('settings.json に periodic.root があるときだけ「今日のノート」を出す', async () => {
  const x = world({ opened: true, installed: true, running: true })
  await x.start()
  await x.advance(6000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  x.files.set(`${VDIR}/settings.json`, JSON.stringify({ periodic: { root: '90_Periodic' } }))
  await x.advance(10_000)
  expect(x.band()).toEqual({ kind: 'button', today: true })
  x.files.set(`${VDIR}/settings.json`, JSON.stringify({ unlisted: [] }))
  await x.advance(10_000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
})

test('/note が登録できなくても、帯と見張りは動く。/notedock で登録し直す', async () => {
  const x = world({ opened: true, installed: true, registerFails: ['note'] })
  await x.start()
  expect(x.log).toContain('command notedock')
  await x.advance(6000)
  expect(x.log).toContain('startServer')
  expect(x.band()).toEqual({ kind: 'button', today: false })

  const y = world({ registerFails: ['note', 'notedock'] })
  await y.start()
  await y.advance(1000)
  expect(y.band()?.kind).toBe('problem')
  expect(y.band()?.text).toContain('/note')
  expect(y.band()?.button).toBe(true)
})

test('/note の場所は、Windowsの区切りでも Vault の中の場所に直す', async () => {
  expect(notePathFrom('C:\\V\\notes\\daily\\a b.md', 'C:\\V\\notes', 'win32')).toBe('daily/a b.md')
  expect(notePathFrom('c:/v/NOTES/x.md', 'C:\\V\\notes', 'win32')).toBe('x.md')
  expect(notePathFrom('daily\\a.md', 'C:\\V\\notes', 'win32')).toBe('daily/a.md')
  expect(notePathFrom('"/V/notes/日記/1.md"', '/V/notes', 'darwin')).toBe('日記/1.md')
  expect(notePathFrom('Home.md', '/V/notes', 'darwin')).toBe('Home.md')
  expect(notePathFrom('', '/V/notes', 'darwin')).toBe('')

  const x = world({ opened: true, installed: true, running: true })
  await x.start()
  await x.advance(6000)
  const r = await x.nd.note('/V/notes/daily/a b.md')
  expect(r.text).toContain(`http://localhost:8801/?note=${encodeURIComponent('daily/a b.md')}#c=KEY1`)
  expect(r.text).toContain('Chrome')
  expect(x.log).toContain(`claimChat ${vaultDirOf({ os: 'darwin', home: HOME, stateDir: STATE, target: 'aarch64-apple-darwin', systemRoot: null }, VID)}`)
})

test('/note はサーバーが止まっていればボタンを案内し、画面のないチャットでは話し相手にならない', async () => {
  const x = world({ opened: true, installed: true, surfaces: [] })
  await x.start()
  await x.advance(12_000)
  const r = await x.nd.note('Home.md')
  expect(r.text).toContain('入力欄の上の『ノートを開く』を押してください')
  expect(r.text).not.toContain('#c=')
  expect(x.log.some(l => l.startsWith('claimChat'))).toBe(false)
  expect(x.log).not.toContain('startServer')
})

test('頼む文、opened.json、open-pending.json、$.store のどれにも合言葉が入らない。opened.json と open-pending.json には鍵も入らない', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.advance(0)
  expect(x.$.store).toBe(undefined) // 代役に $.store は無い。使えば落ちる。
  for (const p of x.prompts) expect(p.text).not.toContain(TOKEN)
  for (const f of [`${STATE}/opened.json`, `${VDIR}/open-pending.json`]) {
    expect(x.files.get(f)).not.toContain(TOKEN)
    expect(x.files.get(f)).not.toContain('KEY1')
  }
  expect(JSON.stringify(x.bands)).not.toContain(TOKEN)
  expect(JSON.stringify(x.bands)).not.toContain('KEY1')
  const r = await x.nd.note('')
  expect(r.text).not.toContain(TOKEN)
})

test('帯：このModの行だけを返し、今日のノートがあればボタンを2つ並べる', () => {
  const el = (tag: string) => (props: any) => ({ tag, props })
  const ui = { Box: el('Box'), Button: el('Button'), Markdown: el('Markdown') }
  const pressed: boolean[] = []
  const two: any = bandTree({ kind: 'button', today: true }, ui, today => pressed.push(today))
  expect(two.tag).toBe('Box')
  expect(two.props.key).toBe('notedock-row')
  expect(two.props.children.length).toBe(2)
  expect(JSON.stringify(two)).toContain('今日のノート')
  two.props.children[1].props.onPress()
  expect(pressed).toEqual([true])
  const one: any = bandTree({ kind: 'button', today: false }, ui, () => {})
  expect((JSON.stringify(one).match(/"tag":"Button"/g) ?? []).length).toBe(1)
  const busy: any = bandTree({ kind: 'opening' }, ui, () => {})
  expect(JSON.stringify(busy)).toContain('"dimColor":true')
  expect(JSON.stringify(busy)).not.toContain('"tag":"Button"')
  const problem: any = bandTree({ kind: 'problem', text: '理由', button: true }, ui, () => {})
  expect(JSON.stringify(problem)).toContain('理由')
  expect(JSON.stringify(problem)).toContain('ノートを開く')
})

// レビューの指摘（Task 7 review）で足したテスト

test('submit がすぐ返っても、turn.start が3分後なら、その時刻から数えて1回だけ頼み直す', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  // 作業中の番のうしろに並んだだけで、すぐ返った。
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.advance(3 * MIN)
  const started = x.now()
  await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
  await x.advance(0)
  expect(x.json(`${VDIR}/open-pending.json`)).toEqual({ until: started + 2 * MIN })
  await x.advance(10_000)
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now() }))
  await x.advance(1500)
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now() }))
  await x.advance(3000)
  expect(x.prompts.length).toBe(2)
  expect(x.prompts[1].text).toContain('#c=KEY1')
  expect(x.band()?.kind).not.toBe('problem')
})

test('包まれた文で turn.start が来ても、その頼みの番とみなす', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.nd.turnStart({ text: `The notedock plugin sent a message: ${x.prompts[0].text}`, turnId: 't1' })
  await x.nd.turnComplete({ turnId: 't1' })
  await x.advance(0)
  expect(x.band()).toEqual({ kind: 'button', today: false })
})

test('opening のあいだも見張りは続き、止まったサーバーを起動し直す', async () => {
  const x = world({ opened: true, installed: true, running: true })
  await x.start()
  await x.advance(6000)
  await pressAndSend(x)
  expect(x.band()).toEqual({ kind: 'opening' })
  const before = x.log.filter(l => l === 'startServer').length
  x.srv.running = false
  await x.advance(11_000)
  expect(x.log.filter(l => l === 'startServer').length).toBe(before + 1)
  expect(x.band()).toEqual({ kind: 'opening' })
})

test('押した処理と30秒ごとの見直しが重なっても、Vaultを調べられないとは出さない', async () => {
  // 押したことはあるがファイルが無いフォルダー。ほかのチャットがファイルを置いた直後に、このチャットでも押す。
  const x = world({ opened: true, installed: false, vaultDelayMs: 2000 })
  await x.start()
  await x.advance(29_200)
  x.w.installed = true
  await x.advance(500) // 30秒ごとの見直しが始まり、Vaultを調べている最中
  await pressAndSend(x)
  expect(x.prompts.length).toBe(1)
  expect(JSON.stringify(x.bands)).not.toContain('Vaultを調べられません')
  expect(x.log.filter(l => l === 'registerTools').length).toBe(1)
})

test('opening のあいだに出た案内は、開き終えたあと残りの時間だけ出す', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
  await x.advance(3 * MIN) // 頼み直しの窓（2分）を過ぎた
  x.files.set(`${VDIR}/need-ticket.json`, JSON.stringify({ at: x.now() }))
  await x.advance(1500)
  expect(x.band()).toEqual({ kind: 'opening' })
  await x.nd.turnComplete({ turnId: 't1' })
  await x.advance(0)
  expect(x.band()).toEqual({ kind: 'problem', text: 'エディターを開き直すには「ノートを開く」を押してください', button: true })
  await x.advance(10 * MIN)
  expect(x.band()).toEqual({ kind: 'button', today: false })
})

test('/note と /notedock の両方が登録できない理由は10分だけ出し、そのあとは今日のノートも出す', async () => {
  const x = world({ opened: true, installed: true, running: true, registerFails: ['note', 'notedock'] })
  x.files.set(`${VDIR}/settings.json`, JSON.stringify({ periodic: { root: 'P' } }))
  await x.start()
  await x.advance(6000)
  expect(x.band()?.kind).toBe('problem')
  await x.advance(10 * MIN)
  expect(x.band()).toEqual({ kind: 'button', today: true })
})

test('/note が別の名前で置き換わって返ったら、/notedock で登録し直す', async () => {
  const x = world({ registerAs: { note: 'other:note' } })
  await x.start()
  expect(x.log).toContain('command notedock')
  await x.advance(1000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
})

test('古い頼みの drop が遅れて来ても、新しく押した回の帯を変えない', async () => {
  const x = world()
  await x.start()
  await pressAndSend(x)
  await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
  await x.nd.turnComplete({ turnId: 't1' })
  await x.advance(0)
  await pressAndSend(x)
  expect(x.band()).toEqual({ kind: 'opening' })
  x.prompts[0].resolve({ drop: '古い理由' })
  await x.advance(0)
  expect(x.band()).toEqual({ kind: 'opening' })
  // 二度押しの守りも外れない。
  await x.nd.press(false)
  await x.advance(2000)
  expect(x.prompts.length).toBe(2)
})

test('読み込んだら、まず帯を null にする（前の帯を残さない）', async () => {
  const x = world({ root: HOME })
  await x.nd.sessionStart(x.io)
  expect(x.bands).toEqual([null])
})

test('押す前から動いていた見張りの古い答え（動いている）を使わず、押したあとに見直してから頼む', async () => {
  const x = world({ opened: true, installed: true, running: true })
  await x.start()
  await x.advance(6000)
  x.w.findDelayMs = 3000
  for (let i = 0; i < 20 && x.w.findsInFlight === 0; i++) await x.advance(500)
  expect(x.w.findsInFlight).toBe(1)
  x.srv.running = false // 見張りが見たあとで止まった
  await x.nd.press(false)
  await x.advance(1000)
  // 進行中の見張りを待っているあいだは「起動しています」。
  expect(x.w.findsInFlight).toBe(1)
  expect(x.band()).toEqual({ kind: 'starting' })
  for (let i = 0; i < 20 && x.prompts.length === 0; i++) await x.advance(500)
  expect(x.prompts.length).toBe(1)
  const started = x.log.lastIndexOf('startServer')
  expect(started).toBeGreaterThan(-1)
  expect(started).toBeLessThan(x.log.lastIndexOf('submit'))
})

test('同じModで session.start がもう一度来ても、画面があれば帯を描き直す', async () => {
  const x = world()
  await x.start()
  await x.advance(1000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  await x.nd.sessionStart(x.io)
  await x.advance(0)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  expect(x.bands.slice(-2)).toEqual([null, { kind: 'button', today: false }])
})

test('session.start で帯を描き直せなくても、/note の登録と裏の処理は続く', async () => {
  const x = world()
  await x.start()
  await x.advance(1000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  x.io.setBand = async () => {
    throw new Error('帯を書けません')
  }
  const before = x.log.filter(l => l === 'command note').length
  await x.nd.sessionStart(x.io)
  expect(x.log.filter(l => l === 'command note').length).toBe(before + 1)
})

// ---- ツール ----

test('2つのツールは isDeferred: true で登録する', async () => {
  const x = world({ opened: true, installed: true, realTools: true })
  await x.start()
  await x.advance(6000)
  expect(x.toolSpecs.map(s => s.name)).toEqual(['set_appearance', 'set_vault_settings'])
  for (const s of x.toolSpecs) expect(s.isDeferred).toBe(true)
  // 見張りも動いている（登録のあとに続く）。
  expect(x.log).toContain('startServer')
  // 登録したあとは、ツールの呼び出しに答える（見た目は保存フォルダーの appearance.json）。
  const r = await x.nd.useTool('appearance', { fontSize: 18 })
  expect(r.isError).toBeUndefined()
  expect(x.json(`${STATE}/appearance.json`)).toEqual({ fontSize: 18 })
})

test('押していないフォルダーと、画面のないチャットでは登録しない', async () => {
  const notPressed = world({ installed: true, running: true, realTools: true })
  await notPressed.start()
  await notPressed.advance(60_000)
  // /note でVaultを調べても、ツールは登録しない。
  await notPressed.nd.note('')
  await notPressed.advance(1000)
  expect(notPressed.toolSpecs).toEqual([])
  // 登録していないあいだに呼ばれても、何も書かずに案内を返す。
  const before = notPressed.log.filter(l => l.startsWith('write ')).length
  const r = await notPressed.nd.useTool('appearance', { fontSize: 18 })
  expect(r.isError).toBe(true)
  expect(r.result).toContain('ノートを開く')
  expect(notPressed.log.filter(l => l.startsWith('write ')).length).toBe(before)
  expect(notPressed.files.has(`${STATE}/appearance.json`)).toBe(false)

  const noScreen = world({ surfaces: [], opened: true, installed: true, running: true, realTools: true })
  await noScreen.start()
  await noScreen.advance(60_000)
  await noScreen.nd.note('')
  expect(noScreen.toolSpecs).toEqual([])
  expect((await noScreen.nd.useTool('vault', {})).isError).toBe(true)
})

test('初めて押したチャットでは、押したあとに本物の登録を1回だけ行う', async () => {
  const x = world({ realTools: true })
  await x.start()
  expect(x.toolSpecs).toEqual([])
  await pressAndSend(x)
  expect(x.toolSpecs.map(s => s.name)).toEqual(['set_appearance', 'set_vault_settings'])
})

test('ツールを登録できなくても、見張りは始まる', async () => {
  const x = world({ opened: true, installed: true, realTools: true })
  x.$.tool.register = async () => { throw new Error('登録できません') }
  await x.start()
  await x.advance(6000)
  expect(x.log).toContain('startServer')
  expect(x.band()).toEqual({ kind: 'button', today: false })
})

test('フックのつなぎ：2つのツールの呼び出しを、それぞれ nd に渡して結果を返す', async () => {
  const hooks: Record<string, (...a: any[]) => any> = {}
  const catches: Record<string, (...a: any[]) => any> = {}
  const on: any = (name: string, a: any, b?: any) => {
    const key = typeof a === 'function' ? name : `${name} ${JSON.stringify(a)}`
    hooks[key] = typeof a === 'function' ? a : b
    return { catch: (h: any) => { catches[key] = h } }
  }
  const calls: unknown[] = []
  const ios: any[] = []
  const nd: any = {
    useTool: async (which: string, input: unknown, callIo: unknown) => {
      calls.push([which, input])
      ios.push(callIo)
      return { result: `ok ${which}` }
    },
    toolActivity: () => {},
  }
  wire(on, nd)
  const a = await hooks['tool.call {"tool":"mcp__notedock__set_appearance"}']({}, { tool: 'mcp__notedock__set_appearance', fontSize: 16 }, async () => ({ deny: 'x' }))
  const v = await hooks['tool.call {"tool":"mcp__notedock__set_vault_settings"}']({}, { tool: 'mcp__notedock__set_vault_settings' }, async () => ({ deny: 'x' }))
  expect(a).toEqual({ result: 'ok appearance' })
  expect(v).toEqual({ result: 'ok vault' })
  expect(calls).toEqual([
    ['appearance', { tool: 'mcp__notedock__set_appearance', fontSize: 16 }],
    ['vault', { tool: 'mcp__notedock__set_vault_settings' }],
  ])
  // 呼び出しごとに、そのフックの $ から作った口を渡す。
  for (const callIo of ios) {
    expect(typeof callIo.fetch).toBe('function')
    expect(typeof callIo.move).toBe('function')
  }
  // 失敗や時間切れでも、理由を付けて答える。
  for (const key of ['tool.call {"tool":"mcp__notedock__set_appearance"}', 'tool.call {"tool":"mcp__notedock__set_vault_settings"}']) {
    const r = await catches[key]({}, {}, async () => ({}))
    expect(r.isError).toBe(true)
    expect(r.result).toContain('NoteDockのツールが答えを返せませんでした')
  }
})

test('ツールの登録が断られたら、理由を /note に添え、30秒ごとに登録し直す。全部登録できたら理由は消える', async () => {
  const x = world({ opened: true, installed: true, realTools: true })
  const attempts: string[] = []
  let refuse = true
  x.$.tool.register = async (spec: { name: string }) => {
    attempts.push(spec.name)
    if (refuse && spec.name === 'set_vault_settings') throw new Error('名前が重なっています')
    return { tool: `mcp__notedock__${spec.name}` }
  }
  await x.start()
  await x.advance(6000)
  expect(attempts).toEqual(['set_appearance', 'set_vault_settings'])
  // 見張りは始まっている。
  expect(x.log).toContain('startServer')
  const told = (await x.nd.note('')).text
  expect(told).toContain('set_vault_settings（名前が重なっています）')
  expect(told).toContain('#c=') // いつもの返事（リンク）も残る
  expect(told).not.toContain('set_appearance（')
  // 30秒たつと登録し直す。まだ断られれば、理由はそのまま。
  await x.advance(30_000)
  expect(attempts.length).toBe(4)
  expect((await x.nd.note('')).text).toContain('名前が重なっています')
  // 次は通る。理由は消え、そのあとは登録し直さない。
  refuse = false
  await x.advance(30_000)
  expect(attempts.length).toBe(6)
  expect((await x.nd.note('')).text).not.toContain('登録できませんでした')
  await x.advance(90_000)
  expect(attempts.length).toBe(6)
})

test('ツールの呼び出しは、渡された口（そのフックの $ から作ったもの）で読み書きする', async () => {
  const x = world({ opened: true, installed: true, realTools: true })
  await x.start()
  await x.advance(6000)
  const used: string[] = []
  const callIo = {
    ...x.io,
    read: async () => { throw new Error('ENOENT') },
    write: async (p: string) => { used.push(`write ${p}`) },
    move: async (_h: unknown, _from: string, to: string) => { used.push(`move ${to}`); return 0 },
  }
  const r = await x.nd.useTool('appearance', { fontSize: 18 }, callIo)
  expect(r.isError).toBeUndefined()
  expect(used[used.length - 1]).toBe(`move ${STATE}/appearance.json`)
  expect(x.files.has(`${STATE}/appearance.json`)).toBe(false)
})

// ---- 新しいバージョンのModが、古いバージョンのサーバーを入れ替える ----

const count = (x: ReturnType<typeof world>, prefix: string) => x.log.filter(l => l.startsWith(prefix)).length

test('動いているサーバーが古いバージョンなら、止め、すぐに古いバージョンのフォルダーを消し、止まってから自分のバージョンを起動する', async () => {
  const x = world({ opened: true, installed: true, running: true, serverVersion: OLD })
  await x.start()
  await x.advance(1000)
  expect(x.band()).toEqual({ kind: 'replacing' })
  expect(x.log).toContain(`requestShutdown ${MINE}`)
  // 止める指示が通ったら、止まるのを待たずに、古いバージョンのフォルダーを消す。
  expect(x.log.indexOf('removeOldVersions')).toBeGreaterThan(x.log.indexOf(`requestShutdown ${MINE}`))
  expect(x.log).not.toContain('stopped')
  expect(x.log).not.toContain('startServer')
  await x.advance(10_000)
  // 止まってから、自分のバージョンを起動する。
  expect(x.log.indexOf('startServer')).toBeGreaterThan(x.log.indexOf('stopped'))
  expect(x.srv.version).toBe(MINE)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  await x.advance(5 * MIN)
  expect(count(x, 'requestShutdown')).toBe(1)
  expect(count(x, 'startServer')).toBe(1)
})

test('バージョンの見出しのないサーバーは止めず、帯に10分だけ案内を出して、そのまま使う', async () => {
  const x = world({ opened: true, installed: true, running: true, serverVersion: null })
  await x.start()
  await x.advance(1000)
  expect(x.band()).toEqual({ kind: 'problem', text: '古い開発用のサーバーが動いています。このフォルダーのチャットをすべて閉じると入れ替わります', button: true })
  expect(count(x, 'requestShutdown')).toBe(0)
  // そのまま使う（/note のリンクは、そのサーバーを指す）。
  expect((await x.nd.note('')).text).toContain('http://localhost:8801/#c=KEY1')
  await x.advance(10 * MIN)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  await x.advance(10 * MIN)
  expect(x.band()).toEqual({ kind: 'button', today: false }) // 出すのは1回だけ
  expect(count(x, 'requestShutdown')).toBe(0)
  expect(count(x, 'startServer')).toBe(0)
  expect(count(x, 'removeOldVersions')).toBe(0)
})

test('動いているサーバーが同じか新しいバージョンなら、止めずにそのまま使い、自分のフォルダーも消さない', async () => {
  for (const v of [MINE, NEWER]) {
    const x = world({ opened: true, installed: true, running: true, serverVersion: v })
    await x.start()
    await x.advance(30_000)
    expect(count(x, 'requestShutdown')).toBe(0)
    expect(count(x, 'startServer')).toBe(0)
    expect(x.band()).toEqual({ kind: 'button', today: false })
    await pressAndSend(x)
    expect(x.prompts[0].text).toContain('http://localhost:8801')
    expect(count(x, 'requestShutdown')).toBe(0)
    // 新しいバージョンが動いているときは、何も消さない（自分のバージョンのフォルダーは、そのバージョンのチャットが使う）。
    // 同じバージョンが動いているときは、自分より古いものだけを消す（removeOldVersions は自分と新しいものを残す）。
    expect(count(x, 'removeOldVersions')).toBe(v === NEWER ? 0 : 1)
  }
})

test('refused なら1回で、failed・20秒たっても止まらないときは3回やり直してから、帯に理由を出し、そのサーバーを使い続け、もう入れ替えを試さない', async () => {
  const cases: [Opt, string, number][] = [
    [{ shutdown: 'refused' }, 'サーバーに断られました', 1],
    [{ shutdown: 'failed' }, '止める指示が届きませんでした', 3],
    [{ stopAfterMs: null }, '20秒たっても止まりませんでした', 3],
  ]
  for (const [opt, why, tries] of cases) {
    const x = world({ opened: true, installed: true, running: true, serverVersion: OLD, ...opt })
    await x.start()
    if (opt.stopAfterMs === null) {
      await x.advance(15_000)
      expect(x.band()).toEqual({ kind: 'replacing' })
    }
    await x.advance(tries === 1 ? 30_000 : 4 * MIN)
    const b = x.band()
    expect(b?.kind).toBe('problem')
    expect(b?.text).toContain(why)
    expect(b?.text).toContain(tries === 1 ? 'そのまま使っています' : 'アプリを終了して、開き直してください')
    expect(b?.button).toBe(true)
    expect(count(x, 'requestShutdown')).toBe(tries)
    expect(count(x, 'startServer')).toBe(0)
    expect(x.srv.version).toBe(OLD)
    // そのサーバーを使い続ける。
    expect((await x.nd.note('')).text).toContain('http://localhost:8801/#c=KEY1')
    await pressAndSend(x)
    expect(x.prompts[0].text).toContain('http://localhost:8801')
    x.prompts[0].resolve({ text: x.prompts[0].text })
    await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
    await x.nd.turnComplete({ turnId: 't1' })
    // refused の帯は10分で消える。failed・timeout の帯は、このチャットのあいだ出し続ける。
    await x.advance(10 * MIN)
    if (tries === 1) expect(x.band()).toEqual({ kind: 'button', today: false })
    else expect(x.band()?.text).toContain('アプリを終了して、開き直してください')
    await x.advance(10 * MIN)
    expect(count(x, 'requestShutdown')).toBe(tries)
    expect(count(x, 'startServer')).toBe(0)
  }
})

test('入れ替えに3回失敗した帯（アプリを終了して、開き直してください）は、10分を過ぎても出し続ける', async () => {
  const x = world({ opened: true, installed: true, running: true, serverVersion: OLD, stopAfterMs: null })
  await x.start()
  await x.advance(4 * MIN)
  const failed = {
    kind: 'problem',
    text: '古いバージョンのサーバーを入れ替えられませんでした。アプリを終了して、開き直してください（20秒たっても止まりませんでした）',
    button: true,
  }
  expect(x.band()).toEqual(failed)
  await x.advance(11 * MIN)
  expect(x.band()).toEqual(failed)
  await x.advance(60 * MIN)
  expect(x.band()).toEqual(failed)
  expect(count(x, 'requestShutdown')).toBe(3)
})

test('failed（refused 以外）を受けたら、帯に「アプリを終了して、開き直してください」と出す', async () => {
  const x = world({ opened: true, installed: true, running: true, serverVersion: OLD, shutdown: 'failed' })
  await x.start()
  // やり直しのあいだは、帯に失敗を出さない（そのサーバーを使う）。
  await x.advance(MIN)
  expect(count(x, 'requestShutdown')).toBe(2)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  // 3回目も失敗したら、1回だけ出す。
  await x.advance(2 * MIN)
  expect(count(x, 'requestShutdown')).toBe(3)
  expect(x.band()).toEqual({
    kind: 'problem',
    text: '古いバージョンのサーバーを入れ替えられませんでした。アプリを終了して、開き直してください（止める指示が届きませんでした）',
    button: true,
  })
  // refused のときは、いまの文のまま。
  const y = world({ opened: true, installed: true, running: true, serverVersion: OLD, shutdown: 'refused' })
  await y.start()
  await y.advance(6000)
  expect(y.band()).toEqual({
    kind: 'problem',
    text: '古いバージョンのサーバーを入れ替えられなかったので、そのまま使っています（サーバーに断られました）',
    button: true,
  })
})

test('押したことのないフォルダーのチャットや、自分のバージョンのファイルがないチャットは、入れ替えない', async () => {
  const notPressed = world({ installed: true, running: true, serverVersion: OLD })
  await notPressed.start()
  await notPressed.advance(60_000)
  expect(count(notPressed, 'requestShutdown')).toBe(0)
  expect(notPressed.band()).toEqual({ kind: 'button', today: false })

  const noFile = world({ opened: true, installed: false, running: true, serverVersion: OLD })
  await noFile.start()
  await noFile.advance(60_000)
  expect(count(noFile, 'requestShutdown')).toBe(0)
  expect(noFile.log).not.toContain('ensureBinary')
  expect(noFile.band()).toEqual({ kind: 'button', today: false })
})

test('古いバージョンのModは、自分のファイルが残っていても、handover.json が新しいバージョンを指し10分たっていないあいだは、起動し直しもダウンロードもしない', async () => {
  // このチャットのModは OLD。新しいバージョン（MINE）のModが、サーバーを止めたところ。
  const x = world({ mine: OLD, opened: true, installed: true, running: false })
  const handedAt = x.now()
  x.files.set(`${VDIR}/handover.json`, JSON.stringify({ to: MINE, at: handedAt }))
  await x.start()
  await x.advance(30_000)
  expect(count(x, 'startServer')).toBe(0)
  expect(x.band()).toEqual({ kind: 'replacing' })
  // 押しても、ダウンロードも起動もしない。
  await x.nd.press(false)
  await x.advance(3000)
  expect(x.log).not.toContain('ensureBinary')
  expect(count(x, 'startServer')).toBe(0)
  // 新しいバージョンのサーバーが動き出したら、それを使う。
  x.srv.running = true
  x.srv.version = MINE
  x.setTicket('KEY1')
  for (let i = 0; i < 20 && x.prompts.length === 0; i++) await x.advance(500)
  expect(x.prompts.length).toBe(1)
  expect(x.prompts[0].text).toContain('http://localhost:8801')
  expect(count(x, 'requestShutdown')).toBe(0) // 新しいバージョンは止めない
  x.prompts[0].resolve({ text: x.prompts[0].text })
  await x.nd.turnStart({ text: x.prompts[0].text, turnId: 't1' })
  await x.nd.turnComplete({ turnId: 't1' })
  // 新しいサーバーが止まっても、10分たつまでは起動し直さない。
  x.srv.running = false
  await x.advance(handedAt + 9 * MIN - x.now())
  expect(count(x, 'startServer')).toBe(0)
  // 10分たったら、いつもどおり起動し直す（使う人が古いバージョンに戻した場合のため）。
  await x.advance(2 * MIN)
  expect(count(x, 'startServer')).toBe(1)
  expect(x.log).not.toContain('ensureBinary')
})

test('古いバージョンのModは、自分のファイルがなく新しいバージョンのフォルダーがあるとき、帯で新しいチャットを案内する', async () => {
  const guide = { kind: 'problem', text: '新しいバージョンのNoteDockが入っています。新しいチャットを開いてください', button: false }
  // チャットが始まったあとで、新しいバージョンのModがフォルダーを置き、自分のファイルが無い状態になった。
  // 押したことはあるが、まだ自分のファイルの無いフォルダー。
  const x = world({ mine: OLD, opened: true, installed: false })
  await x.start()
  await x.advance(1000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  x.w.superseded = true
  // 押されても、ダウンロードせずに案内する。
  await x.nd.press(false)
  await x.advance(3000)
  expect(x.log).not.toContain('ensureBinary')
  expect(x.band()).toEqual(guide)
  // 押したことのないフォルダーでも同じ（押すと古いバージョンをダウンロードしてしまうため）。
  const y = world({ mine: OLD })
  await y.start()
  await y.advance(1000)
  y.w.superseded = true
  await y.nd.press(false)
  await y.advance(3000)
  expect(y.log).not.toContain('ensureBinary')
  expect(y.band()).toEqual(guide)

  // 見張りの途中で、自分のファイルが消された（新しいバージョンが片づけた）ときも、起動せずに案内する。
  const z = world({ mine: OLD, opened: true, installed: true, running: true })
  await z.start()
  await z.advance(6000)
  z.w.superseded = true
  z.srv.running = false
  await z.advance(10_000)
  expect(count(z, 'startServer')).toBe(0)
  expect(z.band()).toEqual(guide)
  // 新しいバージョンのサーバーが動き出したら、それを使う。
  z.srv.running = true
  z.srv.version = MINE
  await z.advance(6000)
  expect(z.band()).toEqual({ kind: 'button', today: false })
})

test('pid が変わっても古いバージョンが答え続けるなら、入れ替えは失敗とする', async () => {
  const x = world({ opened: true, installed: true, running: true, serverVersion: OLD, stopAfterMs: null })
  await x.start()
  await x.advance(2000)
  expect(x.band()).toEqual({ kind: 'replacing' })
  // 古いバージョンのModが、古いバージョンを起動し直した（pid だけが変わる）。
  x.srv.pid = 999
  x.setTicket('KEY1')
  await x.advance(5000)
  expect(x.band()).toEqual({ kind: 'replacing' })
  expect(count(x, 'startServer')).toBe(0)
  await x.advance(20_000)
  // 1回目の失敗。帯は出さず、30秒後と、その120秒後にやり直す。
  expect(x.band()).toEqual({ kind: 'button', today: false })
  await x.advance(4 * MIN)
  expect(x.band()?.kind).toBe('problem')
  expect(x.band()?.text).toContain('20秒たっても止まりませんでした')
  expect(count(x, 'startServer')).toBe(0)
  expect(count(x, 'requestShutdown')).toBe(3)
})

test('入れ替えに失敗したあと、ほかのチャットが入れ替えた新しいサーバーを見つけたら、失敗の帯を消してそれを使う', async () => {
  const x = world({ opened: true, installed: true, running: true, serverVersion: OLD, shutdown: 'refused' })
  await x.start()
  await x.advance(6000)
  expect(x.band()?.kind).toBe('problem')
  // ほかのチャット（同じバージョンのMod）が入れ替えた。
  x.srv.version = MINE
  x.srv.pid = 500
  x.setTicket('KEY2')
  await x.advance(6000)
  expect(x.band()).toEqual({ kind: 'button', today: false })
  expect((await x.nd.note('')).text).toContain('#c=KEY2')
  expect(count(x, 'requestShutdown')).toBe(1)
  expect(count(x, 'startServer')).toBe(0)
  // 自分のバージョンが動いているのを確かめたので、古いバージョンのフォルダーを消す。
  expect(count(x, 'removeOldVersions')).toBe(1)
})

test('Windowsで古いバージョンのフォルダーを消せなかったら、あとでもう一度消す', async () => {
  // 止めたばかりの古いサーバーがまだファイルを使っていると、Windowsでは消せない（removeOldVersions が false を返す）。
  const x = world({ opened: true, installed: true, running: true, serverVersion: OLD, removeFails: 2 })
  await x.start()
  await x.advance(1000)
  expect(count(x, 'removeOldVersions')).toBe(1)
  await x.advance(30_000)
  expect(count(x, 'removeOldVersions')).toBe(3) // 消せるまで消し直す
  await x.advance(5 * MIN)
  expect(count(x, 'removeOldVersions')).toBe(3) // 消せたら、もう消さない

  // 止まらず、自分のバージョンも動かないときは、10秒おきに2分まで消し直す。
  const y = world({ opened: true, installed: true, running: true, serverVersion: OLD, stopAfterMs: null, removeFails: 1000 })
  await y.start()
  await y.advance(1000)
  expect(count(y, 'removeOldVersions')).toBe(1)
  await y.advance(10_000)
  expect(count(y, 'removeOldVersions')).toBe(2)
  // 止める指示を送り直しても（20秒待って止まらなければ、30秒後と、その120秒後）、10秒おきに消し直すのは最初の2分だけ。
  await y.advance(6 * MIN)
  expect(count(y, 'requestShutdown')).toBe(3)
  const n = count(y, 'removeOldVersions')
  expect(n).toBeGreaterThanOrEqual(12)
  expect(n).toBeLessThanOrEqual(14)
  await y.advance(5 * MIN)
  expect(count(y, 'removeOldVersions')).toBe(n)
})

test('チャットが始まったときから、自分のファイルが無く新しいバージョンのフォルダーがあるなら、案内を出さず、押せばダウンロードして起動する', async () => {
  // 新しいバージョンを入れたあとで、古いバージョンのModに戻した。または、作業場所の開発用のMod（0.1.0-dev は 0.1.0 より古い）。
  // 始まったチャットには、入れてあるModが読み込まれるので、このチャットのModを使うのが本人の選択とみなす。
  const newer = '新しいバージョンのNoteDockが入っています'
  for (const opened of [true, false]) {
    const x = world({ mine: OLD, opened, installed: false, superseded: true })
    await x.start()
    await x.advance(1000)
    expect(x.band()).toEqual({ kind: 'button', today: false })
    await pressAndSend(x)
    expect(x.log).toContain('ensureBinary')
    expect(count(x, 'startServer')).toBe(1)
    expect(x.prompts.length).toBe(1)
    // 見張りの途中でサーバーが止まっても、案内せずに起動し直す。
    x.srv.running = false
    await x.advance(6000)
    expect(count(x, 'startServer')).toBe(2)
    expect(JSON.stringify(x.bands)).not.toContain(newer)
    expect((await x.nd.note('')).text).not.toContain(newer)
  }
})

test('自分のバージョンのサーバーが動いているときに古いバージョンのフォルダーを消せなければ、10秒おきに2分まで、そのあとは10分おきに消し直す', async () => {
  // 別のVaultの古いサーバーがまだファイルを使っていると、Windowsでは消せないままになる。5秒ごとに消し直さない。
  const x = world({ opened: true, installed: true, running: true, serverVersion: MINE, removeFails: 100_000 })
  await x.start()
  await x.advance(1000)
  expect(count(x, 'removeOldVersions')).toBe(1)
  await x.advance(10_000)
  expect(count(x, 'removeOldVersions')).toBe(2)
  await x.advance(2 * MIN)
  const n = count(x, 'removeOldVersions')
  expect(n).toBeGreaterThanOrEqual(12)
  expect(n).toBeLessThanOrEqual(14)
  // 2分を過ぎたら10分おき。
  await x.advance(5 * MIN)
  expect(count(x, 'removeOldVersions')).toBeLessThanOrEqual(n + 1)
  await x.advance(55 * MIN)
  const m = count(x, 'removeOldVersions')
  expect(m).toBeGreaterThanOrEqual(n + 5)
  expect(m).toBeLessThanOrEqual(n + 7)
  // 消せたら、もう消さない。
  x.w.removeFails = 0
  await x.advance(10 * MIN)
  const done = count(x, 'removeOldVersions')
  await x.advance(60 * MIN)
  expect(count(x, 'removeOldVersions')).toBe(done)
})
