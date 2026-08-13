// F12 Console — tests inline scroll+click approach for DOM fallback
// Paste this ENTIRE script in F12 Console on instagram.com/direct/inbox/
// Tests: scroll → find unread → click → get thread ID → log → back → continue
// Does NOT send any replies — diagnostic only

(async () => {
  console.log('=== DOM Click Test: Inline scroll+click ===');
  console.log('Scrolls inbox, clicks each unread thread, logs thread ID, goes back.');
  console.log('Does NOT send any messages.\n');

  const MAX_THREADS = 5;
  const seen = new Set();
  const results = [];

  // Helper: scroll all scrollable elements
  const scrollDown = async () => {
    await new Promise(r => {
      document.querySelectorAll('div').forEach(d => {
        const s = getComputedStyle(d);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 50) {
          d.scrollBy(0, 800);
        }
      });
      const sc = document.querySelector('div[role="navigation"]')?.parentElement;
      if (sc) sc.scrollBy(0, 800);
      window.scrollBy(0, 800);
      setTimeout(r, 1500);
    });
  };

  // Helper: find unread threads in current view
  const findUnread = () => {
    const targets = [];
    for (const b of document.querySelectorAll('div[role="button"]')) {
      const text = b.textContent.trim();
      const rect = b.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 30 && rect.height < 120) {
        const isUnread = /\d+\+?\s*new\s*message/i.test(text) || text.includes('Unread');
        if (!isUnread) continue;
        const spans = b.querySelectorAll('span');
        let username = null;
        if (spans.length > 1) {
          const candidate = spans[1].textContent.trim();
          if (candidate && candidate.length > 1 && !candidate.includes('·') && !/^\d+\+?\s*new\s*message/i.test(candidate)) {
            username = candidate;
          }
        }
        if (username) targets.push(username.toLowerCase());
      }
    }
    return targets;
  };

  // Helper: click a thread by username
  const clickThread = (username) => {
    for (const b of document.querySelectorAll('div[role="button"]')) {
      const spans = b.querySelectorAll('span');
      if (spans.length > 1 && spans[1].textContent.trim().toLowerCase() === username) {
        const rect = b.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 30 && rect.height < 120) {
          b.click();
          return true;
        }
      }
    }
    return false;
  };

  let staleCount = 0;

  for (let s = 0; s < 50 && results.length < MAX_THREADS; s++) {
    const targets = findUnread();
    console.log(`Scroll ${s + 1}: found ${targets.length} unread threads in view`);

    if (targets.length === 0) {
      staleCount++;
      if (staleCount >= 5) {
        console.log('No unread threads found for 5 scrolls — stopping');
        break;
      }
      await scrollDown();
      continue;
    }
    staleCount = 0;

    for (const username of targets) {
      if (seen.has(username) || results.length >= MAX_THREADS) break;
      seen.add(username);

      // Click the thread
      const clicked = clickThread(username);
      if (!clicked) {
        console.log(`  @${username}: could not click (not in view)`);
        continue;
      }

      // Wait for navigation to thread page
      try {
        await new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            if (/\/direct\/t\/\d+/.test(window.location.href)) {
              observer.disconnect();
              resolve();
            }
          });
          observer.observe(document, { subtree: true, childList: true });
          setTimeout(() => { observer.disconnect(); reject(new Error('timeout')); }, 10000);
        });
      } catch (e) {
        console.log(`  @${username}: navigation timeout`);
        continue;
      }

      await new Promise(r => setTimeout(r, 2000));
      const urlMatch = window.location.href.match(/\/direct\/t\/(\d+)/);
      if (!urlMatch) {
        console.log(`  @${username}: no thread ID in URL`);
        continue;
      }

      const threadId = urlMatch[1];
      results.push({ username, threadId });
      console.log(`  @${username}: thread ID = ${threadId} ✓`);

      // Navigate back to inbox
      window.location.href = 'https://www.instagram.com/direct/inbox/';
      await new Promise(r => setTimeout(r, 4000));
      break; // Scroll position reset — continue outer loop
    }

    // Scroll down for next iteration
    await scrollDown();
  }

  console.log('\n=== RESULTS ===');
  console.log(`Found ${results.length} threads:`);
  for (const r of results) {
    console.log(`  @${r.username} → thread ${r.threadId}`);
  }
  console.log('\nIf this works, the inline approach is validated. Ready to deploy.');
})();
