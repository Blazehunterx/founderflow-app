/**
 * comment_scanner.cjs - v3 (Stealth Microservice)
 * Uses the local Python API (stealth_harvester.py) for true stealth.
 * No headless browser, no TLS fingerprinting.
 */

const path = require("path");
const fs = require("fs");

const SCAN_STATE_PATH = path.resolve(process.cwd(), "comment_scan_state.json");

function log(emoji, tag, msg) {
  const line = `${emoji} [${tag}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.resolve(process.cwd(), "engine.log"), `[${new Date().toISOString()}] ${line}\n`); } catch (e) {}
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(base, variance) { return base + Math.random() * variance; }

const MINOR_SIGNALS = [
  "class of 2025","class of 2026","class of 2027","class of 2028","class of 2029",
  "high school","senior 20","junior 20","sophomore","freshman",
  "turning 18","almost 18","not 18","17 ","16 ","15 ","14 "," underage","underage",
];
function isLikelyMinor(bio, displayName) {
  const text = `${bio} ${displayName}`.toLowerCase();
  return MINOR_SIGNALS.some(s => text.includes(s));
}

// Wellness/yoga nidra niche intent keywords
const WELLNESS_INTENT_KEYWORDS = [
  "want to learn","how do i","how to","looking for","interested in","recommend",
  "suggestion","advice","tips","help","guide","resource","course","training",
  "certification","teacher training","yoga nidra","nsdr","meditation","rest",
  "nervous system","healing","wellness","coach","practitioner","reiki",
  "somatic","trauma","regulation","breathe","breathwork","mindful",
  "would love","anyone know","where can","can someone","does anyone",
  "thinking about","considering","ready to","start","begin","join",
  "community","group","program","workshop","retreat","class"
];

// Flirty/attraction niche intent keywords (original)
const FLIRTY_INTENT_KEYWORDS = [
  "❤️", "😍", "🔥", "🥵", "🤤", "😈", "💦", "🍑", "🍆", "beautiful", "gorgeous", "love", "stunning", "pretty", "cute", "perfect", "babe", "baby", "hot", "sweet", "angel", "wow", "goddess", "queen", "omg", "omgg", "omggg", "sexy", "fine", "thick", "thicc", "mommy", "mami", "momma", "damn", "lord", "wife", "wifey", "marry", "please", "obsessed", "bark", "step on me", "smash", "would"
];

function getIntentKeywords(niche) {
  const lowerNiche = (niche || '').toLowerCase();
  if (lowerNiche.includes('yoga') || lowerNiche.includes('wellness') || lowerNiche.includes('nidra') || lowerNiche.includes('health') || lowerNiche.includes('coaching')) {
    return WELLNESS_INTENT_KEYWORDS;
  }
  return FLIRTY_INTENT_KEYWORDS;
}

async function checkGenderWithAI(photoUrl, apiKey) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(photoUrl, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    let mimeType = "image/jpeg";
    if (photoUrl.includes(".png")) mimeType = "image/png";
    if (photoUrl.includes(".webp")) mimeType = "image/webp";
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 15000);
    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl2.signal,
        body: JSON.stringify({ contents: [{ parts: [{ inlineData: { mimeType, data: base64 } }, { text: "Look at this Instagram profile photo. Is this person male or female? Reply with ONLY one word: male or female. If you cannot tell, reply: unknown." }] }], generationConfig: { maxOutputTokens: 10, temperature: 0 } }) }
    );
    clearTimeout(t2);
    if (!apiRes.ok) return null;
    const data = await apiRes.json();
    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").toLowerCase().trim();
    if (text.includes("male") && !text.includes("female")) return "male";
    if (text.includes("female")) return "female";
    return "unknown";
  } catch (e) { return null; }
}

async function extractCommentersFromPost(shortcode) {
  try {
    const commenters = new Map();
    let next_cursor = null;
    let pages = 0;
    const MAX_PAGES = 10; // Fetch up to 10 pages per post (~200-400 commenters)

    while (pages < MAX_PAGES) {
      let url = "http://127.0.0.1:5000/scrape_comments?shortcode=" + shortcode;
      if (next_cursor) {
        url += "&next_max_id=" + encodeURIComponent(typeof next_cursor === 'object' ? JSON.stringify(next_cursor) : next_cursor);
      }

      const res = await fetch(url);
      const json = await res.json();
      
      if (json.error) {
        log('⚠️', 'SCAN', "API Error: " + (json.status || json.message));
        break;
      }
      
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
      if (!next_cursor) break; // No more comments
      
      pages++;
      if (pages < MAX_PAGES) await delay(jitter(12000, 4000)); // Delay between pages
    }

    return Array.from(commenters.values());
  } catch (e) {
    log('⚠️', 'SCAN', "Fetch error: " + e.message);
    return [];
  }
}

async function checkProfile(handle, config) {
  try {
    const res = await fetch(`http://127.0.0.1:5000/check_profile?username=${handle}`);
    const json = await res.json();
    if (json.error) {
      return { ok: false, reason: `api error: ${json.status || json.message}` };
    }
    const user = json.data?.user;
    if (!user) return { ok: false, reason: "no user data" };

    const profileData = {
      bio: user.biography || "",
      displayName: user.full_name || "",
      followerCount: user.edge_followed_by?.count || null,
      photoUrl: user.profile_pic_url_hd || user.profile_pic_url || "",
    };

    const maxF = config.commentScanMaxFollowers || 100000;
    if (profileData.followerCount !== null && profileData.followerCount > maxF) {
      return { ok: false, reason: `followers ${Math.round(profileData.followerCount).toLocaleString()} > ${maxF.toLocaleString()}` };
    }
    if (isLikelyMinor(profileData.bio, profileData.displayName)) return { ok: false, reason: "likely minor" };
    // Skip gender filter for wellness niches (yoga teachers are often female - that's the target audience)
    const nicheText = (config.nicheTags || []).join(' ').toLowerCase() + ' ' + (config.niche || '').toLowerCase();
    const isWellnessNiche = nicheText.includes('yoga') || nicheText.includes('wellness') || nicheText.includes('nidra') || nicheText.includes('health') || nicheText.includes('coaching') || nicheText.includes('reiki') || nicheText.includes('somatic');
    if (profileData.photoUrl && config.geminiApiKey && !isWellnessNiche) {
      const gender = await checkGenderWithAI(profileData.photoUrl, config.geminiApiKey);
      if (gender === "female") return { ok: false, reason: "female (AI)" };
    }
    return { ok: true, data: profileData };
  } catch (e) {
    return { ok: false, reason: `error: ${e.message}` };
  }
}

