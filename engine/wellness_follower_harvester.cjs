/**
 * wellness_follower_harvester.cjs
 * Harvests followers of wellness/yoga target accounts.
 * Filters by bio intent (looking for training, interested in nidra, etc.)
 * Integrates with engine auto/harvest mode.
 */

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.resolve(process.cwd(), 'wellness_follower_state.json');

const WELLNESS_BIO_KEYWORDS = [
  'yoga', 'yoga teacher', 'yoga instructor', 'yoga student', 'yoga practitioner',
  'nidra', 'yoga nidra', 'nsdr', 'non sleep deep rest', 'rest',
  'reiki', 'reiki practitioner', 'reiki master', 'energy healing',
  'somatic', 'somatic healing', 'somatic coach', 'somatic experiencing',
  'trauma', 'trauma informed', 'trauma healing', 'nervous system',
  'meditation', 'meditation teacher', 'meditation guide', 'mindfulness',
  'coach', 'life coach', 'wellness coach', 'health coach', 'breathwork',
  'healing', 'holistic', 'wellness', 'wellbeing', 'self care', 'self-care',
  'certification', 'teacher training', '200 hour', '300 hour', 'ytt',
  'practitioner', 'therapist', 'counselor', 'healer',
  'breath', 'breathwork', 'pranayama', 'sound healing', 'sound bath',
  'ayurveda', 'herbalist', 'plant medicine', 'ceremony',
  'retreat', 'workshop', 'circle', 'community', 'sangha'
];

const EXCLUDE_BIO_KEYWORDS = [
  'crypto', 'bitcoin', 'forex', 'trading', 'gamble', 'gambling',
  'mlm', 'recruit', 'scheme', 'get rich', 'passive income',
  'shopify', 'ecommerce', 'dropshipping', 'amazon fba'
];

const MINOR_SIGNALS = [
  'class of 2025', 'class of 2026', 'class of 2027', 'class of 2028', 'class of 2029',
  'high school', 'senior 20', 'junior 20', 'sophomore', 'freshman',
  'turning 18', 'almost 18', 'not 18', '17 ', '16 ', '15 ', '14 ', ' underage', 'underage'
];

function log(emoji, tag, msg) {
  const line = `${emoji} [${tag}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.resolve(process.cwd(), 'engine.log'), `[${new Date().toISOString()}] ${line}\n`); } catch (e) {}
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(base, variance) { return base + Math.random() * variance; }

function isLikelyMinor(text) {
  const t = (text || '').toLowerCase();
  return MINOR_SIGNALS.some(s => t.includes(s));
}

function hasWellnessIntent(bio) {
  const t = (bio || '').toLowerCase();
  const hasIntent = WELLNESS_BIO_KEYWORDS.some(kw => t.includes(kw.toLowerCase()));
  const hasExclude = EXCLUDE_BIO_KEYWORDS.some(kw => t.includes(kw.toLowerCase()));
  return hasIntent && !hasExclude;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function fetchJson(page, url) {
  return await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, {
        credentials: 'include',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'X-IG-App-ID': '1217981644879628'
        }
      });
      if (r.status === 429) return { _rateLimited: true, status: r.status };
      if (r.status === 404) return { _notFound: true, status: r.status };
      if (!r.ok) return { _error: `http_${r.status}`, status: r.status };
      return await r.json();
    } catch (e) {
      return { _error: `fetch_${e.message}` };
    }
  }, url);
}

async function getUserInfo(page, handle) {
  const data = await fetchJson(page, `https://www.instagram.com/api/v1/users/web_profile_info/?username=${handle}`);
  if (data._rateLimited || data._error || data._notFound) return data;
  const user = data?.data?.user;
  if (!user) return { _error: 'no_user_object' };
  return {
    handle: user.username,
    fullName: user.full_name || '',
    bio: user.biography || '',
    followers: user.edge_followed_by?.count || 0,
    isPrivate: user.is_private || false,
    isVerified: user.is_verified || false,
    pk: user.id || ''
  };
}

async function getFollowers(page, pk, max = 200) {
  const followers = [];
  let url = `https://www.instagram.com/api/v1/friendships/${pk}/followers/?count=200`;
  while (followers.length < max) {
    const data = await fetchJson(page, url);
    if (data._rateLimited) {
      log('⚠️', 'WELLNESS_FOLLOWERS', 'Rate limited by Instagram');
      return { error: 'rate_limited', followers };
    }
    if (data._error) {
      log('⚠️', 'WELLNESS_FOLLOWERS', `API error: ${data._error}`);
      return { error: data._error, followers };
    }
    if (!data.users) break;
    for (const u of data.users) {
      if (u.username) {
        followers.push({
          username: u.username.toLowerCase(),
          fullName: u.full_name || '',
          pk: u.pk || ''
        });
      }
      if (followers.length >= max) break;
    }
    if (!data.next_max_id) break;
    url = `https://www.instagram.com/api/v1/friendships/${pk}/followers/?count=200&max_id=${data.next_max_id}`;
    await delay(jitter(2000, 1000));
  }
  return { followers };
}

