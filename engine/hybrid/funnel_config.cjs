/**
 * Hybrid Funnel Config — WhereWeBelong v1.3
 * Central configuration for rules engine, LLM, and validator
 */

const FUNNEL_ID = 'wherewebelong';

// ── Stages ──────────────────────────────────────────────
const STAGES = {
  NEW_LEAD:           'new_lead',
  OPENER_SENT:        'opener_sent',
  STAGE1_QUALIFY:     'stage1_qualify',
  STAGE2_DEEPEN:      'stage2_deepen',
  IMPACT_QUESTION:    'impact_question',
  INVITATION:         'invitation',
  CALL_LINK_SENT:     'call_link_sent',
  OBJECTION_HANDLE:   'objection_handle',
  FOLLOW_UP:          'follow_up',
  BOOKED:             'booked',
  COMPLETED:          'completed',
  STOPPED:            'stopped',
  CRISIS:             'crisis',
  DO_NOT_CONTACT:     'do_not_contact',
};

const FUNNEL_STARTING_STAGE = STAGES.NEW_LEAD;

// Stage progression order (for validation)
const STAGE_ORDER = [
  STAGES.NEW_LEAD,
  STAGES.OPENER_SENT,
  STAGES.STAGE1_QUALIFY,
  STAGES.STAGE2_DEEPEN,
  STAGES.IMPACT_QUESTION,
  STAGES.INVITATION,
  STAGES.CALL_LINK_SENT,
  STAGES.BOOKED,
  STAGES.COMPLETED,
];

// ── Banned Words (never use in any response) ────────────
const BANNED_WORDS = [
  'real', 'genuine', 'authentic', // when used as standalone qualifiers
  'grind', 'crush it', 'hustle', 'hustle mode',
  'elite', 'top 1%', 'high-level only',
  'good vibes only', 'manifest your dreams', 'abundance mindset',
  'leverage', 'synergies', 'scalable', 'value proposition',
  'transform your life', 'become your best self',
  'guarantee', 'guaranteed',
  'just networking', // don't flatly deny networking
  'cohort', 'round', // not batch-based
];

// Partial matches — these substrings in any context are banned
const BANNED_PATTERNS = [
  /\breal\s+(friendship|time|conversation|questions|connection|relationship)/gi,
  /\bgenuine\s+(friendship|time|conversation|questions|connection|relationship)/gi,
  /\bauthentic\s+(friendship|time|conversation|questions|connection|relationship)/gi,
  /\btransform\s+.{0,30}\b(days|weeks|months|program)/gi,
  /\bbecome\s+your\s+best\s+self/gi,
];

// ── Crisis Keywords (STOP funnel immediately) ───────────
const CRISIS_KEYWORDS = [
  'barely leaving', 'barely leaving the apartment', 'haven\'t left',
  'suicidal', 'suicide', 'kill myself', 'end it', 'want to die',
  'self harm', 'self-harm', 'cutting myself',
  'mental breakdown', 'having a breakdown',
  'panic attack', 'anxiety attack',
  'depressed', 'depression', 'deeply depressed',
  'not okay', 'not doing okay', 'not doing well',
  'crisis', 'emergency', 'need help',
  'abuse', 'being abused', 'domestic violence',
  'addiction', 'relapsed', 'can\'t stop drinking',
  'lonely', 'isolated', 'no one cares',
  'giving up', 'can\'t do this anymore', 'can\'t take it anymore',
  'rough few months', 'rough few weeks', 'rough patch',
  'dark place', 'in a dark place',
  'numb', 'feeling numb',
  'therapy', 'need a therapist',
];

// ── Hostility / Hard Stop Keywords ──────────────────────
const HOSTILITY_KEYWORDS = [
  'scam', 'scammer', 'scamming',
  'fuck off', 'f off', 'piss off',
  'stop messaging', 'don\'t contact', 'leave me alone',
  'block', 'report',
  'creep', 'creepy',
  'predator',
];

// ── Disqualifiers ───────────────────────────────────────
const HARD_DISQUALIFIERS = {
  business_types: [
    'day trading', 'crypto trading', 'crypto speculation',
    'forex trading',
    'mlm', 'network marketing', 'multi-level',
    'onlyfans management', 'of management', 'adult content management',
    'affiliate marketing', // if it's the ONLY thing
  ],
  red_flags: [
    'watches', 'private jets', 'luxury cars', 'top 1%',
    'look how rich', 'flex', 'money mindset',
  ],
};

