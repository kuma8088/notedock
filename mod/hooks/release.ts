// このファイルは scripts/write-release.mjs が作る。手で直さない。
import type { Target } from './target'
export const VERSION = "0.1.0-rc.1"
export const BASE_URL = "https://github.com/kuma8088/notedock/releases/download/server-v0.1.0-rc.1/"
export const ASSETS: Partial<Record<Target, { file: string; size: number; sha256: string }>> = {
  "aarch64-apple-darwin": { file: "notedock-server-aarch64-apple-darwin", size: 76812386, sha256: "f4621afc21d8ac291a2ab964fbce7cf088b3edaa87adb6197a9c73b1b1393ea6" },
  "x86_64-apple-darwin": { file: "notedock-server-x86_64-apple-darwin", size: 89089088, sha256: "0199606a74058fd8924f41c29f43a2da2b735c0ca6f620f8bda8798c71c25ac1" },
  "aarch64-pc-windows-msvc": { file: "notedock-server-aarch64-pc-windows-msvc.exe", size: 82093027, sha256: "76d452d87e0c7ab965b69a3f20bf1a338fc608315b924e850b68145eac56c0e9" },
  "x86_64-pc-windows-msvc": { file: "notedock-server-x86_64-pc-windows-msvc.exe", size: 88959458, sha256: "c291c36e7476b467e4a43d4b613d14fb526c5d566b8ae7668d395d977bdc51b5" },
}
