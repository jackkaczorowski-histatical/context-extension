const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function formatCounts(counts) {
  const entries = Object.entries(counts || {}).filter(([, v]) => v > 0);
  if (entries.length === 0) return "none yet";
  return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
}

function buildSystemPrompt(pageTitle, knowledgeLevel, interests, tasteProfile, depth, previousEntities, sessionContext, knownTerms, reactionProfile) {
  const title = pageTitle || "unknown content";
  const level = knowledgeLevel || "intermediate";
  const prevList = previousEntities && previousEntities.length > 0 ? previousEntities.join(", ") : "";

  return `You extract named terms from video transcripts. You ONLY extract words that literally appear in the transcript. Use the exact wording the narrator used — never rephrase (e.g. "divine right" not "Divine Right of Kings", "Versailles" not "Palace of Versailles"). Never invent labels not spoken (e.g. "bread riots", "fiscal collapse").

DO extract: specific palaces/buildings (Versailles, Bastille), named doctrines/ideologies (divine right, laissez-faire), named institutions (Bank of England, Bank of France, National Assembly, Estates General), named people (Anne Robert Turgot, Robespierre, Louis XVI), named wars/events (Seven Years War, American Revolution), specific financial instruments (Assignats, livres), technical terms viewers might not know (tax farmers, salt tax, debt service). Extract 2-4 of these per chunk when they exist.

DO NOT extract: common English words everyone knows (nobility, clergy, counterfeiting, black markets, central banks, liquidity, price controls, monetizing church property, Catholic church), generic phrases (royal accounts, fiscal crisis, French monarchy, French crown, foreign bankers, debt spiral). NEVER extract standalone years as entities (1788, 1792, 1795, 1800, 1720). NEVER extract countries as entities (Greece, Zimbabwe, France, Britain) unless the country name is part of a specific institution like "Bank of France".

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

Ask: would a viewer pause and think "what is that?" If yes, extract it. If any adult would understand it without help, don't.

The 'stock' type is ONLY for currently publicly traded companies with real ticker symbols (e.g. AAPL, TSLA, MSFT). Cars, historical vehicles, and car models (Maserati Biturbo, Nissan 300ZX, Toyota Supra) are type 'concept' or 'event', never 'stock'. Historical currencies like Assignats, livres, mandates are type 'concept', not 'stock'.

Never extract the video's own topic as an entity. If the user is watching a video titled "The Economics Behind the French Revolution", do NOT extract "French Revolution" as an entity — the viewer already knows what the video is about.

Do not extract terms from promotional or call-to-action content. If the transcript contains phrases like 'hit subscribe', 'check out', 'link in the description', 'follow me', 'like and subscribe', 'new video', 'next episode', the chunk is likely outro/promo content — return empty arrays.

Domain-specific jargon always qualifies for extraction, even if the words are common English individually. In a fishing video, terms like 'baitcaster', 'spinning rod', 'weedless', 'creature bait', 'stickbait', 'water column', 'hook set', and 'retrieve' are all jargon that beginners wouldn't understand. In a cooking video, 'mise en place', 'deglaze', 'fond' qualify. In a tech video, 'cache', 'latency', 'throughput' qualify. The test is: would a beginner in THIS specific topic need this term explained? If yes, extract it.

DESCRIPTION LENGTH: One sentence, max 100 characters. Shorter is always better.

The user is watching: "${title}". Their knowledge level: ${level}.${prevList ? ` Already shown this session: ${prevList}.` : ""}${sessionContext ? ` Session transcript so far: ${sessionContext}` : ""}${knownTerms && knownTerms.length > 0 ? ` Known from previous sessions: ${knownTerms.join(", ")}.` : ""}${tasteProfile ? ` Engagement: liked types: ${formatCounts(tasteProfile.liked)}, dismissed: ${formatCounts(tasteProfile.ignored)}.` : ""}${reactionProfile ? ` Reactions: ${reactionProfile.known || 0} "knew this", ${reactionProfile.new || 0} "new to me", ${reactionProfile.advanced || 0} "too advanced".` : ""}

Return ONLY raw JSON, no markdown, no backticks: { "entities": [{ "term": "...", "type": "event|concept|person|stock|organization", "relevance": 1-3, "ticker": null, "salience": "highlight|background", "description": "max 100 chars" }] }. Max 5 per chunk. Return { "entities": [] } when no named terms exist. It is completely fine to return empty arrays.`;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { transcript, pageTitle, userProfile, tasteProfile, reactionProfile, depth, previousEntities, sessionContext, knownTerms } = req.body || {};

  if (!transcript) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing transcript field" });
  }

  const knowledgeLevel = userProfile?.knowledgeLevel || "intermediate";
  const interests = userProfile?.interests?.length > 0 ? userProfile.interests : ["Finance & Economics", "History & Culture", "Politics & Law", "Science & Technology", "Business & Markets", "Arts & Society"];
  const systemPrompt = buildSystemPrompt(pageTitle, knowledgeLevel, interests, tasteProfile, depth, previousEntities, sessionContext, knownTerms, reactionProfile);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: transcript }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(errBody);
    }

    const message = await response.json();
    let text = message.content[0].text;
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
    const parsed = JSON.parse(text);

    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).json(parsed);
  } catch (err) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ error: err.message });
  }
};
