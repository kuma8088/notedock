// このファイルは scripts/write-release.mjs が作る。手で直さない。
import type { Target } from './target'
export const VERSION = "0.1.3"
export const BASE_URL = "https://github.com/kuma8088/notedock/releases/download/server-v0.1.3/"
export const ASSETS: Partial<Record<Target, { file: string; size: number; sha256: string }>> = {
  "aarch64-apple-darwin": { file: "notedock-server-aarch64-apple-darwin", size: 76812386, sha256: "cfb14fc009cfab27beb58a93916e2b89019cfe3a8445829a64dee67e54184fb7" },
  "x86_64-apple-darwin": { file: "notedock-server-x86_64-apple-darwin", size: 89124741, sha256: "1017f00f6830d543561146b3341534c328349677237987f5e45af735f84c51d2" },
  "aarch64-pc-windows-msvc": { file: "notedock-server-aarch64-pc-windows-msvc.exe", size: 82128680, sha256: "86b9664d15ecd992152a3de6fd9c8ca53afc03738b64e1b047072b6fb6db6a9c" },
  "x86_64-pc-windows-msvc": { file: "notedock-server-x86_64-pc-windows-msvc.exe", size: 88995111, sha256: "554ae070cb4d51556ff086003c89dd68b5262b97ffc81ac8f5aef09a328a0157" },
}
