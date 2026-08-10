/**
 * Hybrid Rules Engine — Deterministic Decision Layer
 * Runs BEFORE the LLM. Makes hard decisions that the LLM never has to.
 *
 * Architecture: Rules engine decides WHAT to do, LLM decides HOW to say it.
 */
const {
  STAGES, STAGE_ORDER, CRISIS_KEYWORDS, HOSTILITY_KEYWORDS,
  HARD_DISQUALIFIERS, OBJECTIONS, FOLLOW_UP_SEQUENCES,
  COMPLEX_QUESTIONS, TIMING, BANNED_WORDS, BANNED_PATTERNS,
} = require('./funnel_config.cjs');

// ── Crisis Detection (HIGHEST PRIORITY) ─────────────────
function detectCrisis(message) {
  if (!message) return null;
  const lower = message.toLowerCase();

  for (const keyword of CRISIS_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        triggered: true,
        keyword,
        severity: getSeverity(keyword),
        auto_response: 'I hear you, and I\'m sorry you\'re dealing with that. I don\'t want to make this about the community right now. If you want to talk more or revisit this later, I\'m here, no pressure either way. Take care of yourself first.',
        action: 'STOP_ALL',
      };
    }
  }
  return null;
}

function getSeverity(keyword) {
  const critical = ['suicidal', 'suicide', 'kill myself', 'self harm', 'want to die', 'end it'];
  const high = ['depressed', 'depression', 'breakdown', 'crisis', 'giving up', 'can\'t do this anymore'];
  if (critical.some(k => keyword.includes(k))) return 'critical';
  if (high.some(k => keyword.includes(k))) return 'high';
  return 'medium';
}

// ── Hostility Detection ─────────────────────────────────
function detectHostility(message) {
  if (!message) return null;
  const lower = message.toLowerCase();

  for (const keyword of HOSTILITY_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        triggered: true,
        keyword,
        auto_response: 'Understood, I won\'t message you again. Take care.',
        action: 'STOP_ALL',
      };
    }
  }
  return null;
}

// ── Objection Detection ─────────────────────────────────
function detectObjection(message) {
  if (!message) return null;
  const lower = message.toLowerCase();

  for (const obj of OBJECTIONS) {
    for (const pattern of obj.patterns) {
      if (lower.includes(pattern)) {
        return {
          detected: true,
          id: obj.id,
          root: obj.root,
          response_key: obj.response_key,
        };
      }
    }
  }
  return null;
}

// ── Complex Question Detection ──────────────────────────
function detectComplexQuestion(message) {
  if (!message) return null;
  const lower = message.toLowerCase();

  for (const [pattern, answer] of Object.entries(COMPLEX_QUESTIONS)) {
    if (lower.includes(pattern)) {
      return {
        detected: true,
        pattern,
        pre_approved_answer: answer,
      };
    }
  }
  return null;
}

