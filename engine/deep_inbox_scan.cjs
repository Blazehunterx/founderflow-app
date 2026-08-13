/**
 * ONE-TIME DEEP INBOX SCAN
 * Scans ALL inbox threads (no page limit) and lists all unread messages
 * Run once to see what the engine missed, then the normal engine takes over
 *
 * Usage: node deep_inbox_scan.cjs
 */
const path = require('path');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'config.json'), 'utf8'));
const { delay } = require('./sender.cjs');

const TERMINAL_STEP = 99;

async function fetchLeads() {
  const url = `${config.supabaseUrl}/rest/v1/leads?workspace_id=eq.${config.workspaceId}&conversation_step=lt.${TERMINAL_STEP}&select=id,ig_handle,status,conversation_step,first_name,bio,follower_count`;
  const res = await fetch(url, {
    headers: {
      'apikey': config.supabaseAnonKey,
      'Authorization': `Bearer ${config.supabaseAnonKey}`
    }
  });
  if (!res.ok) return [];
  return await res.json();
}

function log(level, tag, msg) {
  const ts = new Date().toISOString();
  const prefix = { info: '🔵', warn: '⚠️', success: '✅', error: '❌' }[level] || '⚪';
  console.log(`[${ts}] ${prefix} [${tag}] ${msg}`);
}

async function main() {
  log('info', 'DEEP_SCAN', '=== ONE-TIME DEEP INBOX SCAN ===');
  log('info', 'DEEP_SCAN', 'Scanning ALL unread threads, no page limit');

  // Dynamic import of playwright
  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch (e) {
    chromium = require('playwright-core').chromium;
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  // Load cookies
  const cookiePath = path.resolve(__dirname, 'ig_session_cookies.json');
  if (fs.existsSync(cookiePath)) {
    const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
    await context.addCookies(cookies);
    log('info', 'DEEP_SCAN', `Loaded ${cookies.length} cookies`);
  }

  const page = await context.newPage();
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(3000);

  // Check if logged in
  const isLoggedIn = await page.evaluate(() => {
    return !document.querySelector('input[name="username"]');
  });
  if (!isLoggedIn) {
    log('error', 'DEEP_SCAN', 'Not logged in. Run login.cjs first.');
    await browser.close();
    return;
  }
  log('success', 'DEEP_SCAN', 'Logged in');

  // Scan ALL pages
  let cursor = null;
  let pageCount = 0;
  let totalThreads = 0;
  let totalUnread = 0;
  let retries = 3;
  const allThreads = [];

  log('info', 'DEEP_SCAN', 'Starting full inbox scan...');

  while (true) {
    const cursorParam = cursor ? '&cursor=' + encodeURIComponent(typeof cursor === 'string' ? cursor : JSON.stringify(cursor)) : '';

    let data;
    try {
      data = await page.evaluate(async (cp) => {
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
        const url = 'https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&limit=100' + cp;
        const res = await fetch(url, {
          credentials: 'include',
          headers: {
            'X-IG-App-ID': appId,
            'X-ASBD-ID': '129477',
            'X-IG-WWW-Claim': '0',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });
        if (!res.ok) return { error: res.status };
        return await res.json();
      }, cursorParam);
    } catch (e) {
      log('warn', 'DEEP_SCAN', `Page.evaluate threw on page ${pageCount + 1}: ${e.message}`);
      data = { error: 'evaluate_failed' };
    }

    const errorCode = data?.error;
    if (errorCode === 500 || errorCode === 429 || errorCode === 'evaluate_failed') {
      log('warn', 'DEEP_SCAN', `API error ${errorCode} on page ${pageCount + 1}, retrying in 30s... (retries left: ${retries - 1})`);
      await delay(30000);
      retries--;
      if (retries <= 0) {
        log('warn', 'DEEP_SCAN', `Max retries reached, stopping scan`);
        break;
      }
      continue;
    }

    if (!data?.inbox?.threads) {
      log('warn', 'DEEP_SCAN', `No threads data at page ${pageCount + 1}: ${JSON.stringify(data).substring(0, 200)}`);
      break;
    }

    retries = 3;
    const threads = data.inbox.threads;
    pageCount++;
    totalThreads += threads.length;

    // Filter to threads where other person sent last (unread replies)
    const myId = data.viewer?.pk || '';
    for (const t of threads) {
      if (!t.items || t.items.length === 0) continue;
      const lastItem = t.items[0];
      const isMe = lastItem.user_id === String(myId);
      if (!isMe) {
        const username = t.users?.[0]?.username || t.thread_title?.toLowerCase() || '';
        const threadId = t.thread_id;
        allThreads.push({ username, threadId, lastText: (lastItem.text || '').substring(0, 80) });
        totalUnread++;
      }
    }

    // Pagination: Instagram uses has_older + next_cursor/oldest_cursor (NOT has_more/cursor)
    const nextCursor = data.inbox.next_cursor || data.inbox.oldest_cursor || data.inbox.cursor || data.inbox.next_max_id || null;
    const hasMore = (data.inbox.has_older === true || data.inbox.has_more_items === true) && nextCursor !== null;

    log('info', 'DEEP_SCAN', `Page ${pageCount}: ${threads.length} threads scanned, ${totalUnread} unread so far, hasMore:${hasMore}`);

    if (!hasMore || !nextCursor) {
      log('info', 'DEEP_SCAN', `No more pages after page ${pageCount}`);
      break;
    }
    cursor = nextCursor;

    // Rate limit between pages — longer delay to avoid 500s
    await delay(20000 + Math.random() * 15000);
  }

  log('info', 'DEEP_SCAN', `\n=== SCAN COMPLETE: ${pageCount} pages, ${totalThreads} threads, ${totalUnread} unread ===\n`);

  if (totalUnread === 0) {
    log('success', 'DEEP_SCAN', 'No unread messages found. All clean!');
    await browser.close();
    return;
  }

  // Dedup
  const seen = new Set();
  const unique = allThreads.filter(t => {
    if (seen.has(t.username)) return false;
    seen.add(t.username);
    return true;
  });

  log('info', 'DEEP_SCAN', `${unique.length} unique unread threads found\n`);

  // Match to leads in DB for status context
  const leads = await fetchLeads();

  const leadMap = {};
  for (const l of (leads || [])) {
    leadMap[l.ig_handle.toLowerCase()] = l;
  }

  // Print all unread threads with their last message
  log('info', 'DEEP_SCAN', '=== UNREAD THREADS ===');
  for (const t of unique) {
    const lead = leadMap[t.username];
    const status = lead ? `status=${lead.status} step=${lead.conversation_step}` : 'NOT IN DB';
    log('info', 'DEEP_SCAN', `@${t.username} | ${status} | "${t.lastText}" | threadId=${t.threadId}`);
  }
  log('info', 'DEEP_SCAN', '=== END UNREAD THREADS ===\n');

  // Summary
  const inDb = unique.filter(t => leadMap[t.username]);
  const notInDb = unique.filter(t => !leadMap[t.username]);
  log('info', 'DEEP_SCAN', `Summary: ${inDb.length} in DB, ${notInDb.length} not in DB`);
  log('info', 'DEEP_SCAN', 'Normal engine will handle replies on its next pulse.');

  await browser.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
