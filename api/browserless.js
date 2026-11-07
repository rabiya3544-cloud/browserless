// api/browserless.js
// POST { url, token? }  →  text/html
// Wraps Browserless /chromium/content. CORS-enabled so the
// frontend can call it directly from any origin.

module.exports = async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  // ── Input ─────────────────────────────────────────────
  const { url, token } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  // Token: request body OR env var (env wins if both are absent from body)
  const blToken = token || process.env.BROWSERLESS_TOKEN;
  if (!blToken) {
    return res.status(400).json({
      error: 'No browserless token',
      hint: 'Send {token} in the body, or set BROWSERLESS_TOKEN in Vercel env.',
    });
  }

  // Cheap scheme validation. (Not SSRF protection — browserless
  // does the actual fetch, so we never connect to the user URL
  // ourselves. This just rejects nonsense before we bill a unit.)
  let parsed;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http(s) URLs allowed' });
  }

  // ── Upstream call ─────────────────────────────────────
  const endpoint =
    'https://production-sfo.browserless.io/chromium/content' +
    `?blockAds=false&timeout=60000&token=${encodeURIComponent(blToken)}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), 65000);

  try {
    const r = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url }),
      signal:  ctrl.signal,
    });

    const html = await r.text();

    if (!r.ok) {
      // Browserless errors are JSON: { error, message, ... }
      // or plain text — surface both.
      return res.status(r.status).json({
        error: 'Browserless upstream error',
        status: r.status,
        body: html.slice(0, 500),
      });
    }

    // Success → raw HTML straight through
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Source', 'browserless/chromium/content');
    return res.status(200).send(html);
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'upstream timeout' : (err?.message || String(err));
    return res.status(502).json({ error: 'Backend failed', message: msg });
  } finally {
    clearTimeout(timer);
  }
};
