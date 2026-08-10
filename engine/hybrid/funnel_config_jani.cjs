/**
 * Hybrid Funnel Config — Jani Havunen (Author + Affiliate)
 * Both funnels share the same stage structure, different content
 *
 * Author: Free 15-page "Reset Framework" guide → AWeber list 6961178
 * Affiliate: Free training (Warpath Code) → AWeber list 6941925
 */

// ── Shared Stages (identical for both funnels) ──────────
const STAGES = {
  NEW_LEAD:           'new_lead',
  OPENER_SENT:        'opener_sent',
  QUALIFY:            'qualify',
  IDENTIFY_OBSTACLE:  'identify_obstacle',
  ACKNOWLEDGE:        'acknowledge',
  OFFER:              'offer',
  EMAIL_CAPTURE:      'email_capture',
  DELIVERED:          'delivered',
  COMPLETED:          'completed',
  STOPPED:            'stopped',
  CRISIS:             'crisis',
  DO_NOT_CONTACT:     'do_not_contact',
};

const FUNNEL_STARTING_STAGE = STAGES.NEW_LEAD;

const STAGE_ORDER = [
  STAGES.NEW_LEAD,
  STAGES.OPENER_SENT,
  STAGES.QUALIFY,
  STAGES.IDENTIFY_OBSTACLE,
  STAGES.ACKNOWLEDGE,
  STAGES.OFFER,
  STAGES.EMAIL_CAPTURE,
  STAGES.DELIVERED,
  STAGES.COMPLETED,
];

// ── Shared Banned Words ──────────────────────────────────
const BANNED_WORDS = [
  'guarantee', 'guaranteed', 'guaranteed income',
  'passive income', 'easy money', 'get rich',
  'financial freedom', 'quit your job',
  'no experience needed', 'anyone can do it',
  'proven system', 'secret method',
  'act now', 'limited time', 'only spots left',
  'dont miss out', "don't miss out",
  'real', 'genuine', 'authentic',
  'grind', 'crush it', 'hustle mode',
  'elite', 'top 1%', 'high-level only',
  'good vibes only', 'manifest your dreams',
  'leverage', 'synergies', 'scalable',
  'transform your life', 'become your best self',
  'cohort', 'round',
];

const BANNED_PATTERNS = [
  /\bearn\s+\$?\d+/gi,
  /\bmake\s+\$?\d+/gi,
  /\b\$\d+\s*(per|a)\s*month/gi,
  /\bincome\s+of\s+\$?\d+/gi,
  /\bguaranteed?\s+results?\b/gi,
  /\btransform\s+.{0,30}\b(days|weeks|months|program)/gi,
];

// ── Shared Crisis Keywords ───────────────────────────────
const CRISIS_KEYWORDS = [
  'suicidal', 'suicide', 'kill myself', 'end it', 'want to die',
  'self harm', 'self-harm', 'cutting myself',
  'mental breakdown', 'having a breakdown',
  'panic attack', 'anxiety attack',
  'depressed', 'depression', 'deeply depressed',
  'not okay', 'not doing okay', 'not doing well',
  'crisis', 'emergency', 'need help',
  'abuse', 'being abused', 'domestic violence',
  'addiction', 'relapsed', "can't stop drinking",
  'giving up', "can't do this anymore", "can't take it anymore",
  'dark place', 'in a dark place',
  'numb', 'feeling numb',
  'therapy', 'need a therapist',
  'barely leaving', "haven't left",
  'lonely', 'isolated', 'no one cares',
  'rough few months', 'rough few weeks', 'rough patch',
];

// ── Shared Hostility Keywords ────────────────────────────
const HOSTILITY_KEYWORDS = [
  'scam', 'scammer', 'scamming',
  'fuck off', 'f off', 'piss off',
  'stop messaging', "don't contact", 'leave me alone',
  'block', 'report',
  'creep', 'creepy',
  'predator',
];

// ── Timing Rules ─────────────────────────────────────────
const TIMING = {
  min_gap_between_dm_minutes: 2,
  follow_up_after_no_reply_hours: 48,
  max_followups: 1,
  max_conversation_exchanges: 8,
  crisis_cooldown_hours: 24,
};

// ═══════════════════════════════════════════════════════════
// AUTHOR PROFILE — "The Reset Framework"
// ═══════════════════════════════════════════════════════════

