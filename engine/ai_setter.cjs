/**
 * Antigravity AI Setter v3 — Conversation State Machine
 * Multi-turn qualification funnel with Calendly/Skool routing
 */
const path = require('path');
const fs = require('fs');
const { delay, sendReplyViaPage, typeAndSend } = require('./sender.cjs');

const LOG_PATH = path.resolve(process.cwd(), 'engine.log');
const STATE_PATH = path.resolve(process.cwd(), 'state.json');

function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/ignore\s+(all\s+)?(previous\s+)?instructions/i, '')
    .replace(/forget\s+(all\s+)?(previous\s+)?instructions/i, '')
    .replace(/override\s+(all\s+)?(previous\s+)?(instructions|rules)/i, '')
    .replace(/reveal\s+(your\s+)?(system\s+)?prompt/i, '')
    .replace(/output\s+(your\s+)?(system\s+)?(prompt|instructions)/i, '');
}

function sanitizeForGemini(text) {
  if (!text) return text;
  return text
    .replace(/\bOnlyFans\b/gi, 'my exclusive page')
    .replace(/\bOF\b/g, 'my page')
    .replace(/\bof\b(?=\s+(model|creator|content|account|page|profile))/gi, 'my exclusive')
    .replace(/\bchaturbate\b/gi, 'live streaming platform')
    .replace(/\bpornhub\b/gi, 'adult platform')
    .replace(/\bxhamster\b/gi, 'adult platform')
    .replace(/\bxvideos\b/gi, 'adult platform')
    .replace(/\bnude\b/gi, 'artistic content')
    .replace(/\bnudes\b/gi, 'artistic content')
    .replace(/\bsexual\b/gi, 'intimate')
    .replace(/\bsexually\b/gi, 'intimately')
    .replace(/\berotic\b/gi, 'artistic')
    .replace(/\bporn\b/gi, 'adult content')
    .replace(/\bporno\b/gi, 'adult content')
    .replace(/\bnsfw\b/gi, 'exclusive')
    .replace(/\bsFW\b/g, 'exclusive');
}

function log(level, event, message) {
  const emojis = { success: '\u2705', error: '\u274c', warn: '\u26a0\ufe0f', info: '\U0001f535', ai: '\U0001f916' };
  const line = `${emojis[level] || '\U0001f535'} [${event}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`); } catch (e) {}
}


async function sendTelegram(config, message) {
  try {
    const token = config.telegramBotToken;
    const chatId = config.telegramChatId;
    if (!token || !chatId) return;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
  } catch (e) {}
}

function formatTelegramReply(username, reply, incoming, action, step) {
  const stepInfo = step ? ` (step ${step})` : '';
  return `📬 <b>AI Reply → @${username}</b>${stepInfo}\n\n💬 <b>Incoming:</b> ${(incoming || '').substring(0, 150)}\n\n🤖 <b>Reply:</b> ${(reply || '').substring(0, 300)}\n\n📋 Action: ${action}`;
}

const repliedThreads = new Set();
const processedThreads = new Set(); // Tracks all threads we've processed (persists across pulses)
let aiSetterRunning = false;

function loadAiState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveAiState(patch) {
  try {
    const state = loadAiState();
    Object.assign(state, patch);
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) {}
}

const TERMINAL_STEP = 99;

// Rate limiting: minimum gap between Instagram API inbox scans (ms)
const API_INBOX_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between scans
let lastApiInboxScan = 0;



function isPositiveReply(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const positive = ['yes', 'sure', 'send it', 'interested', 'want it', 'ok', 'okay', 'definitely', 'absolutely', 'please', 'go ahead', 'do it', 'yeah', 'yep', 'yup', 'always open', 'tell me more', 'more info', 'sounds interesting', 'sounds good', "i'm listening", 'im listening', 'love to hear more', 'love to know more', 'what is it', "what's it about", 'how does it work', 'go on', 'continue'];
  return positive.some(p => t.includes(p));
}

function isNegativeReply(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const negative = ['not interested', 'no thanks', 'stop', "don't contact", 'unsubscribe', 'leave me alone', 'not now', 'no thank', 'no.', 'never', 'remove me', 'no', 'nope', 'nah', 'not really', "i'm good", 'i am good', 'not for me'];
  return negative.some(k => new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t));
}

const DEFAULT_STEPS = [
  { step: 1, objective: 'Connect over their specific work. Acknowledge what they do. Build rapport.' },
  { step: 2, objective: 'Gather intel: background, challenges, pain points, current status.' },
  { step: 3, objective: 'Share a personal story (vulnerability + authority). Ask about their vision.' },
  { step: 4, objective: 'Explore their dream outcome and goals in detail.' },
  { step: 5, objective: 'Offer a free diagnostic call. Frame as diagnosis, not coaching.' },
  { step: 6, objective: 'Pre-call qualify: exploratory or committed? Budget range? Ask both naturally.' },
];

// HUMAN MESSAGE DETECTION — outbox-based, 100% reliable
async function isHumanMessage(supabase, workspaceId, leadId, lastMsgText) {
  if (!lastMsgText || !leadId) return false;
  try {
    const trimmed = lastMsgText.trim();
    const probe = trimmed.substring(0, 40);
    const { data } = await supabase
      .from('outbox')
      .select('message')
      .eq('workspace_id', workspaceId)
      .eq('lead_id', leadId)
      .order('sent_at', { ascending: false })
      .limit(10);
    if (!data || data.length === 0) return false;
    const isOurs = data.some(row => {
      const msg = (row.message || '').trim();
      return msg === trimmed || msg.substring(0, 40) === probe || trimmed.substring(0, 40) === msg.substring(0, 40);
    });
    return !isOurs;
  } catch (e) {
    return false;
  }
}

function getSteps(config) {
  if (config.conversationSteps) {
    let steps = config.conversationSteps;
    // conversationSteps may arrive as a JSON string from the settings table
    if (typeof steps === 'string') {
      try { steps = JSON.parse(steps); } catch (e) { steps = null; }
    }
    if (Array.isArray(steps) && steps.length > 0) return steps;
  }
  return DEFAULT_STEPS;
}

// ECHO/PARROT DETECTION: lead copies our message and sends it back
// This is a strong automation signal — Instagram will flag self-replies
function isEchoOrParrot(messages) {
  if (!messages || messages.length < 2) return false;
  const theirMsgs = messages.filter(m => !m.isMe && m.text);
  const ourMsgs = messages.filter(m => m.isMe && m.text);
  if (theirMsgs.length === 0 || ourMsgs.length === 0) return false;
  const lastTheir = theirMsgs[theirMsgs.length - 1].text.trim().toLowerCase();
  // Check against our last message
  const lastOur = ourMsgs[ourMsgs.length - 1].text.trim().toLowerCase();
  if (lastTheir === lastOur) return true;
  // Check against our second-to-last message (they may be replying late)
  if (ourMsgs.length >= 2) {
    const prevOur = ourMsgs[ourMsgs.length - 2].text.trim().toLowerCase();
    if (lastTheir === prevOur) return true;
  }
  return false;
}