async function harvestWellnessFollowers(page, supabase, config) {
  const workspaceId = config.workspaceId;
  const state = loadState();
  
  // Get target accounts from config (comma-separated)
  const targetInput = config.commentScanTarget || config.igUsername || '';
  const targetAccounts = targetInput.split(',').map(t => t.trim()).filter(t => t);
  
  if (targetAccounts.length === 0) {
    log('⚠️', 'WELLNESS_FOLLOWERS', 'No target accounts configured');
    return 0;
  }
  
  // Track which account we're on
  const accountIndex = state.accountIndex || 0;
  const currentAccount = targetAccounts[accountIndex % targetAccounts.length];
  state.accountIndex = (accountIndex + 1) % targetAccounts.length;
  
  log('💭', 'WELLNESS_FOLLOWERS', `Harvesting followers of @${currentAccount} (${accountIndex + 1}/${targetAccounts.length})`);
  
  const userInfo = await getUserInfo(page, currentAccount);
  if (userInfo._rateLimited || userInfo._error || userInfo._notFound) {
    log('⚠️', 'WELLNESS_FOLLOWERS', `Failed to get user info for @${currentAccount}: ${JSON.stringify(userInfo)}`);
    saveState(state);
    return 0;
  }
  
  const maxFollowers = config.maxFollowers || 200;
  const result = await getFollowers(page, userInfo.pk, maxFollowers);
  
  if (result.error) {
    log('⚠️', 'WELLNESS_FOLLOWERS', `Failed to fetch followers: ${result.error}`);
    saveState(state);
    return 0;
  }
  
  log('💭', 'WELLNESS_FOLLOWERS', `Got ${result.followers.length} followers from @${currentAccount}`);
  
  // Filter followers by bio intent
  const filtered = [];
  let processed = 0;
  
  for (const follower of result.followers) {
    processed++;
    
    // Check if already in our leads
    const { data: existing } = await supabase.from('leads').select('id')
      .eq('workspace_id', workspaceId).eq('ig_handle', follower.username).limit(1);
    if (existing && existing.length > 0) continue;
    
    // Get profile info to check bio
    const profileInfo = await getUserInfo(page, follower.username);
    if (profileInfo._rateLimited) {
      log('⚠️', 'WELLNESS_FOLLOWERS', 'Rate limited — stopping this session');
      break;
    }
    if (profileInfo._error || profileInfo._notFound) continue;
    
    // Check follower count limits
    const maxF = config.maxFollowers || 100000;
    if (profileInfo.followers > maxF) continue;
    
    // Check if minor
    if (isLikelyMinor(profileInfo.bio)) continue;
    
    // Check wellness intent
    if (!hasWellnessIntent(profileInfo.bio)) continue;
    
    filtered.push({
      username: follower.username,
      fullName: profileInfo.fullName || follower.fullName,
      bio: profileInfo.bio,
      followers: profileInfo.followers
    });
    
    if (filtered.length % 10 === 0) {
      log('📊', 'WELLNESS_FOLLOWERS', `Progress: ${processed}/${result.followers.length} | ${filtered.length} qualified`);
    }
    
    await delay(jitter(1500, 500));
  }
  
  // Sync to Supabase
  let synced = 0;
  for (const lead of filtered) {
    try {
      const { error } = await supabase.from('leads').upsert({
        workspace_id: workspaceId,
        ig_handle: lead.username,
        full_name: lead.fullName,
        follower_count: lead.followers,
        bio: lead.bio,
        niche_tags: config.nicheTags || [],
        source: 'follower',
        source_url: `https://www.instagram.com/${currentAccount}/`,
        status: 'discovered',
        discovered_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,ig_handle', ignoreDuplicates: true });
      if (!error) synced++;
    } catch (e) { log('⚠️', 'WELLNESS_FOLLOWERS', `Upsert failed for @${lead.username}: ${e.message}`); }
    await delay(200 + Math.random() * 300);
  }
  
  log('✅', 'WELLNESS_FOLLOWERS', `Session done: ${synced} leads synced from @${currentAccount}`);
  
  // Update state
  state.lastRun = new Date().toISOString();
  state.lastAccount = currentAccount;
  saveState(state);
  
  return synced;
}

module.exports = { harvestWellnessFollowers };
