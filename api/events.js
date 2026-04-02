const { rateLimit } = require('./_rateLimit');

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method !== "POST") { return res.status(405).json({ error: "Method not allowed" }); }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!rateLimit(`events_${ip}`, 30, 60000)) {
    return res.status(429).json({ error: 'Rate limited' });
  }

  const { events } = req.body || {};

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'No events provided' });
  }

  console.log('[EVENTS]', JSON.stringify({ count: events.length, installId: events[0]?.installId, events: events.map(e => e.event) }));

  // TODO: Store events in Supabase
  return res.status(200).json({ received: events.length });
};