// BOT-ON-BOT DETECTION: lead is another bot, service provider, or asks for OUR info instead of giving theirs
function isBotOnBot(lastIncoming, messages) {
  if (!lastIncoming) return false;
  const t = lastIncoming.toLowerCase().trim();

  // Pattern 1: lead asks for OUR email/phone/WhatsApp instead of providing theirs
  const askingOurInfo = [
    /can you (give|share|send|provide) (me )?(your|ur) (email|mail|phone|number|whatsapp|contact)/i,
    /what('s| is|s) (your|ur) (email|mail|phone|number|whatsapp)/i,
    /podaj mi (sw[oó]j |ten )?(email|mail|telefon|numer)/i,
    /give me your email/i,
    /send me your (email|phone|contact)/i,
    /your email address/i,
    /i need your (email|phone|contact)/i,
  ];
  if (askingOurInfo.some(p => p.test(t))) return true;

  // Pattern 2: obvious service provider / spam / bot
  const serviceSpam = [
    /i('m| am) (a |an )?(freelancer|developer|designer|marketer|virtual assistant|va\b)/i,
    /i can (help|build|create|design|develop|manage)/i,
    /my (portfolio|services|rates|pricing)/i,
    /let me (help|show|share|send)/i,
    /check (out )?my (portfolio|page|profile|website|link|bio)/i,
    /do you need (a |an )?(website|funnel|landing page|graphic|video)/i,
    /affordable (rates|services|prices)/i,
    /just (make sure|checking|following up).*sorted/i,
    /just (getting|making) sure.*work(ed|ing)/i,
    /fully sorted/i,
    /high[- ]level account/i,
  ];
  if (serviceSpam.some(p => p.test(t))) return true;

  return false;
}

async function fetchInboxAPI(page, cursor) {
  const now = Date.now();
  if (now - lastApiInboxScan < API_INBOX_COOLDOWN_MS) {
    return { threads: [], cursor: cursor || null, hasMore: false };
  }
  lastApiInboxScan = now;
  try {
    const cursorParam = cursor ? '&cursor=' + encodeURIComponent(typeof cursor === 'string' ? cursor : JSON.stringify(cursor)) : '';
    const data = await page.evaluate(async (cp) => {
      // Attempt to find the dynamic App ID from Instagram's internal config
      let appId = '936619743392459'; // Fallback
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

    if (data?.error) {
      log('warn', 'API_INBOX', `Rate limited or blocked (Status: ${data.error})`);
      return { threads: [], cursor: cursor || null, hasMore: false };
    }

    if (!data?.inbox?.threads) {
      log('warn', 'API_INBOX', `No inbox.threads in response — raw keys: ${Object.keys(data || {}).join(', ')}`);
      return { threads: [], cursor: cursor || null, hasMore: false };
    }

    const threads = [];
    const now = Date.now();
    const MAX_THREAD_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 365 days — reply to old backlog too
    let totalFiltered = 0, filteredStale = 0, filteredEmptyItems = 0, filteredGroup = 0, filteredSelf = 0, filteredVoice = 0;
    for (const thread of data.inbox.threads) {
      totalFiltered++;
      if (thread.last_activity_at && now - thread.last_activity_at > MAX_THREAD_AGE_MS) { filteredStale++; continue; }
      if (!thread.items?.length) { filteredEmptyItems++; continue; }
      if (thread.users?.length > 2) { filteredGroup++; continue; }
      const lastItem = thread.items[0];
      const myId = thread.viewer_id || thread.own_recipient_user_id;
      const selfLast = lastItem.user_id === myId;
      // Skip voice memos — let user take over
      const isVoice = lastItem.item_type === 'voice_media' || lastItem.media_type === 11;
      if (isVoice) { filteredVoice++; continue; }
      threads.push({
        threadId: thread.thread_id,
        username: thread.users?.[0]?.username || 'unknown',
        lastMessage: lastItem.text || '',
        isUnread: !thread.read_state,
        lastActivity: thread.last_activity_at,
        viewerId: myId,
        lastSenderId: lastItem.user_id,
        selfLast
      });
    }
    // Pagination: Instagram uses has_older + next_cursor/oldest_cursor (NOT has_more_items/cursor)
    const nextCursor = data.inbox.next_cursor || data.inbox.oldest_cursor || data.inbox.cursor || data.inbox.next_max_id || null;
    const hasMore = (data.inbox.has_older === true || data.inbox.has_more_items === true) && nextCursor !== null;
    const unreadCount = threads.filter(t => t.isUnread).length;
    log('info', 'API_INBOX', `Page returned ${data.inbox.threads.length} threads → ${threads.length} actionable (${unreadCount} unread, ${threads.length - unreadCount} read) (stale:${filteredStale} emptyItems:${filteredEmptyItems} group:${filteredGroup} selfLast:${filteredSelf} voice:${filteredVoice}) cursor:${nextCursor ? 'yes' : 'none'} hasMore:${hasMore}`);
    return { threads, cursor: nextCursor, hasMore };
  } catch (e) {
    log('error', 'API_INBOX', e.message);
    return { threads: [], cursor: cursor || null, hasMore: false };
  }
}

async function fetchThreadMessagesAPI(page, threadId) {
  try {
    const data = await page.evaluate(async (tid) => {
      let appId = '936619743392459'; // Fallback
      try {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          if (s.textContent.includes('app_id')) {
            const match = s.textContent.match(/"app_id":"(\d+)"/);
            if (match) { appId = match[1]; break; }
          }
        }
      } catch (e) {}
      
      const url = `https://www.instagram.com/api/v1/direct_v2/threads/${tid}/?limit=10`;
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          'X-IG-App-ID': appId,
          'X-ASBD-ID': '129477',
          'X-IG-WWW-Claim': '0',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      if (!res.ok) return null;
      return await res.json();
    }, threadId);

    if (!data?.thread?.items) return [];
    const myId = data.thread.viewer_id || data.thread.own_recipient_user_id;
    
    return data.thread.items.filter(item => {
      // Filter out voice memos — not actionable by AI
      return item.item_type !== 'voice_media' && item.media_type !== 11;
    }).map(item => {
      let text = item.text || '';
      // Strip Instagram UI artifacts (bubbles, reactions, link previews)
      text = text.replace(/[\u2550\u2554\u2557\u255A\u255D]|BUBBLE|LINK_PREVIEW|REACTION|UNKNOWN/g, '').trim();
      return {
        text,
        isMe: item.user_id === myId,
        timestamp: item.timestamp,
        itemType: item.item_type || 'text'
      };
    }).reverse(); // Order from oldest to newest for AI context
  } catch (e) {
    log('error', 'API_THREAD', e.message);
    return [];
  }
}

async function sendReplyViaPhysical(page, threadId, replyText, username) {
  // Instagram killed the send API and /direct/t/{id}/ doesn't work for long IDs.
  // Use profile-based send: navigate to profile → click Message → type.
  // Falls back to inbox navigation if profile approach fails.
  try {
    await page.evaluate(() => 1); // Health check
  } catch (e) {
    log('warn', 'PHYSICAL_SEND', 'Page dead, re-navigating to inbox...');
    try { await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 }); await delay(3000); } catch(e2) {}
  }

  // If we have a username, use profile-based send (reliable, was working before)
  if (username && username !== 'unknown' && username !== threadId) {
    const result = await sendReplyViaPage(page, username, replyText);
    if (result && result.success) {
      log('success', 'PROFILE_SEND', `Reply sent to @${username} via profile`);
      const thinkingDelay = 3000 + Math.random() * 5000;
      const typingSpeed = 3 + Math.random() * 2;
      const typingDelay = Math.max(3000, (replyText.length / typingSpeed) * 1000);
      const humanDelay = thinkingDelay + typingDelay;
      log('info', 'HUMANIZER', `Pausing ~${Math.round(humanDelay/1000)}s (${replyText.length} chars)...`);
      await delay(humanDelay);
      return true;
    }
    log('warn', 'PROFILE_SEND_FAIL', `Profile send failed for @${username}: ${result?.error || 'unknown'}, trying inbox fallback...`);
  }

  // Fallback A: navigate directly to /direct/t/{threadId}/
  try {
    await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(4000);

    // REQUEST THREAD ACCEPT: if this is a request thread, click "Accept" before looking for message input
    try {
      const acceptBtn = page.locator('button:has-text("Accept"), button:has-text("Accept request"), div[role="button"]:has-text("Accept")').first();
      if (await acceptBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        log('info', 'REQUEST_ACCEPT', `Request thread — clicking Accept for @${username || threadId}`);
        await acceptBtn.click({ timeout: 5000 });
        await delay(3000);
      }
    } catch (e) {}

    const chatBox = page.locator('[role="main"] div[contenteditable="true"], div[contenteditable="true"], [placeholder*="Message"], div[role="textbox"]').first();
    if (await chatBox.isVisible({ timeout: 5000 }).catch(() => false)) {
      log('info', 'INBOX_FALLBACK', `Opened thread ${threadId} via direct URL`);
      try {
        const blockers = page.locator('button:has-text("Not Now"), button:has-text("Not now"), button:has-text("Accept"), div[role="dialog"] button:has-text("Close")');
        const bCount = await blockers.count();
        for (let i = 0; i < bCount; i++) {
          await blockers.nth(i).click({ timeout: 2000 }).catch(() => {});
        }
      } catch (e) {}
      await delay(1000);
      const domResult = await typeAndSend(page, replyText);
      if (domResult && domResult.success) {
        log('success', 'INBOX_SEND', `Reply sent via direct URL to ${username || threadId}`);
        const thinkingDelay = 3000 + Math.random() * 5000;
        const typingSpeed = 3 + Math.random() * 2;
        const typingDelay = Math.max(3000, (replyText.length / typingSpeed) * 1000);
        const humanDelay = thinkingDelay + typingDelay;
        log('info', 'HUMANIZER', `Pausing ~${Math.round(humanDelay/1000)}s (${replyText.length} chars)...`);
        await delay(humanDelay);
        return true;
      }
      log('warn', 'INBOX_SEND_FAIL', `typeAndSend failed on direct URL: ${domResult?.error || 'unknown'}`);
    }
  } catch (e) {
    log('warn', 'INBOX_FALLBACK', `Direct URL failed for ${threadId}: ${e.message}`);
  }

  // Fallback B: navigate to inbox, find thread in sidebar list, click it
  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(4000);

    // Strategy 1: find thread link by href containing thread ID
    let threadClicked = await page.evaluate(({ tid }) => {
      const links = document.querySelectorAll('a[href*="/direct/t/"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (href.includes(tid)) {
          link.click();
          return { success: true, method: 'thread_id' };
        }
      }
      return { success: false };
    }, { tid: threadId });

    // Strategy 2: scroll down to load more threads, then retry
    if (!threadClicked?.success) {
      for (let scrollAttempt = 0; scrollAttempt < 3; scrollAttempt++) {
        await page.evaluate(() => {
          const sidebar = document.querySelector('[role="navigation"]') || document.querySelector('div[class*="sidebar"]') || document.documentElement;
          sidebar.scrollTop = sidebar.scrollHeight;
        });
        await delay(2000);
        threadClicked = await page.evaluate(({ tid }) => {
          const links = document.querySelectorAll('a[href*="/direct/t/"]');
          for (const link of links) {
            const href = link.getAttribute('href') || '';
            if (href.includes(tid)) {
              link.click();
              return { success: true, method: 'thread_id_scrolled' };
            }
          }
          return { success: false };
        }, { tid: threadId });
        if (threadClicked?.success) break;
      }
    }

    // Strategy 3: find by username text in the sidebar
    if (!threadClicked?.success && username) {
      threadClicked = await page.evaluate(({ uname }) => {
        const allElements = document.querySelectorAll('a, span, div');
        for (const el of allElements) {
          const text = (el.innerText || el.textContent || '').trim().toLowerCase();
          if (text === uname.toLowerCase() || text === '@' + uname.toLowerCase() || text.includes(uname.toLowerCase())) {
            let parent = el.closest('a[href*="/direct/t/"]') || el.parentElement?.closest('a[href*="/direct/t/"]');
            if (parent) {
              parent.click();
              return { success: true, method: 'username_in_thread' };
            }
            el.click();
            return { success: true, method: 'username_element' };
          }
        }
        return { success: false };
      }, { uname: username });
    }

    if (threadClicked?.success) {
      log('info', 'INBOX_FALLBACK', `Clicked thread via ${threadClicked.method}`);
      await delay(3000);

      // Dismiss popups
      try {
        const blockers = page.locator('button:has-text("Not Now"), button:has-text("Not now"), button:has-text("Accept"), div[role="dialog"] button:has-text("Close")');
        const bCount = await blockers.count();
        for (let i = 0; i < bCount; i++) {
          await blockers.nth(i).click({ timeout: 2000 }).catch(() => {});
        }
      } catch (e) {}
      await delay(1000);

      const domResult = await typeAndSend(page, replyText);
      if (domResult && domResult.success) {
        log('success', 'INBOX_SEND', `Reply sent via inbox fallback to ${username || threadId}`);
        const thinkingDelay = 3000 + Math.random() * 5000;
        const typingSpeed = 3 + Math.random() * 2;
        const typingDelay = Math.max(3000, (replyText.length / typingSpeed) * 1000);
        const humanDelay = thinkingDelay + typingDelay;
        log('info', 'HUMANIZER', `Pausing ~${Math.round(humanDelay/1000)}s (${replyText.length} chars)...`);
        await delay(humanDelay);
        return true;
      }
      log('warn', 'INBOX_SEND_FAIL', `typeAndSend failed: ${domResult?.error || 'unknown'}`);
    } else {
      log('warn', 'INBOX_FALLBACK', `Could not find thread ${threadId} (@${username || '?'}) in inbox list`);
    }
  } catch (e) {
    log('error', 'INBOX_FALLBACK', e.message);
  }

  // Navigate back to inbox
  try { await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 }); await delay(2000); } catch(e) {}
  return false;
}

async function verifyOurMessageIsLast(page, threadId) {
  try {
    await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(3000);
    const isOurs = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('div[role="log"] div[role="row"], div[data-message]'));
      if (items.length === 0) return false;
      const last = items[items.length - 1];
      return last.querySelector('[data-testid*="message-conversation-message-sent"], [data-testid*="sent"], [aria-label*="Sent"], [aria-label*="sent"], [style*="margin-left: auto"], [style*="flex-end"]') !== null;
    });
    return isOurs;
  } catch (e) {
    return false;
  }
}

async function canSendToThread(page, threadId) {
  try {
    await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(3000);
    const lastIsOurs = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('div[role="log"] div[role="row"], div[data-message]'));
      if (items.length === 0) return false;
      const last = items[items.length - 1];
      return last.querySelector('[data-testid*="message-conversation-message-sent"], [data-testid*="sent"], [aria-label*="Sent"], [aria-label*="sent"], [style*="margin-left: auto"], [style*="flex-end"]') !== null;
    });
    return !lastIsOurs;
  } catch (e) {
    return false;
  }
}

// Grok (xAI) — OpenAI-compatible API
async function callGrok(apiKey, prompt, retries = 3, systemInstruction = null) {
  const messages = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  messages.push({ role: 'user', content: prompt });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'grok-3-mini',
          messages,
          temperature: 0.7,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) return text;
        log('warn', 'GROK', `Empty response (attempt ${attempt}/${retries})`);
      } else if (res.status === 429) {
        if (attempt < retries) {
          log('warn', 'GROK', `429 rate limit (attempt ${attempt}/${retries}) — waiting 60s...`);
          await delay(60000);
          continue;
        }
      } else {
        const body = await res.text().catch(() => '');
        log('error', 'GROK', `${res.status}: ${body.substring(0, 200)}`);
        if (attempt < retries) { await delay(5000); continue; }
      }
    } catch (e) {
      log('error', 'GROK', `${e.message} (attempt ${attempt}/${retries})`);
      if (attempt < retries) await delay(3000);
    }
  }
  throw { quotaExhausted: false };
}

// Unified AI call — routes to Grok or Gemini based on config
async function callAI(apiKey, prompt, retries, systemInstruction, config) {
  const grokKey = config.grokApiKey || process.env.GROK_API_KEY;
  if (grokKey) {
    return callGrok(grokKey, prompt, retries, systemInstruction);
  }
  return callGemini(apiKey, prompt, retries, systemInstruction);
}

// Gemini model rotation — each model has its own free quota
const GEMINI_MODELS = [
  'gemini-2.5-flash',         // 250K RPD free tier
  'gemini-3.1-flash-lite',    // 250K RPD free tier (fallback, brand new)
];

