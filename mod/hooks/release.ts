// このファイルは scripts/write-release.mjs が作る。手で直さない。
import type { Target } from './target'
export const VERSION = "0.1.4"
export const BASE_URL = "https://github.com/kuma8088/notedock/releases/download/server-v0.1.4/"
export const ASSETS: Partial<Record<Target, { file: string; size: number; sha256: string }>> = {
  "aarch64-apple-darwin": { file: "notedock-server-aarch64-apple-darwin", size: 77803106, sha256: "cd5c3bed8833c76d779f57fa17a3ea8a25dd57eeb6d2c64d7d259804ad5b45ad" },
  "x86_64-apple-darwin": { file: "notedock-server-x86_64-apple-darwin", size: 90053089, sha256: "02d2746eee5023fd8ceff47c795c6135486a09324dbea80392919b5a6ab81606" },
  "aarch64-pc-windows-msvc": { file: "notedock-server-aarch64-pc-windows-msvc.exe", size: 83057028, sha256: "c961c16511edeae30fdce49eb92e77ea636beeda8a00bfe4e3e5c9f15e36a04a" },
  "x86_64-pc-windows-msvc": { file: "notedock-server-x86_64-pc-windows-msvc.exe", size: 89923459, sha256: "b02c58720a2590ea4dadda26bf62a65ad0ab2dd5399e9879d36b5e71d63ce605" },
}
