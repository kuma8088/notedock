// このファイルは scripts/write-release.mjs が作る。手で直さない。
import type { Target } from './target'
export const VERSION = "0.1.1"
export const BASE_URL = "https://github.com/kuma8088/notedock/releases/download/server-v0.1.1/"
export const ASSETS: Partial<Record<Target, { file: string; size: number; sha256: string }>> = {
  "aarch64-apple-darwin": { file: "notedock-server-aarch64-apple-darwin", size: 76812386, sha256: "f5688f91c9b0ec84ead3ff2903c6a97bf896c4d962d89ddbf3a20bb07f52f913" },
  "x86_64-apple-darwin": { file: "notedock-server-x86_64-apple-darwin", size: 89107929, sha256: "0b2726eb359d97f98d37436b891336c9f789ed0b5d04ae6d45d4a672736bd123" },
  "aarch64-pc-windows-msvc": { file: "notedock-server-aarch64-pc-windows-msvc.exe", size: 82111868, sha256: "cff82ac5262247e081354dd3907ea35217d57151b4f43220f3060a8bb2784361" },
  "x86_64-pc-windows-msvc": { file: "notedock-server-x86_64-pc-windows-msvc.exe", size: 88978299, sha256: "306939bc6f4cfb0d8c73fd6e41b71f4683c490e6b96fc9155550d06f3a6ae026" },
}
