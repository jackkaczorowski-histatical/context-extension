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

  const { question, sessionTranscript, videoTitle } = req.body || {};

  if (!question) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing question field" });
  }

  const transcript = sessionTranscript
    ? sessionTranscript.slice(-4000)
    : "";
  const title = videoTitle || "unknown video";

  const systemPrompt = `You are a helpful assistant answering questions about a video the user is watching. The video is titled: "${title}". Here is the transcript of what has been said so far:\n\n${transcript}\n\nAnswer in exactly 2-3 short sentences. Max 200 characters total. Be direct and specific. No preamble, no "based on the transcript" qualifiers. Just answer the question. If the transcript doesn't cover it, say so in one sentence. Do not make things up. Return ONLY a JSON object: { "answer": "..." }`;

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
        messages: [{ role: "user", content: question }],
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
