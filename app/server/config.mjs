import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PRODUCT } from '../src/product.mjs'

// 製品名は src/product.mjs の1か所だけに書く（画面のバンドルからも読むため）。
export { PRODUCT }
// どの応答にも付ける印。ポートにいるのが、どのVaultのNoteDockかを見分ける。
export const VAULT_HEADER = `x-${PRODUCT.toLowerCase()}-vault`
// どの応答にも付ける、サーバーのバージョン。止める指示では、送った側のバージョンを同じ名前のヘッダーで知らせる。
export const VERSION_HEADER = `x-${PRODUCT.toLowerCase()}-version`

export function defaultStateDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', PRODUCT)
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set')
    return path.win32.join(env.LOCALAPPDATA, PRODUCT)
  }
  throw new Error('unsupported platform')
}

// ディスクに実際に保存されている書き方（大文字小文字、Windowsの短い名前）にそろえる。
export function canonicalRoot(given) {
  return fs.realpathSync.native(given)
}

export function vaultIdOf(root, platform = process.platform) {
  const key = platform === 'win32' ? root.replace(/\//g, '\\').toLowerCase() : root
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
}

export function vaultDirOf(stateDir, vaultId) {
  return path.join(stateDir, 'vaults', vaultId)
}

export function isRefusedRoot(root, { platform = process.platform, home = os.homedir() } = {}) {
  const trim = (p) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)
  if (platform === 'win32') {
    const norm = (p) => path.win32.normalize(p).replace(/\//g, '\\').toLowerCase()
    const r = norm(root)
    const stripped = r.replace(/\\+$/, '')
    if (/^[a-z]:$/.test(stripped)) return true
    if (/^[a-z]:\\users$/.test(stripped)) return true
    return stripped === norm(home).replace(/\\+$/, '')
  }
  // Macのディスクは普通、大文字と小文字を区別しない。ホームはたどった先の書き方とも比べる。
  const fold = platform === 'darwin' ? (p) => trim(p).toLowerCase() : trim
  let realHome = home
  try {
    realHome = canonicalRoot(home)
  } catch {
    // ホームが見つからなくても、渡された書き方で比べる。
  }
  const r = fold(root)
  return ['/', '/Users', home, realHome].some((p) => r === fold(p))
}
