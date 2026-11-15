import { expect, test } from 'claude-code/testing'

import {
  baseName, binaryName, canonicalRoot, downloadCmd, hostInfo, joinPath, makeDirsCmd, makeExecutableCmd, makeStateDirCmd,
  mkdirExclusiveCmd, moveCmd, parseSha256, refusedReason, removeDirCmd, rootKey, runCmd, sha256Cmd, type HostInfo,
} from './platform'

// テストの `$` には env・process・fs が無い（エンジンは持たない）ので、使う分だけの代役を渡す。
// 環境変数・sysctl・fs.stat の答えを決めておく。
type Fake = { env?: Record<string, string>; sysctl?: { stdout?: string; exitCode?: number; fail?: boolean }; stat?: (path: string) => unknown }
function host(f: Fake) {
  return {
    env: { get: async (name: string) => f.env?.[name] },
    process: {
      run: async (_argv: string[], init?: unknown) => {
        if (f.sysctl?.fail) throw new Error('起動できません')
        return { stdout: f.sysctl?.stdout ?? '', stderr: '', exitCode: f.sysctl?.exitCode ?? 0 }
      },
    },
    fs: { stat: async (path: string, _o: unknown) => f.stat?.(path) },
  }
}

const WIN_ENV = { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\yamada\\AppData\\Local', USERPROFILE: 'C:\\Users\\yamada', SystemRoot: 'C:\\Windows', PROCESSOR_ARCHITECTURE: 'AMD64' }
const MAC_ENV = { HOME: '/Users/yamada' }

const win: HostInfo = { os: 'win32', home: 'C:\\Users\\yamada', stateDir: 'C:\\Users\\yamada\\AppData\\Local\\NoteDock', target: 'x86_64-pc-windows-msvc', systemRoot: 'C:\\Windows' }
const mac: HostInfo = { os: 'darwin', home: '/Users/yamada', stateDir: '/Users/yamada/Library/Application Support/NoteDock', target: 'aarch64-apple-darwin', systemRoot: null }

test('Macでは sysctl が 1 なら aarch64-apple-darwin、エラーや 0 なら x86_64-apple-darwin', async () => {
  const $ = host({ env: MAC_ENV, sysctl: { stdout: '1\n' } })
  expect(((await hostInfo($)) as HostInfo).target).toBe('aarch64-apple-darwin')
})

test('Macで sysctl が 0 なら Intel', async () => {
  const $ = host({ env: MAC_ENV, sysctl: { stdout: '0\n' } })
  expect(((await hostInfo($)) as HostInfo).target).toBe('x86_64-apple-darwin')
})

test('Macで sysctl が失敗しても Intel', async () => {
  const $ = host({ env: MAC_ENV, sysctl: { fail: true } })
  expect(((await hostInfo($)) as HostInfo).target).toBe('x86_64-apple-darwin')
})

test('Macで sysctl が空なら Intel', async () => {
  const $ = host({ env: MAC_ENV, sysctl: { stdout: '', exitCode: 1 } })
  expect(((await hostInfo($)) as HostInfo).target).toBe('x86_64-apple-darwin')
})

test('Windowsでは ARM64 が どちらかの値にあれば aarch64-pc-windows-msvc', async () => {
  const $ = host({ env: { ...WIN_ENV, PROCESSOR_ARCHITECTURE: 'AMD64', PROCESSOR_ARCHITEW6432: 'ARM64' } })
  const h = (await hostInfo($)) as HostInfo
  expect(h.target).toBe('aarch64-pc-windows-msvc')
  expect(h.os).toBe('win32')
})

test('WindowsでどちらもARM64でなければ x64', async () => {
  const $ = host({ env: { ...WIN_ENV, PROCESSOR_ARCHITEW6432: 'AMD64' } })
  expect(((await hostInfo($)) as HostInfo).target).toBe('x86_64-pc-windows-msvc')
})

test('Windowsの保存フォルダーは LOCALAPPDATA\\NoteDock、Macは HOME/Library/Application Support/NoteDock', async () => {
  const $ = host({ env: WIN_ENV })
  const w = (await hostInfo($)) as HostInfo
  expect(w.stateDir).toBe('C:\\Users\\yamada\\AppData\\Local\\NoteDock')
  expect(w.home).toBe('C:\\Users\\yamada')
  expect(w.systemRoot).toBe('C:\\Windows')
})

test('Macの保存フォルダー', async () => {
  const $ = host({ env: MAC_ENV, sysctl: { stdout: '1' } })
  const m = (await hostInfo($)) as HostInfo
  expect(m.stateDir).toBe('/Users/yamada/Library/Application Support/NoteDock')
  expect(m.systemRoot).toBe(null)
})

test('LOCALAPPDATA が無ければ problem を返す', async () => {
  const { LOCALAPPDATA, ...rest } = WIN_ENV
  const $ = host({ env: rest })
  const r = await hostInfo($)
  expect('problem' in r).toBe(true)
})

test('USERPROFILE か SystemRoot が無くても problem を返す', async () => {
  const { USERPROFILE, ...a } = WIN_ENV
  const $ = host({ env: a })
  expect('problem' in (await hostInfo($))).toBe(true)
})

test('SystemRoot が無ければ problem を返す', async () => {
  const { SystemRoot, ...a } = WIN_ENV
  const $ = host({ env: a })
  expect('problem' in (await hostInfo($))).toBe(true)
})

test('HOME が無ければ problem を返す', async () => {
  const $ = host({ env: {} })
  expect('problem' in (await hostInfo($))).toBe(true)
})

test('起動しないフォルダー', async () => {
  expect(refusedReason('/', mac)).toBe('broad')
  expect(refusedReason('/Users', mac)).toBe('broad')
  expect(refusedReason('/Users/yamada', mac)).toBe('broad')
  expect(refusedReason('/Users/yamada/', mac)).toBe('broad')
  expect(refusedReason('C:\\', win)).toBe('broad')
  expect(refusedReason('c:\\users', win)).toBe('broad')
  expect(refusedReason('C:\\Users\\yamada', win)).toBe('broad')
  expect(refusedReason('c:\\USERS\\YAMADA\\', win)).toBe('broad')
  expect(refusedReason('\\\\server\\share\\Notes', win)).toBe('network')
  expect(refusedReason('//server/share/Notes', win)).toBe('network')
  expect(refusedReason('C:\\Users\\yamada\\Notes', win)).toBe(null)
  expect(refusedReason('/Users/yamada/Notes', mac)).toBe(null)
})

test('rootKey は Windows で区切りをそろえて小文字にする', async () => {
  expect(rootKey('C:/Users/Yamada/Notes', 'win32')).toBe('c:\\users\\yamada\\notes')
  expect(rootKey('/Users/Yamada/Notes', 'darwin')).toBe('/Users/Yamada/Notes')
})

test('joinPath と binaryName', async () => {
  expect(joinPath('win32', 'C:\\a\\', 'b', 'c.exe')).toBe('C:\\a\\b\\c.exe')
  expect(joinPath('darwin', '/a/', 'b', 'c')).toBe('/a/b/c')
  expect(binaryName('x86_64-pc-windows-msvc')).toBe('notedock-server.exe')
  expect(binaryName('aarch64-pc-windows-msvc')).toBe('notedock-server.exe')
  expect(binaryName('aarch64-apple-darwin')).toBe('notedock-server')
})

test('Windowsのコマンドの文字列に場所が入らない', async () => {
  const p = 'C:\\Users\\山田 & Co\\100% Notes\\x'
  const cmds = [moveCmd(win, p, p + '2'), removeDirCmd(win, p), makeDirsCmd(win, p), mkdirExclusiveCmd(win, p), makeStateDirCmd(win)]
  for (const c of cmds) {
    expect(c.argv.some(a => a.includes('山田') || a.includes('100%'))).toBe(false)
    expect(c.argv[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(c.argv).toContain('-NoProfile')
  }
  expect(cmds[0].env).toEqual({ ND_FROM: p, ND_TO: p + '2' })
  expect(cmds[1].env).toEqual({ ND_DIR: p })
  expect(cmds[2].env).toEqual({ ND_DIR: p })
  expect(cmds[3].env).toEqual({ ND_DIR: p })
  expect(cmds[4].env).toEqual({ ND_DIR: win.stateDir })
  expect(cmds[0].argv.join(' ')).toContain('Move-Item -LiteralPath $env:ND_FROM -Destination $env:ND_TO -Force')
  expect(cmds[1].argv.join(' ')).toContain('Test-Path -LiteralPath $env:ND_DIR) { Remove-Item -LiteralPath $env:ND_DIR -Recurse -Force }')
  expect(cmds[2].argv.join(' ')).toContain('New-Item -ItemType Directory -Force -Path $env:ND_DIR')
  expect(cmds[3].argv.join(' ')).toContain('New-Item -ItemType Directory -Path $env:ND_DIR -ErrorAction Stop')
})

test('Macでは場所を引数のまま渡す（シェルを通さない）', async () => {
  const p = '/Users/yamada/a b/$(x)'
  const cmds = [moveCmd(mac, p, '/t'), removeDirCmd(mac, p), makeDirsCmd(mac, p), mkdirExclusiveCmd(mac, p), makeStateDirCmd(mac), downloadCmd(mac, 'https://e.com/x', p), sha256Cmd(mac, p), makeExecutableCmd(mac, p)!]
  for (const c of cmds) {
    expect(c.argv[0].startsWith('/')).toBe(true)
    expect(c.argv).not.toContain('sh')
    expect(c.argv).not.toContain('-c')
  }
  expect(cmds[0].argv).toEqual(['/bin/mv', '-f', p, '/t'])
  expect(cmds[1].argv).toEqual(['/bin/rm', '-rf', p])
  expect(cmds[2].argv).toEqual(['/bin/mkdir', '-p', p])
  expect(cmds[3].argv).toEqual(['/bin/mkdir', p])
  expect(cmds[4].argv).toEqual(['/bin/mkdir', '-p', '-m', '700', mac.stateDir])
  expect(cmds[6].argv).toEqual(['/usr/bin/shasum', '-a', '256', p])
  expect(cmds[7].argv).toEqual(['/bin/chmod', '755', p])
  expect(makeExecutableCmd(win, 'C:\\x')).toBe(null)
})

test('指紋の読み取り', async () => {
  const hex = 'ab12'.repeat(16)
  expect(parseSha256(`${hex}  /Users/yamada/file\n`)).toBe(hex)
  expect(parseSha256(`SHA256 hash of C:\\file:\n${hex.toUpperCase()}\nCertUtil: -hashfile command completed successfully.\n`)).toBe(hex)
  const spaced = hex.match(/../g)!.join(' ')
  expect(parseSha256(`SHA256 ハッシュ (ファイル C:\\a):\r\n${spaced}\r\nCertUtil: -hashfile コマンドは正常に完了しました。\r\n`)).toBe(hex)
  expect(parseSha256('SHA256 hash of C:\\ab12ab12ab12ab12\nCertUtil: done\n')).toBe(null)
  expect(parseSha256('')).toBe(null)
})

test('file:// のときだけ --proto =file にし、https では --proto-redir も付ける', async () => {
  const f = downloadCmd(mac, 'file:///tmp/x', '/tmp/o').argv
  expect(f).toContain('=file')
  expect(f).not.toContain('--proto-redir')
  const h = downloadCmd(mac, 'https://example.com/x', '/tmp/o').argv
  expect(h.slice(0, 11)).toEqual(['/usr/bin/curl', '-fsSL', '--proto', '=https', '--proto-redir', '=https', '--speed-limit', '1024', '--speed-time', '60', '-o'])
  expect(h.slice(11)).toEqual(['/tmp/o', 'https://example.com/x'])
  const w = downloadCmd(win, 'https://example.com/x', 'C:\\o')
  expect(w.argv[0]).toBe('C:\\Windows\\System32\\curl.exe')
  expect(w.timeoutMs).toBe(undefined)
  expect(sha256Cmd(win, 'C:\\f').argv).toEqual(['C:\\Windows\\System32\\certutil.exe', '-hashfile', 'C:\\f', 'SHA256'])
})

test('runCmd は起動できなくても例外を投げず exitCode -1 を返す', async () => {
  const $ = host({ env: MAC_ENV, sysctl: { fail: true } })
  const r = await runCmd($, { argv: ['/bin/nothing'] })
  expect(r.exitCode).toBe(-1)
  expect(r.stdout).toBe('')
  expect(r.stderr).toContain('起動できません')
})

test('runCmd は結果をそのまま返す', async () => {
  const $ = host({ env: MAC_ENV, sysctl: { stdout: 'ok', exitCode: 3 } })
  expect(await runCmd($, { argv: ['/bin/x'] })).toEqual({ exitCode: 3, stdout: 'ok', stderr: '' })
})

test('canonicalRoot は realPath を返し、失敗や realPath なしは null', async () => {
  const $ = host({ stat: path => (path === '/a' ? { kind: 'dir', size: 0, realPath: '/real/A' } : null) })
  expect(await canonicalRoot($, '/a')).toBe('/real/A')
  expect(await canonicalRoot($, '/nope')).toBe(null)
})

test('baseName は / と \\ の両方で切る', async () => {
  expect(baseName('/a/b/Notes')).toBe('Notes')
  expect(baseName('C:\\a\\b\\Notes\\')).toBe('Notes')
  expect(baseName('C:\\a/b\\x')).toBe('x')
})
