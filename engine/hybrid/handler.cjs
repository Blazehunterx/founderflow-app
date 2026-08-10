const { analyze } = require('./rules_engine.cjs');
const { generateResponse } = require('./llm_responder.cjs');
const { validate } = require('./validator.cjs');
const { FUNNEL_STARTING_STAGE, STAGES, CALL_LINK } = require('./funnel_config.cjs');

function getApiKey(config) {
  return config.geminiApiKey || config.posterApiKey || process.env.GEMINI_API_KEY;
}

function getStage(funnelState) {
  return funnelState?.current_stage || funnelState?.stage || FUNNEL_STARTING_STAGE;
}

function handleStageProgression(funnelState, message) {
  const newFunnel = { ...funnelState };
  const stage = getStage(funnelState);

  // Track exchanges in current stage
  newFunnel.exchanges_in_current_stage = (funnelState.exchanges_in_current_stage || 0) + 1;

  if (stage === STAGES.INVITATION) {
    const accepted = /yes|sure|let'?s do it|sounds good|ok|yeah|send it/i.test(message);
    const declined = /no|nah|not now|maybe later/i.test(message);
    if (accepted) newFunnel.invitation_accepted = true;
    if (declined) {
      newFunnel.current_stage = STAGES.STAGE1_QUALIFY;
      newFunnel.exchanges_in_current_stage = 0;
    }
  }

  return newFunnel;
}

function isTerminal(stage) {
  return [STAGES.STOPPED, STAGES.CRISIS, STAGES.DO_NOT_CONTACT,
    STAGES.BOOKED, STAGES.COMPLETED].includes(stage);
}

const TRANSPARENCY_RESPONSES = {
  [STAGES.OPENER_SENT]: 'I\'m reaching out because I saw your journey. I help people who are dealing with emotional pain and meaninglessness find a real solution. I\'m part of the WhereWeBelong team. Is it okay if I share what we do?',
  [STAGES.STAGE1_QUALIFY]: 'I\'m not a bot. I\'m part of the WhereWeBelong team — we help people who\'re going through tough times find meaning again. I asked because I want to understand your situation better before sharing anything.',
  [STAGES.STAGE2_DEEPEN]: 'I\'m real. WhereWeBelong is a team of people who\'ve been through similar experiences. We help people rebuild from the inside out. I\'m asking because I care about finding the right fit.',
  [STAGES.IMPACT_QUESTION]: 'I\'m real. WhereWeBelong is a team that helps people reconnect with what matters. I ask because I care about finding the right fit, not just filling spots.',
  [STAGES.INVITATION]: 'I\'m part of WhereWeBelong — a team that helps people reconnect with what matters. I share this because I\'ve seen how much it\'s helped others.',
};

async function handleInboundMessage(lead, lastMessages, config, funnelState) {
  if (!lastMessages || !lastMessages.length) {
    return { send: false, error: 'No messages provided' };
  }

  const message = lastMessages[lastMessages.length - 1]?.body || '';
  const decisions = analyze(funnelState, message, lead);

  if (decisions.crisis) {
    return { send: true, text: decisions.crisis.auto_response, decisions, funnelState, outcome: 'crisis_response' };
  }

  if (decisions.hostility) {
    return { send: true, text: decisions.hostility.auto_response, decisions, funnelState, outcome: 'hostility_response' };
  }

  if (decisions.vulnerability) {
    return { send: true, text: 'I\'m really sorry you\'re going through this. Please reach out to 988 Suicide & Crisis Lifeline (call/text 988). Take care of yourself.', decisions, funnelState, outcome: 'vulnerability_response' };
  }

  if (decisions.transparency) {
    const stage = getStage(funnelState);
    const text = TRANSPARENCY_RESPONSES[stage] || TRANSPARENCY_RESPONSES[STAGES.OPENER_SENT];
    return { send: true, text, decisions, funnelState, outcome: 'transparency_response' };
  }

  const intentToCallLink = message.toLowerCase().includes('send me the link') ||
    message.toLowerCase().includes('send the link') ||
    message.toLowerCase().includes('book a call') ||
    message.toLowerCase().includes('what\'s the link');

  if (intentToCallLink) {
    if (!funnelState?.invitation_accepted) {
      return { send: true, text: 'Sure — before I send it, would you mind sharing what you\'re hoping to get out of a call? I want to make sure it\'s the right fit.', decisions, funnelState, outcome: 'call_link_deflected' };
    }
    if (funnelState?.call_link_sent) {
      return { send: false, decisions, funnelState, outcome: 'already_sent' };
    }
    const text = `Absolutely \u2014 here it is: ${CALL_LINK}. Let me know after you book!`;
    const validation = validate(text, decisions, funnelState);
    if (!validation.should_send) {
      return { send: false, error: 'Validation failed', errors: validation.errors, decisions, funnelState };
    }
    return { send: true, text, decisions, funnelState: { ...funnelState, call_link_sent: true }, outcome: 'call_link_provided' };
  }

  let funnelStateUpdated = handleStageProgression(funnelState, message);

  const apiKey = getApiKey(config);
  if (!apiKey) {
    return { send: false, error: 'No API key configured', decisions, funnelState: funnelStateUpdated };
  }

  try {
    const llmResponse = await generateResponse(decisions, funnelStateUpdated, message, lead, apiKey);
    if (!llmResponse.text) {
      return { send: false, error: 'Empty LLM response', decisions, funnelState: funnelStateUpdated };
    }

    const validation = validate(llmResponse.text, decisions, funnelStateUpdated);
    if (!validation.should_send) {
      return { send: false, error: 'Validation failed', errors: validation.errors, decisions, funnelState: funnelStateUpdated };
    }

    return { send: true, text: llmResponse.text, decisions, funnelState: funnelStateUpdated, outcome: 'llm_response' };
  } catch (e) {
    return { send: false, error: e.message, decisions, funnelState: funnelStateUpdated };
  }
}

async function handleOutboundSend(lead, config, funnelState) {
  const apiKey = getApiKey(config);
  if (!apiKey) {
    return { send: false, error: 'No API key configured' };
  }

  const stage = getStage(funnelState);
  const decisions = analyze(funnelState, '', lead, true);

  if (decisions.crisis || decisions.hostility || decisions.disqualifier?.disqualified) {
    return { send: false, reason: 'safety_block', decisions };
  }

  try {
    const llmResponse = await generateResponse(decisions, funnelState, '', lead, apiKey);
    if (!llmResponse.text) {
      return { send: false, error: 'Empty LLM response' };
    }

    const validation = validate(llmResponse.text, decisions, funnelState);
    if (!validation.should_send) {
      return { send: false, error: 'Validation failed', errors: validation.errors };
    }

    let newFunnel = { ...funnelState, current_stage: llmResponse.stage || stage };
    if (newFunnel.current_stage === STAGES.OPENER_SENT && !newFunnel.stage_started_at) {
      newFunnel.stage_started_at = new Date().toISOString();
    }

    return { send: true, text: llmResponse.text, decisions, funnelState: newFunnel, outcome: 'outbound_send' };
  } catch (e) {
    return { send: false, error: e.message };
  }
}

module.exports = {
  handleInboundMessage,
  handleOutboundSend,
  handleStageProgression,
  isTerminal,
  getStage,
  TRANSPARENCY_RESPONSES,
};