const AUTHOR = {
  profile: 'author',
  aWeber: {
    listId: '6961178',
    listName: 'lead-magnet-free',
    coreTags: ['source-instagram-outreach', 'brand-author', 'dream100-author', 'opt-in-free-guide', 'free-guide-requested'],
  },

  openers: {
    general: 'Hey {first_name}, quick question. Have you been feeling stuck in some area of your life lately, or are things moving in the right direction?',
    focused: 'Hey {first_name}, honest question. Do you feel like something needs to change, but you are not completely sure where to begin?',
    comment_based: 'Hey {first_name}, I saw your comment about feeling stuck. Are you actively trying to make a real change right now, or was the post simply something you related to?',
  },

  qualification: 'What feels like the biggest issue right now: not knowing what to change, repeating the same patterns, or struggling to stay consistent?',

  acknowledgments: {
    no_direction: 'That makes sense. It is difficult to build structure when the next step is still unclear.',
    repeating_patterns: 'I understand. Recognising the pattern is usually the first useful move, but it still needs a structure around it.',
    inconsistency: 'That is common. Motivation can start something, but it usually does not hold it together.',
    complex_answer: 'I hear you. There is a lot in that, and I do not want to reduce it to a quick answer.',
  },

  offer: 'That makes sense. I created a free 15-page guide called The Reset Framework for people who know something needs to change but need a clearer starting point. It covers survival patterns, identity and a simple structure for rebuilding. Would you like me to send it?',

  emailRequest: 'Sure. What is your first name and best email address? I will send the guide there. You will also receive a few short follow-up emails with practical insights connected to the guide. You can unsubscribe at any time.',

  confirmation: 'Perfect. I have sent it to {email}. Check your spam or promotions folder if it does not arrive. Start with the section on the five survival patterns. It will make the rest of the guide clearer.',

  objections: [
    { id: 'what_is_in_it', patterns: ['what is in the guide', 'what does it cover', 'what does it include'], root: 'Needs to know value before committing' },
    { id: 'is_it_free', patterns: ['is it really free', 'whats the catch', 'what is the catch'], root: 'Skepticism about free offers' },
    { id: 'send_link_here', patterns: ['can you just send the link', 'send it here', 'just send it'], root: 'Prefers DM over email' },
    { id: 'tell_me_what_to_do', patterns: ['can you tell me what to do', 'just tell me', 'what should i do'], root: 'Wants direct advice now' },
    { id: 'in_therapy', patterns: ['already in therapy', 'i have a therapist', 'in therapy'], root: 'Worried about overlap' },
    { id: 'no_thanks', patterns: ['no thanks', 'not interested', 'no thank you'], root: 'Not ready or not relevant' },
    { id: 'automated', patterns: ['are you jani', 'is this automated', 'are you a bot', 'is this a real person'], root: 'Authenticity concern' },
  ],
};

// ═══════════════════════════════════════════════════════════
// AFFILIATE PROFILE — "The Warpath Code"
// ═══════════════════════════════════════════════════════════

const AFFILIATE = {
  profile: 'affiliate',
  aWeber: {
    listId: '6941925',
    listName: '7FA',
    coreTags: ['source-instagram-outreach', 'brand-affiliate', 'dream100-affiliate', 'free-training-requested'],
  },

  openers: {
    general: 'Hey {first_name}, quick question. Are you currently trying to build an extra income stream online, or are you mainly interested in the content?',
    goal_based: 'Hey {first_name}, what are you actually trying to achieve right now: extra income, more freedom, or building something of your own?',
    contextual: 'Hey {first_name}, I saw your comment about wanting to start online. What kind of result are you actually trying to create right now?',
  },

  qualification: 'Got it. What would a good result look like for you over the next 6 to 12 months?',

  obstacleQuestion: 'What is the main thing getting in the way right now: not knowing where to start, not trusting the available systems, finding time, building an audience, or staying consistent?',

  acknowledgments: {
    no_clear_starting_point: 'That makes sense. Most beginners do not need more random information. They need a clear model and the right first steps.',
    distrust: 'I understand. There is a lot of hype in this space, so scepticism is reasonable.',
    no_audience: 'That is a common concern. An audience helps, but the real question is how traffic and trust are built.',
    no_time: 'That makes sense. The system has to fit real life, not assume unlimited time.',
    inconsistency: 'That is usually less about motivation and more about having a repeatable process.',
  },

  aboutJani: 'I am an entrepreneur and author. Right now I am building my personal brand around psychology, personal growth and lasting change, while also developing and documenting the online-business side. I prefer realistic systems over hype, and I am still learning and improving the outreach process as well.',

  offer: 'That makes sense. I have a free training that explains the model I am using and how the process works for a beginner, without the usual income hype. Would you like me to send it?',

  emailRequest: 'Sure. What is your first name and best email address? I will send the training there. You will also receive a few short follow-up emails with practical information about the system and next steps. You can unsubscribe at any time.',

  confirmation: 'Perfect. I have sent it to {email}. Check your spam or promotions folder if it does not arrive. Go through the training first, then reply with the part that feels most relevant or unclear.',

  objections: [
    { id: 'does_it_work', patterns: ['does this actually work', 'does it work', 'is this legit'], root: 'Needs proof of concept' },
    { id: 'how_much', patterns: ['how much can i make', 'how much money', 'what can i earn'], root: 'Wants income expectations' },
    { id: 'need_followers', patterns: ['do i need followers', 'need an audience', 'no followers'], root: 'Worried about prerequisites' },
    { id: 'what_are_you_selling', patterns: ['what are you selling', 'whats the catch', 'is this a sales pitch'], root: 'Suspicion of hidden agenda' },
    { id: 'never_done_online', patterns: ['never done online', 'no experience', 'first time'], root: 'Lack of confidence' },
    { id: 'just_like_content', patterns: ['only like the content', 'just here for content'], root: 'Not interested in business' },
    { id: 'no_thanks', patterns: ['no thanks', 'not interested', 'no thank you'], root: 'Not ready or not relevant' },
    { id: 'automated', patterns: ['are you jani', 'is this automated', 'are you a bot', 'is this a real person'], root: 'Authenticity concern' },
  ],
};

// ── Map profile name to config ───────────────────────────
const PROFILES = {
  author: AUTHOR,
  affiliate: AFFILIATE,
};

function getProfileConfig(profileName) {
  return PROFILES[profileName] || AUTHOR;
}

module.exports = {
  STAGES,
  FUNNEL_STARTING_STAGE,
  STAGE_ORDER,
  BANNED_WORDS,
  BANNED_PATTERNS,
  CRISIS_KEYWORDS,
  HOSTILITY_KEYWORDS,
  TIMING,
  AUTHOR,
  AFFILIATE,
  PROFILES,
  getProfileConfig,
};
