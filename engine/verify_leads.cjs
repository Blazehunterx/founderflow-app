/**
 * verify_leads.cjs — Re-qualify raw leads against Ecom-founder criteria.
 *
 * Uses Instagram's internal web_profile_info API (fetched inside the browser)
 * so it bypasses HTML rendering issues and headless detection.
 *
 * Reads found_leads.json, scores every profile, and writes:
 *   - qualified_leads.json     (passes quality gate)
 *   - rejected_leads.json      (fails, with reason)
 *   - verify_report.json       (stats + config used)
 *
 * Resumable via verify_state.json.
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { evaluateLead, parseFollowers, normalizeHandle } = require('./lead_quality.cjs');

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');
const INPUT_PATH = path.resolve(process.cwd(), process.argv[2] || 'found_leads.json');
const INPUT_BASENAME = path.basename(INPUT_PATH, path.extname(INPUT_PATH));
const QUALIFIED_PATH = path.resolve(process.cwd(), 'qualified_leads.json');
const REJECTED_PATH = path.resolve(process.cwd(), 'rejected_leads.json');
const REPORT_PATH = path.resolve(process.cwd(), `verify_report_${INPUT_BASENAME}.json`);
const STATE_PATH = path.resolve(process.cwd(), `verify_state_${INPUT_BASENAME}.json`);
const LOG_PATH = path.resolve(process.cwd(), 'verify.log');
const SESSION_PATH = path.resolve(process.cwd(), 'sessions');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function humanPause(minSec, maxSec) { return delay(rand(minSec * 1000, maxSec * 1000)); }

async function getProfileInfo(page, handle) {
  // Navigate to the profile first to set origin/cookies, then call the internal API.
  try {
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'commit', timeout: 15000 });
  } catch (e) {
    return { error: `goto_failed_${e.message.slice(0, 60)}` };
  }

  if (page.url().indexOf('/accounts/login') !== -1) {
    return { error: 'session_expired' };
  }

  const data = await page.evaluate(async (h) => {
    try {
      const r = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${h}`, {
        credentials: 'include',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'X-IG-App-ID': '1217981644879628'
        }
      });
      if (r.status === 429) return { error: 'rate_limited', status: r.status };
      if (r.status === 404) return { error: 'not_found', status: r.status };
      if (!r.ok) return { error: `http_${r.status}`, status: r.status };
      return await r.json();
    } catch (e) {
      return { error: `fetch_failed_${e.message}` };
    }
  }, handle);

  if (data.error) return data;

  const user = data?.data?.user;
  if (!user) {
    return { error: 'no_user_object', body: JSON.stringify(data).slice(0, 200) };
  }

  return {
    fullName: user.full_name || '',
    bio: user.biography || '',
    followers: user.edge_followed_by?.count || 0,
    isPrivate: user.is_private || false,
    isVerified: user.is_verified || false,
    pk: user.id || ''
  };
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ config.json not found');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (!fs.existsSync(INPUT_PATH)) {
    console.error('❌ found_leads.json not found');
    process.exit(1);
  }

  let inputData;
  try {
    inputData = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
  } catch (e) {
    console.error('❌ failed to parse found_leads.json:', e.message);
    process.exit(1);
  }

  let inputLeads = [];
  if (Array.isArray(inputData)) inputLeads = inputData;
  else if (inputData.leads && Array.isArray(inputData.leads)) inputLeads = inputData.leads;
  else {
    console.error('❌ found_leads.json must be an array or { leads: [...] }');
    process.exit(1);
  }

  log(`Loaded ${inputLeads.length} raw leads from ${INPUT_PATH}`);

  let qualified = [];
  let rejected = [];
  if (fs.existsSync(QUALIFIED_PATH)) {
    try { qualified = JSON.parse(fs.readFileSync(QUALIFIED_PATH, 'utf8')).leads || []; } catch (e) {}
  }
  if (fs.existsSync(REJECTED_PATH)) {
    try { rejected = JSON.parse(fs.readFileSync(REJECTED_PATH, 'utf8')).leads || []; } catch (e) {}
  }

  const qualifiedHandles = new Set(qualified.map(l => normalizeHandle(l.ig_handle)));
  const rejectedHandles = new Set(rejected.map(l => normalizeHandle(l.ig_handle)));

  let state = { index: 0 };
  if (fs.existsSync(STATE_PATH)) {
    try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) {}
  }

  const leadsToProcess = inputLeads
    .map((l, idx) => ({ lead: l, idx }))
    .filter(({ lead }) => {
      const h = normalizeHandle(lead.ig_handle || lead.handle || lead.username);
      return h && !qualifiedHandles.has(h) && !rejectedHandles.has(h);
    });

  log(`${leadsToProcess.length} leads remain after removing already-judged. Starting from index ${state.index}`);

  if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

  const launchOpts = {
    headless: config.headless !== false,
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  };
  if (config.proxyServer) {
    const pm = config.proxyServer.match(/^(https?:\/\/)(?:([^:@]+):([^@]+)@)?(.+)$/);
    if (pm) {
      launchOpts.proxy = { server: pm[1] + pm[4] };
      if (pm[2]) launchOpts.proxy.username = pm[2];
      if (pm[3]) launchOpts.proxy.password = pm[3];
    }
  }

  const context = await chromium.launchPersistentContext(SESSION_PATH, launchOpts);
  const page = await context.newPage();
  await page.addInitScript(function () {
    Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });
  });

  const cookieFile = path.resolve(process.cwd(), 'ig_session_cookies.json');
  if (fs.existsSync(cookieFile)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies.map(function (c) {
          return { name: c.name, value: c.value, domain: c.domain || '.instagram.com', path: c.path || '/', httpOnly: c.httpOnly || false, secure: c.secure !== false, sameSite: c.sameSite || 'Lax' };
        }));
        log(`Injected ${cookies.length} cookies`);
      }
    } catch (e) { log('Cookie inject error: ' + e.message); }
  }

  let processed = 0;
  let newQualified = 0;
  let newRejected = 0;
  let rateLimited = false;

  try {
    for (let i = state.index; i < leadsToProcess.length; i++) {
      const { lead } = leadsToProcess[i];
      const handle = normalizeHandle(lead.ig_handle || lead.handle || lead.username);
      processed++;

      log(`[${i + 1}/${leadsToProcess.length}] @${handle}`);

      const info = await getProfileInfo(page, handle);

      if (info.error === 'session_expired') {
        log('❌ Session expired. Stopping.');
        break;
      }

      if (info.error === 'rate_limited') {
        log('🚫 Rate limited. Sleeping 5-8 min...');
        rateLimited = true;
        state.index = i;
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        await delay(rand(300000, 480000));
        const retry = await getProfileInfo(page, handle);
        if (retry.error === 'rate_limited') {
          log('🚫 Still rate limited. Stopping.');
          break;
        }
        Object.assign(info, retry);
      }

      if (info.error) {
        rejected.push({
          ig_handle: handle,
          full_name: lead.full_name || '',
          follower_count: 0,
          bio: '',
          reason: info.error,
          score: 0,
          checked_at: new Date().toISOString()
        });
        newRejected++;
        log(`  ⏭️ ${info.error}`);
      } else {
        const result = evaluateLead(handle, info.fullName, info.bio, info.followers, config);
        const base = {
          ig_handle: handle,
          full_name: info.fullName || '',
          follower_count: info.followers,
          bio: info.bio || '',
          is_private: info.isPrivate,
          is_verified: info.isVerified,
          pk: info.pk,
          score: result.score,
          founder_score: result.founderScore,
          ecom_score: result.ecomScore,
          negative_score: result.negativeScore,
          founder_matches: result.founderMatches,
          ecom_matches: result.ecomMatches,
          negative_matches: result.negativeMatches,
          checked_at: new Date().toISOString()
        };

        if (result.passed) {
          qualified.push({
            ...base,
            niche_tags: lead.niche_tags || config.nicheTags || ['ecommerce founder'],
            source_url: `https://www.instagram.com/${handle}/`,
            discovered_at: lead.discovered_at || new Date().toISOString()
          });
          newQualified++;
          log(`  ✅ QUALIFIED score=${result.score} founder=${result.founderScore} ecom=${result.ecomScore} followers=${info.followers}`);
        } else {
          rejected.push({ ...base, reason: result.reasons.join(','), passed: false });
          newRejected++;
          log(`  ❌ rejected: ${result.reasons.join(', ')}`);
        }
      }

      // Persist every 10 profiles
      if (processed % 10 === 0) {
        fs.writeFileSync(QUALIFIED_PATH, JSON.stringify({ workspace: config.workspaceName || 'Greywell', leads: qualified, total: qualified.length }, null, 2));
        fs.writeFileSync(REJECTED_PATH, JSON.stringify({ workspace: config.workspaceName || 'Greywell', leads: rejected, total: rejected.length }, null, 2));
        state.index = i + 1;
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        log(`  💾 saved — ${qualified.length} qualified / ${rejected.length} rejected`);
      }

      // Pacing
      if (!rateLimited) {
        await humanPause(1, 2);
        if (processed % 25 === 0) await humanPause(10, 20);
      }
      rateLimited = false;
    }
  } catch (e) {
    log(`❌ CRASH: ${e.message}`);
    console.error(e);
  } finally {
    fs.writeFileSync(QUALIFIED_PATH, JSON.stringify({ workspace: config.workspaceName || 'Greywell', leads: qualified, total: qualified.length }, null, 2));
    fs.writeFileSync(REJECTED_PATH, JSON.stringify({ workspace: config.workspaceName || 'Greywell', leads: rejected, total: rejected.length }, null, 2));
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

    const report = {
      generated_at: new Date().toISOString(),
      input_file: INPUT_PATH,
      input_total: inputLeads.length,
      already_judged: inputLeads.length - leadsToProcess.length,
      processed_this_run: processed,
      qualified_total: qualified.length,
      rejected_total: rejected.length,
      new_qualified_this_run: newQualified,
      new_rejected_this_run: newRejected,
      config: {
        minFollowers: config.minFollowers || 500,
        maxFollowers: config.maxFollowers || 100000,
        minFounderScore: config.minFounderScore || 2,
        minEcomScore: config.minEcomScore || 3,
        minTotalScore: config.minTotalScore || 5
      },
      note: 'Tune minFounderScore/minEcomScore/minTotalScore in config.json and rerun to adjust strictness.'
    };
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

    await context.close();
  }

  log('');
  log('========== VERIFY COMPLETE ==========');
  log(`Qualified: ${qualified.length}`);
  log(`Rejected:  ${rejected.length}`);
  log(`Report:    ${REPORT_PATH}`);
  log('=====================================');
}

main().catch(function (e) {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
