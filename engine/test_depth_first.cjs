#!/usr/bin/env node
/**
 * Test: Depth-first Request thread processing
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const COOKIES_PATH = path.join(process.cwd(), 'ig_session_cookies.json');
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  if (!fs.existsSync(COOKIES_PATH)) { console.error('ig_session_cookies.json not found.'); process.exit(1); }
  const rawCookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
  console.log('Loaded', rawCookies.length, 'cookies.');

  const browser = await chromium.launch({ headless: false, args: ['--no-first-run', '--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(rawCookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain || '.instagram.com', path: c.path || '/',
    expires: c.expires ? Math.floor(c.expires) : undefined, secure: c.secure !== false,
    httpOnly: c.httpOnly || false, sameSite: c.sameSite || 'Lax',
  })));
  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  console.log('\n=== Step 1: Navigate to Requests ===');
  await page.goto('https://www.instagram.com/direct/requests/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(8000);

  const loggedIn = await page.evaluate(() => !document.querySelector('input[name="username"]')).catch(() => false);
  if (!loggedIn) { console.error('Session dead.'); await browser.close(); process.exit(1); }
  console.log('Logged in OK');

  // Only 1 scroll to load a few threads - don't scroll too far
  await page.evaluate(() => {
    document.querySelectorAll('div').forEach(d => {
      const s = getComputedStyle(d);
      if ((s.overflow === 'auto' || s.overflow === 'scroll' || s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 50) {
        d.scrollBy(0, 400);
      }
    });
  });
  await delay(2000);

  console.log('\n=== Step 2: Find top unread thread ===');
  const unreadThread = await page.evaluate(() => {
    const btns = document.querySelectorAll('div[role="button"]');
    for (const b of btns) {
      const t = b.textContent.trim();
      const rect = b.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 30 && rect.height < 120 && t.includes('Unread')) {
        let u = null;
        const a = b.querySelector('a[href^="/"]:not([href*="/direct/"])');
        if (a) u = a.getAttribute('href')?.replace(/^\//, '').replace(/\/$/, '');
        if (!u) { const fw = t.match(/^([a-zA-Z0-9._]+)/); if (fw) u = fw[1]; }
        if (u && u.length > 1) {
          b.scrollIntoView({ block: 'center' });
          return { username: u.toLowerCase(), text: t.substring(0, 120) };
        }
      }
    }
    return null;
  });

  if (!unreadThread) { console.log('No unread threads found.'); await browser.close(); return; }
  console.log('Found:', unreadThread.username);
  console.log('Text:', unreadThread.text);
  await delay(1500);

  console.log('\n=== Step 3: Click thread ===');
  await page.evaluate((username) => {
    const btns = document.querySelectorAll('div[role="button"]');
    for (const b of btns) {
      const t = b.textContent.trim();
      if (t.toLowerCase().includes(username) && t.includes('Unread')) { b.click(); return; }
    }
  }, unreadThread.username);

  try { await page.waitForURL(/\/direct\/t\//, { timeout: 10000 }); } catch (e) {}
  await delay(3000);

  const urlMatch = page.url().match(/\/direct\/t\/(\d+)/);
  if (!urlMatch) { console.log('No thread ID in URL:', page.url()); await browser.close(); return; }
  console.log('Thread ID:', urlMatch[1]);

  // Step 4: Accept
  console.log('\n=== Step 4: Accept ===');
  const acceptClicked = await page.evaluate(() => {
    const all = document.querySelectorAll('button, div[role="button"], span');
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (t === 'Accept' || t === 'Accept request') {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return t;
      }
    }
    return null;
  });
  console.log('Accept result:', acceptClicked || 'not found');
  await delay(2000);

  // Step 4b: Handle "Move messages from X into:" dialog
  console.log('\n=== Step 4b: Move to Primary dialog ===');
  let movedToPrimary = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    // Take a screenshot for debugging every 5 attempts
    if (attempt % 5 === 0) {
      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
      if (pageText.includes('Move messages') || attempt === 0) {
        console.log(`Attempt ${attempt}: Looking for Primary button...`);
      }
    }

    movedToPrimary = await page.evaluate(() => {
      // Strategy 1: find ALL clickable elements and match "Primary" text exactly
      const allClickable = document.querySelectorAll('button, div[role="button"], span, a, div');
      for (const el of allClickable) {
        const t = (el.textContent || '').trim();
        const rect = el.getBoundingClientRect();
        // Must be visible and exact match
        if (t === 'Primary' && rect.width > 0 && rect.height > 0 && rect.width < 300) {
          el.click();
          return 'exact';
        }
      }
      // Strategy 2: find by "Move messages" dialog context
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (el.children.length === 0 && (el.textContent || '').trim() === 'Primary') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            el.click();
            return 'leaf';
          }
        }
      }
      return null;
    });

    if (movedToPrimary) {
      console.log('Clicked Primary via', movedToPrimary);
      await delay(3000);
      break;
    }
    await delay(500);
  }

  if (!movedToPrimary) {
    // Debug: dump dialog/modal DOM structure
    const debugInfo = await page.evaluate(() => {
      const results = [];
      // Find any overlay/modal/dialog
      const candidates = document.querySelectorAll('[role="dialog"], [role="presentation"], [data-testid], [class*="modal"], [class*="dialog"], [class*="overlay"], [class*="Modal"], [class*="Dialog"]');
      for (const c of candidates) {
        results.push({ type: c.tagName, role: c.getAttribute('role'), testid: c.getAttribute('data-testid'), class: (c.className || '').substring(0, 80) });
        // Dump all leaf elements inside
        c.querySelectorAll('*').forEach(el => {
          if (el.children.length === 0 && (el.textContent || '').trim()) {
            results.push({ tag: el.tagName, text: el.textContent.trim().substring(0, 40), rect: { x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } });
          }
        });
      }
      // Also dump all visible text in center of screen (where dialog should be)
      const centerTexts = [];
      document.querySelectorAll('*').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.x > 200 && r.x < 800 && r.y > 200 && r.y < 600 && r.width > 0 && el.children.length === 0 && (el.textContent || '').trim()) {
          centerTexts.push({ tag: el.tagName, text: el.textContent.trim().substring(0, 40), x: Math.round(r.x), y: Math.round(r.y) });
        }
      });
      return { dialogs: results.slice(0, 30), centerScreen: centerTexts.slice(0, 20) };
    });
    console.log('Dialog elements:', JSON.stringify(debugInfo.dialogs, null, 2));
    console.log('Center screen texts:', JSON.stringify(debugInfo.centerScreen, null, 2));
  }

  // Step 5: Check for message input
  console.log('\n=== Step 5: Message input ===');
  await delay(2000);
  const chatBox = page.locator('[role="main"] div[contenteditable="true"], div[contenteditable="true"], [placeholder*="Message"], div[role="textbox"]').first();
  const chatVisible = await chatBox.isVisible({ timeout: 5000 }).catch(() => false);
  console.log('Message input visible:', chatVisible);

  if (chatVisible) {
    const testReply = 'test reply - please ignore';
    console.log('\n=== Step 6: Sending:', testReply);
    await chatBox.click();
    await delay(500);
    for (const char of testReply) {
      await chatBox.type(char, { delay: 50 + Math.random() * 100 });
    }
    await delay(1000);

    const sent = await page.evaluate(() => {
      const btns = document.querySelectorAll('button, div[role="button"]');
      for (const b of btns) {
        if ((b.textContent || '').trim().toLowerCase() === 'send') { b.click(); return 'button'; }
      }
      return null;
    });
    if (sent) console.log('Sent via Send button');
    else { await page.keyboard.press('Enter'); console.log('Sent via Enter'); }
    await delay(3000);

    const empty = !(await chatBox.textContent().catch(() => '')).trim();
    console.log(empty ? 'SUCCESS: Message sent!' : 'WARNING: May not have sent');
  } else {
    console.log('Chat box not visible');
    const btns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, div[role="button"]')).map(b => b.textContent.trim()).filter(Boolean).slice(0, 15);
    });
    console.log('Visible buttons:', btns);
  }

  console.log('\n=== Done ===');
  console.log('URL:', page.url());
  await delay(3000);
  await browser.close();
})();
