const { chromium } = require('playwright-core');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const SESSION_PATH = path.resolve(process.cwd(), 'sessions');
const LOG_PATH = path.resolve(process.cwd(), 'engine.log');
const OUTPUT_PATH = path.resolve(process.cwd(), 'found_leads.json');
const LOCK_PATH = path.resolve(process.cwd(), '.harvester.lock');

function log(emoji, tag, msg) {
  const line = `${emoji} [${tag}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`); } catch (e) { console.error(`Log write failed: ${e.message}`); }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomDelay(min, max) { return min + Math.floor(Math.random() * (max - min)); }

async function humanPause(minSec, maxSec) { await delay(randomDelay(minSec * 1000, maxSec * 1000)); }

async function simulateScrolling(page) {
  try {
    await page.evaluate(function () {
      window.scrollBy(0, 200 + Math.floor(Math.random() * 400));
    });
    await delay(800 + Math.floor(Math.random() * 1500));
    await page.evaluate(function () {
      window.scrollBy(0, -100 - Math.floor(Math.random() * 200));
    });
    await delay(400 + Math.floor(Math.random() * 600));
  } catch (e) {}
}

async function searchFromPage(page, query, timeoutMs) {
  if (!timeoutMs) timeoutMs = 20000;
  try {
    const url = 'https://www.instagram.com/web/search/topsearch/?context=blended&query=' + encodeURIComponent(query) + '&rank_token=0.5';
    const response = await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
    if (!response || !response.ok()) {
      if (response) log('⚠️', 'SEARCH', 'HTTP ' + response.status() + ' for search');
      return null;
    }
    try {
      const body = await response.text();
      return JSON.parse(body);
    } catch (e) { return { users: [] }; }
  } catch (e) {
    log('⚠️', 'SEARCH', 'Request error: ' + (e.message || e));
    return null;
  }
}

function parseFollowers(s) {
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)(k|m)?/i);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2]?.toLowerCase() === 'k') n *= 1000;
  if (m[2]?.toLowerCase() === 'm') n *= 1000000;
  return Math.round(n);
}

async function verifySession(context) {
  const cookies = await context.cookies('https://www.instagram.com');
  return cookies.some(c => c.name === 'sessionid');
}

async function checkSessionAlive(page) {
  try {
    const cookies = await page.context().cookies('https://www.instagram.com');
    return cookies.some(function (c) { return c.name === 'sessionid' && c.value.length > 0; });
  } catch (e) { return false; }
}

/**
 * Core harvest function — reusable from engine (auto mode) or standalone harvester
 * @param {object} page - Playwright page (must be logged into IG)
 * @param {object} supabase - Supabase client
 * @param {object} config - Engine config
 * @returns {number} Number of new leads synced
 */
