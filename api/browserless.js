// api/browserless.js
// POST { url, token? }  →  text/html
// Uses /chromium/content with a "fully loaded" wait strategy:
//   - navigation waits for networkidle2 (≤2 in-flight requests for 500ms)
//   - 2s extra render window after idle
//   - bestAttempt=true so partial HTML is returned instead of erroring

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
  if (!blToken) {
    return res.status(400).json({
      error: 'No browserless token',
      hint: 'Send {token} in the body, or set BROWSERLESS_TOKEN in Vercel env.',
    });
  }

  let parsed;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http(s) URLs allowed' });
  }

  // ── Wait strategy ─────────────────────────────────────
  // timeout=50000             → overall browserless session budget
  // gotoOptions.timeout=45000 → navigation-specific budget
  // networkidle2              → ≤2 in-flight requests for 500ms
  // waitForTimeout=2000       → extra render window after idle
  // bestAttempt=true          → return partial HTML instead of throwing
  //
  // Worst case: 45s + 2s = 47s, under both browserless's 50s
  // session cap and Vercel's 60s maxDuration.
  const endpoint =
    'https://production-sfo.browserless.io/chromium/content' +
    `?blockAds=false&timeout=50000&token=${encodeURIComponent(blToken)}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), 55000);

  try {
    const r = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        url,
        gotoOptions: {
          waitUntil: 'networkidle2',
          timeout:   45000,
        },
        waitForTimeout: 2000,
        bestAttempt:    true,
      }),
      signal: ctrl.signal,
    });

    const html = await r.text();

    if (!r.ok) {
      return res.status(r.status).json({
        error:  'Browserless upstream error',
        status: r.status,
        body:   html.slice(0, 500),
      });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Source', 'browserless/chromium/content');
    res.setHeader('X-Wait-Strategy', 'networkidle2+2000');
    return res.status(200).send(html);
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'upstream timeout' : (err?.message || String(err));
    return res.status(502).json({ error: 'Backend failed', message: msg });
  } finally {
    clearTimeout(timer);
  }
};
