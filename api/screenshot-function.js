// api/screenshot-function.js
// POST { url, token? }  →  { screenshot }
// Same interface as /api/screenshot, but uses /chromium/function.
// Kept separate so a failure here doesn't affect the working endpoint.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { return res.status(204).end(); }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'POST only' }); }

  const { url, token } = req.body || {};
  if (!url) { return res.status(400).json({ error: 'url is required' }); }

  const blToken = token || process.env.BROWSERLESS_TOKEN;
  if (!blToken) { return res.status(400).json({ error: 'No browserless token' }); }

  let parsed;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http(s) URLs allowed' });
  }

  // ESM default-export — the form implied by the three prior
  // failures together:
  //   module.exports  → "module is not defined"      (not CJS)
  //   bare arrow      → "code is not a function"     (bare expression, not a body)
  //   return bare     → "Illegal return statement"   (top-level return in module)
  const script = `
export default async ({ page }) => {
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(${JSON.stringify(url)}, {
    waitUntil: 'networkidle2',
    timeout: 35000,
  });
  await new Promise(r => setTimeout(r, 2000));

  const shot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 80 });
  return { screenshot: shot.toString('base64') };
};
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

    // Try the shapes /chromium/function has used across versions.
    const data = json?.data ?? json?.result ?? json;
    const screenshot = data?.screenshot ?? data?.data?.screenshot;

    if (typeof screenshot !== 'string' || !screenshot) {
      return res.status(502).json({ error: 'No screenshot in response', body: text.slice(0, 300) });
    }

    return res.status(200).json({ screenshot });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'upstream timeout' : (err?.message || String(err));
    return res.status(502).json({ error: 'Backend failed', message: msg });
  } finally {
    clearTimeout(timer);
  }
};
