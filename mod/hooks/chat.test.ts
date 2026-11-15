import { expect, test } from 'claude-code/testing'

import { chatFile, describeNote, hideKeys, quoteForPrompt, TYPED_ORIGINS } from './chat'
import { createNotedock, ioFor, wire } from './register'
import { VERSION } from './release'

// チャット欄の試験用の代役の `$`。時計は仮想で、advance で進めたぶんだけタイマーが動く。
// 話し相手の印・送る・返事・会話の記録・ノートを添える処理は、本物の関数を代役の $ で動かす。
const MIN = 60_000

type Opt = {
  win?: boolean
  vid?: string
  root?: string // $.session.root() が返す場所
  real?: Record<string, string> // シンボリックリンクの先
  surfaces?: string[]
  serverRan?: boolean // Vault別フォルダーがある（サーバーが一度動いた）
  files?: Map<string, string> // 2つのチャットで同じファイルを見るとき
  session?: string
}

function world(o: Opt = {}) {
  const win = !!o.win
  const HOME = win ? 'C:\\Users\\u' : '/Users/u'
  const STATE = win ? 'C:\\Users\\u\\AppData\\Local\\NoteDock' : `${HOME}/Library/Application Support/NoteDock`
  const ROOT = o.root ?? (win ? 'C:\\Users\\u\\Notes' : '/V/notes')
  const real = o.real ?? {}
  const CANON = real[ROOT] ?? ROOT
  const VID = o.vid ?? '0123456789abcdef'
  const sep = win ? '\\' : '/'
  const VDIR = [STATE, 'vaults', VID].join(sep)
  const f = (name: string) => `${VDIR}${sep}${name}`
  const KEY = win ? CANON.toLowerCase() : CANON

  let t = 1_000_000
  const files = o.files ?? new Map<string, string>()
  const dirs = new Set<string>([ROOT, CANON, HOME])
  if (o.serverRan !== false) dirs.add(VDIR)
  const sends: { text: string; rest: Record<string, unknown>; resolve: (r: any) => void; reject: (e: any) => void }[] = []
  const fills: { text: string; mode?: string }[] = []
  const timers: { at: number; ms: number; fn: () => void; repeat: boolean; dead: boolean }[] = []
  const w = { surfaces: o.surfaces ?? ['desktop'], messages: [] as any[], onMessages: null as null | (() => void), afterRead: null as null | ((p: string) => void) }
  const openedFile = [STATE, 'opened.json'].join(sep)
  files.set(openedFile, JSON.stringify({ ...JSON.parse(files.get(openedFile) ?? '{}'), [KEY]: { at: 1 } }))

  const add = (ms: number, fn: () => void, repeat: boolean) => {
    const x = { at: t + ms, ms, fn, repeat, dead: false }
    timers.push(x)
    return { cancel: () => { x.dead = true } }
  }
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

  const env: Record<string, string> = win
    ? { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: HOME, SystemRoot: 'C:\\Windows' }
    : { HOME }
  const $: any = {
    env: { get: async (n: string) => env[n] },
    session: {
      root: async () => ROOT,
      surfaces: async () => w.surfaces,
      id: async () => o.session ?? 'sess-1',
      messages: async () => {
        w.onMessages?.()
        return w.messages
      },
    },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error('ENOENT')
        const v = files.get(p)!
        w.afterRead?.(p) // 読んだ直後に、ほかのチャットが書き換えた場合を作る
        return v
      },
      write: async (p: string, s: string) => {
        files.set(p, s)
      },
      exists: async (p: string) => files.has(p) || dirs.has(p),
      stat: async (p: string) => {
        if (dirs.has(p) || files.has(p)) return { realPath: real[p] ?? p, size: 0, mtimeMs: 0 }
        throw new Error('ENOENT')
      },
      list: async () => [],
    },
    process: {
      run: async (argv: string[]) => ({ exitCode: 0, stdout: argv[0] === '/usr/sbin/sysctl' ? '1\n' : '', stderr: '' }),
      spawn: () => {
        throw new Error('テストでは起動しない')
      },
    },
    clock: {
      now: async () => t,
      after: (ms: number, fn: () => void) => add(ms, fn, false),
      every: (ms: number, fn: () => void) => add(ms, fn, true),
      sleep: async () => {},
    },
    command: { register: async (spec: { name: string }) => ({ command: spec.name }) },
    prompt: {
      submit: ({ text, ...rest }: { text: string }) =>
        new Promise((resolve, reject) => sends.push({ text, rest, resolve, reject })),
      fill: async (e: { text: string; mode?: string }) => {
        fills.push(e)
        return { isFilled: true }
      },
    },
  }

  const running = { port: 8801, vaultId: VID, ticket: 'KEY1', version: VERSION, pid: 1 }
  const io = ioFor($, {
    installedBinary: async () => 'BIN',
    ensureBinary: async () => ({ bin: 'BIN' }),
    removeOldVersions: async () => {},
    vaultIdOf: async () => VID,
    findRunning: async () => running,
    startServer: async () => ({ running }),
    readServerInfo: async () => null,
    setBand: async () => {},
    registerTools: async () => {},
  })
  const nd = createNotedock()
  const json = (name: string) => (files.has(f(name)) ? JSON.parse(files.get(f(name))!) : null)

  return {
    $, nd, io, files, dirs, sends, fills, w, advance, f, json, VDIR, ROOT,
    now: () => t,
    // 始めて、見張りとチャット欄の見回りが動くところまで進める。
    start: async () => {
      await nd.sessionStart(io)
      await advance(3000)
    },
    say: (text: string, kind = 'composer') => nd.promptSubmit({ text, origin: { kind } }),
    editor: (state: Record<string, unknown>) => files.set(f('current-note.json'), JSON.stringify(state)),
    owner: () => json('chat-owner.json'),
  }
}

