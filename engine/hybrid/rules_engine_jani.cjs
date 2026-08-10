/**
 * Hybrid Rules Engine — Jani Havunen (Author + Affiliate)
 * Deterministic decision layer using Jani's funnel stages and objections.
 */
const {
  STAGES, STAGE_ORDER, CRISIS_KEYWORDS, HOSTILITY_KEYWORDS,
  BANNED_WORDS, BANNED_PATTERNS, TIMING, getProfileConfig,
} = require('./funnel_config_jani.cjs');

// ── Crisis Detection (HIGHEST PRIORITY) ─────────────────
function detectCrisis(message) {
  if (!message) return null;
  const lower = message.toLowerCase();
  for (const keyword of CRISIS_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        triggered: true, keyword,
        auto_response: "I hear you, and I'm sorry you're dealing with that. I don't want to make this about the guide right now. If you want to talk more or revisit this later, I'm here, no pressure either way. Take care of yourself first.",
        action: 'STOP_ALL',
      };
    }
  }
  return null;
}

// ── Hostility Detection ─────────────────────────────────
function detectHostility(message) {
  if (!message) return null;
  const lower = message.toLowerCase();
  for (const keyword of HOSTILITY_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        triggered: true, keyword,
        auto_response: "Understood, I won't message you again. Take care.",
        action: 'STOP_ALL',
      };
    }
  }
  return null;
}

// ── Objection Detection (Jani-specific) ─────────────────
function detectObjection(message, profile) {
  if (!message) return null;
  const lower = message.toLowerCase();

  // Check both profiles if no profile specified
  const profiles = profile ? [profile] : ['author', 'affiliate'];

  for (const p of profiles) {
    const cfg = getProfileConfig(p);
    for (const obj of (cfg.objections || [])) {
      for (const pattern of obj.patterns) {
        if (lower.includes(pattern)) {
          return { detected: true, id: obj.id, root: obj.root };
        }
      }
    }
  }
  return null;
}

// ── Stage Router (Jani funnel) ──────────────────────────
function determineStage(funnelState, lastMessage, isOutbound) {
  const state = funnelState || {};
  const stage = state.current_stage || state.stage || STAGES.NEW_LEAD;

  // Terminal states — don't move
  if ([STAGES.STOPPED, STAGES.CRISIS, STAGES.DO_NOT_CONTACT, STAGES.COMPLETED].includes(stage)) {
    return { stage, action: 'none', reason: 'terminal_state' };
  }

  // If outbound first message
  if (isOutbound && stage === STAGES.NEW_LEAD) {
    return { stage: STAGES.OPENER_SENT, action: 'send_opener', reason: 'new_lead_outbound' };
  }

  // Inbound reply to opener → QUALIFY
  if (stage === STAGES.OPENER_SENT && lastMessage) {
    return { stage: STAGES.QUALIFY, action: 'qualify', reason: 'reply_to_opener' };
  }

  // QUALIFY → IDENTIFY_OBSTACLE (after qualification answer)
  if (stage === STAGES.QUALIFY && lastMessage) {
    return { stage: STAGES.IDENTIFY_OBSTACLE, action: 'identify_obstacle', reason: 'after_qualification' };
  }

  // IDENTIFY_OBSTACLE → ACKNOWLEDGE (after obstacle answer)
  if (stage === STAGES.IDENTIFY_OBSTACLE && lastMessage) {
    return { stage: STAGES.ACKNOWLEDGE, action: 'acknowledge', reason: 'after_obstacle' };
  }

  // ACKNOWLEDGE → OFFER (after acknowledgment)
  if (stage === STAGES.ACKNOWLEDGE && lastMessage) {
    return { stage: STAGES.OFFER, action: 'offer', reason: 'after_acknowledge' };
  }

  // OFFER → EMAIL_CAPTURE (if they accepted)
  if (stage === STAGES.OFFER && state.offer_accepted) {
    return { stage: STAGES.EMAIL_CAPTURE, action: 'collect_email', reason: 'offer_accepted' };
  }

  // EMAIL_CAPTURE → DELIVERED (if email captured)
  if (stage === STAGES.EMAIL_CAPTURE && state.captured_email) {
    return { stage: STAGES.DELIVERED, action: 'deliver', reason: 'email_captured' };
  }

  return { stage, action: 'continue', reason: 'no_change' };
}

