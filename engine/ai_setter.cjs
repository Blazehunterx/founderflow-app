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

const repliedThreads = new Set();
const processedThreads = new Set(); // Tracks all threads we've processed (persists across pulses)
const repliedUsernames = new Set(); // Cross-pulse dedup: usernames we've replied to this session
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

// Persist processedThreads to state.json (called after each thread is handled)
function persistProcessedThreads() {
  try {
    const entries = [];
    for (const id of processedThreads) {
      entries.push({ id, ts: Date.now() });
    }
    saveAiState({ processedThreads: entries });
  } catch (e) {}
}

// Mark a thread as processed (add to Set — callers must call persistProcessedThreads() to save immediately)
function markThreadProcessed(threadId) {
  processedThreads.add(threadId);
}

// Rate limiting: minimum gap between Instagram API inbox scans (ms)
const API_INBOX_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between scans
let lastApiInboxScan = 0;

// --- EMAIL CAPTURE FLOW ---
const EMAIL_CAPTURE_STEP = {
  ASK_CONFIRM: 8,
  ASKING_EMAIL: 10,
  ASKING_NAME: 11,
  DELIVERED: 12
};

// --- OF USERNAME CAPTURE FLOW ---
// After OF link shared → ask for username → store → 45-day cooldown
const OF_USERNAME_STEP = {
  ASKING_USERNAME: 50,    // Just shared OF link, waiting to ask for username
  USERNAME_RECEIVED: 51   // Got their username, stored it, cooldown active
};
const OF_COOLDOWN_DAYS_DEFAULT = 20;

// Instagram safety: max request/hidden threads to process per pulse
// High volume of automated DMs triggers community guidelines warnings
const MAX_REQUEST_HIDDEN_PER_PULSE = 5;
const MAX_PRIMARY_PER_PULSE = 110; // 100 API + 10 DOM fallback
const MAX_API_PRIMARY_PER_PULSE = 100; // Process all API threads
const MAX_DOM_PER_PULSE = 0; // DOM fallback disabled — goto after click not loading messages. API covers ~97 threads.

// Instagram safety: conservative tone instructions appended to all AI prompts
// Prevents sexual solicitation flags from automated content moderation
const CONSERVATIVE_TONE = `
INSTAGRAM SAFETY RULES:
- NEVER use sexual/suggestive language, body part mentions, innuendo, or flirty tone
- NEVER mention price unless asked. Say "It's really reasonable, you'll see when you check it out"
- NEVER say "exclusive page", "private content", "special content" — say "my page" or "check me out here"
- ALWAYS reply in English
- SEXUAL DEFLECTION: If message contains sexual/inappropriate words (hot, sexy, naked, sex, nude, body, ass, dick, send pic/photo/video, fuck), reply: "Hey [name], let's keep things friendly here! But if you want to know more about me you can check it out here: [link]". Only for ACTUAL sexual content — not compliments like beautiful/cute/gorgeous.
- CONVERSION: Be personal, use their name, create curiosity, keep it short (1-2 sentences). Sound like a friend, not a salesperson. Never force the link — let them ask.
`;

// Language filtering — only allow EU languages + Arabic
function isAllowedLanguage(text) {
  if (!text) return true; // Allow empty messages
  // Block non-EU, non-Arabic scripts
  const blocked = /[\u0900-\u097F]/; // Devanagari (Hindi, Urdu, Bengali, Tamil)
  const cjk = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/; // Chinese, Japanese, Korean
  const thai = /[\u0E00-\u0E7F]/; // Thai
  const cyrillic = /[\u0400-\u04FF]/; // Russian, Uzbek, Kazakh
  const vietnamese = /[ăâđêôư]/i; // Vietnamese diacritics
  const filipino = /\b(ako|ikaw|siya|namin|wala|kung|pero|dahil|para|po|opo|naman)\b/i; // Filipino words
  
  if (blocked.test(text) || cjk.test(text) || thai.test(text) || cyrillic.test(text)) {
    return false;
  }
  if (vietnamese.test(text) || filipino.test(text)) {
    return false;
  }
  return true; // Allow EU languages (Latin script) and Arabic
}

function extractEmail(text) {
  if (!text) return null;
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

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

// --- AWEBER INTEGRATION ---
async function refreshAWeberToken(supabase, workspaceId, clientId, clientSecret, refreshToken) {
  try {
    const res = await fetch('https://auth.aweber.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken
      })
    });
    const data = await res.json();
    if (data.access_token) {
      // Store new tokens
      await supabase.from('settings').update({
        aweber_access_token: data.access_token,
        aweber_refresh_token: data.refresh_token || refreshToken
      }).eq('workspace_id', workspaceId);
      return data.access_token;
    }
  } catch (e) {
    log('warn', 'AWEBER_AUTH', `Token refresh failed: ${e.message}`);
  }
  return null;
}

async function getAWeberAccountId(accessToken) {
  try {
    const res = await fetch('https://api.aweber.com/1.0/accounts', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (data.entries && data.entries.length > 0) {
      return data.entries[0].id;
    }
  } catch (e) {
    log('warn', 'AWEBER', `Get accounts failed: ${e.message}`);
  }
  return null;
}

async function addAWeberSubscriber(supabase, workspaceId, accessToken, refreshToken, clientId, clientSecret, listId, tags, email, name) {
  try {
    // AWeber API uses numeric list IDs; strip the common 'awlist' prefix if present
    const normalizedListId = (listId || '').toString().replace(/^awlist/i, '');
    let token = accessToken;
    let accountId = await getAWeberAccountId(token);

    // If unauthorized, try refreshing token
    if (!accountId) {
      token = await refreshAWeberToken(supabase, workspaceId, clientId, clientSecret, refreshToken);
      if (!token) {
        log('error', 'AWEBER', 'Could not refresh token — subscriber not added');
        return false;
      }
      accountId = await getAWeberAccountId(token);
    }

    if (!accountId) {
      log('error', 'AWEBER', 'Could not get account ID');
      return false;
    }

    const tagArray = Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(Boolean) : []);

    const url = `https://api.aweber.com/1.0/accounts/${accountId}/lists/${normalizedListId}/subscribers`;
    const body = {
      email: email,
      name: name,
      tags: tagArray
    };
    
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    
    if (res.ok || res.status === 409) { // 409 = already exists
      log('success', 'AWEBER', `Added ${email} to list ${normalizedListId} with tags ${tagArray.join(', ')}`);
      return true;
    } else {
      const err = await res.text();
      log('warn', 'AWEBER', `Add subscriber failed (${res.status}): ${err}`);
      return false;
    }
  } catch (e) {
    log('warn', 'AWEBER', `Add subscriber exception: ${e.message}`);
    return false;
  }
}

const DEFAULT_STEPS = [
  { step: 1, objective: 'Connect over their specific work. Acknowledge what they do. Build rapport.' },
  { step: 2, objective: 'Gather intel: background, challenges, pain points, current status.' },
  { step: 3, objective: 'Share a personal story (vulnerability + authority). Ask about their vision.' },
  { step: 4, objective: 'Explore their dream outcome and goals in detail.' },
  { step: 5, objective: 'Offer a free diagnostic call. Frame as diagnosis, not coaching.' },
  { step: 6, objective: 'Pre-call qualify: exploratory or committed? Budget range? Ask both naturally.' },
];

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

function isAutoResponder(text, history) {
  if (!text) return false;
  const t = text.toLowerCase();

  // --- Pattern 1: classic away / auto-reply phrases ---
  const awayPatterns = [
    /automated response/,
    /auto.responder/,
    /auto.reply/,
    /autoreply/,
    /away right now/,
    /currently away/,
    /out of office/,
    /out of the office/,
    /not available right now/,
    /thanks for reaching out.*(away|auto|respond|back soon)/,
    /thanks for your message.*(away|auto|respond|back soon)/,
    /i use an automated/,
    /i'm using an automated/,
    /messaging assistant/,
    /virtual assistant/,
    /this is an auto/,
    /i.m away/,
    /i am away/,
    /on vacation/,
    /on holiday/,
    /on a break/,
    /temporarily unavailable/,
    /will get back to you/,
    /i.ll get back to you/,
    /reach me later/,
    /contact me later/,
    /not checking messages/,
    /offline until/,
    /back on/i,
    /respond as soon as/i,
  ];
  if (awayPatterns.some(p => p.test(t))) return true;

  // --- Pattern 2: business chatbot / structured questionnaire ---
  const botPatterns = [
    /provide the following details/,
    /kindly provide/,
    /to help us better assist you/,
    /could you (kindly )?provide/,
    /share your whatsapp/i,
    /whatsapp number for easier communication/,
    /\b1\.\s+how many days/i,
    /\b1\.\s+what is your/i,
    /\b1\.\s+will you be joining/i,
    /\b1\.\s+could you share/i,
  ];
  if (botPatterns.some(p => p.test(t))) return true;

  // --- Pattern 3: repeated identical messages (strongest chatbot signal) ---
  if (history && history.length >= 2) {
    const theirMessages = history.filter(m => !m.isMe && m.text);
    if (theirMessages.length >= 2) {
      const last = theirMessages[theirMessages.length - 1].text.trim().toLowerCase();
      const prev = theirMessages[theirMessages.length - 2].text.trim().toLowerCase();
      // Allow minor whitespace differences
      if (last === prev) return true;
    }
  }

  return false;
}

async function fetchInboxAPI(page, cursor, folder) {
  const now = Date.now();
  // Cooldown only applies to the first call of a session; pagination calls are allowed
  if (!cursor && now - lastApiInboxScan < API_INBOX_COOLDOWN_MS) {
    return { threads: [], cursor: null, hasMore: false };
  }
  try {
    const params = (cursor ? '&max_id=' + encodeURIComponent(typeof cursor === 'string' ? cursor : JSON.stringify(cursor)) : '') +
                    (folder ? '&folder=' + folder : '');
    
    // Retry logic for pagination - wait longer on500 errors
    let data = null;
    let retries = 0;
    const MAX_RETRIES = 2;
    
    while (retries <= MAX_RETRIES) {
      data = await page.evaluate(async (p) => {
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

        const url = 'https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&limit=100' + p;
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
      }, params);
      
      if (data?.error && retries < MAX_RETRIES) {
        retries++;
        const retryDelay = 60000 * retries; // 60s, 120s
        log('warn', 'API_INBOX', `Got ${data.error} on attempt ${retries}, retrying in ${retryDelay/1000}s...`);
        await delay(retryDelay);
      } else {
        break;
      }
    }

    if (data?.error) {
      log('warn', 'API_INBOX', `Error (Status: ${data.error}) — cursor sent: ${cursor ? JSON.stringify(cursor).substring(0, 100) : 'null'}`);
      // Return hasMore true so we retry on next pulse, but stop this pagination cycle
      return { threads: [], cursor: cursor || null, hasMore: false };
    }

    if (!data?.inbox?.threads) {
      log('warn', 'API_INBOX', `No inbox.threads in response — raw keys: ${Object.keys(data || {}).join(', ')}`);
      return { threads: [], cursor: cursor || null, hasMore: false };
    }

    // Cooldown only starts after first successful response (not pagination)
    if (!cursor) lastApiInboxScan = Date.now();

    const threads = [];
    const now = Date.now();
    const MAX_THREAD_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 365 days — reply to old backlog too
    const MAX_SELF_LAST_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours — only process threads where THEY sent the last message recently
    let totalFiltered = 0, filteredStale = 0, filteredEmptyItems = 0, filteredGroup = 0, filteredSelf = 0, filteredVoice = 0, filteredOldSelfLast = 0;
    const selfLastSamples = []; // diagnostic: show first 5 selfLast-filtered threads
    for (const thread of data.inbox.threads) {
      totalFiltered++;
      if (thread.last_activity_at && now - thread.last_activity_at > MAX_THREAD_AGE_MS) { filteredStale++; continue; }
      if (!thread.items?.length) { filteredEmptyItems++; continue; }
      if (thread.users?.length > 2) { filteredGroup++; continue; }
      const lastItem = thread.items[0];
      const myId = thread.viewer_id || thread.own_recipient_user_id;
      if (lastItem.user_id === myId) {
        // Always filter selfLast — we only want threads where THEY sent the last message
        filteredSelf++;
        if (selfLastSamples.length < 5) {
          selfLastSamples.push({
            user: thread.users?.[0]?.username,
            readState: thread.read_state,
            lastItemType: lastItem.item_type,
            lastItemText: (lastItem.text || '').substring(0, 60),
            lastItemUserId: lastItem.user_id,
            myId: myId,
            totalItems: thread.items?.length || 0,
          });
        }
        continue;
      }
      // Skip voice memos — let user take over
      const isVoice = lastItem.item_type === 'voice_media' || lastItem.media_type === 11;
      if (isVoice) { filteredVoice++; continue; }
      // NOTE: video_call_event is NOT filtered — we want to detect calls and send $250 offer
      // Time filter: only process threads where THEIR last message is recent (48h)
      // Prevents processing old threads that aren't actual replies
      if (lastItem.user_id !== myId && thread.last_activity_at) {
        const age = now - thread.last_activity_at;
        if (age > MAX_SELF_LAST_AGE_MS) {
          filteredOldSelfLast++;
          continue;
        }
      }
      threads.push({
        threadId: thread.thread_id,
        username: thread.users?.[0]?.username || 'unknown',
        fullName: thread.users?.[0]?.full_name || '',
        lastMessage: lastItem.text || '',
        isUnread: !thread.read_state,
        lastActivity: thread.last_activity_at,
        viewerId: myId,
        lastSenderId: lastItem.user_id
      });
    }
    // Pagination: Instagram uses has_older + next_cursor/oldest_cursor (NOT has_more_items/cursor)
    const nextCursor = data.inbox.next_cursor || data.inbox.oldest_cursor || data.inbox.cursor || data.inbox.next_max_id || null;
    // Check if cursor is sentinel value (2^64 - 1) meaning no more results
    const isSentinelCursor = nextCursor && typeof nextCursor === 'object' && 
      ((nextCursor.cursor_timestamp_seconds && parseInt(nextCursor.cursor_timestamp_seconds) >= 18446744073709551610) ||
       (nextCursor.cursor_relevancy_score && parseInt(nextCursor.cursor_relevancy_score) >= 18446744073709551610));
    const hasMore = (data.inbox.has_older === true || data.inbox.has_more_items === true) && nextCursor !== null && !isSentinelCursor;
    const unreadCount = threads.filter(t => t.isUnread).length;
    // Log cursor details for debugging pagination
    if (cursor) {
      log('info', 'API_INBOX', `Cursor input: ${JSON.stringify(cursor).substring(0, 100)}`);
      log('info', 'API_INBOX', `Cursor output: next_cursor=${data.inbox.next_cursor ? 'yes' : 'no'}, oldest_cursor=${data.inbox.oldest_cursor ? 'yes' : 'no'}, cursor=${data.inbox.cursor ? 'yes' : 'no'}, next_max_id=${data.inbox.next_max_id ? 'yes' : 'no'}`);
    }
    log('info', 'API_INBOX', `${threads.length} actionable (${unreadCount} unread, ${threads.length - unreadCount} read) selfLast:${filteredSelf} oldSelfLast:${filteredOldSelfLast} hasMore:${hasMore}`);
    return { threads, cursor: nextCursor, hasMore };
  } catch (e) {
    log('error', 'API_INBOX', e.message);
    return { threads: [], cursor: cursor || null, hasMore: false };
  }
}

// Fetch threads from Requests tab (message requests from non-followers)
async function fetchRequestsAPI(page, cursor = null) {
  try {
    // Use inbox API with folder=pending — direct /pending/ endpoint is dead (404)
    const data = await page.evaluate(async (cursor) => {
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

      let url = 'https://www.instagram.com/api/v1/direct_v2/inbox/?folder=pending&limit=100';
      if (cursor) {
        url += `&max_id=${cursor}`;
      }
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
    }, cursor);

    if (data?.error) {
      log('warn', 'API_REQUESTS', `Requests scan failed (Status: ${data.error})`);
      return { threads: [], cursor: null, hasMore: false };
    }

    if (!data?.inbox?.threads) {
      log('info', 'API_REQUESTS', `No pending threads — raw keys: ${Object.keys(data || {}).join(', ')} inbox_keys: ${Object.keys(data?.inbox || {}).join(', ')}`);
      return { threads: [], cursor: null, hasMore: false };
    }

    log('info', 'API_REQUESTS', `Raw pending response: ${data.inbox.threads.length} threads, has_older: ${data.inbox.has_older}, has_more: ${data.inbox.has_more_items}, next_cursor: ${data.inbox.next_cursor ? 'yes' : 'no'}, oldest_cursor: ${data.inbox.oldest_cursor ? 'yes' : 'no'}, unseen_count: ${data.inbox.unseen_count}`);

    const threads = [];
    const now = Date.now();
    const MAX_THREAD_AGE_MS = 365 * 24 * 60 * 60 * 1000;
    let debugFiltered = { age: 0, empty: 0, group: 0, voice: 0, total: 0 };
    for (const thread of data.inbox.threads) {
      debugFiltered.total++;
      if (thread.last_activity_at && now - thread.last_activity_at > MAX_THREAD_AGE_MS) { debugFiltered.age++; continue; }
      if (!thread.items?.length) { debugFiltered.empty++; continue; }
      if (thread.users?.length > 2) { debugFiltered.group++; continue; }
      const lastItem = thread.items[0];
      const isVoice = lastItem.item_type === 'voice_media' || lastItem.media_type === 11;
      if (isVoice) { debugFiltered.voice++; continue; }
      threads.push({
        threadId: thread.thread_id,
        username: thread.users?.[0]?.username || 'unknown',
        lastMessage: lastItem.text || '',
        isUnread: !thread.read_state,
        lastActivity: thread.last_activity_at,
        _source: 'requests_api'
      });
    }
    log('info', 'API_REQUESTS', `Filtered: ${debugFiltered.total} total → ${threads.length} actionable (age:${debugFiltered.age} empty:${debugFiltered.empty} group:${debugFiltered.group} voice:${debugFiltered.voice})`);
    // Log first 3 threads for debugging
    for (const t of threads.slice(0, 3)) {
      log('info', 'API_REQUESTS', `  sample: @${t.username} thread=${t.threadId} unread=${t.isUnread} msg="${(t.lastMessage || '').substring(0, 50)}"`);
    }
    return {
      threads,
      cursor: data.inbox.oldest_cursor || null,
      hasMore: data.inbox.has_older || false
    };
  } catch (e) {
    log('error', 'API_REQUESTS', e.message);
    return { threads: [], cursor: null, hasMore: false };
  }
}

