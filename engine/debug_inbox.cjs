const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(__dirname, 'ig_session_cookies.json');

async function main() {
  console.log('=== INBOX DEBUG SCRIPT ===');
  console.log('Loading cookies from', COOKIE_FILE);

  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(cookies);
  const page = await context.newPage();

  // 1. Navigate to inbox
  console.log('\n--- STEP 1: Navigate to inbox ---');
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  console.log('URL:', page.url());

  // 2. Capture API responses
  console.log('\n--- STEP 2: Monitor API responses ---');
  const apiThreads = [];
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (url.includes('/direct_v2/inbox') || url.includes('/direct_v2/pending')) {
        const data = await response.json().catch(() => null);
        if (data?.inbox?.threads) {
          for (const thread of data.inbox.threads) {
            if (!thread.items?.length) continue;
            const lastItem = thread.items[0];
            const username = thread.users?.[0]?.username || 'unknown';
            const isUnread = !thread.read_state;
            const isMe = lastItem.user_id === (thread.viewer_id || thread.own_recipient_user_id);
            apiThreads.push({
              threadId: thread.thread_id,
              username,
              isUnread,
              isMe,
              lastText: (lastItem.text || '').substring(0, 80),
              lastType: lastItem.item_type,
              userId: lastItem.user_id,
              viewerId: thread.viewer_id,
              itemCount: thread.items?.length || 0
            });
          }
          console.log(`[API] Captured ${data.inbox.threads.length} threads (hasMore: ${data.inbox.has_more}, cursor: ${data.inbox.next_cursor ? 'yes' : 'no'})`);
        }
      }
    } catch (e) {}
  });

  // 3. Scroll to trigger API calls
  console.log('\n--- STEP 3: Scroll to load threads ---');
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
  }

  // 4. DOM extraction
  console.log('\n--- STEP 4: DOM extraction ---');
  const domThreads = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Try aria-label first
    let container = document.querySelector('div[aria-label="Thread list"]');
    if (!container) {
      container = document.querySelector('div[role="navigation"]')?.parentElement || document;
      console.log('[DOM] Using fallback container:', container.tagName);
    } else {
      console.log('[DOM] Found Thread list container');
    }

    const buttons = container.querySelectorAll('[role="button"]');
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      const rect = btn.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 30 || rect.height > 120 || !text.includes('·')) continue;

      let username = null;
      let realThreadId = null;

      // Username from profile link
      const a = btn.querySelector('a[href^="/"]:not([href*="/direct/"])');
      if (a) username = a.getAttribute('href')?.replace(/^\//, '').replace(/\/$/, '');

      // Thread ID from DM link
      const dmLink = btn.querySelector('a[href*="/direct/t/"]');
      if (dmLink) {
        const href = dmLink.getAttribute('href') || '';
        const tidMatch = href.match(/\/direct\/t\/(\d+)/);
        if (tidMatch) realThreadId = tidMatch[1];
      }

      if (!username || username.length < 2) continue;

      const key = realThreadId || username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        threadId: realThreadId || username.toLowerCase(),
        username: username.toLowerCase(),
        isUnread: text.includes('Unread'),
        text: text.substring(0, 120),
        hasDmLink: !!dmLink
      });
    }
    return results;
  });

  console.log(`[DOM] Found ${domThreads.length} threads`);
  const unread = domThreads.filter(t => t.isUnread);
  console.log(`[DOM] Unread: ${unread.length}`);

  // 5. Show results
  console.log('\n--- RESULTS ---');
  console.log(`API threads: ${apiThreads.length}`);
  console.log(`DOM threads: ${domThreads.length}`);

  if (apiThreads.length > 0) {
    console.log('\n--- API THREADS (first 20) ---');
    const unreadApi = apiThreads.filter(t => t.isUnread);
    const readApi = apiThreads.filter(t => !t.isUnread);
    console.log(`Unread: ${unreadApi.length}, Read: ${readApi.length}`);

    console.log('\nUnread threads:');
    for (const t of unreadApi.slice(0, 20)) {
      console.log(`  @${t.username} threadId:${t.threadId} isMe:${t.isMe} type:${t.lastType} "${t.lastText}"`);
    }

    console.log('\nRead threads with last msg from them (potential replies needed):');
    const needsReply = readApi.filter(t => !t.isMe).slice(0, 20);
    for (const t of needsReply) {
      console.log(`  @${t.username} threadId:${t.threadId} isMe:${t.isMe} type:${t.lastType} "${t.lastText}"`);
    }
  }

  if (domThreads.length > 0) {
    console.log('\n--- DOM THREADS (first 20) ---');
    for (const t of domThreads.slice(0, 20)) {
      console.log(`  @${t.username} threadId:${t.threadId} unread:${t.isUnread} hasDmLink:${t.hasDmLink}`);
    }
  }

  // 6. Check for threads with real thread IDs vs username-only
  const withRealId = domThreads.filter(t => /^\d+$/.test(t.threadId));
  const withUsernameId = domThreads.filter(t => !/^\d+$/.test(t.threadId));
  console.log(`\n--- THREAD ID ANALYSIS ---`);
  console.log(`DOM threads with real numeric ID: ${withRealId.length}`);
  console.log(`DOM threads with username as ID: ${withUsernameId.length}`);
  if (withUsernameId.length > 0) {
    console.log('Username-only IDs (sending will fail):');
    for (const t of withUsernameId.slice(0, 10)) {
      console.log(`  @${t.username} → threadId: "${t.threadId}" (NOT a real ID)`);
    }
  }

  console.log('\n=== DEBUG COMPLETE ===');
  console.log('Browser staying open for 30 seconds for manual inspection...');
  await page.waitForTimeout(30000);
  await browser.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
