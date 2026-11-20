// このファイルは scripts/write-release.mjs が作る。手で直さない。
import type { Target } from './target'
export const VERSION = "0.1.0"
export const BASE_URL = "https://github.com/kuma8088/notedock/releases/download/server-v0.1.0/"
export const ASSETS: Partial<Record<Target, { file: string; size: number; sha256: string }>> = {
  "aarch64-apple-darwin": { file: "notedock-server-aarch64-apple-darwin", size: 76812386, sha256: "01a19cc946225f2716895199c4742e3bee3a940ee67f81f5bfe324ab72535e56" },
  "x86_64-apple-darwin": { file: "notedock-server-x86_64-apple-darwin", size: 89089084, sha256: "220ae8b6ee6f362568ae02b962be427d742655b7f06705a878a6cfe883acb0a5" },
  "aarch64-pc-windows-msvc": { file: "notedock-server-aarch64-pc-windows-msvc.exe", size: 82093023, sha256: "c7573ee6e6b26b8028b7a8cd7f5351f631c21e5434de15e8d6118b19161b79ec" },
  "x86_64-pc-windows-msvc": { file: "notedock-server-x86_64-pc-windows-msvc.exe", size: 88959454, sha256: "da26193fd2b01c663ed6834b8631eb82aa55a5d3ecc9aedf6616ee3e9f5c7f46" },
}