// DOM scan for Request/Hidden/General — processes each Request/Hidden thread immediately
// after resolving its ID (depth-first approach to avoid virtualized list re-render issues)
async function scanFolderDOM(page, folder, processCallback = null) {
  // For Request/Hidden: if processCallback provided, processes each thread immediately after ID resolution.
  // For General/Primary: collects threads and returns them (thread IDs already known or not needed).
  const urls = {
    primary: 'https://www.instagram.com/direct/inbox/',
    general: 'https://www.instagram.com/direct/inbox/',
    requests: 'https://www.instagram.com/direct/requests/',
    hidden: 'https://www.instagram.com/direct/requests/hidden/',
  };
  const url = urls[folder];
  if (!url) return [];

  const isRequestFolder = (folder === 'requests' || folder === 'hidden');

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Wait longer for SPA to fully render thread list (virtualized list needs time)
    await delay(8000);

    // For General: click the General tab
    if (folder === 'general') {
      await page.evaluate(() => {
        const tabs = document.querySelectorAll('[role="tab"]');
        for (const tab of tabs) {
          if (tab.textContent.trim().includes('General')) {
            tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            tab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            break;
          }
        }
      });
      await delay(5000);
    }

    // Silent — results logged at end

    if (isRequestFolder && processCallback) {
      // EXTRACT-ALL then PROCESS: Match test script behavior exactly
      // 1. Scroll + extract all threads (read + unread) in one pass
      // 2. Process unread threads one by one
      let processed = 0;
      const processedUsers = new Set();
      
      // Process threads one by one — click first, process, back to list, repeat
      while (true) {
        // Find first unprocessed thread in the list
        const nextThread = await page.evaluate((processedArr) => {
          for (const b of document.querySelectorAll('div[role="button"]')) {
            const t = b.textContent.trim();
            const rect = b.getBoundingClientRect();
            if (rect.width > 200 && rect.height > 30 && rect.height < 120) {
              let u = null;
              // NEW: Instagram no longer uses <a> tags — username is in span[1]
              const spans = b.querySelectorAll('span');
              if (spans.length > 1) {
                const candidate = spans[1].textContent.trim();
                if (candidate && candidate.length > 1 && !candidate.includes('·') && !candidate.includes('Unread') && !/^\d+\+?\s*new\s*message/i.test(candidate)) {
                  u = candidate;
                }
              }
              if (!u) {
                const a = b.querySelector('a[href^="/"]:not([href*="/direct/"])');
                if (a) u = a.getAttribute('href')?.replace(/^\//, '').replace(/\/$/, '');
              }
              if (!u) { const fw = t.match(/^([a-zA-Z0-9._]+)/); if (fw) u = fw[1]; }
              if (u && u.length > 1 && !processedArr.includes(u.toLowerCase())) {
                // Extract full name: text content before the username link that looks like a real name
                let fullName = null;
                try {
                  const allSpans = b.querySelectorAll('span');
                  for (const span of allSpans) {
                    const st = span.textContent.trim();
                    // Skip: username, empty, has dots/underscores (IG handle), too long, looks like message preview
                    if (!st || st === u || st.toLowerCase() === u.toLowerCase()) continue;
                    if (st.includes('.') || st.includes('_') || st.length < 2 || st.length > 40) continue;
                    if (st.includes('·') || st.includes('Unread') || st.includes('ago')) continue;
                    // Looks like a real name (mostly letters, reasonable length, not all caps)
                    if (/^[A-Za-z\u00C0-\u024F]+(?: [A-Za-z\u00C0-\u024F]+){0,3}$/.test(st) && st !== st.toUpperCase()) {
                      fullName = st;
                      break;
                    }
                  }
                } catch (e) {}
                return { u: u.toLowerCase(), text: t.substring(0, 120), fullName };
              }
            }
          }
          return null;
        }, [...processedUsers]);

        if (!nextThread) {
          log('info', 'DOM_SCAN', `[${folder}] No more threads to process`);
          break;
        }

        try {
          // Click the thread
          await page.evaluate((username) => {
            for (const b of document.querySelectorAll('div[role="button"]')) {
              const t = b.textContent.trim();
              if (t.toLowerCase().includes(username)) { b.click(); return; }
            }
          }, nextThread.u);

          try { await page.waitForURL(/\/direct\/t\//, { timeout: 10000 }); } catch (e) {}
          await page.waitForTimeout(3000);

          const urlMatch = page.url().match(/\/direct\/t\/(\d+)/);
          if (urlMatch) {
            log('info', 'DOM_SCAN', `[${folder}] @${nextThread.u} → threadId: ${urlMatch[1]}`);
            try {
              await processCallback({ threadId: urlMatch[1], username: nextThread.u, fullName: nextThread.fullName || null, lastMessage: nextThread.text, isUnread: true, _source: folder + '_dom' });
              processed++;
              processedUsers.add(nextThread.u);
            } catch (e) {
              log('warn', 'DOM_SCAN', `[${folder}] Callback failed for @${nextThread.u}: ${e.message}`);
              processedUsers.add(nextThread.u); // Mark as processed even on failure
            }
          } else {
            log('warn', 'DOM_SCAN', `[${folder}] @${nextThread.u} — no thread ID in URL: ${page.url()}`);
            processedUsers.add(nextThread.u);
          }

          // Go back to thread list — click Instagram's back button (not history.back)
          await page.evaluate(() => {
            // Try back arrow SVG
            const svgs = document.querySelectorAll('svg');
            for (const svg of svgs) {
              const label = (svg.getAttribute('aria-label') || '').toLowerCase();
              if (label.includes('back')) {
                const btn = svg.closest('a, button, div[role="button"]');
                if (btn) { btn.click(); return; }
              }
            }
            // Try inbox link
            const link = document.querySelector('a[href*="/direct/"]');
            if (link) link.click();
          });
          await page.waitForTimeout(3000);
          
          // If still on thread page, navigate to folder URL
          const currentUrl = page.url();
          if (!currentUrl.includes('/direct/requests') && !currentUrl.includes('/direct/inbox')) {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(3000);
          }

          log('info', 'DOM_SCAN', `[${folder}] [${processed}] processed so far`);
        } catch (e) {
          log('warn', 'DOM_SCAN', `[${folder}] Error on @${nextThread.u}: ${e.message}`);
          processedUsers.add(nextThread.u);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(3000);
        }
      }

      log('info', 'DOM_SCAN', `[${folder}] Done: ${processed} threads processed`);
      return [];
    } else {
      // COLLECT-ALL: For General/Primary, collect all threads and return (thread IDs already known)
      return await collectAllThreads(page, folder, url);
    }
  } catch (e) {
    log('error', 'DOM_SCAN', `[${folder}] Scan failed: ${e.message}`);
    return [];
  }
}

// Extract all threads from a folder using robust scroll approach
// Scrolls all scrollable elements to ensure we catch everything
async function extractThreadsFromFolder(page, scrolls = 50) {
  const allThreads = [];
  const seen = new Set();

  for (let s = 0; s < scrolls; s++) {
    const batch = await page.evaluate(() => {
      const results = [];
      // Extract threads — same selectors as test script
      document.querySelectorAll('div[role="button"]').forEach(b => {
        const t = b.textContent.trim();
        const rect = b.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 30 && rect.height < 120 && (t.includes('·') || t.includes('Unread'))) {
          let u = null;
          // NEW: Instagram no longer uses <a> tags — username is in span[1]
          const spans = b.querySelectorAll('span');
          if (spans.length > 1) {
            const candidate = spans[1].textContent.trim();
            if (candidate && candidate.length > 1 && !candidate.includes('·') && !candidate.includes('Unread') && !/^\d+\+?\s*new\s*message/i.test(candidate)) {
              u = candidate;
            }
          }
          if (!u) {
            const a = b.querySelector('a[href^="/"]:not([href*="/direct/"])');
            if (a) u = a.getAttribute('href')?.replace(/^\//, '').replace(/\/$/, '');
          }
          if (!u) { const fw = t.match(/^([a-zA-Z0-9._]+)/); if (fw) u = fw[1]; }
          if (u && u.length > 1) {
            const isUnread = t.includes('Unread') || /\d+\+?\s*new\s*message/i.test(t);
            results.push({ u: u.toLowerCase(), text: t.substring(0, 120), unread: isUnread });
          }
        }
      });

      // Scroll ALL scrollable elements — robust approach
      document.querySelectorAll('div').forEach(d => {
        const s = getComputedStyle(d);
        if ((s.overflow === 'auto' || s.overflow === 'scroll' || s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 50) {
          d.scrollBy(0, 800);
        }
      });
      // Also try navigation parent
      const sc = document.querySelector('div[role="navigation"]')?.parentElement;
      if (sc) sc.scrollBy(0, 800);
      window.scrollBy(0, 800);

      return { results };
    });

    for (const b of batch.results) {
      if (!seen.has(b.u)) {
        seen.add(b.u);
        allThreads.push({ u: b.u, text: b.text, unread: b.unread });
      }
    }

    await delay(2000);
  }

  return allThreads;
}

// Collect-all approach for General/Primary (thread IDs already known or not needed)
async function collectAllThreads(page, folder, url) {
  const seen = new Set();
  const allThreads = [];

  // Scroll 50 times — covers ~180 days based on testing (558 threads, 110 unread)
  // After scroll 50 most threads are read and older than 180 days
  let staleCount = 0;
  const STALE_LIMIT = 5;
  for (let s = 0; s < 50; s++) {
    const prevSize = seen.size;
    const batch = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('div[role="button"]').forEach(b => {
        const t = b.textContent.trim();
        const rect = b.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 30 && rect.height < 120 && (t.includes('·') || t.includes('Unread'))) {
          let u = null;
          // NEW: Instagram no longer uses <a> tags — username is in span[1]
          const spans = b.querySelectorAll('span');
          if (spans.length > 1) {
            const candidate = spans[1].textContent.trim();
            if (candidate && candidate.length > 1 && !candidate.includes('·') && !candidate.includes('Unread') && !/^\d+\+?\s*new\s*message/i.test(candidate)) {
              u = candidate;
            }
          }
          // Fallback: old link-based extraction
          if (!u) {
            const a = b.querySelector('a[href^="/"]:not([href*="/direct/"])');
            if (a) u = a.getAttribute('href')?.replace(/^\//, '').replace(/\/$/, '');
          }
          // Last resort: regex from start of text
          if (!u) { const fw = t.match(/^([a-zA-Z0-9._]+)/); if (fw) u = fw[1]; }
          if (u && u.length > 1) {
            const isUnread = t.includes('Unread') || /\d+\+?\s*new\s*message/i.test(t);
            results.push({ u: u.toLowerCase(), text: t.substring(0, 120), unread: isUnread });
          }
        }
      });
      // Scroll ALL scrollable elements — robust approach
      document.querySelectorAll('div').forEach(d => {
        const s = getComputedStyle(d);
        if ((s.overflow === 'auto' || s.overflow === 'scroll' || s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 50) {
          d.scrollBy(0, 800);
        }
      });
      const sc = document.querySelector('div[role="navigation"]')?.parentElement;
      if (sc) sc.scrollBy(0, 800);
      window.scrollBy(0, 800);
      return { results };
    });
    for (const b of batch.results) {
      if (!seen.has(b.u)) {
        seen.add(b.u);
        allThreads.push({
          threadId: b.u, // No thread IDs in DOM — must click to resolve
          username: b.u,
          lastMessage: b.text,
          isUnread: b.unread,
          _source: folder + '_dom',
        });
      }
    }
    if (s < 3 || s % 5 === 0) {
    }
    // Early exit: if no new threads found for 5 consecutive scrolls, stop
    if (seen.size === prevSize) {
      staleCount++;
      if (staleCount >= STALE_LIMIT) {
        log('info', 'DOM_SCAN', `[${folder}] No new threads after ${s + 1} scrolls — stopping early`);
        break;
      }
    } else {
      staleCount = 0;
    }
    await delay(2000);
  }

  const unread = allThreads.filter(t => t.isUnread);
  log('info', 'DOM_SCAN', `[${folder}] Found ${allThreads.length} threads (${unread.length} unread)`);
  return allThreads;
}

async function scanHiddenRequestsDOM(page) {
  const threads = [];
  try {
    // Navigate directly to hidden requests URL (found via debug: /direct/requests/hidden/)
    await page.goto('https://www.instagram.com/direct/requests/hidden/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(4000);

    // Check if we landed on the hidden requests page
    const pageUrl = await page.url();
    if (!pageUrl.includes('hidden') && !pageUrl.includes('requests')) {
      log('warn', 'HIDDEN_REQUESTS', `Did not land on hidden requests page: ${pageUrl}`);
      // Try clicking through UI instead
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(4000);
      // Click Requests tab
      await page.evaluate(() => {
        const tabs = document.querySelectorAll('[role="tab"]');
        for (const tab of tabs) {
          if (tab.textContent.trim().includes('Requests')) {
            tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            tab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return;
          }
        }
      });
      await delay(4000);
      // Click Hidden Requests
      await page.evaluate(() => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          const text = (el.textContent || '').trim();
          if (text === 'Hidden Requests' && el.children.length < 3) {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            el.click();
            return;
          }
        }
      });
      await delay(4000);
    }

    // Scroll to load all threads
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); }).catch(() => {});
      await delay(1500 + Math.random() * 1000);
    }

    // Extract threads from hidden requests page
    // Mobile web: usernames appear as <SPAN> elements at x=92, thread items at x=0
    const domThreads = await page.evaluate(() => {
      const results = [];
      const seenUsernames = new Set();
      
      // Method 1: Look for SPAN elements that contain just a username (no emoji, no time, no actions)
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        const text = (span.textContent || '').trim();
        const rect = span.getBoundingClientRect();
        // Username SPANs are at x=92, height ~18px, contain only valid username chars (NO spaces)
        if (rect.x > 80 && rect.x < 110 && rect.height > 10 && rect.height < 25 &&
            text.length > 1 && text.length < 40 &&
            /^[a-zA-Z0-9._\u0600-\u06FF\u0750-\u077F\u0400-\u04FF\u1100-\u11FF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+$/.test(text) &&
            !text.includes('·') && !text.includes('Unread') && !text.includes('Delete') &&
            !text.includes('Active') && !text.includes('Back') && !text.includes('Hidden') &&
            !text.includes('sent') && !text.includes('clip') && !text.includes('sticker') &&
            !text.includes('audio') && !text.includes('photo') && !text.includes('video')) {
          const lower = text.toLowerCase();
          if (!seenUsernames.has(lower)) {
            seenUsernames.add(lower);
            results.push({
              threadId: lower,
              username: lower,
              _source: 'hidden_requests_dom'
            });
          }
        }
      }
      
      // Method 2: Parse thread container text (e.g., "kars.jigo🔥 · 8hUnread")
      if (results.length === 0) {
        const divs = document.querySelectorAll('div');
        for (const div of divs) {
          const text = (div.textContent || '').trim();
          const rect = div.getBoundingClientRect();
          // Thread containers are at x=0, contain time pattern and "Unread"
          if (rect.x < 5 && rect.height > 30 && rect.height < 80 &&
              text.includes('Unread') && text.includes('·') &&
              text.length < 200) {
            // Extract username: everything before emoji or special chars (support Unicode)
            const match = text.match(/^([a-zA-Z0-9._\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF]+)/);
            if (match) {
              const username = match[1].toLowerCase();
              if (!seenUsernames.has(username) && username.length > 1 &&
                  !username.includes('sent') && !username.includes('delete') &&
                  !username.includes('hidden') && !username.includes('back')) {
                seenUsernames.add(username);
                results.push({
                  threadId: username,
                  username: username,
                  lastMessage: text.substring(0, 60),
                  _source: 'hidden_requests_dom'
                });
              }
            }
          }
        }
      }
      
      return results;
    });

    for (const t of domThreads) {
      threads.push({
        threadId: t.threadId,
        username: t.username,
        lastMessage: t.lastMessage || '',
        _source: 'hidden_requests_dom'
      });
    }

    log('info', 'HIDDEN_REQUESTS', `Found ${threads.length} thread(s) in hidden requests`);
    if (threads.length > 0) {
      for (const t of threads.slice(0, 5)) {
        log('info', 'HIDDEN_REQUESTS', `  @${t.username}`);
      }
    }

    // Navigate back to Primary inbox
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await delay(2000);
  } catch (e) {
    log('error', 'HIDDEN_REQUESTS', e.message);
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await delay(2000);
  }
  return threads;
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
    
    // Debug: log ALL item_types in the thread to understand call events
    const allTypes = data.thread.items.map(i => i.item_type);
    const uniqueTypes = [...new Set(allTypes)];
    if (allTypes.includes('video_call_event') || allTypes.includes('call_log')) {
      log('debug', 'THREAD_TYPES', `Thread ${threadId} contains call events! Types: ${uniqueTypes.join(', ')}`);
      // Log the raw call event for debugging
      const callEvent = data.thread.items.find(i => i.item_type === 'video_call_event' || i.item_type === 'call_log');
      if (callEvent) {
        log('debug', 'CALL_EVENT', `Raw call event: ${JSON.stringify(callEvent).substring(0, 500)}`);
      }
    }
    
    const result = data.thread.items.filter(item => {
      // Filter out voice memos — not actionable by AI
      // Keep video_call_event and call_log — we want to detect calls
      return item.item_type !== 'voice_media' && item.media_type !== 11;
    }).map(item => {
      let text = item.text || '';
      // Strip Instagram UI artifacts (bubbles, reactions, link previews)
      text = text.replace(/[\u2550\u2554\u2557\u255A\u255D]|BUBBLE|LINK_PREVIEW|REACTION|UNKNOWN/g, '').trim();
      const isCall = item.item_type === 'video_call_event' || item.item_type === 'call_log';
      if (isCall) {
        text = '[CALL_EVENT]'; // Placeholder text for call events
      }
      return {
        text,
        isMe: item.user_id === myId,
        timestamp: item.timestamp,
        itemType: item.item_type || 'text',
        isCall
      };
    }).reverse(); // Order from oldest to newest for AI context

    // Debug: log last message isMe status and IDs for troubleshooting
    if (result.length > 0) {
      const last = result[result.length - 1];
      const lastRaw = data.thread.items[0]; // Instagram returns newest first
      log('debug', 'THREAD_ISME', `viewer_id:${myId} lastItem_userId:${lastRaw?.user_id} isMe:${last.isMe} msgs:${result.length}`);
    }

    return result;
  } catch (e) {
    log('error', 'API_THREAD', e.message);
    return [];
  }
}