// ── Stage Router ────────────────────────────────────────
// Determines what stage the conversation is at based on state + last message
function determineStage(funnelState, lastMessage, isOutbound) {
  const state = funnelState || {};
  const stage = state.current_stage || STAGES.NEW_LEAD;
  const history = state.conversation_history || [];
  const lastIncoming = history.filter(h => !h.is_me).slice(-1)[0];

  // ── Terminal states — don't move ──
  if ([STAGES.STOPPED, STAGES.CRISIS, STAGES.DO_NOT_CONTACT, STAGES.BOOKED, STAGES.COMPLETED].includes(stage)) {
    return { stage, action: 'none', reason: 'terminal_state' };
  }

  // ── Check if they confirmed booking ──
  if (stage === STAGES.CALL_LINK_SENT && lastIncoming) {
    const confirmed = ['booked', 'done', 'scheduled', 'got it', 'reserved'].some(w =>
      lastIncoming.text.toLowerCase().includes(w)
    );
    if (confirmed) {
      return { stage: STAGES.BOOKED, action: 'log_booking', reason: 'confirmed_booking' };
    }
  }

  // ── Check for follow-up timing ──
  if (stage === STAGES.CALL_LINK_SENT && !state.call_confirmed) {
    const seq = state.followup_sequence || 'A';
    const lastMsgTime = state.last_message_time ? new Date(state.last_message_time).getTime() : Date.now();
    const daysSince = (Date.now() - lastMsgTime) / (1000 * 60 * 60 * 24);
    const followups = FOLLOW_UP_SEQUENCES[seq];

    if (followups) {
      for (const fu of followups.messages) {
        if (daysSince >= fu.day && (!state.followups_sent || !state.followups_sent.includes(fu.day))) {
          return {
            stage: STAGES.FOLLOW_UP,
            action: 'send_followup',
            reason: `followup_day_${fu.day}`,
            followup_day: fu.day,
            followup_text: fu.text,
          };
        }
      }
      if (daysSince > followups.stop_after_day) {
        return { stage: STAGES.STOPPED, action: 'stop', reason: 'followup_sequence_complete' };
      }
    }
  }

  // ── If outbound (first message to a lead) ──
  if (isOutbound && stage === STAGES.NEW_LEAD) {
    return { stage: STAGES.OPENER_SENT, action: 'send_opener', reason: 'new_lead_outbound' };
  }

  // ── Inbound reply to opener ──
  if (stage === STAGES.OPENER_SENT && lastIncoming) {
    return { stage: STAGES.STAGE1_QUALIFY, action: 'qualify', reason: 'reply_to_opener' };
  }

  // ── Stage progression based on conversation depth ──
  const exchangeCount = history.length;
  const hasAskedImpact = state.impact_question_asked;
  const invitationSent = state.invitation_sent;
  const exchangesInStage = state.exchanges_in_current_stage || 0;

  if (stage === STAGES.STAGE1_QUALIFY && exchangesInStage >= 2) {
    return { stage: STAGES.STAGE2_DEEPEN, action: 'deepen', reason: 'after_qualification' };
  }

  if (stage === STAGES.STAGE2_DEEPEN && !hasAskedImpact && exchangesInStage >= 2) {
    return { stage: STAGES.IMPACT_QUESTION, action: 'impact_question', reason: 'after_deepening' };
  }

  if (stage === STAGES.IMPACT_QUESTION && hasAskedImpact) {
    return { stage: STAGES.INVITATION, action: 'invite', reason: 'after_impact' };
  }

  return { stage, action: 'continue', reason: 'no_change' };
}

// ── Disqualifier Check ──────────────────────────────────
function checkDisqualifiers(leadData) {
  const bio = (leadData.bio || '').toLowerCase();
  const niche = (leadData.niche_tags || []).join(' ').toLowerCase();
  const combined = bio + ' ' + niche;

  for (const term of HARD_DISQUALIFIERS.business_types) {
    if (combined.includes(term)) {
      return { disqualified: true, reason: `hard_disqualifier: ${term}`, type: 'business_type' };
    }
  }

  // Check for competitor community
  const competitors = ['fullcircle', 'founders only', 'founderspace', 'nomad escape'];
  for (const c of competitors) {
    if (combined.includes(c)) {
      return { disqualified: true, reason: `competitor: ${c}`, type: 'competitor' };
    }
  }

  return { disqualified: false };
}