// ── Soft Deprioritization Signals ───────────────────────
const SOFT_DEPRIORITIZE = [
  'backpacker', 'gap year', 'traveling for fun',
  'party', 'clubbing', 'drinking lifestyle',
];

// ── Objection Patterns (surface → root concern → handler) ──
const OBJECTIONS = [
  {
    id: 'price',
    patterns: ['how much', 'what does it cost', 'pricing', 'price', 'expensive', 'afford'],
    root: 'Budget uncertainty',
    response_key: 'objection_price',
  },
  {
    id: 'early_stage',
    patterns: ['doesn\'t exist yet', 'too new', 'no proof', 'no track record', 'why pay for something new'],
    root: 'Fair skepticism about early stage',
    response_key: 'objection_early',
  },
  {
    id: 'competitor',
    patterns: ['full circle', 'founders only', 'same as', 'like that other', 'just like'],
    root: 'Pattern-matching to hustle communities',
    response_key: 'objection_competitor',
  },
  {
    id: 'commitment',
    patterns: ['12 months', '12-month', 'year commitment', 'too long', 'can\'t commit', 'don\'t want to commit'],
    root: 'Fear of being locked in',
    response_key: 'objection_commitment',
  },
  {
    id: 'existing_network',
    patterns: ['already have friends', 'already have a network', 'nomad friends', 'solid network'],
    root: 'Believe existing circle solves it',
    response_key: 'objection_existing_network',
  },
  {
    id: 'budget',
    patterns: ['no budget', 'can\'t afford', 'no money', 'too expensive right now', 'broke'],
    root: 'Genuine cash-flow constraint',
    response_key: 'objection_budget',
  },
  {
    id: 'discord',
    patterns: ['just discord', 'just skool', 'free group', 'why pay for a group', 'discord server'],
    root: 'Perceived value mismatch',
    response_key: 'objection_discord',
  },
  {
    id: 'not_social',
    patterns: ['not social', 'introvert', 'don\'t like people', 'not a people person'],
    root: 'Social anxiety or fear of not belonging',
    response_key: 'objection_not_social',
  },
  {
    id: 'alcohol',
    patterns: ['alcohol', 'partying', 'drinking', 'party scene'],
    root: 'Checking values alignment',
    response_key: 'objection_alcohol',
  },
  {
    id: 'bad_fit',
    patterns: ['don\'t like the people', 'what if it\'s not a fit', 'what if I don\'t mesh'],
    root: 'Fear of bad group fit',
    response_key: 'objection_bad_fit',
  },
  {
    id: 'think_about_it',
    patterns: ['need to think', 'think about it', 'not sure', 'let me think', 'on the fence'],
    root: 'Not convinced or not ready',
    response_key: 'objection_think',
  },
  {
    id: 'trust_dms',
    patterns: ['don\'t trust dms', 'random dm', 'cold dm', 'don\'t trust instagram'],
    root: 'Legitimacy concern',
    response_key: 'objection_trust',
  },
  {
    id: 'explain_here',
    patterns: ['explain here', 'just tell me', 'explain in dm', 'can\'t you just say'],
    root: 'Wants to evaluate without committing to call',
    response_key: 'objection_explain',
  },
  {
    id: 'not_nomad',
    patterns: ['not location independent', 'not a nomad', 'not traveling', 'still based in', 'still living in'],
    root: 'Unsure if they qualify',
    response_key: 'objection_not_nomad',
  },
  {
    id: 'proof',
    patterns: ['proof', 'testimonials', 'proof it works', 'show me results', 'case studies'],
    root: 'Wants social proof',
    response_key: 'objection_proof',
  },
  {
    id: 'rejected',
    patterns: ['what if rejected', 'what if i don\'t get in', 'what if you say no'],
    root: 'Fear of rejection',
    response_key: 'objection_rejected',
  },
  {
    id: 'partner',
    patterns: ['talk to my partner', 'ask my wife', 'ask my husband', 'need to check with'],
    root: 'Not sole decision-maker',
    response_key: 'objection_partner',
  },
  {
    id: 'too_good',
    patterns: ['too good to be true', 'what\'s the catch', 'sounds scammy', 'what\'s the trick'],
    root: 'Skepticism from past burns',
    response_key: 'objection_too_good',
  },
  {
    id: 'cult',
    patterns: ['cult', 'sounds like a cult', 'cult-ish'],
    root: 'Perception of controlling environment',
    response_key: 'objection_cult',
  },
];

