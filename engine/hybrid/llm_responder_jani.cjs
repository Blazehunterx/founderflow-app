/**
 * Hybrid LLM Responder — Jani Havunen (Author + Affiliate)
 * Rules engine decides WHAT to do, LLM decides HOW to say it.
 */
const { STAGES, getProfileConfig, CRISIS_KEYWORDS } = require('./funnel_config_jani.cjs');
const { checkBannedWords } = require('./rules_engine_jani.cjs');

// ── Author System Prompt ─────────────────────────────────
const AUTHOR_PROMPT = `You are Jani Havunen, an author and entrepreneur. You're writing DMs from your personal Instagram account. This is a real conversation, not a brand account.

CRITICAL RULES:
1. NEVER use banned words: guarantee, proven system, secret method, easy money, get rich, passive income, financial freedom, quit your job, act now, limited time, real, genuine, authentic, grind, crush it, elite, leverage, synergies, scalable.
2. NEVER promise outcomes. The guide is educational, not therapy or treatment.
3. NEVER ask for email before the person agrees to receive the guide.
4. Before requesting email, always state: "You will also receive a few short follow-up emails."
5. Max 1 emoji per message. Zero is fine.
6. One clear question at a time. Short messages.
7. Sound like a real person texting. Not corporate, not salesy.
8. Mirror their energy — if they use emoji, light one back. If not, drop them entirely.
9. Never diagnose trauma, addiction, depression or any mental-health condition.
10. Never turn a vulnerable disclosure into a pitch.

ABOUT THE GUIDE:
- Free 15-page guide called "The Reset Framework"
- Covers survival patterns, identity, 30-day structure, minimum standards
- For people who know something needs to change but need a clearer starting point
- NOT therapy, NOT treatment, NOT a personalised solution
- Educational starting point only

YOUR STORY (use naturally):
Author and entrepreneur building around psychology, personal growth and lasting change. Created The Reset Framework from personal experience with starting over.`;

// ── Affiliate System Prompt ──────────────────────────────
const AFFILIATE_PROMPT = `You are Jani Havunen, an entrepreneur and author. You're writing DMs from your personal Instagram account. This is a real conversation, not a brand account.

CRITICAL RULES:
1. NEVER promise income, imply typical earnings or suggest results are automatic.
2. NEVER use banned words: guarantee, proven system, secret method, easy money, get rich, passive income, financial freedom, quit your job, act now, limited time, real, genuine, authentic, grind, crush it, elite, leverage, synergies, scalable.
3. NEVER ask about prior online business experience as the first qualification question.
4. First clarify what the person wants to achieve and what is currently getting in the way.
5. Before requesting email, always state: "You will also receive a few short follow-up emails."
6. Max 1 emoji per message. Zero is fine.
7. One clear question at a time. Short messages.
8. Sound like a real person texting. Not corporate, not salesy.
9. Mirror their energy — if they use emoji, light one back. If not, drop them entirely.
10. Do not use fake scarcity, fabricated proof or exaggerated lifestyle language.

ABOUT THE TRAINING:
- Free training explaining the affiliate marketing model
- Designed for beginners, no income hype
- Explains how the process works so the person can judge it properly
- NOT a guaranteed income solution

YOUR STORY (use naturally):
Entrepreneur and author. Building personal brand around psychology, personal growth and lasting change. Also developing and documenting the online-business side. Prefer realistic systems over hype.`;

// ── Stage-Specific Instructions ─────────────────────────
const AUTHOR_INSTRUCTIONS = {
  [STAGES.OPENER_SENT]: `Send the opener. Keep it under 2 sentences. One clear question. Could they reply in one word and the conversation still feel complete?`,

  [STAGES.QUALIFY]: `They replied to the opener. Use the qualification question: "What feels like the biggest issue right now: not knowing what to change, repeating the same patterns, or struggling to stay consistent?"
Listen to their answer. One of three categories: no direction, repeating patterns, or inconsistency.`,

  [STAGES.IDENTIFY_OBSTACLE]: `You've identified the category. Move to acknowledgment — use the appropriate pre-approved response for their category. Then transition to the guide offer.`,
  [STAGES.ACKNOWLEDGE]: `Acknowledge their answer with the pre-approved response for their category. Then offer the guide.`,
  [STAGES.OFFER]: `You've offered the guide and they said yes. Now collect email with disclosure. Ask: name and email. State that they'll receive follow-up emails.`,
  [STAGES.EMAIL_CAPTURE]: `Collect the email address. Confirm the name. Then deliver confirmation.`,
  [STAGES.DELIVERED]: `Send the delivery confirmation. Mention the five survival patterns section. Stop DM follow-ups — AWeber handles nurture.`,
};

const AFFILIATE_INSTRUCTIONS = {
  [STAGES.OPENER_SENT]: `Send the opener. Keep it under 2 sentences. One clear question. Could they reply in one word and the conversation still feel complete?`,

  [STAGES.QUALIFY]: `They replied. Ask the goal question: "What would a good result look like for you over the next 6 to 12 months?"
Listen. Then ask about the obstacle.`,
  [STAGES.IDENTIFY_OBSTACLE]: `Use the obstacle question: "What is the main thing getting in the way right now: not knowing where to start, not trusting the available systems, finding time, building an audience, or staying consistent?"
Map their answer to a category: no-system, no-audience, no-time, trust, or consistency.`,

  [STAGES.ACKNOWLEDGE]: `Acknowledge their obstacle with the pre-approved response for their category. Then offer the training.`,
  [STAGES.OFFER]: `You've offered the training and they said yes. Now collect email with disclosure. Ask: name and email. State that they'll receive follow-up emails.`,
  [STAGES.EMAIL_CAPTURE]: `Collect the email address. Confirm the name. Then deliver confirmation.`,
  [STAGES.DELIVERED]: `Send the delivery confirmation. Tell them to go through the training first. Stop DM follow-ups — AWeber handles nurture.`,
};