// ── Banned Word Check ───────────────────────────────────
function checkBannedWords(text) {
  if (!text) return { clean: true, violations: [] };
  const violations = [];

  for (const word of BANNED_WORDS) {
    const regex = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    if (regex.test(text)) {
      violations.push({ type: 'banned_word', word, context: extractContext(text, word) });
    }
  }

  for (const pattern of BANNED_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      violations.push({ type: 'banned_pattern', match: match[0] });
    }
  }

  return { clean: violations.length === 0, violations };
}

function extractContext(text, word) {
  const idx = text.toLowerCase().indexOf(word.toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + word.length + 20);
  return text.substring(start, end);
}

// ── Conversation Length Check ────────────────────────────
function checkConversationLength(funnelState) {
  const history = (funnelState && funnelState.conversation_history) || [];
  if (history.length >= TIMING.max_conversation_exchanges) {
    return { exceeded: true, count: history.length, max: TIMING.max_conversation_exchanges };
  }
  return { exceeded: false, count: history.length };
}

// ── Transparency Request Detection ──────────────────────
function detectTransparencyRequest(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return ['why are you asking', 'what is this', "what's this about", 'why do you want to know',
    'what do you mean', 'who are you', "what's going on", 'what are you selling',
    'is this a sales pitch', 'are you selling me something', 'are you a bot',
    'is this automated', 'are you real', 'is this a real person',
  ].some(p => lower.includes(p));
}

// ── Vulnerability Detection (non-crisis) ────────────────
function detectVulnerability(message) {
  if (!message) return null;
  const lower = message.toLowerCase();
  const patterns = [
    { pattern: 'feeling stuck', ack: 'stuck' },
    { pattern: 'keep starting over', ack: 'repeating_patterns' },
    { pattern: 'same patterns', ack: 'repeating_patterns' },
    { pattern: 'repeating the same', ack: 'repeating_patterns' },
    { pattern: 'burnout', ack: 'burnout' },
    { pattern: 'burned out', ack: 'burnout' },
    { pattern: 'exhausted', ack: 'burnout' },
    { pattern: 'lonely', ack: 'lonely' },
    { pattern: 'isolated', ack: 'lonely' },
    { pattern: 'no direction', ack: 'no_direction' },
    { pattern: 'lost', ack: 'no_direction' },
    { pattern: 'dont know what to change', ack: 'no_direction' },
    { pattern: "don't know what to change", ack: 'no_direction' },
    { pattern: 'struggling to stay consistent', ack: 'inconsistency' },
    { pattern: 'cant stay consistent', ack: 'inconsistency' },
    { pattern: "can't stay consistent", ack: 'inconsistency' },
  ];

  for (const { pattern, ack } of patterns) {
    if (lower.includes(pattern)) {
      return { detected: true, acknowledgment_key: ack };
    }
  }
  return null;
}

// ── Main Analyze Function ───────────────────────────────
function analyze(funnelState, lastMessage, leadData, isOutbound, profile) {
  const decisions = {
    crisis: null,
    hostility: null,
    objection: null,
    complex_question: null,
    transparency: false,
    vulnerability: null,
    stage_decision: null,
    length_check: null,
    banned_words: null,
  };

  // Priority 1: Crisis
  decisions.crisis = detectCrisis(lastMessage);
  if (decisions.crisis) {
    decisions.stage_decision = { stage: STAGES.CRISIS, action: 'crisis_stop', reason: 'crisis_detected' };
    return decisions;
  }

  // Priority 2: Hostility
  decisions.hostility = detectHostility(lastMessage);
  if (decisions.hostility) {
    decisions.stage_decision = { stage: STAGES.STOPPED, action: 'hostility_stop', reason: 'hostility_detected' };
    return decisions;
  }

  // Priority 3: Length check
  decisions.length_check = checkConversationLength(funnelState);

  // Priority 4: Stage routing
  decisions.stage_decision = determineStage(funnelState, lastMessage, isOutbound);

  // Priority 5: Objection detection
  decisions.objection = detectObjection(lastMessage, profile);

  // Priority 6: Transparency
  decisions.transparency = detectTransparencyRequest(lastMessage);

  // Priority 7: Vulnerability
  decisions.vulnerability = detectVulnerability(lastMessage);

  return decisions;
}

module.exports = {
  detectCrisis,
  detectHostility,
  detectObjection,
  determineStage,
  checkBannedWords,
  checkConversationLength,
  detectTransparencyRequest,
  detectVulnerability,
  analyze,
};
