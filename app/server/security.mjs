const SAFE_METHODS = new Set(['GET', 'HEAD'])

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ')

export function checkRequest(req, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  const { host, origin } = req.headers
  if (!hosts.includes(host)) return { ok: false, reason: 'host' }
  if (origin !== undefined && !hosts.map((h) => `http://${h}`).includes(origin)) {
    return { ok: false, reason: 'origin' }
  }
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    // チャットのリンクから画面を開く移動だけは認める。
    const isPage = !req.url.startsWith('/api/') && req.headers['sec-fetch-mode'] === 'navigate'
    if (!(isPage && SAFE_METHODS.has(req.method))) return { ok: false, reason: 'site' }
  }
  if (!SAFE_METHODS.has(req.method) && req.headers['x-note-editor'] !== '1') {
    return { ok: false, reason: 'header' }
  }
  return { ok: true }
}
