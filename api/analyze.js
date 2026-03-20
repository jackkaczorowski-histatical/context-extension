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

  return `You extract named terms from video transcripts. You ONLY extract words that literally appear in the transcript.

EXAMPLES:

Transcript: "a furious crowd in Paris stormed the Bastille"
Good: Bastille
Bad: French Revolution (not said), Parisian uprising (not said)

Transcript: "Wrapped in pageantry wealth and divine right beneath the chandeliers of Versailles"
Good: divine right, Versailles
Bad: Divine Right of Kings (narrator said "divine right"), Palace of Versailles (narrator said "Versailles")

Transcript: "it began with debt inflation and bread that cost more than wages"
Good: [] (no named terms here, just common English words)
Bad: sovereign debt (not said), inflation crisis (not said), bread riots (not said)

Transcript: "While Britain had created the Bank of England in 1694"
Good: Bank of England
Bad: British financial system (not said), central banking (not said)

Transcript: "reckless borrowing unfair taxation and paper money spiraling into worthlessness"
Good: [] (these are descriptions, not named terms)
Bad: debt spiral (not said), fiscal collapse (not said)

Transcript: "France was one of the wealthiest and most powerful nations in Europe with nearly 30 million people"
Good: [] (France and Europe are common knowledge, not terms to explain)
Bad: France (too generic), Europe (too generic)

Transcript: "taxes were collected by private tax farmers who paid the king a lump sum"
Good: tax farmers
Bad: taxation system (not a named term)

Transcript: "The nobility and clergy refused to give up privileges"
Good: [] (nobility and clergy are common English words, not specialized terms)
Bad: nobility (too basic), clergy (too basic)

Transcript: "By 1788 the royal treasury was empty"
Good: [] (1788 is just a year, not a term to explain)
Bad: 1788 (just a date), royal treasury (generic phrase)

Transcript: "The streets of Paris erupted in protest"
Good: [] (Paris is a well-known city, not a term needing explanation)
Bad: Paris (too well-known)

Transcript: "The French crown owed enormous debts to foreign bankers"
Good: [] (these are common words describing a situation)
Bad: French crown (just means the monarchy), foreign bankers (generic)

Transcript: "Napoleon created the Bank of France to restore confidence in currency"
Good: Bank of France
Bad: Napoleon's financial reset (invented label, not a real term)

Transcript: "Central banks flood economies with liquidity whenever crises strike"
Good: [] (central banks and liquidity are generic words everyone knows)
Bad: central banks (too common), liquidity (too common), printing (too common)

Transcript: "His reports showed deficits so deep it rattled public confidence"
Good: [] (no named terms here, just a description of events)
Bad: royal accounts (generic phrase), French monarchy (too basic, everyone watching this video knows what it is)

Transcript: "By 1788 the monarchy could not secure loans"
Good: [] (no named terms, just a date and common words)
Bad: 1788 (just a date, already covered in bad examples)

Transcript: "Trust in the currency collapsed. Counterfeiting became rampant."
Good: [] (no named terms, just common English words)
Bad: counterfeiting (common English word), fiscal crisis (generic phrase)

Transcript: "Black markets flourished as farmers refused to bring grain to market"
Good: [] (no named terms, just everyday phrases)
Bad: black markets (common phrase everyone understands)

Never extract years as standalone entities (1788, 1792, 1795 etc). Never extract common English phrases that any adult would understand without help (black markets, counterfeiting, price controls, fiscal crisis).

IMPORTANT: The examples above show what NOT to extract. But you should still extract 2-4 named terms per chunk when they exist. Versailles, divine right, Bank of England, tax farmers, Guillotine, Estates General — these are all good extractions because viewers would want to know about them. Don't be so cautious that you return empty arrays when real named terms are present. If the narrator mentions a specific place, person, doctrine, institution, or historical concept by name, extract it.

Never extract country names (France, Britain, Spain etc) or continent names (Europe, Asia etc) unless they refer to a specific institution like "Bank of France".

Only extract terms that genuinely need explanation for the viewer. Ask: would someone watching this video pause and think "wait, what is that?" If the answer is no, don't extract it. "Bank of England" in a video about France — yes, the viewer might wonder about it. "Nobility" — no, everyone knows what nobility means.

DESCRIPTION LENGTH: One sentence. Maximum 100 characters. No exceptions. Count carefully. Good: "Britain's central bank, gave them war-financing edge France lacked." (67 chars). Bad: "Britain's central bank established in 1694 that enabled sophisticated war financing and economic management, advantages France lacked with its archaic system." (156 chars, way too long). Shorter is ALWAYS better.

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
        max_tokens: 512,
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
