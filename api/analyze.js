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

function buildSystemPrompt(pageTitle, knowledgeLevel, interests, tasteProfile, depth, previousEntities, sessionContext, knownTerms) {
  const title = pageTitle || "unknown content";
  const level = knowledgeLevel || "intermediate";
  const interestList = interests && interests.length > 0 ? interests.join(", ") : "general topics";
  const d = depth || 2;

  let relevanceFilter;
  if (level === "beginner") {
    relevanceFilter = "Return all entities (relevance 1, 2, and 3). Cast a wider net, but still skip the truly obvious.";
  } else if (level === "expert") {
    relevanceFilter = "Only return entities with relevance 3 — truly obscure or specialist terms. Skip anything a well-read person would know.";
  } else {
    relevanceFilter = "Only return entities with relevance 2 or 3. Skip common knowledge.";
  }

  let depthInstruction;
  if (d === 1) {
    depthInstruction = "Depth is set to Surface: only show the most accessible, widely relevant entities. Stick to relevance 1-2. Skip anything niche or specialist.";
  } else if (d === 3) {
    depthInstruction = "Depth is set to Deep Cuts: include obscure, specialist, and niche terms that only a dedicated learner would want. Include all relevance levels including very obscure.";
  } else {
    depthInstruction = "Depth is set to Balanced: show a mix of moderately known and lesser-known entities. Stick to relevance 2-3.";
  }

  return `You are a real-time contextual intelligence engine. The user is watching/listening to content titled: "${title}". Their knowledge level is: ${level}. Their interests are: ${interestList}.

Extract terms, people, events, or concepts that are explicitly mentioned or directly referenced in the transcript. Do NOT infer related academic concepts that weren't said. Focus on what the speaker actually says.

Extract 2-4 notable terms per chunk. Include specific people, named events, named places with historical significance, institutions, technical terms, and concepts that add depth to what the viewer is hearing. It's okay to extract well-known terms if they are central to the current discussion and the viewer would benefit from a quick explanation. The goal is to give the viewer 2-4 useful touchpoints per 12-second window, not to be so selective that nothing appears. An empty response should be rare, only when the transcript is truly generic narration with nothing worth explaining. When in doubt, extract it. The user can always ignore cards they don't need.

Apply these filters:

- SKIP the main topic itself and anything obvious from the title. If the title mentions the French Revolution, do not extract "French Revolution."
- SKIP single-word generic terms like "government", "war", "economy" unless they refer to a specific named event or concept.
- PRIORITIZE: specific people, named events, technical terms, institutions, policies, and concepts that would benefit from a quick explanation.
- For expert users, lean toward more obscure or specialist terms. For beginners, cast a wider net.

For each entity, include a relevance score: 3 = most people wouldn't know this, 2 = moderately well-known, 1 = common knowledge. ${relevanceFilter}

${depthInstruction}

For stocks/companies use type "stock" with the ticker symbol. For other entities use appropriate types: "concept", "event", "person", "organization", "commodity".

For each entity, also include a field called "salience" with value "highlight" or "background". A highlight is something the narrator is specifically introducing, explaining, or emphasizing, something the viewer would naturally wonder about. A background entity is something mentioned casually that provides setting or context but isn't the focus. Examples: narrator says "the gabelle, a salt tax that crushed the poor" = highlight. Narrator says "while Britain developed a bond market" = background for Britain, highlight for bond market.

The user's engagement history shows they prefer these entity types: ${formatCounts(tasteProfile?.liked)}. They tend to dismiss: ${formatCounts(tasteProfile?.ignored)}. Weight your extraction toward the types they engage with.

${previousEntities && previousEntities.length > 0 ? `These terms have already been shown this session: ${previousEntities.join(", ")}. Do not extract these again or close variations. Go deeper with new specific details instead of repeating the same layer.` : ""}

${sessionContext ? `Here is the full transcript of what has been said so far in this video: ${sessionContext}. Use this to understand the narrative arc and what the viewer has already heard. Extract only new terms that add to the viewer's understanding given everything discussed so far. Don't extract things that were already explained by the narrator. Consider where this transcript chunk falls in the video's narrative structure based on the sessionContext. If this appears to be the introduction (setting up the topic, posing questions), extract fewer entities and focus only on the central topic being introduced. If this is a deep explanation section (specific details, evidence, examples, named people and policies), extract more entities because this is where the richest content lives. If this is a conclusion or summary (wrapping up, drawing lessons, connecting to the present), extract very few entities because the narrator is restating things already covered. Use the sessionContext to judge the narrative position.` : ""}

${knownTerms && knownTerms.length > 0 ? `The user has seen these terms in previous sessions: ${knownTerms.join(", ")}. Do not extract terms the user already knows unless they are being discussed in a significantly different context. The user is building knowledge over time. Focus on what is NEW to them. However, if a known term is being discussed in a significantly different context than before, you MAY re-extract it with a note. For example, if the user learned "sovereign debt" from a French Revolution video and now they're watching a video about the 2008 crisis, re-extract it because the context is different and the user would benefit from seeing how the same concept applies in a new situation. In this case, add a field "recontextualized": true to the entity.` : ""}

Return ONLY raw JSON, no markdown, no backticks: { "entities": [{ "term": "Example", "type": "concept", "relevance": 3, "ticker": null, "salience": "highlight" }] }. Max 5 entities per chunk. If nothing noteworthy return { "entities": [] }.`;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { transcript, pageTitle, userProfile, tasteProfile, depth, previousEntities, sessionContext, knownTerms } = req.body || {};

  if (!transcript) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing transcript field" });
  }

  const knowledgeLevel = userProfile?.knowledgeLevel || "intermediate";
  const interests = userProfile?.interests?.length > 0 ? userProfile.interests : ["Finance & Economics", "History & Culture", "Politics & Law", "Science & Technology", "Business & Markets", "Arts & Society"];
  const systemPrompt = buildSystemPrompt(pageTitle, knowledgeLevel, interests, tasteProfile, depth, previousEntities, sessionContext, knownTerms);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 256,
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
