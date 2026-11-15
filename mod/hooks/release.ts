// このファイルは scripts/write-release.mjs が作る。手で直さない。
import type { Target } from './target'
export const VERSION = "0.1.0-dev"
export const BASE_URL = "https://github.com/kuma8088/notedock/releases/download/server-v0.1.0-dev/"
export const ASSETS: Partial<Record<Target, { file: string; size: number; sha256: string }>> = {}
