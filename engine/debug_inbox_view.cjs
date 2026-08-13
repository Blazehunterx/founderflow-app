// debug_inbox_view.cjs — Opens Chrome with IG session for manual inbox inspection.
process.stdout.write('debug_inbox_view.cjs starting...\n');
try {
  const { chromium } = require('playwright-core');
  process.stdout.write('playwright-core loaded OK\n');
  const path = require('path');
  const fs = require('fs');

  const COOKIES_PATH = path.join(process.cwd(), 'ig_session_cookies.json');
  if (!fs.existsSync(COOKIES_PATH)) { console.error('ig_session_cookies.json not found.'); process.exit(1); }

  const rawCookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
  process.stdout.write('Loaded ' + rawCookies.length + ' cookies.\n');

  (async () => {
    try {
      const browser = await chromium.launch({ headless: false, args: ['--no-first-run', '--disable-blink-features=AutomationControlled'] });
      const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
      await context.addCookies(rawCookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain || '.instagram.com', path: c.path || '/',
        expires: c.expires ? Math.floor(c.expires) : undefined, secure: c.secure !== false,
        httpOnly: c.httpOnly || false, sameSite: c.sameSite || 'Lax',
      })));
      const page = context.pages()[0] || await context.newPage();
      process.stdout.write('Navigating to DM inbox...\n');
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      process.stdout.write('Instagram DM inbox open. Close browser when done.\n');
      browser.on('disconnected', () => process.exit(0));
      await new Promise(() => {});
    } catch (e) { console.error('Error:', e.message); process.exit(1); }
  })();
} catch (e) { console.error('require() failed:', e.message); process.exit(1); }