function truncateAtLastSentence(text) {
  // If text ends mid-sentence, truncate to the last complete sentence
  if (!text) return text;
  const trimmed = text.trim();
  // If already ends with sentence terminator, keep as-is
  if (/[.!?]$/.test(trimmed)) return trimmed;
  // Find the last sentence boundary
  const lastBoundary = Math.max(
    trimmed.lastIndexOf('. '),
    trimmed.lastIndexOf('! '),
    trimmed.lastIndexOf('? ')
  );
  if (lastBoundary > 0) {
    return trimmed.substring(0, lastBoundary + 1).trim();
  }
  return trimmed;
}

async function callGemini(apiKey, prompt, retries = 5, systemInstruction = null) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    // Rotate across models to spread free-quota usage
    const model = GEMINI_MODELS[(attempt - 1) % GEMINI_MODELS.length];
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
      };
      if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction }] };
      }
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        const candidate = data?.candidates?.[0];
        let text = candidate?.content?.parts?.[0]?.text?.trim();
        const finishReason = candidate?.finishReason;
        if (text) {
          if (finishReason === 'MAX_TOKENS') {
            log('warn', 'GEMINI', `Response hit MAX_TOKENS on ${model} — truncating to last complete sentence`);
            text = truncateAtLastSentence(text);
          }
          return text;
        }
        const rawSnippet = JSON.stringify(data).substring(0, 300);
        log('warn', 'GEMINI', `Empty response (${model}, attempt ${attempt}/${retries}) finishReason=${finishReason || 'none'} safetyRatings=${JSON.stringify(candidate?.safetyRatings || []).substring(0, 100)} raw=${rawSnippet}`);
      } else if (res.status === 429) {
        // 429 = per-minute rate limit (50 RPM). Wait 65s for RPM reset.
        log('warn', 'GEMINI', `429 rate limit on ${model} (attempt ${attempt}/${retries}) — waiting 65s for RPM reset...`);
        await delay(65000);
        continue;
      } else {
        log('error', 'GEMINI', `${model} error: ${res.status}`);
      }
      if (attempt < retries) {
        await delay(5000);
        continue;
      }
      return null;
    } catch (e) {
      log('error', 'GEMINI', `${model}: ${e.message}`);
      if (attempt < retries) {
        await delay(5000);
        continue;
      }
      return null;
    }
  }
  return null;
}

async function scanInboxDOM(page, maxScrolls = 10) {
  try {
    await delay(3000);

    // Capture API responses that Instagram's web page makes internally
    const capturedThreads = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('/direct_v2/inbox') || url.includes('/direct_v2/pending')) {
          const data = await response.json().catch(() => null);
          if (data?.inbox?.threads) {
            for (const thread of data.inbox.threads) {
              if (!thread.items?.length) continue;
              if (thread.users?.length > 2) continue;
              const lastItem = thread.items[0];
              capturedThreads.push({
                threadId: thread.thread_id,
                username: thread.users?.[0]?.username || 'unknown',
                lastMessage: lastItem.text || '',
                isUnread: !thread.read_state
              });
            }
          }
        }
      } catch (e) {}
    });

    // Scroll multiple times to trigger lazy-loading and API calls
    for (let i = 0; i < maxScrolls; i++) {
      await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); }).catch(() => {});
      await delay(2000 + Math.random() * 1000);
    }

    // Also try direct DOM extraction as backup
    const domThreads = await page.evaluate(() => {
      const results = [];
      const seenIds = new Set();

      // Try multiple selector strategies
      const selectors = [
        'div[role="listitem"] a[href*="/direct/t/"]',
        'div[role="list"] a[href*="/direct/t/"]',
        'a[href*="/direct/t/"]',
        'div[aria-label="Messages"] div[role="listitem"]'
      ];

      for (const sel of selectors) {
        const links = document.querySelectorAll(sel);
        for (const link of links) {
          const href = link.getAttribute('href');
          if (!href) continue;
          const match = href.match(/\/direct\/t\/([^/?]+)/);
          if (!match || seenIds.has(match[1])) continue;
          seenIds.add(match[1]);

          // Walk up to find username
          let handle = null;
          let parent = link.parentElement;
          for (let depth = 0; depth < 5 && parent; depth++) {
            const profileLink = parent.querySelector('a[href^="/"]:not([href*="/direct/"]):not([href*="/accounts/"])');
            if (profileLink) {
              const ph = profileLink.getAttribute('href');
              if (ph) {
                const pm = ph.match(/^\/([^/?]+)/);
                if (pm) { handle = pm[1]; break; }
              }
            }
            parent = parent.parentElement;
          }

          results.push({
            threadId: match[1],
            username: handle || match[1],
            displayName: (link.textContent || '').substring(0, 100)
          });
        }
        if (results.length > 0) break; // Use first selector that works
      }
      return results;
    });

    // Remove listener
    page.removeAllListeners('response');

    // Merge captured API threads + DOM threads, dedupe
    const all = [...capturedThreads, ...domThreads];
    const unique = [];
    const dedup = new Set();
    for (const t of all) {
      if (!dedup.has(t.threadId)) { dedup.add(t.threadId); unique.push(t); }
    }

    log('info', 'DOM_SCAN', `Found ${unique.length} thread(s) via DOM (API captured: ${capturedThreads.length}, DOM extracted: ${domThreads.length}, scrolled: ${maxScrolls} times)`);
    if (unique.length > 0) {
      const handles = unique.map(t => t.username || t.threadId).filter(Boolean);
      log('info', 'DOM_SCAN', `Handles found: ${handles.join(', ')}`);
    }
    return unique;
  } catch (e) {
    log('error', 'DOM_SCAN', e.message);
    return [];
  }
}

