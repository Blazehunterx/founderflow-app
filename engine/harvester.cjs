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
  // Massive tag pool — 100+ terms covering every angle of the affiliate/online business niche
  // Focused on everyday people wanting passive/remote income (NOT high-ticket/7-figure)
  var allTags = [
    // Core affiliate terms
    'affiliate marketing','affiliate marketer','affiliate program','affiliate income','affiliate business','affiliate link','affiliate commission','affiliate strategy','affiliate tips','affiliate coach',
    // Online business — beginner focused
    'online business','online entrepreneur','online income','online earnings','online hustle','online coaching','online success','online revenue','online profit','online wealth','online freedom',
    // Side hustle / extra income — everyday people
    'side hustle','side business','extra income','passive income','passive income ideas','passive income stream','residual income','multiple income streams','income stream','income growth',
    // Digital marketing / creator
    'digital marketing','digital entrepreneur','digital creator','digital nomad','marketing coach','marketing tips','marketing strategy','marketing online','social media marketing','content creator',
    // Make money — beginner friendly
    'make money online','make money from home','financial freedom','financial independence','financial goals','financial literacy','wealth building','wealth mindset','money mindset','money coach',
    // Freedom / lifestyle — everyday dreams
    'freedom lifestyle','freedom entrepreneur','work from home','work remotely','remote income','remote work','digital nomad life','location independent','time freedom','financial freedom',
    // Entrepreneur — early stage
    'entrepreneur mindset','entrepreneur life','entrepreneur coach','business owner','business coach','business mentor','startup founder','founder life','boss life','beginner entrepreneur',
    // Tools / platforms — accessible
    'email marketing','funnel builder','clickfunnels','systeme.io','low ticket','recurring revenue','membership site','course creator','coach','consulting','agency owner',
    // Beginner / learning — the core ICP
    'learn affiliate','start affiliate','beginner affiliate','start online business','learn marketing','start digital marketing','start side hustle','beginner online','first online income','new to affiliate',
    // Outcome — realistic, not 7-figure
    'replaced income','quit nine to five','quit corporate','left my job','freelance life','solopreneur','work from laptop','earn from home','online income beginner','side hustle beginner',
    // Everyday people
    'stay at home mom income','college student income','remote job','online job','part time online','full time remote','digital income','online opportunity','start earning online','beginner side hustle'
  ];

  var selectedTags = [];
  // Pick 16 random tags from the pool each cycle for variety
  var shuffledTags = allTags.slice();
  for (var t = shuffledTags.length - 1; t > 0; t--) {
    var tr = Math.floor(Math.random() * (t + 1));
    var tt = shuffledTags[t]; shuffledTags[t] = shuffledTags[tr]; shuffledTags[tr] = tt;
  }
  selectedTags = shuffledTags.slice(0, 16);
  fs.writeFileSync(rotationPath, JSON.stringify({ index: rotation + 1 }));
  log('🔵', 'HARVEST', 'Tag pool: ' + allTags.length + ' terms, selected 16 random');

  const cities = config.targetRegions || ['new york','los angeles','chicago','houston','phoenix','san antonio','san diego','dallas','austin','miami','seattle','denver','boston','nashville','atlanta','vegas','portland','phoenix','detroit','minneapolis'];

  const queries = [];
  for (const niche of selectedTags) {
    queries.push(niche);
    // Add city variants for first 5 tags
    var cityIdx = allTags.indexOf(niche);
    for (const city of cities.slice(0, 5)) {
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

    // Phase 1.5: Hashtag search — find users who POST about our niche
    const hashtagPool = [
      'affiliatemarketing', 'sidehustleideas', 'passiveincome', 'workfromhome',
      'onlinebusiness', 'digitalmarketing', 'makemoneyonline', 'entrepreneurlife',
      'freelancerlife', 'solopreneur', 'financialfreedom', 'locationindependent',
      'remotework', 'onlineincome', 'emailmarketing', 'socialmediamarketing',
      'contentcreator', 'leadgeneration', 'salesfunnel', 'clickfunnels',
      'affiliatecoach', 'onlinecoaching', 'mompreneur', 'dadpreneur',
      'quitthe9to5', 'buildyourbrand', 'digitalnomad', 'workfromanywhere',
      'freedomlifestyle', 'wealthbuilding', 'financialliteracy', 'money mindset',
      'extr income', 'homebasedbusiness', 'onlinemarketing', 'growthhacking'
    ];
    const selectedHashtags = [];
    for (let i = 0; i < 8 && hashtagPool.length > 0; i++) {
      const idx = Math.floor(Math.random() * hashtagPool.length);
      selectedHashtags.push(hashtagPool.splice(idx, 1)[0]);
    }
    log('🔵', 'HARVEST', `Phase 1.5: Searching ${selectedHashtags.length} hashtags`);

    for (const tag of selectedHashtags) {
      if (leads.length >= maxLeads) break;
      try {
        await page.goto(`https://www.instagram.com/explore/tags/${tag}/`, { waitUntil: 'domcontentloaded', timeout: 8000 });
        if (page.url().includes('/accounts/login')) break;
        await new Promise(r => setTimeout(r, 2000));

        const bodyText = await page.evaluate(function () {
          return document.body ? document.body.innerText.slice(0, 200) : '';
        });
        if (rateLimitSignals.some(function (s) { return bodyText.toLowerCase().indexOf(s) !== -1; })) {
          log('🚫', 'RATELIMIT', 'Rate limit on hashtag page. Skipping hashtags.');
          break;
        }

        // Scroll 3 times to load more posts
        for (let sc = 0; sc < 3; sc++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await new Promise(r => setTimeout(r, 1500));
        }

        const tagHandles = await page.evaluate(() => {
          const links = document.querySelectorAll('a[href*="/"]');
          const found = [];
          for (const link of links) {
            const href = link.getAttribute('href');
            const m = href && href.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
            if (m && m[1] && m[1] !== 'explore' && m[1] !== 'accounts' && m[1] !== 'direct' && m[1] !== 'p' && m[1] !== 'reel' && m[1] !== 'stories' && m[1] !== tag) {
              found.push(m[1].toLowerCase());
            }
          }
          return [...new Set(found)];
        }).catch(() => []);

        let tagAdded = 0;
        for (const h of tagHandles) {
          if (!foundHandles.has(h) && !existingHandles.has(h) && !shuffled.includes(h)) {
            foundHandles.add(h);
            tagAdded++;
          }
        }
        if (tagAdded > 0) {
          log('🏷️', 'HASHTAG', `#${tag} → ${tagAdded} new handles (${tagHandles.length} total)`);
        }
      } catch (e) {}
      await humanPause(1, 2);
    }
    log('🔵', 'HARVEST', `${foundHandles.size} unique handles after hashtag search`);

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
    const phase2Cap = Math.min(shuffled.length, 40);
    for (let p2i = 0; p2i < phase2Cap; p2i++) {
      const handle = shuffled[p2i];
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

        // Must have signal matching the target niche (affiliate/online business/income/freedom)
        var isAffiliateNiche = lower.indexOf('affiliate') !== -1 || lower.indexOf('online business') !== -1 || lower.indexOf('side hustle') !== -1 || lower.indexOf('passive income') !== -1 || lower.indexOf('extra income') !== -1 || lower.indexOf('digital marketing') !== -1 || lower.indexOf('make money') !== -1 || lower.indexOf('work from home') !== -1 || lower.indexOf('freedom') !== -1 || lower.indexOf('financial') !== -1 || lower.indexOf('entrepreneur') !== -1 || lower.indexOf('income') !== -1 || lower.indexOf('marketing') !== -1 || lower.indexOf('coach') !== -1 || lower.indexOf('business') !== -1 || lower.indexOf('founder') !== -1 || lower.indexOf('ceo') !== -1 || lower.indexOf('owner') !== -1 || lower.indexOf('mentor') !== -1 || lower.indexOf('creator') !== -1 || lower.indexOf('influencer') !== -1 || lower.indexOf('brand') !== -1 || lower.indexOf('online') !== -1 || lower.indexOf('remote') !== -1 || lower.indexOf('digital') !== -1 || lower.indexOf('earn') !== -1 || lower.indexOf('revenue') !== -1 || lower.indexOf('profit') !== -1 || lower.indexOf('wealth') !== -1 || lower.indexOf('money') !== -1 || lower.indexOf('invest') !== -1;
        if (!isAffiliateNiche) { continue; }

        // REJECT all non-western leads — Asia, Middle East, Africa are no-go regions
        const nonWesternIndicators = [
          // India (comprehensive)
          'india','indian','india\u{1F1EE}\u{1F1F3}','bharat','desi',
          'mumbai','delhi','bangalore','bengaluru','chennai','kolkata','hyderabad','pune','ahmedabad','jaipur','surat','lucknow','kanpur','nagpur','indore','thane','bhopal','visakhapatnam','pimpri','patna','vadodara','ghaziabad','ludhiana','agra','nashik','faridabad','meerut','rajkot','kalyan','vasai','varanasi','srinagar','aurangabad','dhanbad','amritsar','navi mumbai','allahabad','ranchi','howrah','coimbatore','jabalpur','gwalior','vijayawada','jodhpur','madurai','raipur','kota','guwahati','chandigarh','solapur','hubli','tiruchirappalli','mysore','tiruppur','gurgaon','aligarh','jalandhar','bhubaneswar','salem','warangal','guntur','bhiwandi','saharanpur','gorakhpur','bikaner','amravati','noida','jhansi','mangalore','udupi','kozhikode','kurnool','bokaro','patiala','agartala','bhilai','durgapur','shahjahanpur','tumkur','kharagpur','ambala','bathinda','raurkela',
          'tamil','telugu','hindi','marathi','bengali','gujarati','punjabi','malayalam','kannada','urdu','odia','assamese',
          'rupay','paytm','phonepe','upi','bhim','razorpay',
          '₹','rs ','rs.','inr',
          // South Asia
          'pakistan','pakistani','bangladesh','bangladeshi','sri lanka','sri lankan','nepal','nepali','bhutan','maldives',
          // East Asia
          'china','chinese','japan','japanese','korea','korean','taiwan','taiwanese','hong kong',
          'beijing','shanghai','tokyo','osaka','seoul','busan','taipei',
          // Southeast Asia
          'indonesia','indonesian','philippines','filipino','thailand','thai','vietnam','vietnamese',
          'malaysia','malaysian','singapore','myanmar','cambodia','cambodian','laos','laotian','brunei',
          'bangkok','manila','jakarta','ho chi minh','hanoi','kuala lumpur',
          // Central Asia
          'kazakhstan','uzbekistan','turkmenistan','kyrgyzstan','tajikistan',
          // Middle East
          'dubai','abu dhabi','sharjah','uae','united arab emirates','saudi','saudi arabia',
          'qatar','bahrain','kuwait','oman','yemen',
          'iran','iranian','iraq','iraqi','syria','syrian','jordan','lebanon','lebanese',
          'israel','palestine','turkey','turkish','istanbul','ankara',
          // Africa
          'nigeria','nigerian','ghana','ghanaian','kenya','kenyan','ethiopia','ethiopian',
          'egypt','egyptian','morocco','moroccan','tunisia','tunisian','algeria','algerian',
          'south africa','cape town','johannesburg',
          // Non-western scripts
          'arabic','farsi','kurdish','nepali','sinhala','thai','khmer','lao','burmese',
        ];
        const isNonWestern = nonWesternIndicators.some(ind => lower.includes(ind));
        if (isNonWestern) {
          log('⏭️', 'HARVEST', `@${handle} is non-western — skipping`);
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

        // Spiderweb: scrape followers list from this profile (only every 3rd found, 1K-100K followers)
        if (followers >= 1000 && followers <= 100000 && leads.length % 3 === 0) {
          try {
            await page.goto(`https://www.instagram.com/${handle}/followers/`, { waitUntil: 'domcontentloaded', timeout: 10000 });
            await new Promise(r => setTimeout(r, 2000));

            if (!page.url().includes('/accounts/login')) {
              const followerHandles = [];
              const maxScrolls = 5;
              for (let s = 0; s < maxScrolls; s++) {
                const batch = await page.evaluate(() => {
                  const links = document.querySelectorAll('a[href*="/"]');
                  const found = [];
                  for (const link of links) {
                    const href = link.getAttribute('href');
                    const m = href && href.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
                    if (m && m[1] && m[1] !== 'explore' && m[1] !== 'accounts' && m[1] !== 'direct' && m[1] !== 'p' && m[1] !== 'reel' && m[1] !== 'stories') {
                      found.push(m[1].toLowerCase());
                    }
                  }
                  return [...new Set(found)];
                });
                for (const h of batch) {
                  if (!followerHandles.includes(h)) followerHandles.push(h);
                }
                if (followerHandles.length >= 50) break;
                await page.evaluate(() => {
                  const dialog = document.querySelector('[role="dialog"]') || document.querySelector('div[style*="overflow"]');
                  if (dialog) dialog.scrollTop = dialog.scrollHeight;
                  else window.scrollTo(0, document.body.scrollHeight);
                });
                await new Promise(r => setTimeout(r, 1000));
              }

              let added = 0;
              for (const fh of followerHandles) {
                if (!foundHandles.has(fh) && !existingHandles.has(fh) && !shuffled.includes(fh)) {
                  foundHandles.add(fh);
                  added++;
                }
              }
              if (added > 0) {
                log('🕸️', 'SPIDERWEB', `@${handle} → ${added} follower handles added (${followerHandles.length} scraped)`);
              }
            }
          } catch (e) {}
        }
      } catch (e) { log('⚠️', 'HARVEST', `Profile check failed for @${handle}: ${e.message}`); }
    }

    // Phase 3: Process spiderweb-discovered handles (follower scraping) — fast mode
    const newSpiderHandles = Array.from(foundHandles).filter(h => !existingHandles.has(h) && !shuffled.includes(h));
    const spiderCap = Math.min(newSpiderHandles.length, 20);
    const spiderMaxLeads = Math.max(maxLeads, 300);
    if (spiderCap > 0) {
      log('🕸️', 'SPIDERWEB', `Phase 3: Processing ${spiderCap} of ${newSpiderHandles.length} spiderweb accounts`);
      for (let i = 0; i < spiderCap; i++) {
        const handle = newSpiderHandles[i];
        if (leads.length >= spiderMaxLeads) break;
        if (existingHandles.has(handle)) continue;
        checked++;

        try {
          await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 3000 });
          if (page.url().includes('/accounts/login')) break;

          const bodyText = await page.evaluate(function () {
            return document.body ? document.body.innerText.slice(0, 200) : '';
          });
          if (rateLimitSignals.some(function (s) { return bodyText.toLowerCase().indexOf(s) !== -1; })) {
            log('🚫', 'RATELIMIT', 'Rate limit during spiderweb. Aborting.');
            break;
          }

          await humanPause(0.5, 1.5);

          const raw = await page.evaluate(() => {
            return document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
          });
          const title = await page.evaluate(() => document.title || '');
          if (!raw) continue;

          const fm = raw.match(/^([\d,.]+[kKmM]?)\s+followers/i);
          const nm = raw.match(/followers,\s+\d+.*?[-–—]\s+(.+?)\s+\(@/);
          const bm = raw.match(/on Instagram:\s*"([^"]+)"/);
          if (!fm) continue;

          const followers = parseFollowers(fm[1]);
          if (followers < actualMinFollowers) continue;
          const maxFollowers = config.maxFollowers || Infinity;
          if (followers > maxFollowers) continue;

          let fullName = await page.evaluate(() => {
            const h2 = document.querySelector('h2');
            return h2 ? h2.innerText.trim() : '';
          });
          if (!fullName) fullName = nm?.[1] || '';
          if (!fullName && title) {
            const titleName = title.match(/^(.+?)\s*\(@/);
            if (titleName) fullName = titleName[1].trim();
          }
          const bio = bm?.[1] || '';
          const lower = (fullName + ' ' + bio + ' ' + handle).toLowerCase();

          var isAffiliateNiche = lower.indexOf('affiliate') !== -1 || lower.indexOf('online business') !== -1 || lower.indexOf('side hustle') !== -1 || lower.indexOf('passive income') !== -1 || lower.indexOf('extra income') !== -1 || lower.indexOf('digital marketing') !== -1 || lower.indexOf('make money') !== -1 || lower.indexOf('work from home') !== -1 || lower.indexOf('freedom') !== -1 || lower.indexOf('financial') !== -1 || lower.indexOf('entrepreneur') !== -1 || lower.indexOf('income') !== -1 || lower.indexOf('marketing') !== -1 || lower.indexOf('coach') !== -1 || lower.indexOf('business') !== -1 || lower.indexOf('founder') !== -1 || lower.indexOf('ceo') !== -1 || lower.indexOf('owner') !== -1 || lower.indexOf('mentor') !== -1 || lower.indexOf('creator') !== -1 || lower.indexOf('influencer') !== -1 || lower.indexOf('brand') !== -1 || lower.indexOf('online') !== -1 || lower.indexOf('remote') !== -1 || lower.indexOf('digital') !== -1 || lower.indexOf('earn') !== -1 || lower.indexOf('revenue') !== -1 || lower.indexOf('profit') !== -1 || lower.indexOf('wealth') !== -1 || lower.indexOf('money') !== -1 || lower.indexOf('invest') !== -1;
          if (!isAffiliateNiche) continue;

          const isNonWestern = nonWesternIndicators.some(ind => lower.includes(ind));
          if (isNonWestern) continue;

          leads.push({
            ig_handle: handle,
            full_name: fullName,
            follower_count: followers,
            bio: bio.substring(0, 500),
            niche_tags: selectedTags,
            source_url: `https://www.instagram.com/${handle}/`,
            discovered_at: new Date().toISOString()
          });
          log('✅', 'FOUND', `@${handle} | ${followers.toLocaleString()} | "${fullName}" (spiderweb)`);
        } catch (e) {}
      }
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
        await delay(100 + Math.floor(Math.random() * 200));
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

  // Cookie injection: prefer persistent context (marvinvdsluis), inject relay cookies only if no session
  const hasSession = await verifySession(context);
  if (!hasSession) {
    // Try relay upload cookies as fallback
    var cookieFile = path.resolve(process.cwd(), 'ig_session_cookies.json');
    if (fs.existsSync(cookieFile)) {
      try {
        var cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        if (Array.isArray(cookies) && cookies.length > 0) {
          var igCookies = cookies.filter(c => c.domain && c.domain.includes('instagram.com'));
          if (igCookies.length >= 3) {
            await context.addCookies(igCookies.map(function (c) {
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
            log('🔵', 'HARVEST', `Injected ${igCookies.length} cookies from relay upload`);
          }
        }
      } catch (e) { log('⚠️', 'HARVEST', `Cookie injection failed: ${e.message}`); }
    }
  } else {
    log('🔵', 'HARVEST', 'Using persistent context session (marvinvdsluis)');
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