// OSとCPUの組み合わせ（種類）と、バージョンの形。
// VERSION_RE は app/scripts/write-release.mjs と同じにする。
export type Target = 'aarch64-apple-darwin' | 'x86_64-apple-darwin' | 'aarch64-pc-windows-msvc' | 'x86_64-pc-windows-msvc'
export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/
