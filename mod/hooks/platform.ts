// OSごとの違いを、このファイルの1か所に集める。
// 製品名と保存フォルダーの場所は、Modの中でここだけに書く（server/config.mjs と同じ場所にする）。
import type { Target } from './target'

type Host = any

export const PRODUCT = 'NoteDock'
export type Os = 'darwin' | 'win32'
export type HostInfo = { os: Os; home: string; stateDir: string; target: Target; systemRoot: string | null }
export type Cmd = { argv: string[]; env?: Record<string, string>; timeoutMs?: number }
export type CmdResult = { exitCode: number; stdout: string; stderr: string }

const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

// 環境変数の名前は、変数にせず文字で直接書く（validate が読む名前を拾うため）。
export async function hostInfo($: Host): Promise<HostInfo | { problem: string }> {
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const localAppData = await $.env.get('LOCALAPPDATA')
    const home = await $.env.get('USERPROFILE')
    const systemRoot = await $.env.get('SystemRoot')
    if (!localAppData || !home || !systemRoot) return { problem: 'Windowsの環境変数（LOCALAPPDATA・USERPROFILE・SystemRoot）が読めません' }
    const arch = await $.env.get('PROCESSOR_ARCHITECTURE')
    const archWow = await $.env.get('PROCESSOR_ARCHITEW6432')
    const arm = String(arch ?? '').toUpperCase() === 'ARM64' || String(archWow ?? '').toUpperCase() === 'ARM64'
    return {
      os: 'win32',
      home,
      stateDir: joinPath('win32', localAppData, PRODUCT),
      target: arm ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc',
      systemRoot,
    }
  }
  const home = await $.env.get('HOME')
  if (!home) return { problem: '環境変数 HOME が読めません' }
  // Rosetta 2の上でも本物のCPUの種類を選ぶため、uname ではなく sysctl を使う。
  const r = await runCmd($, { argv: ['/usr/sbin/sysctl', '-n', 'hw.optional.arm64'] })
  const apple = r.exitCode === 0 && r.stdout.trim() === '1'
  return {
    os: 'darwin',
    home,
    stateDir: joinPath('darwin', home, 'Library', 'Application Support', PRODUCT),
    target: apple ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin',
    systemRoot: null,
  }
}

export function joinPath(os: Os, ...parts: string[]): string {
  const sep = os === 'win32' ? '\\' : '/'
  const re = os === 'win32' ? /[\\/]+$/ : /\/+$/
  return parts.map((p, i) => (i < parts.length - 1 ? p.replace(re, '') : p)).join(sep)
}

// / と \ の両方を区切りとみなす。
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

// ディスクに実際に保存されている書き方にそろえる。たどれなければ null（失敗を隠さない）。
export async function canonicalRoot($: Host, root: string): Promise<string | null> {
  try {
    const st = await $.fs.stat(root, { resolve: true })
    return st?.realPath || null
  } catch {
    return null
  }
}

function winNorm(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\{2,}/g, '\\').toLowerCase().replace(/\\+$/, '')
}

// サーバーの isRefusedRoot と同じ決まりに、ネットワーク上の場所を足したもの。
export function refusedReason(root: string, host: HostInfo): 'network' | 'broad' | null {
  if (root.startsWith('\\\\') || root.startsWith('//')) return 'network'
  if (host.os === 'win32') {
    const r = winNorm(root)
    if (/^[a-z]:$/.test(r) || /^[a-z]:\\users$/.test(r)) return 'broad'
    return r === winNorm(host.home) ? 'broad' : null
  }
  const fold = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p).toLowerCase()
  const r = fold(root)
  return ['/', '/Users', host.home].some(p => r === fold(p)) ? 'broad' : null
}

