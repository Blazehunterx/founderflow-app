/**
 * Ghost.cjs — Injects IG session cookies from scratch/ig_session_cookies.json
 * into the engine's Playwright session directory.
 * Usage: node ghost.cjs [path-to-cookies.json]
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const SESSION_PATH = path.resolve(process.cwd(), 'sessions');

async function main() {
  // Find cookies file
  let cookiesPath = process.argv[2];
  if (!cookiesPath) {
    // Try relative paths from engine directory
    const candidates = [
      path.resolve(process.cwd(), '..', 'scratch', 'ig_session_cookies.json'),
      path.resolve(process.cwd(), '..', '..', 'scratch', 'ig_session_cookies.json'),
    ];
    cookiesPath = candidates.find(f => fs.existsSync(f));
  }
  if (!cookiesPath || !fs.existsSync(cookiesPath)) {
    console.log('❌ Cookies file not found. Pass path: node ghost.cjs ./ig_session_cookies.json');
    process.exit(1);
  }

  const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
  if (!Array.isArray(cookies) || cookies.length === 0) {
    console.log('❌ Invalid cookies file — expected array of cookie objects.');
    process.exit(1);
  }

  // Validate critical cookies
  const hasSession = cookies.some(c => c.name === 'sessionid' && c.value);
  const hasUserId = cookies.some(c => c.name === 'ds_user_id' && c.value);
  if (!hasSession || !hasUserId) {
    console.log('❌ Missing sessionid or ds_user_id cookies. Re-extract from browser.');
    process.exit(1);
  }

  if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

  // Format cookies for Playwright (convert expires ms → seconds)
  const playCookies = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '.instagram.com',
    path: c.path || '/',
    expires: c.expires ? Math.floor(c.expires) : undefined,
    secure: c.secure !== false,
    httpOnly: c.httpOnly || false,
    sameSite: c.sameSite || 'Lax',
  }));

  const context = await chromium.launchPersistentContext(SESSION_PATH, {
    headless: false,
    viewport: { width: 390, height: 844 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  await context.addCookies(playCookies);

  const page = await context.newPage();
  console.log('🚀 Launching Instagram with injected session...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Check if logged in
  await page.waitForTimeout(3000);
  const url = page.url();
  const loginPage = url.includes('/login') || url.includes('/accounts/');

  if (loginPage) {
    console.log('⚠️ Session didn\'t stick — Instagram wants login. Cookies may be expired.');
    console.log('   Close the browser, re-extract fresh cookies, and try again.');
  } else {
    console.log(`✅ Ghosted! Instagram logged in as @scott_northwolf`);
    console.log(`   Session saved to sessions/ — engine will use it automatically.`);
    console.log(`   You can close the browser now.`);
  }

  await new Promise(() => {});
  await context.close();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
