/**
 * Hybrid Handler — Jani Havunen (Author + Affiliate)
 * Orchestrates inbound + outbound flows with Supabase state management.
 *
 * Fixes from WhereWeBelong version:
 * - generateResponse signature matches llm_responder
 * - No success field check — use try/catch
 * - Email capture gated (not call link)
 * - No shadowing of rules engine functions
 * - isTerminal only includes actual terminal states
 * - handleOutboundSend runs full analyze()
 * - VALID_TRANSITIONS actually used for stage validation
 */
const { analyze } = require('./rules_engine_jani.cjs');
const { generateResponse } = require('./llm_responder_jani.cjs');
const { validate } = require('./validator_jani.cjs');
const { STAGES, FUNNEL_STARTING_STAGE, getProfileConfig, TIMING } = require('./funnel_config_jani.cjs');

// ── Valid Stage Transitions ──────────────────────────────
const VALID_TRANSITIONS = {
  [STAGES.NEW_LEAD]:          [STAGES.OPENER_SENT],
  [STAGES.OPENER_SENT]:       [STAGES.QUALIFY, STAGES.STOPPED],
  [STAGES.QUALIFY]:           [STAGES.IDENTIFY_OBSTACLE, STAGES.ACKNOWLEDGE, STAGES.STOPPED],
  [STAGES.IDENTIFY_OBSTACLE]: [STAGES.ACKNOWLEDGE, STAGES.STOPPED],
  [STAGES.ACKNOWLEDGE]:       [STAGES.OFFER, STAGES.STOPPED],
  [STAGES.OFFER]:             [STAGES.EMAIL_CAPTURE, STAGES.STAGE1_QUALIFY, STAGES.STOPPED],
  [STAGES.EMAIL_CAPTURE]:     [STAGES.DELIVERED, STAGES.STOPPED],
  [STAGES.DELIVERED]:         [STAGES.COMPLETED],
  [STAGES.COMPLETED]:         [],
  [STAGES.STOPPED]:           [],
  [STAGES.CRISIS]:            [],
  [STAGES.DO_NOT_CONTACT]:    [],
};

// ── Terminal States ──────────────────────────────────────
function isTerminal(stage) {
  return [STAGES.COMPLETED, STAGES.STOPPED, STAGES.CRISIS, STAGES.DO_NOT_CONTACT].includes(stage);
}

// ── Detect if they want the email/training now ───────────
function detectCallLinkIntent(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('send me the link') || lower.includes('send the link') ||
    lower.includes('send it') || lower.includes("what's the link") ||
    lower.includes('yes please') || lower.includes('yeah send') ||
    lower.includes('sure send') || lower.includes('okay send');
}

// ── Detect if they provided an email ─────────────────────
function detectEmailProvided(message) {
  if (!message) return null;
  const emailMatch = message.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  return emailMatch ? emailMatch[0] : null;
}

// ── Detect if they provided a name ───────────────────────
function detectNameProvided(message, existingName) {
  if (!message || existingName) return existingName || null;
  const lower = message.toLowerCase().trim();
  // Simple heuristic: if short message with no spaces and not a question, likely a name
  if (lower.length > 1 && lower.length < 30 && !lower.includes('?') && !lower.includes(' ')) {
    return message.trim();
  }
  return null;
}