async function harvest(page, supabase, config) {
  const niches = config.nicheTags || ['doctor', 'medical', 'health'];
  // Rotate through 4 tag sets each cycle to avoid finding the same handles
  var rotationPath = path.resolve(process.cwd(), 'tag_rotation.json');
  var rotation = 0;
  if (fs.existsSync(rotationPath)) {
    try { rotation = JSON.parse(fs.readFileSync(rotationPath, 'utf8')).index || 0; } catch (e) {}
  }
  var tagSets = [
    ['fashion founder','beauty founder','jewelry founder','skincare founder','wellness founder','ecommerce founder','shopify founder','brand founder','lingerie founder','accessories founder','footwear founder','lifestyle founder','swimwear founder','cosmetics founder','fragrance founder','homeware founder'],
    ['fashion ceo','beauty ceo','ecom founder','brand owner','shopify store owner','fashion label founder','cosmetics brand ceo','skincare founder','jewelry brand owner','wellness founder','accessories brand ceo','lingerie brand owner','footwear brand ceo','lifestyle founder','homeware founder','fragrance founder'],
    ['founder of fashion','founder of beauty','ceo of jewelry','owner of skincare','ecom brand founder','d2c founder','founder of accessories','ceo of footwear','owner of cosmetics','founder of wellness','ceo of lingerie','founder of swimwear','owner of lifestyle brand','founder of homeware','ceo of fragrance']
  ];
  var selectedTags = tagSets[rotation % tagSets.length];
  fs.writeFileSync(rotationPath, JSON.stringify({ index: rotation + 1 }));
  log('🔵', 'HARVEST', 'Tag set #' + ((rotation % tagSets.length) + 1) + '/' + tagSets.length + ' (' + selectedTags.length + ' tags)');
  const cities = config.targetRegions || ['mumbai', 'delhi', 'bangalore', 'chennai', 'kolkata', 'hyderabad', 'pune', 'ahmedabad', 'jaipur'];

  const queries = [];
  for (const niche of selectedTags) {
    queries.push(niche);
    for (const city of cities.slice(0, 3)) {
      queries.push(`${niche} ${city}`);
    }
  }

  const uniqueQueries = [...new Set(queries)];
  log('🔵', 'HARVEST', `${uniqueQueries.length} search queries`);

  const foundHandles = new Set();
  const leads = [];
  let checked = 0;

  // Append mode: load existing leads to avoid duplicates
  function loadExistingLeads() {
    if (!fs.existsSync(OUTPUT_PATH)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
      return data.leads || [];
    } catch { return []; }
  }

  const existingLeads = loadExistingLeads();
  const existingHandles = new Set(existingLeads.map(l => l.ig_handle.toLowerCase()));
  if (existingHandles.size > 0) {
    log('🔵', 'HARVEST', `${existingHandles.size} existing leads in found_leads.json — skipping duplicates`);
  }

  const minFollowers = config.minFollowers || 100;
  // Override — keep at 100 for founder discovery
  var actualMinFollowers = Math.min(minFollowers, 100);
  const maxLeads = config.maxLeads || 100;

  let synced = 0;
  let sessionExpired = false;

  try {
    // Phase 1: Search via page.goto (appears as browser navigation)
    const HANDLES_PATH = path.resolve(process.cwd(), 'phase1_handles.json');

    // Load previously-saved handles if available (survives session expiry)
    if (fs.existsSync(HANDLES_PATH)) {
      try {
        var saved = JSON.parse(fs.readFileSync(HANDLES_PATH, 'utf8'));
        if (Array.isArray(saved) && saved.length > 0) {
          saved.forEach(function (h) { foundHandles.add(h.toLowerCase()); });
          log('🔵', 'HARVEST', 'Loaded ' + foundHandles.size + ' handles from phase1_handles.json — skipping Phase 1');
        }
      } catch (e) {}
    }

    if (foundHandles.size === 0) {
    const MAX_SEARCH_RETRIES = 3;
    const CONSECUTIVE_FAILURE_LIMIT = 8;
    let consecutiveFailures = 0;

    for (const q of uniqueQueries) {
      let data = null;

      for (let attempt = 0; attempt < MAX_SEARCH_RETRIES; attempt++) {
        data = await searchFromPage(page, q, 20000);
        if (data && data.users) break;
        await delay(Math.pow(2, attempt) * 2000);
      }

      if (data && data.users && data.users.length > 0) {
        consecutiveFailures = 0;
        for (const u of data.users) {
          const username = (u.user && u.user.username) || u.username;
          if (username) foundHandles.add(username.toLowerCase());
        }
        log('🔵', 'HARVEST', 'Search "' + q.substring(0, 30) + '": ' + data.users.length + ' users');
      } else {
        consecutiveFailures++;
        log('⚠️', 'HARVEST', 'Search failed for "' + q + '" (' + consecutiveFailures + '/' + CONSECUTIVE_FAILURE_LIMIT + ' consecutive failures)');
      }

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        log('🚫', 'HARVEST', 'Aborting Phase 1 after ' + consecutiveFailures + ' consecutive search failures');
        break;
      }

      // Quick pause between searches
      if (consecutiveFailures === 0) await humanPause(3, 8);
      else await humanPause(8, 15);

      // Every 10 queries, take a short break (20-45 seconds)
      if (consecutiveFailures === 0 && uniqueQueries.indexOf(q) > 0 && uniqueQueries.indexOf(q) % 10 === 0) {
        await humanPause(20, 45);
      }
    }
    } // end Phase 1 search

    log('🔵', 'HARVEST', `${foundHandles.size} unique handles from search`);

    // Shuffle for fresh order each run
    var shuffled = Array.from(foundHandles);
    for (var s = shuffled.length - 1; s > 0; s--) {
      var r = Math.floor(Math.random() * (s + 1));
      var tmp = shuffled[s]; shuffled[s] = shuffled[r]; shuffled[r] = tmp;
    }

    // Persist Phase 1 handles so they survive container restarts
    try {
      fs.writeFileSync(path.resolve(process.cwd(), 'phase1_handles.json'), JSON.stringify(Array.from(foundHandles), null, 2));
      log('🔵', 'HARVEST', `Saved ${foundHandles.size} handles to phase1_handles.json`);
    } catch (e) {}

    // Phase 2: Check each handle's profile (fast but human-paced)
    for (const handle of shuffled) {
      if (leads.length >= maxLeads) break;
      if (existingHandles.has(handle)) continue;
      checked++;

      try {
        await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 8000 });

        if (page.url().includes('/accounts/login')) break;

        // Check for rate-limit page before scraping
        const bodyText = await page.evaluate(function () {
          return document.body ? document.body.innerText.slice(0, 200) : '';
        });
        const rateLimitSignals = ['we limit', 'try again later', 'restrict certain activity'];
        const isRateLimited = rateLimitSignals.some(function (s) {
          return bodyText.toLowerCase().indexOf(s) !== -1;
        });
        if (isRateLimited) {
          log('🚫', 'RATELIMIT', 'Rate limit page detected. Sleeping 4-6 minutes before retry...');
          await delay(240000 + Math.floor(Math.random() * 120000));
          await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 8000 });
          await humanPause(3, 6);
          const retryText = await page.evaluate(function () {
            return document.body ? document.body.innerText.slice(0, 200) : '';
          });
          if (rateLimitSignals.some(function (s) { return retryText.toLowerCase().indexOf(s) !== -1; })) {
            log('🚫', 'RATELIMIT', 'Still rate-limited after sleep. Aborting harvest.');
            break;
          }
        }

        await humanPause(2, 4);

        const raw = await page.evaluate(() => {
          return document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
        });
        const title = await page.evaluate(() => document.title || '');
        if (!raw) { log('⏭️', 'HARVEST', '@' + handle + ' — no meta description (page blank? login redirect?)'); continue; }

        const fm = raw.match(/^([\d,.]+[kKmM]?)\s+followers/i);
        const nm = raw.match(/followers,\s+\d+.*?[-–—]\s+(.+?)\s+\(@/);
        const bm = raw.match(/on Instagram:\s*"([^"]+)"/);
        if (!fm) { log('⏭️', 'HARVEST', '@' + handle + ' — cannot parse follower count from meta: ' + raw.substring(0, 60)); continue; }

        const followers = parseFollowers(fm[1]);
        if (followers < actualMinFollowers) { log('⏭️', 'HARVEST', '@' + handle + ' — ' + followers + ' followers < ' + actualMinFollowers + ' minimum'); continue; }

        const maxFollowers = config.maxFollowers || Infinity;
        if (followers > maxFollowers) {
          log('⏭️', 'HARVEST', `@${handle} has ${followers.toLocaleString()} followers — exceeds max limit (${maxFollowers.toLocaleString()})`);
          continue;
        }

        // Multi-strategy name extraction (h2 first — most reliable)
        // Strategy 1: DOM h2 element (Instagram always renders the profile name here)
        let fullName = await page.evaluate(() => {
          const h2 = document.querySelector('h2');
          return h2 ? h2.innerText.trim() : '';
        });
        // Strategy 2: Meta description regex
        if (!fullName) {
          fullName = nm?.[1] || '';
        }
        // Strategy 3: Title tag
        if (!fullName && title) {
          const titleName = title.match(/^(.+?)\s*\(@/);
          if (titleName) fullName = titleName[1].trim();
        }
        const bio = bm?.[1] || '';

        const lower = (fullName + ' ' + bio + ' ' + handle).toLowerCase();

        // Must have BOTH founder signal AND ecom signal (brand/store/shopify/ecom/boutique/label)
        var isFounder = lower.indexOf('founder') !== -1 || lower.indexOf('ceo') !== -1 || lower.indexOf('owner') !== -1 || lower.indexOf('creative director') !== -1;
        var isEcom = lower.indexOf('brand') !== -1 || lower.indexOf('shopify') !== -1 || lower.indexOf('store') !== -1 || lower.indexOf('ecom') !== -1 || lower.indexOf('boutique') !== -1 || lower.indexOf('label') !== -1 || lower.indexOf('shop') !== -1 || lower.indexOf('retail') !== -1 || lower.indexOf('fashion') !== -1 || lower.indexOf('beauty') !== -1 || lower.indexOf('jewelry') !== -1 || lower.indexOf('skincare') !== -1 || lower.indexOf('wellness') !== -1 || lower.indexOf('cosmetics') !== -1 || lower.indexOf('lingerie') !== -1 || lower.indexOf('swimwear') !== -1 || lower.indexOf('accessories') !== -1 || lower.indexOf('footwear') !== -1 || lower.indexOf('apparel') !== -1 || lower.indexOf('clothing') !== -1;
        if (!isFounder || !isEcom) { continue; }

        // REJECT all Indian leads — India is a no-go region
        const indiaIndicators = [
          'india','indian','india\u{1F1EE}\u{1F1F3}','bharat','desi','desi',
          'mumbai','delhi','bangalore','bengaluru','chennai','kolkata','hyderabad','pune','ahmedabad','jaipur','surat','lucknow','kanpur','nagpur','indore','thane','bhopal','visakhapatnam','pimpri','patna','vadodara','ghaziabad','ludhiana','agra','nashik','faridabad','meerut','rajkot','kalyan','vasai','varanasi','srinagar','aurangabad','dhanbad','amritsar','navi mumbai','allahabad','ranchi','howrah','coimbatore','jabalpur','gwalior','vijayawada','jodhpur','madurai','raipur','kota','guwahati','chandigarh','solapur','hubli','tiruchirappalli','mysore','tiruppur','gurgaon','aligarh','jalandhar','bhubaneswar','salem','warangal','guntur','bhiwandi','saharanpur','gorakhpur','bikaner','amravati','noida','jhansi','ulhasnagar','mangalore','udupi','etawah','malegaon','davanagere','kozhikode','akola','kurnool','rajpur sonarpur','bokaro','bellary','patiala','gopalpur','agartala','bhilai','bhilwara','chandrapur','bharatpur','purnia','satna','mau','sonipat','farrukhabad','sambalpur','rewa','naihati','hapur','kamarhati','bulandshahr','durgapur','shahjahanpur','baranagar','shivamogga','pali','yamunanagar','sitapur','bhagalpur','hindupur','nandyal','bhiwani','morena','banda','mahbubnagar','hospet','phusro','itarsi','tiruvannamalai','baharampur','ongole','karimnagar','shimla','anantapur','danapur','bidar','motihari','bhalswa jahangirpur','panipat','karnal','rajahmundry','katihar','singrauli',' hardoi','nagda','sambhal','bhatpara','damoh','chapra','hajipur','phagwara','zirakpur','dibrugarh','kolar','rohtak','khammam','bhind','bhusawal','bathinda','raurkela','nangloi jat','tumkur','kharagpur','ambala','gandhidham','burhanpur','kumbakonam','rajapalayam','sikar','thanjavur','bhilwara','hazaribagh','nagda','khanna','udhampur','reasi','samba','kathua','doda','poonch','rajouri','anantnag','baramulla','bandipora','kulgam','kupwara','pulwama','budgam','ganderbal','shopian','srinagar','leh','ladakh','kargil',
          'tamil','telugu','hindi','marathi','bengali','gujarati','punjabi','malayalam','kannada','urdu','odia','assamese',
          'rupay','paytm','phonepe','upi','bhim','razorpay',
          '₹','rs ','rs.','inr'
        ];
        const isIndia = indiaIndicators.some(ind => lower.includes(ind));
        if (isIndia) {
          log('⏭️', 'HARVEST', `@${handle} is from India — skipping`);
          continue;
        }

        // Verify that the Message button is visible on the profile
        const hasMessageButton = await page.evaluate(() => {
          const textMatch = (el, text) => el.textContent.trim().toLowerCase() === text.toLowerCase();
          const all = document.querySelectorAll('div[role="button"], button, svg, span, a[href*="/direct/"]');
          for (const el of all) {
            if (textMatch(el, 'Message') || el.getAttribute('aria-label')?.toLowerCase() === 'message') {
              return true;
            }
          }
          return false;
        }).catch(() => false);

        if (!hasMessageButton) {
          log('⏭️', 'HARVEST', `@${handle} has no Message button — skipping`);
          continue;
        }

        leads.push({
          ig_handle: handle,
          full_name: fullName,
          follower_count: followers,
          bio: bio.substring(0, 500),
          niche_tags: selectedTags,
          source_url: `https://www.instagram.com/${handle}/`,
          discovered_at: new Date().toISOString()
        });

        log('✅', 'FOUND', `@${handle} | ${followers.toLocaleString()} | "${fullName}"`);
      } catch (e) { log('⚠️', 'HARVEST', `Profile check failed for @${handle}: ${e.message}`); }
    }
  } finally {
    // Merge new leads with existing (dedup by handle)
    const allLeads = [...existingLeads];
    const seen = new Set(allLeads.map(l => l.ig_handle.toLowerCase()));
    for (const lead of leads) {
      if (!seen.has(lead.ig_handle.toLowerCase())) {
        allLeads.push(lead);
        seen.add(lead.ig_handle.toLowerCase());
      }
    }

    // Save locally (atomic write: temp file then rename)
    const tmpPath = OUTPUT_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify({ workspace: config.workspaceName, leads: allLeads, total: allLeads.length }, null, 2));
    fs.renameSync(tmpPath, OUTPUT_PATH);

    // Sync to Supabase leads table
    if (leads.length > 0) {
      log('🔵', 'HARVEST', `Syncing ${leads.length} new leads to Supabase...`);
      const leadsWithNames = [];
      for (const lead of leads) {
        try {
          // Upsert new leads
          const { error } = await supabase.from('leads').upsert({
            workspace_id: config.workspaceId,
            ig_handle: lead.ig_handle,
            full_name: lead.full_name,
            follower_count: lead.follower_count,
            bio: lead.bio,
            niche_tags: lead.niche_tags,
            source_url: lead.source_url,
            status: 'discovered',
            discovered_at: lead.discovered_at,
          }, { onConflict: 'workspace_id,ig_handle', ignoreDuplicates: true });
          if (!error) synced++;
          // Track leads with names for batch update after loop
          if (lead.full_name) leadsWithNames.push(lead);
        } catch (e) { log('⚠️', 'HARVEST', `Upsert failed for @${lead.ig_handle}: ${e.message}`); }
        await delay(200 + Math.floor(Math.random() * 800));
      }
      // Batch update existing leads missing full_name (parallel, no per-lead delay)
      if (leadsWithNames.length > 0) {
        await Promise.all(leadsWithNames.map(async (lead) => {
          try {
            await supabase.from('leads').update({
              full_name: lead.full_name,
              updated_at: new Date().toISOString(),
            }).eq('workspace_id', config.workspaceId).eq('ig_handle', lead.ig_handle).is('full_name', null);
          } catch (e) { log('⚠️', 'HARVEST', `Name update failed for @${lead.ig_handle}: ${e.message}`); }
        }));
      }
      log(synced > 0 ? '✅' : '⚠️', 'HARVEST', `Synced ${synced}/${leads.length} leads to database`);
    }

    if (sessionExpired) {
      log('⚠️', 'HARVEST', `Done (SESSION EXPIRED). ${checked} checked, ${leads.length} new, ${allLeads.length} total`);
    } else {
      log('🔵', 'HARVEST', `Done. ${checked} checked, ${leads.length} new, ${allLeads.length} total`);
    }
  }

  return synced;
}