// Windowsは区切りを \ にそろえて小文字にする。
export function rootKey(root: string, os: Os): string {
  return os === 'win32' ? root.replace(/\//g, '\\').toLowerCase() : root
}

export function binaryName(target: Target): string {
  return target.includes('windows') ? 'notedock-server.exe' : 'notedock-server'
}

function sys32(host: HostInfo, ...rest: string[]): string {
  return joinPath('win32', host.systemRoot ?? '', 'System32', ...rest)
}

function powershell(host: HostInfo, script: string, env: Record<string, string>): Cmd {
  // 失敗はエラーとして終わらせ、終了コードに出す。場所は環境変数で渡し、文字列には入れない。
  return { argv: [sys32(host, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ...PS_FLAGS, `$ErrorActionPreference = 'Stop'; ${script}`], env }
}

// 時間の上限は付けない。このコマンドは $.process.spawn で動かす。
// $.process.run は初めの30秒、長くても10分で止まるので、runCmd には通さない。
// 60秒続けて1KB/秒を下回ったら止まる。
export function downloadCmd(host: HostInfo, url: string, out: string): Cmd {
  const proto = url.startsWith('file://') ? ['--proto', '=file'] : ['--proto', '=https', '--proto-redir', '=https']
  const curl = host.os === 'win32' ? sys32(host, 'curl.exe') : '/usr/bin/curl'
  return { argv: [curl, '-fsSL', ...proto, '--speed-limit', '1024', '--speed-time', '60', '-o', out, url] }
}

export function sha256Cmd(host: HostInfo, file: string): Cmd {
  if (host.os === 'win32') return { argv: [sys32(host, 'certutil.exe'), '-hashfile', file, 'SHA256'] }
  return { argv: ['/usr/bin/shasum', '-a', '256', file] }
}

// 空白を除くと16進の64文字だけになる行を探す（certutilの古い形は2文字ごとに空白が入る）。
export function parseSha256(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.replace(/\s+/g, '')
    if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase()
    // shasum は「指紋  ファイル名」の形
    const m = /^([0-9a-fA-F]{64})\s/.exec(line)
    if (m) return m[1].toLowerCase()
  }
  return null
}

export function makeExecutableCmd(host: HostInfo, file: string): Cmd | null {
  return host.os === 'win32' ? null : { argv: ['/bin/chmod', '755', file] }
}

export function moveCmd(host: HostInfo, from: string, to: string): Cmd {
  if (host.os === 'win32') return powershell(host, 'Move-Item -LiteralPath $env:ND_FROM -Destination $env:ND_TO -Force', { ND_FROM: from, ND_TO: to })
  return { argv: ['/bin/mv', '-f', from, to] }
}

export function removeDirCmd(host: HostInfo, dir: string): Cmd {
  if (host.os === 'win32') return powershell(host, 'if (Test-Path -LiteralPath $env:ND_DIR) { Remove-Item -LiteralPath $env:ND_DIR -Recurse -Force }', { ND_DIR: dir })
  return { argv: ['/bin/rm', '-rf', dir] }
}

// 保存フォルダーを本人だけの権限で作る。すでにあっても 0 で終わる。
// Macの -m は最後のフォルダーにだけ効くが、親の Application Support はもとからある。
export function makeStateDirCmd(host: HostInfo): Cmd {
  if (host.os === 'win32') return makeDirsCmd(host, host.stateDir)
  return { argv: ['/bin/mkdir', '-p', '-m', '700', host.stateDir] }
}

// 親ごと作る。すでにあっても 0 で終わる。
export function makeDirsCmd(host: HostInfo, dir: string): Cmd {
  if (host.os === 'win32') return powershell(host, 'New-Item -ItemType Directory -Force -Path $env:ND_DIR', { ND_DIR: dir })
  return { argv: ['/bin/mkdir', '-p', dir] }
}

// 親はあるものとして1つだけ作る。すでにあれば 0 以外で終わる（取り合いの目印に使う）。
export function mkdirExclusiveCmd(host: HostInfo, dir: string): Cmd {
  if (host.os === 'win32') return powershell(host, 'New-Item -ItemType Directory -Path $env:ND_DIR -ErrorAction Stop', { ND_DIR: dir })
  return { argv: ['/bin/mkdir', dir] }
}

// 起動できない・時間切れのときも例外にせず、終了コード -1 で返す。
export async function runCmd($: Host, cmd: Cmd): Promise<CmdResult> {
  try {
    const init: { env?: Record<string, string>; timeoutMs?: number } = {}
    if (cmd.env) init.env = cmd.env
    if (cmd.timeoutMs !== undefined) init.timeoutMs = cmd.timeoutMs // undefined のキーは渡さない
    const r = await $.process.run(cmd.argv, init)
    return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  } catch (e) {
    return { exitCode: -1, stdout: '', stderr: String((e as Error)?.message ?? e) }
  }
}
