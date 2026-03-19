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

Never extract country names (France, Britain, Spain etc) or continent names (Europe, Asia etc) unless they refer to a specific institution like "Bank of France".

The user is watching: "${title}". Their knowledge level: ${level}.${prevList ? ` Already shown this session: ${prevList}.` : ""}${sessionContext ? ` Session transcript so far: ${sessionContext}` : ""}${knownTerms && knownTerms.length > 0 ? ` Known from previous sessions: ${knownTerms.join(", ")}.` : ""}${tasteProfile ? ` Engagement: liked types: ${formatCounts(tasteProfile.liked)}, dismissed: ${formatCounts(tasteProfile.ignored)}.` : ""}${reactionProfile ? ` Reactions: ${reactionProfile.known || 0} "knew this", ${reactionProfile.new || 0} "new to me", ${reactionProfile.advanced || 0} "too advanced".` : ""}

Return ONLY raw JSON, no markdown, no backticks: { "entities": [{ "term": "...", "type": "event|concept|person|stock|organization", "relevance": 1-3, "ticker": null, "salience": "highlight|background", "description": "one sentence under 80 chars" }] }. Max 5 per chunk. Return { "entities": [] } when no named terms exist. It is completely fine to return empty arrays.`;
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
