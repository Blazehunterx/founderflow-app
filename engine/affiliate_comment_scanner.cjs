/**
 * affiliate_comment_scanner.cjs
 * Stealth comment harvesting for affiliate outreach.
 * Rotates through dream_100_sources table, scans recent posts, filters by intent.
 */

const fs = require('fs');
const path = require('path');

const SCAN_STATE_PATH = path.resolve(process.cwd(), 'affiliate_scan_state.json');

const AFFILIATE_INTENT_KEYWORDS = [
  'start', 'beginner', 'new to', 'how do i', 'how to', 'want to learn', 'interested in',
  'affiliate', 'online income', 'extra income', 'side hustle', 'side income', 'passive income',
  'make money', 'make money online', 'earn online', 'earn extra', 'income stream', 'online business',
  'digital marketing', 'content creator', 'monetize', 'monetization', 'need help', 'struggling',
  'looking for', 'searching for', 'where do i', 'what platform', 'what to sell', 'no followers',
  'no audience', 'no experience', 'recommend', 'course', 'training', 'guide', 'mentor', 'coach'
];

const EXCLUDE_KEYWORDS = [
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

async function apiGet(endpoint) {
  const res = await fetch(`http://127.0.0.1:5000${endpoint}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function extractCommentersFromPost(shortcode) {
  const commenters = new Map();
  let next_cursor = null;
  let pages = 0;
  const MAX_PAGES = 10;

  while (pages < MAX_PAGES) {
    let url = `/scrape_comments?shortcode=${shortcode}`;
    if (next_cursor) {
      url += '&next_max_id=' + encodeURIComponent(typeof next_cursor === 'object' ? JSON.stringify(next_cursor) : next_cursor);
    }
    try {
      const json = await apiGet(url);
      if (json.error) break;
      const comments = json.comments || [];
      if (comments.length === 0) break;
      for (const c of comments) {
        const user = c.user;
        if (user && user.username && !commenters.has(user.username)) {
          commenters.set(user.username, {
            username: user.username,
            full_name: user.full_name || '',
            follower_count: user.follower_count !== undefined ? user.follower_count : null,
            profile_pic_url: user.profile_pic_url || '',
            is_verified: user.is_verified || false,
            is_private: user.is_private || false,
            comment_text: c.text || ''
          });
        }
      }
      next_cursor = json.next_min_id || json.next_max_id;
      if (!next_cursor) break;
      pages++;
      if (pages < MAX_PAGES) await delay(jitter(12000, 4000));
    } catch (e) {
      log('⚠️', 'AFF_SCAN', `Fetch error: ${e.message}`);
      break;
    }
  }
  return Array.from(commenters.values());
}

async function getRecentPosts(username, maxPosts = 20) {
  try {
    const profileData = await apiGet(`/check_profile?username=${username}`);
    const userId = profileData.data?.user?.id;
    if (!userId) return [];
    const feedData = await apiGet(`/get_user_posts?user_id=${userId}`);
    const items = feedData.items || [];
    return items.map(i => ({ shortcode: i.code, url: `https://www.instagram.com/p/${i.code}/` })).filter(p => !!p.shortcode).slice(0, maxPosts);
  } catch (e) {
    log('⚠️', 'AFF_SCAN', `Failed to fetch posts for @${username}: ${e.message}`);
    return [];
  }
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

function hasAffiliateIntent(commentText) {
  const t = (commentText || '').toLowerCase();
  const hasIntent = AFFILIATE_INTENT_KEYWORDS.some(kw => t.includes(kw.toLowerCase()));
  const hasExclude = EXCLUDE_KEYWORDS.some(kw => t.includes(kw.toLowerCase()));
  return hasIntent && !hasExclude;
}

async function scanAffiliateComments(page, supabase, config) {
  if (!config.commentScanEnabled) return 0;

  const workspaceId = config.workspaceId;
  let state = {};
  try { state = JSON.parse(fs.readFileSync(SCAN_STATE_PATH, 'utf8')); } catch (e) {}

  const source = await getNextDream100Source(supabase, workspaceId, state);
  if (!source) {
    log('⚠️', 'AFF_SCAN', 'No active Dream 100 sources found');
    return 0;
  }

  const targetUsername = source.creator_handle;
  log('💭', 'AFF_SCAN', `Scanning @${targetUsername} (${source.category})`);

  const scannedPosts = state.scannedPosts || {};
  const sourceScanned = scannedPosts[targetUsername] || [];

  const recentPosts = await getRecentPosts(targetUsername, config.commentScanMaxPosts || 20);
  if (!recentPosts.length) {
    log('💭', 'AFF_SCAN', `No recent posts for @${targetUsername}`);
    return 0;
  }

  const unscanned = recentPosts.filter(p => !sourceScanned.includes(p.shortcode));
  if (!unscanned.length) {
    log('💭', 'AFF_SCAN', `All recent posts for @${targetUsername} already scanned`);
    return 0;
  }

  log('💭', 'AFF_SCAN', `${unscanned.length} new posts to scan`);

  const minFollowers = config.minFollowers || 0;
  const maxFollowers = config.maxFollowers || 500000;
  let leadsFound = 0;
  let filtered = 0;
  let processed = 0;

  for (const post of unscanned) {
    processed++;
    log('💭', 'AFF_SCAN', `[${processed}/${unscanned.length}] @${targetUsername}/p/${post.shortcode}`);

    const commenters = await extractCommentersFromPost(post.shortcode);
    if (commenters.length === 0) {
      sourceScanned.push(post.shortcode);
      await delay(jitter(15000, 5000));
      continue;
    }

    log('💭', 'AFF_SCAN', `${commenters.length} commenters — filtering...`);

    for (const commenter of commenters) {
      const handle = commenter.username.toLowerCase();

      if (commenter.is_verified) {
        log('🔍', 'AFF_SCAN', `@${handle} ✗ verified`);
        filtered++; continue;
      }

      if (isLikelyMinor(commenter.full_name + ' ' + commenter.comment_text)) {
        log('🔍', 'AFF_SCAN', `@${handle} ✗ likely minor`);
        filtered++; continue;
      }

      if (!hasAffiliateIntent(commenter.comment_text)) {
        log('🔍', 'AFF_SCAN', `@${handle} ✗ weak intent: ${commenter.comment_text.substring(0, 30).replace(/\n/g, ' ')}`);
        filtered++; continue;
      }

      if (commenter.follower_count !== null) {
        if (commenter.follower_count < minFollowers) {
          log('🔍', 'AFF_SCAN', `@${handle} ✗ ${commenter.follower_count} followers < ${minFollowers}`);
          filtered++; continue;
        }
        if (commenter.follower_count > maxFollowers) {
          log('🔍', 'AFF_SCAN', `@${handle} ✗ ${commenter.follower_count} followers > ${maxFollowers}`);
          filtered++; continue;
        }
      }

      const { data: existing } = await supabase.from('leads').select('id')
        .eq('workspace_id', workspaceId).eq('ig_handle', handle).limit(1);
      if (existing && existing.length > 0) {
        log('🔍', 'AFF_SCAN', `@${handle} ✗ already in leads`);
        filtered++; continue;
      }

      try {
        await supabase.from('leads').insert({
          workspace_id: workspaceId,
          ig_handle: handle,
          status: 'discovered',
          source: 'comment_harvest',
          source_creator: source.creator_handle,
          source_post_url: post.url,
          discovered_at: new Date().toISOString(),
          last_updated_at: new Date().toISOString(),
          full_name: commenter.full_name || null,
          follower_count: commenter.follower_count,
          bio: null
        });
        leadsFound++;
        const fk = commenter.follower_count ? ` (${Math.round(commenter.follower_count / 1000)}K)` : '';
        log('✅', 'AFF_SCAN', `@${handle} ✓ added${fk}`);
      } catch (e) {
        log('⚠️', 'AFF_SCAN', `@${handle} insert error: ${e.message}`);
      }

      await delay(jitter(15000, 6000));
    }

    sourceScanned.push(post.shortcode);
    await delay(jitter(25000, 10000));
  }

  scannedPosts[targetUsername] = sourceScanned.slice(-200);
  state.scannedPosts = scannedPosts;
  state.lastAffiliateScan = new Date().toISOString();
  fs.writeFileSync(SCAN_STATE_PATH, JSON.stringify(state, null, 2));

  log('✅', 'AFF_SCAN', `Session done: ${leadsFound} leads, ${filtered} filtered from @${targetUsername}`);
  return leadsFound;
}

module.exports = { scanAffiliateComments };
