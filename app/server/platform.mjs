// OSごとに違う処理をここに集める。Denoだけの機能は globalThis.Deno があるときだけ使う。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { renameWithRetry } from './durable.mjs'
import { realPathMatches } from './paths.mjs'

const TRASH = '/usr/bin/trash'
const TRASH_TIMEOUT_MS = 15000
const SYNCHRONIZE = 0x00100000
const FILE_ATTRIBUTE_HIDDEN = 0x2
const INVALID_FILE_ATTRIBUTES = 0xffffffff

function fail(message, status) {
  return Object.assign(new Error(message), { status })
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

let kernel32 = null
let kernel32Failed = false
function loadKernel32() {
  if (kernel32Failed) throw new Error('kernel32 unavailable')
  try {
    kernel32 ??= globalThis.Deno.dlopen('kernel32.dll', {
      OpenProcess: { parameters: ['u32', 'i32', 'u32'], result: 'pointer' },
      WaitForSingleObject: { parameters: ['pointer', 'u32'], result: 'u32', nonblocking: true },
      GetFileAttributesW: { parameters: ['buffer'], result: 'u32' },
    })
  } catch (error) {
    kernel32Failed = true
    throw error
  }
  return kernel32
}

// 今の起動元のプロセス番号。WindowsのDenoでは Deno.ppid を使う。
export function launcherPid(platform = process.platform) {
  return platform === 'win32' && globalThis.Deno ? globalThis.Deno.ppid : process.ppid
}

// 返ってくる関数で見張りをやめる。タイマーは、それだけでプロセスを生かし続けない。
// parentPid は、起動してすぐに覚えた起動元。起動の途中で起動元が終わっていても気づけるよう、呼ぶ側が最初に取っておく。
export function watchParent(onGone, { platform = process.platform, intervalMs = 2000, parentPid = launcherPid(platform) } = {}) {
  let stopped = false
  let timer = null
  const done = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    onGone()
  }
  const poll = (gone) => {
    if (stopped) return
    timer = setInterval(() => {
      if (gone()) done()
    }, intervalMs)
    timer.unref?.()
  }
  const parent = parentPid
  if (platform === 'win32') {
    let handle = null
    if (globalThis.Deno) {
      try {
        handle = loadKernel32().symbols.OpenProcess(SYNCHRONIZE, 0, parent)
      } catch {
        handle = null
      }
    }
    if (handle) {
      loadKernel32()
        .symbols.WaitForSingleObject(handle, 0xffffffff)
        .then(
          (result) => (result === 0 ? done() : poll(() => !isAlive(parent))),
          () => poll(() => !isAlive(parent)),
        )
    } else {
      poll(() => !isAlive(parent))
    }
  } else {
    // 起動元が先に終わると、親は1（launchd / init）に付け替わる。覚えた番号が1なら、もう終わっている。
    poll(() => parent === 1 || process.ppid !== parent)
  }
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

// 隠し属性はPowerShellでVault全体を調べず、ファイルごとにWindowsに直接たずねる。
export function isHiddenFile(fullPath, platform = process.platform) {
  if (platform !== 'win32' || !globalThis.Deno) return false
  try {
    const units = new Uint16Array(fullPath.length + 1)
    for (let i = 0; i < fullPath.length; i++) units[i] = fullPath.charCodeAt(i)
    const attrs = loadKernel32().symbols.GetFileAttributesW(new Uint8Array(units.buffer))
    return attrs !== INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_HIDDEN) !== 0
  } catch {
    return false
  }
}

// Windowsは標準のごみ箱を使わず、Vault直下の.trashへ移す（確かめずに完全に消してしまうことがないように）。
function uniqueTrashTarget(target) {
  if (!fs.existsSync(target)) return target
  const ext = fs.statSync(target).isDirectory() ? '' : path.extname(target)
  const base = target.slice(0, target.length - ext.length)
  for (let n = 2; ; n += 1) {
    const next = `${base} (${n})${ext}`
    if (!fs.existsSync(next)) return next
  }
}

// 消すことはしない。ごみ箱に入れられなければ、そのまま残して知らせる。
export function moveToTrash(file, { platform = process.platform, root, run = execFileSync } = {}) {
  if (platform === 'win32') {
    if (!root) throw fail('trash failed', 500)
    try {
      const rel = path.relative(root, file)
      if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('outside root')
      // .trash がリンク（ジャンクション）やファイルなら使わない。たどるとVaultの外へ移してしまう。
      const trash = path.join(root, '.trash')
      let stat = null
      try {
        stat = fs.lstatSync(trash)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error('trash is not a plain folder')
      const target = path.join(trash, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      // 中のフォルダーがリンクでも、短い名前でも、移す先の実際の場所がVaultの .trash の下で指定どおりか確かめる。
      const parts = path.relative(root, path.dirname(target)).split(path.sep)
      if (!realPathMatches(fs.realpathSync.native(root), fs.realpathSync.native(path.dirname(target)), parts)) throw new Error('trash outside root')
      renameWithRetry(file, uniqueTrashTarget(target), platform)
    } catch {
      // 移せなければ、ノートはそのまま残す。理由は区別せず「ごみ箱へ移せなかった」とだけ返す。
      throw fail('trash failed', 500)
    }
    return
  }
  try {
    run(TRASH, [file], { timeout: TRASH_TIMEOUT_MS })
  } catch {
    throw fail('trash failed', 500)
  }
}

// 合言葉のファイルを信用してよいか。Windowsは置き場が%LOCALAPPDATA%なので、普通のファイルかどうかだけ見る。
export function ownerOnly(file, platform = process.platform) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    if (platform === 'win32') return true
    return !(stat.mode & 0o077) && stat.uid === process.getuid()
  } catch {
    return false
  }
}
