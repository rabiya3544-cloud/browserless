// api/css.js
// GET ?url=...  or  POST { url }  →  text/css
// Simple fetch-and-return-text with SSRF guard, timeout, size cap.

const MAX_BYTES  = 4 * 1024 * 1024;
const TIMEOUT_MS = 25000;

function isSafeHost(parsed) {
  if (!['http:', 'https:'].includes(parsed.protocol)) { return false; }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') { return false; }
  if (/^127\./.test(host)) { return false; }
  if (/^10\./.test(host)) { return false; }
  if (/^192\.168\./.test(host)) { return false; }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) { return false; }
  if (/^169\.254\./.test(host)) { return false; }
  if (host.endsWith('.internal') || host.endsWith('.local')) { return false; }
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { return res.status(204).end(); }

  let rawUrl;
  if (req.method === 'GET') {
    rawUrl = req.query?.url;
  } else if (req.method === 'POST') {
    rawUrl = (req.body || {}).url;
  } else {
    return res.status(405).json({ error: 'GET or POST only' });
  }

  if (!rawUrl || typeof rawUrl !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  let parsed;
  try { parsed = new URL(rawUrl); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!isSafeHost(parsed)) {
    return res.status(400).json({ error: 'URL not allowed' });
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS);

  try {
    const r = await fetch(parsed.href, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CssFetcher/1.0)',
        'Accept': 'text/css,*/*;q=0.1',
      },
    });

    if (!r.ok) {
      return res.status(r.status).json({ error: `Upstream HTTP ${r.status}`, url: parsed.href });
    }

    const text = await r.text();

    if (text.length > MAX_BYTES) {
      return res.status(413).json({ error: `Response too large (${text.length} bytes)`, url: parsed.href });
    }

    const ct = (r.headers.get('content-type') || '').toLowerCase();
    res.setHeader('Content-Type', ct.includes('css') ? 'text/css; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Original-Content-Type', ct || 'none');
    return res.status(200).send(text);
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'upstream timeout' : (err?.message || String(err));
    return res.status(502).json({ error: 'Backend failed', message: msg });
  } finally {
    clearTimeout(timer);
  }
};
