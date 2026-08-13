/**
 * Olive's Isolation Test — run on her local machine
 *   node test_olive_isolation.cjs
 */

const fs = require('fs');
const path = require('path');

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
let failures = 0;
let warnings = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log('  ' + PASS + ' ' + label);
  } else {
    console.log('  ' + FAIL + ' ' + label + (detail ? ' — ' + detail : ''));
    failures++;
  }
}

try {
  // ── 1. Load config.json ──
  console.log('\n=== 1. CONFIG.JSON ===\n');
  var cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'config.json'), 'utf8'));
    check('config.json exists and is valid JSON', true);
  } catch (e) {
    check('config.json exists and is valid JSON', false, e.message);
    console.log('\nCannot continue without config.json. Make sure config.json is in the same folder as this script.');
    console.log('Current folder: ' + __dirname);
    console.log('Files here: ' + fs.readdirSync(__dirname).join(', '));
    process.exit(1);
  }

  check('workspaceId is Olive', cfg.workspaceId === '8b20597a-2859-4a82-ac77-90e8a2e76103', 'got: ' + cfg.workspaceId);
  check('workspaceName is OlivePixxie', cfg.workspaceName === 'OlivePixxie', 'got: ' + cfg.workspaceName);
  check('calendlyLink is linklylo.co', (cfg.calendlyLink || '').indexOf('linklylo.co') !== -1, 'got: ' + cfg.calendlyLink);
  check('inboxScanMode is true', cfg.inboxScanMode === true, 'got: ' + cfg.inboxScanMode);
  check('dailyLimit is 0 (no outbound DMs)', cfg.dailyLimit === 0, 'got: ' + cfg.dailyLimit);
  check('maxFollowups is 0', cfg.maxFollowups === 0, 'got: ' + cfg.maxFollowups);
  check('conversationRoutingStep is 4', cfg.conversationRoutingStep === 4, 'got: ' + cfg.conversationRoutingStep);

  // Voice check
  var ctx = cfg.aiTrainingContext || '';
  check('aiTrainingContext is not empty', ctx.length > 0, 'empty — template voice will leak!');
  check('aiTrainingContext mentions Olive', /Olive|Pixie/i.test(ctx), 'does not mention Olive');
  check('aiTrainingContext does NOT mention Jani', !/Jani/i.test(ctx), 'MENTIONS JANI — VOICE LEAK!');
  check('aiTrainingContext does NOT mention Marvin', !/Marvin/i.test(ctx), 'MENTIONS MARVIN — VOICE LEAK!');
  check('aiTrainingContext mentions OnlyFans', /OnlyFans|onlyfans/i.test(ctx), 'missing OnlyFans context');
  check('aiTrainingContext mentions WhatsApp/Telegram', /WhatsApp|Telegram/i.test(ctx), 'missing WhatsApp/Telegram context');
  check('calendlyLink (OF link) is correct', cfg.calendlyLink === 'https://linklylo.co/new-page-4ve7', 'got: ' + cfg.calendlyLink);
  check('aiSetterEnabled is true', cfg.aiSetterEnabled === true, 'got: ' + cfg.aiSetterEnabled);

  // ── 2. Load engine.cjs ──
  console.log('\n=== 2. ENGINE.CJS ===\n');
  var engine;
  try {
    engine = fs.readFileSync(path.resolve(__dirname, 'engine.cjs'), 'utf8');
    check('engine.cjs exists', true);
  } catch (e) {
    check('engine.cjs exists', false, e.message);
    process.exit(1);
  }

  check('reads config from __dirname', engine.indexOf("path.resolve(__dirname, 'config.json')") !== -1, 'config load path wrong');
  check('no hardcoded Marvin voice', engine.indexOf('You are Marvin') === -1, 'hardcoded Marvin voice found');
  check('no hardcoded Jani voice', engine.indexOf('You are Jani') === -1, 'hardcoded Jani voice found');
  check('templateWorkspaceId not hardcoded in engine', engine.indexOf('fbe1aced-2cda-4931-97f8-99d39216414a') === -1, 'template ID hardcoded in engine');

  // Config lock checks
  check('config lock: refreshLiveConfig is no-op', engine.indexOf('CONFIG LOCKED') !== -1, 'config not locked — runtime overwrite risk!');
  check('config lock: no config overwrite from Supabase', engine.indexOf('config.aiTrainingContext = merged.ai_training_context') === -1, 'config still overwritten from Supabase!');

  // ── 3. Load ai_setter.cjs ──
  console.log('\n=== 3. AI_SETTER.CJS ===\n');
  var setter;
  try {
    setter = fs.readFileSync(path.resolve(__dirname, 'ai_setter.cjs'), 'utf8');
    check('ai_setter.cjs exists', true);
  } catch (e) {
    check('ai_setter.cjs exists', false, e.message);
    process.exit(1);
  }

  check('reads voice from config.aiTrainingContext', setter.indexOf('config.aiTrainingContext') !== -1, 'voice source wrong');
  check('inboxScanMode present', setter.indexOf('inboxScanMode') !== -1, 'inbox scan mode missing');
  check('story reply skip present', setter.indexOf('AI_REACTION_SKIP') !== -1, 'story reply skip missing');
  check('OF cooldown present', setter.indexOf('ofCooldown') !== -1 || setter.indexOf('OF_COOLDOWN') !== -1, 'OF cooldown missing');
  check('no hardcoded Marvin voice', setter.indexOf('You are Marvin') === -1, 'hardcoded Marvin voice found');
  check('no hardcoded Jani voice', setter.indexOf('You are Jani') === -1, 'hardcoded Jani voice found');
  check('no hardcoded Olive voice in code', setter.indexOf('You are Olive') === -1, 'hardcoded Olive voice in code (should come from config only)');

  // Workspace scoping
  var wsMatches = setter.match(/workspace_id.*workspaceId|workspaceId.*workspace_id/g) || [];
  check('workspace-scoped DB queries', wsMatches.length > 10, 'only ' + wsMatches.length + ' found');
  check('no references to other workspace IDs',
    setter.indexOf('0ebe9602-c4b4-44fa-b69e-0b32e4676d26') === -1 &&
    setter.indexOf('df8dda74-a7af-4795-ac35-8f101e605401') === -1,
    'other workspace IDs found in code');

  // ── 4. Cross-file consistency ──
  console.log('\n=== 4. CROSS-FILE CONSISTENCY ===\n');

  check('engine loads config.json, ai_setter reads config.aiTrainingContext',
    engine.indexOf("path.resolve(__dirname, 'config.json')") !== -1 && setter.indexOf('config.aiTrainingContext') !== -1,
    'chain broken');

  check('config.json voice matches workspace identity',
    ctx.indexOf('OLIVEPIXXIE') !== -1 && cfg.workspaceName === 'OlivePixxie',
    'voice/identity mismatch');

  // ── 5. File locations ──
  console.log('\n=== 5. FILE LOCATIONS ===\n');
  var files = ['config.json', 'engine.cjs', 'ai_setter.cjs', 'start.cjs'];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var p = path.resolve(__dirname, f);
    check(f + ' at root (same dir)', fs.existsSync(p), 'missing from ' + path.dirname(p));
  }

  // ── Summary ──
  console.log('\n==================================================');
  if (failures === 0 && warnings === 0) {
    console.log('\x1b[32m\x1b[1m\n  ALL CLEAR — Olive is Olive. No voice leaking.\n\x1b[0m');
  } else if (failures === 0) {
    console.log('\x1b[33m\n  ' + warnings + ' warning(s), 0 failures — review above\n\x1b[0m');
  } else {
    console.log('\x1b[31m\n  ' + failures + ' FAILURE(S), ' + warnings + ' warning(s) — FIX BEFORE RUNNING ENGINE\n\x1b[0m');
  }
  process.exit(failures > 0 ? 1 : 0);

} catch (e) {
  console.error('\x1b[31mTest crashed:\x1b[0m', e.message);
  console.error(e.stack);
  process.exit(2);
}
