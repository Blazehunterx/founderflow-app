/**
 * Cookie Injector — launches Instagram already logged in using cookies from your real browser.
 * Usage: node inject_cookies.cjs
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const SESSION_PATH = path.resolve(process.cwd(), 'sessions');
const CFG_PATH = path.resolve(process.cwd(), 'config.json');

async function main() {
  if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

  // Check if already have a session
  let currentSession = false;
  try {
    const testContext = await chromium.launchPersistentContext(SESSION_PATH, { headless: true });
    const cookies = await testContext.cookies('https://www.instagram.com');
    currentSession = cookies.some(c => c.name === 'sessionid');
    await testContext.close();
  } catch (e) {}

  if (currentSession) {
    console.log('Session already exists. Run START.hta to start the engine.');
    return;
  }

  // Prompt for cookie values
  const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => readline.question(q, r));

  console.log('\n=== Instagram Cookie Injector ===');
  console.log('1. Open Chrome DevTools on instagram.com (you must be logged in)');
  console.log('2. Go to Application tab > Cookies > instagram.com');
  console.log('3. Find and copy the VALUES for these cookies:\n');

  const sessionid = await ask('sessionid value: ');
  const ds_user_id = await ask('ds_user_id value: ');
  const csrftoken = await ask('csrftoken value: ');
  readline.close();

  if (!sessionid || !ds_user_id) {
    console.log('sessionid and ds_user_id are required.');
    return;
  }

  const context = await chromium.launchPersistentContext(SESSION_PATH, {
    headless: false,
    viewport: { width: 390, height: 844 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  await context.addCookies([
    { name: 'sessionid', value: sessionid, domain: '.instagram.com', path: '/' },
    { name: 'ds_user_id', value: ds_user_id, domain: '.instagram.com', path: '/' },
    { name: 'csrftoken', value: csrftoken || '', domain: '.instagram.com', path: '/' },
  ]);

  const page = await context.newPage();
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('\nNavigating to Instagram... If you see your feed, the session works!');
  console.log('Close the browser window when done. The engine can now use this session.\n');

  // Wait for browser to close
  await new Promise(() => {});
  await context.close();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
