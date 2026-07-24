/**
 * Client IG Login - Opens browser for manual login (Desktop viewport version)
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const SESSION_PATH = path.resolve(process.cwd(), 'sessions');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

async function dismissPopups(page) {
  const selectors = [
    'button:has-text("Not now")',
    'button:has-text("Not Now")',
    'button:has-text("Later")',
    'button:has-text("Cancel")',
    'button:has-text("Save Info")',
    'button:has-text("Remind Me Later")',
    'button:has-text("Allow all cookies")',
    'button:has-text("Decline optional cookies")',
    'button:has-text("Allow essential and optional cookies")',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await page.waitForTimeout(1000);
      }
    } catch (e) {}
  }
}

async function main() {
  if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

  // Read proxy config if available
  const cfgPath = path.resolve(process.cwd(), 'config.json');
  let proxyConfig = {};
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.proxyServer) {
        proxyConfig = { server: cfg.proxyServer };
        if (cfg.proxyUsername) proxyConfig.username = cfg.proxyUsername;
        if (cfg.proxyPassword) proxyConfig.password = cfg.proxyPassword;
        log(`Using proxy: ${cfg.proxyServer}`);
      }
    } catch (e) {}
  }

  log('=== FounderFlow Engine ===');
  log('A Google Chrome browser window has opened for Instagram login.');
  log('Complete your login below, then this window will close automatically.\n');
  log('IMPORTANT: Do NOT close the browser window until login is confirmed below.\n');
  log('Instructions:');
  log('  1. Enter your Instagram username & password');
  log('  2. Complete any 2FA verification if prompted');
  log('  3. Click "Not Now" on any popup prompts ("Save Info", "Turn on Notifications", etc.)');
  log('  4. Once logged in and on your home feed, the session saves and this window closes.\n');
  
  const context = await chromium.launchPersistentContext(SESSION_PATH, {
    // channel: 'chrome' removed — Docker has no Chrome, use bundled Chromium
    headless: false,
    viewport: null, // Let Chrome open with its default desktop size so buttons aren't cropped
    proxy: Object.keys(proxyConfig).length > 0 ? proxyConfig : undefined,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-automation',
    ],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  const page = await context.newPage();
  
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  log(`Navigating to Instagram...`);
  
  let loadSuccess = false;
  for (let r = 0; r < 3; r++) {
    try {
      await page.goto('https://www.instagram.com/accounts/login/', { 
        waitUntil: 'networkidle', 
        timeout: 60000 
      });
      loadSuccess = true;
      break;
    } catch (e) {
      log(`Retrying page load (${r + 1}/3)... ${e.message}`);
      await page.waitForTimeout(5000);
    }
  }

  if (!loadSuccess) throw new Error('Failed to reach Instagram login page after 3 attempts.');
  
  log('Waiting for login (up to 5 minutes)...');
  let attempts = 0;
  const maxAttempts = 100; // 5 minutes
  
  while (attempts < maxAttempts) {
    await page.waitForTimeout(3000);
    attempts++;

    await dismissPopups(page);
    
    const cookies = await context.cookies('https://www.instagram.com');
    const sessionid = cookies.find(c => c.name === 'sessionid');
    if (sessionid) {
      log('Login detected! Verifying session...');
      
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(3000);
      await dismissPopups(page);
      
      const currentUrl = page.url();
      if (!currentUrl.includes('/login') && !currentUrl.includes('/accounts/')) {
        let username = null;
        try {
          username = await page.evaluate(() => {
            const sel = document.querySelector('[href*="/accounts/edit"]') 
              || document.querySelector('header a[href^="/"]:not([href*="/"])')
              || document.querySelector('a[href*="/"] img[alt*="@"]');
            if (sel) {
              const href = sel.getAttribute('href') || (sel.closest && sel.closest('a')?.getAttribute('href'));
              if (href && href !== '/') return href.replace(/^\//, '').split('/')[0];
            }
            return null;
          });
        } catch (e) {}

        if (username) log(`\nSuccess! Logged in as @${username}`);
        else log('\nLogin confirmed!');
        log('Session saved to: sessions/');
        try {
          const exportCookies = await context.cookies('https://www.instagram.com');
          const cookiePath = path.resolve(process.cwd(), 'ig_session_cookies.json');
          fs.writeFileSync(cookiePath, JSON.stringify(exportCookies, null, 2));
          log(`Exported ${exportCookies.length} cookies to ig_session_cookies.json`);
        } catch (e) { log(`Cookie export failed: ${e.message}`); }
        log('\nYou can close this browser.');
        await context.close();
        return;
      }
    }
    
    if (attempts % 5 === 0) {
      log(`Waiting for login... (${attempts * 3}s / 300s)`);
    }
  }
  
  log('\nTimeout. Login took longer than 5 minutes.');
  await context.close();
  process.exit(1);
}

main().catch(err => {
  log(`Error: ${err.message}`);
  process.exit(1);
});