async function getRecentPosts(username) {
  try {
    const profileRes = await fetch('http://127.0.0.1:5000/check_profile?username=' + username);
    const profileData = await profileRes.json();
    const userId = profileData.data?.user?.id;
    if (!userId) return [];
    
    const feedRes = await fetch('http://127.0.0.1:5000/get_user_posts?user_id=' + userId);
    const feedData = await feedRes.json();
    const items = feedData.items || [];
    return items.map(i => i.code).filter(c => !!c);
  } catch (e) {
    log("??", "SCAN", "Failed to fetch recent posts dynamically: " + e.message);
    return [];
  }
}

async function scanComments(page, supabase, config) {
  if (!config.commentScanEnabled) return 0;

  try {
    let scannedPosts = [];
    let stats = { totalScanned: 0, totalFiltered: 0, totalLeads: 0, sessions: 0 };
    try {
      const raw = fs.readFileSync(SCAN_STATE_PATH, 'utf8');
      const s = JSON.parse(raw);
      if (s.commentScannedPosts) scannedPosts = s.commentScannedPosts;
      if (s.stats) stats = { ...stats, ...s.stats };
    } catch (e) {}

    const targetWorkspace = config.commentScanWorkspace || config.workspaceId;
    
    // Support multiple target accounts (comma-separated)
    const targetInput = config.commentScanTarget || config.igUsername || 'kazumisworld';
    const targetAccounts = targetInput.split(',').map(t => t.trim()).filter(t => t);
    
    // Get intent keywords based on niche
    const intentKeywords = getIntentKeywords(config.nicheTags?.join(' ') || config.niche || '');
    log('💭', 'SCAN', 'Using ' + (intentKeywords === WELLNESS_INTENT_KEYWORDS ? 'wellness' : 'flirty') + ' intent keywords');
    
    let totalLeadsFound = 0;

    for (const targetUsername of targetAccounts) {
      log('💭', 'SCAN', 'Fetching recent active posts for @' + targetUsername + '...');
      const recentPosts = await getRecentPosts(targetUsername);
      
      if (!recentPosts.length) {
        log('💭', 'SCAN', 'Could not find any recent posts for @' + targetUsername + ' — skipping');
        continue;
      }
      
      const unscanned = recentPosts.filter(p => !scannedPosts.includes(p));
      if (!unscanned.length) {
        log('💭', 'SCAN', 'All recent posts for @' + targetUsername + ' already scanned this cycle');
        continue;
      }

      log('💭', 'SCAN', unscanned.length + ' new active posts to scan for @' + targetUsername + ' (' + scannedPosts.length + ' already done)');
      stats.sessions++;

      let leadsFound = 0, filtered = 0, processed = 0;

      for (const shortcode of unscanned) {
        processed++;
        log('💭', 'SCAN', '[' + processed + '/' + unscanned.length + '] /' + targetUsername + '/p/' + shortcode + '/');
        
        const commenters = await extractCommentersFromPost(shortcode);

        if (commenters.length === 0) {
          log('💭', 'SCAN', 'No commenters captured via Python API for ' + shortcode);
          scannedPosts.push(shortcode);
          await delay(jitter(15000, 5000));
          continue;
        }

        log('💭', 'SCAN', commenters.length + ' commenters captured — filtering...');

        for (const commenter of commenters) {
          const handle = commenter.username;

          if (commenter.is_verified) {
            log('🔍', 'SCAN', '@' + handle + ' ✗ is verified');
            filtered++; stats.totalFiltered++; continue;
          }

          const commentText = (commenter.comment_text || '').toLowerCase();
          const showsIntent = intentKeywords.some(kw => commentText.includes(kw));
          
          if (!showsIntent) {
              log('🔍', 'SCAN', '@' + handle + ' ✗ weak intent: ' + commentText.substring(0, 20).replace(/\n/g, ' '));
              filtered++; stats.totalFiltered++; continue;
          }

          const { data: existing } = await supabase.from('leads').select('id')
            .eq('workspace_id', targetWorkspace).eq('ig_handle', handle).limit(1);
          if (existing && existing.length > 0) { stats.totalFiltered++; continue; }

          if (commenter.follower_count !== null) {
              const maxF = config.commentScanMaxFollowers || 100000;
              if (commenter.follower_count > maxF) {
                log('🔍', 'SCAN', '@' + handle + ' ✗ ' + Math.round(commenter.follower_count).toLocaleString() + ' followers > max');
                filtered++; stats.totalFiltered++; continue;
              }
          }

          const check = await checkProfile(handle, config);
          stats.totalScanned++;

          if (!check.ok) {
            filtered++; stats.totalFiltered++;
            log('🔍', 'SCAN', '@' + handle + ' ✗ ' + check.reason);
            await delay(jitter(12000, 4000));
            continue;
          }

          try {
            await supabase.from('leads').insert({
              workspace_id: targetWorkspace,
              ig_handle: handle,
              status: 'verified',
              source: 'comment',
              discovered_at: new Date().toISOString(),
              full_name: commenter.full_name || check.data?.displayName || null,
              follower_count: check.data?.followerCount || commenter.follower_count || null,
              bio: check.data?.bio || null,
            }).then(() => {}, () => {});
            leadsFound++; stats.totalLeads++;
            const fk = check.data?.followerCount ? ' (' + Math.round(check.data.followerCount / 1000) + 'K)' : '';
            log('✅', 'SCAN', '@' + handle + ' ✓ added' + fk);
          } catch (e) {}

          await delay(jitter(15000, 6000));
        }

        scannedPosts.push(shortcode);
        if (processed % 2 === 0) {
          log('📊', 'SCAN', 'Progress: ' + processed + '/' + unscanned.length + ' posts | ' + leadsFound + ' leads | ' + filtered + ' filtered');
        }
        
        await delay(jitter(25000, 10000));
      }

      totalLeadsFound += leadsFound;
      log('✅', 'SCAN', '@' + targetUsername + ' done: ' + leadsFound + ' leads found');
      
      // Pause between accounts
      if (targetAccounts.indexOf(targetUsername) < targetAccounts.length - 1) {
        log('💭', 'SCAN', 'Pausing 60-90s before next account...');
        await delay(jitter(60000, 30000));
      }
    }

    log('✅', 'SCAN', '─── SESSION DONE ───');
    log('✅', 'SCAN', 'This session: ' + totalLeadsFound + ' leads | ' + stats.totalScanned + ' profiles checked | ' + stats.totalFiltered + ' filtered');
    log('✅', 'SCAN', 'All-time: ' + stats.totalLeads + ' leads | ' + stats.sessions + ' sessions');

    try {
      let state = {};
      try { state = JSON.parse(fs.readFileSync(SCAN_STATE_PATH, 'utf8')); } catch (e) {}
      state.commentScannedPosts = scannedPosts.slice(-200);
      state.lastCommentScan = new Date().toISOString();
      state.stats = stats;
      fs.writeFileSync(SCAN_STATE_PATH, JSON.stringify(state, null, 2));
    } catch (e) {}

    return totalLeadsFound;
  } catch (e) {
    log('❌', 'SCAN_ERR', e.message);
    return 0;
  }
}

module.exports = { scanComments };





