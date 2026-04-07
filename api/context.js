const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-extension-token",
};

const { rateLimit } = require('./_rateLimit');
const validateRequest = require('./_validateRequest');

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
  if (!await rateLimit(clientId, 10, 60000)) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(429).json({ error: 'Rate limited', retry: true });
  }

  const { term, userProfile } = req.body || {};

  if (!term) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing term field" });
  }

  const knowledgeLevel = userProfile?.knowledgeLevel || "intermediate";
  let levelInstruction;
  if (knowledgeLevel === "expert") {
    levelInstruction = "Be technical and precise.";
  } else if (knowledgeLevel === "beginner") {
    levelInstruction = "Be plain and concrete.";
  } else {
    levelInstruction = "Balance clarity with depth.";
  }

  const systemPrompt = `You're a sharp, witty friend sitting next to someone watching a video. They just tapped on a term because they want to know what it is. Give them a 1-2 sentence explanation that's direct, confident, and connects it to what they're watching. No filler words. No 'essentially' or 'basically' or 'think of it as'. No analogies unless they genuinely help. No dashes of any kind. Just tell them what it is and why it matters, like you're whispering to a friend in a theater. Keep descriptions to 1-2 sentences. Max 100 characters. Be direct. "The French royal palace where Louis XIV consolidated power" not "The French royal palace where Louis XIV moved the entire court to assert absolute power and control the nobility through elaborate ceremony and ritual." Shorter is always better. Every word must earn its place. ${levelInstruction} Do NOT start with the term name. Return ONLY a JSON object: { "description": "..." }`;

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
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: term,
          },
        ],
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
