/**
 * affiliate_follower_harvester.cjs
 * Harvests followers of Affiliate Dream 100 creators and filters by bio intent.
 * Integrates with engine auto/harvest mode.
 */

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.resolve(process.cwd(), 'affiliate_follower_state.json');

const AFFILIATE_BIO_KEYWORDS = [
  'affiliate', 'online income', 'extra income', 'side hustle', 'side income', 'passive income',
  'make money', 'make money online', 'earn online', 'earn extra', 'income stream', 'online business',
  'digital marketing', 'content creator', 'entrepreneur', 'beginner affiliate', 'leave 9 to 5',
  'income flexibility', 'financial freedom', 'work from home', 'solopreneur', 'founder',
  'business owner', 'startup', 'ecommerce', 'shopify', 'funnels', 'marketing', 'coach', 'consultant'
];

const EXCLUDE_BIO_KEYWORDS = [
  'crypto', 'bitcoin', 'forex', 'trading', 'gamble', 'gambling', 'bet', 'lottery',
  'get rich quick', 'rich overnight', 'guaranteed income', 'guaranteed money', 'pyramid',
  'mlm', 'recruit', 'scheme'
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

function hasAffiliateIntent(bio) {
  const t = (bio || '').toLowerCase();
  const hasIntent = AFFILIATE_BIO_KEYWORDS.some(kw => t.includes(kw.toLowerCase()));
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
  const handles = [];
  let url = `https://www.instagram.com/api/v1/friendships/${pk}/followers/?count=200`;
  while (handles.length < max) {
    const data = await fetchJson(page, url);
    if (data._rateLimited) {
      log('⚠️', 'AFF_FOLLOWERS', 'Rate limited by Instagram');
      return { error: 'rate_limited', handles };
    }
    if (data._error) {
      log('⚠️', 'AFF_FOLLOWERS', `API error: ${data._error}`);
      return { error: data._error, handles };
    }
    if (!data.users) break;
    for (const u of data.users) {
      if (u.username) handles.push(u.username.toLowerCase());
      if (handles.length >= max) break;
    }
    if (!data.next_max_id) break;
    url = `https://www.instagram.com/api/v1/friendships/${pk}/followers/?count=200&max_id=${data.next_max_id}`;
    await delay(jitter(2000, 1000));
  }
  return { handles: [...new Set(handles)] };
}

async function getNextDream100Source(supabase, workspaceId, state) {
  const { data: sources, error } = await supabase
    .from('dream_100_sources')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true });

  if (error || !sources || sources.length === 0) return null;

  const idx = state.sourceIndex || 0;
  const source = sources[idx % sources.length];
  state.sourceIndex = (idx + 1) % sources.length;
  return source;
}

async function harvestAffiliateFollowers(page, supabase, config) {
  const workspaceId = config.workspaceId;
  const state = loadState();
  const source = await getNextDream100Source(supabase, workspaceId, state);
  if (!source) {
    log('⚠️', 'AFF_FOLLOWERS', 'No active Dream 100 sources found');
    return 0;
  }

  log('💭', 'AFF_FOLLOWERS', `Harvesting followers of @${source.creator_handle}`);

  const userInfo = await getUserInfo(page, source.creator_handle);
  if (userInfo._error || !userInfo.pk) {
    log('⚠️', 'AFF_FOLLOWERS', `Could not get user info for @${source.creator_handle}: ${userInfo._error || 'unknown'}`);
    return 0;
  }

  const maxFollowers = config.commentScanMaxFollowers || 100000;
  const followersResult = await getFollowers(page, userInfo.pk, 200);
  if (followersResult.error) {
    log('⚠️', 'AFF_FOLLOWERS', `Error fetching followers: ${followersResult.error}`);
    return 0;
  }

  const handles = followersResult.handles || [];
  log('💭', 'AFF_FOLLOWERS', `${handles.length} raw follower handles`);

  const minFollowers = config.minFollowers || 0;
  const maxLeadFollowers = config.maxFollowers || 500000;
  let leadsFound = 0;
  let filtered = 0;
  let processed = 0;

  for (const handle of handles) {
    processed++;
    if (processed % 20 === 0) {
      log('📊', 'AFF_FOLLOWERS', `${processed}/${handles.length} checked, ${leadsFound} leads, ${filtered} filtered`);
    }

    const { data: existing } = await supabase.from('leads').select('id')
      .eq('workspace_id', workspaceId).eq('ig_handle', handle).limit(1);
    if (existing && existing.length > 0) { filtered++; continue; }

    const profile = await getUserInfo(page, handle);
    if (profile._error || profile.isPrivate) {
      filtered++;
      await delay(jitter(2000, 1000));
      continue;
    }

    if (profile.followers < minFollowers || profile.followers > maxLeadFollowers) {
      log('🔍', 'AFF_FOLLOWERS', `@${handle} ✗ follower count ${profile.followers}`);
      filtered++; continue;
    }

    if (isLikelyMinor(profile.bio + ' ' + profile.fullName)) {
      log('🔍', 'AFF_FOLLOWERS', `@${handle} ✗ likely minor`);
      filtered++; continue;
    }

    if (!hasAffiliateIntent(profile.bio)) {
      filtered++;
      await delay(jitter(2000, 1000));
      continue;
    }

    try {
      await supabase.from('leads').insert({
        workspace_id: workspaceId,
        ig_handle: handle,
        status: 'discovered',
        source: 'follower_harvest',
        source_creator: source.creator_handle,
        discovered_at: new Date().toISOString(),
        last_updated_at: new Date().toISOString(),
        full_name: profile.fullName || null,
        follower_count: profile.followers,
        bio: profile.bio || null
      });
      leadsFound++;
      const fk = profile.followers ? ` (${Math.round(profile.followers / 1000)}K)` : '';
      log('✅', 'AFF_FOLLOWERS', `@${handle} ✓ added${fk}`);
    } catch (e) {
      log('⚠️', 'AFF_FOLLOWERS', `@${handle} insert error: ${e.message}`);
    }

    await delay(jitter(5000, 2000));
  }

  state.lastRun = new Date().toISOString();
  saveState(state);

  log('✅', 'AFF_FOLLOWERS', `Session done: ${leadsFound} leads, ${filtered} filtered from @${source.creator_handle}`);
  return leadsFound;
}

module.exports = { harvestAffiliateFollowers };
