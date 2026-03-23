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

  const { entities, title } = req.body || {};

  if (!entities || !Array.isArray(entities) || entities.length === 0) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing or empty entities array" });
  }

  const videoTitle = title || "unknown video";

  const systemPrompt = `You generate quiz questions from video terms. Given a list of terms with descriptions from a video, create exactly 5 multiple-choice questions. Each question should test understanding of one term. Include one correct answer and three plausible distractors. Return ONLY raw JSON: { "questions": [{ "question": "...", "options": ["A","B","C","D"], "correct": 0 }] }. The correct field is the 0-indexed position of the right answer.`;

  const userMessage = `Video: "${videoTitle}"\n\nTerms:\n${entities.map(e => `- ${e.term} (${e.type}): ${e.description || 'no description'}`).join('\n')}`;

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
        messages: [{ role: "user", content: userMessage }],
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