// ── Stage Progression ────────────────────────────────────
function handleStageProgression(funnelState, message, profile) {
  const newFunnel = { ...funnelState };
  const stage = funnelState.current_stage || funnelState.stage || FUNNEL_STARTING_STAGE;
  const cfg = getProfileConfig(profile);

  if (stage === STAGES.OFFER) {
    // Check if they accepted the offer
    const accepted = /\b(yes|sure|ok|yeah|send it|send me|please|let's do it|sounds good)\b/i.test(message);
    const declined = /\b(no|nah|not now|maybe later|not interested)\b/i.test(message);
    if (accepted) newFunnel.offer_accepted = true;
    if (declined) newFunnel.current_stage = STAGES.STOPPED;
  }

  return newFunnel;
}

// ── Validate Stage Transition ────────────────────────────
function isValidTransition(fromStage, toStage) {
  const allowed = VALID_TRANSITIONS[fromStage];
  if (!allowed) return false;
  return allowed.includes(toStage);
}

// ── Build Inbound Context ────────────────────────────────
function buildInboundContext(lead, lastMessages, config, funnelState) {
  return {
    handle: lead.ig_handle,
    name: lead.first_name || lead.ig_handle,
    status: lead.status,
    conversationStep: lead.conversation_step,
    followupStep: lead.followup_step || 0,
    funnel: {
      stage: funnelState?.current_stage || funnelState?.stage || FUNNEL_STARTING_STAGE,
      data: funnelState,
    },
    blueprint: config.blueprintType,
    customInstructions: config.aiTrainingContext,
    lastMessages,
    inboundMessage: lastMessages.find(m => m.direction === 'in')?.body || '',
  };
}

// ── Build Outbound Context ───────────────────────────────
function buildOutboundContext(lead, config, funnelState) {
  return {
    handle: lead.ig_handle,
    name: lead.first_name || lead.ig_handle,
    status: lead.status,
    conversationStep: lead.conversation_step,
    followupStep: lead.followup_step || 0,
    funnel: {
      stage: funnelState?.current_stage || funnelState?.stage || FUNNEL_STARTING_STAGE,
      data: funnelState,
    },
    blueprint: config.blueprintType,
    customInstructions: config.aiTrainingContext,
  };
}

// ── Handle Inbound Message ───────────────────────────────
async function handleInboundMessage(lead, lastMessages, config, funnelState, apiKey, profile) {
  if (!lastMessages || !lastMessages.length) {
    return { send: false, error: 'No messages provided' };
  }

  const message = lastMessages[lastMessages.length - 1]?.body || '';
  const stage = funnelState?.current_stage || funnelState?.stage || FUNNEL_STARTING_STAGE;
  const cfg = getProfileConfig(profile);

  // Run rules engine
  const decisions = analyze(funnelState, message);

  // Crisis → stop immediately
  if (decisions.crisis) {
    return {
      send: true,
      text: "I hear you, and I'm sorry you're dealing with that. I don't want to make this about the guide right now. If you want to talk more or revisit this later, I'm here, no pressure either way. Take care of yourself first.",
      decisions,
      funnelState: { ...funnelState, current_stage: STAGES.CRISIS },
      outcome: 'crisis_response',
    };
  }

  // Hostility → stop immediately
  if (decisions.hostility) {
    return {
      send: true,
      text: "Understood, I won't message you again. Take care.",
      decisions,
      funnelState: { ...funnelState, current_stage: STAGES.STOPPED },
      outcome: 'hostile_terminate',
    };
  }

  // Transparency request → answer honestly
  if (decisions.transparency) {
    const isAuthor = profile === 'author';
    const response = isAuthor
      ? "I'm Jani. I'm an author and entrepreneur working on personal growth and lasting change. I reach out to people who might benefit from a free guide I created. I'm not a bot — but I do use tools to manage outreach at scale. Happy to answer anything directly."
      : "I'm Jani. I'm an entrepreneur and author. I reach out to people interested in building extra income because I'm documenting and developing an online-business model. I'm not a bot — but I do use tools to manage outreach at scale. Happy to answer anything directly.";
    return {
      send: true,
      text: response,
      decisions,
      funnelState,
      outcome: 'transparency_response',
    };
  }

  // Stage progression
  let updatedFunnel = handleStageProgression(funnelState, message, profile);

  // Check if they want the training/guide sent (at offer stage)
  if (stage === STAGES.OFFER && detectCallLinkIntent(message)) {
    updatedFunnel.offer_accepted = true;
    updatedFunnel.current_stage = STAGES.EMAIL_CAPTURE;
  }

  // If at email capture stage, check if they provided email
  if (stage === STAGES.EMAIL_CAPTURE || updatedFunnel.current_stage === STAGES.EMAIL_CAPTURE) {
    const email = detectEmailProvided(message);
    if (email) {
      updatedFunnel.captured_email = email;
      updatedFunnel.current_stage = STAGES.DELIVERED;

      // Subscribe to AWeber
      const { subscribe } = require('./aweber_subscribe.cjs');
      const aweberResult = await subscribe({
        accessToken: config.aweberAccessToken,
        listId: cfg.aWeber.listId,
        email,
        name: lead.first_name || '',
        tags: [...cfg.aWeber.tags, `workspace-${config.workspaceId?.substring(0, 8)}`],
        customFields: { ig_handle: lead.ig_handle || '', source: 'instagram_dm' },
        refreshToken: config.aweberRefreshToken,
        clientId: config.aweberClientId,
        clientSecret: config.aweberClientSecret,
        supabase,
        workspaceId: config.workspaceId,
      });

      if (aweberResult.success) {
        log('info', 'AWEBER', `Subscribed ${email} to list ${cfg.aWeber.listId}${aweberResult.duplicate ? ' (duplicate)' : ''}`);
      } else {
        log('warn', 'AWEBER_FAILED', `Failed to subscribe ${email}: ${aweberResult.error}`);
      }

      // Build confirmation
      const name = lead.first_name || lead.ig_handle || 'there';
      const confirmation = cfg.confirmation.replace('{email}', email).replace('{first_name}', name);

      return {
        send: true,
        text: confirmation,
        decisions,
        funnelState: updatedFunnel,
        outcome: 'email_captured',
        capturedEmail: email,
        capturedName: lead.first_name || null,
      };
    }
  }

  // Build context for LLM
  const context = buildInboundContext(lead, lastMessages, config, updatedFunnel);

  // Generate response
  let llmResponse;
  try {
    llmResponse = await generateResponse(decisions, updatedFunnel, message, lead, apiKey, profile);
  } catch (e) {
    return { send: false, error: `LLM error: ${e.message}`, decisions, funnelState: updatedFunnel };
  }

  // Validate
  const validation = validate(llmResponse.text, decisions, updatedFunnel, profile);
  if (!validation.should_send) {
    return { send: false, error: 'Validation failed', errors: validation.errors, decisions, funnelState: updatedFunnel };
  }

  // Advance stage after successful LLM response
  if (updatedFunnel.current_stage === stage && !isTerminal(stage)) {
    const transitionMap = {
      [STAGES.OPENER_SENT]: STAGES.QUALIFY,
      [STAGES.QUALIFY]: STAGES.IDENTIFY_OBSTACLE,
      [STAGES.IDENTIFY_OBSTACLE]: STAGES.ACKNOWLEDGE,
      [STAGES.ACKNOWLEDGE]: STAGES.OFFER,
    };
    if (transitionMap[stage]) {
      updatedFunnel.current_stage = transitionMap[stage];
    }
  }

  return {
    send: true,
    text: llmResponse.text,
    decisions,
    funnelState: updatedFunnel,
    outcome: 'llm_response',
  };
}

// ── Handle Outbound Send ─────────────────────────────────
async function handleOutboundSend(lead, config, funnelState, apiKey, profile) {
  const stage = funnelState?.current_stage || funnelState?.stage || FUNNEL_STARTING_STAGE;
  const cfg = getProfileConfig(profile);

  // Run full analyze for outbound — safety checks still apply
  const decisions = analyze(funnelState, '', lead, true);

  // Safety: crisis/hostility on lead data
  if (decisions.crisis || decisions.hostility) {
    return { send: false, error: 'Safety check failed', decisions };
  }

  // Build context for LLM
  const context = buildOutboundContext(lead, config, funnelState);

  let llmResponse;
  try {
    llmResponse = await generateResponse(decisions, funnelState, '', lead, apiKey, profile);
  } catch (e) {
    return { send: false, error: `LLM error: ${e.message}` };
  }

  // Validate
  const validation = validate(llmResponse.text, decisions, funnelState, profile);
  if (!validation.should_send) {
    return { send: false, error: 'Validation failed', errors: validation.errors };
  }

  // Update funnel state
  let newFunnel = { ...funnelState, current_stage: STAGES.OPENER_SENT };
  if (!newFunnel.stage_started_at) {
    newFunnel.stage_started_at = new Date().toISOString();
  }

  return {
    send: true,
    text: llmResponse.text,
    decisions,
    funnelState: newFunnel,
    outcome: 'outbound_send',
  };
}

module.exports = {
  handleInboundMessage,
  handleOutboundSend,
  isTerminal,
  isValidTransition,
  detectCallLinkIntent,
  detectEmailProvided,
  handleStageProgression,
};