// DOM-based message reader — reads conversation from the thread page DOM
// Uses selectors proven in engine.cjs follow-up detection
async function fetchThreadMessagesDOM(page) {
  try {
    // Wait for messages to actually appear in DOM (up to 10s)
    for (let attempt = 0; attempt < 5; attempt++) {
      const hasMessages = await page.evaluate(() => {
        return document.querySelectorAll('span[dir="auto"]').length;
      });
      if (hasMessages > 0) break;
      await delay(2000);
    }

    return await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span[dir="auto"]'));
      const myId = document.cookie.match(/ds_user_id=(\d+)/)?.[1];
      const messages = [];
      
      for (const span of spans) {
        const text = (span.textContent || '').trim();
        if (!text) continue;
        
        // Detect call events
        const isCall = /video chat ended|started a video chat|call ended|missed.*call/i.test(text);
        if (isCall) {
          // Call events are system messages, not from either user
          messages.push({ text, isMe: false, itemType: 'video_call_event' });
          continue;
        }
        
        // Skip other system messages
        if (/started a (video )?chat|invited? .* to the chat|added? .* to the chat/i.test(text)) continue;
        
        // Skip "Seen" receipts in any language — Instagram renders these as span[dir="auto"] but they're NOT messages
        // English: Seen, Finnish: Nähty, Swedish: Sett, German: Gesehen, French: Vu, Spanish/Italian/Portuguese: Visto, Dutch: Gezien
        if (/^(seen|nähty|sett|gesehen|vu|visto|gezien)\s/i.test(text)) continue;
        
        // Determine if sent or received — flex-end = right-aligned = our message
        const row = span.closest('div[role="row"]') || span.closest('[role="listitem"]') || span.parentElement?.parentElement;
        let isMe = false;
        if (row) {
          const rowStyle = window.getComputedStyle(row);
          isMe = rowStyle.justifyContent === 'flex-end';
          // Fallback 1: check for sent indicators
          if (!isMe) {
            isMe = row.querySelector('[data-testid*="sent"], [aria-label*="Sent"]') !== null;
          }
          // Fallback 2: check horizontal position — right half of viewport = our message
          if (!isMe) {
            const rect = row.getBoundingClientRect();
            if (rect.width > 0) {
              const viewportWidth = window.innerWidth;
              isMe = rect.left > viewportWidth * 0.5;
            }
          }
        }
        
        messages.push({ text, isMe, itemType: 'text' });
      }
      return messages;
    });
  } catch (e) {
    return [];
  }
}

// Read the visible last message from thread page DOM — determines if last msg is from us or them
async function readLastMessageFromDOM(page) {
  try {
    return await page.evaluate(() => {
      // Find all message rows
      const rows = document.querySelectorAll('[role="row"], [role="listitem"]');
      let lastText = '';
      let lastIsMe = null;
      for (const row of rows) {
        const textEl = row.querySelector('span[dir="auto"], span > span');
        const text = textEl ? (textEl.textContent || '').trim() : '';
        if (!text) continue;
        const style = window.getComputedStyle(row);
        lastText = text;
        lastIsMe = style.justifyContent === 'flex-end';
      }
      return { text: lastText, isMe: lastIsMe };
    });
  } catch (e) {
    return { text: '', isMe: null };
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
        await delay(2000);

        // Move to Primary dialog: "Move messages from X into:" → click Primary
        let movedToPrimary = false;
        for (let i = 0; i < 15; i++) {
          movedToPrimary = await page.evaluate(() => {
            const all = document.querySelectorAll('*');
            for (const el of all) {
              if (el.children.length === 0 && (el.textContent || '').trim() === 'Primary') {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) { el.click(); return true; }
              }
            }
            return false;
          });
          if (movedToPrimary) { log('info', 'REQUEST_ACCEPT', 'Moved to Primary'); await delay(2000); break; }
          await delay(500);
        }
        if (!movedToPrimary) {
          // Debug: dump what's on screen to find the Primary button
          const debugTexts = await page.evaluate(() => {
            const texts = [];
            document.querySelectorAll('*').forEach(el => {
              const r = el.getBoundingClientRect();
              if (r.x > 200 && r.x < 800 && r.y > 150 && r.y < 500 && r.width > 0 && el.children.length === 0 && (el.textContent || '').trim()) {
                texts.push({ tag: el.tagName, text: el.textContent.trim().substring(0, 40), x: Math.round(r.x), y: Math.round(r.y) });
              }
            });
            return texts.slice(0, 15);
          });
          log('warn', 'REQUEST_ACCEPT', `Primary not found. Center screen: ${JSON.stringify(debugTexts)}`);
        }
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
        // Dismiss "Turn on Notifications" popup if it appears after sending
        await delay(1500);
        await page.evaluate(() => {
          const all = document.querySelectorAll('button, div[role="button"]');
          for (const b of all) {
            const t = (b.textContent || '').trim().toLowerCase();
            if (t === 'not now' || t === 'not now') { b.click(); return; }
          }
        }).catch(() => {});
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

async function callGemini(apiKey, prompt, retries = 3, systemInstruction = null) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    // Rotate across models to spread free-quota usage
    const model = GEMINI_MODELS[(attempt - 1) % GEMINI_MODELS.length];
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
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
        // 429 = per-minute rate limit (50 RPM). Wait 65s and retry instead of giving up.
        if (attempt < retries) {
          log('warn', 'GEMINI', `429 rate limit on ${model} (attempt ${attempt}/${retries}) — waiting 65s for RPM reset...`);
          await delay(65000);
          continue;
        }
        // All retries exhausted — still 429, give up for this call
        const err = new Error('Gemini quota exhausted (429 after retries)');
        err.quotaExhausted = true;
        throw err;
      } else {
        log('error', 'GEMINI', `${model} error: ${res.status}`);
      }
      if (attempt < retries) {
        await delay(3000);
        continue;
      }
      return null;
    } catch (e) {
      log('error', 'GEMINI', `${model}: ${e.message}`);
      if (attempt < retries) {
        await delay(3000);
        continue;
      }
      return null;
    }
  }
  return null;
}

async function scanInboxDOM(page, folderOrScrolls, maybeScrolls) {
  // Support both scanInboxDOM(page, folder) and scanInboxDOM(page, maxScrolls)
  const folder = (folderOrScrolls === 'general' || folderOrScrolls === null) ? folderOrScrolls : null;
  const maxScrolls = folder ? (maybeScrolls || 5) : (folderOrScrolls || 10);
  try {
    if (folder === 'general') {
      // General: we're already on /direct/inbox/ — just click the General tab
      await page.evaluate(() => {
        const tabs = document.querySelectorAll('[role="tab"]');
        for (const tab of tabs) {
          if (tab.textContent.trim().includes('General')) {
            tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            tab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return;
          }
        }
      });
      await delay(4000); // Wait for React to re-render the thread list
    } else {
      // Primary: navigate to inbox
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(3000);
    }

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

    // Scroll to trigger lazy-loading (fewer scrolls for General since it's a filter, not a separate endpoint)
    for (let i = 0; i < maxScrolls; i++) {
      await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); }).catch(() => {});
      await delay(2000 + Math.random() * 1000);
    }

    // DOM extraction: role="button" elements inside thread list
    const domThreads = await page.evaluate((folderName) => {
      const results = [];
      const seenIds = new Set();

      // Find the thread list container — try multiple selectors
      let threadList = document.querySelector('div[aria-label="Thread list"]');
      if (!threadList) {
        // Fallback: find the main scrollable container in the DM sidebar
        threadList = document.querySelector('div[role="navigation"]')?.parentElement
          || document.querySelector('main')?.querySelector('div[style*="overflow"]')
          || document;
      }

      // Find all role="button" elements (these are the thread rows)
      const buttons = threadList.querySelectorAll('[role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent.trim();
        const rect = btn.getBoundingClientRect();
        
        // Threads are wide (>200px), tall (>30px), contain "·" (time separator)
        if (rect.width < 200 || rect.height < 30 || rect.height > 120 || !text.includes('·')) continue;

        // Parse username from text: "username | displayName..." or "usernameYou:..."
        // The username is before " | " or before "You:" or the first word
        let username = null;
        
        // Method 1: "username | displayName..."
        const pipeMatch = text.match(/^([^|]+)\|/);
        if (pipeMatch) {
          username = pipeMatch[1].trim();
        }
        
        // Method 2: Look for profile link inside the button
        if (!username) {
          const profileLink = btn.querySelector('a[href^="/"]:not([href*="/direct/"]):not([href*="/accounts/"])');
          if (profileLink) {
            const href = profileLink.getAttribute('href');
            const pm = href.match(/^\/([^/?]+)/);
            if (pm) username = pm[1];
          }
        }
        
        // Method 3: First word before common patterns
        if (!username) {
          const firstWord = text.match(/^([a-zA-Z0-9._]+)/);
          if (firstWord) username = firstWord[1];
        }

        if (!username || username.length < 2) continue;
        
        // Skip navigation buttons and system elements
        if (['New message', 'New post', 'Settings', 'Down chevron'].some(s => text.includes(s))) continue;

        // Extract real thread ID from DM link: /direct/t/123456789/
        let realThreadId = username.toLowerCase();
        const dmLink = btn.querySelector('a[href*="/direct/t/"]');
        if (dmLink) {
          const href = dmLink.getAttribute('href') || '';
          const tidMatch = href.match(/\/direct\/t\/(\d+)/);
          if (tidMatch) realThreadId = tidMatch[1];
        }
        if (seenIds.has(realThreadId)) continue;
        seenIds.add(realThreadId);

        // Check if unread
        const isUnread = text.includes('Unread');
        
        // Check if last message is from us ("You:" prefix)
        const isMe = text.includes('You:');

        // Extract last message text (after the time separator "·")
        let lastMessage = '';
        const timeIdx = text.lastIndexOf('·');
        if (timeIdx > 0) {
          // Message is between display name and time
          // Skip "You:" prefix if present
          const beforeTime = text.substring(0, timeIdx).trim();
          const youIdx = beforeTime.lastIndexOf('You:');
          if (youIdx >= 0) {
            lastMessage = beforeTime.substring(youIdx + 4).trim();
          } else {
            // Take text after display name (after "|")
            const pipeIdx = beforeTime.indexOf('|');
            if (pipeIdx >= 0) {
              lastMessage = beforeTime.substring(pipeIdx + 1).trim();
            } else {
              lastMessage = beforeTime;
            }
          }
        }

        results.push({
          threadId: realThreadId,
          username: username.toLowerCase(),
          lastMessage: lastMessage.substring(0, 100),
          isUnread: isUnread,
          isMe: isMe,
          _source: folderName === 'general' ? 'general_inbox_dom' : 'primary_inbox_dom'
        });
      }
      return results;
    }, folder);

    // Remove listener
    page.removeAllListeners('response');

    // Merge captured API threads + DOM threads, dedupe
    const all = [...capturedThreads, ...domThreads];
    const unique = [];
    const dedup = new Set();
    for (const t of all) {
      if (!dedup.has(t.threadId)) { dedup.add(t.threadId); unique.push(t); }
    }

    log('info', 'DOM_SCAN', `${unique.length} new threads from ${folder || 'Primary'} DOM`);
    return unique;
  } catch (e) {
    log('error', 'DOM_SCAN', e.message);
    return [];
  }
}

