const Anthropic = require("@anthropic-ai/sdk");

const SYSTEM_PROMPT = `You are a live context assistant. Given a transcript chunk, identify anything a general audience might not immediately know — stocks, companies, people, historical events, countries, conflicts, laws, or concepts. Return ONLY raw JSON, no markdown, no backticks: { "entities": [{ "term": "Apple", "type": "stock", "ticker": "AAPL" }, { "term": "Bretton Woods", "type": "event", "ticker": null }] }. Max 2 entities per chunk. If nothing noteworthy return { "entities": [] }.`;

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
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: transcript }],
    });

    const text = message.content[0].text;
    const parsed = JSON.parse(text);

    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).json(parsed);
  } catch (err) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ error: err.message });
  }
};
