// api/browserless-scroll.js
// POST { url, token? }  →  text/html
// Uses /chromium/function to run a custom Puppeteer script that
// scrolls to bottom (triggering lazy loads) before serializing.

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

  // ── The interaction script ──────────────────────────
  // Budget: 35s navigation + up to ~15s scroll + 2s settle ≈ 52s
  const script = `
  async ({ page }) => {
    await page.goto(${JSON.stringify(url)}, {
      waitUntil: 'networkidle2',
      timeout: 35000,
    });

    await page.evaluate(async () => {
      await new Promise(resolve => {
        let iter = 0, lastHeight = 0, stuck = 0;
        const STEP = window.innerHeight * 0.8;
        const timer = setInterval(() => {
          iter++;
          window.scrollBy(0, STEP);
          const h = document.body.scrollHeight;
          if (h === lastHeight) {
            if (++stuck >= 3) { clearInterval(timer); resolve(); }
          } else {
            stuck = 0;
            lastHeight = h;
          }
          if (iter >= 75) { clearInterval(timer); resolve(); }
        }, 200);
      });
    });

    await new Promise(r => setTimeout(r, 2000));

    return await page.content();
  }
`;

  const endpoint =
    'https://production-sfo.browserless.io/chromium/function' +
    `?token=${encodeURIComponent(blToken)}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), 56000);

  try {
    const r = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code: script }),
      signal:  ctrl.signal,
    });

    const text = await r.text();

    if (!r.ok) {
      return res.status(r.status).json({
        error:  'Browserless function error',
        status: r.status,
        body:   text.slice(0, 500),
      });
    }

    // Response is JSON: { data: <returnValue>, ... }
    let html = '';
    try {
      const json = JSON.parse(text);
      html = typeof json?.data === 'string' ? json.data : '';
    } catch {
      // Some configs return raw string directly
      html = text;
    }

    if (!html) {
      return res.status(502).json({ error: 'Function returned no HTML', body: text.slice(0, 300) });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Source', 'browserless/chromium/function');
    res.setHeader('X-Strategy', 'scroll+settle');
    return res.status(200).send(html);
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'upstream timeout' : (err?.message || String(err));
    return res.status(502).json({ error: 'Backend failed', message: msg });
  } finally {
    clearTimeout(timer);
  }
};
