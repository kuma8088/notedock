// このファイルは scripts/write-release.mjs が作る。手で直さない。
import type { Target } from './target'
export const VERSION = "0.1.2"
export const BASE_URL = "https://github.com/kuma8088/notedock/releases/download/server-v0.1.2/"
export const ASSETS: Partial<Record<Target, { file: string; size: number; sha256: string }>> = {
  "aarch64-apple-darwin": { file: "notedock-server-aarch64-apple-darwin", size: 76812386, sha256: "77a08f6e4b7b428b51380ed89cd4b0e89d3fac7e1ac5b2cadb69d2db56b26566" },
  "x86_64-apple-darwin": { file: "notedock-server-x86_64-apple-darwin", size: 89118047, sha256: "50ca5e919ae87a999321f9cb3ac4f722030bac342a98d92e92a9a6aa651d5c57" },
  "aarch64-pc-windows-msvc": { file: "notedock-server-aarch64-pc-windows-msvc.exe", size: 82121986, sha256: "23bc1c85c14f1c88dcc8894a5e295b1bb2350f84ee5b9264e777af9594080251" },
  "x86_64-pc-windows-msvc": { file: "notedock-server-x86_64-pc-windows-msvc.exe", size: 88988417, sha256: "725090f397d65bcc224a0b5811a4d6aa3ee5b1129481b04e947aa3de5da4c8bb" },
}
