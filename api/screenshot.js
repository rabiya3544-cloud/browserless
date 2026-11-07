// api/screenshot.js
// POST { url, token? }  →  { screenshot: "<base64 jpeg>" }
// Thin wrapper around /chromium/screenshot. Deliberately
// independent from /api/browserless and /api/browserless-scroll
// so a failure here never breaks HTML fetching.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  const { url, token } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  const blToken = token || process.env.BROWSERLESS_TOKEN;
  if (!blToken) return res.status(400).json({ error: 'No browserless token' });

  let parsed;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http(s) URLs allowed' });
  }

  const endpoint =
    'https://production-sfo.browserless.io/chromium/screenshot' +
    `?token=${encodeURIComponent(blToken)}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), 55000);

  try {
    const r = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'image/jpeg' },
      body:    JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 35000 },
        waitForTimeout: 2000,
        bestAttempt: true,
        options: { type: 'jpeg', quality: 80, fullPage: false },
        viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      }),
      signal: ctrl.signal,
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({
        error: 'Browserless screenshot error',
        status: r.status,
        body: text.slice(0, 500),
      });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(200).json({
      screenshot: buf.toString('base64'),
      contentType: r.headers.get('content-type') || 'image/jpeg',
    });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'upstream timeout' : (err?.message || String(err));
    return res.status(502).json({ error: 'Backend failed', message: msg });
  } finally {
    clearTimeout(timer);
  }
};
