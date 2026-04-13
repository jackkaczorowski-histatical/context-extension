const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const entityCache = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const cors = {
  "Access-Control-Allow-Origin": "*", // TODO: Lock to chrome-extension://EXTENSION_ID after CWS publish
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-extension-token",
};

const CORRECTIONS = {
  'jacques nacare': 'Jacques Necker',
  'jacques nacre': 'Jacques Necker',
  'jacques naker': 'Jacques Necker',
  'jack nacare': 'Jacques Necker',
  'anne robert turgot': 'Anne Robert Turgot',
  'assignettes': 'Assignats',
  'assignets': 'Assignats',
  'acidnets': 'Assignats',
  'acid nets': 'Assignats',
  'ethnic nets': 'Assignats',
  'asking nats': 'Assignats',
  'aztec gnats': 'Assignats',
  'sean ryan': 'Shawn Ryan',
  'elias suscover': 'Ilya Sutskever',
  'elias suskever': 'Ilya Sutskever',
  'elia sutskever': 'Ilya Sutskever',
  'ilya suskever': 'Ilya Sutskever',
  'signets': 'Assignats',
  's and p 500': 'S&P 500',
  's and p': 'S&P',
  'the dow': 'Dow Jones Industrial Average',
};

const TYPE_OVERRIDES = {
  'versailles': 'place',
  'paris': 'place',
  'bastille': 'place',
  'strait of hormuz': 'place',
  'persian gulf': 'place',
  'karg island': 'place',
  'manhattan': 'place',
};

function correctTranscript(text) {
  let result = text;
  for (const [wrong, right] of Object.entries(CORRECTIONS)) {
    result = result.replace(new RegExp(wrong, 'gi'), right);
  }
  return result;
}

function correctEntities(parsed) {
  if (!parsed) return parsed;
  if (Array.isArray(parsed.entities)) {
    parsed.entities.forEach(entity => {
      const key = (entity.term || '').toLowerCase();
      if (CORRECTIONS[key]) {
        entity.term = CORRECTIONS[key];
      }
      if (entity.description) {
        for (const [wrong, right] of Object.entries(CORRECTIONS)) {
          entity.description = entity.description.replace(new RegExp(wrong, 'gi'), right);
        }
      }
      const typeKey = (entity.term || '').toLowerCase();
      if (TYPE_OVERRIDES[typeKey]) {
        entity.type = TYPE_OVERRIDES[typeKey];
      }
    });
  }
  if (Array.isArray(parsed.insights)) {
    parsed.insights.forEach(insight => {
      if (insight.insight) {
        for (const [wrong, right] of Object.entries(CORRECTIONS)) {
          insight.insight = insight.insight.replace(new RegExp(wrong, 'gi'), right);
        }
      }
      if (insight.detail) {
        for (const [wrong, right] of Object.entries(CORRECTIONS)) {
          insight.detail = insight.detail.replace(new RegExp(wrong, 'gi'), right);
        }
      }
    });
  }
  return parsed;
}

function formatCounts(counts) {
  const entries = Object.entries(counts || {}).filter(([, v]) => v > 0);
  if (entries.length === 0) return "none yet";
  return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
}

function buildCalibrationInstructions(typeCalibration) {
  if (!typeCalibration || typeof typeCalibration !== 'object') return '';
  const instructions = [];
  for (const [type, counts] of Object.entries(typeCalibration)) {
    const knew = counts.knewThis || 0;
    const advanced = counts.tooAdvanced || 0;
    if (knew > 0 && advanced > 0) {
      const knewRatio = knew / advanced;
      const advancedRatio = advanced / knew;
      if (knewRatio > 3) {
        instructions.push(`For '${type}' entities: the user already knows most basics. Extract fewer common ${type} terms and focus on more specific or deeper sub-concepts.`);
      } else if (advancedRatio > 2) {
        instructions.push(`For '${type}' entities: the user finds these challenging. Add more foundational context to descriptions and prefer simpler terminology.`);
      }
    } else if (knew > 3 && advanced === 0) {
      instructions.push(`For '${type}' entities: the user already knows most basics. Extract fewer common ${type} terms and focus on more specific or deeper sub-concepts.`);
    } else if (advanced > 2 && knew === 0) {
      instructions.push(`For '${type}' entities: the user finds these challenging. Add more foundational context to descriptions and prefer simpler terminology.`);
    }
  }
  return instructions.length > 0 ? '\n\nDifficulty calibration based on user reactions:\n' + instructions.join('\n') : '';
}

