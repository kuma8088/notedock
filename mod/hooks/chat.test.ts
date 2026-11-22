import { expect, test } from 'claude-code/testing'

import { chatFile, describeNote, hideKeys, isSentText, lineMention, lineRefsIn, linkDir, MENTION_HEAD, mentionBlock, mentionsForSend, quoteForPrompt, safeVaultPath, titleFrom, TYPED_ORIGINS } from './chat'
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
  state?: Map<string, unknown> // $.state（Modを読み込み直しても残る）。同じチャットの読み込み直しを作るときに渡す
  serverVersion?: string // 動いているサーバーのバージョン（既定はこのModと同じ）
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
  const w = { surfaces: o.surfaces ?? ['desktop'], messages: [] as any[], onMessages: null as null | (() => void), afterRead: null as null | ((p: string) => void), onWrite: null as null | ((p: string) => Promise<void>) }
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
  const state = o.state ?? new Map<string, unknown>()
  const debugLines: string[] = []
  const $: any = {
    ui: { log: (text: string, opt?: { to?: string }) => { if (opt?.to === 'debug') debugLines.push(text) } },
    state: {
      get: async (ref: { key: string }) => ({ value: state.get(ref.key), version: 0 }),
      set: async (ref: { key: string }, value: unknown) => {
        state.set(ref.key, value)
        return { isSet: true, version: 1 }
      },
    },
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
        const hook = w.onWrite
        if (hook) await hook(p)
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

  const running = { port: 8801, vaultId: VID, ticket: 'KEY1', version: o.serverVersion ?? VERSION, pid: 1 }
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
  // このチャットの結び付けのフォルダー（link.json があるところ）。まだ無ければ null。
  const myLink = (): string | null => {
    const head = `${VDIR}${sep}chats${sep}`
    const found = [...files.keys()].filter(k => k.startsWith(head) && k.endsWith(`${sep}link.json`))
    const mine = found.find(k => k.slice(head.length).split(sep)[0] === mineHash.value)
    return mine ? mine.slice(0, -`${sep}link.json`.length) : null
  }
  const mineHash = { value: '' }
  const inLink = (name: string) => {
    const dir = myLink()
    return dir ? `${dir}${sep}${name}` : ''
  }
  const json = (name: string) => {
    const p = inLink(name)
    return p && files.has(p) ? JSON.parse(files.get(p)!) : null
  }

  return {
    $, nd, io, files, dirs, sends, fills, w, advance, f, json, VDIR, ROOT, state, sep, debugLines,
    now: () => t,
    // 始めて、見張りとチャット欄の見回りが動くところまで進める。
    start: async () => {
      await nd.sessionStart(io)
      await advance(3000)
    },
    // エディターを開く（/note）。このチャットの番号が作られ、結び付けのフォルダーができる。返すのは /note の返事。
    open: async () => {
      const r = await nd.note('')
      const raw = /[#&]s=([A-Za-z0-9_-]{43})/.exec(r.text)?.[1] ?? ''
      mineHash.value = String(state.get('chatLink') ?? '')
      return { ...r, raw }
    },
    linkDir: myLink,
    inLink,
    say: (text: string, kind = 'composer') => nd.promptSubmit({ text, origin: { kind } }),
    // このチャットに結び付いたエディターが書く状態（サーバーが state.json に書く）。
    editor: (st: Record<string, unknown>) => files.set(inLink('state.json'), JSON.stringify(st)),
    share: (on: boolean) => files.set(inLink('share.json'), JSON.stringify({ on })),
    link: () => json('link.json'),
  }
}

// ---- 開いているノートを添える（このチャットに結び付いたエディターの状態だけ） ----

// 開いて、結び付けのフォルダーと切り替えを用意したところまで進める。
async function opened(o: Opt = {}) {
  const x = world(o)
  await x.start()
  const r = await x.open()
  expect(r.raw).toMatch(/^[A-Za-z0-9_-]{43}$/)
  return x
}

test('開いているノートを次の発言に添える', async () => {
  const x = await opened()
  x.share(true)
  x.editor({ path: 'Home.md', dirty: true, selection: '選択', updatedAt: x.now() - 100 })
  const note = await x.say('こんにちは')
  expect(note).toContain('Home.md')
  expect(note).toContain('選択')
  expect(note).toContain('まだ保存していない変更')
})

test('別のフォルダーのノートは場所も添える。今のプロジェクトのノートは相対パスのまま', async () => {
  const x = await opened()
  x.share(true)
  x.editor({ path: 'Home.md', root: '/tmp/copy', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toContain('/tmp/copy/Home.md')
  x.editor({ path: 'Home.md', root: '/V/notes', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toContain('ノート: Home.md')
})

test('閉じたノートと古い情報は添えない', async () => {
  const x = await opened()
  x.share(true)
  x.editor({ path: null, updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toBe(null)
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
  const x = await opened({ root: '/link/notes', real: { '/link/notes': '/real/notes' } })
  x.share(true)
  x.editor({ path: 'Home.md', root: '/real/notes', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toContain('ノート: Home.md')
})

test('切り替えが無い・オフなら添えない。オンなら添える', async () => {
  const x = await opened()
  x.editor({ path: 'Home.md', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toBe(null)
  x.share(false)
  expect(await x.say('こんにちは')).toBe(null)
  x.share(true)
  expect(await x.say('こんにちは')).toBe('エディターで開いているノート: Home.md')
})

test('本人が打った発言にだけ添える。別のセッションからのメッセージ・タスクの知らせ・定期の起動・Modの文には添えない', async () => {
  expect([...TYPED_ORIGINS].sort()).toEqual(['bridge', 'composer', 'sdk'])
  const x = await opened()
  x.share(true)
  x.editor({ path: 'Home.md', updatedAt: x.now() - 100 })
  for (const kind of ['task-notification', 'scheduled-trigger', 'plugin', 'session-message', 'teammate', '']) {
    expect(await x.nd.promptSubmit({ text: '知らせ', origin: { kind } })).toBe(null)
  }
  expect(await x.nd.promptSubmit({ text: '知らせ' })).toBe(null)
  expect(await x.say('こんにちは')).toBe('エディターで開いているノート: Home.md')
})

test('エディターを開いていない（番号が無い）チャットには、ほかのチャットのエディターのノートを添えない', async () => {
  const files = new Map<string, string>()
  const a = world({ files })
  await a.start()
  await a.open()
  a.share(true)
  a.editor({ path: 'A.md', updatedAt: a.now() - 100 })
  // 同じフォルダーの、エディターを開いていない別のチャット。
  const b = world({ files })
  await b.start()
  expect(await b.say('こんにちは')).toBe(null)
  expect(await a.say('こんにちは')).toBe('エディターで開いているノート: A.md')
})

// ---- 送る・返事・会話の記録・引用 ----

test('結び付いたエディターから送られた文を本人の発言として送り、その番の返事を reply.json に書く', async () => {
  const x = await opened()
  x.editor({ path: 'a.md', updatedAt: x.now(), sendChat: { text: '表を足して', at: x.now() } })
  const sentAt = x.now()
  await x.advance(1500)
  expect(x.sends.length).toBe(1)
  expect(x.sends[0].text).toBe('表を足して')
  expect(x.sends[0].rest).toEqual({ asUser: true })
  x.sends[0].resolve({})
  await x.nd.turnStart({ text: '表を足して', turnId: 'c1' })
  await x.nd.turnComplete({ turnId: 'c1', answer: '足しました。', reason: 'done' })
  const reply = x.json('reply.json')
  expect(reply.for).toBe(sentAt)
  expect(reply.text).toBe('足しました。')
  expect(reply.reason).toBe('done')
  await x.advance(3000)
  expect(x.sends.length).toBe(1)
})

test('切り替えがオンなら、エディターから送る文の末尾に、開いているノートの案内を足す', async () => {
  const x = await opened()
  x.share(true)
  const sentAt = x.now()
  x.editor({ path: 'Home.md', updatedAt: x.now(), sendChat: { text: '表を足して', at: sentAt } })
  await x.advance(1500)
  expect(x.sends[0].text).toBe('表を足して\n\n（エディターで開いているノート: Home.md）')
  x.sends[0].resolve({})
  await x.nd.turnStart({ text: x.sends[0].text, turnId: 'c1' })
  await x.nd.turnComplete({ turnId: 'c1', answer: 'Home.mdです。', reason: 'done' })
  expect(x.json('reply.json').for).toBe(sentAt)
})

test('足す案内には、保存していない変更と選んでいる文字も入れ、選んだ文字には上限を付ける', async () => {
  const x = await opened()
  x.share(true)
  x.editor({ path: 'Home.md', dirty: true, selection: '一行目\n二行目', updatedAt: x.now(), sendChat: { text: 'ここを直して', at: x.now() } })
  await x.advance(1500)
  expect(x.sends[0].text).toBe('ここを直して\n\n（エディターで開いているノート: Home.md。まだ保存していない変更があります）\n選んでいる文字:\n> 一行目\n> 二行目')
  x.editor({ path: 'Home.md', selection: 'y'.repeat(9000), updatedAt: x.now(), sendChat: { text: 'z'.repeat(9000), at: x.now() + 1 } })
  await x.advance(1500)
  const long = x.sends[1].text
  expect(long.startsWith(`${'z'.repeat(4000)}\n\n（エディターで開いているノート: Home.md）`)).toBe(true)
  expect(long.length).toBeLessThan(8100)
  expect((long.match(/y/g) ?? []).length).toBe(4000)
})

test('切り替えがオフ、またはノートが閉じている・古いときは、送る文をそのまま送る', async () => {
  const x = await opened()
  x.share(false)
  x.editor({ path: 'Home.md', updatedAt: x.now(), sendChat: { text: 'オフ', at: x.now() } })
  await x.advance(1500)
  x.share(true)
  x.editor({ path: null, updatedAt: x.now(), sendChat: { text: '閉じた', at: x.now() + 1 } })
  await x.advance(1500)
  x.editor({ path: 'Home.md', updatedAt: x.now() - 31 * MIN, sendChat: { text: '古い', at: x.now() + 2 } })
  await x.advance(1500)
  expect(x.sends.map(s => s.text)).toEqual(['オフ', '閉じた', '古い'])
})

test('Modを読み込み直しても、$.state から番号を戻し、同じエディターとやり取りを続ける（返事も渡す）', async () => {
  const x = await opened()
  x.share(true)
  const sentAt = x.now()
  x.editor({ path: 'Home.md', updatedAt: x.now(), sendChat: { text: '表を足して', at: sentAt } })
  await x.advance(1500)
  const text = x.sends[0].text
  const dir = x.linkDir()
  // 読み込み直した Mod（前の Mod の見回りは止まる）。同じファイルと同じ $.state を見る。
  const y = world({ files: x.files, state: x.state })
  await y.start()
  expect(y.sends.length).toBe(0) // 送り済みの文は送り直さない
  await y.nd.turnStart({ text, turnId: 'c2' })
  await y.nd.turnComplete({ turnId: 'c2', answer: '足しました。', reason: 'done' })
  expect(x.json('reply.json').for).toBe(sentAt)
  // 読み込み直したあとの /note も、同じ番号のリンクを出す。
  const r = await y.open()
  expect(r.raw).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(y.linkDir()).toBe(dir)
  y.editor({ updatedAt: y.now(), sendChat: { text: '次', at: y.now() + 5 } })
  await y.advance(1500)
  expect(y.sends.map(s => s.text)).toEqual(['次'])
})

test('送る文に案内を足しても、prompt.submit のフックで同じ案内をもう一度足さない', async () => {
  const x = await opened()
  x.share(true)
  x.editor({ path: 'Home.md', updatedAt: x.now(), sendChat: { text: '表を足して', at: x.now() } })
  await x.advance(1500)
  expect(await x.nd.promptSubmit({ text: x.sends[0].text, origin: { kind: 'composer' } })).toBe(null)
  expect(await x.say('別の質問')).toBe('エディターで開いているノート: Home.md')
})

test('送った文が drop されたら、または例外なら、送れなかったことを reply.json に書く', async () => {
  const x = await opened()
  const at = x.now()
  x.editor({ sendChat: { text: 'こんにちは', at } })
  await x.advance(1500)
  x.sends[0].resolve({ drop: '止められました' })
  await x.advance(0)
  expect(x.json('reply.json')).toEqual({ for: at, text: 'チャットへ送れませんでした。（止められました）', failed: true, at: x.now() })
  const at2 = x.now()
  x.editor({ sendChat: { text: 'もう一度', at: at2 } })
  await x.advance(1500)
  x.sends[1].reject(new Error('切れました'))
  await x.advance(0)
  expect(x.json('reply.json')).toEqual({ for: at2, text: 'チャットへ送れませんでした。（切れました）', failed: true, at: x.now() })
})

test('引用を入れる。開いたときに残っていた古い頼みは使わない', async () => {
  const x = await opened()
  x.editor({ askChat: { text: '一行目\n二行目', at: x.now() } })
  await x.advance(1500)
  expect(x.fills).toEqual([{ text: '> 一行目\n> 二行目\n', mode: 'insert' }])
  // 読み込み直したあと、残っていた頼みはもう済んだものとみなす。
  const again = createNotedock()
  await again.sessionStart(x.io)
  await x.advance(3000)
  expect(x.fills.length).toBe(1)
})

test('会話の記録を log.json に書き、10秒ごとに link.json の時刻を書き直す。名前は最初の本人の発言から付ける', async () => {
  const x = await opened()
  x.w.messages = [
    { role: 'user', text: 'The notedock plugin sent a message: NoteDockを開いてください。ブラウザパネルで、preview_start に http://localhost:8801 を渡して開き…' },
    { role: 'user', text: '<system-reminder>見せない</system-reminder>表を足して' },
    { role: 'assistant', text: '足しました。' },
  ]
  await x.say('表を足して')
  const first = x.link().at
  await x.advance(3000)
  const log = x.json('log.json')
  expect(log.project).toBe('notes')
  expect(log.title).toBe('notes ·「表を足して」')
  expect(log.items.slice(-2)).toEqual([
    { kind: 'user', text: '表を足して' },
    { kind: 'assistant', text: '足しました。' },
  ])
  expect(log.working).toBe(0)
  await x.advance(11_000)
  expect(x.link().at).toBeGreaterThan(first)
  expect(x.now() - x.link().at).toBeLessThanOrEqual(11_000)
  expect(x.link().title).toBe('notes ·「表を足して」')
  expect(titleFrom([], 'notes')).toBe('notes')
  expect(titleFrom([{ kind: 'user', text: 'NoteDockの使い方' }], 'p')).toBe('p ·「NoteDockの使い方」')
  expect(titleFrom([{ kind: 'user', text: 'あ'.repeat(30) }], 'p')).toBe(`p ·「${'あ'.repeat(24)}…」`)
})

test('Vault別フォルダーがない（サーバーが一度も動いていない）あいだは、チャット欄のファイルを書かない', async () => {
  const x = world({ serverRan: false })
  await x.start()
  await x.say('こんにちは')
  await x.nd.note('')
  await x.advance(15_000)
  expect([...x.files.keys()].filter(k => k.startsWith(x.VDIR))).toEqual([])
})

// ---- 結び付け（エディターを開いた会話ごと） ----

test('エディターを開くまでは、どのエディターとも結び付かない（発言しても、前の版の印が残っていても）', async () => {
  const x = world()
  x.files.set(x.f('current-note.json'), JSON.stringify({ sendChat: { text: '前の版の送る文', at: 2_000_000 }, askChat: { text: '引用', at: 2_000_000 } }))
  x.files.set(x.f('chat-owner.json'), JSON.stringify({ session: 'sess-1', at: 2_000_000 }))
  await x.start()
  await x.say('こんにちは')
  await x.advance(60_000)
  expect(x.sends.length).toBe(0)
  expect(x.fills.length).toBe(0)
  expect([...x.files.keys()].some(k => k.includes(`${x.sep}chats${x.sep}`))).toBe(false)
})

test('/note で結び付けのフォルダーを作り、リンクには一度だけの合図を s= で付ける。合図そのものはどのファイルにも書かない', async () => {
  const x = world()
  await x.start()
  const r = await x.open()
  expect(r.text).toContain(`http://localhost:8801/#c=KEY1&s=${r.raw}`)
  expect(r.text).toContain('このチャットに届きます')
  const folder = x.state.get('chatLink') as string
  expect(folder).toMatch(/^[0-9a-f]{64}$/)
  expect(x.linkDir()).toBe(linkDir('darwin', x.VDIR, folder))
  expect(x.now() - x.link().at).toBeLessThanOrEqual(0)
  // link.json には合図のハッシュと期限だけ（サーバーが引き換えに使う）。
  expect(x.link().binds).toEqual([{ h: await x.io.hashLink(r.raw), until: x.now() + 15 * MIN }])
  for (const [, text] of x.files) expect(text).not.toContain(r.raw)
  // 開き直すと、同じフォルダーに新しい合図を足す（前の合図も期限まで使える。5つまで）。
  const again = await x.open()
  expect(again.raw).not.toBe(r.raw)
  expect(x.linkDir()).toBe(linkDir('darwin', x.VDIR, folder))
  expect(x.link().binds.length).toBe(2)
  for (let i = 0; i < 6; i++) await x.open()
  expect(x.link().binds.length).toBe(5)
  // 期限が過ぎた合図は、印を書き直すときに外す。
  await x.advance(16 * MIN)
  expect(x.link().binds).toEqual([])
})

test('動いているサーバーがこのModより古ければ、リンクに合図を付けない（古い画面は #c= だけの形しか読めない）', async () => {
  const x = world({ serverVersion: '0.0.1' })
  await x.start()
  const r = await x.nd.note('')
  expect(r.text).toContain('#c=KEY1')
  expect(r.text).not.toContain('s=')
  expect(r.text).not.toContain('このチャットに届きます')
})

test('番号は推測できない43文字（32バイトの乱数）で、毎回違う。ハッシュは SHA-256 の16進', async () => {
  const x = world()
  const a = x.io.randomLink()
  const b = x.io.randomLink()
  expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(a).not.toBe(b)
  expect(await x.io.hashLink('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('2つのチャットがそれぞれエディターを開いたら、それぞれのエディターの文は、それぞれのチャットにだけ届く', async () => {
  const files = new Map<string, string>()
  const a = world({ files, session: 'sess-a' })
  const b = world({ files, session: 'sess-b' })
  await a.start()
  await b.start()
  const ra = await a.open()
  const rb = await b.open()
  expect(ra.raw).not.toBe(rb.raw)
  expect(a.linkDir()).not.toBe(b.linkDir())
  a.editor({ sendChat: { text: 'Aへ', at: a.now() } })
  await a.advance(1500)
  await b.advance(1500)
  expect(a.sends.map(s => s.text)).toEqual(['Aへ'])
  expect(b.sends.length).toBe(0)
  b.editor({ sendChat: { text: 'Bへ', at: b.now() }, askChat: { text: 'B引用', at: b.now() } })
  await a.advance(1500)
  await b.advance(1500)
  expect(a.sends.map(s => s.text)).toEqual(['Aへ'])
  expect(b.sends.map(s => s.text)).toEqual(['Bへ'])
  expect(a.fills.length).toBe(0)
  expect(b.fills.length).toBe(1)
  // 返事も、それぞれの結び付けのフォルダーに書く。
  a.sends[0].resolve({})
  b.sends[0].resolve({})
  await a.nd.turnStart({ text: 'Aへ', turnId: 'ta' })
  await a.nd.turnComplete({ turnId: 'ta', answer: 'Aの返事', reason: 'done' })
  await b.nd.turnStart({ text: 'Bへ', turnId: 'tb' })
  await b.nd.turnComplete({ turnId: 'tb', answer: 'Bの返事', reason: 'done' })
  expect(a.json('reply.json').text).toBe('Aの返事')
  expect(b.json('reply.json').text).toBe('Bの返事')
  // 片方の番が、もう片方の返事にならない。
  await b.nd.turnStart({ text: 'Aへ', turnId: 'tx' })
  await b.nd.turnComplete({ turnId: 'tx', answer: '混ざった', reason: 'done' })
  expect(a.json('reply.json').text).toBe('Aの返事')
})

test('ターミナルだけのチャットは、送り先にならない。/note の返事でそう伝え、リンクに番号を付けない', async () => {
  const x = world({ surfaces: ['terminal'] })
  await x.start()
  const r = await x.open()
  expect(r.raw).toBe('')
  expect(r.text).toContain('#c=KEY1')
  expect(r.text).not.toContain('s=')
  expect(r.text).toContain('ターミナルだけで開いているので')
  expect(x.linkDir()).toBe(null)
  expect([...x.files.keys()].some(k => k.includes(`${x.sep}chats${x.sep}`))).toBe(false)
  expect(await x.say('こんにちは')).toBe(null)
  // ターミナルとアプリの両方に出ているチャットは、送り先になる。
  const y = world({ surfaces: ['terminal', 'desktop'] })
  await y.start()
  expect((await y.open()).raw).toMatch(/^[A-Za-z0-9_-]{43}$/)
})

test('開いたあとにターミナルだけになったら、送らず、送れなかったことを返し、link.json も書き直さない。画面が戻っても遅れて送らない', async () => {
  const x = await opened()
  const at = x.link().at
  x.w.surfaces = ['terminal']
  const sentAt = x.now()
  x.editor({ sendChat: { text: 'こんにちは', at: sentAt } })
  await x.advance(30_000)
  expect(x.sends.length).toBe(0)
  expect(x.link().at).toBe(at)
  expect(x.json('reply.json')).toEqual({ for: sentAt, text: 'チャットへ送れませんでした。（このチャットの画面が開いていません）', failed: true, at: expect.any(Number) })
  x.w.surfaces = ['desktop']
  await x.advance(3000)
  expect(x.sends.length).toBe(0)
})

test('書かれてから2分より時間がたった送る文は、送らずに、送れなかったことを返す', async () => {
  const x = await opened()
  const old = x.now() - 3 * MIN
  x.editor({ sendChat: { text: '古い文', at: old } })
  await x.advance(1500)
  expect(x.sends.length).toBe(0)
  expect(x.json('reply.json').for).toBe(old)
  expect(x.json('reply.json').failed).toBe(true)
})

test('印を書いているあいだにチャットが終わっても、印を生き返らせず、$.state にも戻さない', async () => {
  const x = await opened()
  let ended = false
  x.w.onWrite = async p => {
    if (ended || !p.endsWith('link.json')) return
    ended = true
    x.w.onWrite = null
    await x.nd.sessionEnd('other') // 見回りの書き込みの途中で終わる
  }
  await x.advance(11_000)
  expect(ended).toBe(true)
  expect(x.link()).toEqual({ at: 0, closed: true, reason: 'other' })
  expect(x.state.get('chatLink')).toBe(null)
})

test('Modを読み込み直しても、まだ使っていない合図は link.json に残す', async () => {
  const x = await opened()
  const code = (await x.open()).raw
  const h = await x.io.hashLink(code)
  const y = world({ files: x.files, state: x.state })
  await y.start()
  await y.advance(11_000)
  expect(x.link().binds.some((b: { h: string }) => b.h === h)).toBe(true)
})

test('チャットが終わったあとに、途中だった見回りが印を生き返らせない', async () => {
  const x = await opened()
  await x.nd.sessionEnd('other')
  await x.advance(30_000)
  expect(x.link()).toEqual({ at: 0, closed: true, reason: 'other' })
})

test('/clear では結び付けを残す（名前は新しくする）。チャットが終わると link.json を終わりにし、番号を捨てる', async () => {
  const x = await opened()
  const raw = x.state.get('chatLink')
  await x.nd.sessionEnd('clear')
  expect(x.state.get('chatLink')).toBe(raw)
  x.editor({ sendChat: { text: 'clear のあと', at: x.now() } })
  await x.advance(1500)
  expect(x.sends.map(s => s.text)).toEqual(['clear のあと'])
  await x.nd.sessionEnd('other')
  expect(x.link()).toEqual({ at: 0, closed: true, reason: 'other' })
  expect(x.json('log.json')).toEqual({}) // 会話の抜粋も消す
  expect(x.state.get('chatLink')).toBe(null)
  x.editor({ sendChat: { text: '終わったあと', at: x.now() + 10 } })
  await x.advance(3000)
  expect(x.sends.length).toBe(1)
  // 次に開くときは新しい結び付けのフォルダー。
  await x.open()
  expect(x.state.get('chatLink')).not.toBe(raw)
})

test('別のVaultのチャットは、このVaultの結び付けのフォルダーに触らない', async () => {
  const files = new Map<string, string>()
  const a = world({ files, vid: 'aaaaaaaaaaaaaaaa', root: '/V/a' })
  const b = world({ files, vid: 'bbbbbbbbbbbbbbbb', root: '/V/b' })
  await a.start()
  await b.start()
  await a.open()
  await b.open()
  expect(a.linkDir()!.startsWith(a.VDIR)).toBe(true)
  expect(b.linkDir()!.startsWith(b.VDIR)).toBe(true)
  const before = [...files.keys()].filter(k => k.startsWith(a.VDIR)).map(k => [k, files.get(k)])
  await b.advance(15_000)
  await b.nd.sessionEnd('other')
  expect([...files.keys()].filter(k => k.startsWith(a.VDIR)).map(k => [k, files.get(k)])).toEqual(before)
})

test('Windowsの場所でも、別のフォルダーのノートを見分け、project はフォルダーの名前だけ', async () => {
  expect(describeNote({ path: 'Home.md', root: 'c:/users/u/NOTES', updatedAt: 900 }, 1000, 'C:\\Users\\u\\Notes', 'win32')).toBe('エディターで開いているノート: Home.md')
  expect(describeNote({ path: 'sub/Home.md', root: 'C:\\Users\\u\\Other', updatedAt: 900 }, 1000, 'C:\\Users\\u\\Notes', 'win32')).toBe(
    'エディターで開いているノート: C:\\Users\\u\\Other\\sub\\Home.md',
  )
  expect(describeNote({ path: 'Home.md', root: '/v/NOTES', updatedAt: 900 }, 1000, '/v/notes', 'darwin')).toBe('エディターで開いているノート: /v/NOTES/Home.md')

  const x = await opened({ win: true })
  expect(x.linkDir()!.startsWith(`${x.VDIR}\\chats\\`)).toBe(true)
  x.share(true)
  x.editor({ path: 'Home.md', root: 'C:\\Users\\u\\Other', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toContain('C:\\Users\\u\\Other\\Home.md')
  x.editor({ path: 'Home.md', root: 'c:\\users\\u\\notes', updatedAt: x.now() - 100 })
  expect(await x.say('こんにちは')).toBe('エディターで開いているノート: Home.md')
  await x.advance(3000)
  expect(x.json('log.json').project).toBe('Notes')
})

test('会話の記録に、エディターを開く鍵（#c=）と結び付けの合図（s=）を書かない', async () => {
  const x = await opened()
  const raw = (await x.open()).raw
  x.w.messages = [
    { role: 'user', text: `The notedock plugin sent a message: navigate で http://localhost:8801/?chat=1#c=SECRETKEY123&s=${raw} へ移ってください。` },
    { role: 'assistant', text: `[開く](http://localhost:8801/#c=KEY2) と "http://localhost:8801/#c=KEY3" と <http://localhost:8801/#s=${raw}>` },
  ]
  await x.say('こんにちは')
  await x.advance(3000)
  const log = x.files.get(x.inLink('log.json'))!
  expect(log).toBeDefined()
  expect(log).not.toContain('#c=')
  expect(log).not.toContain(raw)
  for (const key of ['SECRETKEY123', 'KEY2', 'KEY3']) expect(log).not.toContain(key)
  expect(log).toContain('http://localhost:8801/?chat=1')
})

test('画面なしで始まり、session.attach なしで画面が付いたチャットでも、/note のあとは見回りが動く', async () => {
  const x = world({ surfaces: [] })
  await x.start()
  await x.advance(12_000)
  x.w.surfaces = ['desktop']
  const r = await x.open()
  expect(r.raw).toMatch(/^[A-Za-z0-9_-]{43}$/)
  await x.advance(3000)
  x.editor({ sendChat: { text: 'こんにちは', at: x.now() } })
  await x.advance(1500)
  expect(x.sends.map(s => s.text)).toEqual(['こんにちは'])
})

test('画面のないチャットでは、/note でも番号を作らない', async () => {
  const x = world({ surfaces: [] })
  await x.start()
  await x.advance(12_000)
  const r = await x.open()
  expect(r.raw).toBe('')
  expect([...x.files.keys()].some(k => k.includes(`${x.sep}chats${x.sep}`))).toBe(false)
})

test('Windowsでは、別のフォルダーの場所の / も \\ にそろえてつなぐ。ファイルの場所はOSを渡して作る', () => {
  expect(describeNote({ path: 'sub/Home.md', root: 'C:/Users/u/Other', updatedAt: 900 }, 1000, 'C:\\Users\\u\\Notes', 'win32')).toBe(
    'エディターで開いているノート: C:\\Users\\u\\Other\\sub\\Home.md',
  )
  expect(chatFile('win32', 'C:\\S\\vaults\\v', 'link.json')).toBe('C:\\S\\vaults\\v\\link.json')
  expect(chatFile('darwin', '/S/vaults/v', 'link.json')).toBe('/S/vaults/v/link.json')
  expect(linkDir('win32', 'C:\\S\\vaults\\v', 'ab')).toBe('C:\\S\\vaults\\v\\chats\\ab')
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

test('鍵と番号を消すとき、すぐあとに続く文は残す', () => {
  expect(hideKeys('http://localhost:8801/#c=AbC-_9xyzです。次へ')).toBe('http://localhost:8801/です。次へ')
  expect(hideKeys('[開く](http://localhost:8801/#c=KEY2)を押す')).toBe('[開く](http://localhost:8801/)を押す')
  expect(hideKeys('a #c=K1、b #c=K2。')).toBe('a 、b 。')
  const s = 'S'.repeat(43)
  expect(hideKeys(`http://localhost:8801/#c=K1&s=${s})です`)).toBe('http://localhost:8801/)です')
  expect(hideKeys(`http://localhost:8801/#s=${s}。`)).toBe('http://localhost:8801/。')
  expect(hideKeys('鍵なし')).toBe('鍵なし')
})

test('チャットが終わった理由を、デバッグのログと「終わった」の印に残す（決まった言葉だけ）。/clear なら結び付けを残す', async () => {
  const x = await opened()
  await x.nd.sessionEnd('clear')
  expect(x.debugLines).toEqual(['notedock: session.end reason=clear'])
  expect(x.link().closed).toBeUndefined()
  await x.nd.sessionEnd('prompt_input_exit')
  expect(x.debugLines[1]).toBe('notedock: session.end reason=prompt_input_exit')
  expect(x.link()).toEqual({ at: 0, closed: true, reason: 'prompt_input_exit' })
  const y = await opened()
  await y.nd.sessionEnd('/Users/someone の会話' as any)
  expect(y.debugLines).toEqual(['notedock: session.end reason=unknown'])
  expect(y.link().reason).toBe('unknown')
  const z = await opened()
  await z.nd.sessionEnd(undefined)
  expect(z.link().reason).toBe('unknown')
})

// ---- 入力欄の @ の候補「選んでいる行」 ----

test('@ を打つと、選んでいる行の候補を出す。選ぶと @場所#L から行までが入る', async () => {
  const x = await opened()
  x.editor({ path: 'notes/Home.md', selection: '本文', lines: { from: 12, to: 18 }, updatedAt: x.now() - 100 })
  expect(await x.nd.autocomplete({ token: '@' })).toEqual({
    text: '@notes/Home.md#L12-18',
    label: '選んでいる行：notes/Home.md の12〜18行',
    description: 'NoteDock',
  })
  // 共有の切り替えがオフでも出す（本人が選んだときだけ渡るため）
  x.share(false)
  expect((await x.nd.autocomplete({ token: '@選' }))?.text).toBe('@notes/Home.md#L12-18')
  expect((await x.nd.autocomplete({ token: '@notes/Ho' }))?.text).toBe('@notes/Home.md#L12-18')
})

test('1行だけなら #L12、保存していない変更があれば添え書きに出す', () => {
  const row = lineMention({ path: 'Home.md', lines: { from: 3, to: 3 }, dirty: true, updatedAt: 900 }, 1000, '/V/notes', 'darwin', '@')
  expect(row?.text).toBe('@Home.md#L3')
  expect(row?.label).toBe('選んでいる行：Home.md の3行')
  expect(row?.description).toContain('行がずれる')
})

test('出さないとき：行を選んでいない・古い・別の語を打っている・もう選んだあと・場所に空白や # がある・@ 以外', async () => {
  const x = await opened()
  x.editor({ path: 'Home.md', updatedAt: x.now() - 100 })
  expect(await x.nd.autocomplete({ token: '@' })).toBe(null)
  x.editor({ path: 'Home.md', lines: { from: 1, to: 2 }, updatedAt: x.now() - 31 * MIN })
  expect(await x.nd.autocomplete({ token: '@' })).toBe(null)
  x.editor({ path: 'Home.md', lines: { from: 1, to: 2 }, updatedAt: x.now() - 100 })
  expect(await x.nd.autocomplete({ token: '@src' })).toBe(null)
  expect(await x.nd.autocomplete({ token: '@Home.md#L1-2' })).toBe(null)
  expect(await x.nd.autocomplete({ token: '#' })).toBe(null)
  x.editor({ path: 'My Notes/Home.md', lines: { from: 1, to: 2 }, updatedAt: x.now() - 100 })
  expect(await x.nd.autocomplete({ token: '@' })).toBe(null)
  x.editor({ path: 'a#b.md', lines: { from: 1, to: 2 }, updatedAt: x.now() - 100 })
  expect(await x.nd.autocomplete({ token: '@' })).toBe(null)
  x.editor({ path: 'Home.md', lines: { from: 5, to: 2 }, updatedAt: x.now() - 100 })
  expect(await x.nd.autocomplete({ token: '@' })).toBe(null)
})

test('別のフォルダーのノートは、フォルダーからの場所で入れる', async () => {
  const x = await opened()
  x.editor({ path: 'Home.md', root: '/tmp/copy', lines: { from: 1, to: 2 }, updatedAt: x.now() - 100 })
  expect((await x.nd.autocomplete({ token: '@' }))?.text).toBe('@/tmp/copy/Home.md#L1-2')
})

test('エディターを開いていないチャットでは出さない', async () => {
  const x = world()
  await x.start()
  expect(await x.nd.autocomplete({ token: '@' })).toBe(null)
})

test('フックのつなぎ：prompt.autocomplete は @ の語にだけつなぎ、候補をほかのプラグインの候補より前に足す（エンジンの候補はこの下ではなく上に並ぶ）', async () => {
  const hooks: Record<string, { matcher: any; fn: (...a: any[]) => any }> = {}
  const on: any = (name: string, a: any, b?: any) => {
    hooks[name] = typeof a === 'function' ? { matcher: undefined, fn: a } : { matcher: a, fn: b }
    return { catch: () => {} }
  }
  const row = { text: '@Home.md#L1-2', label: '選んでいる行：Home.md の1〜2行', description: 'NoteDock' }
  const nd: any = { autocomplete: async () => row, toolActivity: () => {} }
  wire(on, nd)
  const h = hooks['prompt.autocomplete']!
  expect(h.matcher.token.test('@a')).toBe(true)
  expect(h.matcher.token.test('#a')).toBe(false)
  const next = async () => ({ suggestions: [{ text: 'other' }] })
  const out: any = await h.fn({}, { text: '@', cursor: 1, token: '@', start: 0 }, next)
  expect(out.suggestions).toEqual([row, { text: 'other' }])
  nd.autocomplete = async () => null
  const same: any = await h.fn({}, { text: '@', cursor: 1, token: '@', start: 0 }, next)
  expect(same.suggestions).toEqual([{ text: 'other' }])
})

test('打った文の @場所#L12-18 を拾う。Vault の外へ出る場所・絶対パス・.md でない場所は拾わない', () => {
  expect(lineRefsIn('@a.md#L12-18 と @memo/b.md#L3 を見て。')).toEqual([
    { path: 'a.md', from: 12, to: 18 },
    { path: 'memo/b.md', from: 3, to: 3 },
  ])
  expect(lineRefsIn('x@a.md#L1 @a.md @a.md#L5-2 @a.md#L0')).toEqual([])
  expect(lineRefsIn('@../x.md#L1 @/etc/x.md#L1 @a/./b.md#L1 @C:x.md#L1 @a.txt#L1')).toEqual([])
  expect(lineRefsIn('@a.md#L1 @a.md#L1')).toEqual([{ path: 'a.md', from: 1, to: 1 }])
  expect(lineRefsIn('（@a.md#L1-2）')).toEqual([])
  expect(lineRefsIn('@a.md#L1-2、ここ')).toEqual([{ path: 'a.md', from: 1, to: 2 }])
  expect(safeVaultPath('a/b.md')).toBe(true)
  expect(safeVaultPath('a//b.md')).toBe(false)
  expect(safeVaultPath('a\\b.md')).toBe(false)
})

test('@ の行を番号付きで添える。範囲が長すぎる・ファイルが短い・読めないときはそう書く', () => {
  const text = 'l1\nl2\nl3\n'
  const block = mentionBlock([
    { ref: { path: 'a.md', from: 2, to: 3 }, where: 'a.md', text },
    { ref: { path: 'b.md', from: 9, to: 9 }, where: 'b.md', text },
    { ref: { path: 'c.md', from: 1, to: 1 }, where: 'c.md', text: null },
  ])!
  expect(block.startsWith(MENTION_HEAD)).toBe(true)
  expect(block).toContain('@a.md#L2-3\n```\n2\tl2\n3\tl3\n```')
  expect(block).toContain('@b.md#L9: このファイルは3行までです')
  expect(block).toContain('@c.md#L1: 読めませんでした')
  // 本文に ``` があれば、囲みをそれより長くする
  expect(mentionBlock([{ ref: { path: 'a.md', from: 1, to: 1 }, where: 'a.md', text: '```js' }])).toContain('````\n1\t```js\n````')
  const long = mentionBlock([{ ref: { path: 'a.md', from: 1, to: 1000 }, where: 'a.md', text: 'x\n'.repeat(1000) }])!
  expect(long).toContain('400行目まで。ここで切りました')
})

test('読むのはエディターの Vault の中。会話のフォルダーが Vault と違えば、塊には Vault の中の場所を書く', async () => {
  const seen: string[] = []
  const read = async (p: string) => {
    seen.push(p)
    return 'a\nb\n'
  }
  const same = await mentionsForSend('@x/a.md#L2', { root: '/V/notes' }, '/V/notes', 'darwin', read)
  expect(seen).toEqual(['/V/notes/x/a.md'])
  expect(same).toContain('@x/a.md#L2\n')
  const other = await mentionsForSend('@x/a.md#L2', { root: '/V/test' }, '/V/notes', 'darwin', read)
  expect(seen[1]).toBe('/V/test/x/a.md')
  expect(other).toContain('@/V/test/x/a.md#L2\n')
  expect(await mentionsForSend('行の指定なし @x/a.md', { root: '/V/notes' }, '/V/notes', 'darwin', read)).toBe(null)
  const win = await mentionsForSend('@x/a.md#L1', { root: 'C:\\Notes' }, 'C:\\Notes', 'win32', async p => (seen.push(p), 'a'))
  expect(seen.at(-1)).toBe('C:\\Notes\\x\\a.md')
  expect(win).toContain('@x/a.md#L1')
})

test('@ の行が続く文も、エディターから送った文とみなす（Modを読み込み直したあと）', () => {
  expect(isSentText(`見て @a.md#L1\n\n${MENTION_HEAD}\n@a.md#L1`, '見て @a.md#L1')).toBe(true)
  expect(isSentText('見て @a.md#L1 ほかの文', '見て @a.md#L1')).toBe(false)
})

test('窓のチャット欄で @場所#L を打って送ると、保存したファイルのその行を文に添える（共有がオフでも）', async () => {
  const x = await opened()
  x.files.set(`${x.ROOT}/memo.md`, Array.from({ length: 20 }, (_, i) => `行${i + 1}`).join('\n'))
  x.editor({ path: 'memo.md', root: x.ROOT, updatedAt: x.now(), sendChat: { text: '@memo.md#L12-13 を直して', at: x.now() } })
  const sentAt = x.now()
  await x.advance(1500)
  expect(x.sends.length).toBe(1)
  expect(x.sends[0].text).toBe(`@memo.md#L12-13 を直して\n\n${MENTION_HEAD}\n@memo.md#L12-13\n`+'```'+`\n12\t行12\n13\t行13\n`+'```')
  x.sends[0].resolve({})
  await x.nd.turnStart({ text: x.sends[0].text, turnId: 'm1' })
  await x.nd.turnComplete({ turnId: 'm1', answer: '直しました。', reason: 'done' })
  expect(x.json('reply.json').for).toBe(sentAt)
})
