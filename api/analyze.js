const SYSTEM_PROMPT = `You are a live context assistant. Given a transcript chunk, identify terms that genuinely need explanation for a general audience — stocks, companies, notable commodities, people, historical events, countries, conflicts, laws, economic concepts, or technical terms. Only flag common everyday items (like "coffee", "shipping", "water") if they are discussed in a specifically notable financial, historical, or political context. Focus on things a viewer would actually want to look up. For example "Tesla" is type "stock" with ticker "TSLA", "OPEC" is type "organization", "inflation" is type "concept", "crude oil futures" is type "commodity". Return ONLY raw JSON, no markdown, no backticks: { "entities": [{ "term": "Apple", "type": "stock", "ticker": "AAPL" }, { "term": "OPEC", "type": "organization", "ticker": null }, { "term": "Bretton Woods", "type": "event", "ticker": null }] }. Max 3 entities per chunk. If nothing noteworthy return { "entities": [] }.`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { transcript } = req.body || {};

  if (!transcript) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing transcript field" });
  }

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
        max_tokens: 256,
        system: SYSTEM_PROMPT,
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