// ---- 今のModの register.test.ts から写したテスト（チャット欄・ノートを添える） ----

test('開いているノートを次の発言に添える', async () => {
  const x = world()
  await x.start()
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  x.editor({ path: 'Home.md', dirty: true, selection: '選択', updatedAt: x.now() - 100 })
  const note = await x.say('こんにちは')
  expect(note).toContain('Home.md')
  expect(note).toContain('選択')
  expect(note).toContain('まだ保存していない変更')
})

test('別のフォルダーのノートは場所も添える', async () => {
  const x = world()
  await x.start()
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  x.editor({ path: 'Home.md', root: '/tmp/copy', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toContain('/tmp/copy/Home.md')
})

test('今のプロジェクトのノートは相対パスのまま添える', async () => {
  const x = world()
  await x.start()
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  x.editor({ path: 'Home.md', root: '/V/notes', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toContain('ノート: Home.md')
})

test('閉じたノートは添えない', async () => {
  const x = world()
  await x.start()
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  x.editor({ path: null, updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toBe(null)
})

test('古い情報は添えない', async () => {
  const x = world()
  await x.start()
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  x.editor({ path: 'Home.md', updatedAt: x.now() - 31 * MIN })
  expect(await x.say('こんにちは')).toBe(null)
})

test('入力欄へ入れる文字と、発言に添える選択の文字に上限を付ける', () => {
  expect(quoteForPrompt('x'.repeat(5000)).length).toBeLessThan(4100)
  expect(quoteForPrompt('a\nb')).toBe('> a\n> b\n')
  const note = describeNote({ path: 'a.md', selection: 'y'.repeat(5000), updatedAt: 900 }, 1000, '/V/notes', 'darwin')
  expect((note ?? '').length).toBeLessThan(4100)
})

test('シンボリックリンクの先が同じなら、今のプロジェクトのノートとして添える', async () => {
  const x = world({ root: '/link/notes', real: { '/link/notes': '/real/notes' } })
  await x.start()
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  x.editor({ path: 'Home.md', root: '/real/notes', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toContain('ノート: Home.md')
})

// ---- 送る・返事・会話の記録・引用（今のModの449〜529行・599〜644行と同じ動き） ----

test('話し相手は、エディターから送られた文を本人の発言として送り、その番の返事を chat-reply.json に書く', async () => {
  const x = world()
  await x.start()
  await x.say('はじめ')
  x.editor({ path: 'a.md', updatedAt: x.now(), sendChat: { text: '表を足して', at: x.now() } })
  const sentAt = x.now()
  await x.advance(1500)
  expect(x.sends.length).toBe(1)
  expect(x.sends[0].text).toBe('表を足して')
  expect(x.sends[0].rest).toEqual({ asUser: true })
  x.sends[0].resolve({})
  await x.nd.turnStart({ text: '表を足して', turnId: 'c1' })
  await x.nd.turnComplete({ turnId: 'c1', answer: '足しました。', reason: 'done' })
  const reply = x.json('chat-reply.json')
  expect(reply.for).toBe(sentAt)
  expect(reply.text).toBe('足しました。')
  expect(reply.reason).toBe('done')
  // 同じ文はもう送らない。
  await x.advance(3000)
  expect(x.sends.length).toBe(1)
})

// 実機（Task 10 F4）：Modが自分で送る文には、Mod自身の prompt.submit フックが呼ばれない（呼んだプラグインのフックは通らない）。
// そこで、切り替えがオンなら、開いているノートの案内を送る文の末尾に足す。
test('切り替えがオンなら、エディターから送る文の末尾に、開いているノートの案内を足す', async () => {
  const x = world()
  await x.start()
  await x.say('はじめ')
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  const sentAt = x.now()
  x.editor({ path: 'Home.md', updatedAt: x.now(), sendChat: { text: '表を足して', at: sentAt } })
  await x.advance(1500)
  expect(x.sends.length).toBe(1)
  expect(x.sends[0].text).toBe('表を足して\n\n（エディターで開いているノート: Home.md）')
  expect(x.sends[0].rest).toEqual({ asUser: true })
  // 足した文のまま番が始まっても、その番の返事をエディターへ渡す。
  x.sends[0].resolve({})
  await x.nd.turnStart({ text: x.sends[0].text, turnId: 'c1' })
  await x.nd.turnComplete({ turnId: 'c1', answer: 'Home.mdです。', reason: 'done' })
  expect(x.json('chat-reply.json').for).toBe(sentAt)
  expect(x.json('chat-reply.json').text).toBe('Home.mdです。')
})

test('足す案内には、保存していない変更と選んでいる文字も入れ、選んだ文字には上限を付ける', async () => {
  const x = world()
  await x.start()
  await x.say('はじめ')
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  x.editor({ path: 'Home.md', dirty: true, selection: '一行目\n二行目', updatedAt: x.now(), sendChat: { text: 'ここを直して', at: x.now() } })
  await x.advance(1500)
  expect(x.sends[0].text).toBe('ここを直して\n\n（エディターで開いているノート: Home.md。まだ保存していない変更があります）\n選んでいる文字:\n> 一行目\n> 二行目')
  x.editor({ path: 'Home.md', selection: 'y'.repeat(9000), updatedAt: x.now(), sendChat: { text: 'z'.repeat(9000), at: x.now() + 1 } })
  await x.advance(1500)
  const long = x.sends[1].text
  expect(long.startsWith(`${'z'.repeat(4000)}\n\n（エディターで開いているノート: Home.md）`)).toBe(true)
  expect(long.length).toBeLessThan(8100) // 送る文4000字＋選んだ文字4000字＋案内の行
  expect((long.match(/y/g) ?? []).length).toBe(4000)
})

test('切り替えがオフ、またはノートが閉じている・古いときは、送る文をそのまま送る', async () => {
  const x = world()
  await x.start()
  await x.say('はじめ')
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: false }))
  x.editor({ path: 'Home.md', updatedAt: x.now(), sendChat: { text: 'オフ', at: x.now() } })
  await x.advance(1500)
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  x.editor({ path: null, updatedAt: x.now(), sendChat: { text: '閉じた', at: x.now() + 1 } })
  await x.advance(1500)
  x.editor({ path: 'Home.md', updatedAt: x.now() - 31 * MIN, sendChat: { text: '古い', at: x.now() + 2 } })
  await x.advance(1500)
  expect(x.sends.map(s => s.text)).toEqual(['オフ', '閉じた', '古い'])
})

test('案内を足して送ったあとにModを読み込み直しても、その番の返事をエディターへ渡す', async () => {
  const x = world()
  await x.start()
  await x.say('はじめ')
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  const sentAt = x.now()
  x.editor({ path: 'Home.md', updatedAt: x.now(), sendChat: { text: '表を足して', at: sentAt } })
  await x.advance(1500)
  const text = x.sends[0].text
  // 読み込み直すと、送った文の目印は消える。エディターが書いた送る文（案内なし）と照らし合わせる。
  const again = createNotedock()
  await again.sessionStart(x.io)
  await x.advance(3000)
  expect(x.sends.length).toBe(1)
  await again.turnStart({ text, turnId: 'c2' })
  await again.turnComplete({ turnId: 'c2', answer: '足しました。', reason: 'done' })
  expect(x.json('chat-reply.json').for).toBe(sentAt)
  // 案内の付いていない、似た別の文の番は、その返事にしない。
  const y = world()
  await y.start()
  await y.say('はじめ')
  y.editor({ path: 'Home.md', updatedAt: y.now(), sendChat: { text: '表を', at: y.now() } })
  await y.advance(1500)
  const later = createNotedock()
  await later.sessionStart(y.io)
  await y.advance(3000)
  await later.turnStart({ text: '表を足して', turnId: 'c3' })
  await later.turnComplete({ turnId: 'c3', answer: '別の返事', reason: 'done' })
  expect(y.json('chat-reply.json')).toBe(null)
})

test('送る文に案内を足しても、prompt.submit のフックで同じ案内をもう一度足さない', async () => {
  const x = world()
  await x.start()
  await x.say('はじめ')
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  x.editor({ path: 'Home.md', updatedAt: x.now(), sendChat: { text: '表を足して', at: x.now() } })
  await x.advance(1500)
  expect(await x.nd.promptSubmit({ text: x.sends[0].text, origin: { kind: 'plugin' } })).toBe(null)
  // 本人が打った文には、今までどおり添える。
  expect(await x.say('別の質問')).toBe('エディターで開いているノート: Home.md')
})

test('送った文が drop されたら、送れなかったことを chat-reply.json に書く', async () => {
  const x = world()
  await x.start()
  await x.say('はじめ')
  const at = x.now()
  x.editor({ sendChat: { text: 'こんにちは', at } })
  await x.advance(1500)
  x.sends[0].resolve({ drop: '止められました' })
  await x.advance(0)
  expect(x.json('chat-reply.json')).toEqual({ for: at, text: 'チャットへ送れませんでした。（止められました）', failed: true, at: x.now() })
})

test('引用を入れるのは話し相手だけ。読み込んだときに残っていた古い頼みは使わない', async () => {
  const x = world()
  x.editor({ askChat: { text: '古い', at: 5 } })
  await x.start()
  await x.say('はじめ')
  await x.advance(1500)
  expect(x.fills.length).toBe(0)
  x.editor({ askChat: { text: '一行目\n二行目', at: x.now() } })
  await x.advance(1500)
  expect(x.fills).toEqual([{ text: '> 一行目\n> 二行目\n', mode: 'insert' }])
})

test('話し相手は会話の記録を chat-log.json に書き、10秒ごとに印の時刻を書き直す', async () => {
  const x = world()
  await x.start()
  x.w.messages = [
    { role: 'user', text: '<system-reminder>見せない</system-reminder>表を足して' },
    { role: 'assistant', text: '足しました。' },
  ]
  await x.say('表を足して')
  const claimed = x.owner().at
  await x.advance(3000)
  const log = x.json('chat-log.json')
  expect(log.project).toBe('notes')
  expect(log.items).toEqual([
    { kind: 'user', text: '表を足して' },
    { kind: 'assistant', text: '足しました。' },
  ])
  expect(log.working).toBe(0)
  await x.advance(11_000)
  expect(x.owner().session).toBe('sess-1')
  expect(x.owner().at).toBeGreaterThan(claimed)
  expect(x.now() - x.owner().at).toBeLessThanOrEqual(11_000)
})

test('Vault別フォルダーがない（サーバーが一度も動いていない）あいだは、チャット欄のファイルを書かない', async () => {
  const x = world({ serverRan: false })
  await x.start()
  await x.say('こんにちは')
  await x.nd.note('')
  await x.advance(15_000)
  expect([...x.files.keys()].filter(k => k.startsWith(x.VDIR))).toEqual([])
})

// ---- このタスクで足したテスト ----

test('チャットが始まっただけでは相手にならない（前の相手がいなくても）', async () => {
  const x = world()
  await x.start()
  await x.advance(60_000)
  expect(x.owner()).toBe(null)

  // 前の相手の印が古くなっていても、引き継がない。
  const y = world()
  y.files.set(y.f('chat-owner.json'), JSON.stringify({ session: 'old', at: 1 }))
  await y.start()
  await y.advance(60_000)
  expect(y.owner()).toEqual({ session: 'old', at: 1 })
})

test('本人が発言すると相手になる。task-notification では相手にならない', async () => {
  expect([...TYPED_ORIGINS].sort()).toEqual(['bridge', 'composer', 'sdk'])
  const x = world()
  await x.start()
  await x.say('通知', 'task-notification')
  await x.say('定期', 'scheduled-trigger')
  expect(x.owner()).toBe(null)
  await x.say('こんにちは', 'composer')
  expect(x.owner()).toEqual({ session: 'sess-1', at: x.now(), since: x.now() })
})

test('準備が終わる前に本人が発言しても、準備が終わったら相手になる（印には発言した時刻を残す）', async () => {
  const x = world()
  await x.nd.sessionStart(x.io)
  const said = x.now()
  expect(await x.say('こんにちは')).toBe(null) // 準備中なのでノートは添えられない
  expect(x.owner()).toBe(null)
  await x.advance(3000)
  expect(x.owner().session).toBe('sess-1')
  expect(x.owner().since).toBe(said)

  // 準備中に来たのが本人の発言でなければ、相手にならない。
  const y = world()
  await y.nd.sessionStart(y.io)
  await y.say('通知', 'task-notification')
  await y.advance(3000)
  expect(y.owner()).toBe(null)
})

test('準備中に発言したあと、ほかのチャットで本人が発言していたら、準備が終わっても相手を取らない', async () => {
  const files = new Map<string, string>()
  const b = world({ files, session: 'sess-b' })
  await b.start()
  const a = world({ files, session: 'sess-a' })
  await a.nd.sessionStart(a.io)
  await a.say('Aで先に話す')
  await b.advance(1000)
  await b.say('Bであとから話す')
  await a.advance(3000)
  expect(a.owner().session).toBe('sess-b')

  // 前の相手が外れていた、または前の相手の発言がこちらより前なら、相手になる。
  const files2 = new Map<string, string>()
  const c = world({ files: files2, session: 'sess-c' })
  c.files.set(c.f('chat-owner.json'), JSON.stringify({ session: 'old', at: c.now() + 50_000, since: c.now() - 1 }))
  await c.nd.sessionStart(c.io)
  await c.say('こんにちは')
  await c.advance(3000)
  expect(c.owner().session).toBe('sess-c')
})

test('サーバーがまだ一度も動いていないチャットで発言しても、あとで動いたら相手になる', async () => {
  const x = world({ serverRan: false })
  await x.nd.sessionStart(x.io)
  await x.say('こんにちは')
  await x.advance(15_000)
  expect(x.owner()).toBe(null)
  x.dirs.add(x.VDIR) // 押して、サーバーが動き、Vault別フォルダーができた
  await x.advance(3000)
  expect(x.owner()?.session).toBe('sess-1')
})

test('画面のないチャットと分かったら、準備中の発言は忘れる（あとで画面に出しても相手を取らない）', async () => {
  const x = world({ surfaces: [] })
  await x.nd.sessionStart(x.io)
  await x.say('こんにちは')
  await x.advance(12_000)
  x.w.surfaces = ['desktop']
  await x.nd.attach()
  await x.advance(3000)
  expect(x.owner()).toBe(null)
})

test('準備中の発言：前の版の印（since なし）、外れた印、印なしなら相手になる', async () => {
  for (const before of [
    { session: 'old-mod', at: 9_999_999_999 }, // 前の版のModが10秒ごとに書き直している印
    { session: '', at: 0 }, // 外れた印
    null,
  ]) {
    const x = world()
    if (before) x.files.set(x.f('chat-owner.json'), JSON.stringify(before))
    await x.nd.sessionStart(x.io)
    await x.say('こんにちは')
    await x.advance(3000)
    expect(x.owner()?.session).toBe('sess-1')
  }
})

test('準備中の発言：チャットの番号がまだ分からなければ、覚えたまま次の見回りでやり直す', async () => {
  const x = world({ session: '' })
  await x.nd.sessionStart(x.io)
  await x.say('こんにちは')
  await x.advance(3000)
  expect(x.owner()).toBe(null)
  x.$.session.id = async () => 'sess-1'
  await x.advance(3000)
  expect(x.owner()?.session).toBe('sess-1')
})

test('準備中の発言：session.start より先に届いても、覚えて、準備が終わったら相手になる', async () => {
  const x = world()
  expect(await x.say('こんにちは')).toBe(null)
  await x.nd.sessionStart(x.io)
  await x.advance(3000)
  expect(x.owner()?.session).toBe('sess-1')
})

test('準備中の発言で相手になったあと、ほかのチャットへ移った相手を、あとから取り返さない', async () => {
  const files = new Map<string, string>()
  const a = world({ files, session: 'sess-a' })
  await a.nd.sessionStart(a.io)
  await a.say('準備中に話す')
  await a.advance(3000)
  await a.say('準備のあとに話す')
  expect(a.owner().session).toBe('sess-a')
  const b = world({ files, session: 'sess-b' })
  await b.start()
  await b.advance(60_000)
  await b.say('Bで話す')
  await a.advance(15_000)
  expect(a.owner().session).toBe('sess-b')
})

test('印の時刻を書き直しても、相手になった時刻（since）は変えない', async () => {
  const x = world()
  await x.start()
  await x.say('こんにちは')
  const since = x.owner().since
  await x.advance(25_000)
  expect(x.owner().at).toBeGreaterThan(since)
  expect(x.owner().since).toBe(since)
})

test('/note を打つと相手になる。画面のないチャットではならない', async () => {
  const x = world()
  await x.start()
  await x.nd.note('')
  expect(x.owner()?.session).toBe('sess-1')

  const y = world({ surfaces: [] })
  await y.start()
  await y.advance(12_000)
  await y.nd.note('')
  await y.say('こんにちは')
  expect(y.owner()).toBe(null)
})

test('相手でないチャットは、エディターから送られた文を送らない', async () => {
  const x = world()
  await x.start()
  x.files.set(x.f('chat-owner.json'), JSON.stringify({ session: 'other', at: x.now() }))
  x.editor({ sendChat: { text: 'こんにちは', at: x.now() }, askChat: { text: '引用', at: x.now() } })
  await x.advance(3000)
  expect(x.sends.length).toBe(0)
  expect(x.fills.length).toBe(0)
  expect(x.json('chat-log.json')).toBe(null)
  expect(x.owner().session).toBe('other')
})

test('別のVaultのチャットは、このVaultの chat-owner.json に触らない', async () => {
  const files = new Map<string, string>()
  const a = world({ files, vid: 'aaaaaaaaaaaaaaaa', root: '/V/a', session: 'sess-a' })
  const b = world({ files, vid: 'bbbbbbbbbbbbbbbb', root: '/V/b', session: 'sess-b' })
  await a.start()
  await b.start()
  await a.say('Aで話す')
  const ownerA = files.get(a.f('chat-owner.json'))
  await b.say('Bで話す')
  await b.nd.note('')
  await b.advance(15_000)
  expect(files.get(a.f('chat-owner.json'))).toBe(ownerA)
  expect(b.owner()?.session).toBe('sess-b')
  await b.nd.sessionEnd('other')
  expect(files.get(a.f('chat-owner.json'))).toBe(ownerA)
})

test('share-note.json がなければ、ノートを添えない', async () => {
  const x = world()
  await x.start()
  x.editor({ path: 'Home.md', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toBe(null)
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: false }))
  expect(await x.say('こんにちは')).toBe(null)
})

test('share-note.json が on: true なら、ノートを添える', async () => {
  const x = world()
  await x.start()
  x.editor({ path: 'Home.md', updatedAt: x.now() - 100 })
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  expect(await x.say('こんにちは')).toBe('エディターで開いているノート: Home.md')
  // 画面のないチャットでは添えない。
  const y = world({ surfaces: [] })
  await y.start()
  await y.advance(12_000)
  y.editor({ path: 'Home.md', updatedAt: y.now() - 100 })
  y.files.set(y.f('share-note.json'), JSON.stringify({ on: true }))
  expect(await y.say('こんにちは')).toBe(null)
})

test('チャットが終わると相手を外す。/clear では外さない', async () => {
  const x = world()
  await x.start()
  await x.say('こんにちは')
  await x.nd.sessionEnd('clear')
  expect(x.owner().session).toBe('sess-1')
  await x.nd.sessionEnd('other')
  expect(x.owner()).toEqual({ session: '', at: 0 })

  // ほかのチャットが相手なら、終わっても書き換えない。
  const y = world()
  await y.start()
  y.files.set(y.f('chat-owner.json'), JSON.stringify({ session: 'other', at: y.now() }))
  await y.nd.sessionEnd('other')
  expect(y.owner().session).toBe('other')
})

test('Windowsの場所でも、別のフォルダーのノートを見分け、project はフォルダーの名前だけ', async () => {
  expect(describeNote({ path: 'Home.md', root: 'c:/users/u/NOTES', updatedAt: 900 }, 1000, 'C:\\Users\\u\\Notes', 'win32')).toBe('エディターで開いているノート: Home.md')
  expect(describeNote({ path: 'sub/Home.md', root: 'C:\\Users\\u\\Other', updatedAt: 900 }, 1000, 'C:\\Users\\u\\Notes', 'win32')).toBe(
    'エディターで開いているノート: C:\\Users\\u\\Other\\sub\\Home.md',
  )
  // Macでは大文字と小文字を区別する。
  expect(describeNote({ path: 'Home.md', root: '/v/NOTES', updatedAt: 900 }, 1000, '/v/notes', 'darwin')).toBe('エディターで開いているノート: /v/NOTES/Home.md')

  const x = world({ win: true })
  await x.start()
  x.files.set(x.f('share-note.json'), JSON.stringify({ on: true }))
  x.editor({ path: 'Home.md', root: 'C:\\Users\\u\\Other', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toContain('C:\\Users\\u\\Other\\Home.md')
  x.editor({ path: 'Home.md', root: 'c:\\users\\u\\notes', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toBe('エディターで開いているノート: Home.md')
  await x.advance(3000)
  expect(x.owner().session).toBe('sess-1')
  expect(x.json('chat-log.json').project).toBe('Notes')
})


// ---- レビュー指摘の修正（Fix round 1） ----

test('会話の記録に、エディターを開く鍵（#c=）を書かない', async () => {
  const x = world()
  await x.start()
  x.w.messages = [
    { role: 'user', text: 'The notedock plugin sent a message: navigate で http://localhost:8801/?chat=1#c=SECRETKEY123 へ移ってください。' },
    { role: 'assistant', text: '[開く](http://localhost:8801/#c=KEY2) と "http://localhost:8801/#c=KEY3" と <http://localhost:8801/#c=KEY4>' },
  ]
  await x.say('こんにちは')
  await x.advance(3000)
  const log = x.files.get(x.f('chat-log.json'))!
  expect(log).toBeDefined()
  expect(log).not.toContain('#c=')
  for (const key of ['SECRETKEY123', 'KEY2', 'KEY3', 'KEY4']) expect(log).not.toContain(key)
  expect(log).toContain('http://localhost:8801/?chat=1')
})

test('送る直前に話し相手でなくなっていたら、送らない', async () => {
  const x = world()
  await x.start()
  await x.say('はじめ')
  x.editor({ sendChat: { text: 'こんにちは', at: x.now() } })
  // 見回りの途中（会話を読むとき）に、ほかのチャットが印を移した。
  x.w.onMessages = () => x.files.set(x.f('chat-owner.json'), JSON.stringify({ session: 'other', at: x.now() }))
  await x.advance(1500)
  expect(x.sends.length).toBe(0)
  expect(x.owner().session).toBe('other')
})

test('印を書き直す直前に、ほかのチャットへ移っていたら、上書きしない', async () => {
  const x = world()
  await x.start()
  const ownerFile = x.f('chat-owner.json')
  x.files.set(ownerFile, JSON.stringify({ session: 'sess-1', at: x.now() - 20_000 }))
  let moved = false
  x.w.afterRead = p => {
    if (p === ownerFile && !moved) {
      moved = true
      x.files.set(ownerFile, JSON.stringify({ session: 'other', at: x.now() }))
    }
  }
  await x.advance(1500)
  expect(x.owner().session).toBe('other')
})

test('自分の印が古くなっていれば（スリープ明けなど）、見回りで書き直す。ほかのチャットの古い印は引き継がない', async () => {
  const x = world()
  await x.start()
  x.files.set(x.f('chat-owner.json'), JSON.stringify({ session: 'sess-1', at: 1 }))
  await x.advance(1500)
  expect(x.owner().session).toBe('sess-1')
  expect(x.now() - x.owner().at).toBeLessThanOrEqual(1500)

  const y = world()
  await y.start()
  y.files.set(y.f('chat-owner.json'), JSON.stringify({ session: 'other', at: 1 }))
  await y.advance(15_000)
  expect(y.owner()).toEqual({ session: 'other', at: 1 })
})

test('送るのに失敗したら（例外）、送れなかったことを chat-reply.json に書く', async () => {
  const x = world()
  await x.start()
  await x.say('はじめ')
  const at = x.now()
  x.editor({ sendChat: { text: 'こんにちは', at } })
  await x.advance(1500)
  x.sends[0].reject(new Error('切れました'))
  await x.advance(0)
  expect(x.json('chat-reply.json')).toEqual({ for: at, text: 'チャットへ送れませんでした。（切れました）', failed: true, at: x.now() })
})

test('画面なしで始まり、session.attach なしで画面が付いたチャットでも、/note のあとは見回りが動く', async () => {
  const x = world({ surfaces: [] })
  await x.start()
  await x.advance(12_000)
  x.w.surfaces = ['desktop']
  await x.nd.note('')
  expect(x.owner()?.session).toBe('sess-1')
  await x.advance(3000)
  x.editor({ sendChat: { text: 'こんにちは', at: x.now() } })
  await x.advance(1500)
  expect(x.sends.map(s => s.text)).toEqual(['こんにちは'])
})

test('Windowsでは、別のフォルダーの場所の / も \\ にそろえてつなぐ。ファイルの場所はOSを渡して作る', () => {
  expect(describeNote({ path: 'sub/Home.md', root: 'C:/Users/u/Other', updatedAt: 900 }, 1000, 'C:\\Users\\u\\Notes', 'win32')).toBe(
    'エディターで開いているノート: C:\\Users\\u\\Other\\sub\\Home.md',
  )
  expect(chatFile('win32', 'C:\\S\\vaults\\v', 'chat-owner.json')).toBe('C:\\S\\vaults\\v\\chat-owner.json')
  expect(chatFile('darwin', '/S/vaults/v', 'chat-owner.json')).toBe('/S/vaults/v/chat-owner.json')
})

test('フックのつなぎ：prompt.submit で添える文を context に足し、session.end に reason を渡す', async () => {
  const hooks: Record<string, (...a: any[]) => any> = {}
  const on: any = (name: string, a: any, b?: any) => {
    hooks[name] = typeof a === 'function' ? a : b
    return { catch: () => {} }
  }
  const ends: unknown[] = []
  const nd: any = {
    promptSubmit: async () => 'エディターで開いているノート: Home.md',
    sessionEnd: async (reason: unknown) => { ends.push(reason) },
    toolActivity: () => {},
  }
  wire(on, nd)
  const next = async (e: unknown) => e
  const out: any = await hooks['prompt.submit']({}, { text: 'こんにちは', origin: { kind: 'composer' }, context: ['前から'] }, next)
  expect(out.context).toEqual(['前から', 'エディターで開いているノート: Home.md'])
  nd.promptSubmit = async () => null
  const same: any = await hooks['prompt.submit']({}, { text: 'x', context: ['前から'] }, next)
  expect(same.context).toEqual(['前から'])
  await hooks['session.end']({}, { reason: 'clear' }, next)
  await hooks['session.end']({}, { reason: 'logout' }, next)
  expect(ends).toEqual(['clear', 'logout'])
})

test('鍵を消すとき、鍵のすぐあとに続く文は残す', () => {
  // 鍵は base64url（A-Z a-z 0-9 _ -）だけでできている。そのほかの文字が来たら、そこで鍵は終わる。
  expect(hideKeys('http://localhost:8801/#c=AbC-_9xyzです。次へ')).toBe('http://localhost:8801/です。次へ')
  expect(hideKeys('[開く](http://localhost:8801/#c=KEY2)を押す')).toBe('[開く](http://localhost:8801/)を押す')
  expect(hideKeys('a #c=K1、b #c=K2。')).toBe('a 、b 。')
  expect(hideKeys('鍵なし')).toBe('鍵なし')
})