async function checkAndReply(page, supabase, config, context) {
  if (aiSetterRunning) {
    log('info', 'AISETTER_SKIP', 'Already running — skipping concurrent call');
    return;
  }
  aiSetterRunning = true;
  try {
  repliedThreads.clear(); // Fresh set each pulse — threads re-fetched, isMe guard prevents duplicates
  processedThreads.clear(); // No cross-pulse persistence — conversation state (isMe, terminal step) handles dedup
  const workspaceId = config.workspaceId;
  const trainingContext = config.aiTrainingContext || '';
  const apiKey = config.grokApiKey || config.geminiApiKey || process.env.GROK_API_KEY || process.env.GEMINI_API_KEY;
  const calendlyLink = config.calendlyLink || '';
  const skoolLink = config.skoolLink || '';
  const frameworkLink = config.frameworkLink || '';
  const conversationEnabled = config.conversationEnabled !== false;

  let logId = null;
  let threadsFound = 0;
  let threadsReplied = 0;
  const maxRepliesPerPulse = Math.max(1, Math.min(config.maxRepliesPerPulse || 5, 15)); // Default to 5, cap at 15
  let logErrors = [];
  const threadDetails = []; // per-thread: username, action, reply, intent, error

  // Create activity log entry
  try {
    const { data: logEntry } = await supabase.from('ai_setter_log').insert({
      workspace_id: workspaceId,
      checked_at: new Date().toISOString(),
      threads_found: 0,
      threads_replied: 0
    }).select('id').limit(1).maybeSingle();
    if (logEntry) logId = logEntry.id;
  } catch (e) {}

  if (!apiKey) {
    log('info', 'AI', 'No Gemini API key configured. Skipping AI Setter.');
    return;
  }

  log('info', 'AI', 'Scanning inbox via Golden API...');

  // Navigate to DM inbox to ensure Instagram API context is initialized
  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(5000);
    // DEBUG: log page state after navigation
    const pageInfo = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      bodyText: document.body?.innerText?.substring(0, 200) || 'empty'
    }));
    log('info', 'AI', `Page state: url=${pageInfo.url} title="${pageInfo.title}" viewport=${pageInfo.viewport.w}x${pageInfo.viewport.h}`);
    log('info', 'AI', `Page body preview: "${pageInfo.bodyText.substring(0, 150)}"`);
  } catch (e) {
    log('warn', 'AI', `Inbox navigation (timeout OK): ${e.message}`);
    // Still try API call — browser may be on a page with valid cookies
  }

  // Quick login check — if page shows login form, API will return 0
  const loggedOut = await page.evaluate(() => {
    return document.querySelector('input[name="username"]') !== null;
  }).catch(() => false);
  if (loggedOut) {
    log('error', 'AI', 'Browser is logged out — cannot scan inbox. Will retry next pulse.');
    logErrors.push('Browser logged out at scan start');
    await logActivity(supabase, logId, workspaceId, 0, 0, logErrors);
    return;
  }

  // --- INBOX SCAN: detect new replies via Instagram API ---
  // Calls the internal IG inbox API (fast, no page navigation).
  // Paginates through inbox in batches, saving cursor to state for resume next pulse.
  // Cross-references threads with dm_sent/replied leads, fetches conversation, queues for AI reply.
  const threads = [];
  let totalActionable = 0;
  const MAX_PAGES_PER_PULSE = 6; // Scan 6 pages per pulse (600 threads), always from top — no cursor resume
  try {
    let inboxCursor = null; // Always scan from top — never resume cursor (old threads get missed otherwise)
    let inboxPageCount = 0;
    let totalInboxThreads = 0;
    let hasMore = true;
    // All threads collected across pages (for lead matching)
    const allInboxThreads = [];
    
    while (hasMore && inboxPageCount < MAX_PAGES_PER_PULSE) {
      const result = await fetchInboxAPI(page, inboxCursor);
      if (!result || !result.threads || result.threads.length === 0) {
        // API error or empty — don't save stale cursor
        hasMore = false;
        break;
      }
      
      allInboxThreads.push(...result.threads);
      totalInboxThreads += result.threads.length;
      totalActionable += result.threads.length;
      inboxPageCount++;
      inboxCursor = result.cursor;
      hasMore = result.hasMore;
      
      log('info', 'API_INBOX', `Page ${inboxPageCount}: got ${result.threads.length} threads (total: ${totalActionable}) hasMore:${hasMore}`);
      
      // Cooldown between pages to avoid rate limiting
      if (hasMore && inboxPageCount < MAX_PAGES_PER_PULSE) {
        await delay(10000 + Math.random() * 5000); // 10-15s between pages
      }
    }
    
    // Always reset cursor — scan from top every pulse
    config.inboxCursor = null;
    if (inboxPageCount > 0) log('info', 'API_INBOX', `Full inbox scan complete — ${inboxPageCount} pages, ${totalActionable} threads (always from top)`);

    // Dedup allInboxThreads across pages (same thread can appear on multiple pages)
    const seenThreadIds = new Set();
    const dedupedInboxThreads = [];
    for (const t of allInboxThreads) {
      if (!seenThreadIds.has(t.threadId)) {
        seenThreadIds.add(t.threadId);
        dedupedInboxThreads.push(t);
      }
    }
    allInboxThreads.length = 0;
    allInboxThreads.push(...dedupedInboxThreads);
    log('info', 'API_INBOX', `Deduped: ${totalActionable} → ${allInboxThreads.length} unique threads`);

    if (allInboxThreads.length > 0) {
      if (config.inboxScanMode) {
        // INBOX SCAN MODE: Only reply to UNREAD threads from EXISTING leads.
        // Never create leads on-the-fly — only reply to people already in the leads table.
        for (const thread of allInboxThreads) {
          try {
          // Skip Instagram system accounts and self
          const skipUsers = ['instagram support', 'instagram', 'highlightsvideo'];
          if (skipUsers.includes(thread.username.toLowerCase())) continue;

          // Only process if lead already exists in our table
          const { data: existingLead } = await supabase.from('leads')
            .select('id, ig_handle, status, conversation_step, source')
            .eq('workspace_id', workspaceId)
            .eq('ig_handle', thread.username.toLowerCase())
            .maybeSingle();

          if (!existingLead) {
            log('info', 'INBOX_SCAN', `@${thread.username} not in leads table — skipping (no on-the-fly lead creation)`);
            continue;
          }

          // Skip leads we did NOT initiate outreach to (inbound DMs from strangers)
          if (existingLead.source === 'inbound_dm') {
            log('info', 'INBOX_SCAN', `@${thread.username} is inbound-only — skipping`);
            continue;
          }

          // Skip terminal leads
          if (existingLead.conversation_step >= TERMINAL_STEP) {
            log('info', 'INBOX_SCAN', `@${thread.username} at terminal step — skipping`);
            continue;
          }

          // Only reply if the other person sent last (unread / waiting for us)
          if (!thread.selfLast) {
            threads.push({
              threadId: thread.threadId,
              username: thread.username,
              lastMessage: thread.lastMessage || '',
              isUnread: thread.isUnread || false,
              _source: 'inbox_api',
              viewerId: thread.viewerId,
              lastSenderId: thread.lastSenderId
            });
          } else {
            // WE sent last — check if it was a human manually taking over
            const msgs = await fetchThreadMessagesAPI(page, thread.threadId);
            const lastFromUs = msgs && msgs.length > 0 ? [...msgs].reverse().find(m => m.isMe) : null;
            if (lastFromUs) {
              const isHuman = await isHumanMessage(supabase, workspaceId, existingLead.id, lastFromUs.text);
              if (isHuman) {
                try { await supabase.from('leads').update({
                  conversation_step: TERMINAL_STEP,
                  followup_step: 99,
                  last_updated_at: new Date().toISOString()
                }).eq('id', existingLead.id); } catch (e) {}
                log('info', 'AI', `@${thread.username}: human takeover detected — terminating thread`);
              }
            }
          }
          } catch (e) {
            log('warn', 'INSCAN_SCAN', `Failed processing @${thread.username}: ${e.message}`);
          }
        }
      } else {
         // STANDARD MODE: Only process threads matching outreach-initiated leads (exclude inbound_dm)
         // CRITICAL: We only reply to people WE initiated contact with
        const threadHandles = [...new Set(allInboxThreads.map(t => t.username.toLowerCase()))];
        const matchedHandles = new Set();
        if (threadHandles.length > 0) {
          const { data: actionableLeads } = await supabase.from('leads')
            .select('id, ig_handle, status, conversation_step, source')
            .eq('workspace_id', workspaceId)
            .in('ig_handle', threadHandles)
            .in('status', ['dm_sent', 'replied', 'closed_lost'])
            .limit(threadHandles.length);
          let skippedInbound = 0;
          if (actionableLeads && actionableLeads.length > 0) {
            for (const thread of allInboxThreads) {
              const match = actionableLeads.find(l => l.ig_handle.toLowerCase() === thread.username.toLowerCase());
              if (match) {
                 matchedHandles.add(thread.username.toLowerCase());
                 // Skip inbound DM leads — only reply to outreach we initiated
                 if (match.source === 'inbound_dm') {
                   skippedInbound++;
                   continue;
                 }
                   // Check if lead is at terminal step before adding to queue
                  if (match.conversation_step < TERMINAL_STEP) {
                      // USE THE FLAG: inbox API already told us who sent last
                      if (!thread.selfLast) {
                        // THEY sent last — queue for AI reply
                        threads.push({
                          threadId: thread.threadId,
                          username: thread.username,
                          lastMessage: thread.lastMessage || '',
                          _source: 'inbox_api',
                          viewerId: thread.viewerId,
                          lastSenderId: thread.lastSenderId
                        });
                      } else {
                        // WE sent last — but was it a human manually? Check outbox
                        const msgs = await fetchThreadMessagesAPI(page, thread.threadId);
                        const lastFromUs = msgs && msgs.length > 0 ? [...msgs].reverse().find(m => m.isMe) : null;
                        if (lastFromUs) {
                          const isHuman = await isHumanMessage(supabase, workspaceId, match.id, lastFromUs.text);
                          if (isHuman) {
                            // Human manually replied — TERMINATE this thread permanently
                            try { await supabase.from('leads').update({
                              conversation_step: TERMINAL_STEP,
                              followup_step: 99,
                              last_updated_at: new Date().toISOString()
                            }).eq('id', match.id); } catch (e) {}
                            log('info', 'AI', `@${thread.username}: human takeover detected — terminating thread`);
                          }
                        }
                      }
                    }
               }
             }
          }
          if (skippedInbound > 0) {
            log('info', 'AI', `Skipped ${skippedInbound} inbound DM thread(s) — only replying to outreach`);
          }
          // NOTE: _needsLeadCreate path REMOVED — no longer auto-creating leads from organic DMs
          // If a thread isn't in our leads table, it's not our outreach — we don't reply
        }
        }
      }
    } catch (e) {
     log('warn', 'AI', `Inbox scan failed: ${e.message} — continuing`);
   }

  log('info', 'AI', `Inbox scan complete: ${threads.length} thread(s) queued for processing`);

  // --- DOM FALLBACK: scroll inbox page to lazy-load threads the API missed ---
  // Always run in inbox scan mode to maximize coverage
  if (threads.length === 0 || config.inboxScanMode) {
    try {
      const apiThreadIds = new Set(threads.map(t => t.threadId));
      const domThreads = await scanInboxDOM(page, 15);
      if (domThreads && domThreads.length > 0) {
        // Only add threads not already found by API
        const newDomThreads = domThreads.filter(t => !apiThreadIds.has(t.threadId));
        log('info', 'DOM_SCAN', `${newDomThreads.length} new threads from DOM (API had ${threads.length})`);
        if (config.inboxScanMode) {
          // INBOX SCAN MODE: Process all DOM threads, create leads on-the-fly
          let domQueued = 0;
          for (const t of newDomThreads) {
            if (!t.username) continue;
            try {
            let { data: existingLead } = await supabase.from('leads')
              .select('id, ig_handle, status, source')
              .eq('workspace_id', workspaceId)
              .eq('ig_handle', t.username.toLowerCase())
              .maybeSingle();
            
            if (!existingLead) {
              // Don't auto-create inbound DM leads from DOM scan — only reply to outreach
              continue;
             }
             
             // Only add thread to reply queue if lead is NOT at terminal step AND is not inbound DM
             const skipIfTerminal = existingLead && existingLead.conversation_step >= TERMINAL_STEP;
             const skipIfInbound = existingLead && existingLead.source === 'inbound_dm';
             if (!skipIfTerminal && !skipIfInbound) {
               threads.push({
                 threadId: t.threadId,
                 username: t.username,
                 lastMessage: '',
                 isUnread: true,
                 _source: 'dom_scan'
               });
               domQueued++;
             }
             } catch (e) {
               log('warn', 'DOM_SCAN', `Failed processing @${t.username}: ${e.message}`);
             }
           }
           if (domQueued > 0) {
             log('info', 'AI', `${domQueued} DOM thread(s) queued (inbox scan mode)`);
           }
          } else {
             // STANDARD MODE: Only process threads matching outreach-initiated leads (exclude inbound_dm)
             const domHandles = [...new Set(newDomThreads.map(t => (t.username || '').toLowerCase()).filter(Boolean))];
             if (domHandles.length > 0) {
               const { data: actionableLeads } = await supabase.from('leads')
                 .select('id, ig_handle, status, conversation_step, source')
                .eq('workspace_id', workspaceId)
                .in('ig_handle', domHandles)
                 .in('status', ['dm_sent', 'replied', 'closed_lost'])
                .limit(domHandles.length);
              if (actionableLeads && actionableLeads.length > 0) {
                let domQueued = 0;
                for (const t of newDomThreads) {
                  const match = actionableLeads.find(l =>
                    l.ig_handle.toLowerCase() === (t.username || '').toLowerCase()
                  );
                  if (match) {
                    // Skip inbound DM leads — only reply to outreach we initiated
                    if (match.source === 'inbound_dm') continue;
                    if (match.status !== 'replied') {
                      await supabase.from('leads').update({
                        status: 'replied',
                        last_updated_at: new Date().toISOString()
                      }).eq('id', match.id);
                      log('success', 'AI_REPLY_DETECT', `@${match.ig_handle} replied — tagged as replied (DOM)`);
                    }
                     // Check if lead is at terminal step before adding to queue
                      if (match.conversation_step < TERMINAL_STEP) {
                        threads.push({
                         threadId: t.threadId,
                         username: match.ig_handle,
                         lastMessage: '',
                         isUnread: true,
                         _source: 'dom_scan'
                       });
                        domQueued++;
                    }
                  }
                }
                if (domQueued > 0) {
                  log('info', 'AI', `${domQueued} DOM thread(s) queued (standard mode)`);
                }
              }
            }
         }
       }
     } catch (e) {
       log('warn', 'AI', `DOM scan fallback failed: ${e.message} — continuing`);
     }
   }

  // Page health check + recovery — inbox navigation may have crashed the page
  try { await page.evaluate(() => 1); } catch (_) {
    log('warn', 'AI_HEALTH', 'Page dead after inbox scan — recovering...');
    if (context) {
      try {
        page = await context.newPage();
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(5000);
        log('success', 'AI_HEALTH', 'Page recovered');
      } catch (e) {
        log('warn', 'AI_HEALTH', 'Could not recover page — skipping this pulse');
        await logActivity(supabase, logId, workspaceId, 0, 0, logErrors);
        return;
      }
    }
  }

  // HARD DEDUP: remove any remaining duplicate threadIds in the queue
  const seenIds = new Set();
  const dedupedThreads = [];
  for (const t of threads) {
    if (!seenIds.has(t.threadId)) {
      seenIds.add(t.threadId);
      dedupedThreads.push(t);
    } else {
      log('info', 'DEDUP', `Removed duplicate thread ${t.threadId} (@${t.username})`);
    }
  }
  threads.length = 0;
  threads.push(...dedupedThreads);

  // OUTBOX COOLDOWN: prevent replying to ourselves or spamming
  // SAFETY: NEVER reply if last message is from us (absolute rule)
  // COOLDOWN: Skip if we sent last DM within 1 pulse (~1 hour), retry next pulse
  // OVERRIDE: If DOM detected they replied, allow reply even if API lags
  const DM_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour (skip one pulse, retry next)
  const now = Date.now();
  try {
    const usernames = threads.map(t => t.username.toLowerCase()).filter(Boolean);
    if (usernames.length > 0) {
      // Get lead IDs for all threads in one query
      const { data: leads } = await supabase.from('leads')
        .select('id, ig_handle')
        .eq('workspace_id', workspaceId)
        .in('ig_handle', usernames);

      if (leads && leads.length > 0) {
        const leadIds = leads.map(l => l.id);
        const leadMap = {};
        for (const l of leads) leadMap[l.ig_handle] = l.id;

        // Get most recent outbox entry per lead in one query
        const { data: recentOutbox } = await supabase.from('outbox')
          .select('lead_id, sent_at, incoming_message')
          .eq('workspace_id', workspaceId)
          .in('lead_id', leadIds)
          .order('sent_at', { ascending: false });

        // Build set of leads we recently messaged without a reply
        const cooldownLeadIds = new Set();
        if (recentOutbox) {
          for (const leadId of leadIds) {
            const entry = recentOutbox.find(o => o.lead_id === leadId);
            if (entry && entry.sent_at) {
              const sentAt = new Date(entry.sent_at).getTime();
              // Find the thread for this lead
              const t = threads.find(th => leadMap[th.username.toLowerCase()] === leadId);

              // SAFETY: ABSOLUTE RULE — never reply to ourselves
              // If API says last message is from us, check if outbox has incoming_message (they replied)
              const lastMsgFromUs = t && t.lastSenderId && t.viewerId && t.lastSenderId === t.viewerId;
              const hasIncomingInbox = entry.incoming_message && entry.incoming_message.trim().length > 0;

              // They replied if: (1) API says last sender is them, OR (2) outbox has incoming message
              const theyReplied = (t && t.lastSenderId && t.viewerId && t.lastSenderId !== t.viewerId) || hasIncomingInbox;

              // Apply cooldown ONLY if WE sent the last message (they haven't replied)
              // Skip cooldown if they replied (detected via API or outbox)
              if (!theyReplied && (now - sentAt) < DM_COOLDOWN_MS) {
                cooldownLeadIds.add(leadId);
              }
            }
          }
        }

        // Filter threads by cooldown
        const threadsBefore = threads.length;
        const threadsWithCooldown = threads.filter(t => {
          const leadId = leadMap[t.username.toLowerCase()];
          if (leadId && cooldownLeadIds.has(leadId)) {
            // OVERRIDE: If DOM detected they replied, allow even if API lags
            if (t.lastSenderId && t.viewerId && t.lastSenderId !== t.viewerId) {
              log('info', 'DM_COOLDOWN', `@${t.username}: cooldown active but they replied (API) — allowing`);
              return true;
            }
            // SAFETY: ABSOLUTE RULE — if last message is from us, skip
            if (t.lastSenderId && t.viewerId && t.lastSenderId === t.viewerId) {
              log('info', 'DM_COOLDOWN', `@${t.username}: last message is from us — skipping (NEVER reply to ourselves)`);
              return false;
            }
            // Unknown sender — skip for safety
            log('info', 'DM_COOLDOWN', `@${t.username}: cooldown active, unknown sender — skipping`);
            return false;
          }
          return true;
        });

        if (threadsWithCooldown.length < threadsBefore) {
          log('info', 'DM_COOLDOWN', `${threadsBefore - threadsWithCooldown.length} thread(s) skipped by cooldown`);
        }
        threads.length = 0;
        threads.push(...threadsWithCooldown);
      }
    }
  } catch (e) {
    log('warn', 'DM_COOLDOWN', `Cooldown check failed: ${e.message} — continuing`);
  }

  threadsFound = threads.length;
  if (threadsFound === 0) {
    log('info', 'AI', 'No replied leads found. Skipping AI Setter this pulse.');
    await logActivity(supabase, logId, workspaceId, 0, 0, logErrors);
    return;
  }

  log('info', 'AI', `Found ${threadsFound} unread thread(s)`);

  let skippedSelfCount = 0;
  for (const thread of threads) {
    const detail = { username: thread.username, threadId: thread.threadId, action: 'pending', reply: '', intent: '', error: '' };
    threadDetails.push(detail);
    if (repliedThreads.has(thread.threadId)) { detail.action = 'skipped_duplicate'; continue; }
    if (threadsReplied >= maxRepliesPerPulse) {
      detail.action = 'rate_limited';
      log('info', 'AI_RATE', `Pulse cap reached (${maxRepliesPerPulse}) — stopping. ${threadsFound - threads.length} thread(s) deferred.`);
      break;
    }

    // Browser health check — abort if Chromium crashed
    try { await page.evaluate(() => 1); } catch (e) {
      log('error', 'AI_ABORT', 'Browser crashed mid-AI Setter — aborting remaining threads');
      for (const remaining of threads.slice(threads.indexOf(thread))) {
        const remDetail = threadDetails.find(d => d.threadId === remaining.threadId);
        if (remDetail) { remDetail.action = 'aborted_browser_dead'; remDetail.error = 'browser crashed'; }
      }
      break;
    }
    
    // Rate limit: delay between individual thread fetches
    if (threads.indexOf(thread) > 0) await delay(3000 + Math.random() * 5000);
    let messages = await fetchThreadMessagesAPI(page, thread.threadId);
    if (messages && messages.length > 0) {
      const lastMsgDebug = messages[messages.length - 1];
      if (!lastMsgDebug.isMe) {
        log('info', 'AI_THREAD', `@${thread.username}: ${messages.length} msgs, last.isMe=false last.text="${(lastMsgDebug.text || '').substring(0, 50)}"`);
      }
    }
    if (!messages || messages.length === 0) {
      // API fetch failed — fall back to navigating to thread page and reading DOM
      try {
        await page.goto(`https://www.instagram.com/direct/t/${thread.threadId}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await delay(3000);
        const lastMsgData = await page.evaluate(() => {
          const items = document.querySelectorAll('div[role="row"]');
          if (items.length === 0) return null;
          const last = items[items.length - 1];
          const text = (last.querySelector('div[dir="auto"]') || last).textContent.trim();
          const isMe = last.querySelector('[data-testid*="sent"], [data-testid*="message-conversation-message-sent"], [aria-label*="Sent"], [aria-label*="sent"], [style*="margin-left: auto"], [style*="flex-end"]') !== null;
          return { text, isMe };
        }).catch(() => null);
        if (lastMsgData && lastMsgData.text) {
          messages = [{ text: lastMsgData.text, isMe: lastMsgData.isMe, timestamp: Date.now() }];
          log('info', 'AI', `@${thread.username}: using DOM thread fallback (isMe: ${lastMsgData.isMe})`);
        }
      } catch (e) {}
      if (!messages || messages.length === 0) {
        detail.action = 'thread_gone';
        log('info', 'AI', `@${thread.username}: thread_gone (API failed, DOM fallback failed)`);
        continue;
      }
    }

    // Fetch lead data early — needed by both auto-responder check and email capture
    let leadId = null;
    let lead = null;
    try {
      const { data: l } = await supabase.from('leads').select('id, status, followup_step, conversation_step, conversation_data, bio, full_name, follower_count, email, first_name').eq('ig_handle', thread.username.toLowerCase()).limit(1).maybeSingle();
      if (l) { lead = l; leadId = l.id; }
    } catch (e) {}

    // Find last message from THEM (not us) — skip past action_logs, reactions, empty items
    // But also find our last message to compare timestamps
    const NON_CONV_TYPES = new Set(['action_log', 'story_reaction', 'story_share', 'reel_share', 'media', 'raven_media', 'animated_media', 'sticker', 'link']);
    let lastMsg = messages[messages.length - 1];
    let lastFromThem = null;
    let lastFromUs = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.isMe && !lastFromUs) lastFromUs = msg;
      if (!msg.isMe && !lastFromThem) lastFromThem = msg;
      if (lastFromUs && lastFromThem) break;
    }
    // Use the last message from THEM as lastMsg if it exists
    // This catches replies that come after our text (even if their reply is action_log/reaction)
    if (lastFromThem && lastFromUs) {
      const themTs = parseInt(lastFromThem.timestamp || '0');
      const usTs = parseInt(lastFromUs.timestamp || '0');
      if (themTs > usTs) {
        // They replied AFTER us — use their message as lastMsg
        lastMsg = lastFromThem;
      } else {
        // Our message is newest — find last real text for context
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          const type = msg.itemType || 'text';
          if (!NON_CONV_TYPES.has(type) && (msg.text || '').trim()) {
            lastMsg = msg;
            break;
          }
        }
      }
    } else if (lastFromThem) {
      lastMsg = lastFromThem;
    }

    // Skool link dedup guard — don't send the same link twice
    if (lead && lead.conversation_step && lead.conversation_step >= TERMINAL_STEP) {
      repliedThreads.add(thread.threadId);
      detail.action = 'already_terminal';
      log('info', 'AI_DEDUP', `@${thread.username} already at terminal step — skipping`);
      continue;
    }

    // HUMAN TAKEOVER: outbox-based detection — 100% reliable
    if (lastMsg.isMe) {
      const isHuman = await isHumanMessage(supabase, workspaceId, lead?.id, lastMsg.text);
      if (isHuman) {
        if (lead) {
          try { await supabase.from('leads').update({
            conversation_step: TERMINAL_STEP,
            followup_step: 99,
            last_updated_at: new Date().toISOString()
          }).eq('id', lead.id); } catch (e) {}
        }
        repliedThreads.add(thread.threadId);
        detail.action = 'human_takeover';
        log('info', 'AI', `@${thread.username}: human message detected (not in outbox) — closing`);
        continue;
      }
      // It's our own AI message — skip
      repliedThreads.add(thread.threadId);
      detail.action = 'skipped_last_from_me';
      skippedSelfCount++;
      continue;
    }

    // Deferred lead creation — REMOVED: no longer auto-creating leads from organic DMs
    // If a thread isn't in our leads table, it's not our outreach — skip it
    if (!lead && thread._needsLeadCreate) {
      log('info', 'AI', `@${thread.username}: skipping unread thread not in leads table (not our outreach)`);
      continue;
    }

    // --- STORY REACTIONS / STICKERS / MEDIA / SYSTEM: skip (no auto-reply) ---
    const lastItemType = lastMsg.itemType || 'text';
    const isEmptyText = !(lastMsg.text || '').trim();
    const isNonConversation = lastItemType === 'story_reaction' || lastItemType === 'story_share' || lastItemType === 'reel_share' || lastItemType === 'media' || lastItemType === 'raven_media' || lastItemType === 'animated_media' || lastItemType === 'sticker' || lastItemType === 'link' || lastItemType === 'action_log' || isEmptyText;
    // System/Instagram noise messages — not real conversation
    const lastText = (lastMsg.text || '').trim();
    const isSystemNoise = /^(new messages|You're now friends\. Say hi!|This video can only be replayed once|Use the mobile app to view|this story will be available|message request|pending message|filtered message)/i.test(lastText);
    if (isNonConversation || isSystemNoise) {
      repliedThreads.add(thread.threadId);
      detail.action = 'skipped_reaction';
      log('info', 'AI_REACTION_SKIP', `@${thread.username}: skipping non-conversation item (type: ${lastItemType}, isEmptyText: ${isEmptyText}, isSystemNoise: ${isSystemNoise})`);
      continue;
    }

    const lastIncoming = sanitizeInput(lastMsg.text || '');

    // BOT-ON-BOT / SPAM DETECTION: lead is another bot or service provider
    if (isBotOnBot(lastIncoming, messages)) {
      repliedThreads.add(thread.threadId);
      detail.action = 'closed_bot';
      log('info', 'AI_BOT', `@${thread.username}: detected bot/spam/service provider "${lastIncoming.substring(0, 60)}" — closing`);
      if (lead) {
        await supabase.from('leads').update({
          status: 'closed_lost',
          conversation_step: TERMINAL_STEP,
          followup_step: 99,
          last_updated_at: new Date().toISOString()
        }).eq('id', lead.id);
      }
      continue;
    }

    // HARD CLOSE: clear rejection — don't waste a DM slot asking another question
    const t = lastIncoming.toLowerCase().trim();
    const isClearRejection = /^(no$|nope$|nah$|pass$|no thanks$|no thank you$|not interested$|not for me$|i.ll pass$|i am good$|i.m good$|im good$|no need$|not now$|not right now$|skip it$|skip for now$|maybe later$|some other time$|i.m okay$|im okay$|i.m fine$|im fine$|leave me alone$|stop messaging$|don.t contact me$|do not contact me$|not a fit$|not the right time$|already have one$|already doing that$|i.m all set$|im all set$|i.m good for now$|im good for now$|thanks but no$|thank you but no$|not looking for$|not seeking$|not wanting$|not interested in$|decline$|no longer interested$|count me out$|i will pass$|unable to commit$|can.t commit$|cannot commit$|not ready$|not able to$|in therapy$|my therapist$|therapist (said|recommended|advised|suggested)|not in a position$|not (able|in) to (commit|join|participate)|not the right (time|moment)|can.t (join|participate|commit) (right now|at the moment|currently)$)/i.test(t) || /\b(not interested|not now|skip it|skip for now|maybe later|i.ll pass|i am good|i.m all set|im all set|not a fit|not the right time|decline|count me out|no longer interested|unable to commit|can.t commit|in therapy|therapist|not ready|not able to)\b/i.test(t);
    if (isClearRejection && convoStep > 0 && convoStep < TERMINAL_STEP) {
      repliedThreads.add(thread.threadId);
      detail.action = 'closed_rejection';
      log('info', 'AI_CLOSE', `@${thread.username}: clear rejection "${lastIncoming}" — closing`);
      if (lead) {
        await supabase.from('leads').update({
          status: 'closed_lost',
          conversation_step: TERMINAL_STEP,
          followup_step: 99,
          last_updated_at: new Date().toISOString()
        }).eq('id', lead.id);
      }
      continue;
    }

    // ECHO/PARROT DETECTION: lead copied our message — skip to avoid self-reply loop
    if (isEchoOrParrot(messages)) {
      repliedThreads.add(thread.threadId);
      detail.action = 'skipped_echo';
      log('warn', 'AI_ECHO', `@${thread.username}: lead echoed our message — skipping to avoid self-reply loop`);
      continue;
    }

    // Handoff decisions are handled by the AI via training context — no hardcoded keyword bypass

    // Build conversation context for AI
    let conversation = messages.map(m => {
      return `${m.isMe ? 'You' : '@' + thread.username}: "${sanitizeInput(m.text || '')}"`;
    }).join('\n');

    // --- CONVERSATION STATE MACHINE ---
    let convoStep = lead?.conversation_step || 0;

    // Guard: force non-leads into simple-reply path (no funnel, no DB tracking)
    if (!lead) convoStep = TERMINAL_STEP;

    // Prepend lead profile context for AI (bio, name, followers from harvested data)
    if (lead) {
      const profileParts = [];
      if (lead.full_name) profileParts.push(`Name: ${lead.full_name}`);
      if (lead.bio) profileParts.push(`Bio: ${lead.bio}`);
      if (lead.follower_count) profileParts.push(`Followers: ${lead.follower_count}`);
      if (profileParts.length > 0) {
        conversation = `Lead's public profile:\n${profileParts.join('\n')}\n\n${conversation}`;
      }
    }

    // ── HYBRID FUNNEL HANDLER ──────────────────────────────────
    const funnelType = config?.funnelType;
    if (funnelType && ['author', 'affiliate', 'wherewebelong'].includes(funnelType) && lead && convoStep < TERMINAL_STEP) {
      try {
        // Route to correct hybrid handler by funnelType
        const isWWB = funnelType === 'wherewebelong';
        const handler = require(isWWB ? './hybrid/handler.cjs' : './hybrid/handler_jani.cjs');
        const funnelConfig = require(isWWB ? './hybrid/funnel_config.cjs' : './hybrid/funnel_config_jani.cjs');
        const rulesEngine = require(isWWB ? './hybrid/rules_engine.cjs' : './hybrid/rules_engine_jani.cjs');

        if (isWWB) {
          // ── WhereWeBelong hybrid handler ──
          const funnelState = lead.conversation_data?.funnel || {
            current_stage: funnelConfig.FUNNEL_STARTING_STAGE,
            conversation_history: [],
            exchanges_in_current_stage: 0,
          };

          const lastMessages = [];
          if (lastIncoming) lastMessages.push({ body: lastIncoming, direction: 'in', timestamp: new Date().toISOString() });

          const result = await handler.handleInboundMessage(lead, lastMessages, config, funnelState);

          if (result.send) {
            const canSend = await canSendToThread(page, thread.threadId);
            if (!canSend) { detail.result = 'skip_thread_not_safe'; continue; }
            await sendReplyViaPage(page, thread.threadId, result.text);

            // Persist funnel state
            const updatedFunnel = { ...result.funnelState };
            if (!updatedFunnel.conversation_history) updatedFunnel.conversation_history = [];
            updatedFunnel.conversation_history.push({ is_me: true, text: result.text.substring(0, 200) });
            if (lastIncoming) {
              updatedFunnel.conversation_history.push({ is_me: false, text: lastIncoming.substring(0, 200) });
              updatedFunnel.conversation_history = updatedFunnel.conversation_history.slice(-20);
            }

            await supabase.from('leads').update({
              conversation_data: { ...(lead.conversation_data || {}), funnel: updatedFunnel },
              conversation_step: (lead.conversation_step || 0) + 1,
              status: 'replied',
              last_updated_at: new Date().toISOString(),
            }).eq('id', lead.id);

            detail.reply = result.text.substring(0, 200);
            detail.result = `sent_hybrid_${result.outcome}`;
            log('info', 'HYBRID_WWB', `@${thread.username} ${result.outcome} → reply sent`);
          } else {
            detail.result = result.outcome || 'hybrid_no_send';
            log('info', 'HYBRID_WWB_SKIP', `@${thread.username} ${result.outcome || 'no action'}`);
          }
          continue;

        } else {
          // ── Author/Affiliate/WhereWeBelong hybrid handler ──
          const funnelState = {
            step: convoStep,
            lastMessageAt: lead.last_dm_sent_at || lead.last_updated_at,
            emailCaptured: !!lead.email,
            nameCaptured: !!lead.first_name,
            offerSent: convoStep >= funnelConfig.STAGES.OFFER,
            callLinkSent: false,
            disclosed: convoStep >= funnelConfig.STAGES.OFFER,
          };

          const decisions = rulesEngine.analyze(funnelState, lastIncoming, funnelType);

          if (decisions.objection) {
            const response = handler.handleObjection(decisions.objection, funnelType);
            funnelState.step = decisions.nextStep;
            await supabase.from('leads').update({
              conversation_step: decisions.nextStep,
              status: 'replied',
              last_updated_at: new Date().toISOString(),
            }).eq('id', lead.id);

            detail.reply = response.substring(0, 200);
            const canSend = await canSendToThread(page, thread.threadId);
            if (!canSend) { detail.result = 'skip_thread_not_safe'; continue; }
            await sendReplyViaPage(page, thread.threadId, response);
            detail.result = 'sent_hybrid_objection';
            log('info', 'HYBRID_OBJECTION', `@${thread.username} objection ${decisions.objection.id} → reply sent`);
            continue;
          }

          if (decisions.action === 'crisis' || decisions.action === 'stop') {
            const response = decisions.action === 'crisis'
              ? handler.handleCrisis()
              : handler.handleHostility();
            await supabase.from('leads').update({
              conversation_step: funnelConfig.STAGES.CRISIS,
              status: 'closed_lost',
              last_updated_at: new Date().toISOString(),
            }).eq('id', lead.id);

            detail.reply = response.substring(0, 200);
            const canSend = await canSendToThread(page, thread.threadId);
            if (canSend) await sendReplyViaPage(page, thread.threadId, response);
            detail.result = `sent_hybrid_${decisions.action}`;
            log('info', `HYBRID_${decisions.action.toUpperCase()}`, `@${thread.username} ${decisions.action} → reply sent`);
            continue;
          }

          const validation = rulesEngine.validateMessage(lastIncoming, funnelState, funnelType);
          if (!validation.valid) {
            detail.result = `blocked_${validation.error}`;
            log('warn', 'HYBRID_VALIDATION', `@${thread.username} blocked: ${validation.error}`);
            continue;
          }

          if (decisions.action === 'advance') {
            funnelState.step = decisions.nextStep;
          }

          // EMAIL + NAME CAPTURE: detect in any incoming message and persist to DB + AWeber
          let capturedEmail = null;
          let capturedName = null;
          const emailMatch = (lastIncoming || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (emailMatch && !lead.email) {
            capturedEmail = emailMatch[0];
            funnelState.emailCaptured = true;

            // Try to extract a name from the same message
            const withoutEmail = lastIncoming.replace(capturedEmail, '').trim();
            const namePatterns = [
              /^([A-Za-z][a-zA-Z]+(?:\s+[A-Za-z][a-zA-Z]+)?)[,\.\s]+/,   // "Jane Doe, jane@..."
              /[,\.\s]+([A-Za-z][a-zA-Z]+(?:\s+[A-Za-z][a-zA-Z]+)?)$/,     // "jane@..., Jane Doe"
              /^([A-Za-z][a-zA-Z]+(?:\s+[A-Za-z][a-zA-Z]+)?)$/              // just "Jane Doe"
            ];
            for (const p of namePatterns) {
              const m = withoutEmail.match(p);
              if (m) { capturedName = m[1].trim(); break; }
            }

            // Skip AWeber subscription if the lead previously unsubscribed
            const isUnsubscribed = lead.aweber_status === 'unsubscribed' || lead.aweber_status === 'bounced' || lead.aweber_status === 'complained';
            if (isUnsubscribed) {
              log('info', 'AWEBER_SKIP', `@${thread.username}: previously ${lead.aweber_status} — not re-adding to AWeber`);
              await supabase.from('leads').update({
                email: capturedEmail,
                first_name: capturedName || lead.first_name || null,
                last_updated_at: new Date().toISOString(),
              }).eq('id', lead.id);
            } else {
              // Subscribe to AWeber
              try {
                const profileCfg = funnelConfig.getProfileConfig(funnelType);
                const { subscribe } = require('./hybrid/aweber_subscribe.cjs');
                const aweberResult = await subscribe({
                  accessToken: config.aweberAccessToken,
                  listId: profileCfg.aWeber.listId,
                  email: capturedEmail,
                  name: capturedName || lead.first_name || '',
                  tags: [...profileCfg.aWeber.coreTags, `workspace-${(workspaceId || '').substring(0, 8)}`],
                  customFields: { ig_handle: thread.username, source: 'instagram_dm' },
                  refreshToken: config.aweberRefreshToken,
                  clientId: config.aweberClientId,
                  clientSecret: config.aweberClientSecret,
                  supabase,
                  workspaceId,
                });

                if (aweberResult.success) {
                  log('info', 'AWEBER', `Subscribed ${capturedEmail} to list ${profileCfg.aWeber.listId}${aweberResult.duplicate ? ' (duplicate)' : ''}`);
                } else {
                  log('warn', 'AWEBER_FAILED', `Failed to subscribe ${capturedEmail}: ${aweberResult.error}`);
                }

                await supabase.from('leads').update({
                  email: capturedEmail,
                  first_name: capturedName || lead.first_name || null,
                  aweber_status: aweberResult.success ? (aweberResult.duplicate ? 'duplicate' : 'added') : 'failed',
                  last_updated_at: new Date().toISOString(),
                }).eq('id', lead.id);
              } catch (captureErr) {
                log('warn', 'EMAIL_CAPTURE', `Failed to capture/subscribe email for @${thread.username}: ${captureErr.message}`);
                await supabase.from('leads').update({
                  email: capturedEmail,
                  first_name: capturedName || lead.first_name || null,
                  aweber_status: 'failed',
                  last_updated_at: new Date().toISOString(),
                }).eq('id', lead.id);
              }
            }
          }

          const responder = require('./hybrid/llm_responder_jani.cjs');
          const response = await responder.generateResponse(decisions, funnelState, lastIncoming, lead, apiKey, funnelType);
          if (!response || !response.text) { log('warn', 'HYBRID_NO_REPLY', `LLM returned no reply for @${thread.username}`); continue; }

          await supabase.from('leads').update({
            conversation_step: funnelState.step,
            status: 'replied',
            last_updated_at: new Date().toISOString(),
          }).eq('id', lead.id);

          detail.reply = response.text.substring(0, 200);
          const canSend = await canSendToThread(page, thread.threadId);
          if (!canSend) { detail.result = 'skip_thread_not_safe'; continue; }
          await sendReplyViaPage(page, thread.threadId, response.text);
          detail.result = 'sent_hybrid';
          log('info', 'HYBRID_SENT', `@${thread.username} step ${funnelState.step} → reply sent`);
          continue;
        }

      } catch (hybridErr) {
        log('warn', 'HYBRID_ERROR', `Hybrid handler failed for @${thread.username}: ${hybridErr.message}, falling back to callAI`);
      }
    }
    // ── END HYBRID FUNNEL HANDLER ─────────────────────────────────

    // ── DETERMINISTIC TEMPLATE FUNNEL (no LLM) ─────────────────────
    if (config.deterministicFunnel === true) {
      if (convoStep === 0) convoStep = 1;
      const steps = getSteps(config);
      const currentStep = steps.find(s => s.step === convoStep);

      if (currentStep && typeof currentStep.message === 'string' && currentStep.message.trim()) {
        const firstName = lead?.first_name || thread.username;
        const message = currentStep.message
          .replace(/{{name}}/gi, thread.username)
          .replace(/{{first_name}}/gi, firstName);

        const canSend = await canSendToThread(page, thread.threadId);
        if (!canSend) {
          log('warn', 'DETERMINISTIC_BLOCKED', `@${thread.username}: cannot send — last message is from us`);
          detail.action = 'skipped_last_from_me';
          repliedThreads.add(thread.threadId);
          await delay(10000 + Math.random() * 15000);
          continue;
        }

        const sent = await sendReplyViaPhysical(page, thread.threadId, message, thread.username);
        if (sent) {
          const nextStep = convoStep + 1;
          const maxStep = Math.max(...steps.map(s => s.step || 0), 0);
          const isTerminal = nextStep > maxStep;
          const newStep = isTerminal ? TERMINAL_STEP : nextStep;

          if (lead) {
            try {
              await supabase.from('leads').update({
                conversation_step: newStep,
                followup_step: isTerminal ? 99 : (lead.followup_step || 0),
                status: 'replied',
                last_updated_at: new Date().toISOString()
              }).eq('id', lead.id);
            } catch (e) {}
          }

          try {
            await supabase.from('outbox').insert({
              workspace_id: workspaceId,
              lead_id: leadId,
              message,
              incoming_message: lastIncoming,
              status: 'auto_replied',
              sent_at: new Date().toISOString()
            });
          } catch (e) {}

          threadsReplied++;
          repliedThreads.add(thread.threadId);
          log('success', 'DETERMINISTIC_SENT', `@${thread.username} step ${convoStep} → sent ${message.length} chars`);
          await sendTelegram(config, formatTelegramReply(thread.username, message, lastIncoming, `deterministic_step_${convoStep}→${newStep}`, convoStep));
        } else {
          log('warn', 'DETERMINISTIC_FAIL', `Failed to send deterministic reply to @${thread.username}`);
        }
      } else {
        log('warn', 'DETERMINISTIC_NO_TEMPLATE', `@${thread.username}: no template for step ${convoStep}`);
      }
      await delay(10000 + Math.random() * 15000);
      continue;
    }
    // ── END DETERMINISTIC TEMPLATE FUNNEL ──────────────────────────

    // If conversation is complete or disabled, use simple reply fallback
    if (!conversationEnabled || convoStep >= TERMINAL_STEP) {
      // Simple reply fallback — uses workspace's ai_training_context for voice/persona
      const systemPrompt = `You are replying to Instagram DMs on behalf of the account owner. Use the persona and voice described below. Never reveal you are an AI.

${sanitizeForGemini(trainingContext) || 'Be warm, direct, and professional. Short messages, 1-2 sentences max. No abbreviations like "u" or "lol". No emoji unless the person uses them first.'}

Rules:
- Write SHORT messages. 1-2 sentences max. Never more than 3.
- Match the tone and speaking style described in the persona above.
- Always write a COMPLETE thought — never cut off mid-sentence.
- Never reveal you are an AI or a bot.
- Use the person's first name naturally if you know it.
- If the conversation is going well, follow the DM flow described in the persona above.
- If they want a real conversation or ask to connect, hand off to the account owner.`;

      const prompt = sanitizeForGemini(`Conversation history:\n${conversation}\n\nIncoming from @${thread.username}: "${lastIncoming}"\n\nReply:`);
      let reply = await callAI(apiKey, prompt, 3, sanitizeForGemini(systemPrompt), config);
      if (!reply) { log('warn', 'AI_NO_REPLY', `Gemini returned no reply for @${thread.username}`); continue; }

      detail.reply = reply.substring(0, 200);
      // PRE-SEND CHECK: navigate to thread and confirm lead's message is last before sending
      const canSend = await canSendToThread(page, thread.threadId);
      if (!canSend) {
        log('warn', 'AI_BLOCKED', `@${thread.username}: last message is from us — skipping simple reply`);
        repliedThreads.add(thread.threadId);
        detail.action = 'skipped_last_from_me';
        await delay(10000 + Math.random() * 15000);
        continue;
      }
      const sent = await sendReplyViaPhysical(page, thread.threadId, reply, thread.username);
      if (sent) {
        threadsReplied++;
        repliedThreads.add(thread.threadId);
        detail.action = 'replied_simple';

        // VERIFY: confirm our message is the last one before updating lead status
        const verified = await verifyOurMessageIsLast(page, thread.threadId);
        if (!verified) {
          log('warn', 'AI_VERIFY', `@${thread.username}: simple reply sent but unverified — keeping dm_sent status`);
          detail.action = 'replied_simple_unverified';
          await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: leadId, message: reply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }).then(() => {}, () => {});
          await delay(10000 + Math.random() * 15000);
          continue;
        }

        if (lead) {
          const negative = ['not interested', 'no thanks', 'stop', 'don\'t contact', 'unsubscribe', 'leave me alone', 'not now', 'no thank', 'no.', 'never', 'remove me'];
          const positive = ['let\'s do it', 'book a call', 'interested', 'sounds great', 'let\'s talk', 'schedule', 'call me', 'yes please', 'tell me more', 'i\'m in', 'count me in', 'when can we', 'let\'s hop'];
          let newStatus = 'replied';
          let isRejected = false;
          // Check negative first to avoid "not interested" matching positive "interested"
          if (negative.some(k => new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(incoming))) {
            isRejected = true;
          } else if (positive.some(k => new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(incoming))) {
            newStatus = 'meeting_booked';
          }
          detail.intent = isRejected ? 'closed_lost' : newStatus;
          const extra = {};
          if (newStatus === 'meeting_booked' || isRejected) {
            extra.followup_step = 99;
            extra.conversation_step = TERMINAL_STEP;
          } else if (newStatus === 'replied') {
            extra.followup_step = config.maxFollowups || 0;
          }
          const updateData = { status: newStatus, followup_step: extra.followup_step, last_updated_at: new Date().toISOString() };
          if (extra.conversation_step !== undefined) updateData.conversation_step = extra.conversation_step;
          await supabase.from('leads').update(updateData).eq('id', lead.id);
          if (newStatus !== 'replied') log('ai', 'INTENT', `@${thread.username} \u2192 ${newStatus}`);

          // if (newStatus === 'meeting_booked' && calendlyLink) {
          //   await delay(1500);
          //   const sentLink = await sendReplyViaPhysical(page, thread.threadId, `Would you like to hop on a quick call? ${calendlyLink}`);
          //   if (sentLink) {
          //     try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: calendlyLink, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
          //     log('success', 'AI', `Sent booking link to @${thread.username}`);
          //   }
          // }
        }

        try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: leadId, message: reply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
        
        log('success', 'AI', `Replied to @${thread.username}: "${reply.substring(0, 80)}"`);
        await sendTelegram(config, formatTelegramReply(thread.username, reply, lastIncoming, 'simple_reply', null));
      } else {
        detail.action = 'send_failed';
        detail.error = 'send failed';
        log('warn', 'AI_SEND_FAIL', `Failed to reply to @${thread.username} — send returned false`);
      }
      await delay(10000 + Math.random() * 15000);
      continue;
    }

    // --- QUALIFICATION FUNNEL ---
    if (convoStep === 0) convoStep = 1; // Start funnel

    // Terminal route decision step (configurable, default 7)
    var routeStep = config.conversationRoutingStep || 7;
    if (convoStep >= routeStep) {
      // MAX EXCHANGES GUARD: if conversation is 6+ exchanges past routing step, close
      const routeExchanges = messages ? messages.filter(m => m.text && m.text.trim()).length : 0;
      if (routeExchanges > 12) {
        repliedThreads.add(thread.threadId);
        detail.action = 'closed_max_exchanges';
        log('info', 'AI_CLOSE', `@${thread.username}: ${routeExchanges} exchanges past routing step — closing`);
        if (lead) {
          await supabase.from('leads').update({
            conversation_step: TERMINAL_STEP,
            followup_step: 99,
            last_updated_at: new Date().toISOString()
          }).eq('id', lead.id);
        }
        continue;
      }
      const routeRaw = 'Conversation history with @' + thread.username + ':\n' + conversation + '\n\nTheir latest message: "' + lastIncoming + '"\n\nReply naturally to their message. Write SHORT \u2014 1-2 sentences max, one continuous line, no line breaks. Match the tone and speaking style from the business context above. Never reveal you\'re following a script. NEVER ask for their name \u2014 you already know it. Only share your link if they explicitly ask for it or the conversation naturally leads to it. Never proactively drop the link.';
      const routePrompt = sanitizeForGemini(routeRaw);

      let reply = await callAI(apiKey, routePrompt, 3, sanitizeForGemini(trainingContext) || null, config);
      if (!reply) continue;

      const cleanReply = reply.trim();

      // PRE-SEND CHECK: navigate to thread and confirm lead's message is last before sending
      const canSend = await canSendToThread(page, thread.threadId);
      if (!canSend) {
        log('warn', 'AI_BLOCKED', `@${thread.username}: last message is from us — skipping route reply`);
        repliedThreads.add(thread.threadId);
        detail.action = 'skipped_last_from_me';
        await delay(10000 + Math.random() * 15000);
        continue;
      }

      // Send final reply then go terminal
      const sent = await sendReplyViaPhysical(page, thread.threadId, cleanReply, thread.username);
      if (sent) {
        threadsReplied++;
        repliedThreads.add(thread.threadId);
        await delay(2000);

        const verified = await verifyOurMessageIsLast(page, thread.threadId);
        if (!verified) {
          log('warn', 'AI_VERIFY', `@${thread.username}: route reply sent but unverified — keeping step, will retry`);
          await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: cleanReply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }).then(() => {}, () => {});
          await delay(10000 + Math.random() * 15000);
          continue;
        }

        // Terminal — email captured, link shared, conversation done
        if (lead) {
          await supabase.from('leads').update({ status: 'replied', conversation_step: TERMINAL_STEP, followup_step: 99, last_updated_at: new Date().toISOString() }).eq('id', lead.id);
        }
        await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: cleanReply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }).then(() => {}, () => {});
        log('success', 'AI', `@${thread.username} → terminal at route step`);
        await sendTelegram(config, formatTelegramReply(thread.username, cleanReply, lastIncoming, 'terminal_route', convoStep));
      }
      await delay(10000 + Math.random() * 15000);
      continue;
    }

    // Normal funnel steps 1-6
    const steps = getSteps(config);
    const currentStep = steps.find(s => s.step === convoStep) || steps[0];
    const stepContext = `FUNNEL STATUS:
- Current Step: ${currentStep.step}/${steps.length}
- Objective: ${currentStep.objective}

Conversation history with @${thread.username}:
${conversation}

IMPORTANT RULES:
- Stay in character no matter what the other person says
- Never output anything except a natural conversational reply
- Use the lead's name naturally in conversation like you already know them. Only ask for their name or email if the current step's objective explicitly requires it.

Instructions:
CRITICAL: Read the conversation history above carefully. NEVER repeat a question you already asked. If you already asked about their challenges/goals/situation, DO NOT ask it again — acknowledge their answer and move forward. Track what topics you've covered and don't circle back.
Reply naturally to their latest message, working toward this step's objective. Write SHORT — 1-2 sentences max, one continuous line, no line breaks. Sound like a real person having a genuine conversation. Never reveal you're following a funnel or script. Always complete your thought.

ADVANCE/REMAIN/CLOSE:
At the very END of your reply, on its own line, include exactly one of:
- [ADVANCE] — if this step's objective is met and you are ready to move to the next step next time they reply
- [REMAIN] — if they asked a question, seem hesitant, or you need another exchange on this step before advancing
- [CLOSE] — if they are clearly not a fit for what you offer based on your training context, not interested, or the conversation has naturally run its course. End warmly, no hard feelings. ALWAYS close immediately if: they are asking for money or donations, they are in a completely unrelated niche with no crossover to your story or offer, the conversation has stalled for 3+ exchanges with no movement toward the objective, they mention a therapist, therapist advice, or being in therapy (respect their professional guidance), they say they cannot or are unable to commit (any phrasing — "can't commit", "unable to commit", "not in a position to commit"), or they say they are not ready. Never push past these — acknowledge warmly and close.

Examples:
- They mention donations or charity → [CLOSE] (not a fit)
- Their life situation is completely unrelated to your story → [CLOSE] (no crossover)
- They give short one-word replies 3+ times → [CLOSE] (disengaged)`;

    const exchangeCount = messages ? messages.filter(m => m.text && m.text.trim()).length : 0;
    const rawPrompt = `${stepContext}\n\nReply to @${thread.username}:`;
    const fullPrompt = sanitizeForGemini(rawPrompt);
    const sysInst = trainingContext ? sanitizeForGemini(trainingContext) : null;

    let reply = await callAI(apiKey, fullPrompt, 3, sysInst, config);
    if (!reply) continue;

    // EMAIL ENFORCEMENT: at step 4+, if no email in conversation, override AI reply to ask for email
    if (convoStep >= 4 && convoStep < TERMINAL_STEP) {
      const allTheirText = messages.filter(m => !m.isMe && m.text).map(m => m.text).join(' ');
      const hasEmailInConvo = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(allTheirText) || /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(lastIncoming || '');
      if (!hasEmailInConvo) {
        const emailAskVariants = [
          `What's the best email to send it to?`,
          `I'd love to send it over — what email should I use?`,
          `What email works best for you?`,
          `Can you drop your email so I can send it?`,
        ];
        const overrideReply = emailAskVariants[Math.floor(Math.random() * emailAskVariants.length)];
        log('warn', 'EMAIL_ENFORCE', `@${thread.username}: step ${convoStep} but no email in conversation — overriding AI reply to ask for email`);
        reply = overrideReply;
      }
    }

    const cleanReply = reply.replace(/\[ADVANCE\]|\[REMAIN\]|\[CLOSE\]/gi, '').trim();

    // AUTO-CLOSE: if incoming message is a clear rejection, close immediately — don't let AI override
    if (lead && lastIncoming) {
      const rejectPatterns = [
        /\bno\b.*\b(change|thanks|interested|need|good|fine|want)\b/i,
        /\bnot?\s+(interested|looking|ready|now|today)\b/i,
        /\b(don'?t|do not)\s+(need|want|have time)\b/i,
        /\b(stop|unsubscribe|remove|leave me alone)\b/i,
        /\bno thanks?\b/i,
        /\bno thank you\b/i,
        /\bi'?m\s+(good|fine|ok|okay)\b/i,
        /\beverything\s+(is\s+)?(going\s+)?(really\s+)?fine\b/i,
        /\bi\s+don'?t\s+want\s+(any\s+)?change\b/i,
        /\bcan'?t\s+commit\b/i,
        /\bnot\s+in\s+a\s+position\b/i,
        /\bnot\s+ready\b/i,
        /\bnever\s+mind\b/i,
        /\bforget\s+it\b/i,
        /\bdon'?t\s+(waste|bother)\s+your\s+time\b/i,
        /\b(not\s+for\s+me|not\s+interested\s+in\s+this)\b/i,
      ];
      const isRejection = rejectPatterns.some(p => p.test(lastIncoming));
      if (isRejection) {
        log('ai', 'AUTO_CLOSE', `@${thread.username}: incoming "${lastIncoming.substring(0, 60)}" matches rejection pattern — closing`);
        const closeReply = 'No problem at all. Take care!';
        const canSendClose = await canSendToThread(page, thread.threadId);
        if (canSendClose) {
          await sendReplyViaPhysical(page, thread.threadId, closeReply, thread.username);
        }
        await supabase.from('leads').update({
          status: 'closed_lost',
          conversation_step: TERMINAL_STEP,
          followup_step: 99,
          last_updated_at: new Date().toISOString()
        }).eq('id', lead.id);
        await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: closeReply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }).then(() => {}, () => {});
        repliedThreads.add(thread.threadId);
        detail.action = 'auto_closed_rejection';
        detail.intent = 'closed_lost';
        await sendTelegram(config, formatTelegramReply(thread.username, closeReply, lastIncoming, '🚫 auto_closed_rejection', null));
        await delay(10000 + Math.random() * 15000);
        continue;
      }
    }

    // LINK BLOCK: never send the framework link before email is captured
    const funnelLink = config.frameworkLink || calendlyLink || '';
    if (funnelLink && cleanReply.includes(funnelLink) && convoStep < 4) {
      const allTheirText = messages.filter(m => !m.isMe && m.text).map(m => m.text).join(' ');
      const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(allTheirText);
      if (!hasEmail) {
        log('warn', 'LINK_BLOCK', `@${thread.username}: AI tried to send link before email captured (step ${convoStep}) — forcing REMAIN`);
        cleanReply = cleanReply.replace(new RegExp(funnelLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').trim() || 'I will send it over shortly. What is your best email address?';
      }
    }

    // PRE-SEND CHECK: navigate to thread and confirm lead's message is last before sending
    const canSend = await canSendToThread(page, thread.threadId);
    if (!canSend) {
      log('warn', 'AI_BLOCKED', `@${thread.username}: last message is from us — skipping send`);
      repliedThreads.add(thread.threadId);
      detail.action = 'skipped_last_from_me';
      await delay(10000 + Math.random() * 15000);
      continue;
    }

    const sent = await sendReplyViaPhysical(page, thread.threadId, cleanReply, thread.username);
    if (sent) {
      threadsReplied++;
      repliedThreads.add(thread.threadId);

      // VERIFY: navigate to thread and confirm our message is the last one before advancing
      const verified = await verifyOurMessageIsLast(page, thread.threadId);
      if (!verified) {
        log('warn', 'AI_VERIFY', `@${thread.username}: could not verify our message is last — advancing step anyway since message was sent`);
        detail.action = 'replied_funnel_unverified';
        detail.reply = cleanReply.substring(0, 200);
        // Still advance the step since message was sent — don't get stuck
        const unverifiedNext = Math.min(convoStep + 1, routeStep);
        await supabase.from('leads').update({ conversation_step: unverifiedNext, status: 'replied', last_updated_at: new Date().toISOString() }).eq('id', lead.id);
        await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: cleanReply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }).then(() => {}, () => {});
        await delay(10000 + Math.random() * 15000);
        continue;
      }

      // Advance/Remain/Close based on AI markers
      let wantsAdvance = /\[ADVANCE\]/i.test(reply);
      const wantsClose = /\[CLOSE\]/i.test(reply);
      const funnelLink = config.frameworkLink || calendlyLink || '';
      const linkShared = funnelLink && cleanReply.includes(funnelLink);

      // AUTO-ADVANCE FALLBACK: if AI didn't return [ADVANCE] but lead gave a substantive response, advance anyway
      if (!wantsAdvance && !wantsClose && !linkShared && convoStep < routeStep) {
        const incoming = (lastIncoming || '').trim();
        const theirWords = incoming.split(/\s+/).length;
        const shortIgnore = /^(ok|yes|no|sure|yep|yup|nah|nope|lol|haha|thanks|thank you|got it|cool|nice|great|awesome|perfect|fine|good|alright|k|thx|ty|hi|hey|hello)$/i;
        const positiveSignals = /\b(game|sounds good|let'?s do|count me|i'?m in|interested|send it|yes please|absolutely|definitely|of course|why not|let'?s go|ready|down)\b/i;
        const botIntro = /^[\w\s'.-]+(agency|studio|company|llc|inc|co\.?|brand|collective|consulting|services|group|team)$/i;
        const isShortIgnore = theirWords <= 3 && shortIgnore.test(incoming);
        const isPositive = positiveSignals.test(incoming);
        const isBotIntro = theirWords <= 4 && botIntro.test(incoming);
        if (isBotIntro) {
          // Bot/business self-ID — close, not advance
          wantsClose = true;
          log('ai', 'AUTO_CLOSE_BOT', `@${thread.username}: incoming "${incoming.substring(0, 60)}" looks like bot/business intro — closing`);
        } else if (isPositive || theirWords >= 4) {
          wantsAdvance = true;
          log('ai', 'AUTO_ADVANCE', `@${thread.username}: AI didn't return [ADVANCE] but incoming is substantive (${theirWords} words, positive=${isPositive}) — auto-advancing`);
        }
      }

      // EMAIL CAPTURE GATEKEEPER: if AI says [ADVANCE] on an email step, verify email was actually captured
      const currentStepDef = (steps.find(s => s.step === convoStep) || {}).objective || '';
      const isEmailStep = /email/i.test(currentStepDef);
      if (wantsAdvance && isEmailStep && !wantsClose && !linkShared) {
        const allTheirText = messages.filter(m => !m.isMe && m.text).map(m => m.text).join(' ');
        const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(allTheirText) || /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(lastIncoming || '');
        if (!hasEmail) {
          log('warn', 'FUNNEL', `@${thread.username}: AI tried to advance past email step but no email detected in conversation — forcing REMAIN`);
          wantsAdvance = false;
        }
      }

      let nextStep;
      if (wantsClose || linkShared) {
        nextStep = TERMINAL_STEP;
        log('ai', 'FUNNEL', `@${thread.username} — ${linkShared ? 'link shared' : 'closed'} → terminal`);
        detail.intent = linkShared ? 'link_shared' : 'closed_not_a_fit';
      } else if (wantsAdvance) {
        nextStep = Math.min(convoStep + 1, routeStep);
        log('ai', 'FUNNEL', `@${thread.username} advanced step ${convoStep} \u2192 ${nextStep}`);
        detail.intent = `step_${convoStep}_to_${nextStep}`;
      } else {
        nextStep = convoStep;
        log('ai', 'FUNNEL', `@${thread.username} remains on step ${convoStep}`);
        detail.intent = `step_${convoStep}_stay`;
      }

      detail.action = 'replied_funnel';
      detail.reply = cleanReply.substring(0, 200);

      const updateData = { conversation_step: nextStep, status: 'replied', last_updated_at: new Date().toISOString() };
      if (wantsClose || linkShared) updateData.followup_step = 99;
      await supabase.from('leads').update(updateData).eq('id', lead.id);

      await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: cleanReply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }).then(() => {}, () => {});
      log('success', 'AI', `@${thread.username} (step ${convoStep}) replied`);
      const funnelAction = wantsClose ? 'closed' : wantsAdvance ? `step_${convoStep}→${nextStep}` : `step_${convoStep}_stay`;
      await sendTelegram(config, formatTelegramReply(thread.username, cleanReply, lastIncoming, funnelAction, convoStep));
    } else {
      detail.action = 'send_failed';
      detail.error = 'send failed';
    }

    await delay(10000 + Math.random() * 15000);
  }

  if (skippedSelfCount > 0) {
    log('info', 'AI', `${skippedSelfCount} thread(s) skipped (last msg is from us)`);
  }

  await logActivity(supabase, logId, workspaceId, threadsFound, threadsReplied, logErrors, threadDetails);
  // No cross-pulse processedThreads persistence — conversation state (isMe, terminal step) handles dedup
  // Per-pulse repliedThreads prevents same thread processed twice in one pulse
  } finally {
    aiSetterRunning = false;
  }
}

async function logActivity(supabase, logId, workspaceId, threadsFound, threadsReplied, logErrors, threadDetails) {
  try {
    const payload = {
      threads_found: threadsFound,
      threads_replied: threadsReplied,
      errors: logErrors.length > 0 ? logErrors.join('; ') : null,
      details: threadDetails || []
    };
    if (logId) {
      await supabase.from('ai_setter_log').update(payload).eq('id', logId);
    } else {
      await supabase.from('ai_setter_log').insert({
        workspace_id: workspaceId,
        checked_at: new Date().toISOString(),
        ...payload
      }).then(() => {}, () => {});
    }
  } catch (e) {}
}

module.exports = { checkAndReply };
