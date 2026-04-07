const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-extension-token",
};

const counts = {};

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

  const { videoUrl, term } = req.body || {};

  if (!videoUrl || !term) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing videoUrl or term field" });
  }

  if (!counts[videoUrl]) counts[videoUrl] = {};
  counts[videoUrl][term] = (counts[videoUrl][term] || 0) + 1;

  const count = counts[videoUrl][term];
  const total = Object.values(counts[videoUrl]).reduce((s, v) => s + v, 0);

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  return res.status(200).json({ count, total });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