// ── Opener Templates ────────────────────────────────────
const OPENERS = {
  A: {
    name: 'general_curiosity',
    template: 'Hey {first_name}, saw you\'re also living the nomad life. What\'s been your favourite place so far? 👀',
    alt: 'Hey {first_name}, noticed you\'re nomading too. Where\'s been the best base so far?',
  },
  B: {
    name: 'location_specific',
    template: 'Hey {first_name}, you\'re in {city} right now right? Worth the hype or kind of overrated?',
    alt: 'Hey {first_name}, how\'s {city}? Been thinking about heading there myself.',
    // Cannot use "worth the hype" for places Walerij has been
    blocked_locations: ['bali', 'thailand', 'malaysia', 'singapore', 'vietnam', 'laos', 'sri lanka'],
  },
  C: {
    name: 'content_reaction',
    template: 'Hey {first_name}, that {specific_post} lowkey sold me on {place}. How long have you been out there?',
  },
  D: {
    name: 'relatable_humor',
    template: 'Hey {first_name}, you\'re a nomad too, right? How do you keep friendships going when people come and go all the time? Curious what others do.',
  },
  E: {
    name: 'business_curious',
    template: 'Hey {first_name}, respect for building {business} while travelling, that\'s a whole different kind of chaos. How long you been doing it?',
  },
  F: {
    name: 'reply_to_engagement',
    template: 'Hey {first_name}, saw your comment on {post}, felt that. Where are you based right now?',
  },
};

// ── Acknowledgment Responses ────────────────────────────
const ACKNOWLEDGMENTS = {
  building_alone: 'That\'s the part nobody warn you about. Free enough to build anything, and nobody in the room to tell you if it\'s a good idea.',
  friendships_reset: 'Yeah, that tracks. Most people just stop investing after a while because what\'s the point if everyone leaves in six weeks.',
  successful_but_empty: 'That\'s a strange spot to be in, doing well by every metric that shows up on a screen, and still feeling like something\'s missing.',
  dating_impossible: 'Makes sense. Hard to build something lasting with someone when your address changes every month.',
  burnout: 'That tracks. New country, new routine, new everything, over and over, that\'s exhausting even when it looks like freedom from the outside.',
  tried_communities: 'A lot of those are networking dressed up as community. Different thing entirely from actually being known by people.',
  complex_answer: 'There\'s a lot in that. I don\'t want to rush past it with a quick reply. Give me a second.',
  missing_family: 'That one doesn\'t get talked about enough. The distance is genuinely hard, even when the lifestyle is the right call.',
};

// ── Call Link ───────────────────────────────────────────
const CALL_LINK = 'meet.walerij.com/alignment';
const CALL_DURATION = '45 minutes';
const CALL_NOTE = 'it\'s just me on the other end, no team';

// ── Follow-Up Sequences (timing in days) ────────────────
const FOLLOW_UP_SEQUENCES = {
  A: { // Call link sent, no booking confirmation
    messages: [
      { day: 2, text: 'Hey {first_name}, did you find a free spot? If not, let me know, I can open up some more depending on your timezone.' },
      { day: 9, text: 'Hey {first_name}, circling back. If you want to grab that call or have questions first, I\'m here. No rush at all.' },
      { day: 16, text: 'Hey {first_name}, last message from me on this. If you ever want to revisit it, the door\'s open. Take care.' },
    ],
    stop_after_day: 16,
  },
  B: { // Said "not now" or "let me think"
    messages: [
      { day: 14, text: 'Hey {first_name}, just checking in. No pressure, door\'s still open if the timing\'s better now.' },
      { day: 30, text: 'Hey {first_name}, hope things are going well out there. If you ever want to revisit this, I\'m around. Take care.' },
    ],
    stop_after_day: 30,
  },
  C: { // Call booked, no-show
    messages: [
      { day: 2, text: 'Hey {first_name}, no worries if life got busy, just want to make sure you saw this. Want to find a new time?' },
      { day: 7, text: 'Hey {first_name}, all good either way, the offer stands whenever it\'s right. Take care.' },
    ],
    stop_after_day: 7,
  },
};