async function checkAndReply(page, supabase, config, context) {
  if (aiSetterRunning) {
    log('info', 'AISETTER_SKIP', 'Already running — skipping concurrent call');
    return { threadsFound: 0, threadsReplied: 0 };
  }
  aiSetterRunning = true;
  try {
  repliedThreads.clear(); // Fresh set each pulse — threads re-fetched, isMe guard prevents duplicates
  processedThreads.clear(); // No cross-pulse persistence — conversation state (isMe, terminal step) handles dedup
  const workspaceId = config.workspaceId;
  const trainingContext = config.aiTrainingContext || '';
  const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
  const calendlyLink = config.calendlyLink || '';
  const skoolLink = config.skoolLink || '';
  const frameworkLink = config.frameworkLink || '';
  const shareableLink = frameworkLink || calendlyLink || '';
  const emailCaptureEnabled = config.emailCaptureEnabled === true || (!!frameworkLink && config.emailCaptureEnabled !== false);
  const conversationEnabled = config.conversationEnabled !== false;

  // Helper: if a thread already contains an email + name reply, deliver the framework link
  // and add to AWeber immediately. Returns true if delivery happened.
  async function tryDeliverCapturedInfo(thread, messages, lead) {
    if (!emailCaptureEnabled || !frameworkLink || !lead) return false;
    if (lead.conversation_step >= EMAIL_CAPTURE_STEP.DELIVERED) return false;
    if (lead.email && lead.first_name) return false;

    const conversation = messages.slice(-8).map(m => `${m.isMe ? 'You' : '@' + thread.username}: "${sanitizeInput(m.text || '')}"`).join('\n');
    const capturedEmail = extractEmail(conversation);
    if (!capturedEmail) return false;

    // Find the first non-empty message AFTER the email message — treat it as the name reply
    let capturedName = null;
    const msgIndex = messages.findIndex(m => !m.isMe && m.text && extractEmail(m.text));
    if (msgIndex >= 0) {
      for (let i = msgIndex + 1; i < messages.length; i++) {
        const m = messages[i];
        if (!m.isMe && m.text && !extractEmail(m.text)) {
          const firstWord = m.text.trim().split(/\s+/)[0];
          if (firstWord && firstWord.length > 1 && /^[a-zA-Z]/i.test(firstWord)) {
            capturedName = firstWord.replace(/[^a-zA-Z0-9_\-]/g, '');
            break;
          }
        }
      }
    }
    // Fallback: name from the latest incoming message if it looks like a name
    const lastIncoming = sanitizeInput(messages[messages.length - 1]?.text || '');
    if (!capturedName && lastIncoming && !extractEmail(lastIncoming)) {
      const firstWord = lastIncoming.trim().split(/\s+/)[0];
      if (firstWord && firstWord.length > 1 && /^[a-zA-Z]/i.test(firstWord)) {
        capturedName = firstWord.replace(/[^a-zA-Z0-9_\-]/g, '');
      }
    }
    if (!capturedName) return false;

    const firstName = capturedName.charAt(0).toUpperCase() + capturedName.slice(1).toLowerCase();
    const deliveryMsg = config.emailCaptureDeliveryMsg
      ? config.emailCaptureDeliveryMsg.replace(/\{\{firstName\}\}/g, firstName).replace(/\$\{firstName\}/g, firstName).replace(/\{\{link\}\}/g, frameworkLink).replace(/\$\{link\}/g, frameworkLink)
      : `Thanks ${firstName}! Framework is on its way to your inbox — should land in the next few minutes. Here's the link just in case: ${frameworkLink}`;

    const sent = await sendReplyViaPhysical(page, thread.threadId, deliveryMsg, thread.username);
    if (!sent) return false;

    threadsReplied++;
    if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
    repliedThreads.add(thread.threadId);
    markThreadProcessed(thread.threadId);
    persistProcessedThreads();

    await supabase.from('leads').update({
      email: capturedEmail,
      first_name: firstName,
      conversation_step: TERMINAL_STEP,
      followup_step: 0,
      status: 'replied',
      last_updated_at: new Date().toISOString()
    }).eq('id', lead.id);

    if (config.aweberAccessToken && config.aweberListId) {
      const baseTags = (config.aweberTag || '').split(',').map(t => t.trim()).filter(Boolean);
      const aweberOk = await addAWeberSubscriber(
        supabase, workspaceId,
        config.aweberAccessToken, config.aweberRefreshToken,
        config.aweberClientId, config.aweberClientSecret,
        config.aweberListId, baseTags,
        capturedEmail, firstName
      );
      await supabase.from('leads').update({ aweber_status: aweberOk ? 'added' : 'failed', last_updated_at: new Date().toISOString() }).eq('id', lead.id);
      log('success', 'AI', `Email+name safety net delivered framework to @${thread.username} (${firstName}, ${capturedEmail}) AWeber: ${aweberOk ? 'added' : 'failed'}`);
    } else {
      log('success', 'AI', `Email+name safety net delivered framework to @${thread.username} (${firstName}, ${capturedEmail}) — no AWeber configured`);
    }

    try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: deliveryMsg, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
    await delay(10000 + Math.random() * 15000);
    return true;
  }

  let logId = null;
  let threadsFound = 0;
  let threadsReplied = 0;
  const maxRepliesPerPulse = config.inboxScanMode ? 999 : Math.max(1, Math.min(config.maxRepliesPerPulse || 10, 20)); // Unlimited for inbox mode, 10 for outbound
  let requestReplies = 0; // Track Request sends separately
  let requestAccepted = 0; // Track Request ACCEPTS separately (cap triggers BEFORE accept, not after send)
  let hiddenReplies = 0; // Track Hidden sends separately
  let primaryReplies = 0; // Track Primary sends separately
  let requestHiddenCapHit = false; // Stop processing requests/hidden when cap reached
  let primaryStepDistribution = {}; // Track step changes: { '0→1': 2, '3→4': 1, ... }
  let primaryLinkShared = 0; // Track how many received the link
  let primaryLinkSharedUsers = []; // Track IG handles that received the link
  let logErrors = [];
  const threadDetails = []; // per-thread: username, action, reply, intent, error
  let geminiQuotaExhausted = false; // Set on first 429 — skip ALL remaining Gemini calls this pulse

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
    return { threadsFound: 0, threadsReplied: 0 };
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

  const threads = [];
  const allInboxThreads = [];
  let totalActionable = 0;

  try {
  // --- INBOX SCAN: Two-phase approach ---
  // Phase 1: Primary → Requests → Hidden (process all threads)
  // Phase 2: General (reply to unread threads)

  // 1. PRIMARY — Click-first processing (same approach as Request/Hidden)
  // ALWAYS runs — even when scanRequests is false (outreach-only mode).
  // We must always detect replies in Primary inbox, regardless of outreach settings.
  // Navigate to inbox → find unread thread → click → fetch messages → generate reply → send → back → repeat
  {
    try {
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(3000);

      const processPrimaryThread = async (thread) => {
        if (geminiQuotaExhausted) return; // Skip — quota exhausted this pulse
        // HARD threadId dedup — prevents re-replying when Instagram DOM truncates usernames differently
        if (repliedThreads.has(thread.threadId) || processedThreads.has(thread.threadId)) {
          log('info', 'DEDUP', `@${thread.username}: already processed — skipping`);
          return;
        }

        const skipUsers = ['instagram support', 'instagram', 'highlightsvideo'];
        if (skipUsers.includes(thread.username.toLowerCase())) return;

        // Check lead
        let { data: existingLead } = await supabase.from('leads')
          .select('id, ig_handle, status, conversation_step, conversation_data')
          .eq('workspace_id', workspaceId)
          .eq('ig_handle', thread.username.toLowerCase())
          .maybeSingle();
        
        if (!existingLead) {
          // No lead exists — this person messaged Jani cold (not a reply to his DM).
          // Skip — we only reply to people Jani initiated contact with.
          log('info', 'PRIMARY_SEND', `@${thread.username}: no lead found (not a DM reply) — skipping`);
          return;
        }

        // Only process if Jani DM'd them first (dm_sent) or they replied (replied)
        if (existingLead.status !== 'dm_sent' && existingLead.status !== 'replied') {
          log('info', 'PRIMARY_SEND', `@${thread.username}: lead status '${existingLead.status}' — skipping`);
          return;
        }

        if (existingLead && existingLead.conversation_step >= TERMINAL_STEP) {
          log('info', 'AI', `@${thread.username} at terminal step — skipping`);
          return;
        }

        log('info', 'PRIMARY_SEND', `Processing @${thread.username} on thread page...`);

        // Dismiss blockers
        try {
          await page.evaluate(() => {
            for (const b of document.querySelectorAll('button, div[role="button"]')) {
              const t = (b.textContent || '').trim().toLowerCase();
              if (t === 'not now' || t === 'turn on') { b.click(); return; }
            }
          });
          await delay(1000);
        } catch (e) {}

        // Read messages from DOM — we're already on the thread page, messages are rendered right there
        let messages = [];
        try { messages = await fetchThreadMessagesDOM(page); } catch (e) {}
        if (messages.length === 0) {
          // DOM fallback didn't find messages — try API
          try { messages = await fetchThreadMessagesAPI(page, thread.threadId); } catch (e) {}
        }
        log('info', 'PRIMARY_SEND', `@${thread.username}: got ${messages.length} messages`);

        // Debug: log what we got
        log('info', 'PRIMARY_SEND', `@${thread.username}: fetched ${messages.length} messages${messages.length > 0 ? ` (last: isMe=${messages[messages.length-1].isMe} type=${messages[messages.length-1].itemType} text="${(messages[messages.length-1].text || '').substring(0, 60)}")` : ''}`);

        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.isMe) {
          log('info', 'PRIMARY_SEND', `@${thread.username}: last message is from us — skipping`);
          repliedThreads.add(thread.threadId);
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          return;
        }

        // Filter out "Seen" receipts and system notifications — not real messages
        if (lastMsg && /^seen\s/i.test(lastMsg.text || '')) {
          log('info', 'PRIMARY_SEND', `@${thread.username}: last message is "Seen" receipt — skipping`);
          repliedThreads.add(thread.threadId);
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          return;
        }

        // Get last incoming message — include non-text types (sticker, reel_share, media, etc.)
        const incomingMsg = messages.filter(m => !m.isMe).pop();
        let incoming = '';
        if (incomingMsg) {
          if (incomingMsg.text && incomingMsg.text.trim()) {
            incoming = incomingMsg.text;
          } else {
            // Non-text message (sticker, emoji, reel share, media, etc.) — describe it
            const type = incomingMsg.itemType || 'unknown';
            const descriptions = {
              'reel_share': 'shared a reel',
              'media': 'sent a photo/video',
              'animated_media': 'sent a GIF',
              'sticker': 'sent a sticker',
              'link': 'sent a link',
              'like': 'liked a message',
              'profile': 'shared a profile',
              'placeholder': 'sent a message',
              'video_call_event': 'tried to video call',
              'text': incomingMsg.text || '',
            };
            incoming = descriptions[type] || `sent a ${type}`;
            log('info', 'PRIMARY_SEND', `@${thread.username}: non-text message (${type}) — using description: "${incoming}"`);
          }
        }
        if (!incoming.trim()) incoming = thread.lastMessage || '';
        if (!incoming.trim()) {
          log('info', 'PRIMARY_SEND', `@${thread.username}: no incoming message found — skipping (will retry next pulse)`);
          return;
        }

        // === LANGUAGE FILTER ===
        // Check ALL their messages (not just last one — last might be "Seen just now" Instagram UI text)
        const allTheirText = messages.filter(m => !m.isMe && m.text).map(m => m.text).join(' ');
        if (!isAllowedLanguage(allTheirText)) {
          log('info', 'PRIMARY_SEND', `@${thread.username}: blocked language — skipping`);
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          return;
        }

        // === EMAIL+NAME SAFETY NET ===
        // If the conversation already contains both email and name, deliver framework and terminate
        const delivered = await tryDeliverCapturedInfo(thread, messages, existingLead);
        if (delivered) {
          log('info', 'PRIMARY_SEND', `@${thread.username}: delivered framework via safety net — skipping normal reply`);
          return;
        }

        // === CALL DETECTION ===
        // Check if the last incoming message is a call event
        const isCallEvent = incomingMsg && (incomingMsg.itemType === 'video_call_event' || incomingMsg.itemType === 'call_log');
        if (isCallEvent) {
          log('success', 'CALL_DETECT', `@${thread.username}: detected call event!`);
          
          // Send $250 offer — NO notification yet, wait for positive reply
          const callReply = `Hey ${thread.fullName || thread.username}, I saw you tried to call! I don't take calls on here, but I do offer video calls on WhatsApp/Telegram. It's $250 for a video call and you get to keep my number. Let me know if you're interested!`;
          
          // Navigate to thread and send
          try {
            await page.goto(`https://www.instagram.com/direct/t/${thread.threadId}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await delay(3000);
            const chatBox = page.locator('[role="main"] div[contenteditable="true"], div[contenteditable="true"], [placeholder*="Message"], div[role="textbox"]').first();
            if (await chatBox.isVisible({ timeout: 5000 }).catch(() => false)) {
              await chatBox.click();
              await delay(500);
              for (const char of callReply) {
                await chatBox.type(char, { delay: 30 + Math.random() * 60 });
              }
              await delay(1000);
              const sent = await page.evaluate(() => {
                for (const b of document.querySelectorAll('button, div[role="button"]')) {
                  if ((b.textContent || '').trim().toLowerCase() === 'send') { b.click(); return true; }
                }
                return false;
              });
              if (!sent) await page.keyboard.press('Enter');
              await delay(2000);
              
              // Dismiss notifications
              await page.evaluate(() => {
                for (const b of document.querySelectorAll('button, div[role="button"]')) {
                  const t = (b.textContent || '').trim().toLowerCase();
                  if (t === 'not now') { b.click(); return; }
                }
              }).catch(() => {});
              
              log('success', 'CALL_DETECT', `$250 offer sent to @${thread.username} — waiting for reply`);
              
              // Save to outbox
              try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: existingLead?.id, message: callReply, incoming_message: '[call_event]', status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
              
              // Mark lead as call_lead for follow-up
              if (existingLead) {
                const convData = existingLead.conversation_data || {};
                convData.call_detected_at = new Date().toISOString();
                convData.call_offer_sent = true;
                await supabase.from('leads').update({
                  conversation_data: convData,
                  last_updated_at: new Date().toISOString()
                }).eq('id', existingLead.id);
              }
              
              repliedThreads.add(thread.threadId);
              markThreadProcessed(thread.threadId);
              persistProcessedThreads();
            }
          } catch (e) {
            log('error', 'CALL_DETECT', `Failed to send $250 offer to @${thread.username}: ${e.message}`);
          }
          return; // Skip normal AI processing for call events
        }

        // === CALL LEAD FOLLOW-UP ===
        // Check if this lead was previously offered the $250 call deal
        if (existingLead?.conversation_data?.call_offer_sent) {
          const incomingLower = (incoming || '').toLowerCase();
          const isPositive = /\b(yes|sure|interested|okay|ok|yeah|yep|i'm in|count me|let's do it|whatsapp|telegram|number|phone|send|share|want|like|do it)\b/i.test(incomingLower);
          const isNegative = /\b(no|nah|not|never|pass|skip|maybe later|too expensive|can't afford)\b/i.test(incomingLower);
          
          if (isPositive) {
            // They're interested — notify Olive!
            log('success', 'CALL_DETECT', `@${thread.username}: POSITIVE reply to $250 offer!`);
            sendTelegram(config, `📞💰 <b>Call lead interested!</b> — @${thread.username}\nThey want the $250 video call + WhatsApp/Telegram number!\n\nJump in and handle payment!`);
            
            // Clear the flag so we don't notify again
            const convData = existingLead.conversation_data || {};
            convData.call_offer_sent = false;
            convData.call_lead_interested = true;
            await supabase.from('leads').update({
              conversation_data: convData,
              last_updated_at: new Date().toISOString()
            }).eq('id', existingLead.id);
          } else if (isNegative) {
            // They're not interested — clear the flag, no notification
            log('info', 'CALL_DETECT', `@${thread.username}: negative reply to $250 offer — no notification`);
            const convData = existingLead.conversation_data || {};
            convData.call_offer_sent = false;
            await supabase.from('leads').update({
              conversation_data: convData,
              last_updated_at: new Date().toISOString()
            }).eq('id', existingLead.id);
          }
          // If neither positive nor negative, keep waiting for a clear response
        }

        // Generate AI reply
        let reply;
        const convoStep = existingLead?.conversation_step || 0;
        const routeStep = config.conversationRoutingStep || 4;
        try {
          const convoHistory = messages.slice(-6).map(m => `${m.isMe ? 'Me' : 'Them'}: ${m.text}`).join('\n');
          const displayName = thread.fullName || thread.username;
          let rawPrompt;
          if (convoStep >= routeStep + 3 && shareableLink) {
            // Step 7+: Professional chatter — keep them engaged, let them ask for the link
            rawPrompt = `Reply to this Instagram DM.\n\nTheir name: "${displayName}"\nTheir message: "${incoming}"\n\nConversation so far:\n${convoHistory}\n\nYou're a professional chatter. You already shared your link. DO NOT share the link again. Keep them engaged — ask about their day, their interests, their life. Make them feel special. Be playful and fun. If they haven't subscribed yet, that's okay — keep building the relationship. Don't sell, don't mention price. Just be yourself.`;
          } else if (convoStep >= routeStep + 2 && shareableLink) {
            // Step 6: Professional chatter — if they asked for the link, share it. If they subscribed, ask for username.
            const wantsLink = /\b(link|page|profile|where|how|send|share|check it out|what is it)\b/i.test(incoming);
            const mentionedSub = /\b(sub|subscri|joined|got it|bought|paid|on it|already|just did)\b/i.test(incoming);
            if (mentionedSub) {
              rawPrompt = `Reply to this Instagram DM.\n\nTheir name: "${displayName}"\nTheir message: "${incoming}"\n\nConversation so far:\n${convoHistory}\n\nThey just mentioned they subscribed! Be excited and genuine. Ask for their username warmly so you can check it out and give them a shoutout. Example: "That's amazing! What's your username so I can check?"`;
            } else if (wantsLink) {
              rawPrompt = `Reply to this Instagram DM.\n\nTheir name: "${displayName}"\nTheir message: "${incoming}"\n\nConversation so far:\n${convoHistory}\n\nThey asked for your link! Share it naturally. Example: "Sure! Here it is: ${shareableLink}". Keep it short and warm.`;
            } else {
              rawPrompt = `Reply to this Instagram DM.\n\nTheir name: "${displayName}"\nTheir message: "${incoming}"\n\nConversation so far:\n${convoHistory}\n\nYou're a professional chatter. Keep them engaged — ask about their day, their interests, their life. Make them feel special. Be playful and fun. Don't share the link unless they ask. Keep it short and natural.`;
            }
          } else if (convoStep >= routeStep + 1 && shareableLink) {
            // Step 5: Create curiosity — mention your page, don't share link yet
            const step5Variations = [
              `Hey ${displayName}, you'd love my page`,
              `${displayName}, I'm way more fun on my page`,
              `${displayName}, you should see my page sometime`
            ];
            const step5Msg = step5Variations[Math.floor(Math.random() * step5Variations.length)];
            rawPrompt = `Reply to this Instagram DM.\n\nTheir name: "${displayName}"\nTheir message: "${incoming}"\n\nConversation so far:\n${convoHistory}\n\nReply in 1 short sentence. Address them by first name. Be warm and natural. Mention your page but do NOT share the link yet. Use this exact message (or very similar): "${step5Msg}"`;
          } else if (convoStep >= routeStep && shareableLink) {
            // Step 4: Professional chatter — engage, ask questions, build connection
            rawPrompt = `Reply to this Instagram DM.\n\nTheir name: "${displayName}"\nTheir message: "${incoming}"\n\nConversation so far:\n${convoHistory}\n\nYou're a professional chatter. Be playful, fun, and engaging. Ask them about their day, their interests, their life. Make them feel special and heard. Do NOT share the link yet — just build connection. Keep it short (1-2 sentences), personal, and fun.`;
          } else {
            // Steps 1-3: Build rapport, no link
            rawPrompt = `Reply to this Instagram DM.\n\nTheir name: "${displayName}"\nTheir message: "${incoming}"\n\nConversation so far:\n${convoHistory}\n\nReply in 1 short sentence. Address them by first name. Be warm, ask a question to keep them engaged. Do NOT share any links yet — UNLESS the message is explicitly sexual/inappropriate (contains words like: sexy, hot, naked, sex, send pic, fuck, nude, etc. — do NOT treat compliments like beautiful, cute, gorgeous as sexual), in which case deflect with: "Hey [name], let's keep things friendly here! But if you want to know more about me you can check it out here: ${shareableLink || '[link not available]'}". Do NOT use this deflection for regular conversation, compliments, or normal messages.`;
          }
          const fullPrompt = sanitizeForGemini(rawPrompt);
          let sysInst = trainingContext ? sanitizeForGemini(trainingContext) : null;
          if (sysInst && shareableLink) {
            sysInst += `\n\nCRITICAL: Your actual link is: ${shareableLink}. When sharing your link, you MUST use this exact URL. Say "if you want to know more about me you can find it here" or "check me out here" — do NOT say "exclusive page" or "website".`;
          }
          sysInst += `\n\nPRICING: NEVER mention price unless they ask. If they ask, say "It's really reasonable, you'll see when you check it out." Don't oversell — just be natural. The link speaks for itself.`;
          sysInst = (sysInst || '') + CONSERVATIVE_TONE;
          reply = await callGemini(apiKey, fullPrompt, 3, sysInst);
        } catch (e) {
          if (e.quotaExhausted) { geminiQuotaExhausted = true; log('warn', 'GEMINI', 'Quota exhausted — skipping all remaining threads this pulse'); }
          log('warn', 'PRIMARY_SEND', `AI failed for @${thread.username}: ${e.message}`);
          return;
        }

        if (!reply) { log('warn', 'PRIMARY_SEND', `No AI reply for @${thread.username}`); return; }
        const cleanReply = reply.replace(/\[ADVANCE\]|\[REMAIN\]/gi, '').trim();
        const hasLink = shareableLink && cleanReply.includes(shareableLink);
        if (hasLink) {
          log('success', 'PRIMARY_SEND', `@${thread.username}: Link shared at step ${convoStep}`);
          sendTelegram(config, `🔗 <b>Link shared!</b> — @${thread.username}\nStep: ${convoStep}\n"${cleanReply.substring(0, 150)}"`);
        }

        // Send via typeAndSend (we're already on the thread page)
        const chatBox = page.locator('[role="main"] div[contenteditable="true"], div[contenteditable="true"], [placeholder*="Message"], div[role="textbox"]').first();
        if (await chatBox.isVisible({ timeout: 5000 }).catch(() => false)) {
          await chatBox.click();
          await delay(500);
          for (const char of cleanReply) {
            await chatBox.type(char, { delay: 30 + Math.random() * 60 });
          }
          await delay(1000);

          const sent = await page.evaluate(() => {
            for (const b of document.querySelectorAll('button, div[role="button"]')) {
              if ((b.textContent || '').trim().toLowerCase() === 'send') { b.click(); return true; }
            }
            return false;
          });
          if (!sent) await page.keyboard.press('Enter');
          await delay(2000);

          // Dismiss "Turn on Notifications"
          await page.evaluate(() => {
            for (const b of document.querySelectorAll('button, div[role="button"]')) {
              const t = (b.textContent || '').trim().toLowerCase();
              if (t === 'not now') { b.click(); return; }
            }
          }).catch(() => {});

          threadsReplied++;
          primaryReplies++;
          repliedThreads.add(thread.threadId);
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          log('success', 'PRIMARY_SEND', `Reply sent to @${thread.username}: "${cleanReply.substring(0, 80)}"`);

          // Update lead
          if (existingLead) {
            const currentStep = existingLead.conversation_step || 0;
            let newStep;
            const incomingLower = (incoming || '').toLowerCase();

            if (currentStep >= routeStep + 3) {
              // Step 7+: Soft close loop — check for username, pricing agreement, otherwise stay at step 7
              const usernameMatch = incoming.match(/(?:my username is|my of is|my onlyfans is|@\s*)([a-zA-Z0-9._]{3,30})/i);
              if (usernameMatch) {
                const subUsername = usernameMatch[1];
                const convData = existingLead.conversation_data || {};
                convData.sub_username = subUsername;
                convData.sub_verified_at = new Date().toISOString();
                await supabase.from('leads').update({
                  conversation_step: TERMINAL_STEP,
                  conversation_data: convData,
                  status: 'replied',
                  last_updated_at: new Date().toISOString()
                }).eq('id', existingLead.id);
                log('success', 'PRIMARY_SEND', `@${thread.username}: subscriber username captured: ${subUsername}`);
                newStep = TERMINAL_STEP;
              } else if (/\b(yes|sure|interested|how|subscribe|subscribed|joined|bought|paid|on it|let's do it|i'm in|count me|check it out|will do|sounds good)\b/i.test(incomingLower)) {
                // They showed interest — no notification needed, just log
                log('success', 'PRIMARY_SEND', `@${thread.username}: interest detected`);
                newStep = currentStep;
              } else {
                // Stay at step 7 — keep nudging with pricing/personal connection
                newStep = currentStep;
              }
            } else if (currentStep >= routeStep + 2) {
              // Step 6: Check if they provided a username
              const usernameMatch = incoming.match(/(?:my username is|my of is|my onlyfans is|@\s*)([a-zA-Z0-9._]{3,30})/i);
              if (usernameMatch) {
                const subUsername = usernameMatch[1];
                const convData = existingLead.conversation_data || {};
                convData.sub_username = subUsername;
                convData.sub_verified_at = new Date().toISOString();
                await supabase.from('leads').update({
                  conversation_step: TERMINAL_STEP,
                  conversation_data: convData,
                  status: 'replied',
                  last_updated_at: new Date().toISOString()
                }).eq('id', existingLead.id);
                log('success', 'PRIMARY_SEND', `@${thread.username}: subscriber username captured: ${subUsername}`);
                newStep = TERMINAL_STEP;
              } else {
                // No username yet — advance to step 7 (soft close)
                newStep = routeStep + 3;
              }
            } else if (currentStep >= routeStep + 1) {
              // Step 5: Curiosity — advance to step 6 (where we share link if they ask)
              newStep = routeStep + 2;
            } else if (currentStep >= routeStep && hasLink) {
              // Step 4: Link was shared (deflection) — jump to step 6
              newStep = routeStep + 2;
            } else if (currentStep >= routeStep) {
              // Step 4: No link — advance to step 5 (curiosity)
              newStep = currentStep + 1;
            } else {
              // Steps 1-3: If link was shared (deflection), jump to step 6 (ask for username)
              // Otherwise increment normally
              newStep = hasLink ? routeStep + 2 : currentStep + 1;
            }
            await supabase.from('leads').update({
              conversation_step: newStep,
              status: 'replied', last_updated_at: new Date().toISOString()
            }).eq('id', existingLead.id);
            log('info', 'PRIMARY_SEND', `@${thread.username}: step ${currentStep} → ${newStep} (linkShared=${hasLink})`);
            // Track step distribution
            const stepKey = `${currentStep}→${newStep}`;
            primaryStepDistribution[stepKey] = (primaryStepDistribution[stepKey] || 0) + 1;
            if (hasLink) {
              primaryLinkShared++;
              primaryLinkSharedUsers.push(thread.username);
            }
          }
          await supabase.from('outbox').insert({
            workspace_id: workspaceId, lead_id: existingLead?.id, message: cleanReply,
            incoming_message: incoming, status: 'auto_replied', sent_at: new Date().toISOString()
          }).then(() => {}, () => {});

          // Human delay
          const thinkingDelay = 3000 + Math.random() * 5000;
          const typingSpeed = 3 + Math.random() * 2;
          const typingDelay = Math.max(3000, (cleanReply.length / typingSpeed) * 1000);
          const humanDelay = thinkingDelay + typingDelay;
          log('info', 'HUMANIZER', `Pausing ~${Math.round(humanDelay/1000)}s (${cleanReply.length} chars)...`);
          await delay(humanDelay);
        } else {
          log('warn', 'PRIMARY_SEND', `Chat box not found for @${thread.username}`);
        }
      };

      // ─── Part A: Fetch thread list via API (no navigation — just get the list) ───
      // fetchInboxAPI already filters out threads where last message is from us (SELF_LAST)
      let processed = 0;
      let apiThreadIds = new Set();
      let apiUsernames = new Set();
      let actionableThreads = [];
      try {
        const allActionableThreads = [];
        let cursor = null;
        let pageCount = 0;
        const MAX_INBOX_PAGES = 10;
        do {
          const inboxResult = await fetchInboxAPI(page, cursor);
          const pageThreads = inboxResult.threads || [];
          allActionableThreads.push(...pageThreads);
          cursor = inboxResult.cursor;
          pageCount++;
          log('info', 'API_PRIMARY', `Page ${pageCount}: ${pageThreads.length} threads, cursor: ${cursor ? JSON.stringify(cursor).substring(0, 80) : 'null'}, hasMore: ${inboxResult.hasMore}`);
          if (inboxResult.hasMore && cursor && pageCount < MAX_INBOX_PAGES) {
            const pageDelay = 120000 + Math.random() * 30000;
            log('info', 'API_PRIMARY', `Waiting ${Math.round(pageDelay/1000)}s before next inbox page...`);
            await delay(pageDelay);
          } else {
            break;
          }
        } while (true);

        actionableThreads = allActionableThreads
          .filter((t, i, arr) => arr.findIndex(x => x.threadId === t.threadId) === i)
          .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
        log('info', 'API_PRIMARY', `${actionableThreads.length} actionable Primary thread(s) from API (${pageCount} page(s))`);

        apiThreadIds = new Set(actionableThreads.map(t => t.threadId));
        apiUsernames = new Set(actionableThreads.map(t => t.username.toLowerCase()));

        // ─── PRE-FILTER: cross-reference API threads with leads table ───
        // Only threads matching dm_sent/replied leads will actually be processed
        // This gives accurate count upfront AND saves navigations on skipped threads
        const apiUsernamesArray = [...apiUsernames];
        const { data: matchingLeads } = await supabase.from('leads')
          .select('ig_handle, status')
          .eq('workspace_id', workspaceId)
          .in('ig_handle', apiUsernamesArray)
          .in('status', ['dm_sent', 'replied']);

        const leadMap = new Map((matchingLeads || []).map(l => [l.ig_handle, l.status]));
        const beforeFilter = actionableThreads.length;
        actionableThreads = actionableThreads.filter(t => leadMap.has(t.username.toLowerCase()));

        log('info', 'API_PRIMARY', `Pre-filter: ${beforeFilter} API threads → ${actionableThreads.length} have matching dm_sent/replied leads`);
        if (actionableThreads.length > 0 && actionableThreads.length <= 20) {
          log('info', 'API_PRIMARY', `Will process: ${actionableThreads.map(t => `@${t.username}(${leadMap.get(t.username.toLowerCase())})`).join(', ')}`);
        }
        if (beforeFilter - actionableThreads.length > 0) {
          const skipped = beforeFilter - actionableThreads.length;
          log('info', 'API_PRIMARY', `${skipped} threads skipped (no lead or status not dm_sent/replied)`);
        }

        apiThreadIds = new Set(actionableThreads.map(t => t.threadId));
        apiUsernames = new Set(actionableThreads.map(t => t.username.toLowerCase()));
      } catch (e) {
        log('warn', 'API_PRIMARY', `API fetch failed: ${e.message}`);
      }

      log('info', 'API_PRIMARY', `API fetch done: ${apiThreadIds.size} threads found — processing via message reading (no DOM detection)`);

      // ─── Part B: API navigation — process each thread, read messages to decide ───
      // No DOM blue-dot detection — Instagram's DOM/API are unreliable for unread status.
      // Instead, navigate to each thread, read messages, and let processPrimaryThread decide.
      try {
        for (const thread of actionableThreads) {
          if (processed >= MAX_API_PRIMARY_PER_PULSE) {
            log('info', 'PRIMARY_CAP', `API cap reached (${MAX_API_PRIMARY_PER_PULSE}) — stopping API navigation`);
            break;
          }
          if (repliedThreads.has(thread.threadId) || processedThreads.has(thread.threadId)) {
            log('info', 'DEDUP', `@${thread.username}: already processed — skipping`);
            continue;
          }

          try {
            await page.goto(`https://www.instagram.com/direct/t/${thread.threadId}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForSelector('[role="row"], [role="listitem"], [data-testid="message-container"]', { timeout: 8000 }).catch(() => {});
            await delay(2000);
            await processPrimaryThread({
              threadId: thread.threadId,
              username: thread.username,
              fullName: thread.fullName || '',
              lastMessage: thread.lastMessage || '',
              isUnread: true,
              _source: 'primary_api'
            });
            processed++;
          } catch (e) {
            log('warn', 'API_PRIMARY', `[primary] Error on @${thread.username}: ${e.message}`);
          }
        }
      } catch (e) {
        log('warn', 'API_PRIMARY', `API navigation failed: ${e.message}`);
      }

      log('info', 'PRIMARY_SCAN', `[primary] Full scan done: ${processed} threads processed (leads pre-filtered)`);
    } catch (e) {
      log('warn', 'SCAN_PRIMARY', `Click-first failed: ${e.message}`);
    }
  }

  // 2. REQUESTS — DOM scan with IMMEDIATE send (depth-first)
  // While on the thread's page: Accept → Move to Primary → Generate reply → Send → Back
  if (config.scanRequests !== false) {
    try {
      const processRequestThread = async (thread) => {
        if (geminiQuotaExhausted) return; // Skip — quota exhausted this pulse
        // Instagram safety: cap request/hidden processing per pulse
        if (requestHiddenCapHit || requestReplies >= MAX_REQUEST_HIDDEN_PER_PULSE) {
          requestHiddenCapHit = true;
          log('info', 'SAFETY', `Request cap reached (${MAX_REQUEST_HIDDEN_PER_PULSE}) — stopping request processing`);
          return;
        }

        // HARD threadId dedup — prevents re-replying when Instagram DOM truncates usernames differently
        if (repliedThreads.has(thread.threadId) || processedThreads.has(thread.threadId)) {
          log('info', 'DEDUP', `@${thread.username}: already processed — skipping`);
          return;
        }

        const skipUsers = ['instagram support', 'instagram', 'highlightsvideo'];
        if (skipUsers.includes(thread.username.toLowerCase())) return;

        // No rate limit — process ALL threads

        // Check lead
        let { data: existingLead } = await supabase.from('leads')
          .select('id, ig_handle, status, conversation_step, conversation_data')
          .eq('workspace_id', workspaceId)
          .eq('ig_handle', thread.username.toLowerCase())
          .maybeSingle();
        
        if (!existingLead) {
          const { data: newLead } = await supabase.from('leads').insert({
            workspace_id: workspaceId, ig_handle: thread.username.toLowerCase(),
            status: 'replied', source: 'inbound_dm', last_updated_at: new Date().toISOString()
          }).select('id, ig_handle, status, conversation_step, conversation_data').maybeSingle();
          if (newLead) existingLead = newLead;
        }

        if (existingLead && existingLead.conversation_step >= TERMINAL_STEP) {
          log('info', 'AI', `@${thread.username} at terminal step — skipping`);
          return;
        }

        // We're on the thread's page right now — Accept + Move to Primary + Send immediately
        log('info', 'REQUEST_SEND', `Processing @${thread.username} on thread page...`);

        // CAP CHECK — BEFORE accept (not after send). Stops accepting when cap reached.
        if (requestAccepted >= MAX_REQUEST_HIDDEN_PER_PULSE) {
          requestHiddenCapHit = true;
          log('info', 'SAFETY', `Request ACCEPT cap reached (${requestAccepted}/${MAX_REQUEST_HIDDEN_PER_PULSE}) — stopping request processing`);
          return;
        }

        // Accept if needed
        try {
          const acceptBtn = page.locator('button:has-text("Accept"), div[role="button"]:has-text("Accept")').first();
          if (await acceptBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await acceptBtn.click({ timeout: 5000 });
            requestAccepted++;
            log('info', 'REQUEST_ACCEPT', `Accepted @${thread.username} (${requestAccepted}/${MAX_REQUEST_HIDDEN_PER_PULSE})`);
            await delay(2000);
            // Move to Primary
            for (let i = 0; i < 15; i++) {
              const moved = await page.evaluate(() => {
                for (const el of document.querySelectorAll('*')) {
                  if (el.children.length === 0 && (el.textContent || '').trim() === 'Primary') {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) { el.click(); return true; }
                  }
                }
                return false;
              });
              if (moved) { log('info', 'REQUEST_ACCEPT', 'Moved to Primary'); await delay(2000); break; }
              await delay(500);
            }
          }
        } catch (e) {}

        // Dismiss blockers (notifications, turn on, etc.)
        try {
          await page.evaluate(() => {
            for (const b of document.querySelectorAll('button, div[role="button"]')) {
              const t = (b.textContent || '').trim().toLowerCase();
              if (t === 'not now' || t === 'turn on') { b.click(); return; }
            }
          });
          await delay(1000);
        } catch (e) {}

        // Fetch messages to build AI context
        let messages = [];
        try {
          messages = await fetchThreadMessagesAPI(page, thread.threadId);
        } catch (e) {}

        // Generate AI reply
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.isMe) {
          log('info', 'REQUEST_SEND', `@${thread.username}: last message is from us — skipping`);
          repliedThreads.add(thread.threadId);
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          return;
        }
        const theirMsgs = messages.filter(m => !m.isMe && m.text).map(m => m.text);
        const myMsgs = messages.filter(m => m.isMe && m.text).map(m => m.text);
        const incoming = theirMsgs[theirMsgs.length - 1] || thread.lastMessage || '';

        // === LANGUAGE FILTER ===
        const allTheirTextReq = theirMsgs.join(' ');
        if (!isAllowedLanguage(allTheirTextReq)) {
          log('info', 'REQUEST_SEND', `@${thread.username}: blocked language — skipping`);
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          return;
        }

        let reply;
        try {
          const convoHistory = messages.slice(-6).map(m => `${m.isMe ? 'Me' : 'Them'}: ${m.text}`).join('\n');
          const displayName = thread.fullName || thread.username;
          const rawPrompt = `Reply to this Instagram DM.\n\nTheir name: "${displayName}"\nTheir message: "${incoming}"\n\nConversation so far:\n${convoHistory}\n\nReply in 1-2 short sentences. Address them by first name. Be warm, ask a question to keep them engaged. Do NOT share any links yet.`;
          const fullPrompt = sanitizeForGemini(rawPrompt);
          let sysInst = trainingContext ? sanitizeForGemini(trainingContext) : null;
          if (sysInst && shareableLink) {
            sysInst += `\n\nCRITICAL: Your actual link is: ${shareableLink}. When sharing your link, you MUST use this exact URL. Say "if you want to know more about me you can find it here" or "check me out here" — do NOT say "exclusive page" or "website".`;
          }
          sysInst = (sysInst || '') + CONSERVATIVE_TONE;
          reply = await callGemini(apiKey, fullPrompt, 3, sysInst);
        } catch (e) {
          if (e.quotaExhausted) { geminiQuotaExhausted = true; log('warn', 'GEMINI', 'Quota exhausted — skipping all remaining threads this pulse'); }
          log('warn', 'REQUEST_SEND', `AI failed for @${thread.username}: ${e.message}`);
          return;
        }

        if (!reply) { log('warn', 'REQUEST_SEND', `No AI reply for @${thread.username}`); return; }
        const cleanReply = reply.replace(/\[ADVANCE\]|\[REMAIN\]/gi, '').trim();

        // Send via typeAndSend (we're already on the thread page)
        const chatBox = page.locator('[role="main"] div[contenteditable="true"], div[contenteditable="true"], [placeholder*="Message"], div[role="textbox"]').first();
        if (await chatBox.isVisible({ timeout: 5000 }).catch(() => false)) {
          await chatBox.click();
          await delay(500);
          for (const char of cleanReply) {
            await chatBox.type(char, { delay: 30 + Math.random() * 60 });
          }
          await delay(1000);

          const sent = await page.evaluate(() => {
            for (const b of document.querySelectorAll('button, div[role="button"]')) {
              if ((b.textContent || '').trim().toLowerCase() === 'send') { b.click(); return true; }
            }
            return false;
          });
          if (!sent) await page.keyboard.press('Enter');
          await delay(2000);

          // Dismiss "Turn on Notifications"
          await page.evaluate(() => {
            for (const b of document.querySelectorAll('button, div[role="button"]')) {
              const t = (b.textContent || '').trim().toLowerCase();
              if (t === 'not now') { b.click(); return; }
            }
          }).catch(() => {});

          threadsReplied++;
          requestReplies++;
          repliedThreads.add(thread.threadId);
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          log('success', 'REQUEST_SEND', `Reply sent to @${thread.username}: "${cleanReply.substring(0, 80)}"`);

          // Update lead
          if (existingLead) {
            await supabase.from('leads').update({
              conversation_step: (existingLead.conversation_step || 0) + 1,
              status: 'replied', last_updated_at: new Date().toISOString()
            }).eq('id', existingLead.id);
          }
          await supabase.from('outbox').insert({
            workspace_id: workspaceId, lead_id: existingLead?.id, message: cleanReply,
            incoming_message: incoming, status: 'auto_replied', sent_at: new Date().toISOString()
          }).then(() => {}, () => {});

          // Human delay — character-based like sendReplyViaPhysical
          const thinkingDelay = 3000 + Math.random() * 5000;
          const typingSpeed = 3 + Math.random() * 2;
          const typingDelay = Math.max(3000, (cleanReply.length / typingSpeed) * 1000);
          const humanDelay = thinkingDelay + typingDelay;
          log('info', 'HUMANIZER', `Pausing ~${Math.round(humanDelay/1000)}s (${cleanReply.length} chars)...`);
          await delay(humanDelay);
        } else {
          log('warn', 'REQUEST_SEND', `Chat box not found for @${thread.username}`);
        }
      };

      await scanFolderDOM(page, 'requests', processRequestThread);
    } catch (e) {
      log('warn', 'SCAN_REQUESTS', `Failed: ${e.message}`);
    }
  }

  // 3. HIDDEN — DOM scan with IMMEDIATE send (depth-first)
  if (config.scanRequests !== false) {
    try {
      const processHiddenThread = async (thread) => {
        if (geminiQuotaExhausted) return; // Skip — quota exhausted this pulse
        // HARD threadId dedup — prevents re-replying when Instagram DOM truncates usernames differently
        if (repliedThreads.has(thread.threadId) || processedThreads.has(thread.threadId)) {
          log('info', 'DEDUP', `@${thread.username}: already processed — skipping`);
          return;
        }

        const skipUsers = ['instagram support', 'instagram', 'highlightsvideo'];
        if (skipUsers.includes(thread.username.toLowerCase())) return;

        // No rate limit — process ALL threads

        let { data: existingLead } = await supabase.from('leads')
          .select('id, ig_handle, status, conversation_step, conversation_data')
          .eq('workspace_id', workspaceId)
          .eq('ig_handle', thread.username.toLowerCase())
          .maybeSingle();
        
        if (!existingLead) {
          const { data: newLead } = await supabase.from('leads').insert({
            workspace_id: workspaceId, ig_handle: thread.username.toLowerCase(),
            status: 'replied', source: 'inbound_dm', last_updated_at: new Date().toISOString()
          }).select('id, ig_handle, status, conversation_step, conversation_data').maybeSingle();
          if (newLead) existingLead = newLead;
        }

        if (existingLead && existingLead.conversation_step >= TERMINAL_STEP) {
          log('info', 'AI', `@${thread.username} at terminal step — skipping`);
          return;
        }

        log('info', 'HIDDEN_SEND', `Processing @${thread.username} on thread page...`);

        // CAP CHECK — BEFORE accept (same as Requests). Stops accepting when cap reached.
        if (requestAccepted >= MAX_REQUEST_HIDDEN_PER_PULSE) {
          requestHiddenCapHit = true;
          log('info', 'SAFETY', `Request ACCEPT cap reached (${requestAccepted}/${MAX_REQUEST_HIDDEN_PER_PULSE}) — stopping hidden processing`);
          return;
        }

        // Accept if needed
        try {
          const acceptBtn = page.locator('button:has-text("Accept"), div[role="button"]:has-text("Accept")').first();
          if (await acceptBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await acceptBtn.click({ timeout: 5000 });
            requestAccepted++;
            log('info', 'HIDDEN_ACCEPT', `Accepted @${thread.username} (${requestAccepted}/${MAX_REQUEST_HIDDEN_PER_PULSE})`);
            await delay(2000);
            for (let i = 0; i < 15; i++) {
              const moved = await page.evaluate(() => {
                for (const el of document.querySelectorAll('*')) {
                  if (el.children.length === 0 && (el.textContent || '').trim() === 'Primary') {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) { el.click(); return true; }
                  }
                }
                return false;
              });
              if (moved) { log('info', 'HIDDEN_ACCEPT', 'Moved to Primary'); await delay(2000); break; }
              await delay(500);
            }
          }
        } catch (e) {}

        // Dismiss blockers
        try {
          await page.evaluate(() => {
            for (const b of document.querySelectorAll('button, div[role="button"]')) {
              const t = (b.textContent || '').trim().toLowerCase();
              if (t === 'not now' || t === 'turn on') { b.click(); return; }
            }
          });
          await delay(1000);
        } catch (e) {}

        // Fetch messages
        let messages = [];
        try { messages = await fetchThreadMessagesAPI(page, thread.threadId); } catch (e) {}

        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.isMe) {
          log('info', 'HIDDEN_SEND', `@${thread.username}: last message is from us — skipping`);
          repliedThreads.add(thread.threadId);
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          return;
        }

        const incoming = messages.filter(m => !m.isMe && m.text).map(m => m.text).pop() || thread.lastMessage || '';

        // === LANGUAGE FILTER ===
        const allTheirTextHidden = messages.filter(m => !m.isMe && m.text).map(m => m.text).join(' ');
        if (!isAllowedLanguage(allTheirTextHidden)) {
          log('info', 'HIDDEN_SEND', `@${thread.username}: blocked language — skipping`);
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          return;
        }

        // Generate AI reply
        let reply;
        try {
          const convoHistory = messages.slice(-6).map(m => `${m.isMe ? 'Me' : 'Them'}: ${m.text}`).join('\n');
          const displayName = thread.fullName || thread.username;
          const rawPrompt = `Reply to this Instagram DM.\n\nTheir name: "${displayName}"\nTheir message: "${incoming}"\n\nConversation so far:\n${convoHistory}\n\nReply in 1-2 short sentences. Address them by first name. Be warm, ask a question to keep them engaged. Do NOT share any links yet.`;
          const fullPrompt = sanitizeForGemini(rawPrompt);
          let sysInst = trainingContext ? sanitizeForGemini(trainingContext) : null;
          if (sysInst && shareableLink) {
            sysInst += `\n\nCRITICAL: Your actual link is: ${shareableLink}. When sharing your link, you MUST use this exact URL. Say "if you want to know more about me you can find it here" or "check me out here" — do NOT say "exclusive page" or "website".`;
          }
          sysInst = (sysInst || '') + CONSERVATIVE_TONE;
          reply = await callGemini(apiKey, fullPrompt, 3, sysInst);
        } catch (e) {
          if (e.quotaExhausted) { geminiQuotaExhausted = true; log('warn', 'GEMINI', 'Quota exhausted — skipping all remaining threads this pulse'); }
          log('warn', 'HIDDEN_SEND', `AI failed for @${thread.username}: ${e.message}`);
          return;
        }

        if (!reply) { log('warn', 'HIDDEN_SEND', `No AI reply for @${thread.username}`); return; }
        const cleanReply = reply.replace(/\[ADVANCE\]|\[REMAIN\]/gi, '').trim();

        // Send
        const chatBox = page.locator('[role="main"] div[contenteditable="true"], div[contenteditable="true"], [placeholder*="Message"], div[role="textbox"]').first();
        if (await chatBox.isVisible({ timeout: 5000 }).catch(() => false)) {
          await chatBox.click();
          await delay(500);
          for (const char of cleanReply) { await chatBox.type(char, { delay: 30 + Math.random() * 60 }); }
          await delay(1000);
          const sent = await page.evaluate(() => {
            for (const b of document.querySelectorAll('button, div[role="button"]')) {
              if ((b.textContent || '').trim().toLowerCase() === 'send') { b.click(); return true; }
            }
            return false;
          });
          if (!sent) await page.keyboard.press('Enter');
          await delay(2000);
          await page.evaluate(() => {
            for (const b of document.querySelectorAll('button, div[role="button"]')) {
              if ((b.textContent || '').trim().toLowerCase() === 'not now') { b.click(); return; }
            }
          }).catch(() => {});

          threadsReplied++;
          hiddenReplies++;
          repliedThreads.add(thread.threadId);
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          log('success', 'HIDDEN_SEND', `Reply sent to @${thread.username}: "${cleanReply.substring(0, 80)}"`);

          if (existingLead) {
            await supabase.from('leads').update({
              conversation_step: (existingLead.conversation_step || 0) + 1,
              status: 'replied', last_updated_at: new Date().toISOString()
            }).eq('id', existingLead.id);
          }
          await supabase.from('outbox').insert({
            workspace_id: workspaceId, lead_id: existingLead?.id, message: cleanReply,
            incoming_message: incoming, status: 'auto_replied', sent_at: new Date().toISOString()
          }).then(() => {}, () => {});

          // Human delay — character-based like sendReplyViaPhysical
          const thinkingDelay = 3000 + Math.random() * 5000;
          const typingSpeed = 3 + Math.random() * 2;
          const typingDelay = Math.max(3000, (cleanReply.length / typingSpeed) * 1000);
          const humanDelay = thinkingDelay + typingDelay;
          log('info', 'HUMANIZER', `Pausing ~${Math.round(humanDelay/1000)}s (${cleanReply.length} chars)...`);
          await delay(humanDelay);
        } else {
          log('warn', 'HIDDEN_SEND', `Chat box not found for @${thread.username}`);
        }
      };

      await scanFolderDOM(page, 'hidden', processHiddenThread);
    } catch (e) {
      log('warn', 'SCAN_HIDDEN', `Failed: ${e.message}`);
    }
  }

  // 4. GENERAL — DOM scan
  if (config.scanGeneral) {
    try {
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await delay(3000);
      const genThreads = await scanFolderDOM(page, 'general');
      const unreadGen = genThreads.filter(t => t.isUnread);
      for (const t of unreadGen) {
        threads.push({
          threadId: t.threadId,
          username: t.username,
          lastMessage: '',
          isUnread: true,
          _source: 'general_dom'
        });
        log('info', 'AI', `@${t.username} queued`);
      }
      // Silent — counted in summary
    } catch (e) {
      log('warn', 'SCAN_GENERAL', `Failed: ${e.message}`);
    }
  }

  // Navigate back to inbox after all DOM scans
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await delay(3000);

  // Merge Request/Hidden threads (queued via callbacks) into allInboxThreads for processing
  // This ensures they go through the same processing logic as Primary/General threads
  for (const t of threads) {
    if (!allInboxThreads.some(at => at.threadId === t.threadId)) {
      allInboxThreads.push(t);
    }
  }
  threads.length = 0; // Clear — will be repopulated during processing

  // Silent — counted in summary

  if (allInboxThreads.length > 0) {
    if (config.inboxScanMode) {
        // INBOX SCAN MODE: Process ALL threads where other person sent last message
        // No outbox dedup — self-message filter + per-pulse cap prevent spam
        for (const thread of allInboxThreads) {
          try {
          // Skip Instagram system accounts and self
          const skipUsers = ['instagram support', 'instagram', 'highlightsvideo'];
          if (skipUsers.includes(thread.username.toLowerCase())) continue;

          // Check if lead exists, create if not
          let { data: existingLead } = await supabase.from('leads')
            .select('id, ig_handle, status, conversation_step')
            .eq('workspace_id', workspaceId)
            .eq('ig_handle', thread.username.toLowerCase())
            .maybeSingle();
          
          if (!existingLead) {
            const { data: newLead, error: insertErr } = await supabase.from('leads').insert({
              workspace_id: workspaceId,
              ig_handle: thread.username.toLowerCase(),
              status: 'replied',
              source: 'inbound_dm',
              last_updated_at: new Date().toISOString()
            }).select('id, ig_handle, status').maybeSingle();
            if (newLead) {
              existingLead = newLead;
              log('success', 'INBOX_SCAN', `Created new lead @${thread.username} from inbound DM`);
            } else if (insertErr) {
              // Duplicate key — lead already exists, re-fetch
              const { data: retryLead } = await supabase.from('leads')
                .select('id, ig_handle, status, conversation_step')
                .eq('workspace_id', workspaceId)
                .eq('ig_handle', thread.username.toLowerCase())
                .maybeSingle();
              if (retryLead) existingLead = retryLead;
            }
          } else if (existingLead.status !== 'replied') {
            await supabase.from('leads').update({
              status: 'replied',
              last_updated_at: new Date().toISOString()
            }).eq('id', existingLead.id);
          }
          
          // Only add thread to reply queue if lead is NOT at terminal step
          // processedThreads removed — lastMsg.isMe in processing loop handles dedup
          const skipIfTerminal = existingLead && existingLead.conversation_step >= TERMINAL_STEP;
          if (!skipIfTerminal) {
            threads.push({
              threadId: thread.threadId,
              username: thread.username,
              lastMessage: thread.lastMessage || '',
              isUnread: thread.isUnread || false,
              _source: 'inbox_api',
              viewerId: thread.viewerId,
              lastSenderId: thread.lastSenderId
            });
            log('info', 'AI', `@${thread.username} queued`);
          } else {
            if (skipIfTerminal) {
              log('info', 'AI', `@${thread.username} at terminal step (${existingLead.conversation_step}) — skipping`);
            }
          }
           } catch (e) {
            log('warn', 'INSCAN_SCAN', `Failed processing @${thread.username}: ${e.message}`);
          }
        }
      } else {
        // STANDARD MODE: Only process threads that match leads Jani did outreach to (dm_sent)
        const threadHandles = [...new Set(allInboxThreads.map(t => t.username.toLowerCase()))];
        if (threadHandles.length > 0) {
          const { data: actionableLeads } = await supabase.from('leads')
            .select('id, ig_handle, status')
            .eq('workspace_id', workspaceId)
            .in('ig_handle', threadHandles)
            .eq('status', 'dm_sent')
            .limit(threadHandles.length);
          if (actionableLeads && actionableLeads.length > 0) {
            for (const thread of allInboxThreads) {
              const match = actionableLeads.find(l => l.ig_handle.toLowerCase() === thread.username.toLowerCase());
              if (match) {
                 // Check if lead is at terminal step before adding to queue
                 if (match.conversation_step >= TERMINAL_STEP) {
                   log('info', 'AI', `@${thread.username} at terminal step (${match.conversation_step}) — skipping`);
                 } else {
                   threads.push({
                     threadId: thread.threadId,
                     username: thread.username,
                     lastMessage: thread.lastMessage || '',
                     _source: 'inbox_api',
                     viewerId: thread.viewerId,
                     lastSenderId: thread.lastSenderId
                   });
                   log('info', 'AI', `@${thread.username} queued`);
                 }
               }
             }
           }
         }
       }
     }
   } catch (e) {
     log('warn', 'AI', `Inbox scan failed: ${e.message} — continuing`);
   }

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
          for (const t of newDomThreads) {
            if (!t.username) continue;
            try {
            let { data: existingLead } = await supabase.from('leads')
              .select('id, ig_handle, status')
              .eq('workspace_id', workspaceId)
              .eq('ig_handle', t.username.toLowerCase())
              .maybeSingle();
            
            if (!existingLead) {
              const { data: newLead } = await supabase.from('leads').insert({
                workspace_id: workspaceId,
                ig_handle: t.username.toLowerCase(),
                status: 'replied',
                source: 'inbound_dm',
                last_updated_at: new Date().toISOString()
              }).select('id, ig_handle, status').single();
              if (newLead) existingLead = newLead;
             }
             
             // Only add thread to reply queue if lead is NOT at terminal step
             const skipIfTerminal = existingLead && existingLead.conversation_step >= TERMINAL_STEP;
             if (!skipIfTerminal) {
               threads.push({
                 threadId: t.threadId,
                 username: t.username,
                 lastMessage: '',
                 isUnread: true,
                 _source: 'dom_scan'
               });
               log('info', 'AI', `@${t.username} queued`);
             } else {
               log('info', 'AI', `@${t.username} at terminal step (${existingLead.conversation_step}) — skipping (DOM)`);
             }
             } catch (e) {
               log('warn', 'DOM_SCAN', `Failed processing @${t.username}: ${e.message}`);
             }
           }
         } else {
           // STANDARD MODE: Only process threads that match leads Jani did outreach to (dm_sent)
           const domHandles = [...new Set(newDomThreads.map(t => (t.username || '').toLowerCase()).filter(Boolean))];
           if (domHandles.length > 0) {
             const { data: actionableLeads } = await supabase.from('leads')
               .select('id, ig_handle, status')
               .eq('workspace_id', workspaceId)
               .in('ig_handle', domHandles)
               .eq('status', 'dm_sent')
               .limit(domHandles.length);
             if (actionableLeads && actionableLeads.length > 0) {
               for (const t of newDomThreads) {
                 const match = actionableLeads.find(l =>
                   l.ig_handle.toLowerCase() === (t.username || '').toLowerCase()
                 );
                 if (match) {
                   if (match.status !== 'replied') {
                     await supabase.from('leads').update({
                       status: 'replied',
                       last_updated_at: new Date().toISOString()
                     }).eq('id', match.id);
                     log('success', 'AI_REPLY_DETECT', `@${match.ig_handle} replied — tagged as replied (DOM)`);
                   }
                    // Check if lead is at terminal step before adding to queue
                     if (match.conversation_step >= TERMINAL_STEP) {
                       log('info', 'AI', `@${match.ig_handle} at terminal step (${match.conversation_step}) — skipping (DOM)`);
                     } else {
                       threads.push({
                        threadId: t.threadId,
                        username: match.ig_handle,
                        lastMessage: '',
                        isUnread: true,
                        _source: 'dom_scan'
                      });
                     log('info', 'AI', `@${match.ig_handle} queued`);
                   }
                 }
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

  // CROSS-PULSE DEDUP: skip usernames we already replied to this session
  // Prevents re-processing the same people every pulse
  const beforeCrossPulse = threads.length;
  const threadsAfterCrossPulse = threads.filter(t => {
    if (t.username && repliedUsernames.has(t.username.toLowerCase())) {
      log('info', 'DEDUP', `@${t.username}: already replied this session — skipping`);
      return false;
    }
    return true;
  });
  if (threadsAfterCrossPulse.length < beforeCrossPulse) {
    log('info', 'DEDUP', `${beforeCrossPulse - threadsAfterCrossPulse.length} thread(s) skipped by cross-pulse dedup`);
  }
  threads.length = 0;
  threads.push(...threadsAfterCrossPulse);

  // PERSISTENT CROSS-PULSE DEDUP: skip threads already processed in prior pulses
  const beforePersistDedup = threads.length;
  const threadsAfterPersist = threads.filter(t => {
    if (t.threadId && processedThreads.has(t.threadId)) {
      log('info', 'DEDUP', `@${t.username}: already processed in prior pulse — skipping`);
      return false;
    }
    return true;
  });
  if (threadsAfterPersist.length < beforePersistDedup) {
    log('info', 'DEDUP', `${beforePersistDedup - threadsAfterPersist.length} thread(s) skipped by persistent cross-pulse dedup`);
  }
  threads.length = 0;
  threads.push(...threadsAfterPersist);

  // OUTBOX COOLDOWN: batch-check which leads we recently messaged without a reply
  // Prevents spamming people with multiple messages in a row
  const DM_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
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

        // Build set of leads we recently messaged (regardless of reply status)
        // If we sent a DM within 24h, don't send another — period.
        const cooldownLeadIds = new Set();
        if (recentOutbox) {
          for (const leadId of leadIds) {
            const entry = recentOutbox.find(o => o.lead_id === leadId);
            if (entry && entry.sent_at) {
              const sentAt = new Date(entry.sent_at).getTime();
              const theyReplied = entry.incoming_message && entry.incoming_message.trim().length > 0; // Did they send a message that triggered our latest reply?

              // Apply cooldown ONLY if WE sent the last message (they haven't replied to our latest DM)
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
            // If last message is from THEM, they've replied — skip cooldown
            if (t.lastSenderId && t.viewerId && t.lastSenderId !== t.viewerId) {
              log('info', 'DM_COOLDOWN', `@${t.username}: cooldown active but they replied (lastSenderId:${t.lastSenderId}) — allowing`);
              return true;
            }
            log('info', 'DM_COOLDOWN', `@${t.username}: recently messaged, no reply — skipping`);
            return false;
          }
          return true;
        });

        if (threadsWithCooldown.length < threadsBefore) {
          log('info', 'DM_COOLDOWN', `${threadsBefore - threadsWithCooldown.length} thread(s) skipped by 24h DM cooldown`);
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

  for (const thread of threads) {
    const detail = { username: thread.username, threadId: thread.threadId, action: 'pending', reply: '', intent: '', error: '' };
    threadDetails.push(detail);
    if (repliedThreads.has(thread.threadId)) { detail.action = 'skipped_duplicate'; log('info', 'DEDUP', `@${thread.username}: thread already replied this pulse (threadId:${thread.threadId}) — skipping`); continue; }
    // Persistent dedup: skip threads we already processed in a prior pulse
    if (processedThreads.has(thread.threadId)) {
      detail.action = 'skipped_already_processed';
      log('info', 'DEDUP', `@${thread.username}: already processed in prior pulse — skipping`);
      continue;
    }
    if (threadsReplied >= maxRepliesPerPulse) {
      detail.action = 'rate_limited';
      log('info', 'AI_RATE', `Pulse cap reached (${maxRepliesPerPulse}) — stopping. ${threadsFound - threads.length} thread(s) deferred.`);
      break;
    }
    if (geminiQuotaExhausted) { detail.action = 'skipped_quota'; log('info', 'GEMINI', 'Quota exhausted — stopping all remaining threads'); break; }

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
    if (!messages || messages.length === 0) {
      // API fetch failed — fall back to lastMessage from inbox scan
      // Use viewerId + lastSenderId to determine who sent the last message
      const isOwnMsg = thread.lastSenderId && thread.viewerId && thread.lastSenderId === thread.viewerId;
      if (thread.lastMessage) {
        messages = [{ text: thread.lastMessage, isMe: isOwnMsg, timestamp: Date.now() }];
        log('info', 'AI', `@${thread.username}: using inbox lastMessage fallback (isMe: ${isOwnMsg})`);
      } else {
        // Try DOM navigation fallback for ANY source (dom_scan, inbox_api, etc.)
        try {
          await page.goto(`https://www.instagram.com/direct/t/${thread.threadId}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await delay(3000);
          const lastText = await page.evaluate(() => {
            const items = document.querySelectorAll('div[role="row"]');
            if (items.length === 0) return '';
            const last = items[items.length - 1];
            return (last.querySelector('div[dir="auto"]') || last).textContent.trim();
          }).catch(() => '');
          if (lastText) {
            messages = [{ text: lastText, isMe: false, timestamp: Date.now() }];
            log('info', 'AI', `@${thread.username}: using DOM thread fallback ("${lastText.substring(0, 60)}")`);
          }
        } catch (e) {}
        if (!messages || messages.length === 0) {
          detail.action = 'thread_gone';
          // Silent — counted in summary
          markThreadProcessed(thread.threadId);
          persistProcessedThreads();
          continue;
        }
      }
    }

    // Fetch lead data early — needed by both auto-responder check and email capture
    let leadId = null;
    let lead = null;
    try {
      const { data: l } = await supabase.from('leads').select('id, status, followup_step, conversation_step, conversation_data, bio, full_name, follower_count, email, first_name').eq('ig_handle', thread.username.toLowerCase()).limit(1).maybeSingle();
      if (l) { lead = l; leadId = l.id; }
    } catch (e) {}

    const lastMsg = messages[messages.length - 1];

    // --- AGE FILTER: skip threads where the relevant message is older than 6 months ---
    const MAX_MSG_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 6 months
    const MIN_VALID_TS = 1000000000000; // Jan 2001 — anything before this is garbage/epoch0
    {
      let relevantTs = null;
      if (lastMsg && lastMsg.timestamp) {
        // Instagram timestamps are in microseconds — convert to ms if needed
        let tsMs = lastMsg.timestamp > 1e12 ? lastMsg.timestamp / 1000 : lastMsg.timestamp;
        tsMs = Number(tsMs); // Ensure numeric
        if (!tsMs || tsMs < MIN_VALID_TS) tsMs = null; // Reject epoch0 / garbage timestamps
        const isRequestThread = thread._source === 'requests_api' || thread._source === 'hidden_requests_dom' || thread._source === 'requests_dom' || thread._source === 'hidden_dom';
        if (lastMsg.isMe && isRequestThread) {
          // Request thread: last msg is our DM — check their last message instead
          for (let i = messages.length - 1; i >= 0; i--) {
            if (!messages[i].isMe && messages[i].timestamp) {
              let rts = messages[i].timestamp > 1e12 ? messages[i].timestamp / 1000 : messages[i].timestamp;
              rts = Number(rts);
              if (rts && rts >= MIN_VALID_TS) { relevantTs = rts; break; }
            }
          }
        } else if (!lastMsg.isMe && tsMs) {
          relevantTs = tsMs;
        }
      }
      if (relevantTs && (Date.now() - relevantTs) > MAX_MSG_AGE_MS) {
        repliedThreads.add(thread.threadId);
        markThreadProcessed(thread.threadId);
          persistProcessedThreads();
        detail.action = 'skipped_old_message';
        const ageDays = Math.round((Date.now() - relevantTs) / (24 * 60 * 60 * 1000));
        log('info', 'AGE_FILTER', `@${thread.username}: last message ${ageDays} days old (>180 days) — skipping`);
        continue;
      }
    }

    // Skool link dedup guard — don't send the same link twice
    if (lead && lead.conversation_step && lead.conversation_step >= TERMINAL_STEP) {
      repliedThreads.add(thread.threadId);
      markThreadProcessed(thread.threadId);
          persistProcessedThreads();
      detail.action = 'already_terminal';
      log('info', 'AI_DEDUP', `@${thread.username} already at terminal step — skipping`);
      continue;
    }

    // Check for manual override (!) — if ANY of our sent messages ends with "!", AI stops replying.
    // This must run regardless of who sent the last message, so it catches Jani jumping in mid-thread.
    const ourMessages = messages.filter(m => m.isMe && m.text).map(m => m.text.trim());
    const hasManualOverride = ourMessages.some(t => t.endsWith('!'));
    if (hasManualOverride && lead) {
      try { await supabase.from('leads').update({
        conversation_step: TERMINAL_STEP,
        followup_step: 99,
        last_updated_at: new Date().toISOString()
      }).eq('id', lead.id); } catch (e) {}
      repliedThreads.add(thread.threadId);
      markThreadProcessed(thread.threadId);
      persistProcessedThreads();
      detail.action = 'manual_override';
      log('info', 'AI', `@${thread.username}: manual override detected (! in sent msg) — setting terminal step`);
      continue;
    }

    if (lastMsg.isMe) {
      // Debug: show why isMe is true
      const debugLastText = (lastMsg.text || '').substring(0, 40);
      const debugLastSenderId = thread.lastSenderId;
      const debugViewerId = thread.viewerId;
      log('debug', 'SKIP_ISME', `@${thread.username} lastSenderId:${debugLastSenderId} viewerId:${debugViewerId} lastText:"${debugLastText}"`);
      // Instagram's API item.user_id is unreliable — it often attributes the other person's
      // last message to us (viewer_id), causing false isMe.
      // - If thread is READ → skip (other person saw our reply, isMe is likely correct)
      // - If thread is UNREAD → process (isMe is a false positive — they replied after our DM)
      const isUnread = thread.isUnread !== false; // undefined/true = unread, false = read
      const shouldSkip = !isUnread;

      if (!shouldSkip) {
        // Unread thread — isMe is a false positive from unreliable API, treat as reply
        log('info', 'AI', `@${thread.username}: isMe=true but unread — treating as reply (API user_id unreliable)`);
      } else {
        repliedThreads.add(thread.threadId);
        markThreadProcessed(thread.threadId);
          persistProcessedThreads();
        detail.action = 'skipped_last_from_me';
        log('info', 'AI', `@${thread.username}: last msg is from us — skipping (alreadyReplied:${!!alreadyReplied} isUnread:${isUnread})`);
        continue;
      }
    }

    // --- STORY REACTIONS / STICKERS / MEDIA: skip (no auto-reply) ---
    const lastItemType = lastMsg.itemType || 'text';
    const isEmptyText = !(lastMsg.text || '').trim();
    const isNonConversation = lastItemType === 'story_reaction' || lastItemType === 'story_share' || lastItemType === 'reel_share' || lastItemType === 'media' || lastItemType === 'raven_media' || lastItemType === 'animated_media' || lastItemType === 'sticker' || lastItemType === 'link' || lastItemType === 'action_log' || isEmptyText;
    if (isNonConversation) {
      repliedThreads.add(thread.threadId);
      markThreadProcessed(thread.threadId);
          persistProcessedThreads();
      detail.action = 'skipped_reaction';
      log('info', 'AI_REACTION_SKIP', `@${thread.username}: skipping non-conversation item (type: ${lastItemType}, isEmptyText: ${isEmptyText})`);
      continue;
    }

    const lastIncoming = sanitizeInput(lastMsg.text || '');
    if (isAutoResponder(lastIncoming, messages)) {
      detail.action = 'auto_responder';
      log('warn', 'AI_AUTO_RESPONDER', `@${thread.username} sent auto-responder — stopping outreach`);
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

    // Handoff decisions are handled by the AI via training context — no hardcoded keyword bypass

    // PRE-GEMINI HANDOFF: Check incoming message for WhatsApp/Telegram keywords BEFORE calling Gemini (gated by config)
    const preHandoffRe = /\b(whatsapp|telegram|wa\b|phone|number|text me|dm me|personal chat|one.on.one)\b/i;
    if (config.whatsappHandoffEnabled && preHandoffRe.test(lastIncoming)) {
      // Generate a short reply acknowledging, then hand off
      const ackReplies = [
        "Of course, one moment.",
        "Sure, let me grab that for you.",
        "Got it, give me a sec.",
        "Sure thing, I'll send that over."
      ];
      const ackReply = ackReplies[Math.floor(Math.random() * ackReplies.length)];
      const sent = await sendReplyViaPhysical(page, thread.threadId, ackReply, thread.username);
      if (sent) {
        threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
        repliedThreads.add(thread.threadId);
        detail.action = 'handoff_whatsapp';
        detail.intent = 'handoff_whatsapp';
        detail.reply = ackReply;
        sendTelegram(config, `📱 <b>WhatsApp handoff</b> — @${thread.username}\n"${lastIncoming}"\n\nReply: "${ackReply}"`);
        log('success', 'AI', `@${thread.username} → WhatsApp handoff (notified)`);
        if (lead) {
          await supabase.from('leads').update({ status: 'replied', conversation_step: TERMINAL_STEP, followup_step: 99, last_updated_at: new Date().toISOString() }).eq('id', lead.id);
        }
        try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: leadId, message: ackReply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
      }
      await delay(10000 + Math.random() * 15000);
      continue;
    }

    // Build conversation context for AI
    // Cap conversation to last 8 messages to save tokens (long threads waste Gemini quota)
    const cappedMessages = messages.slice(-8);
    let conversation = cappedMessages.map(m => {
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

    // --- EMAIL CAPTURE FLOW ---
    // Check if lead is in email capture mode
    if (lead && lead.conversation_step >= EMAIL_CAPTURE_STEP.ASKING_EMAIL && lead.conversation_step < EMAIL_CAPTURE_STEP.DELIVERED) {
      // Lead is in email capture flow
      if (lead.conversation_step === EMAIL_CAPTURE_STEP.ASKING_EMAIL) {
        if (isNegativeReply(lastIncoming)) {
          await supabase.from('leads').update({
            status: 'replied',
            followup_step: 99,
            conversation_step: TERMINAL_STEP,
            last_updated_at: new Date().toISOString()
          }).eq('id', lead.id);
          log('success', 'AI', `Marked @${thread.username} as uninterested at email step`);
          detail.action = 'closed_lost_email';
          await delay(10000 + Math.random() * 15000);
          continue;
        }
        const email = extractEmail(lastIncoming);
        if (email) {
          // Valid email received, ask for name
          await supabase.from('leads').update({
            email: email,
            conversation_step: EMAIL_CAPTURE_STEP.ASKING_NAME,
            last_updated_at: new Date().toISOString()
          }).eq('id', lead.id);
          const reply = config.emailCaptureAskNameMsg || "Got it. And your first name?";
          const sent = await sendReplyViaPhysical(page, thread.threadId, reply, thread.username);
          if (sent) {
            threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
            repliedThreads.add(thread.threadId);
            detail.action = 'capture_ask_name';
            detail.reply = reply;
            try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: reply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
            log('success', 'AI', `Asked name from @${thread.username} after email ${email}`);
          }
        } else {
          // Check if lead is refusing email but still wants the link
          const refusePrompt = `The lead was asked for their email but replied with: "${lastIncoming}"

Does the lead show clear interest in receiving the framework/link but explicitly REFUSE to share their email? Reply ONLY "YES" or "NO".`;
          const refuseCheck = await callGemini(apiKey, refusePrompt).catch(() => '');
          const isRefusing = refuseCheck && /^YES/i.test(refuseCheck.trim());

          if (isRefusing) {
            // Skip email capture — deliver framework link directly
            const firstName = (lead.first_name || conversation.match(/Name: (\S+)/)?.[1] || 'there').trim();
            const finalLink = frameworkLink;
            const reply = finalLink
              ? (config.emailCaptureSkipMsg ? config.emailCaptureSkipMsg.replace('{{link}}', finalLink) : `All good! Here's the link if you want to grab it now instead: ${finalLink}`)
              : "All good! Feel free to reach out if you have any questions.";
            const sent = await sendReplyViaPhysical(page, thread.threadId, reply, thread.username);
            if (sent) {
              threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
              repliedThreads.add(thread.threadId);
              detail.action = 'capture_skip_email';
              detail.reply = reply;
              await supabase.from('leads').update({
                first_name: firstName !== 'there' ? firstName : lead.first_name,
                conversation_step: TERMINAL_STEP,
                followup_step: 0,
                status: 'replied',
                last_updated_at: new Date().toISOString()
              }).eq('id', lead.id);
              try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: reply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
              log('success', 'AI', `Skipped email capture for @${thread.username} — sent link directly`);
            }
          } else {
            // Invalid or no email, ask again
            const reply = config.emailCaptureRetryMsg || "No worries, just drop your best email and I'll send it right over.";
            const sent = await sendReplyViaPhysical(page, thread.threadId, reply, thread.username);
            if (sent) {
              threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
              repliedThreads.add(thread.threadId);
              detail.action = 'capture_ask_email_retry';
              detail.reply = reply;
              try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: reply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
              log('info', 'AI', `Retry asking email from @${thread.username}`);
            }
          }
        }
        await delay(10000 + Math.random() * 15000);
        continue;
      }

      if (lead.conversation_step === EMAIL_CAPTURE_STEP.ASKING_NAME) {
        if (isNegativeReply(lastIncoming)) {
          await supabase.from('leads').update({
            status: 'replied',
            followup_step: 99,
            conversation_step: TERMINAL_STEP,
            last_updated_at: new Date().toISOString()
          }).eq('id', lead.id);
          log('success', 'AI', `Marked @${thread.username} as uninterested at name step`);
          detail.action = 'closed_lost_name';
          await delay(10000 + Math.random() * 15000);
          continue;
        }
        const firstName = lastIncoming.trim().split(/\s+/)[0]; // Take first word as name
        const finalLink = frameworkLink;
        const deliveryMsg = config.emailCaptureDeliveryMsg || `Thanks ${firstName}! Framework is on its way to your inbox \u2014 should land in the next few minutes. Here's the link just in case: ${finalLink}`;
        const reply = finalLink
          ? deliveryMsg.replace(/\{\{firstName\}\}/g, firstName).replace(/\{\{link\}\}/g, finalLink).replace(/\$\{firstName\}/g, firstName).replace(/\$\{link\}/g, finalLink)
          : (config.emailCaptureDeliveryMsg ? config.emailCaptureDeliveryMsg.replace(/\{\{firstName\}\}/g, firstName).replace(/\$\{firstName\}/g, firstName) : `Thanks ${firstName}! Framework is on its way to your inbox \u2014 should land in the next few minutes.`);
        const sent = await sendReplyViaPhysical(page, thread.threadId, reply, thread.username);
        if (sent) {
          threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
          repliedThreads.add(thread.threadId);
          detail.action = 'capture_delivered';
          detail.reply = reply;

          // Update lead as delivered — persist email if not already saved
          const capturedEmail = lead.email || extractEmail(conversation) || extractEmail(lastIncoming);
          await supabase.from('leads').update({
            first_name: firstName,
            email: capturedEmail || lead.email,
            conversation_step: TERMINAL_STEP,
            followup_step: 0,
            status: 'replied',
            last_updated_at: new Date().toISOString()
          }).eq('id', lead.id);

          // AWeber API call
          if (config.aweberAccessToken && config.aweberListId) {
            const baseTags = (config.aweberTag || '').split(',').map(t => t.trim()).filter(Boolean);
            const aweberOk = await addAWeberSubscriber(
              supabase, workspaceId,
              config.aweberAccessToken, config.aweberRefreshToken,
              config.aweberClientId, config.aweberClientSecret,
              config.aweberListId, baseTags,
              capturedEmail, firstName
            );
            await supabase.from('leads').update({ aweber_status: aweberOk ? 'added' : 'failed', last_updated_at: new Date().toISOString() }).eq('id', lead.id);
            if (aweberOk) {
              detail.intent = 'aweber_added';
            } else {
              detail.intent = 'aweber_failed';
            }
          } else {
            log('warn', 'AWEBER', `No access token or list ID configured — skipping AWeber for @${thread.username}`);
          }

          try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: reply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
          log('success', 'AI', `Delivered framework to @${thread.username} (${firstName}, ${capturedEmail || 'no email'})`);
        }
        await delay(10000 + Math.random() * 15000);
        continue;
      }
    }

    // --- EMAIL+NAME SAFETY NET (conversation flow / any path) ---
    const deliveredUnified = await tryDeliverCapturedInfo(thread, cappedMessages, lead);
    if (deliveredUnified) {
      detail.action = 'capture_delivered_safety';
      detail.intent = 'aweber_added';
      continue;
    }

    // --- OF USERNAME CAPTURE FLOW (Olive-only, gated by config) ---
    // After OF link shared → detect "subscribed" → ask for username → store → cooldown
    if (config.ofUsernameCaptureEnabled && lead && lead.conversation_step >= OF_USERNAME_STEP.ASKING_USERNAME && lead.conversation_step < OF_USERNAME_STEP.USERNAME_RECEIVED) {
      const subscribedKeywords = /\b(subscri|sub\b|subbed|already sub|joined|on it|just sub|got it|done|bought|paid)\b/i;
      const isSubscribed = subscribedKeywords.test(lastIncoming);
      
      if (lead.conversation_step === OF_USERNAME_STEP.ASKING_USERNAME && isSubscribed) {
        // They said they subscribed — ask for their OF username
        const askReplies = [
          `That's great! What's your username on there so I can give you a shoutout?`,
          `Awesome, thank you! What's your OF username? I'd love to feature you.`,
          `Love that! Drop your username and I'll hook you up with a shoutout.`,
          `Thank you so much! What's your username? I want to show you some love.`
        ];
        const askReply = askReplies[Math.floor(Math.random() * askReplies.length)];
        const sent = await sendReplyViaPhysical(page, thread.threadId, askReply, thread.username);
        if (sent) {
          threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
          repliedThreads.add(thread.threadId);
          detail.action = 'of_ask_username';
          detail.reply = askReply;
          await supabase.from('leads').update({ conversation_step: OF_USERNAME_STEP.ASKING_USERNAME, last_updated_at: new Date().toISOString() }).eq('id', lead.id);
          try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: askReply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
          log('success', 'AI', `Asked @${thread.username} for OF username`);
        }
        await delay(10000 + Math.random() * 15000);
        continue;
      }
      
      // Check if they shared a username (explicit patterns only)
      if (lead.conversation_step === OF_USERNAME_STEP.ASKING_USERNAME) {
        const usernameMatch = lastIncoming.match(/(?:my username is|my of is|my onlyfans is|@\s*)([a-zA-Z0-9._]{3,30})/i);
        if (usernameMatch && !isSubscribed) {
          const ofUsername = usernameMatch[1];
          // Store the username in conversation_data
          const conversationData = lead.conversation_data || {};
          conversationData.of_username = ofUsername;
          conversationData.of_username_captured_at = new Date().toISOString();
          
          // Set cooldown: terminal step + timestamp
          const cooldownDays = config.ofCooldownDays || OF_COOLDOWN_DAYS_DEFAULT;
          const cooldownUntil = new Date(Date.now() + cooldownDays * 24 * 60 * 60 * 1000).toISOString();
          conversationData.cooldown_until = cooldownUntil;
          
          await supabase.from('leads').update({
            status: 'replied',
            conversation_step: OF_USERNAME_STEP.USERNAME_RECEIVED,
            conversation_data: conversationData,
            last_updated_at: new Date().toISOString()
          }).eq('id', lead.id);
          
          // Send confirmation
          const confirmReplies = [
            `@${ofUsername} — got it! Giving you a shoutout now.`,
            `@${ofUsername}, thank you! I'll feature you.`,
            `@${ofUsername} — appreciate the support, shoutout coming your way.`,
            `@${ofUsername}, thank you so much! I'll make sure to shout you out.`
          ];
          const confirmReply = confirmReplies[Math.floor(Math.random() * confirmReplies.length)];
          const sent = await sendReplyViaPhysical(page, thread.threadId, confirmReply, thread.username);
          if (sent) {
            threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
            repliedThreads.add(thread.threadId);
            detail.action = 'of_username_captured';
            detail.reply = confirmReply;
            try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: confirmReply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
          }
          
          log('success', 'AI', `Captured OF username @${ofUsername} from @${thread.username} — ${cooldownDays} day cooldown`);
          
          await delay(10000 + Math.random() * 15000);
          continue;
        }

        // If no username captured and not a negative reply, revert to general conversation
        // so AI can continue building rapport or re-introduce OF later
        log('info', 'AI', `@${thread.username} at OF_ASKING_USERNAME but no username found. Reverting to general conversation.`);
        await supabase.from('leads').update({
          conversation_step: 1, // Revert to initial funnel step
          last_updated_at: new Date().toISOString()
        }).eq('id', lead.id);
        await delay(5000); // Small delay to ensure DB update propagates
        // DO NOT continue here. Let the normal funnel/simple reply logic run for this pulse.
      }
    }
    
    // Check 45-day cooldown — skip if still in cooldown
    if (lead && lead.conversation_step >= OF_USERNAME_STEP.USERNAME_RECEIVED) {
      const conversationData = lead.conversation_data || {};
      if (conversationData.cooldown_until) {
        const cooldownEnd = new Date(conversationData.cooldown_until);
        if (new Date() < cooldownEnd) {
          // Still in cooldown — skip
          const daysLeft = Math.ceil((cooldownEnd - new Date()) / (24 * 60 * 60 * 1000));
          log('info', 'AI', `@${thread.username} in OF cooldown — ${daysLeft} days left`);
          detail.action = 'of_cooldown';
          continue;
        } else {
          // Cooldown expired — reset to terminal so they can be re-engaged
          await supabase.from('leads').update({
            conversation_step: TERMINAL_STEP,
            last_updated_at: new Date().toISOString()
          }).eq('id', lead.id);
          log('info', 'AI', `@${thread.username} OF cooldown expired — ready for re-engagement`);
        }
      }
    }

    // --- EMAIL CAPTURE TRIGGER (fallback: only when conversation flow is disabled) ---
    // When conversationEnabled is true, the conversation steps handle email capture naturally.
    // This rigid funnel is only for workspaces that don't use the conversation flow.
    if (emailCaptureEnabled && !conversationEnabled && lead && lead.conversation_step < EMAIL_CAPTURE_STEP.ASKING_EMAIL) {
      if (isPositiveReply(lastIncoming)) {
        if (lead.conversation_step < EMAIL_CAPTURE_STEP.ASK_CONFIRM) {
        // Step 1: Confirm interest
        await supabase.from('leads').update({
          conversation_step: EMAIL_CAPTURE_STEP.ASK_CONFIRM,
          status: 'replied',
          last_updated_at: new Date().toISOString()
        }).eq('id', lead.id);
        const reply = config.emailCaptureConfirmMsg || "Awesome! I put together a free framework that breaks down the exact structure I used to rebuild after hitting absolute rock bottom. It's not motivational fluff \u2014 it's the actual operating system. Want me to send it over?";
        const sent = await sendReplyViaPhysical(page, thread.threadId, reply, thread.username);
        if (sent) {
          threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
          repliedThreads.add(thread.threadId);
          detail.action = 'capture_ask_confirm';
          detail.reply = reply;
          try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: reply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
          log('success', 'AI', `Asked @${thread.username} to confirm interest`);
        }
      } else {
        // Step 2: Ask for email
        await supabase.from('leads').update({
          conversation_step: EMAIL_CAPTURE_STEP.ASKING_EMAIL,
          status: 'replied',
          last_updated_at: new Date().toISOString()
        }).eq('id', lead.id);
        const reply = config.emailCaptureAskEmailMsg || "Perfect! What email should I send the framework to?";
        const sent = await sendReplyViaPhysical(page, thread.threadId, reply, thread.username);
        if (sent) {
          threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
          repliedThreads.add(thread.threadId);
          detail.action = 'capture_ask_email';
          detail.reply = reply;
          try { await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: reply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }); } catch (e) {}
          log('success', 'AI', `Triggered email capture for @${thread.username}`);
        }
      }
      await delay(10000 + Math.random() * 15000);
      continue;
    } else if (isNegativeReply(lastIncoming)) {
      await supabase.from('leads').update({
        status: 'replied',
        followup_step: 99,
        conversation_step: TERMINAL_STEP,
        last_updated_at: new Date().toISOString()
      }).eq('id', lead.id);
      log('success', 'AI', `Marked @${thread.username} as uninterested (step=99)`);
      detail.action = 'closed_lost_capture';
      await delay(10000 + Math.random() * 15000);
      continue;
    }
  }

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
      let reply;
      try {
        reply = await callGemini(apiKey, prompt, 3, sanitizeForGemini(systemPrompt) + CONSERVATIVE_TONE);
      } catch (e) {
        if (e.quotaExhausted) { geminiQuotaExhausted = true; log('warn', 'GEMINI', 'Quota exhausted — skipping all remaining threads this pulse'); }
        continue;
      }
      if (!reply) { log('warn', 'AI_NO_REPLY', `Gemini returned no reply for @${thread.username}`); continue; }

      detail.reply = reply.substring(0, 200);
      const sent = await sendReplyViaPhysical(page, thread.threadId, reply, thread.username);
      if (sent) {
        threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
        repliedThreads.add(thread.threadId);
        detail.action = 'replied_simple';

        // WhatsApp/Telegram handoff detection (gated by config)
        const incoming = (lastIncoming || '').toLowerCase();
        const replyText = reply.toLowerCase();
        const isWhatsAppMention = config.whatsappHandoffEnabled && (/\b(whatsapp|telegram|wa\b|phone|number|text me|dm me|personal chat|one.on.one)\b/i.test(incoming) || /\b(whatsapp|telegram|wa\b|phone|number|text me|dm me|personal chat|one.on.one)\b/i.test(replyText));
        if (isWhatsAppMention) {
          detail.action = 'handoff_whatsapp';
          detail.intent = 'handoff_whatsapp';
          sendTelegram(config, `📱 <b>WhatsApp handoff</b> — @${thread.username}\n"${lastIncoming}"\n\nReply: "${reply.substring(0, 150)}"`);
          log('success', 'AI', `@${thread.username} → WhatsApp handoff (notified)`);
          if (lead) {
            await supabase.from('leads').update({ status: 'replied', conversation_step: TERMINAL_STEP, followup_step: 99, last_updated_at: new Date().toISOString() }).eq('id', lead.id);
          }
        }

        if (lead && !isWhatsAppMention) {
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
        
        // Post-reply OF link detection — if AI included the OF link, track it
        if (lead && calendlyLink && reply.includes(calendlyLink)) {
          const conversationData = lead.conversation_data || {};
          conversationData.of_link_shared_count = (conversationData.of_link_shared_count || 0) + 1;
          conversationData.of_link_shared_at = new Date().toISOString();
          conversationData.of_link_shared_last = lastIncoming;
          await supabase.from('leads').update({ conversation_data: conversationData, conversation_step: OF_USERNAME_STEP.ASKING_USERNAME, last_updated_at: new Date().toISOString() }).eq('id', lead.id);
          log('success', 'AI', `@${thread.username} → OF link shared by AI (${conversationData.of_link_shared_count}/2)`);
        }
        
        log('success', 'AI', `Replied to @${thread.username}: "${reply.substring(0, 80)}"`);
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
    if (convoStep === routeStep) {
      // Language filter — skip before Gemini to save tokens
      const allTheirTextRoute = messages.filter(m => !m.isMe && m.text).map(m => m.text).join(' ');
      if (!isAllowedLanguage(allTheirTextRoute)) {
        log('info', 'ROUTE', `@${thread.username}: blocked language — skipping routing`);
        markThreadProcessed(thread.threadId);
        persistProcessedThreads();
        continue;
      }
      // Let the AI reply naturally using the training context's own stage guidance.
      // The training context already tells the AI what to do at each stage
      // (STAGE 6 = offer call, STAGE 7 = send calendly, etc.).
      // We infer the route from the reply content.
      const routeShareableLink = config.frameworkLink || calendlyLink || '';
      const routeLinkLine = routeShareableLink ? '\nIMPORTANT: When you share your link, use this EXACT URL: ' + routeShareableLink : '';
      const routeRaw = 'Conversation history with @' + thread.username + ':\n' + conversation + '\n\nTheir latest message: "' + lastIncoming + '"' + routeLinkLine + '\n\nReply naturally to their message. Write SHORT \u2014 1-2 sentences max, one continuous line, no line breaks. Match the tone and speaking style from the business context above. Never reveal you\'re following a script. NEVER ask for their name \u2014 you already know it. Only share your link if they explicitly ask for it or the conversation naturally leads to it. Never proactively drop the link.';
      const routePrompt = sanitizeForGemini(routeRaw);

      let routeSysInst = trainingContext ? sanitizeForGemini(trainingContext) : null;
      if (routeSysInst && calendlyLink) {
        routeSysInst += `\n\nCRITICAL: Your actual page link is: ${calendlyLink}. When sharing your page, you MUST use this exact URL. Do NOT make up or guess URLs. Do NOT write "myexclusivepage.com" or any other fake URL. Say "if you want to know more about me you can find it here" or "check me out here" — do NOT say "exclusive page" or "website".`;
      }
      routeSysInst = (routeSysInst || '') + CONSERVATIVE_TONE;
      let reply;
      try {
        reply = await callGemini(apiKey, routePrompt, 3, routeSysInst);
      } catch (e) {
        if (e.quotaExhausted) { geminiQuotaExhausted = true; log('warn', 'GEMINI', 'Quota exhausted — skipping all remaining threads this pulse'); }
        continue;
      }
      if (!reply) continue;

      const cleanReply = reply.trim();

      // Send evaluation reply first
      const sent = await sendReplyViaPhysical(page, thread.threadId, cleanReply, thread.username);
      if (sent) {
        threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
        repliedThreads.add(thread.threadId);
        await delay(2000);

        // Infer route from reply content (only if links are configured)
        const replyLower = cleanReply.toLowerCase();
        const incomingLower = (lastIncoming || '').toLowerCase();
        const isWhatsAppMention = /\b(whatsapp|telegram|wa\b|phone|number|text me|dm me|personal chat|one.on.one)\b/i.test(replyLower) || /\b(whatsapp|telegram|wa\b|phone|number|text me|dm me|personal chat|one.on.one)\b/i.test(incomingLower);
        const hasCallOffer = !isWhatsAppMention && /\b(call|book|schedule|calendly|jump on|hop on)\b/i.test(replyLower);
        const isSkoolRoute = /\b(community|free|resources|group|skool|not ready|no budget|maybe later)\b/i.test(replyLower);

        detail.intent = 'reply_sent';

        // WhatsApp/Telegram handoff — notify workspace immediately (gated by config)
        if (config.whatsappHandoffEnabled && isWhatsAppMention) {
          detail.action = 'handoff_whatsapp';
          detail.intent = 'handoff_whatsapp';
          sendTelegram(config, `📱 <b>WhatsApp handoff</b> — @${thread.username}\n"${lastIncoming}"\n\nReply: "${cleanReply.substring(0, 150)}"`);
          log('success', 'AI', `@${thread.username} → WhatsApp handoff (notified)`);
          if (lead) {
            await supabase.from('leads').update({ status: 'replied', conversation_step: TERMINAL_STEP, followup_step: 99, last_updated_at: new Date().toISOString() }).eq('id', lead.id);
          }
        } else if (hasCallOffer && !isSkoolRoute && calendlyLink) {
          // User wants a call — send Calendly link
          await sendReplyViaPhysical(page, thread.threadId, `Awesome! Let's get you booked — ${calendlyLink}`, thread.username);
          detail.action = 'routed_calendly';
          detail.intent = 'route_calendly';
          log('success', 'AI', `@${thread.username} routed to Calendly`);
        } else if (isSkoolRoute && skoolLink) {
          // User not ready — send Skool community link (only if configured)
          const sentLink = await sendReplyViaPhysical(page, thread.threadId, `No worries! Join our free community here for resources, accountability, and weekly calls: ${skoolLink}. Reach out when you're ready to go deeper!`, thread.username);
          if (sentLink) {
            threadsReplied++;
        if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
            detail.intent = 'route_skool';
            await supabase.from('leads').update({ status: 'replied', conversation_step: TERMINAL_STEP, last_updated_at: new Date().toISOString() }).eq('id', lead.id);
            await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: skoolLink, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }).then(() => {}, () => {});
            log('success', 'AI', `@${thread.username} not ready → Skool link sent`);
          }
        }
        // No link configured or no route match — conversation continues naturally

        await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: cleanReply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }).then(() => {}, () => {});
        
        // Post-reply OF link detection — if AI included the OF link, track it (Olive-only, gated by config)
        if (config.ofUsernameCaptureEnabled && lead && calendlyLink && cleanReply.includes(calendlyLink)) {
          const conversationData = lead.conversation_data || {};
          conversationData.of_link_shared_count = (conversationData.of_link_shared_count || 0) + 1;
          conversationData.of_link_shared_at = new Date().toISOString();
          conversationData.of_link_shared_last = lastIncoming;
          await supabase.from('leads').update({ conversation_data: conversationData, conversation_step: OF_USERNAME_STEP.ASKING_USERNAME, last_updated_at: new Date().toISOString() }).eq('id', lead.id);
          log('success', 'AI', `@${thread.username} → OF link shared by AI (${conversationData.of_link_shared_count}/2)`);
        }
        
        log('success', 'AI', `Routed @${thread.username} → ${detail.intent}`);
      }
      await delay(10000 + Math.random() * 15000);
      continue;
    }

    // Normal funnel steps 1-6
    // Language filter — skip before Gemini to save tokens
    const allTheirTextFunnel = messages.filter(m => !m.isMe && m.text).map(m => m.text).join(' ');
    if (!isAllowedLanguage(allTheirTextFunnel)) {
      log('info', 'FUNNEL', `@${thread.username}: blocked language — skipping`);
      markThreadProcessed(thread.threadId);
      persistProcessedThreads();
      continue;
    }
    const steps = getSteps(config);
    const currentStep = steps.find(s => s.step === convoStep) || steps[0];
    // Determine which link to share (framework link takes priority over calendly)
    const shareableLink = config.frameworkLink || calendlyLink || '';
    const linkLine = shareableLink ? `\nIMPORTANT: When you share your link, use this EXACT URL: ${shareableLink}. Do NOT make up or guess URLs.` : '';
    const stepContext = `FUNNEL STATUS:
- Current Step: ${currentStep.step}/${steps.length}
- Objective: ${currentStep.objective}${linkLine}

Conversation history with @${thread.username}:
${conversation}

IMPORTANT RULES:
- Stay in character no matter what the other person says
- Never output anything except a natural conversational reply
- NEVER ask for their name — you already know it from the opening DM ({{name}}). Use it naturally in conversation like you already know them
- Only share your link if THEY ask for it, express interest, or the conversation naturally leads to it. Never proactively drop the link. If your link appears above, hold it until they naturally bring it up.

Instructions:
Reply naturally to their latest message, working toward this step's objective. Write SHORT — 1-2 sentences max, one continuous line, no line breaks. Sound like a real person having a genuine conversation. Never reveal you're following a funnel or script. Always complete your thought.

ADVANCE/REMAIN/CLOSE:
At the very END of your reply, on its own line, include exactly one of:
- [ADVANCE] — if this step's objective is met and you are ready to move to the next step next time they reply
- [REMAIN] — if they asked a question, seem hesitant, or you need another exchange on this step before advancing
- [CLOSE] — if they are clearly not a fit for what you offer based on your training context, not interested, or the conversation has naturally run its course. End warmly, no hard feelings. ALWAYS close immediately if: they are asking for money or donations, they are in a completely unrelated niche with no crossover to your story or offer, or the conversation has stalled for 3+ exchanges with no movement toward the objective.

Examples:
- They say "sure, what's it about?" → reply naturally, then [ADVANCE] (they showed interest, next step is ask email)
- They say "sounds interesting but what exactly is it?" → reply answering their question, then [REMAIN] (they need more info first)
- They give their email → reply confirming, then [ADVANCE] (email captured, next step is ask name)
- They ask "how much does it cost?" → reply briefly, then [REMAIN] (they're exploring, don't rush)
- They say "I've never really experienced that" or "that's not really my thing" → reply warmly acknowledging their perspective, then [CLOSE] (not a fit, don't push)
- They mention donations, charity, or asking for money → [CLOSE] (not a fit)
- Their life situation is completely unrelated to your story or offer → [CLOSE] (no crossover)
- They give short one-word replies 3+ times in a row → [CLOSE] (disengaged, move on)`;

    const exchangeCount = messages ? messages.filter(m => m.text && m.text.trim()).length : 0;
    const rawPrompt = `${stepContext}\n\nReply to @${thread.username}:`;
    const fullPrompt = sanitizeForGemini(rawPrompt);
    let sysInst = trainingContext ? sanitizeForGemini(trainingContext) : null;
    // Inject actual link URL into system instruction so Gemini never makes up fake URLs
    if (sysInst && calendlyLink) {
      sysInst += `\n\nCRITICAL: Your actual page link is: ${calendlyLink}. When sharing your page, you MUST use this exact URL. Do NOT make up or guess URLs. Do NOT write "myexclusivepage.com" or any other fake URL. Say "if you want to know more about me you can find it here" or "check me out here" — do NOT say "exclusive page" or "website".`;
    }
    sysInst = (sysInst || '') + CONSERVATIVE_TONE;

    let reply;
    try {
      reply = await callGemini(apiKey, fullPrompt, 3, sysInst);
    } catch (e) {
      if (e.quotaExhausted) { geminiQuotaExhausted = true; log('warn', 'GEMINI', 'Quota exhausted — skipping all remaining threads this pulse'); }
      continue;
    }
    if (!reply) continue;

    const cleanReply = reply.replace(/\[ADVANCE\]|\[REMAIN\]/gi, '').trim();

    const sent = await sendReplyViaPhysical(page, thread.threadId, cleanReply, thread.username);
    if (sent) {
      threadsReplied++;
      if (thread.username) repliedUsernames.add(thread.username.toLowerCase());
      repliedThreads.add(thread.threadId);

      // Advance/Remain/Close based on AI markers
      const wantsAdvance = /\[ADVANCE\]/i.test(reply);
      const wantsClose = /\[CLOSE\]/i.test(reply);
      let nextStep;
      if (wantsClose) {
        nextStep = TERMINAL_STEP;
        log('ai', 'FUNNEL', `@${thread.username} — conversation closed (not a fit)`);
        detail.intent = 'closed_not_a_fit';
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
      if (wantsClose) updateData.followup_step = 99; // prevent follow-ups on closed conversations
      await supabase.from('leads').update(updateData).eq('id', lead.id);

await supabase.from('outbox').insert({ workspace_id: workspaceId, lead_id: lead.id, message: cleanReply, incoming_message: lastIncoming, status: 'auto_replied', sent_at: new Date().toISOString() }).then(() => {}, () => {});

// Post-reply OF link detection — if AI included the OF link, track it (Olive-only, gated by config)
if (config.ofUsernameCaptureEnabled && lead && calendlyLink && cleanReply.includes(calendlyLink)) {
  const conversationData = lead.conversation_data || {};
  conversationData.of_link_shared_count = (conversationData.of_link_shared_count || 0) + 1;
  conversationData.of_link_shared_at = new Date().toISOString();
  conversationData.of_link_shared_last = lastIncoming;
  await supabase.from('leads').update({ conversation_data: conversationData, conversation_step: OF_USERNAME_STEP.ASKING_USERNAME, last_updated_at: new Date().toISOString() }).eq('id', lead.id);
          log('success', 'AI', `@${thread.username} → OF link shared by AI (${conversationData.of_link_shared_count}/2)`);
}

       // Only log "route decision" if this workspace has a route destination (Calendly or Skool)
       // Some workspaces have no Calendly/Skool, so they just continue the funnel naturally
       if (nextStep === routeStep && (calendlyLink || skoolLink)) {
         log('success', 'AI', `@${thread.username} reached step ${routeStep} — route decision next cycle`);
       } else {
         log('success', 'AI', `@${thread.username} (step ${convoStep}) replied`);
       }
    } else {
      detail.action = 'send_failed';
      detail.error = 'send failed';
    }

    // Mark thread as processed (persists across pulses)
    markThreadProcessed(thread.threadId);
          persistProcessedThreads();
    await delay(10000 + Math.random() * 15000);
  }

  await logActivity(supabase, logId, workspaceId, threadsFound, threadsReplied, logErrors, threadDetails);
  persistProcessedThreads();

  // Send pulse summary to Olive
  const requests = requestReplies;
  const hidden = hiddenReplies;
  const primary = primaryReplies;
  const stepEntries = Object.entries(primaryStepDistribution).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  const summary = [
    `📊 <b>Pulse Summary</b>`,
    ``,
    `📥 Requests: ${requests} sent / ${requestAccepted} accepted`,
    `📩 Hidden: ${hidden}`,
    `💬 Primary: ${primary}`,
    ``,
    `📈 Funnel Movement:`,
    stepEntries || '  No movement',
    ``,
    `🔗 Link Shared: ${primaryLinkShared}`,
    primaryLinkSharedUsers.length > 0 ? `  Handles: ${primaryLinkSharedUsers.map(u => '@' + u).join(', ')}` : '',
  ].join('\n');
  sendTelegram(config, summary);

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
