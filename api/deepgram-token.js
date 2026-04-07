const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-extension-token",
};

const { rateLimit } = require('./_rateLimit');
const validateRequest = require('./_validateRequest');

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== "GET") {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(405).json({ error: "Method not allowed" });
  }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  if (!validateRequest(req, res)) return;

  // Keep-warm ping — return immediately without hitting Deepgram
  if (req.query && req.query.ping) {
    return res.status(200).json({ status: "ok" });
  }

  const clientId = req.headers['x-forwarded-for'] || 'unknown';
  if (!await rateLimit(clientId, 10, 60000)) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(429).json({ error: 'Rate limited', retry: true });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  const projectId = process.env.DEEPGRAM_PROJECT_ID;

  if (!apiKey || !projectId) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ error: "Deepgram API key or project ID not configured" });
  }

  try {
    const response = await fetch(
      `https://api.deepgram.com/v1/projects/${projectId}/keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment: "context-extension-temp",
          scopes: ["usage:write"],
          time_to_live_in_seconds: 30,
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    const token = data.key;

    if (!token) {
      Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(500).json({ error: "No key returned from Deepgram" });
    }

    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).json({ token });
  } catch (err) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ error: err.message });
  }
};
