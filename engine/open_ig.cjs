// open_ig.cjs — Opens Chrome with Olive's IG session for manual debugging.
// Usage: node open_ig.cjs
process.stdout.write('open_ig.cjs starting...\n');
try {
  const { chromium } = require('playwright-core');
  process.stdout.write('playwright-core loaded OK\n');
  const path = require('path');
  const fs = require('fs');

  const COOKIES_PATH = path.join(process.cwd(), 'ig_session_cookies.json');
  process.stdout.write('Cookies path: ' + COOKIES_PATH + '\n');

  function findChrome() {
    for (const p of [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ]) { if (fs.existsSync(p)) return p; }
    return null;
  }

  (async () => {
    try {
      const chromePath = findChrome();
      if (!chromePath) { console.error('Chrome not found.'); process.exit(1); }
      process.stdout.write('Chrome: ' + chromePath + '\n');
      if (!fs.existsSync(COOKIES_PATH)) { console.error('ig_session_cookies.json not found.'); process.exit(1); }

      const rawCookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
      process.stdout.write('Loaded ' + rawCookies.length + ' cookies.\n');

      const browser = await chromium.launch({ headless: false, executablePath: chromePath, args: ['--no-first-run', '--disable-blink-features=AutomationControlled'] });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

      await context.addCookies(rawCookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain || '.instagram.com', path: c.path || '/',
        expires: c.expires ? Math.floor(c.expires) : undefined, secure: c.secure !== false,
        httpOnly: c.httpOnly || false, sameSite: c.sameSite || 'Lax',
      })));

      const page = context.pages()[0] || await context.newPage();
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);

      const loggedIn = await page.evaluate(() => !document.querySelector('input[name="username"]')).catch(() => false);
      if (!loggedIn) { console.error('Session dead. Run: node login.cjs'); await browser.close(); process.exit(1); }

      await page.click('button:has-text("Not Now")').catch(() => {});
      await page.waitForTimeout(1000);
      await page.click('button:has-text("Not Now")').catch(() => {});

      process.stdout.write('\n=== Browser is open on Instagram inbox ===\n');
      process.stdout.write('Press F12, go to Console, paste the debug script.\n');
      process.stdout.write('Close this window or press Ctrl+C when done.\n');

      browser.on('disconnected', () => { process.stdout.write('Browser closed.\n'); process.exit(0); });
      await new Promise(() => {});
    } catch (e) { console.error('Error:', e.message); process.exit(1); }
  })();
} catch (e) { console.error('require() failed:', e.message); process.exit(1); }
