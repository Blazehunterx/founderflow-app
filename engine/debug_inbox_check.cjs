const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log('=== Inbox Debug Check ===');

  const cookiePath = path.resolve(__dirname, 'ig_session_cookies.json');
  if (!fs.existsSync(cookiePath)) {
    console.log('ERROR: ig_session_cookies.json not found');
    return;
  }
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

  // Step 1: Navigate and check login
  console.log('\n[1] Checking login...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const url = page.url();
  const loggedIn = !url.includes('/accounts/login');
  console.log(`  URL: ${url}`);
  console.log(`  Logged in: ${loggedIn}`);
  if (!loggedIn) {
    console.log('  NOT LOGGED IN — session expired. Re-login needed.');
    await browser.close();
    return;
  }

  // Step 2: Primary inbox API
  console.log('\n[2] Primary inbox API...');
  const primaryResult = await page.evaluate(async () => {
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

    const res = await fetch('https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&limit=100', {
      credentials: 'include',
      headers: {
        'X-IG-App-ID': appId,
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': '0',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    if (!res.ok) return { status: res.status, ok: false, body: await res.text().catch(() => '') };
    return { status: res.status, ok: true, body: await res.json().catch(() => null) };
  });

  if (primaryResult.ok && primaryResult.body?.inbox?.threads) {
    const threads = primaryResult.body.inbox.threads;
    const myId = cookies.find(c => c.name === 'ds_user_id')?.value;
    console.log(`  Status: ${primaryResult.status} — ${threads.length} threads`);
    for (const t of threads) {
      const handle = t.users?.[0]?.username || 'unknown';
      const lastItem = t.items?.[0];
      const lastSenderId = lastItem?.user_id;
      const isThem = lastSenderId !== myId;
      const readState = t.read_state;
      const lastText = (lastItem?.text || lastItem?.item_type || '').substring(0, 80);
      console.log(`  @${handle} | read:${readState} | ${isThem ? 'THEM' : 'ME'} last | "${lastText}"`);
    }
  } else {
    console.log(`  FAILED: status ${primaryResult.status}`);
    console.log(`  Body: ${primaryResult.body?.substring?.(0, 500) || JSON.stringify(primaryResult.body)?.substring(0, 500)}`);
  }

  // Step 3: Pending/Requests API
  console.log('\n[3] Pending/Requests API...');
  const pendingResult = await page.evaluate(async () => {
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

    const res = await fetch('https://www.instagram.com/api/v1/direct_v2/inbox/?folder=pending&limit=100', {
      credentials: 'include',
      headers: {
        'X-IG-App-ID': appId,
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': '0',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    if (!res.ok) return { status: res.status, ok: false, body: await res.text().catch(() => '') };
    return { status: res.status, ok: true, body: await res.json().catch(() => null) };
  });

  if (pendingResult.ok && pendingResult.body?.inbox?.threads) {
    const threads = pendingResult.body.inbox.threads;
    const myId = cookies.find(c => c.name === 'ds_user_id')?.value;
    console.log(`  Status: ${pendingResult.status} — ${threads.length} threads`);
    for (const t of threads) {
      const handle = t.users?.[0]?.username || 'unknown';
      const lastItem = t.items?.[0];
      const lastSenderId = lastItem?.user_id;
      const isThem = lastSenderId !== myId;
      const readState = t.read_state;
      const lastText = (lastItem?.text || lastItem?.item_type || '').substring(0, 80);
      console.log(`  @${handle} | read:${readState} | ${isThem ? 'THEM' : 'ME'} last | "${lastText}"`);
    }
  } else {
    console.log(`  FAILED: status ${pendingResult.status}`);
    console.log(`  Body: ${pendingResult.body?.substring?.(0, 500) || JSON.stringify(pendingResult.body)?.substring(0, 500)}`);
  }

  // Step 4: Summary
  console.log('\n=== Done ===');
  console.log('Browser stays open for 30 seconds. Inspect manually if needed.');
  await new Promise(r => setTimeout(r, 30000));
  await browser.close();
})();
