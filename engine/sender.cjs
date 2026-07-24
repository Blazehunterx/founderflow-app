/**
 * Shared sender — single typing engine for DM replies and AI replies.
 * Both engine.cjs and ai_setter.cjs import this.
 *
 * Bubble splitting: messages over 880 chars are split into multiple
 * natural-sentence chunks, each sent as a separate DM bubble with
 * human-like delays between them.
 */

function jitter(baseMs, variance = 0.3) {
  const jitterAmount = baseMs * variance;
  return baseMs + (Math.random() * jitterAmount * 2) - jitterAmount;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, jitter(ms)));
}

const MAX_BUBBLE = 880;

function splitMessage(text) {
  if (text.length <= MAX_BUBBLE) return [text];

  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > 0) {
    if (remaining.length <= MAX_BUBBLE) {
      chunks.push(remaining);
      break;
    }

    let cut = -1;

    const sentenceEnd = Math.max(
      remaining.lastIndexOf('. ', MAX_BUBBLE),
      remaining.lastIndexOf('! ', MAX_BUBBLE),
      remaining.lastIndexOf('? ', MAX_BUBBLE)
    );
    if (sentenceEnd > MAX_BUBBLE * 0.4) cut = sentenceEnd + 1;

    if (cut === -1) {
      const newline = remaining.lastIndexOf('\n', MAX_BUBBLE);
      if (newline > MAX_BUBBLE * 0.4) cut = newline;
    }

    if (cut === -1) {
      const comma = remaining.lastIndexOf(', ', MAX_BUBBLE);
      if (comma > MAX_BUBBLE * 0.4) cut = comma + 1;
    }

    if (cut === -1) {
      const space = remaining.lastIndexOf(' ', MAX_BUBBLE);
      if (space > 1) cut = space;
    }

    if (cut === -1 || cut < 1) {
      chunks.push(remaining.substring(0, MAX_BUBBLE));
      remaining = remaining.substring(MAX_BUBBLE).trim();
    } else {
      chunks.push(remaining.substring(0, cut).trim());
      remaining = remaining.substring(cut).trim();
    }
  }

  return chunks;
}

