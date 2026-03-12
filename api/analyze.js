const SYSTEM_PROMPT = `You are watching a video with the user. Extract ANY proper noun, named entity, financial term, economic concept, historical reference, organization, or technical term from this transcript. When in doubt, include it. A viewer watching a finance or educational video would want context on almost any specific term mentioned. For stocks/companies use type "stock" with the ticker symbol. For other entities use appropriate types like "concept", "event", "person", "organization", "commodity". Return ONLY raw JSON, no markdown, no backticks: { "entities": [{ "term": "Apple", "type": "stock", "ticker": "AAPL" }, { "term": "OPEC", "type": "organization", "ticker": null }, { "term": "quantitative easing", "type": "concept", "ticker": null }] }. Max 5 entities per chunk. If nothing noteworthy return { "entities": [] }.`;

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
        model: "claude-sonnet-4-6",
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