// ── Build Full Prompt for LLM ───────────────────────────
function buildPrompt(decisions, funnelState, lastMessage, leadData, profile) {
  const cfg = getProfileConfig(profile);
  const stage = decisions.stage_decision?.stage || STAGES.NEW_LEAD;
  const systemPrompt = profile === 'affiliate' ? AFFILIATE_PROMPT : AUTHOR_PROMPT;
  const instructions = (profile === 'affiliate' ? AFFILIATE_INSTRUCTIONS : AUTHOR_INSTRUCTIONS)[stage] || '';
  const history = (funnelState && funnelState.conversation_history) || [];

  const historyText = history.slice(-8).map(h => {
    const role = h.is_me ? 'Jani (you)' : `${leadData?.ig_handle || 'Lead'}`;
    return `${role}: ${h.text}`;
  }).join('\n');

  const guardrails = [];

  if (decisions.objection) {
    const objectionData = (cfg.objections || []).find(o => o.id === decisions.objection.id);
    if (objectionData) {
      guardrails.push(`OBJECTION DETECTED: "${decisions.objection.id}" — root concern: ${objectionData.root}. Handle this objection before anything else.`);
    }
  }

  if (decisions.vulnerability) {
    guardrails.push(`VULNERABILITY DETECTED: They shared something personal. Acknowledge with empathy. Do NOT pitch or offer the guide after this.`);
  }

  if (decisions.transparency) {
    guardrails.push(`TRANSPARENCY REQUEST: They asked what this is or who you are. Be honest and direct. Never claim Jani personally typed a message when he did not.`);
  }

  if (decisions.complex_question) {
    guardrails.push(`COMPLEX QUESTION: They asked about "${decisions.complex_question.pattern}". Answer naturally and honestly.`);
  }

  if (decisions.length_check?.exceeded) {
    guardrails.push(`WARNING: Conversation is at ${decisions.length_check.count} exchanges (max ${decisions.length_check.max}). Wrap up soon.`);
  }

  if (stage === STAGES.OFFER) {
    guardrails.push('OFFER STAGE: Make the permission-based offer. Ask if they want the guide/training. Do NOT send it yet — wait for yes.');
  }

  if (stage === STAGES.EMAIL_CAPTURE) {
    guardrails.push('EMAIL STAGE: Collect name and email. MUST include disclosure: "You will also receive a few short follow-up emails. You can unsubscribe at any time."');
  }

  const leadContext = leadData ? `
LEAD CONTEXT:
- Username: @${leadData.ig_handle || 'unknown'}
- Name: ${leadData.full_name || 'unknown'}
- Bio: ${(leadData.bio || '').substring(0, 200)}
- Current stage: ${stage}
- Exchange count: ${history.length}
` : '';

  return `${systemPrompt}

${leadContext}

STAGE: ${stage}
INSTRUCTIONS: ${instructions}

${guardrails.length > 0 ? 'GUARDRAILS:\n' + guardrails.map(g => '- ' + g).join('\n') : ''}

CONVERSATION HISTORY:
${historyText || '(No previous messages — this is the first exchange)'}

THEIR LATEST MESSAGE: "${lastMessage}"

Generate your response. Be specific to their situation. Sound like a real person texting. One clear thought per message.`;
}

// ── Call Gemini API ──────────────────────────────────────
async function callGemini(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 300,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No text in Gemini response');
  return text.trim();
}

// ── Generate Response (main entry point) ────────────────
async function generateResponse(decisions, funnelState, lastMessage, leadData, apiKey, profile) {
  const stage = decisions.stage_decision?.stage;
  const cfg = getProfileConfig(profile);

  // Crisis / Hostility → use pre-approved responses (no LLM needed)
  if (decisions.crisis) {
    return { text: decisions.crisis.auto_response, source: 'crisis_template', stage };
  }
  if (decisions.hostility) {
    return { text: decisions.hostility.auto_response, source: 'hostility_template', stage };
  }

  // Follow-up → use template (no LLM needed)
  if (decisions.stage_decision?.action === 'send_followup') {
    const name = leadData?.first_name || leadData?.ig_handle || 'there';
    const text = (decisions.stage_decision.followup_text || '').replace('{first_name}', name);
    return { text, source: 'followup_template', stage };
  }

  // Build prompt and call LLM
  const prompt = buildPrompt(decisions, funnelState, lastMessage, leadData, profile);
  const text = await callGemini(prompt, apiKey);
  return { text, source: 'llm', stage };
}

module.exports = {
  buildPrompt,
  callGemini,
  generateResponse,
  AUTHOR_PROMPT,
  AFFILIATE_PROMPT,
  AUTHOR_INSTRUCTIONS,
  AFFILIATE_INSTRUCTIONS,
};