function buildDifficultyInstructions(difficultyProfile) {
  if (!difficultyProfile || typeof difficultyProfile !== 'object') return '';
  const parts = [];
  if (difficultyProfile.tooEasy && difficultyProfile.tooEasy.length > 0) {
    parts.push(`Types the user finds too easy (go deeper): ${difficultyProfile.tooEasy.join(', ')}.`);
  }
  if (difficultyProfile.tooHard && difficultyProfile.tooHard.length > 0) {
    parts.push(`Types the user finds too hard (simplify): ${difficultyProfile.tooHard.join(', ')}.`);
  }
  return parts.length > 0 ? '\n\nDifficulty profile: ' + parts.join(' ') : '';
}

const STATIC_SYSTEM_PROMPT = `You extract named terms from video transcripts. You ONLY extract words that literally appear in the transcript. Use the exact wording the narrator used — never rephrase (e.g. "divine right" not "Divine Right of Kings", "Versailles" not "Palace of Versailles"). Never invent labels not spoken (e.g. "bread riots", "fiscal collapse").

DO extract: specific palaces/buildings (Versailles, Bastille), named doctrines/ideologies (divine right, laissez-faire), named institutions (Bank of England, Bank of France, National Assembly, Estates General), named people (Anne Robert Turgot, Robespierre, Louis XVI), named wars/events (Seven Years War, American Revolution), specific financial instruments (Assignats, livres), technical terms viewers might not know (tax farmers, salt tax, debt service). Extract 2-4 of these per chunk when they exist.

DO NOT extract: common English words everyone knows (nobility, clergy, counterfeiting, black markets, central banks, liquidity, price controls, monetizing church property, Catholic church, combustion chamber, exhaust, horsepower, cylinder, frying pan, oven, saucepan, cutting board, knife, spatula, stove, grill, mixing bowl, baking sheet, seasoning, salt and pepper), generic phrases (royal accounts, fiscal crisis, French monarchy, French crown, foreign bankers, debt spiral). NEVER extract standalone years as entities (1788, 1792, 1795, 1800, 1720). NEVER extract countries as entities (Greece, Zimbabwe, France, Britain) unless the country name is part of a specific institution like "Bank of France".

EXAMPLES:
"a furious crowd in Paris stormed the Bastille" → [Bastille] (not: French Revolution — not said)
"Wrapped in pageantry wealth and divine right beneath the chandeliers of Versailles" → [divine right, Versailles]
"taxes were collected by private tax farmers who paid the king a lump sum" → [tax farmers]
"Napoleon created the Bank of France to restore confidence in currency" → [Bank of France]
"While Britain had created the Bank of England in 1694" → [Bank of England]
"it began with debt inflation and bread that cost more than wages" → [] (no named terms)
"The nobility and clergy refused to give up privileges" → [] (common English words)
"By 1788 the royal treasury was empty" → [] (just a date and generic phrase)
"Black markets flourished as farmers refused to bring grain to market" → [] (common phrase)
"add 150ml of chicken stock and a tablespoon of red wine vinegar" → [chicken stock (ingredient), red wine vinegar (ingredient)] (specific ingredients with quantities)
"pour in some oil and add the onions" → [] (bare ingredients without quantity or preparation context)

CRITICAL: Prioritize entities that would teach the viewer something new. Skip obvious, common-knowledge terms that any viewer would already know — geographic locations like states or countries, common job titles, or basic vocabulary. Never extract the interviewer, host, or show name as an entity — these are obvious context the viewer already knows. The first entity you return should be the most surprising or educational one in the transcript. Ask yourself: would a curious person pause the video to Google this? If not, skip it. Prefer specific technical terms, named programs, historical events, and expert-level concepts over generic references.

Ask: would a viewer pause and think "what is that?" If yes, extract it. If any adult would understand it without help, don't.

ENTITY TYPE RULES:
- "stock" = ONLY tradeable securities with a real ticker symbol the user could buy — individual stocks and ETFs. Examples: Alphabet (GOOGL), Tesla (TSLA), CIBR, AIQ, MSFT. Cars, historical vehicles, and car models (Maserati Biturbo, Nissan 300ZX, Toyota Supra) are NEVER stock. Historical currencies like Assignats, livres, mandates are NEVER stock.
- "organization" = companies, stock exchanges, institutions, banks, military units. Examples: Nasdaq, NYSE, Goldman Sachs, the Fed, 82nd Airborne, Dow Jones. CRITICAL: Stock EXCHANGES and INDICES (Nasdaq, NYSE, Dow Jones Industrial Average, S&P 500) are "organization", NOT "stock" and NOT "concept". Only things you can buy with a ticker are "stock".
- "place" = buildings, cities, countries, geographic features, landmarks. Examples: Versailles, Bastille, Strait of Hormuz, Paris, Karg Island, Manhattan, Persian Gulf. Do NOT use concept for physical locations.
- "concept" = ideas, strategies, economic principles. Examples: inflation, dollar-cost averaging, divine right, laissez-faire. Do NOT use concept for physical places or locations — use "place" instead.
- "event" = specific historical or current events that HAPPENED. Only things that occurred at a point in time are events. Examples: 2022 market crash, World War II, Seven Years War, storming of the Bastille. The storming of the Bastille is an event, but the Bastille itself is a place. Historical periods and eras (e.g. Paleolithic era, Bronze Age, Renaissance, Enlightenment, Middle Ages) should be typed as event.
- "person" = named individuals. Examples: Elon Musk, Robespierre, Louis XVI.
- "work" = specific books, papers, laws, treaties, films, albums. Examples: "The Wealth of Nations", "Treaty of Versailles", "Dodd-Frank Act", "The Communist Manifesto". These are NOT concepts or events — they are specific named works or documents.
- "legislation" = specific laws, policies, acts, executive orders, regulations. Examples: "Glass-Steagall Act", "The New Deal", "Edict of Nantes", "Magna Carta". Distinguish from events: the signing is an event, the document itself is legislation.
- "metric" = specific statistics, measurements, or quantified claims. Examples: "GDP growth of 3.2%", "unemployment at 14%", "$21 trillion national debt". Only extract when the number is specific and meaningful, not vague references.
- "ingredient" = specific named ingredients with quantity or preparation context.

The 'ingredient' type is for specific named ingredients mentioned with a quantity or preparation method (e.g. "150ml chicken stock", "tablespoon of sugar", "red wine vinegar"). Do not use ingredient type for bare mentions without quantity or preparation context.

Never extract the video's own topic as an entity. If the user is watching a video titled "The Economics Behind the French Revolution", do NOT extract "French Revolution" as an entity — the viewer already knows what the video is about.

Do not extract terms from promotional or call-to-action content. If the transcript contains phrases like 'hit subscribe', 'check out', 'link in the description', 'follow me', 'like and subscribe', 'new video', 'next episode', the chunk is likely outro/promo content — return empty arrays.

Domain-specific jargon always qualifies for extraction, even if the words are common English individually. In a fishing video, terms like 'baitcaster', 'spinning rod', 'weedless', 'creature bait', 'stickbait', 'water column', 'hook set', and 'retrieve' are all jargon that beginners wouldn't understand. In a cooking video, 'mise en place', 'deglaze', 'fond' qualify. In a tech video, 'cache', 'latency', 'throughput' qualify. The test is: would a beginner in THIS specific topic need this term explained? If yes, extract it.

DESCRIPTION LENGTH: One sentence, max 100 characters. Shorter is always better.

FOLLOW-UP QUESTIONS: For each entity, include a followUps array with exactly 2 short questions (max 60 chars each) a curious viewer might ask about this entity IN THE CONTEXT of the video. These should be specific and thought-provoking, not generic. Good for "Bank of England" in a French Revolution video: ["Why didn't France create a central bank?", "How did this give Britain an advantage?"]. Bad: ["What is the Bank of England?", "Tell me more about banking."]. The questions should make the user think "ooh, I want to know that."

PRIORITY: Entity extraction is your PRIMARY task. Always extract ALL qualifying named terms first. Insights are SECONDARY — only extract insights after you have identified every named term in the transcript. If you find 0 entities, you should still look for insights, but never sacrifice entity extraction to produce more insights. A chunk with 3 entities and 1 insight is better than a chunk with 0 entities and 3 insights.

SECOND CATEGORY — INSIGHTS: Beyond named terms, also extract practical knowledge, technique reasoning, and 'why' moments from the transcript. These are things a learner would want to remember but that aren't specific terms. Examples from a cooking video: 'Score the rind on pork chops — prevents curling so they cook evenly', 'Rest meat as long as you cooked it — keeps it moist', 'Add sugar to peppers — accelerates caramelization', 'Crush garlic instead of chopping — releases more flavor with less prep', 'Lay meat away from you in the pan — prevents oil splashing toward you'. Examples from an engineering video: 'Crossing the V balances power but increases air travel distance — a trade-off', 'Bigger turbo = more power but more lag'. Examples from a finance video: 'Printing money doesn't create value, it redistributes it'. Examples from a history/educational video: 'The Hundred Years War strengthened French nationalism — military victory unified regional identities under one crown', 'Rome\\'s integration of Gaul planted the linguistic seed for French — Latin displaced Celtic and evolved over centuries', 'Napoleon\\'s Continental System backfired — blocking British trade hurt French allies more than Britain', 'Colonial losses in the Seven Years War bankrupted France — setting the stage for revolution 20 years later'. An insight must be a specific actionable or memorable piece of knowledge from THIS transcript, not generic advice. Do not extract insights like 'cooking is about confidence' or 'practice makes perfect' — those are motivational, not informational. Max 2 insights per chunk. Pick the most valuable, memorable insights from this transcript chunk. Do not extract motivational statements, generic cooking advice, or restatements of what the narrator literally said. The insight must teach something a viewer couldn't figure out just by watching. Every insight MUST be specific and actionable — it must describe a concrete technique, measurement, timing, or observable cue that applies to THIS specific moment in the video. Reject any insight that could apply to any video in this category, such as 'confidence is important', 'practice leads to improvement', or 'mastering this tool is foundational'. If a viewer could not immediately act on it or look for it right now, do not include it. Category guidance: TRADEOFF (use when something has a meaningful cost or downside), TECHNIQUE (use when describing a method or how something works), TIP (use for actionable advice or best practice), WHY (fallback only when none of the above apply). Prefer TRADEOFF, TECHNIQUE, and TIP over WHY. Only use WHY if the insight genuinely doesn't fit the others. Return them in the same JSON. Return empty arrays when nothing qualifies.

Return ONLY raw JSON, no markdown, no backticks: { "entities": [{ "term": "...", "type": "event|concept|person|place|stock|organization|work|legislation|metric|ingredient", "relevance": 1-3, "ticker": null, "salience": "highlight|background", "description": "max 100 chars", "followUps": ["question1", "question2"] }], "insights": [{ "insight": "short summary", "detail": "one sentence explanation, max 120 chars", "category": "technique|tip|why|tradeoff" }] }. Max 5 entities and 3 insights per chunk. Return { "entities": [], "insights": [] } when nothing qualifies. It is completely fine to return empty arrays.`;

