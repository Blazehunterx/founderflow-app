const { checkBannedWords } = require('./rules_engine.cjs');
const { STAGES, CALL_LINK } = require('./funnel_config.cjs');

function createResult(valid, errors, warnings) {
  return { valid, errors: errors || [], warnings: warnings || [], should_send: valid && !(errors||[]).length, should_regenerate: !valid };
}

function validateLength(text) {
  if (!text) return createResult(false, [{ type: 'empty', message: 'Response is empty' }]);
  if (text.length < 10) return createResult(false, [{ type: 'too_short', message: `${text.length} chars, min 10` }]);
  if (text.length > 500) return createResult(true, [{ type: 'long_response', message: `${text.length} chars, over 500` }]);
  return createResult(true);
}

function validateBannedWords(text) {
  const result = checkBannedWords(text);
  if (!result.clean) {
    return createResult(false, result.violations.map(v => ({
      type: 'banned_word', message: `Banned: "${v.word || v.match}"` })));
  }
  return createResult(true);
}

function validateCallLink(text, decisions, funnelState, callLink) {
  const link = callLink || CALL_LINK;
  if (!text.includes(link)) return createResult(true);
  const stage = decisions.stage_decision?.stage;
  if (stage !== STAGES.CALL_LINK_SENT && stage !== STAGES.INVITATION) {
    return createResult(false, [{ type: 'premature_link', message: `Link at stage "${stage}"` }]);
  }
  if (!funnelState?.invitation_accepted) {
    return createResult(false, [{ type: 'link_without_acceptance', message: 'No acceptance yet' }]);
  }
  if (funnelState?.call_link_sent) {
    return createResult(false, [{ type: 'duplicate_link', message: 'Already sent' }]);
  }
  return createResult(true);
}

function validateStageConsistency(text, decisions) {
  const stage = decisions.stage_decision?.stage;
  if (stage === STAGES.OPENER_SENT && text.length > 200) {
    return createResult(true, [{ type: 'opener_long', message: 'Opener over 200 chars' }]);
  }
  if (decisions.objection && text.includes('want me to send you a link')) {
    return createResult(false, [{ type: 'objection_and_invite', message: 'Handle one at a time' }]);
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

function validateLinks(text, allowedDomains) {
  const urls = (text.match(/https?:\/\/[^\s]+/gi) || []);
  const domains = allowedDomains || ['meet.walerij.com'];
  for (const url of urls) {
    const allowed = domains.some(d => url.includes(d));
    if (!allowed) {
      return createResult(false, [{ type: 'unauthorized_link', message: url }]);
    }
  }
  return createResult(true);
}

function validateNotGeneric(text) {
  const phrases = ['i hope this finds you well', 'i wanted to reach out', 'i hope you', 'i was wondering if',
    'i came across your profile', 'hope you', 'having a great day'];
  const lower = text.toLowerCase();
  for (const p of phrases) {
    if (lower.includes(p)) return createResult(true, [{ type: 'generic', message: p }]);
  }
  return createResult(true);
}

function validate(text, decisions, funnelState, options) {
  const opts = options || {};
  const allowedDomains = opts.allowedDomains || ['meet.walerij.com'];
  const callLink = opts.callLink || CALL_LINK;
  const errors = [];
  const warnings = [];
  const checks = [
    validateLength(text),
    validateBannedWords(text),
    validateCallLink(text, decisions, funnelState, callLink),
    validateStageConsistency(text, decisions),
    validateEmoji(text),
    validateCaps(text),
    validateLinks(text, allowedDomains),
    validateNotGeneric(text),
  ];
  for (const r of checks) {
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { valid: errors.length === 0, errors, warnings, should_send: errors.length === 0, should_regenerate: errors.length > 0 };
}

module.exports = {
  validate, validateLength, validateBannedWords, validateCallLink,
  validateStageConsistency, validateEmoji, validateCaps, validateLinks,
};