// ── Banned Word Check (for validator) ───────────────────
function checkBannedWords(text) {
  if (!text) return { clean: true, violations: [] };

  const lower = text.toLowerCase();
  const violations = [];

  // Check exact banned words
  for (const word of BANNED_WORDS) {
    const regex = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    if (regex.test(text)) {
      violations.push({ type: 'banned_word', word, context: extractContext(text, word) });
    }
  }

  // Check banned patterns
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

// ── Call Link Timing Check ──────────────────────────────
function canSendCallLink(funnelState, lastMessage) {
  const state = funnelState || {};

  // Must have had impact question answered
  if (!state.impact_question_asked) {
    return { allowed: false, reason: 'impact_question_not_asked' };
  }

  // Must have invitation accepted
  if (!state.invitation_accepted) {
    return { allowed: false, reason: 'invitation_not_accepted' };
  }

  // Already sent?
  if (state.call_link_sent) {
    return { allowed: false, reason: 'already_sent' };
  }

  return { allowed: true };
}

// ── Conversation Length Check ────────────────────────────
function checkConversationLength(funnelState) {
  const history = (funnelState && funnelState.conversation_history) || [];
  if (history.length >= TIMING.max_conversation_exchanges) {
    return { exceeded: true, count: history.length, max: TIMING.max_conversation_exchanges };
  }
  return { exceeded: false, count: history.length };
}

// ── Detect "Why are you asking?" / "What is this?" ──────
function detectTransparencyRequest(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  const patterns = [
    'why are you asking', 'what is this', 'what\'s this about',
    'why do you want to know', 'what do you mean', 'who are you',
    'what is this about', 'what\'s going on', 'what are you selling',
    'is this a sales pitch', 'are you selling me something',
  ];
  return patterns.some(p => lower.includes(p));
}

// ── Detect Vulnerable Disclosure (non-crisis) ───────────
function detectVulnerability(message) {
  if (!message) return null;
  const lower = message.toLowerCase();

  const patterns = [
    { pattern: 'missing home', ack: 'missing_family' },
    { pattern: 'missing family', ack: 'missing_family' },
    { pattern: 'lonely', ack: 'successful_but_empty' },
    { pattern: 'isolated', ack: 'successful_but_empty' },
    { pattern: 'burnout', ack: 'burnout' },
    { pattern: 'burned out', ack: 'burnout' },
    { pattern: 'exhausted', ack: 'burnout' },
    { pattern: 'nervous system', ack: 'burnout' },
    { pattern: 'tried other communities', ack: 'tried_communities' },
    { pattern: 'tried masterminds', ack: 'tried_communities' },
    { pattern: 'surface level', ack: 'tried_communities' },
    { pattern: 'dating', ack: 'dating_impossible' },
    { pattern: 'relationship', ack: 'dating_impossible' },
    { pattern: 'building alone', ack: 'building_alone' },
    { pattern: 'nobody to talk', ack: 'building_alone' },
    { pattern: 'nobody nearby', ack: 'building_alone' },
  ];

  for (const { pattern, ack } of patterns) {
    if (lower.includes(pattern)) {
      return { detected: true, acknowledgment_key: ack };
    }
  }
  return null;
}

// ── Detect "Both" in social/business branch ─────────────
function detectBothResponse(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower === 'both' || lower.includes('both') || lower.includes('both honestly');
}

// ── Main Analyze Function ───────────────────────────────
// This is the entry point. Analyzes incoming message + state, returns decisions.
function analyze(funnelState, lastMessage, leadData, isOutbound = false) {
  const decisions = {
    crisis: null,
    hostility: null,
    objection: null,
    complex_question: null,
    transparency: false,
    vulnerability: null,
    stage_decision: null,
    disqualifier: null,
    call_link_check: null,
    length_check: null,
    banned_words: null,
  };

  // Priority 1: Crisis detection
  decisions.crisis = detectCrisis(lastMessage);
  if (decisions.crisis) {
    decisions.stage_decision = { stage: STAGES.CRISIS, action: 'crisis_stop', reason: 'crisis_detected' };
    return decisions;
  }

  // Priority 2: Hostility detection
  decisions.hostility = detectHostility(lastMessage);
  if (decisions.hostility) {
    decisions.stage_decision = { stage: STAGES.STOPPED, action: 'hostility_stop', reason: 'hostility_detected' };
    return decisions;
  }

  // Priority 3: Disqualifier check (on lead data, not message)
  if (leadData) {
    decisions.disqualifier = checkDisqualifiers(leadData);
    if (decisions.disqualifier.disqualified) {
      decisions.stage_decision = { stage: STAGES.DO_NOT_CONTACT, action: 'disqualify', reason: decisions.disqualifier.reason };
      return decisions;
    }
  }

  // Priority 4: Conversation length check
  decisions.length_check = checkConversationLength(funnelState);

  // Priority 5: Stage routing
  decisions.stage_decision = determineStage(funnelState, lastMessage, isOutbound);

  // Priority 6: Objection detection
  decisions.objection = detectObjection(lastMessage);

  // Priority 7: Complex question detection
  decisions.complex_question = detectComplexQuestion(lastMessage);

  // Priority 8: Transparency request
  decisions.transparency = detectTransparencyRequest(lastMessage);

  // Priority 9: Vulnerability detection
  decisions.vulnerability = detectVulnerability(lastMessage);

  // Priority 10: Call link timing
  decisions.call_link_check = canSendCallLink(funnelState, lastMessage);

  return decisions;
}

module.exports = {
  detectCrisis,
  detectHostility,
  detectObjection,
  detectComplexQuestion,
  determineStage,
  checkDisqualifiers,
  checkBannedWords,
  canSendCallLink,
  checkConversationLength,
  detectTransparencyRequest,
  detectVulnerability,
  detectBothResponse,
  analyze,
};