function buildSystemPrompt(pageTitle, knowledgeLevel, interests, tasteProfile, depth, previousEntities, sessionContext, knownTerms, reactionProfile, typeCalibration, difficultyProfile, familiarTerms, topTopics) {
  const title = pageTitle || "unknown content";
  const level = knowledgeLevel || "intermediate";
  const prevList = previousEntities && previousEntities.length > 0 ? previousEntities.join(", ") : "";

  return `The user is watching: "${title}". Their knowledge level: ${level}.${prevList ? ` Already shown this session: ${prevList}.` : ""}${sessionContext ? ` Session transcript so far: ${sessionContext}` : ""}${knownTerms && knownTerms.length > 0 ? ` Known from previous sessions: ${knownTerms.join(", ")}.` : ""}${familiarTerms && familiarTerms.length > 0 ? `\nThe user already knows these terms well (do NOT extract them unless they appear in a genuinely new context): ${familiarTerms.join(", ")}.` : ""}${topTopics ? `\nUser's top interests: ${topTopics}. Prioritize entities in these areas — the user engages most with these topics. For their strong topics, extract more granular/advanced entities. For their weak topics, extract foundational entities with beginner-friendly descriptions.` : ""}${tasteProfile ? ` Engagement: liked types: ${formatCounts(tasteProfile.liked)}, dismissed: ${formatCounts(tasteProfile.ignored)}.` : ""}${reactionProfile ? ` Reactions: ${reactionProfile.known || 0} "knew this", ${reactionProfile.new || 0} "new to me", ${reactionProfile.advanced || 0} "too advanced".` : ""}${buildCalibrationInstructions(typeCalibration)}${buildDifficultyInstructions(difficultyProfile)}${!previousEntities || previousEntities.length <= 2 ? `\n\nFIRST BATCH RULE: This is the beginning of a session. Prioritize the single most surprising, distinctive, or niche entity over completeness. The first card a user sees determines whether they trust the product. A card for "Treaty of Westphalia" is more impressive than a card for "Europe". Lead with specificity.` : ''}`;
}

