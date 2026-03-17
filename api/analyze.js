const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function buildSystemPrompt(pageTitle, knowledgeLevel, interests) {
  const title = pageTitle || "unknown content";
  const level = knowledgeLevel || "intermediate";
  const interestList = interests && interests.length > 0 ? interests.join(", ") : "general topics";

  let relevanceFilter;
  if (level === "beginner") {
    relevanceFilter = "Return all entities (relevance 1, 2, and 3). Cast a wider net, but still skip the truly obvious.";
  } else if (level === "expert") {
    relevanceFilter = "Only return entities with relevance 3 — truly obscure or specialist terms. Skip anything a well-read person would know.";
  } else {
    relevanceFilter = "Only return entities with relevance 2 or 3. Skip common knowledge.";
  }

  return `You are a real-time contextual intelligence engine. The user is watching/listening to content titled: "${title}". Their knowledge level is: ${level}. Their interests are: ${interestList}.

Extract ONLY entities, concepts, events, or terms that a viewer would genuinely benefit from having explained — things they likely don't already know. Apply these filters strictly:

- SKIP the main topic itself and anything obvious from the title. If the title mentions the French Revolution, do not extract "French Revolution."
- SKIP well-known countries, continents, and major cities unless they are being discussed in a surprising or non-obvious way.
- SKIP generic/common terms like "government", "war", "economy" unless they refer to a specific named event or concept.
- PRIORITIZE: specific historical figures not widely known, technical financial terms, obscure events, named policies/laws/treaties, specific organizations, and domain jargon the viewer might not know.
- For expert users, only extract truly obscure or specialist terms. For beginners, cast a wider net but still skip the obvious.

For each entity, include a relevance score: 3 = most people wouldn't know this, 2 = moderately well-known, 1 = common knowledge. ${relevanceFilter}

For stocks/companies use type "stock" with the ticker symbol. For other entities use appropriate types: "concept", "event", "person", "organization", "commodity".

Return ONLY raw JSON, no markdown, no backticks: { "entities": [{ "term": "Example", "type": "concept", "relevance": 3, "ticker": null }] }. Max 5 entities per chunk. If nothing noteworthy return { "entities": [] }.`;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { transcript, pageTitle, userProfile } = req.body || {};

  if (!transcript) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing transcript field" });
  }

  const knowledgeLevel = userProfile?.knowledgeLevel || "intermediate";
  const interests = userProfile?.interests || [];
  const systemPrompt = buildSystemPrompt(pageTitle, knowledgeLevel, interests);

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
