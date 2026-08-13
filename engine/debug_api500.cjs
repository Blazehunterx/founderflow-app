const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log('=== API 500 Debug ===');

  const cookiePath = path.resolve(__dirname, 'ig_session_cookies.json');
  const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
  console.log(`Loaded ${cookies.length} cookies`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  async function testInboxAPI(label) {
    const result = await page.evaluate(async () => {
      let appId = '936619743392459';
      try {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          if (s.textContent.includes('app_id')) {
            const match = s.textContent.match(/"app_id":"(\d+)"/);
            if (match) { appId = match[1]; break; }
          }
        }
      } catch (e) {}
      const res = await fetch('https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&limit=20', {
        credentials: 'include',
        headers: {
          'X-IG-App-ID': appId,
          'X-ASBD-ID': '129477',
          'X-IG-WWW-Claim': '0',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      return { status: res.status, ok: res.ok, body: res.ok ? await res.json().catch(() => null) : await res.text().catch(() => '') };
    });
    const threadCount = result.body?.inbox?.threads?.length || 0;
    console.log(`  [${label}] Status: ${result.status} | Threads: ${threadCount}`);
    if (!result.ok) console.log(`  Body: ${result.body?.substring(0, 200)}`);
    return result;
  }

  // Test 1: From instagram.com homepage
  console.log('\n[1] From homepage (instagram.com/)...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await testInboxAPI('homepage');

  // Test 2: From direct/inbox/ page (like engine does)
  console.log('\n[2] From direct/inbox/ page...');
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await testInboxAPI('inbox_page');

  // Test 3: From inbox page, wait longer
  console.log('\n[3] From inbox page, wait 10s...');
  await page.waitForTimeout(10000);
  await testInboxAPI('inbox_wait10s');

  // Test 4: Navigate to profile, then test
  console.log('\n[4] From profile page...');
  await page.goto('https://www.instagram.com/jani_havunen_author/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await testInboxAPI('profile');

  // Test 5: Back to homepage, test again
  console.log('\n[5] Back to homepage...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await testInboxAPI('homepage_again');

  // Test 6: Rapid fire 3 calls
  console.log('\n[6] Rapid fire 3 calls from homepage...');
  await testInboxAPI('rapid_1');
  await testInboxAPI('rapid_2');
  await testInboxAPI('rapid_3');

  console.log('\n=== Done ===');
  await new Promise(r => setTimeout(r, 30000));
  await browser.close();
})();