const Anthropic = require('@anthropic-ai/sdk');
const { rateLimit } = require('./_rateLimit');
const validateRequest = require('./_validateRequest');
const { log } = require('./_log');
const { captureError } = require('./_sentry');
const { checkBudget, recordSpend } = require('./_budget');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  if (!validateRequest(req, res)) return;

  const clientId = req.body?.installId || req.headers['x-forwarded-for'] || 'unknown';
  if (!await rateLimit(clientId, 60, 60000)) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(429).json({ error: 'Rate limited', retry: true });
  }

  const { transcript, pageTitle, userProfile, tasteProfile, reactionProfile, depth, previousEntities, sessionContext, knownTerms, familiarTerms, topTopics, typeCalibration, difficultyProfile } = req.body || {};

  if (!transcript) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing transcript field" });
  }

  const cacheInput = `${pageTitle || ''}::${transcript}`;
  const cacheKey = `entity:${crypto.createHash('sha256').update(cacheInput).digest('hex').slice(0, 32)}`;

  try {
    const cached = await entityCache.get(cacheKey);
    if (cached) {
      log('info', 'analyze_cache_hit', { endpoint: 'analyze' });
      Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(200).json(typeof cached === 'string' ? JSON.parse(cached) : cached);
    }
  } catch (cacheErr) {
    log('warn', 'analyze_cache_read_error', { error: cacheErr.message });
  }

  if (!await checkBudget()) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(503).json({ error: 'high_demand', message: 'Context is experiencing high demand. Please try again later.', retry: true });
  }

  const knowledgeLevel = userProfile?.knowledgeLevel || "intermediate";
  const interests = userProfile?.interests?.length > 0 ? userProfile.interests : ["Finance & Economics", "History & Culture", "Politics & Law", "Science & Technology", "Business & Markets", "Arts & Society"];
  const dynamicSuffix = buildSystemPrompt(pageTitle, knowledgeLevel, interests, tasteProfile, depth, previousEntities, sessionContext, knownTerms, reactionProfile, typeCalibration, difficultyProfile, familiarTerms, topTopics);

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: STATIC_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" }
        },
        {
          type: "text",
          text: dynamicSuffix
        }
      ],
      messages: [{ role: "user", content: correctTranscript(transcript) }],
    }, {
      headers: { "anthropic-beta": "prompt-caching-2024-07-31" }
    });

    let text = (message.content[0].text || '').trim();
    // Strip markdown fences
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
    // Extract JSON object even if surrounded by other text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log('warn', 'analyze_no_json', { endpoint: 'analyze' });
      Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(200).json({ entities: [], insights: [] });
    }
    let parsed;
    try {
      parsed = correctEntities(JSON.parse(jsonMatch[0]));
    } catch (parseErr) {
      log('error', 'analyze_parse_failed', { endpoint: 'analyze', error: parseErr.message });
      Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(200).json({ entities: [], insights: [] });
    }

    try {
      await entityCache.set(cacheKey, JSON.stringify(parsed), { ex: 86400 });
    } catch (cacheErr) {
      log('warn', 'analyze_cache_write_error', { error: cacheErr.message });
    }

    await recordSpend('analyze');

    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).json(parsed);
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      const status = err.status;
      if (status === 529 || status === 503 || status === 429) {
        Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
        return res.status(503).json({ error: "overloaded", retry: true });
      }
    }
    captureError(err, { endpoint: 'analyze', clientId });
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
