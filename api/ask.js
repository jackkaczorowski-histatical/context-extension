const { rateLimit } = require('./_rateLimit');
const validateRequest = require('./_validateRequest');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-extension-token",
};

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
    return res.status(429).json({ error: 'Rate limited', retry: true });
  }

  const { question, sessionTranscript, videoTitle, sessionEntities, sessionInsights } = req.body || {};

  if (!question) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing question field" });
  }

  const transcript = sessionTranscript
    ? sessionTranscript.slice(-4000)
    : "";
  const title = videoTitle || "unknown video";

  let entitiesBlock = "";
  if (sessionEntities && sessionEntities.length > 0) {
    entitiesBlock = "\n\nExtracted entities and ingredients from this session:\n" +
      sessionEntities.map(e => `- ${e.term} (${e.type})${e.description ? ': ' + e.description : ''}`).join("\n");
  }

  let insightsBlock = "";
  if (sessionInsights && sessionInsights.length > 0) {
    insightsBlock = "\n\nExtracted insights from this session:\n" +
      sessionInsights.map(i => `- ${i.insight}${i.detail ? ': ' + i.detail : ''}`).join("\n");
  }

  const systemPrompt = `You are a helpful assistant answering questions about a video the user is watching. The video is titled: "${title}".

You have access to the session transcript and extracted entities below. Use them to add video-specific context when relevant.

Here is the transcript of what has been said so far:

${transcript}${entitiesBlock}${insightsBlock}

INSTRUCTIONS:
- ALWAYS provide a useful, direct explanation of the entity or topic the user asks about, drawing on your own knowledge.
- If the transcript or entities provide relevant context about why this came up or how it relates to the video, weave that in naturally.
- If the transcript context is thin, just explain the entity directly — never say "the video didn't cover this" or "not enough information."
- For stocks or financial entities, explain what the company/fund does and why it matters to investors.
- 2-4 concise sentences. No bullet points, no preamble, no "based on the transcript" qualifiers.
- Return ONLY a JSON object: { "answer": "..." }`;

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

    // Save query to Supabase (fire and forget)
    if (SUPABASE_URL && SUPABASE_KEY) {
      fetch(`${SUPABASE_URL}/rest/v1/ask_queries`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY
        },
        body: JSON.stringify({
          install_id: req.body.installId || null,
          user_id: req.body.userId || null,
          question,
          term: req.body.term || null,
          video_title: title
        })
      }).catch(() => {});
    }

    return res.status(200).json(parsed);
  } catch (err) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