async function purgePopups(page) {
  for (let pass = 0; pass < 3; pass++) {
    try {
      const clicked = await page.evaluate(() => {
        const DISMISS_TEXTS = ['not now', 'not now.', 'ei nyt', 'restore', 'accept', 'hyväksy', 'salli', 'allow', 'ok', 'close', 'sulje', 'no thanks'];
        const allClickable = document.querySelectorAll('div[role="button"], button, span, a');
        let count = 0;
        for (const el of allClickable) {
          const text = (el.textContent || '').trim().toLowerCase();
          if (DISMISS_TEXTS.some(t => text === t || text.startsWith(t))) {
            el.click();
            count++;
          }
        }
        return count;
      }).catch(() => 0);
      if (clicked === 0) break;
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {}
  }
}

async function typeAndSend(page, text) {
  const boxSelector = '[role="main"] div[contenteditable="true"], div[contenteditable="true"], [placeholder*="Message"], div[role="textbox"], textarea[placeholder*="Message"], p[role="textbox"]';
  const box = page.locator(boxSelector).first();
  
  // Try normal click first, force only as fallback
  try {
    if (await box.count() > 0) {
      await box.scrollIntoViewIfNeeded();
      try { await box.click({ timeout: 10000 }); } catch (_) {
        await box.click({ force: true, timeout: 5000 });
      }
    }
  } catch (e) {}

  if (!(await box.isVisible({ timeout: 10000 }).catch(() => false))) return false;

  await box.click();
  await delay(800 + Math.floor(Math.random() * 700));

  const bubbles = splitMessage(text);
  for (let i = 0; i < bubbles.length; i++) {
    const chunk = bubbles[i].trim();
    const safeChunk = chunk.length > 900 ? chunk.substring(0, 900) : chunk;

    await box.click();
    await delay(400 + Math.floor(Math.random() * 400));
    try {
      await box.type(safeChunk, { delay: 30 + Math.floor(Math.random() * 50) });
    } catch (e) {}
    await delay(800 + Math.floor(Math.random() * 700));

    // Attempt to send: try all known send button selectors, then scan DOM for send icon
    let sent = false;
    const sendSelectors = [
      'div[aria-label="Send"][role="button"]',
      'button[aria-label="Send"]',
      'svg[aria-label="Send"]',
      'div[aria-label="Send"]',
      'span[aria-label="Send"]',
    ];
    for (const sel of sendSelectors) {
      if (sent) break;
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click({ force: true, timeout: 2000 });
          sent = true;
        }
      } catch (e) {}
    }

    // Fallback: scan DOM for any clickable element containing a send-like SVG
    if (!sent) {
      try {
        sent = await page.evaluate(() => {
          // Look for any button/div with role="button" near the contenteditable box
          const box = document.querySelector('div[contenteditable="true"]');
          if (!box) return false;
          const toolbar = box.closest('[role="main"]') || box.parentElement?.parentElement?.parentElement;
          if (!toolbar) return false;
          // Find buttons in the same toolbar/row
          const btns = toolbar.querySelectorAll('div[role="button"], button');
          for (const btn of btns) {
            const rect = btn.getBoundingClientRect();
            // Send button is typically small, square, to the right of the input
            if (rect.width > 10 && rect.width < 80 && rect.height > 10) {
              const svg = btn.querySelector('svg');
              if (svg || btn.getAttribute('aria-label')?.toLowerCase().includes('send')) {
                btn.click();
                return true;
              }
            }
          }
          return false;
        });
      } catch (e) {}
    }
    await delay(1500 + Math.floor(Math.random() * 1000));

    try {
      await page.screenshot({ path: '/engine/dm_sent_latest.png' });
    } catch (e) {}
    
    try {
      const blocked = await page.locator(':has-text("Action Blocked"), :has-text("We restrict"), :has-text("Couldn\'t send"), :has-text("Try Again Later")').first().isVisible({ timeout: 2000 }).catch(() => false);
      if (blocked) return { success: false, error: 'Action Blocked' };
    } catch (_) {}

    // Verify message actually appeared in chat (broad fallback)
    try {
      const verified = await page.evaluate(function (sentText) {
        var checkText = sentText.trim().substring(0, 80);
        // Strategy 1: check dir-based elements (profile overlay bubbles)
        var bubbles = document.querySelectorAll('div[dir], span[dir]');
        for (var i = 0; i < bubbles.length; i++) {
          if (bubbles[i].textContent.trim().indexOf(checkText) !== -1) return true;
        }
        // Strategy 2: check full page text (works on dedicated thread page)
        if (document.body.innerText.indexOf(checkText) !== -1) return true;
        return false;
      }, safeChunk).catch(function () { return true; });
      if (!verified) log('warn', 'VERIFY', 'Message not found in DOM — may still have sent');
    } catch (e) {}
    
    if (i < bubbles.length - 1) await delay(jitter(2000, 0.5));
  }
  await delay(2000);
  return { success: true };
}

async function sendReplyViaPage(page, handle, text) {
  try {
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(3000);

    // Click Message button via native JS event dispatch
    const msgClicked = await page.evaluate(() => {
      const MSG_KEYWORDS = ['message', 'send message', 'send a message', 'message request'];
      const matchesMessageButton = (el) => {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (MSG_KEYWORDS.some(k => aria.includes(k))) return true;
        const vis = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (MSG_KEYWORDS.some(k => vis.includes(k))) return true;
        return false;
      };
      // NOTE: SVGs excluded — nav "Messages" icon (aria-label="Messages") matches includes('message')
      const all = document.querySelectorAll('div[role="button"], button, span, a[href*="/direct/"]');
      for (const el of all) {
        if (matchesMessageButton(el)) {
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' }));
          el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' }));
          el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
          el.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (!msgClicked) return { success: false, error: 'Message button not found' };

    await delay(3000);

    // REQUEST THREAD ACCEPT: if this is a request thread, click "Accept" before looking for message input
    try {
      const acceptBtn = page.locator('button:has-text("Accept"), button:has-text("Accept request"), div[role="button"]:has-text("Accept")').first();
      if (await acceptBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        log('info', 'REQUEST_ACCEPT', `Request thread — clicking Accept for @${handle}`);
        await acceptBtn.click({ timeout: 5000 });
        await delay(3000); // Wait for accept to process and message input to appear
      }
    } catch (e) {}

    // Wait for chat box
    try {
      await Promise.race([
        page.waitForSelector('div[contenteditable="true"], [placeholder*="Message"]', { timeout: 15000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hard_timeout')), 15000))
      ]);
    } catch (_) {}

    // Dismiss popups after chat box appeared
    await purgePopups(page);

    return await typeAndSend(page, text);
  } catch (err) {
    return { success: false, error: err.message.substring(0, 100) };
  }
}

module.exports = { typeAndSend, delay, jitter, sendReplyViaPage };
