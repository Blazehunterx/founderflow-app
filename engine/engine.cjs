const { chromium } = require('playwright-core');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

let checkAndReply = async () => {};
try { checkAndReply = require('./ai_setter.cjs').checkAndReply; } catch (e) { console.warn('[LOAD_ERR] Failed to load ai_setter.cjs:', e.message); }
let typeAndSend = async () => false;
try { typeAndSend = require('./sender.cjs').typeAndSend; } catch (e) { console.warn('[LOAD_ERR] Failed to load sender.cjs:', e.message); }
let startProxyBridge = async () => ({ localUrl: null, close: () => {} });
try { startProxyBridge = require('./proxy_bridge.cjs').startProxyBridge; } catch (e) {}

const http = require('http');

function getProxyGeoInfo(proxyUrl, username, password) {
  return new Promise((resolve) => {
    try {
      if (!proxyUrl) return resolve(null);
      const parsed = new URL(proxyUrl);
      const options = {
        host: parsed.hostname,
        port: parsed.port || 80,
        path: 'http://ip-api.com/json',
        headers: {
          Host: 'ip-api.com',
        }
      };
      if (username && password) {
        const auth = Buffer.from(`${username}:${password}`).toString('base64');
        options.headers['Proxy-Authorization'] = `Basic ${auth}`;
      }
      
      const req = http.get(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsedData = JSON.parse(data);
            if (parsedData && parsedData.status === 'success') {
              resolve(parsedData);
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function mapCountryToLocale(countryCode) {
  const map = {
    'FI': 'fi-FI',
    'ID': 'id-ID',
    'US': 'en-US',
    'GB': 'en-GB',
    'CA': 'en-CA',
    'AU': 'en-AU',
    'DE': 'de-DE',
    'FR': 'fr-FR',
    'ES': 'es-ES',
    'IT': 'it-IT',
    'NL': 'nl-NL',
    'SE': 'sv-SE',
    'NO': 'nb-NO',
    'DK': 'da-DK',
    'PL': 'pl-PL',
    'BR': 'pt-BR',
    'PT': 'pt-PT',
    'IN': 'en-IN',
  };
  return (countryCode && map[countryCode.toUpperCase()]) || 'en-US';
}

// Heartbeat helper: insert or update (handles unique constraint on workspace_id)
async function sendHeartbeat(supabase, wsId, isPaused, version, isDeepSleep) {
  try {
    const payload = { workspace_id: wsId, paused: isPaused, deepsleep: isDeepSleep || false, engine_version: version, seen_at: new Date().toISOString() };
    const { error } = await supabase.from('engine_heartbeats').insert(payload);
    if (error && error.message?.includes('duplicate key') || error?.message?.includes('unique constraint')) {
      await supabase.from('engine_heartbeats').update(payload).eq('workspace_id', wsId);
    }
  } catch (e) {
    try { await supabase.from('engine_heartbeats').update({ workspace_id: wsId, paused: isPaused, deepsleep: isDeepSleep || false, engine_version: version, seen_at: new Date().toISOString() }).eq('workspace_id', wsId); } catch (e2) {}
  }
}

async function sendTelegram(supabase, message) {
  try {
    const token = config.telegramBotToken;
    const chatId = config.telegramChatId;
    if (!token || !chatId) return;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
    if (!res.ok) log('warn', 'TELEGRAM_ERR', `HTTP ${res.status}`);
  } catch (e) {
    log('warn', 'TELEGRAM_ERR', e.message);
  }
}

const ABSOLUTE_MAX_DM = 75;
const SESSION_PATH = path.resolve(process.cwd(), 'sessions');
const LOG_PATH = path.resolve(process.cwd(), 'engine.log');
const STATE_PATH = path.resolve(process.cwd(), 'state.json');
const FINGERPRINT_PATH = path.resolve(process.cwd(), 'fingerprint.json');

const logBuffer = [];
let logFlushTimer = null;

const configPath = path.resolve(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.mode = process.argv[2] || 'dm';
const WebSocket = require('ws');
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

let ENGINE_VERSION = 'unknown';
try {
  const versionFile = path.resolve(__dirname, '.version');
  if (fs.existsSync(versionFile)) ENGINE_VERSION = fs.readFileSync(versionFile, 'utf8').trim();
} catch (e) {}

// Check permissions
if (config.permissions && config.permissions.canDM === false) {
  console.log('⚠️  DM sending disabled — AI Setter inbox mode.');
}

const GREETINGS = ['Hey', 'Hello', 'Hi there', 'Hey there', 'Yo'];

function addTypo(text, rate) {
  if (rate <= 0 || Math.random() * 100 >= rate) return text;
  const chars = text.split('');
  const idx = Math.floor(Math.random() * chars.length);
  if (idx >= chars.length) return text;
  const type = Math.random();
  if (type < 0.33 && idx < chars.length - 1) {
    [chars[idx], chars[idx + 1]] = [chars[idx + 1], chars[idx]];
  } else if (type < 0.66) {
    chars.splice(idx, 1);
  } else {
    chars.splice(idx, 0, chars[idx]);
  }
  return chars.join('');
}

const GENERIC_TERMS = ["following", "followers", "message", "contact", "subscribe", "subscribe", "shop", "learn", "watch", "call", "email", "book", "buy", "sign", "review", "call", "directions", "brand", "studio", "collective", "group", "agency", "inc", "ltd", "corp", "healthcare", "medical", "clinic", "hospital", "pro", "specialist", "surgeons", "mumbai", "delhi", "bangalore", "india", "wellness", "center", "centre", "dr", "doctor", "coaching", "fitness", "nutrition", "consulting", "solutions", "official", "team", "life", "fit", "academy", "transformation", "health", "gym", "training", "strength", "performance", "wellbeing", "motivation", "success", "mindset", "lifestyle", "body", "muscle", "physique", "expert", "professional", "entrepreneur", "business", "brand", "media", "marketing", "digital", "online", "virtual", "global", "worldwide", "international", "certified", "licensed", "qualified", "registered", "accredited", "approved", "verified", "authentic", "genuine", "original", "real", "true", "pure", "natural", "organic", "holistic", "integrative", "functional", "preventive", "regenerative", "anti-aging", "longevity", "self-care", "self-love", "self-improvement", "personal", "growth", "development", "evolution", "journey", "path", "way", "method", "system", "program", "protocol", "formula", "recipe", "guide", "roadmap", "compass", "navigation", "direction", "destination", "goal", "target", "aim", "objective", "mission", "vision", "purpose", "calling", "passion", "dream", "aspiration", "ambition", "desire", "wish", "hope", "faith", "belief", "trust", "confidence", "certainty", "assurance", "guarantee", "promise", "commitment", "dedication", "devotion", "loyalty", "honesty", "integrity", "transparency", "clarity", "simplicity", "elegance", "beauty", "grace", "charm", "appeal", "attraction", "magnetism", "charisma", "presence", "aura", "energy", "vibe", "frequency", "vibration", "resonance", "harmony", "balance", "equilibrium", "stability", "security", "safety", "protection", "defense", "shield", "armor", "fortress", "sanctuary", "haven", "refuge", "retreat", "oasis", "paradise", "bliss", "joy", "happiness", "contentment", "satisfaction", "gratification", "fulfillment", "achievement", "accomplishment", "victory", "triumph", "conquest", "mastery", "dominance", "supremacy", "superiority", "excellence", "perfection", "ideal", "optimal", "peak", "pinnacle", "summit", "apex", "zenith", "top", "height", "elevation", "altitude", "prominence", "eminence", "distinction", "prestige", "status", "rank", "position", "standing", "reputation", "renown", "fame", "glory", "honor", "dignity", "respect", "esteem", "regard", "admiration", "appreciation", "gratitude", "thankfulness", "recognition", "acknowledgment", "validation", "affirmation", "confirmation", "verification", "proof", "evidence", "support", "backing", "endorsement", "approval", "acceptance", "agreement", "consensus", "unity", "solidarity", "cohesion", "bond", "connection", "link", "tie", "relationship", "partnership", "collaboration", "cooperation", "alliance", "coalition", "federation", "union", "association", "organization", "institution", "establishment", "foundation", "base", "ground", "bedrock", "cornerstone", "pillar", "column", "beam", "support", "brace", "prop", "stay", "anchor", "platform", "stage", "deck", "floor", "ground", "earth", "soil", "land", "terrain", "territory", "domain", "realm", "kingdom", "empire", "dynasty", "reign", "rule", "government", "administration", "management", "leadership", "direction", "guidance", "supervision", "oversight", "monitoring", "surveillance", "watch", "guard", "patrol", "sentry", "lookout", "observation", "inspection", "examination", "investigation", "inquiry", "query", "question", "interrogation", "interview", "consultation", "discussion", "conversation", "dialogue", "chat", "talk", "speech", "address", "lecture", "presentation", "demonstration", "show", "display", "exhibition", "exposition", "fair", "market", "bazaar", "exchange", "trade", "commerce", "industry", "manufacturing", "production", "construction", "building", "architecture", "design", "engineering", "technology", "science", "research", "study", "analysis", "evaluation", "assessment", "appraisal", "estimate", "calculation", "computation", "reckoning", "count", "tally", "score", "grade", "rating", "ranking", "classification", "categorization", "taxonomy", "systematics", "arrangement", "order", "structure", "framework", "infrastructure", "superstructure", "substructure", "preparation", "readiness", "suitability", "appropriateness", "aptness", "qualification", "eligibility", "entitlement", "right", "claim", "title", "ownership", "possession", "property", "belongings", "assets", "resources", "means", "wealth", "riches", "treasure", "fortune", "luck", "chance", "opportunity", "possibility", "potential", "capability", "capacity", "ability", "power", "force", "might", "vigor", "vitality", "spirit", "soul", "heart", "intellect", "intelligence", "wisdom", "knowledge", "understanding", "comprehension", "grasp", "awareness", "consciousness", "perception", "sensation", "feeling", "emotion", "sentiment", "attitude", "disposition", "temperament", "mood", "humor", "temper", "nature", "character", "personality", "psyche", "mentality", "outlook", "perspective", "viewpoint", "opinion", "conviction", "principle", "value", "ethic", "moral", "standard", "norm", "criterion", "benchmark", "yardstick", "measure", "gauge", "indicator", "sign", "signal", "symbol", "token", "mark", "label", "tag", "logo", "icon", "image", "picture", "photo", "portrait", "snapshot", "selfie", "headshot", "profile", "avatar", "display", "screen", "monitor", "view", "window", "frame", "border", "edge", "margin", "padding", "space", "gap", "void", "empty", "blank", "vacant", "hollow", "cavern", "cave", "tunnel", "passage", "corridor", "hallway", "aisle", "lane", "path", "trail", "track", "route", "course", "channel", "canal", "conduit", "pipeline", "tube", "pipe", "hose", "line", "wire", "cable", "cord", "rope", "string", "thread", "fiber", "filament", "strand", "ribbon", "strip", "band", "belt", "strap", "tie", "lace", "chain", "link", "ring", "circle", "loop", "hoop", "arc", "curve", "bend", "turn", "twist", "spin", "roll", "rotation", "revolution", "orbit", "cycle", "round", "circuit", "lap", "trace", "mark", "stripe", "streak", "bar", "rod", "pole", "stick", "staff", "cane", "wand", "baton", "club", "mace", "scepter", "post", "stake", "peg", "pin", "nail", "screw", "bolt", "nut", "washer", "rivet", "fastener", "clip", "clamp", "grip", "hold", "clutch", "clench", "squeeze", "press", "push", "pull", "draw", "drag", "haul", "tug", "tow", "heave", "lift", "raise", "elevate", "hoist", "boost", "propel", "launch", "throw", "toss", "cast", "fling", "hurl", "pitch", "chuck", "lob", "fire", "shoot", "blast", "explode", "detonate", "ignite", "burn", "flame", "blaze", "inferno", "conflagration", "firestorm", "holocaust", "armageddon", "apocalypse", "cataclysm", "catastrophe", "disaster", "tragedy", "calamity", "misfortune", "adversity", "hardship", "difficulty", "struggle", "battle", "fight", "combat", "war", "conflict", "clash", "collision", "crash", "impact", "blow", "hit", "strike", "punch", "kick", "slap", "smack", "whack", "thwack", "bash", "bang", "pop", "snap", "crack", "smash", "shatter", "break", "fracture", "split", "tear", "rip", "shred", "cut", "slice", "dice", "chop", "mince", "grind", "crush", "pound", "mash", "pulp", "puree", "blend", "mix", "stir", "shake", "whisk", "whip", "beat", "fold", "knead", "shape", "mold", "form", "fashion", "model", "sculpt", "carve", "etch", "engrave", "inscribe", "write", "compose", "draft", "draw", "sketch", "design", "plan", "scheme", "plot", "diagram", "chart", "graph", "table", "list", "catalog", "index", "register", "record", "log", "journal", "diary", "account", "chronicle", "history", "story", "tale", "narrative", "report", "article", "essay", "paper", "thesis", "dissertation", "treatise", "monograph", "opus", "work", "creation", "production", "piece", "item", "object", "thing", "entity", "being", "creature", "organism", "lifeform", "specimen", "sample", "example", "instance", "case", "illustration", "demonstration", "exhibit", "show", "presentation", "performance", "act", "action", "deed", "feat", "attainment", "realization", "actualization", "materialization", "manifestation", "embodiment", "incarnation", "personification", "epitome", "quintessence", "essence", "core", "heart", "soul", "spirit", "nature", "character", "quality", "trait", "feature", "attribute", "property", "characteristic", "aspect", "facet", "side", "angle", "standpoint", "stance", "posture", "attitude", "disposition", "temperament", "tone", "spirit", "atmosphere", "ambiance", "environment", "surroundings", "setting", "scene", "backdrop", "background", "context", "situation", "circumstance", "condition", "state", "status", "place", "location", "site", "spot", "point", "station", "post", "base", "camp", "headquarters", "center", "hub", "nexus", "kernel", "nucleus", "seed", "germ", "origin", "source", "root", "cause", "reason", "motive", "motivation", "incentive", "impetus", "stimulus", "provocation", "incitement", "instigation", "prompting", "encouragement", "inspiration", "influence", "effect", "consequence", "result", "outcome", "product", "output", "yield", "return", "profit", "gain", "benefit", "advantage", "edge", "lead", "upper hand", "whip hand", "trump card", "ace", "joker", "wild card", "wildcard", "variable", "factor", "element", "component", "ingredient", "constituent", "part", "segment", "section", "division", "partition", "fragment", "shard", "splinter", "chip", "flake", "crumb", "grain", "particle", "molecule", "atom", "electron", "proton", "neutron", "quark", "boson", "fermion", "lepton", "hadron", "baryon", "meson", "nucleon", "photon", "gluon", "graviton", "neutrino", "axion", "tachyon", "string", "brane", "membrane", "manifold", "dimension", "space", "time", "spacetime", "continuum", "universe", "cosmos", "galaxy", "star", "sun", "planet", "moon", "asteroid", "comet", "meteor", "meteorite", "satellite", "station", "probe", "rover", "lander", "shuttle", "capsule", "module", "pod", "cabin", "compartment", "cockpit", "bridge", "deck", "hold", "bay", "hangar", "silo", "bunker", "shelter", "barracks", "quarters", "dormitory", "hostel", "hotel", "motel", "inn", "lodge", "resort", "spa", "sanatorium", "sanitarium", "infirmary", "surgery", "operating", "theater", "theatre", "auditorium", "arena", "stadium", "colosseum", "amphitheater", "bowl", "dome", "gymnasium", "gym", "court", "field", "pitch", "ground", "circuit", "route", "trail", "way", "road", "street", "avenue", "boulevard", "lane", "drive", "terrace", "place", "circle", "loop", "crescent", "heights", "ridge", "crest", "acme", "culmination", "climax", "highlight", "highpoint", "milestone", "landmark", "watershed", "turning", "tipping", "breaking", "crossing", "threshold", "boundary", "border", "frontier", "limit", "fringe", "periphery", "outskirts", "suburbs", "countryside", "rural", "urban", "city", "town", "village", "hamlet", "settlement", "colony", "outpost", "borderland", "march", "demesne", "estate", "land", "grounds", "premises", "compound", "complex", "facility", "installation", "plant", "works", "factory", "mill", "foundry", "forge", "smithy", "workshop", "studio", "atelier", "shop", "store", "boutique", "emporium", "mart", "market", "fair", "exhibition", "exposition", "display", "show", "demonstration", "presentation", "performance", "production", "staging", "mounting", "installation", "exhibit", "piece", "opus", "creation", "composition", "arrangement", "setting", "scoring", "orchestration", "instrumentation", "adaptation", "transcription", "translation", "interpretation", "rendition", "version", "edition", "variation", "configuration", "layout", "design", "pattern", "template", "model", "prototype", "mockup", "dummy", "placeholder", "stand-in", "substitute", "replacement", "alternative", "option", "choice", "selection", "pick", "preference", "priority", "precedence", "predominance", "preeminence", "paramountcy", "primacy", "hegemony", "monopoly", "oligopoly", "cartel", "syndicate", "trust", "conglomerate", "corporation", "company", "firm", "enterprise", "venture", "undertaking", "endeavor", "attempt", "effort", "try", "shot", "stab", "crack", "go", "whirl", "spin", "turn", "round", "bout", "match", "game", "contest", "competition", "tournament", "championship", "title", "crown", "belt", "strap", "medal", "ribbon", "badge", "insignia", "emblem", "token", "stamp", "seal", "imprint", "impression", "print", "copy", "duplicate", "replica", "reproduction", "facsimile", "likeness", "image", "portrait", "photograph", "snapshot", "shot", "frame", "still", "clip", "segment", "sequence", "series", "succession", "chain", "strand", "thread", "line", "row", "rank", "file", "column", "queue", "lineup", "roster", "roll", "directory", "index", "guide", "manual", "handbook", "textbook", "primer", "reader", "anthology", "collection", "compilation", "compendium", "digest", "summary", "abstract", "synopsis", "outline", "sketch", "draft", "blueprint", "plan", "scheme", "strategy", "tactic", "maneuver", "operation", "exercise", "drill", "practice", "rehearsal", "run-through", "walk-through", "dry", "run", "trial", "test", "exam", "examination", "quiz", "review", "critique", "criticism", "analysis", "study", "research", "investigation", "inquiry", "probe", "inquest", "hearing", "trial", "tribunal", "court", "bench", "bar"];

function handleAsName(handle) {
  if (!handle) return '';
  const clean = handle.replace(/^[@_]+/, '').replace(/[._-]/g, ' ').trim();
  const words = clean.split(' ').filter(w => w.length > 0);
  const firstWord = words[0] || '';
  return firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
}

async function resolveIdentity(page, lead) {
  // Trust harvester-provided full_name; only extract from page if it's missing
  let firstName = lead.full_name || '';

  // 🛡️ Strip hashtags, emojis, and special chars from name
  firstName = firstName.replace(/#\w+/g, '').replace(/[^\w\s'-]/g, '').trim();

  // 🛡️ Reject ALL-CAPS names (brand/page names like "SELF MASTERY", "BOSS BABE")
  const isAllCaps = firstName === firstName.toUpperCase() && firstName.length > 2;

  // 🛡️ Reject stored names that look like handles (e.g. "instacoachmike" instead of "Mike")
  const looksLikeHandle = firstName && /^[a-z._0-9]+$/.test(firstName) && !firstName.includes(' ');

  if (firstName && firstName.length > 1 && !isAllCaps && !looksLikeHandle && !GENERIC_TERMS.includes(firstName.split(' ')[0].toLowerCase())) {
    // Already have a good name from harvester, use it directly
    const clean = firstName.replace(/^Dr\.\s+/i, '').replace(/^Dr\s+/i, '').replace(/^dr/i, '');
    firstName = clean.split(' ')[0];
    return firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
  }

  try {
    // Multi-strategy name extraction from Instagram profile page
    const pageData = await page.evaluate(() => {
      const title = document.title || '';
      const h2s = Array.from(document.querySelectorAll('h2')).map(h => h.innerText.trim()).filter(Boolean);
      const spans = Array.from(document.querySelectorAll('header span, header div')).map(s => s.innerText.trim()).filter(Boolean);
      return { title, h2s, spans };
    });

    // Strategy 1: Title tag — "Nora Stack (@drishtique5t) • Instagram..."
    const titleMatch = pageData.title.match(/^([A-Z][a-z]+)\s+[^@]*\s*\(@/);
    if (titleMatch && titleMatch[1]) {
      firstName = titleMatch[1];
    }

    // Strategy 2: First h2 (usually display name)
    if (!firstName && pageData.h2s.length > 0) {
      const h2 = pageData.h2s[0];
      const h2Word = h2.split(' ')[0];
      if (h2Word && /^[A-Z][a-z]+$/.test(h2Word) && !GENERIC_TERMS.includes(h2Word.toLowerCase())) {
        firstName = h2Word;
      }
    }

    // Strategy 3: First real-looking name in header spans
    if (!firstName) {
      for (const text of pageData.spans) {
        const word = text.split(' ')[0];
        if (word && /^[A-Z][a-z]+$/.test(word) && !GENERIC_TERMS.includes(word.toLowerCase()) && word.length > 1) {
          firstName = word;
          break;
        }
      }
    }

    // Strategy 4: Old bio/header extraction as fallback
    if (!firstName) {
      const bioText = await page.evaluate(() => document.querySelector('header section div:nth-child(2) span')?.innerText || "");
      const headerName = await page.evaluate(() => document.querySelector('header section div:nth-child(1) h2')?.innerText || "");

      const nameMatch = bioText.match(/(?:Dr\.|Dr|I am|Meet|Hi, I'm|Nutritionist|Dermatologist|Dentist|Surgeon|Physician|Coach|Health)\s+([A-Z][a-z]+)/);
      const headerMatch = headerName.match(/(?:Dr\.|Dr|Nutritionist|Dermatologist|Dentist|Coach)\s+([A-Z][a-z]+)/);

      if (headerMatch && headerMatch[1]) {
        firstName = headerMatch[1];
      } else if (nameMatch && nameMatch[1]) {
        firstName = nameMatch[1];
      } else {
        const withMatch = headerName.match(/(?:with|by)\s+([A-Z][a-z]+)/i);
        const possessiveMatch = headerName.match(/^([A-Z][a-z]+)'s\b/i);
        if (withMatch && withMatch[1] && !GENERIC_TERMS.includes(withMatch[1].toLowerCase())) {
          firstName = withMatch[1];
        } else if (possessiveMatch && possessiveMatch[1] && !GENERIC_TERMS.includes(possessiveMatch[1].toLowerCase())) {
          firstName = possessiveMatch[1];
        } else {
          const firstWord = headerName.split(' ')[0];
          if (firstWord && /^[A-Z][a-z]+$/.test(firstWord) && !GENERIC_TERMS.includes(firstWord.toLowerCase())) {
            firstName = firstWord;
          }
        }
      }
    }
  } catch (e) {}

  const isHandle = (firstName.length >= 15 && !firstName.includes(' ')) || /^@/.test(firstName) || (/^[a-z._0-9]+$/.test(firstName) && firstName === (lead.ig_handle || '').replace(/^@/, ''));
  if (!firstName || firstName.toLowerCase() === 'there' || GENERIC_TERMS.includes(firstName.toLowerCase()) || isHandle) {
    firstName = handleAsName(lead?.ig_handle) || 'there';
  }
  return firstName === 'there' ? 'there' : firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
}
// end resolveIdentity

function resolveIdentityFromLead(lead) {
  let firstName = (lead && lead.full_name) || '';

  // 🛡️ Strip hashtags, emojis, and special chars from name
  firstName = firstName.replace(/#\w+/g, '').replace(/[^\w\s'-]/g, '').trim();

  // 🛡️ Reject ALL-CAPS names (brand/page names like "SELF MASTERY", "BOSS BABE")
  const isAllCaps = firstName === firstName.toUpperCase() && firstName.length > 2;
  if (isAllCaps) firstName = '';

  const headerName = firstName;
  const bioText = (lead && lead.bio) || '';

  const nameMatch = bioText.match(/(?:Dr\.|Dr|I am|Meet|Hi, I'm|Nutritionist|Dermatologist|Dentist|Surgeon|Physician|Coach|Health)\s+([A-Z][a-z]+)/);
  const headerMatch = headerName.match(/(?:Dr\.|Dr|Nutritionist|Dermatologist|Dentist|Coach)\s+([A-Z][a-z]+)/);

  if (headerMatch && headerMatch[1]) {
    firstName = headerMatch[1];
  } else if (nameMatch && nameMatch[1]) {
    firstName = nameMatch[1];
  } else {
    const withMatch = headerName.match(/(?:with|by)\s+([A-Z][a-z]+)/i);
    const possessiveMatch = headerName.match(/^([A-Z][a-z]+)'s\b/i);
    if (withMatch && withMatch[1] && !GENERIC_TERMS.includes(withMatch[1].toLowerCase())) {
      firstName = withMatch[1];
    } else if (possessiveMatch && possessiveMatch[1] && !GENERIC_TERMS.includes(possessiveMatch[1].toLowerCase())) {
      firstName = possessiveMatch[1];
    } else {
      const firstWord = headerName.split(' ')[0];
      if (firstWord && /^[A-Z][a-z]+$/.test(firstWord) && !GENERIC_TERMS.includes(firstWord.toLowerCase())) {
        firstName = firstWord;
      } else if (firstName) {
        let clean = firstName.replace(/^Dr\.\s+/i, '').replace(/^Dr\s+/i, '').replace(/^dr/i, '');
        firstName = clean.split(' ')[0];
      }
    }
  }

  const isHandle = (firstName.length >= 15 && !firstName.includes(' ')) || /^@/.test(firstName) || (/^[a-z._0-9]+$/.test(firstName) && firstName === (lead.ig_handle || '').replace(/^@/, ''));
  if (!firstName || firstName.toLowerCase() === 'there' || GENERIC_TERMS.includes(firstName.toLowerCase()) || isHandle) {
    firstName = handleAsName(lead?.ig_handle) || 'there';
  }
  return firstName === 'there' ? 'there' : firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
}

async function acceptCookieConsent(page) {
  try {
    // Check if a cookie consent dialog is blocking the page
    const hasConsent = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      for (const dialog of dialogs) {
        const text = (dialog.textContent || '').toLowerCase();
        if (text.includes('cookie') || text.includes('eväste') || text.includes('allow the use')) {
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (!hasConsent) return;

    log('info', 'CONSENT', 'Cookie consent dialog detected — accepting...');

    // Scroll to bottom of dialog to reveal "Allow all cookies" button, then click it
    const accepted = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      for (const dialog of dialogs) {
        const text = (dialog.textContent || '').toLowerCase();
        if (!text.includes('cookie') && !text.includes('eväste') && !text.includes('allow the use')) continue;

        // Scroll dialog content to bottom
        const scrollable = dialog.querySelector('div[style*="overflow"]') || dialog;
        scrollable.scrollTop = scrollable.scrollHeight;

        // Find and click "Allow all cookies" / "Allow all" / "Salli kaikki"
        const allElements = dialog.querySelectorAll('button, div[role="button"], a, span');
        for (const el of allElements) {
          const elText = (el.textContent || '').trim().toLowerCase();
          if (elText.includes('allow all') || elText.includes('hyväksy kaikki') || elText.includes('salli kaikki')) {
            el.scrollIntoView();
            el.click();
            return true;
          }
        }

        // Fallback: click any button with "allow" or "accept"
        for (const el of allElements) {
          const elText = (el.textContent || '').trim().toLowerCase();
          if (elText === 'allow all cookies' || elText === 'allow all' || elText === 'accept all' || elText === 'salli') {
            el.scrollIntoView();
            el.click();
            return true;
          }
        }
      }
      return false;
    });

    if (accepted) {
      log('info', 'CONSENT', 'Cookie consent accepted');
      await delay(2000);
    } else {
      // Last resort: try clicking the Language SVG at top-right to close the picker part
      const langSvg = page.locator('svg[aria-label="Language"]').first();
      if (await langSvg.isVisible({ timeout: 1000 }).catch(() => false)) {
        const box = await langSvg.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await delay(1000);
        }
      }
      // Try Escape as absolute last resort
      await page.keyboard.press('Escape').catch(() => {});
      await delay(500);
    }
  } catch (e) {}
}

async function purgePopups(page) {
  for (let pass = 0; pass < 5; pass++) {
    try {
      await acceptCookieConsent(page);
      const clicked = await page.evaluate(() => {
        const DISMISS_TEXTS = [
          'not now', 'not now.', 'ei nyt', 'ei nyt.',
          'restore', 'accept', 'hyväksy', 'salli',
          'allow', 'ok', 'close', 'sulje',
          'no thanks', 'no thanks.',
        ];
        const allClickable = document.querySelectorAll(
          'div[role="button"], button, span, a, div[role="dialog"] div[role="button"], div[role="dialog"] button'
        );
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

function humanize(template, lead, firstName, topic, humanizerConfig) {
  if (!template || template.trim().length < 20) {
    return null; // No valid template — skip DM
  }
  let msg = template;
  const hStart = msg.indexOf('/*HUMANIZER:');
  const hEnd = msg.indexOf('*/');
  if (hStart !== -1 && hEnd !== -1) {
    msg = msg.slice(hEnd + 2).trim();
  }
  const isFallback = firstName.toLowerCase() === 'there';

  // Replace variables
  msg = msg.replace(/\{\{name\}\}/g, firstName);
  msg = msg.replace(/\{name\}/g, firstName);
  msg = msg.replace(/\{\{handle\}\}/g, lead.ig_handle);
  msg = msg.replace(/\{handle\}/g, lead.ig_handle);
  msg = msg.replace(/\{\{topic\}\}/g, topic);
  msg = msg.replace(/\{topic\}/g, topic);
  msg = msg.replace(/\{\{industry\/topic\}\}/g, topic);
  msg = msg.replace(/\{industry\/topic\}/g, topic);
  msg = msg.replace(/\{\{followers\}\}/g, (lead.follower_count || '0').toLocaleString());
  
  
  const spintaxRegex = /\{([^\{}|]+\|[^\}]+)\}/g;
  let spintaxMatch;
  while ((spintaxMatch = spintaxRegex.exec(msg)) !== null) {
    const options = spintaxMatch[1].split('|');
    const replacement = options[Math.floor(Math.random() * options.length)];
    msg = msg.slice(0, spintaxMatch.index) + replacement + msg.slice(spintaxMatch.index + spintaxMatch[0].length);
    spintaxRegex.lastIndex = 0;
  }
  
  msg = addTypo(msg, humanizerConfig.typoRate || 0);
  return msg;
}

function jitter(baseMs, variance = 0.3) {
  const jitterAmount = baseMs * variance;
  return baseMs + (Math.random() * jitterAmount * 2) - jitterAmount;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, jitter(ms)));
}

function log(level, event, message) {
  const emojis = { success: '✅', error: '❌', warn: '⚠️', info: '🔵' };
  const emoji = emojis[level] || '🔵';
  const line = `${emoji} [${event}] ${message}`;
  console.log(line);
  // File logging removed — stdout captured by parent process
  logBuffer.push({ level, event, message, created_at: new Date().toISOString() });
}

async function flushLogs() {
  if (logBuffer.length === 0) return;
  const batch = logBuffer.splice(0, logBuffer.length);
  try {
    await supabase.from('engine_logs').insert(
      batch.map(l => ({ workspace_id: config.workspaceId, ...l }))
    );
  } catch (e) {}
}

async function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (e) {
      log('warn', 'STATE', 'Corrupted state.json — starting fresh');
    }
  }
  return { lastLeadId: null, sentToday: 0, lastDate: new Date().toISOString().split('T')[0], paused: false, dmNotifyCount: 0, inboxCursor: null, requestsCursor: null };
}

async function saveState(state) {
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

async function verifySession(context) {
  if (!context) return false;
  const cookies = await context.cookies('https://www.instagram.com');
  const hasSession = cookies.some(c => c.name === 'sessionid');
  if (hasSession) return true;
  // httpOnly sessionid cookies may not be visible via context.cookies() but session still works
  // Check if we have ds_user_id + csrf which means we're authenticated
  const hasUserId = cookies.some(c => c.name === 'ds_user_id');
  const hasCsrf = cookies.some(c => c.name === 'csrf_token' || c.name === 'csrftoken');
  return hasUserId && hasCsrf;
}

async function sendDM(page, handle, fullMessage, lead = null) {
  try {
    // Visit inbox first to clear cookie consent overlay (profile pages trigger it, inbox doesn't)
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);

    const targetUrl = `https://www.instagram.com/${handle}/`;
    log('info', 'TARGET', `Navigating to @${handle}...`);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(3000);

    // Dismiss cookie consent / language dialog if it appeared
    await purgePopups(page);
    await delay(1000);

    // Profile exists check — wait for content to load, then check for explicit error indicators
    await delay(2000); // Extra wait for SPA content to render
    const pageBody = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
    const pageUrl = page.url();
    // Only flag as gone if we see explicit "not available" text OR got redirected to a different profile
    const isExplicit404 = pageBody.includes('this page isn\'t available') || pageBody.includes('Sorry, this page') || pageBody.includes('Page Not Found');
    const isLoginWall = pageUrl.includes('/accounts/login');
    if (isExplicit404) {
      log('warn', 'PROFILE_GONE', `@${handle} does not exist — skipping`);
      return { success: false, error: 'Profile not found' };
    }
    if (isLoginWall) {
      log('error', 'SESSION_LOST', 'Session expired.');
      return { success: false, error: 'Session expired' };
    }

    // Dismiss cookie consent and popups BEFORE clicking anything
    await purgePopups(page);
    await delay(1000);

    // Click Follow if present — native Playwright click, record in DB
    try {
      const followBtn = await page.locator('div[role="button"], button, span').filter({ hasText: /^Follow$/i }).first();
      const isVisible = await followBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (isVisible) {
        await followBtn.click();
        await delay(2000);
        log('info', 'FOLLOW_OK', `Followed @${handle}`);
        if (lead?.id) {
          try {
            await supabase.from('leads').update({
              follow_status: 'followed',
              followed_at: new Date().toISOString(),
              last_updated_at: new Date().toISOString()
            }).eq('id', lead.id);
          } catch (dbErr) {
            log('warn', 'FOLLOW_DB_ERR', dbErr.message);
          }
        }
      }
    } catch (e) {}

    // Click Message button — try compose URL first (most reliable), then button detection
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await delay(500);
    let msgClicked = false;

    // PRIMARY: Navigate to compose screen directly (bypasses fragile button detection)
    log('info', 'CLICK', `Navigating to compose screen for @${handle}`);
    await page.goto(`https://www.instagram.com/direct/new/?username=${handle}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(3000);
    await purgePopups(page);
    await delay(1000);

    // Check if compose screen loaded (has "To" input field)
    const hasComposeInput = await page.locator('input[name="queryBox"], input[placeholder*="Search"], input[aria-label*="To"], input[aria-label*="Search"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (hasComposeInput) {
      msgClicked = true;
      log('info', 'CLICK', 'Compose screen loaded');
    }

    // FALLBACK: If compose didn't load, try Message button on profile
    if (!msgClicked) {
      log('info', 'CLICK', 'Compose failed — trying Message button on profile');
      await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(3000);

      // Synthetic DOM click
      msgClicked = await page.evaluate(() => {
        const MSG_KEYWORDS = ['message', 'send message', 'send a message', 'message request'];
        const matchesMessageButton = (el) => {
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          if (MSG_KEYWORDS.some(k => aria.includes(k))) return true;
          const vis = (el.innerText || el.textContent || '').trim().toLowerCase();
          if (MSG_KEYWORDS.some(k => vis.includes(k))) return true;
          return false;
        };
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
      if (msgClicked) log('info', 'CLICK', 'Clicked Message via synthetic events');
    }

    // FALLBACK 2: Playwright locator
    if (!msgClicked) {
      try {
        const msgLocator = page.locator('div[role="button"], button, span, a').filter({ hasText: /^Message$/ }).first();
        if (await msgLocator.isVisible({ timeout: 5000 }).catch(() => false)) {
          const href = await msgLocator.evaluate(el => el.tagName === 'A' ? el.getAttribute('href') : null).catch(() => null);
          if (href && href.includes('/direct/')) {
            log('info', 'CLICK', `Message is <a> link, navigating to ${href}`);
            await page.goto(`https://www.instagram.com${href}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
            msgClicked = true;
          } else {
            await msgLocator.click({ timeout: 5000 });
            msgClicked = true;
            log('info', 'CLICK', 'Clicked Message via Playwright locator');
          }
        }
      } catch (e) {
        log('info', 'CLICK', `Playwright click failed: ${e.message.substring(0, 60)}`);
      }
    }

    if (!msgClicked) {
      log('warn', 'CLICK', 'Message button not found on profile');
      return { success: false, error: 'Message button not found' };
    }

    log('info', 'CLICK', 'Clicked Message button');
    await delay(3000);

    // Dismiss popups that appear AFTER clicking Message (e.g. "Save your login info?")
    await purgePopups(page);
    await delay(2000);

    // Diagnostic: screenshot + URL after click
    await page.screenshot({ path: `debug_after_click_${handle}.png` }).catch(() => {});
    log('info', 'DEBUG', `URL after click: ${page.url()}`);

    // If we landed on /direct/inbox/ (nav bar link), redirect to compose screen
    if (page.url().includes('/direct/inbox') && !page.url().includes('/direct/t/')) {
      log('info', 'CLICK', `Landed on inbox instead of thread — navigating to compose for @${handle}`);
      await page.goto(`https://www.instagram.com/direct/new/?username=${handle}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await delay(3000);
      await purgePopups(page);
      await delay(1000);
    }

    // If we're still on the profile page, the Message click didn't navigate — try direct URL
    if (page.url().includes(`/${handle}/`) && !page.url().includes('/direct/')) {
      log('info', 'CLICK', `Still on profile after click — navigating to DM directly`);
      const directHref = await page.evaluate(() => {
        for (const a of document.querySelectorAll('a[href*="/direct/"]')) {
          const text = (a.textContent || '').trim().toLowerCase();
          if (text === 'message') return a.getAttribute('href');
        }
        return null;
      }).catch(() => null);

      if (directHref) {
        log('info', 'CLICK', `Found direct link: ${directHref}`);
        await page.goto(`https://www.instagram.com${directHref}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } else {
        log('info', 'CLICK', `No direct link found — trying /direct/new/?username=`);
        await page.goto(`https://www.instagram.com/direct/new/?username=${handle}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
      await delay(3000);
      await purgePopups(page);
      await delay(1000);
    }

    // COMPOSE SCREEN HANDLER: If we're on /direct/new/ (compose screen), complete the flow
    if (page.url().includes('/direct/new')) {
      log('info', 'CLICK', `On compose screen — completing DM flow for @${handle}`);

      const toInput = page.locator('input[name="queryBox"], input[placeholder*="Search"], input[aria-label*="To"], input[aria-label*="Search"]').first();
      if (await toInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await toInput.click();
        await delay(500);
        await toInput.fill('');
        await delay(300);
        await toInput.fill(handle);
        log('info', 'CLICK', `Typed @${handle} in To field`);
        await delay(3000); // Wait for search results to load

        // Check for "No results found" FIRST — before trying to click suggestions
        const noResults = await page.evaluate(() => {
          const text = document.body.innerText || '';
          return text.includes('No results found') || text.includes('no results');
        }).catch(() => false);
        if (noResults) {
          log('warn', 'CLICK', `@${handle} not found in compose search — profile may be private or restricted`);
          return { success: false, error: 'Username not found in compose search' };
        }

        const suggestionClicked = await page.evaluate((username) => {
          for (const el of document.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] button, [role="listbox"] div, [role="dialog"] [role="option"]')) {
            const text = (el.textContent || '').toLowerCase();
            if (text.includes(username.toLowerCase())) {
              el.click();
              return true;
            }
          }
          const firstOption = document.querySelector('[role="listbox"] [role="option"], [role="listbox"] button');
          if (firstOption) { firstOption.click(); return true; }
          return false;
        }, handle).catch(() => false);

        if (suggestionClicked) {
          log('info', 'CLICK', `Selected @${handle} from suggestions`);
          await delay(1000);
        } else {
          log('warn', 'CLICK', `Could not find @${handle} in suggestions`);
        }

        const chatClicked = await page.evaluate(() => {
          for (const btn of document.querySelectorAll('button, div[role="button"]')) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'chat' || text === 'next' || text === 'start chat') {
              btn.click();
              return true;
            }
          }
          return false;
        }).catch(() => false);

        if (chatClicked) {
          log('info', 'CLICK', `Clicked Chat/Next button`);
          await delay(3000);
        } else {
          log('warn', 'CLICK', `Chat/Next button not found`);
        }
      } else {
        log('warn', 'CLICK', `To input not found on compose screen`);
      }
    }

    // Check for cookie consent / dialogs that might block the chat overlay
    const hasDialog = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const texts = [];
      dialogs.forEach(d => texts.push(d.textContent.substring(0, 100)));
      return { count: dialogs.length, texts };
    }).catch(() => ({ count: 0, texts: [] }));
    log('info', 'DEBUG', `Dialogs on page: ${hasDialog.count} — ${hasDialog.texts.map(t => t.replace(/\n/g, ' ').substring(0, 50)).join(' | ')}`);

    // Wait for chat box to appear
    try {
      await Promise.race([
        page.waitForSelector('div[contenteditable="true"], [placeholder*="Message"]', { timeout: 15000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hard_timeout')), 15000))
      ]);
    } catch (_) {
      log('warn', 'HYDRATION', 'Chat box did not appear after Message click');
      // Dump page state for diagnosis
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
      log('info', 'DEBUG', `Page text: ${bodyText.replace(/\n/g, ' | ').substring(0, 300)}`);
      await page.screenshot({ path: `debug_hydration_fail_${handle}.png` }).catch(() => {});
      return { success: false, error: 'Chat box not found' };
    }

    // Dismiss popups AFTER chat box appeared (not before — it kills the chat overlay)
    await purgePopups(page);

    const result = await typeAndSend(page, fullMessage);
    if (result?.success) return { success: true };
    return { success: false, error: result?.error || 'typeAndSend failed' };
  } catch (err) {
    return { success: false, error: err.message.substring(0, 100) };
  }
}

// Wraps sendDM with a hard timeout to prevent indefinite hangs
async function sendDMWithTimeout(page, handle, message, timeoutMs = 90000, lead = null) {
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ success: false, error: 'sendDM timed out' }), timeoutMs)
  );
  return Promise.race([sendDM(page, handle, message, lead), timeout]);
}

let stopRequested = false;

process.on('SIGINT', () => {
  log('warn', 'SHUTDOWN', 'Shutdown requested...');
  stopRequested = true;
});
process.on('SIGTERM', () => {
  log('warn', 'SHUTDOWN', 'SIGTERM received...');
  stopRequested = true;
});

async function sleepWithCancel(ms) {
  const interval = 1000;
  const steps = Math.ceil(ms / interval);
  for (let i = 0; i < steps; i++) {
    if (stopRequested) return;
    await new Promise(r => setTimeout(r, interval));
  }
}

function isScheduleActive() {
  if (!config.scheduleEnabled) return true;
  const now = new Date();
  const tz = config.scheduleTimezone || 'UTC';
  const localHour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }));
  const start = config.scheduleStartHour;
  const end = config.scheduleEndHour;
  if (start === end) return true;
  if (start > end) return localHour >= start || localHour < end;
  return localHour >= start && localHour < end;
}

function buildLaunchOptions(geo, userAgent, config) {
  const locale = geo ? mapCountryToLocale(geo.countryCode) : 'en-US';
  const timezoneId = geo ? geo.timezone : undefined;

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const chromePath = chromePaths.find(p => fs.existsSync(p));

  return {
    headless: true,
    executablePath: chromePath || undefined,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
      '--disable-site-isolation-trials',
      '--disable-infobars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
    userAgent,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    viewport: {
      width: 393,
      height: 852,
    },
    locale,
    timezoneId,
    extraHTTPHeaders: {
      'Accept-Language': `${locale},${locale.split('-')[0]};q=0.9,en-US;q=0.8,en;q=0.7`,
    },
  };
}

async function main() {
  let context = null;
  let page = null;
  let proxyBridge = null;
  const startTime = Date.now();
  let myUsername = 'unknown';

  const state = await loadState();
  // Restore inbox cursor from state
  if (state.inboxCursor) config.inboxCursor = state.inboxCursor;
  if (state.requestsCursor) config.requestsCursor = state.requestsCursor;

  // Migrate warmupStartDate from state.json → DB (one-time, self-healing)
  if (!config.warmupStartDate && state.warmupStartDate) {
    config.warmupStartDate = state.warmupStartDate;
    try { await supabase.from('settings').update({ warmup_start_date: config.warmupStartDate, updated_at: new Date().toISOString() }).eq('workspace_id', config.workspaceId); } catch (e) {}
  }

  // ALWAYS recover warmupStartDate from DB — DB is source of truth, config.json may be stale
  try {
    const { data: dbSettings } = await supabase.from('settings').select('warmup_start_date').eq('workspace_id', config.workspaceId).maybeSingle();
    if (dbSettings?.warmup_start_date) {
      if (config.warmupStartDate && config.warmupStartDate !== dbSettings.warmup_start_date) {
        log('info', 'WARMUP', `DB date (${dbSettings.warmup_start_date}) overrides config.json (${config.warmupStartDate})`);
      }
      config.warmupStartDate = dbSettings.warmup_start_date;
    }
  } catch (e) {}

  let template = config.dmTemplate || '';
  log('info', 'CONFIG_TEMPLATE', `Loaded dmTemplate from config (${template.length} chars): ${template.substring(0, 100) || 'EMPTY'}`);
  let dailyLimit = config.dailyLimit || 30;
  const canAISetter = config.permissions ? config.permissions.canAISetter !== false : true;
  function hasAiKey() { return !!(config.grokApiKey || config.geminiApiKey || process.env.GROK_API_KEY || process.env.GEMINI_API_KEY); }
  function aiSetterShouldRun() { return canAISetter && ((config.aiSetterEnabled === true && hasAiKey()) || config.deterministicFunnel === true); }
  let pulseIntervalMs = (config.pulseIntervalH || 1) * 3600 * 1000;

  let humanizerConfig = {};
  function parseHumanizerConfig(tpl) {
    const cfg = { minDelay: 300, maxDelay: 600, typoRate: 10, pauseAfter: 5 };
    const hStart = tpl.indexOf('/*HUMANIZER:');
    const hEnd = tpl.indexOf('*/');
    if (hStart !== -1 && hEnd !== -1) {
      try { Object.assign(cfg, JSON.parse(tpl.slice(hStart + 12, hEnd))); } catch (e) {}
    }
    return cfg;
  }
  humanizerConfig = parseHumanizerConfig(template);

  let delayMin = (humanizerConfig.minDelay || 300) * 1000;
  let delayMax = (humanizerConfig.maxDelay || 600) * 1000;
  let pauseAfter = humanizerConfig.pauseAfter || 5;

  // Calculate effective limit for logging (Warmup check)
  let logLimit = dailyLimit;
  if (config.warmupEnabled !== false && config.warmupStartDate) {
    const startMs = new Date(config.warmupStartDate).getTime();
    const daysRunning = Math.floor((Date.now() - startMs) / 86400000);
    const progress = Math.min(daysRunning / (config.warmupDurationDays || 14), 1);
    logLimit = Math.min(Math.max(Math.ceil(ABSOLUTE_MAX_DM * (0.3 + 0.7 * progress)), 10), dailyLimit);
  }

  log('info', 'ENGINE_SETTINGS', `Limit: ${logLimit}/day ${logLimit < dailyLimit ? '(Warmup active)' : ''} | Delay: ${delayMin/1000}-${delayMax/1000}s | Pause: every ${pauseAfter} DMs | Typos: ${humanizerConfig.typoRate || 0}%`);
  
  if (config.scheduleEnabled) {
    log('info', 'SCHEDULE', `Active hours: ${config.scheduleStartHour}:00-${config.scheduleEndHour}:00 ${config.scheduleTimezone || 'UTC'}`);
  } else {
    log('info', 'SCHEDULE', 'Schedule disabled — engine runs 24/7');
  }

  
  if (!state.paused) {
    const success = await startBrowserSession();
    if (!success) {
       log('warn', 'BROWSER', 'Browser session start failed, forcing pause state.');
       state.paused = true;
       await saveState(state);
    }
  } else {
    // Always start awake — clear persisted pause flag so engine doesn't stay
    // stuck in deep sleep after a restart. Pause commands from the dashboard
    // will re-pause it on the next pulse if needed.
    log('info', 'BROWSER', 'Clearing persisted pause state — starting awake.');
    state.paused = false;
    await saveState(state);
    const success = await startBrowserSession();
    if (!success) {
       log('warn', 'BROWSER', 'Browser session start failed, forcing pause state.');
       state.paused = true;
       await saveState(state);
    }
  }

  async function startBrowserSession() {
    try {
      let userAgent;
      try {
        if (fs.existsSync(FINGERPRINT_PATH)) {
          const saved = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, 'utf8'));
          userAgent = saved.userAgent;
        }
      } catch (e) {}
      if (!userAgent) {
        const userAgents = [
          'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
          'Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
          'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
        ];
        userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
        try { fs.writeFileSync(FINGERPRINT_PATH, JSON.stringify({ userAgent })); } catch (e) {}
      }

      let geo = null;
      if (config.proxyServer) {
        try {
          log('info', 'STEALTH', 'Detecting proxy location and timezone...');
          geo = await getProxyGeoInfo(config.proxyServer, config.proxyUsername, config.proxyPassword);
          if (geo) {
            log('info', 'STEALTH', `Proxy detected in ${geo.city}, ${geo.country} (${geo.timezone}, code: ${geo.countryCode})`);
          } else {
            log('warn', 'STEALTH', 'Proxy location detection failed — using default timezone/locale');
          }
        } catch (e) {
          log('warn', 'STEALTH', `Proxy check error: ${e.message}`);
        }
      }

      const launchOpts = buildLaunchOptions(geo, userAgent, config);
      if (config.proxyServer) {
        try {
          proxyBridge = await startProxyBridge(config.proxyServer);
          launchOpts.proxy = { server: proxyBridge.localUrl };
          log('info', 'PROXY_BRIDGE', `Bridge on ${proxyBridge.localUrl} routing through ${config.proxyServer}`);
        } catch (e) {
          log('warn', 'PROXY_BRIDGE', `Bridge failed: ${e.message} — using direct proxy`);
          launchOpts.proxy = { server: config.proxyServer };
          if (config.proxyUsername) launchOpts.proxy.username = config.proxyUsername;
          if (config.proxyPassword) launchOpts.proxy.password = config.proxyPassword;
        }
      }
      context = await chromium.launchPersistentContext(SESSION_PATH, launchOpts);
      page = await context.newPage();
      page.on('crash', () => log('error', 'PAGE_CRASH', 'Page crashed (likely SIGSEGV/out-of-memory)'));
      page.on('pageerror', err => log('error', 'PAGE_ERROR', err.message.substring(0, 200)));

      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l', configurable: true });
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
        Object.defineProperty(navigator, 'plugins', { get: () => [], configurable: true });
        Object.defineProperty(navigator, 'mimeTypes', { get: () => [], configurable: true });
        if (!navigator.connection) {
          Object.defineProperty(navigator, 'connection', { get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }), configurable: true });
        }
        if (!window.chrome) { window.chrome = { loadTimes: function() {}, csi: function() {}, app: {} }; }
        const origGetParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {
          if (param === 0x9245) return 'Google Inc. (Qualcomm)';
          if (param === 0x9246) return 'ANGLE (Qualcomm, Qualcomm Adreno (TM) 740, OpenGL ES 3.2)';
          return origGetParameter.call(this, param);
        };
        if (typeof WebGL2RenderingContext !== 'undefined') {
          const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
          WebGL2RenderingContext.prototype.getParameter = function(param) {
            if (param === 0x9245) return 'Google Inc. (Qualcomm)';
            if (param === 0x9246) return 'ANGLE (Qualcomm, Qualcomm Adreno (TM) 740, OpenGL ES 3.2)';
            return origGetParameter2.call(this, param);
          };
        }
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function(type) {
          if (this.width > 16 && this.height > 16) {
            try {
              const ctx = this.getContext('2d');
              if (ctx) {
                const imageData = ctx.getImageData(0, 0, 2, 2);
                for (let i = 0; i < imageData.data.length; i += 4) { imageData.data[i] ^= 1; }
                ctx.putImageData(imageData, 0, 0);
              }
            } catch (e) {}
          }
          return origToDataURL.apply(this, arguments);
        };
        Object.defineProperty(screen, 'width', { get: () => 393, configurable: true });
        Object.defineProperty(screen, 'height', { get: () => 852, configurable: true });
        Object.defineProperty(screen, 'availWidth', { get: () => 393, configurable: true });
        Object.defineProperty(screen, 'availHeight', { get: () => 852, configurable: true });
        Object.defineProperty(screen, 'colorDepth', { get: () => 30, configurable: true });
        Object.defineProperty(screen, 'pixelDepth', { get: () => 30, configurable: true });
        Object.defineProperty(window, 'devicePixelRatio', { get: () => 3, configurable: true });
        Object.defineProperty(window, 'innerWidth', { get: () => 393, configurable: true });
        Object.defineProperty(window, 'innerHeight', { get: () => 852, configurable: true });
        Object.defineProperty(window, 'outerWidth', { get: () => 393, configurable: true });
        Object.defineProperty(window, 'outerHeight', { get: () => 852, configurable: true });
        Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true });
        const origQuery = Permissions.prototype.query;
        Permissions.prototype.query = function(desc) {
          if (desc && desc.name === 'notifications') { return Promise.resolve({ state: 'denied', onchange: null }); }
          return origQuery.call(this, desc);
        };
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { get: function() { return null; } });
        if (window.RTCPeerConnection) {
          const origRTCPeerConnection = window.RTCPeerConnection;
          window.RTCPeerConnection = function(config, constraints) {
            const pc = new origRTCPeerConnection(config, constraints);
            let onIceCandidateHandler = null;
            Object.defineProperty(pc, 'onicecandidate', {
              get: () => onIceCandidateHandler,
              set: (cb) => { onIceCandidateHandler = cb; if (cb) { setTimeout(() => { try { cb({ candidate: null }); } catch(e) {} }, 10); } }
            });
            const origAddEventListener = pc.addEventListener;
            pc.addEventListener = function(type, listener, options) {
              if (type === 'icecandidate') { setTimeout(() => { try { listener({ candidate: null }); } catch(e) {} }, 10); return; }
              return origAddEventListener.apply(this, arguments);
            };
            return pc;
          };
          window.RTCPeerConnection.prototype = origRTCPeerConnection.prototype;
        }
        if (window.webkitRTCPeerConnection) { window.webkitRTCPeerConnection = window.RTCPeerConnection; }
        Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
        Object.defineProperty(navigator, 'languages', { get: () => { const lang = navigator.language || 'en-US'; return [lang, lang.split('-')[0]]; }, configurable: true });
        Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => false, configurable: true });
        Object.defineProperty(navigator, 'cookieEnabled', { get: () => true, configurable: true });
        Object.defineProperty(navigator, 'keyboard', { get: () => undefined, configurable: true });
        if (window.SharedWorker) { Object.defineProperty(window, 'SharedWorker', { get: () => undefined, configurable: true }); }
        ['Bluetooth', 'USB', 'Serial', 'HID'].forEach(function(api) {
          if (navigator[api]) { Object.defineProperty(navigator, api, { get: () => undefined, configurable: true }); }
        });
        Object.defineProperty(screen, 'orientation', { get: () => ({ angle: 0, type: 'portrait-primary', onchange: null }), configurable: true });
        if (window.SpeechRecognition || window.webkitSpeechRecognition) { try { delete window.SpeechRecognition; } catch (e) {} try { delete window.webkitSpeechRecognition; } catch (e) {} }
        Object.defineProperty(window, 'AudioContext', { get: () => undefined, configurable: true });
        Object.defineProperty(window, 'webkitAudioContext', { get: () => undefined, configurable: true });
        Object.defineProperty(window, 'OfflineAudioContext', { get: () => undefined, configurable: true });
        Object.defineProperty(window, 'webkitOfflineAudioContext', { get: () => undefined, configurable: true });
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
          const _origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
          navigator.mediaDevices.enumerateDevices = function() {
            return Promise.resolve([
              { deviceId: 'audio1', kind: 'audioinput', label: 'Microphone', groupId: 'g1' },
              { deviceId: 'audio2', kind: 'audiooutput', label: 'Speaker', groupId: 'g1' },
              { deviceId: 'video1', kind: 'videoinput', label: 'Camera', groupId: 'g1' }
            ]);
          };
        }
        if (!performance.memory) {
          Object.defineProperty(performance, 'memory', { get: () => ({ jsHeapSizeLimit: 2172649472, totalJSHeapSize: 26200000, usedJSHeapSize: 17600000 }), configurable: true });
        }
        Object.defineProperty(window, 'screenX', { get: () => 0, configurable: true });
        Object.defineProperty(window, 'screenY', { get: () => 0, configurable: true });
        Object.defineProperty(window, 'screenLeft', { get: () => 0, configurable: true });
        Object.defineProperty(window, 'screenTop', { get: () => 0, configurable: true });
      });

      if (!await verifySession(context)) {
        const cookiesPath = path.join(path.dirname(process.argv[1]) || __dirname, 'ig_session_cookies.json');
        if (fs.existsSync(cookiesPath)) {
          log('info', 'COOKIE_INJECT', 'No session found — trying cookie backup...');
          try {
            const raw = fs.readFileSync(cookiesPath, 'utf8');
            const cookies = JSON.parse(raw);
            if (Array.isArray(cookies) && cookies.length > 0) {
              const playCookies = cookies.map(c => ({
                name: c.name, value: c.value, domain: c.domain || '.instagram.com', path: c.path || '/',
                expires: c.expires ? Math.floor(c.expires) : undefined, secure: c.secure !== false,
                httpOnly: c.httpOnly || false, sameSite: c.sameSite || 'Lax',
              }));
              await context.addCookies(playCookies);
              if (await verifySession(context)) { log('success', 'COOKIE_INJECT_OK', 'Backup cookies injected — session restored'); }
              else { log('warn', 'COOKIE_INJECT_FAIL', 'Backup cookies exist but did not produce a valid session'); }
            }
          } catch (e) { log('error', 'COOKIE_INJECT', `Failed to inject cookies: ${e.message}`); }
        }
      }

      if (!await verifySession(context)) {
        log('warn', 'ENGINE_NO_SESSION', 'No Instagram session found. Run: node login.cjs');
        if (context) await context.close().catch(() => {});
        if (proxyBridge) proxyBridge.close();
        context = null; page = null; proxyBridge = null;
        return false;
      }

      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(3000);

      // Accept cookie consent on first launch (covers Finnish/GDPR dialogs)
      await acceptCookieConsent(page);
      await delay(2000);

      if (page.url().includes('/accounts/login')) {
        log('error', 'SESSION_REDIRECT', 'Redirected to login — cookies are stale. Run: node login.cjs');
        if (context) await context.close().catch(() => {});
        if (proxyBridge) proxyBridge.close();
        context = null; page = null; proxyBridge = null;
        return false;
      }
      if (!await verifySession(context)) {
        log('error', 'ENGINE_EXPIRED', 'Session expired. Run: node login.cjs');
        if (context) await context.close().catch(() => {});
        if (proxyBridge) proxyBridge.close();
        context = null; page = null; proxyBridge = null;
        return false;
      }

      await delay(20000 + Math.random() * 40000);
      try { await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); }); } catch (e) {}
      await delay(5000 + Math.random() * 10000);

      await delay(3000);
      try {
        myUsername = await page.evaluate(() => {
          const sidebar = document.querySelector('a[href^="/"][href$="/"] img[alt*="profile"]')?.closest('a')?.getAttribute('href')?.replace(/\//g, '');
          const editLink = document.querySelector('a[href*="/accounts/edit"]')?.getAttribute('href')?.split('/')[1];
          return sidebar || editLink || 'unknown';
        });
      } catch (e) { log('warn', 'ENGINE_USER', `Could not resolve username: ${e.message}`); }
      log('info', 'ENGINE_USER', `@${myUsername}`);
      sendTelegram(supabase, `🚀 <b>Engine started</b> — @${myUsername}\nWorkspace: ${config.workspaceName || 'unknown'}\nVersion: ${ENGINE_VERSION}`);

      return true;
    } catch (e) {
      log('error', 'BROWSER_START', `Failed to start browser session: ${e.message}`);
      if (context) await context.close().catch(() => {});
      if (proxyBridge) proxyBridge.close();
      context = null; page = null; proxyBridge = null;
      return false;
    }
  }

  async function stopBrowserSession() {
    log('info', 'DEEP_SLEEP', 'Tearing down browser for deep sleep...');
    try {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (proxyBridge) proxyBridge.close();
    } catch (e) { log('warn', 'DEEP_SLEEP', `Teardown error: ${e.message}`); }
    context = null;
    page = null;
    proxyBridge = null;
    log('info', 'DEEP_SLEEP', 'Browser fully disconnected. Deep sleep active.');
  }

  let pulseCount = 0;
  let paused = false;
  let lastHeartbeat = 0;
  let lastHeartbeatCleanup = 0;
  let heartbeatTimer = null;
  let cycleDmCount = 0;
  let settingsUpdatedAt = '';

  function reloadChangedModules() { /* no-op: hot-reload not needed */ }

  async function refreshLiveConfig() {
    // DB-FIRST: dashboard settings override local config.json. This lets non-technical users
    // update templates, limits, and links via the dashboard without touching files.
    try {
      const { data: s } = await supabase
        .from('settings')
        .select('dm_template, daily_dm_limit, pulse_interval_h, ai_setter_enabled, ai_training_context, niche_tags, warmup_enabled, warmup_duration_days, warmup_start_date, calendly_link, schedule_enabled, schedule_start_hour, schedule_end_hour, schedule_timezone, followup_0_delay, followup_0_template, followup_1_delay, followup_1_template, followup_2_delay, followup_2_template, max_followups, comment_scan_enabled, comment_scan_target, comment_scan_max_followers, telegram_bot_token, telegram_chat_id, gemini_api_key, grok_api_key, framework_link, pre_dm_likes, blueprint_type, conversation_routing_step, conversation_steps, conversation_enabled, deterministic_funnel, unfollow_enabled, unfollow_after_days, daily_unfollow_limit, ai_client_feedback')
        .eq('workspace_id', config.workspaceId)
        .maybeSingle();
      if (!s) return false;

      let changed = false;
      const oldTemplate = template;

      if (s.dm_template && s.dm_template.trim().length >= 20 && s.dm_template !== template) {
        template = s.dm_template;
        config.dmTemplate = s.dm_template;
        changed = true;
      }
      if (s.daily_dm_limit > 0) {
        dailyLimit = s.daily_dm_limit;
        config.dailyLimit = s.daily_dm_limit;
      }
      if (s.pulse_interval_h > 0) {
        pulseIntervalMs = s.pulse_interval_h * 3600 * 1000;
        config.pulseIntervalH = s.pulse_interval_h;
      }
      if (s.ai_setter_enabled !== undefined) config.aiSetterEnabled = s.ai_setter_enabled;
      if (s.ai_training_context) config.aiTrainingContext = s.ai_training_context;
      if (s.ai_client_feedback !== undefined && s.ai_client_feedback !== null) config.aiClientFeedback = s.ai_client_feedback;
      if (s.niche_tags) config.nicheTags = s.niche_tags;
      if (s.warmup_enabled !== undefined) config.warmupEnabled = s.warmup_enabled;
      if (s.warmup_duration_days > 0) config.warmupDurationDays = s.warmup_duration_days;
      if (s.warmup_start_date) config.warmupStartDate = s.warmup_start_date;
      if (s.calendly_link) config.calendlyLink = s.calendly_link;
      if (s.schedule_enabled !== undefined) config.scheduleEnabled = s.schedule_enabled;
      if (s.schedule_start_hour !== undefined && s.schedule_start_hour !== null) config.scheduleStartHour = s.schedule_start_hour;
      if (s.schedule_end_hour !== undefined && s.schedule_end_hour !== null) config.scheduleEndHour = s.schedule_end_hour;
      if (s.schedule_timezone) config.scheduleTimezone = s.schedule_timezone;
      if (s.followup_0_delay > 0) config.followupDelays = [s.followup_0_delay, s.followup_1_delay ?? 5, s.followup_2_delay ?? 7];
      if (s.followup_0_template !== undefined) config.followupTemplates = [s.followup_0_template || '', s.followup_1_template || '', s.followup_2_template || ''];
      if (s.max_followups !== undefined && s.max_followups !== null) config.maxFollowups = s.max_followups;
      if (s.comment_scan_enabled !== undefined) config.commentScanEnabled = s.comment_scan_enabled;
      if (s.comment_scan_target) config.commentScanTarget = s.comment_scan_target;
      if (s.comment_scan_max_followers !== undefined) config.commentScanMaxFollowers = s.comment_scan_max_followers;
      if (s.telegram_bot_token) config.telegramBotToken = s.telegram_bot_token;
      if (s.telegram_chat_id) config.telegramChatId = s.telegram_chat_id;
      if (s.gemini_api_key) config.geminiApiKey = s.gemini_api_key;
      if (s.grok_api_key) config.grokApiKey = s.grok_api_key;
      if (s.framework_link) config.frameworkLink = s.framework_link;
      if (s.pre_dm_likes !== undefined) config.preDmLikes = s.pre_dm_likes;
      if (s.blueprint_type) config.blueprintType = s.blueprint_type;
      if (s.conversation_routing_step !== undefined && s.conversation_routing_step !== null) config.conversationRoutingStep = s.conversation_routing_step;
      if (s.conversation_steps) config.conversationSteps = s.conversation_steps;
      if (s.conversation_enabled !== undefined && s.conversation_enabled !== null) config.conversationEnabled = s.conversation_enabled;
      if (s.deterministic_funnel !== undefined && s.deterministic_funnel !== null) config.deterministicFunnel = s.deterministic_funnel;
      if (s.unfollow_enabled !== undefined && s.unfollow_enabled !== null) config.unfollowEnabled = s.unfollow_enabled;
      if (s.unfollow_after_days > 0) config.unfollowAfterDays = s.unfollow_after_days;
      if (s.daily_unfollow_limit > 0) config.dailyUnfollowLimit = s.daily_unfollow_limit;

      if (changed) {
        humanizerConfig = parseHumanizerConfig(template);
        delayMin = (humanizerConfig.minDelay || 300) * 1000;
        delayMax = (humanizerConfig.maxDelay || 600) * 1000;
        pauseAfter = humanizerConfig.pauseAfter || 5;
        log('info', 'CONFIG_REFRESH', `Template updated from DB (${oldTemplate.length} → ${template.length} chars)`);
      }
      return changed;
    } catch (e) {
      log('warn', 'CONFIG_REFRESH', `Failed: ${e.message}`);
      return false;
    }
  }

  // ── Engine command checker (used by heartbeat + pulse) ──
  // Batches all pending commands, processes non-destructive ones immediately,
  // then takes a single final action (update/shutdown) — stacking is harmless.
  async function checkEngineCommands() {
    try {
      const { data: unacked } = await supabase
        .from('engine_commands')
        .select('id, command, payload')
        .eq('workspace_id', config.workspaceId)
        .is('acknowledged_at', null)
        .order('created_at', { ascending: true });

      if (!unacked || unacked.length === 0) return false;

      let finalExitCode = null;

      for (const cmd of unacked) {
        if (stopRequested && cmd.command !== 'hard_kill' && cmd.command !== 'update' && cmd.command !== 'start' && cmd.command !== 'restart' && cmd.command !== 'shutdown') continue;

        if (cmd.command === 'stop' && !paused) {
          paused = true;
          state.paused = true;
          const s = await loadState();
          s.paused = true;
          await saveState(s);
          log('info', 'PAUSED', 'Outreach paused by dashboard command');
        } else if (cmd.command === 'start' && paused) {
          paused = false;
          state.paused = false;
          await refreshLiveConfig();
          const s = await loadState();
          s.paused = false;
          await saveState(s);
          const success = await startBrowserSession();
          if (!success) {
            paused = true;
            state.paused = true;
            s.paused = true;
            await saveState(s);
            log('error', 'RESUME_FAILED', 'Failed to resume outreach (session likely expired). Engine re-paused.');
          } else {
            log('info', 'RESUMED', 'Outreach resumed by dashboard command');
          }
        } else if (cmd.command === 'health') {
          log('info', 'HEALTH_CHECK', 'Health check requested from dashboard...');
          try {
            let hasSession = false;
            if (context) {
              const cookies = await context.cookies('https://www.instagram.com');
              hasSession = cookies.some(c => c.name === 'sessionid');
            }
            const res = {
              workspace_id: config.workspaceId,
              session_valid: hasSession,
              browser_active: !!page,
              last_check_at: new Date().toISOString()
            };
            await supabase.from('engine_health_reports').insert(res);
            log('success', 'HEALTH_REPORT', `Report sent to dashboard (Session: ${hasSession ? 'OK' : 'EXPIRED'}, Browser: ${!!page ? 'OK' : 'OFFLINE'})`);
          } catch (e) {
            log('error', 'HEALTH_ERR', e.message);
          }
        } else if (cmd.command === 'update') {
          log('info', 'REMOTE_UPDATE', 'Downloading updated engine files in-process...');
          let updated = false;
          let latestVersion = '';
          try {
            const DASHBOARD_URL = 'https://founderflow-dashboard.vercel.app';
            const VERSION_FILE = path.resolve(__dirname, '.version');
            const verController = new AbortController();
            const verTimeout = setTimeout(() => verController.abort(), 10000);
            const verRes = await fetch(`${DASHBOARD_URL}/api/version`, { signal: verController.signal });
            clearTimeout(verTimeout);
            if (verRes.ok) {
              const body = await verRes.json();
              latestVersion = body.version;
              let currentVersion = '';
              if (fs.existsSync(VERSION_FILE)) currentVersion = fs.readFileSync(VERSION_FILE, 'utf8').trim();
              if (latestVersion && latestVersion !== currentVersion) {
                const files = ['engine.cjs', 'ai_setter.cjs', 'sender.cjs', 'inject_cookies.cjs', 'ghost.cjs', 'start.cjs', 'login.cjs', 'watchdog.cjs', 'package.json'];
                let allOk = true;
                for (const file of files) {
                  try {
                    const fController = new AbortController();
                    const fTimeout = setTimeout(() => fController.abort(), 15000);
                    const fRes = await fetch(`${DASHBOARD_URL}/api/engine-file/${file}?engine_update=1&workspace_id=${config.workspaceId}`, { signal: fController.signal });
                    clearTimeout(fTimeout);
                    if (!fRes.ok) { allOk = false; continue; }
                    const content = await fRes.text();
                    if (content.trim().startsWith('<') || content.length < 20) { allOk = false; continue; }
                    fs.writeFileSync(path.resolve(__dirname, file), content, 'utf-8');
                  } catch (e) { allOk = false; }
                }
                if (allOk) {
                  fs.writeFileSync(VERSION_FILE, latestVersion);
                  log('success', 'REMOTE_UPDATE', `Updated to ${latestVersion}`);
                  updated = true;
                }
              }
            }
          } catch (e) {
            log('error', 'REMOTE_UPDATE', `In-process update failed: ${e.message}`);
          }
          if (updated) {
            log('success', 'REMOTE_UPDATE', `Updated to ${latestVersion} — restarting in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            process.exit(0);
          } else {
            log('warn', 'REMOTE_UPDATE', 'In-process download incomplete');
          }
        } else if (cmd.command === 'shutdown') {
          log('info', 'SHUTDOWN', 'Shutdown queued — will stop after processing all pending commands');
          finalExitCode = 0;
        } else if (cmd.command === 'hard_kill') {
          log('error', 'HARD_KILL', 'Kill switch activated from dashboard');
          finalExitCode = 6;
        } else if (cmd.command === 'force_reply') {
          try {
            const payload = cmd.payload || {};
            const handle = payload.handle || '';
            const message = payload.message || '';
            if (handle && message && page) {
              // Safety guard: only send if handle exists in leads table for this workspace
              const { data: leadCheck } = await supabase
                .from('leads')
                .select('id')
                .eq('workspace_id', config.workspaceId)
                .eq('ig_handle', handle)
                .limit(1);
              if (!leadCheck || leadCheck.length === 0) {
                log('warn', 'FORCE_REPLY', `@${handle} not in leads table — skipping to prevent spam to non-leads`);
              } else {
                log('info', 'FORCE_REPLY', `Dashboard-commanded reply to @${handle}...`);
                const result = await sendDMWithTimeout(page, handle, message);
                if (result.success) {
                  log('success', 'FORCE_REPLY', `Force reply sent to @${handle}`);
                  await supabase.from('outbox').insert({
                    workspace_id: config.workspaceId,
                    message,
                    status: 'force_replied',
                    sent_at: new Date().toISOString()
                  }).then(() => {}, () => {});
                } else {
                  log('error', 'FORCE_REPLY', `Failed to send to @${handle}: ${result.error}`);
                }
              }
            }
          } catch (e) {
            log('error', 'FORCE_REPLY', e.message);
          }
        } else if (cmd.command === 'reload_settings') {
          log('info', 'RELOAD_SETTINGS', 'Dashboard changed settings — reloading config and running AI Setter');
          await refreshLiveConfig();
          reloadChangedModules();
    if (aiSetterShouldRun() && state.firstPulseDone) {
            if (!paused && page && context) { await checkAndReply(page, supabase, config, context); }
            // Persist inbox cursor to state
            try {
              const s = await loadState();
              s.inboxCursor = config.inboxCursor || null;
              s.requestsCursor = config.requestsCursor || null;
              await saveState(s);
            } catch (e) {}
          }
        }
      }

      // Acknowledge ALL pending commands at once (avoids stale looping)
      const ids = unacked.map(c => c.id);
      await supabase.from('engine_commands').update({ acknowledged_at: new Date().toISOString() }).in('id', ids);

      // Single destructive action (last one wins — stacking is safe)
      if (finalExitCode !== null) {
        log('info', 'COMMIT', finalExitCode === 5 ? 'Self-update restart' : finalExitCode === 0 ? 'Shutdown' : 'Hard kill');
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        process.exit(finalExitCode);
      }

      return true;
    } catch (e) {}
  }

  // Heartbeat + config refresh + command check every 30s (dashboard changes picked up within 30s)
  let lastStatusNotify = Date.now();
  const STATUS_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  heartbeatTimer = setInterval(async () => {
    await sendHeartbeat(supabase, config.workspaceId, paused, ENGINE_VERSION);
    const configChanged = await refreshLiveConfig();
    if (configChanged && aiSetterShouldRun()) {
      if (!paused && page && context) {
        reloadChangedModules();
        log('info', 'CONFIG_CHANGED', 'Settings updated in dashboard — running AI Setter immediately');
        try { await checkAndReply(page, supabase, config, context); } catch (e) { log('warn', 'AISETTER_ERR', e.message); }
      }
    }
    // Periodic status notification every 15 minutes
    if (Date.now() - lastStatusNotify >= STATUS_INTERVAL_MS) {
      lastStatusNotify = Date.now();
      const uptimeMin = Math.round((Date.now() - startTime) / 60000);
      const status = paused ? 'Paused' : 'Running';
      let replyCount = '?';
      try {
        const today = new Date().toISOString().slice(0, 10);
        const { count } = await supabase.from('outbox').select('id', { count: 'exact', head: true })
          .eq('workspace_id', config.workspaceId)
          .gte('sent_at', today + 'T00:00:00Z');
        replyCount = count || 0;
      } catch (e) {}
      sendTelegram(supabase, `💚 <b>${status}</b> — @${myUsername}\nUptime: ${uptimeMin} min\nReplies today: ${replyCount}\nVersion: ${ENGINE_VERSION}`);
    }
    await flushLogs();
    await checkEngineCommands();
  }, 30000);

  // Fresh config on startup — pick up Gemini API key and latest settings immediately
  await refreshLiveConfig();

  // Warm sleep: periodically browse Instagram feed during pulse breaks to keep session alive
  async function warmSleep(ms) {
    const warmMin = () => 15 + Math.floor(Math.random() * 11);
    let nextWarmMin = warmMin();
    const totalMin = Math.ceil(ms / 60000);

    for (let min = 0; min < totalMin; min++) {
      if (stopRequested) return;

      if (min >= nextWarmMin) {
        try {
          await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await delay(2000 + Math.random() * 3000);

          if (page.url().includes('/accounts/login')) {
            log('warn', 'WARM', 'Redirected to login during warm browse');
          } else {
            const scrolls = 2 + Math.floor(Math.random() * 3);
            for (let s = 0; s < scrolls; s++) {
              await page.evaluate(() => window.scrollBy(0, 300 + Math.random() * 700)).catch(() => {});
              await delay(2000 + Math.random() * 4000);
            }
            log('info', 'WARM', `Feed browsed (${scrolls} scrolls) — session kept warm`);
          }
        } catch (e) {
          log('warn', 'WARM', `Browse failed: ${e.message}`);
          try { await page.close().catch(() => {}); } catch (_) {}
          try { page = await context.newPage(); } catch (_) {}
        }
        nextWarmMin += warmMin();
      }

      await sleepWithCancel(60000);
    }
  }

  let sent = 0;

  while (!stopRequested) {
    // State already loaded at startup

    // Sync paused state from disk (survives crash/reboot)
    if (state.paused) paused = true;

    const today = new Date().toISOString().split('T')[0];
    if (state.lastDate !== today) {
      state.sentToday = 0;
      state.lastDate = today;
      await saveState(state);
    }

    // ── Check engine commands at pulse start too (belt + suspenders) ──
    await checkEngineCommands();

    // ── If paused, fast-loop (heartbeat + command check every 10s) ──
    if (paused) {
      if (context) {
        await stopBrowserSession();
      }
      await sendHeartbeat(supabase, config.workspaceId, true, ENGINE_VERSION);
      await sleepWithCancel(10000);
      continue;
    }

    // ── Schedule-based deep sleep ──
    if (!paused && !isScheduleActive()) {
      if (context) {
        await stopBrowserSession();
      }
      await sendHeartbeat(supabase, config.workspaceId, false, ENGINE_VERSION, true);
      await checkEngineCommands();
      log('info', 'SCHEDULE_SLEEP', `Outside active hours (${config.scheduleStartHour}:00-${config.scheduleEndHour}:00 ${config.scheduleTimezone || 'UTC'}) — sleeping 10min`);
      await sleepWithCancel(600000);
      continue;
    }

    // Live config refresh every pulse so dashboard setting changes take effect immediately
    pulseCount++;
    await refreshLiveConfig();
    if (pulseCount % 10 === 0) {
      
      // 🛡️ Periodic Auto-Update Check:
      // Pings the dashboard to see if new code was pushed.
      // Also fetches the current Gemini API key for AI Setter.
      try {
        log('info', 'VERSION_CHECK', 'Checking for engine updates...');
        const res = await fetch(`https://founderflow-dashboard.vercel.app/api/version`);
        if (res.ok) {
          const body = await res.json();
          const latestVersion = body.version;
          if (body.geminiApiKey !== undefined) config.geminiApiKey = body.geminiApiKey || '';
          if (body.grokApiKey !== undefined) config.grokApiKey = body.grokApiKey || '';
          if (latestVersion) {
            let currentVersion = '';
            const versionFile = path.resolve(__dirname, '.version');
            if (fs.existsSync(versionFile)) {
              currentVersion = fs.readFileSync(versionFile, 'utf8').trim();
            }
            if (latestVersion !== currentVersion) {
              log('info', 'VERSION_CHECK', `Update available: ${latestVersion} (current: ${currentVersion || 'unknown'})`);
              log('info', 'VERSION_CHECK', 'NEVER restart — engine will continue running. New files applied on next container start.');
            }
          }
        }
      } catch (e) {
        log('warn', 'VERSION_CHECK', `Version check failed: ${e.message}`);
      }
    }

    if (aiSetterShouldRun()) {
      // Page health check before AI setter — dead page = inbox API returns empty
      try { await page.evaluate(() => 1); } catch (_) {
        log('warn', 'AISETTER_PRE', 'Page dead before AI setter — recovering...');
        try {
          try { await page.close().catch(() => {}); } catch (_) {}
          page = await context.newPage();
          await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await delay(5000);
        } catch (e) {
          log('error', 'AISETTER_PRE', 'Could not recover page for AI setter — skipping this pulse');
        }
      }
      reloadChangedModules();
      try { await checkAndReply(page, supabase, config, context); } catch (e) { log('warn', 'AISETTER_ERR', e.message); }
      // Persist inbox cursor to state
      try {
        const s = await loadState();
        s.inboxCursor = config.inboxCursor || null;
        s.requestsCursor = config.requestsCursor || null;
        await saveState(s);
      } catch (e) {}
    }

    // Close and recreate page after AI Setter — inbox DOM scan corrupts the React SPA context.
    // A simple page.goto can hang forever on a corrupted page even with a timeout.
    try { await page.close().catch(() => {}); } catch (_) {}
    try {
      page = await context.newPage();
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(3000);
    } catch (e) { log('warn', 'PAGE_RESET', `Post-AI-setter page reset failed: ${e.message}`); }

    // Warmup: ramp from 30% → 100% of ABSOLUTE_MAX_DM over warmupDurationDays
    const warmupEnabled = config.warmupEnabled !== false;
    const warmupDuration = config.warmupDurationDays || 14;
    let effectiveLimit = Math.min(dailyLimit, ABSOLUTE_MAX_DM);
    if (warmupEnabled) {
      const startMs = config.warmupStartDate ? new Date(config.warmupStartDate).getTime() : 0;
      const daysRunning = (startMs && !isNaN(startMs)) ? Math.floor((Date.now() - startMs) / 86400000) : 0;
      const progress = Math.min(daysRunning / warmupDuration, 1);
      const warmupTarget = Math.max(Math.ceil(ABSOLUTE_MAX_DM * (0.3 + 0.7 * progress)), 10);
      effectiveLimit = Math.min(warmupTarget, dailyLimit, ABSOLUTE_MAX_DM);
      if (state.sentToday < effectiveLimit && state._dailyResetDone) {
        state._dailyResetDone = false;
        await saveState(state);
      }
      if (state.sentToday >= effectiveLimit) {
        if (!state._dailyResetDone) {
          log('warn', 'WARMUP', `Warmup cap: ${effectiveLimit}/${ABSOLUTE_MAX_DM} (day ${daysRunning}/${warmupDuration})`);
          state._dailyResetDone = true;
          await saveState(state);
          try { await page.close().catch(() => {}); } catch (_) {}
          try {
            page = await context.newPage();
            await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(5000);
          } catch (e) { log('warn', 'MEMORY', `Daily page reset failed: ${e.message}`); }
        }
        await sleepWithCancel(pulseIntervalMs);
        continue;
      }
    } else if (state.sentToday >= effectiveLimit) {
      if (state.sentToday === effectiveLimit) {
        log('warn', 'ENGINE_LIMIT', `Daily limit reached (${state.sentToday}/${effectiveLimit})`);
        try { await supabase.from('engine_alerts').insert({ workspace_id: config.workspaceId, alert_type: 'daily_limit_hit', message: `Daily DM limit reached (${effectiveLimit}). Sleeping until tomorrow.` }); } catch (e) {}
        state.sentToday++;
        await saveState(state);
        // Reset page once daily to release accumulated Instagram SPA memory
        try { await page.close().catch(() => {}); } catch (_) {}
        try {
          page = await context.newPage();
          await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await delay(5000);
        } catch (e) { log('warn', 'MEMORY', `Daily page reset failed: ${e.message}`); }
      }
      await sleepWithCancel(pulseIntervalMs);
      continue;
    }

    // Check trial/account status — query live so expired clients get stopped even mid-run
    try {
      const { data: livePerms } = await supabase
        .from('client_permissions')
        .select('status')
        .eq('user_id', config.userId)
        .eq('workspace_id', config.workspaceId)
        .limit(1)
        .maybeSingle()
      if (livePerms && (livePerms.status === 'expired' || livePerms.status === 'suspended')) {
        log('error', 'ACCOUNT_EXPIRED', `Account ${livePerms.status}. Stopping engine.`);
        break;
      }
    } catch (e) {}

  // Heartbeat — mark engine as alive (sent every pulse)
  await sendHeartbeat(supabase, config.workspaceId, false, ENGINE_VERSION);

  // Heartbeat cleanup handled by periodic 7-day prune in main loop below
  try {
    if (!await verifySession(context)) {
      log('error', 'SESSION_LOST', 'Session expired. Stopping.');
      break;
    }
  } catch (e) {
    log('error', 'SESSION_LOST', `Session check failed: ${e.message}`);
    break;
  }

  // Check browser is still alive — single recovery attempt if page crashed
  // Timeout race: page.evaluate can hang on corrupted pages, so we race it against a 10s timer
    try {
      await Promise.race([
        page.evaluate(() => 1),
        new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate timeout')), 10000))
      ]);
    } catch (e) {
      log('warn', 'RECOVERY', `Page health check failed (${e.message}) — creating new tab...`);
      try {
        try { await page.close().catch(() => {}); } catch (_) {}
        page = await context.newPage();
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(5000);
        log('success', 'RECOVERY', 'New tab opened — continuing');
      } catch (e2) {
        log('error', 'BROWSER_LOST', 'Browser fully dead. Stopping.');
        break;
      }
    }

    // Reset page to clean state before DM loop — prevents React SPA crash after AI Setter
    try { await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); } catch (e) {}
    await delay(3000);

    // Second browser health check — harvest or AI Setter may have crashed the page
    try { await page.evaluate(() => 1); } catch (e) {
      log('warn', 'PRE_DM_RECOVERY', 'Page crashed — creating new tab before DM loop...');
      try {
        page = await context.newPage();
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(5000);
        log('success', 'PRE_DM_RECOVERY', 'New tab opened — DM loop can proceed');
      } catch (e2) {
        log('error', 'BROWSER_LOST', 'Browser fully dead. Stopping.');
        break;
      }
    }

    let query = supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', config.workspaceId)
      .in('status', ['discovered', 'verified'])
      .order('discovered_at', { ascending: true })
      .limit(100);

    if (state.lastCursor) {
      query = query.gte('discovered_at', state.lastCursor);
    }

    let { data: leads, error: leadsErr } = await query;

    if (leadsErr || !leads) {
      log('error', 'DM_QUERY_ERR', `Lead query with order/limit failed: ${leadsErr?.message || 'null data'} — retrying without order`);
      let fb = supabase.from('leads').select('*').eq('workspace_id', config.workspaceId).in('status', ['discovered', 'verified']);
      if (state.lastCursor) {
        fb = fb.gte('discovered_at', state.lastCursor);
      }
      const fbResult = await fb;
      leads = fbResult.data;
      if (fbResult.error || !leads) {
        log('error', 'DM_QUERY_ERR', `Fallback query also failed: ${fbResult.error?.message || 'null data'}`);
      }
    }

    // CURSOR RECOVERY: if 0 leads found and cursor is set, it may be stuck ahead of all leads — clear and retry
    if (leads && leads.length === 0 && state.lastCursor) {
      log('warn', 'CURSOR_RECOVERY', `0 leads with lastCursor=${state.lastCursor} — clearing cursor and retrying`);
      delete state.lastCursor;
      delete state.lastLeadId;
      await saveState(state);
      let retryQuery = supabase
        .from('leads')
        .select('*')
        .eq('workspace_id', config.workspaceId)
        .in('status', ['discovered', 'verified'])
        .order('discovered_at', { ascending: true })
        .limit(100);
      const retryResult = await retryQuery;
      leads = retryResult.data;
      if (retryResult.error) {
        log('error', 'DM_QUERY_ERR', `Cursor recovery query failed: ${retryResult.error.message}`);
      } else if (leads && leads.length > 0) {
        log('success', 'CURSOR_RECOVERY', `Cursor cleared — found ${leads.length} leads without cursor filter`);
      }
    }

    // Filter out leads already processed this pulse session (prevents repeats on same timestamp)
    if (state.lastLeadId && leads) {
      const lastIndex = leads.findIndex(l => l.id === state.lastLeadId);
      if (lastIndex !== -1 && lastIndex < leads.length - 1) {
        leads = leads.slice(lastIndex + 1);
      } else if (lastIndex === leads.length - 1) {
        leads = []; // Batch finished
      }
    }

    sent = state.sentToday;

    sentThisPulse = 0;
    followupsSentThisPulse = 0;
    const dmSentThisPulse = new Set(); // Track leads DM'd this pulse to prevent follow-up in same pulse

    if (leads && leads.length > 0) {
      log('info', 'ENGINE_LEADS', `${leads.length} leads. Starting...`);

    for (const lead of leads) {
      if (stopRequested) break;
      const cap = effectiveLimit;
      if (sent >= cap) {
        log('warn', 'ENGINE_LIMIT', `Limit reached (${sent}/${cap})`);
        break;
      }

      try { // Wrap entire DM iteration in try/catch to prevent crash

      log('info', 'ENGINE_DM', `@${lead.ig_handle}`);

      // Page health check — recreate if dead from previous iteration
      if (!page) {
        log('warn', 'HEALTH_CHECK', 'Page is null — creating new page...');
        try {
          page = await context.newPage();
          await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await delay(5000);
        } catch (e) {
          log('warn', 'HEALTH_CHECK', 'Could not create page — skipping lead.');
          continue;
        }
      }
      try { await page.evaluate(() => 1); } catch (_) {
        log('warn', 'HEALTH_CHECK', 'Page dead at start of iteration — creating new page...');
        try {
          page = await context.newPage();
          await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await delay(5000);
        } catch (e) {
          log('warn', 'HEALTH_CHECK', 'Could not recreate page — skipping lead, next iteration will retry.');
          continue;
        }
      }

      // Resolve real name and topic from profile page every time (slower but safer)
      let firstName;
      let leadTopic = 'your work';
      try {
        await page.goto(`https://www.instagram.com/${lead.ig_handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(2000);
        firstName = await resolveIdentity(page, lead);
        const pageBio = await page.evaluate(() => {
          const meta = document.querySelector('meta[name="description"]');
          if (!meta) return '';
          const content = meta.getAttribute('content') || '';
          const match = content.match(/on Instagram:\s*"([^"]+)"/);
          return match ? match[1] : '';
        });
        if (pageBio) {
          lead.bio = pageBio;
          const nicheKeywords = config.nicheTags || ['doctor', 'medical', 'health'];
          for (const kw of nicheKeywords) {
            if (pageBio.toLowerCase().includes(kw.toLowerCase())) {
              leadTopic = kw;
              break;
            }
          }
        }
      } catch (e) {
        log('warn', 'PROFILE_ERR', `Could not load profile for @${lead.ig_handle}: ${e.message}`);
        firstName = resolveIdentityFromLead(lead);
      }
      log('info', 'IDENTITY', `Resolved: ${firstName} (topic: ${leadTopic})`);

      log('info', 'DM_TEMPLATE', `Using template (${template?.length || 0} chars): ${template?.substring(0, 80) || 'EMPTY'}`);

      const isDryRun = process.argv.includes('--dry');
      const message = humanize(template, lead, firstName, leadTopic, humanizerConfig);
      
      if (!message) {
        log('warn', 'SKIP_NO_TEMPLATE', `@${lead.ig_handle} skipped — dmTemplate is empty`);
        continue;
      }
      
      let result;
      if (isDryRun) {
        log('info', 'DRY_RUN', `[SIMULATED] Would send to @${lead.ig_handle}: "${message.substring(0, 50)}..."`);
        await delay(3000);
        result = { success: true };
      } else {
        result = await sendDMWithTimeout(page, lead.ig_handle, message, 90000, lead);
      }

        if (result.success) {
          if (isDryRun) {
            log('success', 'DRY_RUN_OK', `Simulated outreach to @${lead.ig_handle} successful.`);
          } else {
            try {
              await supabase.from('outbox').insert({
                workspace_id: config.workspaceId,
                lead_id: lead.id,
                message,
                status: 'sent',
                sent_at: new Date().toISOString()
              });
              await supabase.from('leads').update({ status: 'dm_sent', last_dm_sent_at: new Date().toISOString(), last_updated_at: new Date().toISOString() }).eq('id', lead.id);
            } catch (e) {
              log('warn', 'OUTBOX_ERR', e.message);
            }
          }

        sent++;
        sentThisPulse++;
        dmSentThisPulse.add(lead.id);
            state.lastCursor = lead.discovered_at;
            delete state.lastLeadId;
            state.sentToday = sent;
        state.paused = paused; // sync in-memory paused flag before persisting
        // Track warmup start on first successful DM (persisted in DB, not state.json)
        if (!config.warmupStartDate) {
          config.warmupStartDate = new Date().toISOString();
          try { await supabase.from('settings').update({ warmup_start_date: config.warmupStartDate, updated_at: new Date().toISOString() }).eq('workspace_id', config.workspaceId); } catch (e) { log('warn', 'WARMUP', `Failed to persist warmup_start_date: ${e.message}`); }
        }
        await saveState(state);
        log('success', 'SENT', `@${lead.ig_handle} — ${sent}/${effectiveLimit}`);

        // Per-DM Telegram notification with configurable interval
        state.dmNotifyCount = (state.dmNotifyCount || 0) + 1;
        const dmInterval = config.telegramDmNotifyInterval;
        if (dmInterval && dmInterval > 0 && state.dmNotifyCount % dmInterval === 0) {
          sendTelegram(supabase, `📤 <b>DM sent</b> — @${lead.ig_handle}\n\"${message.substring(0, 150)}\"`);
        }
      } else {
        log('error', 'FAIL', `@${lead.ig_handle}: ${result.error}`);
        const err = (result.error || '').toLowerCase();
        if (err.includes('profile not found') || err.includes('message button not found') || err.includes('page context lost') || err.includes('not found in compose search') || err.includes('chat box not found')) {
          try { await supabase.from('leads').update({ status: 'rejected', last_updated_at: new Date().toISOString() }).eq('id', lead.id); } catch (e) {}
        }

        // If context lost, create new page and continue to next lead instead of aborting batch
        try { await page.evaluate(() => 1); } catch (_) { 
          log('warn', 'RESILIENCE', 'Page context lost — creating new page for next lead...');
          try { await page.close().catch(() => {}); } catch (_) {}
          try {
            page = await context.newPage();
            await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(5000);
          } catch (e) {
            log('warn', 'RESILIENCE', 'Could not recover page — continuing to next lead anyway.');
          }
          continue;
        }

        // Action block detection — Instagram is restricting the account
        if (err.includes('action blocked') || err.includes('we restrict')) {
          log('error', 'ACTION_BLOCKED', 'Instagram action block detected. Stopping engine for 24h.');
          try { await supabase.from('engine_alerts').insert({ workspace_id: config.workspaceId, alert_type: 'action_block', message: 'Instagram action block detected. Engine stopped for 24h.' }); } catch (e) {}
          sendTelegram(supabase, `🚫 <b>Action Blocked!</b>\nInstagram restricted @${config.igUsername || 'unknown'}\nEngine stopped for 24h.`);
          stopRequested = true;
          break;
        }

        if (err.includes('session expired')) {
          log('error', 'EXPIRED', 'Session lost. Stopping.');
          try { await supabase.from('engine_alerts').insert({ workspace_id: config.workspaceId, alert_type: 'session_expired', message: 'Instagram session expired. Please re-authenticate.' }); } catch (e) {}
          stopRequested = true;
          break;
        }
      }

      //Human delay: random between min-max, pause after N DMs
      {
        const baseMs = delayMin + Math.random() * (delayMax - delayMin);
        cycleDmCount++;
        if (pauseAfter > 0 && cycleDmCount % pauseAfter === 0) {
          const extraPause = 300000 + Math.random() * 300000;
          log('info', 'HUMANIZER', `Pausing ${Math.round(extraPause/60000)}min after ${pauseAfter} DMs/fails`);
          await delay(baseMs + extraPause);
          // Mid-pulse AI Setter: check for new replies during DM pauses
          if (aiSetterShouldRun()) {
            try {
              log('info', 'AI_MIDPULSE', 'Running AI Setter mid-pulse during DM pause...');
              await checkAndReply(page, supabase, config, context);
            } catch (e) { log('warn', 'AI_MIDPULSE_ERR', e.message); }
          }
        } else {
          await delay(baseMs);
        }
      }

      } catch (dmIterErr) {
        log('error', 'DM_CRASH', `DM iteration crashed: ${dmIterErr.message}`);
        // Don't break — continue to next lead
      }
    }
    } // end leads block
    if (sentThisPulse > 0) sendTelegram(supabase, `✅ <b>DMs sent</b> — ${sentThisPulse} this pulse\nTotal today: ${sent}`);

    if (stopRequested) break;

    // Follow-up loop: send sequenced DMs to non-responders (separate from outreach cap)
    const maxFU = config.maxFollowups || 0;
    const fuDelays = config.followupDelays || [3, 5, 7];
    const fuTemplates = config.followupTemplates || ['', '', ''];
      if (maxFU > 0) {
        const { data: fuLeads } = await supabase
          .from('leads')
          .select('*')
          .eq('workspace_id', config.workspaceId)
          .in('status', ['dm_sent'])
          .lt('followup_step', maxFU)
        .order('followup_step', { ascending: true })
        .order('last_dm_sent_at', { ascending: true })
        .limit(20);

      if (fuLeads && fuLeads.length > 0) {
        for (const lead of fuLeads) {
          if (stopRequested) break;
          const step = lead.followup_step || 0;
          if (!fuTemplates[step]) continue; // no template for this step, skip lead
          const delayDays = fuDelays[step] || 3;
          const lastSent = new Date(lead.last_dm_sent_at || lead.discovered_at).getTime();
          if (Date.now() - lastSent < delayDays * 86400000) continue; // not due yet
          if (dmSentThisPulse.has(lead.id)) continue; // skip — first DM sent this same pulse

          // Guard: only send follow-ups to dm_sent leads — replied leads are handled by AI Setter
          // (Old DOM check removed — it navigated to /direct/t/{username}/ which 404s; Instagram DM URLs need numeric thread IDs)

          log('info', 'FOLLOWUP', `@${lead.ig_handle} step ${step + 1}/${maxFU}`);
          
          let firstName;
          let leadTopic = 'your work';
          try {
            await page.goto(`https://www.instagram.com/${lead.ig_handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(2000);
            firstName = await resolveIdentity(page, lead);
            const pageBio = await page.evaluate(() => {
              const meta = document.querySelector('meta[name="description"]');
              if (!meta) return '';
              const content = meta.getAttribute('content') || '';
              const match = content.match(/on Instagram:\s*"([^"]+)"/);
              return match ? match[1] : '';
            });
            if (pageBio) {
              lead.bio = pageBio;
              const nicheKeywords = config.nicheTags || ['doctor', 'medical', 'health'];
              for (const kw of nicheKeywords) {
                if (pageBio.toLowerCase().includes(kw.toLowerCase())) {
                  leadTopic = kw;
                  break;
                }
              }
            }
          } catch (e) {
            firstName = resolveIdentityFromLead(lead);
          }
          
          const message = humanize(fuTemplates[step], lead, firstName, leadTopic, humanizerConfig);
          if (!message) {
            log('warn', 'SKIP_NO_FOLLOWUP', `@${lead.ig_handle} follow-up step ${step} skipped — template empty`);
            continue;
          }
          const result = await sendDMWithTimeout(page, lead.ig_handle, message);

          const newStep = step + 1;
          const newStatus = lead.status === 'replied' ? 'replied' : (newStep >= maxFU ? 'closed_lost' : 'dm_sent');
          if (result.success) {
            try {
              await supabase.from('outbox').insert({
                workspace_id: config.workspaceId,
                lead_id: lead.id,
                message,
                status: 'sent',
                sent_at: new Date().toISOString()
              });
              await supabase.from('leads').update({
                status: newStatus,
                followup_step: newStep,
                last_dm_sent_at: new Date().toISOString(),
                last_updated_at: new Date().toISOString()
              }).eq('id', lead.id);
            } catch (e) {
              log('warn', 'FOLLOWUP_ERR', e.message);
            }
            // Follow-ups don't count toward daily outreach cap
            state.paused = paused; // sync in-memory paused flag before persisting
            await saveState(state);
            followupsSentThisPulse++;
            log('success', 'FOLLOWUP_OK', `@${lead.ig_handle} step ${step + 1}/${maxFU}${newStatus === 'closed_lost' ? ' → closed_lost' : ''}`);
            // Human delay: random between min-max, pause after N DMs
            {
              const baseMs = delayMin + Math.random() * (delayMax - delayMin);
              cycleDmCount++;
              if (pauseAfter > 0 && cycleDmCount % pauseAfter === 0) {
                const extraPause = 300000 + Math.random() * 300000;
                log('info', 'HUMANIZER', `Pausing ${Math.round(extraPause/60000)}min after ${pauseAfter} DMs`);
                await delay(baseMs + extraPause);
              } else {
                await delay(baseMs);
              }
            }
          } else {
            log('error', 'FOLLOWUP_FAIL', `@${lead.ig_handle}: ${result.error}`);
            const err2 = (result.error || '').toLowerCase();
            if (err2.includes('session expired')) { stopRequested = true; break; }
            if (err2.includes('action blocked') || err2.includes('we restrict')) {
              log('error', 'ACTION_BLOCKED', 'Instagram action block detected. Stopping engine for 24h.');
              stopRequested = true;
              break;
            }
            if (err2.includes('profile not found') || err2.includes('not exist')) {
              try { await supabase.from('leads').update({ status: 'closed_lost', conversation_step: 99, followup_step: 99, last_updated_at: new Date().toISOString() }).eq('id', lead.id); } catch (e) {}
              log('info', 'FOLLOWUP_CLEANUP', `@${lead.ig_handle} profile gone — marked closed_lost`);
            }
            // Human delay: random between min-max
            {
              const baseMs = delayMin + Math.random() * (delayMax - delayMin);
              cycleDmCount++;
              await delay(baseMs);
            }
          }
        }
      }
    }
    if (followupsSentThisPulse > 0) sendTelegram(supabase, `🔄 <b>Follow-ups sent</b> — ${followupsSentThisPulse} this pulse`);

    // ── IDLE UNFOLLOW SEQUENCE ──────────────────────────────────
    // Run only when outreach/follow-ups are done to avoid detection patterns
    try {
      const { runUnfollowSequence } = require('./unfollower.cjs');
      await runUnfollowSequence({ page, supabase, config, stopRequested });
    } catch (ufErr) {
      log('warn', 'UNFOLLOW_ERR', `Idle unfollow sequence failed: ${ufErr.message}`);
    }

    log('success', 'DONE', `Sent ${sent} DMs this cycle.`);

    // Mark first pulse done so AI Setter runs on subsequent pulses
    if (!state.firstPulseDone) {
      state.firstPulseDone = true;
      await saveState(state);
      log('info', 'FIRST_PULSE', 'First outreach pulse complete. AI Setter enabled for next pulse.');
    }

    // Supabase cleanup: prune old rows once per day (~24 pulses) to stay under free tier limit
    if (pulseCount > 0 && pulseCount % 24 === 0) {
      log('info', 'CLEANUP', 'Pruning old outbox and heartbeat rows...');
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      try {
        const { data: deleted } = await supabase.from('outbox').delete().lt('sent_at', thirtyDaysAgo).select('count');
        log('success', 'CLEANUP', `Purged ${deleted?.length || 0} outbox rows`);
      } catch (e) { log('warn', 'CLEANUP', `Outbox prune: ${e.message}`); }
      try {
        const { data: deleted } = await supabase.from('engine_heartbeats').delete().lt('seen_at', sevenDaysAgo).select('count');
        log('success', 'CLEANUP', `Purged ${deleted?.length || 0} heartbeat rows`);
      } catch (e) { log('warn', 'CLEANUP', `Heartbeat prune: ${e.message}`); }
      try {
        const shotDir = path.resolve(process.cwd(), 'screenshots');
        if (fs.existsSync(shotDir)) {
          const dayAgo = Date.now() - 86400000;
          let purged = 0;
          const files = fs.readdirSync(shotDir);
          for (const f of files) {
            if (!f.endsWith('.png')) continue;
            try {
              const stat = fs.statSync(path.join(shotDir, f));
              if (stat.mtimeMs < dayAgo) { fs.unlinkSync(path.join(shotDir, f)); purged++; }
            } catch (e) {}
          }
          if (purged > 0) log('success', 'CLEANUP', `Purged ${purged} screenshots older than 24h`);
        }
      } catch (e) { log('warn', 'CLEANUP', `Screenshot prune: ${e.message}`); }
    }

    // Wait for next pulse (always, to avoid busy-loop)
    if (leads && leads.length > 0 && sent < dailyLimit) {
      log('info', 'SLEEP', `Waiting ${config.pulseIntervalH || 1}h for new leads...`);
    } else {
      log('info', 'SLEEP', `Waiting ${config.pulseIntervalH || 1}h (${leads ? leads.length : 0} leads, ${sent}/${dailyLimit} sent)...`);
    }

    // 🛡️ Memory refresh: close old pages every 4 pulses instead of restarting (preserves session)
    if (pulseCount > 0 && pulseCount % 4 === 0) {
      try {
        const pages = context.pages();
        for (const p of pages) { if (p !== page) try { await p.close(); } catch (e) {} }
        log('info', 'MEMORY', `Closed ${pages.length - 1} stale page(s), keeping main page alive.`);
      } catch (e) { log('warn', 'MEMORY', `Page cleanup: ${e.message}`); }
    }
    await warmSleep(pulseIntervalMs);
  }

  clearInterval(heartbeatTimer);
  if (proxyBridge) proxyBridge.close();
  await flushLogs();
  if (context) await context.close();
  sendTelegram(supabase, `⏹ <b>Engine stopped</b>\nDMs sent today: ${sent}`);
  log('success', 'STOP', 'Engine stopped cleanly.');
}

main().catch(err => {
  log('error', 'CRASH', err.message);
  sendTelegram(supabase, `⛔ <b>Engine crashed</b>\nError: ${err.message.slice(0, 200)}`);
  process.exit(1);
});
