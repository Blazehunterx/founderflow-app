/**
 * Hybrid Funnel Tests — Jani Havunen (Author + Affiliate)
 * Tests both funnels through full conversation flow
 */
const { analyze, checkBannedWords } = require('./rules_engine_jani.cjs');
const { validate } = require('./validator_jani.cjs');
const { handleStageProgression, isTerminal, detectEmailProvided, detectCallLinkIntent } = require('./handler_jani.cjs');
const { STAGES, FUNNEL_STARTING_STAGE, AUTHOR, AFFILIATE } = require('./funnel_config_jani.cjs');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  \u2713 ${label}`); }
  else { failed++; console.log(`  \u2717 FAIL: ${label}`); }
}

function mkFunnel(stage) { return { current_stage: stage, conversation_history: [] }; }

console.log('═══════════════════════════════════════════════════════════');
console.log('  HYBRID FUNNEL — JANI HAVUNEN TESTS');
console.log('═══════════════════════════════════════════════════════════\n');

// ── Test 1: Crisis Detection ───────────────────────────
console.log('Test 1: Crisis — "I feel suicidal"');
(() => {
  const decisions = analyze(mkFunnel(FUNNEL_STARTING_STAGE), 'I feel suicidal');
  assert(decisions.crisis !== null, 'Crisis detected');
  assert(decisions.stage_decision.stage === STAGES.CRISIS, 'Stage is CRISIS');
  assert(isTerminal(decisions.stage_decision.stage), 'Stage is terminal');
})();

// ── Test 2: Hostility ──────────────────────────────────
console.log('\nTest 2: Hostility — "fuck off, stop messaging"');
(() => {
  const decisions = analyze(mkFunnel(FUNNEL_STARTING_STAGE), 'fuck off, stop messaging');
  assert(decisions.hostility !== null, 'Hostility detected');
  assert(decisions.stage_decision.stage === STAGES.STOPPED, 'Stage is STOPPED');
})();

// ── Test 3: Author — Full Conversation Flow ────────────
console.log('\nTest 3: Author — Full Flow (stuck → qualify → acknowledge → offer → email → deliver)');
(() => {
  // Step 1: Outbound opener
  let decisions = analyze(mkFunnel(FUNNEL_STARTING_STAGE), '', null, true);
  assert(decisions.stage_decision.stage === STAGES.OPENER_SENT, 'Outbound: NEW_LEAD -> OPENER_SENT');

  // Step 2: They reply "I keep starting over"
  let funnel = { current_stage: STAGES.OPENER_SENT, conversation_history: [] };
  decisions = analyze(funnel, 'I keep starting over');
  assert(decisions.stage_decision.stage === STAGES.QUALIFY, 'Reply to opener -> QUALIFY');

  // Step 3: They answer qualification (repeating patterns)
  funnel = { current_stage: STAGES.QUALIFY, conversation_history: [{ is_me: true, text: 'opener' }, { is_me: false, text: 'I keep starting over' }] };
  decisions = analyze(funnel, 'repeating the same patterns');
  assert(decisions.stage_decision.stage === STAGES.IDENTIFY_OBSTACLE, 'QUALIFY -> IDENTIFY_OBSTACLE');

  // Step 4: Acknowledge + offer
  funnel = { current_stage: STAGES.IDENTIFY_OBSTACLE, conversation_history: [] };
  decisions = analyze(funnel, 'repeating patterns');
  assert(decisions.stage_decision.stage === STAGES.ACKNOWLEDGE, 'IDENTIFY_OBSTACLE -> ACKNOWLEDGE');

  // Step 5: Offer accepted
  funnel = { current_stage: STAGES.OFFER, offer_accepted: true, conversation_history: [] };
  const progression = handleStageProgression(funnel, 'yes please send it', 'author');
  assert(progression.offer_accepted === true, 'Offer accepted');

  // Step 6: Email provided
  const email = detectEmailProvided('Mia, mia@example.com');
  assert(email === 'mia@example.com', 'Email detected');

  // Step 7: Validate email capture stage
  const v = validate('Sure. What is your first name and best email address? I will send the guide there. You will also receive a few short follow-up emails with practical insights connected to the guide. You can unsubscribe at any time.', { stage_decision: { stage: STAGES.EMAIL_CAPTURE } }, { offer_accepted: true }, 'author');
  assert(v.should_send === true, 'Email capture with disclosure passes');
})();

// ── Test 4: Affiliate — Full Conversation Flow ─────────
console.log('\nTest 4: Affiliate — Full Flow (opener → qualify → obstacle → acknowledge → offer → email)');
(() => {
  // Step 1: Outbound opener
  let decisions = analyze(mkFunnel(FUNNEL_STARTING_STAGE), '', null, true);
  assert(decisions.stage_decision.stage === STAGES.OPENER_SENT, 'Outbound: NEW_LEAD -> OPENER_SENT');

  // Step 2: They reply about wanting extra income
  let funnel = { current_stage: STAGES.OPENER_SENT, conversation_history: [] };
  decisions = analyze(funnel, 'I would like extra income');
  assert(decisions.stage_decision.stage === STAGES.QUALIFY, 'Reply -> QUALIFY');

  // Step 3: Goal clarification
  funnel = { current_stage: STAGES.QUALIFY, conversation_history: [] };
  decisions = analyze(funnel, 'a few hundred a month');
  assert(decisions.stage_decision.stage === STAGES.IDENTIFY_OBSTACLE, 'QUALIFY -> IDENTIFY_OBSTACLE');

  // Step 4: Obstacle identified
  funnel = { current_stage: STAGES.IDENTIFY_OBSTACLE, conversation_history: [] };
  decisions = analyze(funnel, 'I do not trust most of what I see online');
  assert(decisions.stage_decision.stage === STAGES.ACKNOWLEDGE, 'IDENTIFY_OBSTACLE -> ACKNOWLEDGE');

  // Step 5: Email provided
  const email = detectEmailProvided('Daniel, daniel@example.com');
  assert(email === 'daniel@example.com', 'Email detected');
})();

// ── Test 5: Banned Words ──────────────────────────────
console.log('\nTest 5: Banned Words');
(() => {
  const r1 = checkBannedWords('We guarantee results');
  assert(r1.clean === false, 'Guarantee detected');
  const r2 = checkBannedWords("You'll crush it with us");
  assert(r2.clean === false, 'Crush it detected');
  const r3 = checkBannedWords('This proven system will make you rich');
  assert(r3.clean === false, 'Proven system + rich detected');
  const r4 = checkBannedWords('Hey, wanted to connect and see how things are going');
  assert(r4.clean === true, 'Clean message passes');
})();

// ── Test 6: Premature Email ────────────────────────────
console.log('\nTest 6: Premature Email Request');
(() => {
  const v = validate('What is your email address?', { stage_decision: { stage: STAGES.OPENER_SENT } }, {}, 'author');
  assert(v.should_send === false, 'Email at opener stage blocked');
  assert(v.errors.some(e => e.type === 'premature_email'), 'Error type: premature_email');
})();

// ── Test 7: Missing Disclosure ─────────────────────────
console.log('\nTest 7: Missing Disclosure in Email Request');
(() => {
  const v = validate('Sure. What is your first name and best email address?', { stage_decision: { stage: STAGES.EMAIL_CAPTURE } }, {}, 'author');
  assert(v.should_send === false, 'Email without disclosure blocked');
  assert(v.errors.some(e => e.type === 'missing_disclosure'), 'Error type: missing_disclosure');
})();

// ── Test 8: ALL CAPS ──────────────────────────────────
console.log('\nTest 8: ALL CAPS');
(() => {
  const v = validate('THIS IS A TEST MESSAGE', { stage_decision: { stage: STAGES.QUALIFY } }, {}, 'author');
  assert(v.should_send === false, 'ALL CAPS blocked');
  assert(v.errors.some(e => e.type === 'all_caps'), 'Error type: all_caps');
})();

// ── Test 9: Links Blocked ─────────────────────────────
console.log('\nTest 9: Links in DMs');
(() => {
  const v = validate('Check out https://example.com', { stage_decision: { stage: STAGES.QUALIFY } }, {}, 'author');
  assert(v.should_send === false, 'Links blocked');
  assert(v.errors.some(e => e.type === 'link_detected'), 'Error type: link_detected');
})();

// ── Test 10: Generic Response ─────────────────────────
console.log('\nTest 10: Generic Response');
(() => {
  const v = validate('I hope this finds you well. I wanted to reach out about the guide.', { stage_decision: { stage: STAGES.QUALIFY } }, {}, 'author');
  assert(v.should_send === false, 'Generic phrases blocked');
  assert(v.errors.some(e => e.type === 'generic'), 'Error type: generic');
})();

// ── Test 11: Objection Detection ──────────────────────
console.log('\nTest 11: Objection — "Is it really free?"');
(() => {
  const decisions = analyze(mkFunnel(STAGES.OFFER), 'Is it really free?');
  assert(decisions.objection !== null, 'Objection detected');
  assert(decisions.objection.id === 'is_it_free', 'Objection is "is_it_free"');
})();

// ── Test 12: Objection — "Does it work?" ─────────────
console.log('\nTest 12: Objection — "Does this actually work?"');
(() => {
  const decisions = analyze(mkFunnel(STAGES.ACKNOWLEDGE), 'Does this actually work?');
  assert(decisions.objection !== null, 'Objection detected');
  assert(decisions.objection.id === 'does_it_work', 'Objection is "does_it_work"');
})();

// ── Test 13: Transparency ─────────────────────────────
console.log('\nTest 13: Transparency — "Are you a bot?"');
(() => {
  const decisions = analyze(mkFunnel(STAGES.QUALIFY), 'Are you a bot?');
  assert(decisions.transparency === true, 'Transparency detected');
})();

// ── Test 14: Email Detection ──────────────────────────
console.log('\nTest 14: Email Detection');
(() => {
  assert(detectEmailProvided('john@example.com') === 'john@example.com', 'Simple email');
  assert(detectEmailProvided('My email is jane@gmail.com') === 'jane@gmail.com', 'Email in sentence');
  assert(detectEmailProvided('no email here') === null, 'No email');
  assert(detectEmailProvided('john@') === null, 'Incomplete email');
})();

// ── Test 15: Call Link Intent ─────────────────────────
console.log('\nTest 15: Call/Training Link Intent');
(() => {
  assert(detectCallLinkIntent('send me the link') === true, 'send me the link');
  assert(detectCallLinkIntent('yes please send it') === true, 'yes please send it');
  assert(detectCallLinkIntent('sure send') === true, 'sure send');
  assert(detectCallLinkIntent('how are you?') === false, 'Normal question');
})();

// ── Test 16: Valid Response ───────────────────────────
console.log('\nTest 16: Valid Response Passes');
(() => {
  const v = validate('That makes sense. What feels like the biggest issue right now: not knowing what to change, repeating the same patterns, or struggling to stay consistent?', { stage_decision: { stage: STAGES.QUALIFY } }, {}, 'author');
  assert(v.should_send === true, 'Valid qualification question passes');
  assert(v.errors.length === 0, 'No errors');
})();

// ── Test 17: Author Config Correct ────────────────────
console.log('\nTest 17: Author Config');
(() => {
  assert(AUTHOR.profile === 'author', 'Profile is author');
  assert(AUTHOR.aWeber.listId === '6961178', 'AWeber list ID correct');
  assert(AUTHOR.aWeber.coreTags.includes('brand-author'), 'Has brand-author tag');
  assert(AUTHOR.openers.general.length > 0, 'Has general opener');
  assert(AUTHOR.qualification.length > 0, 'Has qualification question');
  assert(AUTHOR.offer.length > 0, 'Has offer text');
  assert(AUTHOR.emailRequest.includes('unsubscribe'), 'Email request has disclosure');
})();

// ── Test 18: Affiliate Config Correct ─────────────────
console.log('\nTest 18: Affiliate Config');
(() => {
  assert(AFFILIATE.profile === 'affiliate', 'Profile is affiliate');
  assert(AFFILIATE.aWeber.listId === '6941925', 'AWeber list ID correct');
  assert(AFFILIATE.aWeber.coreTags.includes('brand-affiliate'), 'Has brand-affiliate tag');
  assert(AFFILIATE.openers.general.length > 0, 'Has general opener');
  assert(AFFILIATE.qualification.length > 0, 'Has qualification question');
  assert(AFFILIATE.obstacleQuestion.length > 0, 'Has obstacle question');
  assert(AFFILIATE.offer.length > 0, 'Has offer text');
  assert(AFFILIATE.emailRequest.includes('unsubscribe'), 'Email request has disclosure');
  assert(AFFILIATE.aboutJani.length > 0, 'Has about Jani text');
})();

// ── Summary ────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═══════════════════════════════════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
