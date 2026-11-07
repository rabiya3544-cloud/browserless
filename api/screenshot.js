/// api/screenshot.js
// POST { url, token?, mobile?, colorScheme? }  →  { screenshot }
// Uses /chromium/function for full emulation control:
//   - mobile viewport (iPhone-sized by default)
//   - mobile user agent
//   - prefers-color-scheme: dark (matches most devs' system)
// Override via body: { mobile: false, colorScheme: 'light' }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  const { url, token, mobile = true, colorScheme = 'dark' } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  const blToken = token || process.env.BROWSERLESS_TOKEN;
  if (!blToken) return res.status(400).json({ error: 'No browserless token' });

  let parsed;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http(s) URLs allowed' });
  }

  // Mobile: iPhone 14-ish. Desktop: 1280×800 to match the HTML endpoint.
  const viewport = mobile
    ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { width: 1280, height: 800, deviceScaleFactor: 1 };

  const ua = mobile
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // Pass JSON-serialisable values into the script.
  const script = `
    async ({ page }) => {
      await page.setViewport(${JSON.stringify(viewport)});
      await page.setUserAgent(${JSON.stringify(ua)});
      await page.emulateMediaFeatures([
        { name: 'prefers-color-scheme', value: ${JSON.stringify(colorScheme)} }
      ]);

      await page.goto(${JSON.stringify(url)}, {
        waitUntil: 'networkidle2',
        timeout: 35000,
      });
      await new Promise(r => setTimeout(r, 2000));

      const shot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 80 });
      return { screenshot: shot.toString('base64') };
    }
  `;

  const endpoint =
    'https://production-sfo.browserless.io/chromium/function' +
    `?token=${encodeURIComponent(blToken)}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), 55000);

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

    let json;
    try { json = JSON.parse(text); }
    catch { return res.status(502).json({ error: 'Response was not JSON', body: text.slice(0, 300) }); }

    const data = json?.data;
    if (!data || typeof data.screenshot !== 'string') {
      return res.status(502).json({ error: 'No screenshot in response', body: text.slice(0, 300) });
    }

    return res.status(200).json({ screenshot: data.screenshot });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'upstream timeout' : (err?.message || String(err));
    return res.status(502).json({ error: 'Backend failed', message: msg });
  } finally {
    clearTimeout(timer);
  }
};