/**
 * Standalone entry point (run directly: node harvester.cjs)
 */
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Antigravity Client Harvester v3        ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const configPath = path.resolve(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log('❌ config.json not found. Download from dashboard.');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  if (config.permissions && config.permissions.canHarvest === false) {
    console.log('⛔ Lead harvesting is disabled for your account.');
    process.exit(0);
  }

  // PID lock — prevent concurrent harvester instances
  if (fs.existsSync(LOCK_PATH)) {
    try {
      var lockData = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      try { process.kill(lockData.pid, 0); console.log('⚠️ Another harvester is already running (PID ' + lockData.pid + '). Exiting.'); process.exit(0); } catch (e) { /* stale lock, continue */ }
    } catch (e) { /* corrupted lock, continue */ }
  }
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  var heartbeatTimer = null;

  process.on('exit', function () {
    try { if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH); } catch (e) {}
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: {
      headers: {
        'x-workspace-secret': config.workspaceSecret || ''
      }
    },
    realtime: {
      transport: WebSocket
    }
  });

  if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

  const userAgents = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  ];
  const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];

  const launchOpts = {
    headless: process.platform === 'linux' || config.headless !== false,
    userAgent: randomUA,
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  };
  if (config.proxyServer) {
    // Parse proxy URL for explicit credentials (Playwright needs them separate)
    var proxyMatch = config.proxyServer.match(/^(https?:\/\/)(?:([^:@]+):([^@]+)@)?(.+)$/);
    if (proxyMatch) {
      launchOpts.proxy = { server: proxyMatch[1] + proxyMatch[4] };
      if (proxyMatch[2]) launchOpts.proxy.username = proxyMatch[2];
      if (proxyMatch[3]) launchOpts.proxy.password = proxyMatch[3];
    } else {
      launchOpts.proxy = { server: config.proxyServer };
    }
    if (config.proxyUsername) launchOpts.proxy.username = config.proxyUsername;
    if (config.proxyPassword) launchOpts.proxy.password = config.proxyPassword;
  }
  const context = await chromium.launchPersistentContext(SESSION_PATH, launchOpts);

  const page = await context.newPage();
  
  // Stealth: Hide webdriver
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Auto-inject cookies from relay upload if available
  var cookieFile = path.resolve(process.cwd(), 'ig_session_cookies.json');
  if (fs.existsSync(cookieFile)) {
    try {
      var cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies.map(function (c) {
          return {
            name: c.name,
            value: c.value,
            domain: c.domain || '.instagram.com',
            path: c.path || '/',
            httpOnly: c.httpOnly || false,
            secure: c.secure !== false,
            sameSite: c.sameSite || 'Lax'
          };
        }));
        log('🔵', 'HARVEST', 'Injected ' + cookies.length + ' cookies from relay upload');
      }
    } catch (e) { log('⚠️', 'HARVEST', 'Cookie injection failed: ' + e.message); }
  }

  if (!await verifySession(context)) {
    log('⚠️', 'HARVEST', 'No Instagram session. Run: node login.cjs first');
    await context.close();
    process.exit(1);
  }

  log('🔵', 'HARVEST', 'Logged in. Starting search...\n');

  // Start heartbeat — dashboard gets live progress visibility
  var workspaceId = config.workspaceId;
  heartbeatTimer = setInterval(function () {
    try {
      supabase.from('engine_heartbeats').upsert({
        workspace_id: workspaceId,
        seen_at: new Date().toISOString(),
        paused: false
      }, { onConflict: 'workspace_id' });
    } catch (e) {}
  }, 60000);

  try {
    await harvest(page, supabase, config);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await context.close();
  }

  console.log('');
}

module.exports = { harvest };

if (require.main === module) {
  main().catch(e => { log('❌', 'CRASH', e.message); process.exit(1); });
}