// ── Complex Questions (15) ──────────────────────────────
const COMPLEX_QUESTIONS = {
  'what happens day to day': 'Weekly or biweekly Peer Circle calls with your group of 3-4, a monthly Picnic Call with the whole community, occasional masterclasses with guest speakers, and an ongoing group chat where people actually check in on each other, not just post updates.',
  'how many members': 'Honestly, still early, founding members, growing month by month. I ran a free version of this before, in German, and it didn\'t really stick, when something\'s free, people don\'t always show up the way they do once everyone\'s actually committed. This time it\'s paid and English from day one. Happy to tell you exactly where the count stands when we talk.',
  'why skool': 'The platform might change down the line, but Skool has what\'s needed right now and it\'s simple to use. Honestly the platform matters a lot less than who\'s actually in it.',
  'proof it works': 'Yes, it works, because communities, masterminds, and group travel like this exist all over the world already, I\'m not inventing the concept, just building a specific niche and a specific mix of people. Masterminds specifically have worked for decades.',
  'therapy or coaching': 'No. It\'s peer support between founders living the same kind of life, not clinical or professional treatment.',
  'online vs coliving': 'The online community, the Digital Home, is the ongoing core. Chapters are the live side, colivings and events in different countries. Most people start with the Digital Home.',
  'non founders': 'Yeah, founders, or people building some sort of business. What doesn\'t really fit is someone working a corporate job remotely with nothing of their own.',
  'english not first': 'I\'m not a native English speaker either, I\'m German. It\'s fine. Most members won\'t be native speakers either.',
  'organic friends': 'Time, mainly, months and years, not weeks. Organic friendships on the road rarely get that much runway before someone moves.',
  'your story': 'I\'m Walerij. Moved from Germany to Bali in 2022 for what was supposed to be one semester, and never really left. WhereWeBelong is the thing I actually wanted to exist for myself. Happy to have you look at my page directly, @walerij.koko, before deciding anything.',
  'want to leave': 'You can, but the commitment is 12 months. If it comes up early, I\'d want to understand why first, sometimes it\'s solvable.',
  'coliving refund': 'Colivings are handled separately from the membership, priced at cost. If something genuinely unexpected happens, we handle it individually.',
  'membership refund': 'Yes, there\'s a money-back guarantee. After 6 months, if you\'ve used the community the way it\'s meant to be used and still didn\'t get any value, I\'ll refund the full amount.',
  'my niche': 'It\'s a mix on purpose, different skills, different industries. The mix is actually the value. You get perspectives you\'d never get in a room full of people doing exactly what you do.',
  'paid friend group': 'Kind of, yeah, and I\'m not going to dress that up as something fancier. What you\'re actually paying for is friendship and business sparring that take intention and structure to happen reliably.',
};

// ── ICP Scoring Weights ─────────────────────────────────
const ICP_WEIGHTS = {
  revenue:     { max: 5 },
  lifestyle:   { max: 5 },
  pain:        { max: 5 },
  values_fit:  { max: 5 },
  engagement:  { max: 5 },
  followers:   { max: 5 },
};

// ── Timing Rules ────────────────────────────────────────
const TIMING = {
  min_gap_between_dm_minutes: 2,
  follow_up_after_no_reply_hours: 48,
  max_followups: 3,
  max_conversation_exchanges: 15,
  crisis_cooldown_hours: 24,
};

module.exports = {
  FUNNEL_ID,
  FUNNEL_STARTING_STAGE,
  STAGES,
  STAGE_ORDER,
  BANNED_WORDS,
  BANNED_PATTERNS,
  CRISIS_KEYWORDS,
  HOSTILITY_KEYWORDS,
  HARD_DISQUALIFIERS,
  SOFT_DEPRIORITIZE,
  OBJECTIONS,
  OPENERS,
  ACKNOWLEDGMENTS,
  CALL_LINK,
  CALL_DURATION,
  CALL_NOTE,
  FOLLOW_UP_SEQUENCES,
  COMPLEX_QUESTIONS,
  ICP_WEIGHTS,
  TIMING,
};
