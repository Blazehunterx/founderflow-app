/**
 * Hybrid Validator — Jani Havunen
 * Post-generation safety checks: banned words, email timing, length, stage validation
 */
const { checkBannedWords } = require('./rules_engine_jani.cjs');
const { STAGES, getProfileConfig } = require('./funnel_config_jani.cjs');

function createResult(valid, errors, warnings) {
  return { valid, errors: errors || [], warnings: warnings || [], should_send: valid && !(errors || []).length, should_regenerate: !valid };
}

function validateLength(text) {
  if (!text) return createResult(false, [{ type: 'empty', message: 'Response is empty' }]);
  if (text.length < 10) return createResult(false, [{ type: 'too_short', message: `${text.length} chars, min 10` }]);
  if (text.length > 300) return createResult(true, [{ type: 'long_response', message: `${text.length} chars, over 300` }]);
  return createResult(true);
}

function validateBannedWords(text) {
  const result = checkBannedWords(text);
  if (!result.clean) {
    return createResult(false, result.violations.map(v => ({
      type: 'banned_word', message: `Banned: "${v.word || v.match}"`,
    })));
  }
  return createResult(true);
}

function validateEmailTiming(text, decisions, funnelState, profile) {
  // Check if email is being requested/discussed
  const emailPatterns = /email|@\w+\.\w+|send it there|send the guide|send the training/i;
  if (!emailPatterns.test(text)) return createResult(true);

  const stage = decisions.stage_decision?.stage;

  // Email should only be discussed at EMAIL_CAPTURE stage or later
  if (stage !== STAGES.EMAIL_CAPTURE && stage !== STAGES.DELIVERED) {
    // Check if we're at OFFER and they just said yes — that's OK to transition to email
    if (stage === STAGES.OFFER && funnelState?.offer_accepted) {
      return createResult(true);
    }
    return createResult(false, [{ type: 'premature_email', message: `Email discussed at stage "${stage}" — should be at EMAIL_CAPTURE` }]);
  }

  // Must include disclosure about follow-up emails
  const hasDisclosure = /follow.up|unsubscribe/i.test(text);
  if (!hasDisclosure && stage === STAGES.EMAIL_CAPTURE) {
    return createResult(false, [{ type: 'missing_disclosure', message: 'Email request must include follow-up disclosure' }]);
  }

  return createResult(true);
}

function validateStageConsistency(text, decisions) {
  const stage = decisions.stage_decision?.stage;

  // Don't offer guide/training at wrong stage
  if (stage === STAGES.OPENER_SENT && /guide|training|framework|reset/i.test(text)) {
    return createResult(true, [{ type: 'early_offer', message: 'Guide/training mentioned at opener stage' }]);
  }

  // Don't ask qualification at wrong stage
  if (stage === STAGES.EMAIL_CAPTURE && /biggest issue|main thing getting in the way/i.test(text)) {
    return createResult(false, [{ type: 'wrong_stage_question', message: 'Qualification question at email stage' }]);
  }

  return createResult(true);
}

function validateEmoji(text) {
  const matches = text.match(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu);
  if (matches && matches.length > 1) {
    return createResult(true, [{ type: 'too_many_emojis', message: `${matches.length} emojis, max 1` }]);
  }
  return createResult(true);
}

function validateCaps(text) {
  const words = text.split(/\s+/).filter(w => w.length > 4);
  const caps = words.filter(w => w === w.toUpperCase() && /[A-Z]/.test(w));
  if (caps.length) return createResult(false, [{ type: 'all_caps', message: caps.join(', ') }]);
  return createResult(true);
}

function validateLinks(text) {
  const urls = (text.match(/https?:\/\/[^\s]+/gi) || []);
  if (urls.length > 0) {
    return createResult(false, [{ type: 'link_detected', message: `Links not allowed in DMs: ${urls[0]}` }]);
  }
  return createResult(true);
}

function validateNotGeneric(text) {
  const phrases = ['i hope this finds you well', 'i wanted to reach out', 'i hope you',
    'i was wondering if', 'i came across your profile', 'hope you', 'having a great day',
    'i hope you are doing well'];
  const lower = text.toLowerCase();
  for (const p of phrases) {
    if (lower.includes(p)) return createResult(true, [{ type: 'generic', message: p }]);
  }
  return createResult(true);
}

function validate(text, decisions, funnelState, profile) {
  const errors = [];
  const warnings = [];
  const checks = [
    validateLength(text),
    validateBannedWords(text),
    validateEmailTiming(text, decisions, funnelState, profile),
    validateStageConsistency(text, decisions),
    validateEmoji(text),
    validateCaps(text),
    validateLinks(text),
    validateNotGeneric(text),
  ];
  for (const r of checks) {
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { valid: errors.length === 0, errors, warnings, should_send: errors.length === 0, should_regenerate: errors.length > 0 };
}

module.exports = {
  validate, validateLength, validateBannedWords, validateEmailTiming,
  validateStageConsistency, validateEmoji, validateCaps, validateLinks,
};
