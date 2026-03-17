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

  const { term, userProfile } = req.body || {};

  if (!term) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing term field" });
  }

  // Tailor tone based on user's knowledge level
  let toneInstruction = "that would help a general audience understand it";
  if (userProfile && userProfile.knowledgeLevel) {
    const level = userProfile.knowledgeLevel;
    if (level === "beginner") {
      toneInstruction =
        "using simple everyday language and analogies, as if explaining to someone with no background knowledge";
    } else if (level === "intermediate") {
      toneInstruction =
        "assuming some background knowledge, balancing clarity with depth";
    } else if (level === "expert") {
      toneInstruction =
        "in a concise and technical manner, assuming the reader is already familiar with the domain";
    }
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
        messages: [
          {
            role: "user",
            content: `Give a 1-2 short sentence description of "${term}" ${toneInstruction}. MUST be under 120 characters total, ideally under 100. Be punchy and conversational. Do NOT start with the term name. Jump straight into the explanation. Example: instead of 'The Bastille was a fortress...' say 'A fortress in Paris that symbolized royal tyranny.' Return ONLY a JSON object: { "description": "..." }`,
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
